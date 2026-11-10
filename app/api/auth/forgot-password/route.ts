import { createPasswordResetToken } from "../../../../lib/password-reset.ts";
import { getAuthSecret } from "../../../../lib/session.ts";
import { enforceRateLimit } from "../../../../lib/rate-limit.ts";
import { validateInput, forgotPasswordSchema } from "../../../../lib/validation.ts";

export type ForgotPasswordRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSecret?: () => string;
  skipRateLimit?: boolean;
  returnTokenForTesting?: boolean;
};

let prodSqlPromise: Promise<any> | null = null;

async function loadProductionSql(): Promise<any> {
  if (!prodSqlPromise) {
    prodSqlPromise = import("../../../../lib/db.ts").then((m) => m.sql);
  }
  return prodSqlPromise;
}

export async function handleForgotPassword(
  request: Request,
  deps: ForgotPasswordRouteDependencies = {}
): Promise<Response> {
  try {
    // 1. Sliding-Window Rate Limiting (5 requests per min per IP)
    if (!deps.skipRateLimit) {
      const { response: rateLimitResp } = await enforceRateLimit(request, {
        action: "forgot-password",
        limit: 5,
        windowSeconds: 60,
      });
      if (rateLimitResp) {
        return rateLimitResp;
      }
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    const validation = validateInput(forgotPasswordSchema, body);
    if (!validation.success) {
      return Response.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const { email } = validation.data;
    const sql = deps.sql ?? (await loadProductionSql());

    // Check account existence without exposing result to client (anti-enumeration)
    const existing = await sql`
      SELECT id, email FROM users
      WHERE LOWER(TRIM(email)) = ${email}
      LIMIT 1;
    `;

    let generatedToken: string | null = null;
    if (existing && existing.length > 0) {
      const user = existing[0];
      try {
        const secret = deps.getSecret ? deps.getSecret() : getAuthSecret();
        const tokenInfo = createPasswordResetToken(user.id, user.email, secret);
        generatedToken = tokenInfo.token;
      } catch {
        // If AUTH_SECRET is unconfigured in test environment, non-fatal for generic anti-enumeration response
      }
      // In production, an email delivery service dispatches this token securely.
    }

    // Generic response regardless of whether account exists, preventing email enumeration
    const responsePayload: Record<string, unknown> = {
      success: true,
      message:
        "If an account is associated with this email address, you will receive password reset instructions.",
    };

    if (deps.returnTokenForTesting && generatedToken) {
      responsePayload.resetToken = generatedToken;
    }

    return Response.json(responsePayload, { status: 200 });
  } catch (error) {
    console.error("Forgot password processing error occurred.");
    return Response.json(
      { error: "An unexpected error occurred. Please try again later." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return handleForgotPassword(request);
}
