import { getAuthSecret } from "../../../../lib/session.ts";
import {
  verifyPasswordResetToken,
  executePasswordReset,
} from "../../../../lib/password-reset.ts";
import { enforceRateLimit } from "../../../../lib/rate-limit.ts";
import { validateInput, resetPasswordSchema } from "../../../../lib/validation.ts";

export type ResetPasswordRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSecret?: () => string;
  skipRateLimit?: boolean;
};

let prodSqlPromise: Promise<any> | null = null;

async function loadProductionSql(): Promise<any> {
  if (!prodSqlPromise) {
    prodSqlPromise = import("../../../../lib/db.ts").then((m) => m.sql);
  }
  return prodSqlPromise;
}

export async function handleResetPassword(
  request: Request,
  deps: ResetPasswordRouteDependencies = {}
): Promise<Response> {
  // 1. Sliding-Window Rate Limiting (5 attempts per minute per IP)
  if (!deps.skipRateLimit) {
    const { response: rateLimitResp } = await enforceRateLimit(request, {
      action: "reset-password",
      limit: 5,
      windowSeconds: 60,
    });
    if (rateLimitResp) {
      return rateLimitResp;
    }
  }

  // 2. Parse & Validate Request Body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const validation = validateInput(resetPasswordSchema, body);
  if (!validation.success) {
    return Response.json(
      { error: validation.error, details: validation.issues },
      { status: 400 }
    );
  }

  const { token, newPassword } = validation.data;

  // 3. Resolve Dependencies
  const secret = deps.getSecret ? deps.getSecret() : getAuthSecret();
  const sql = deps.sql ?? (await loadProductionSql());

  // 4. Verify Cryptographic Token & Single-Use Status
  const verification = await verifyPasswordResetToken(token, secret, sql);
  if (!verification.valid || !verification.payload) {
    return Response.json(
      { error: verification.error || "Invalid, expired, or previously used reset token." },
      { status: 400 }
    );
  }

  // 5. Update Password, Consume Token, and Revoke Active Sessions
  const resetResult = await executePasswordReset(
    sql,
    verification.payload.tokenId,
    verification.payload.userId,
    newPassword
  );

  if (!resetResult.success) {
    return Response.json(
      { error: resetResult.error || "Failed to update password." },
      { status: 500 }
    );
  }

  return Response.json(
    {
      success: true,
      message: "Password has been successfully updated. Please sign in with your new password.",
    },
    { status: 200 }
  );
}

export async function POST(request: Request) {
  return handleResetPassword(request);
}
