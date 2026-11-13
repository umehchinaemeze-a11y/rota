import crypto from "node:crypto";
import {
  runPaystackRenewalCycle,
  type RenewalEngineOptions,
} from "../../../../../lib/paystack-renewal-engine.ts";

export interface RenewalRouteOptions extends RenewalEngineOptions {
  cronSecret?: string;
  sessionUser?: any;
}

/**
 * Validates whether the incoming Authorization header contains a valid Bearer token
 * matching expectedSecret in constant time to prevent timing attacks.
 */
export function isValidBearerToken(authHeader: string | null | undefined, expectedSecret?: string): boolean {
  if (!authHeader || typeof authHeader !== "string") return false;
  const secret = expectedSecret?.trim();
  if (!secret) return false;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const token = match[1].trim();
  if (!token) return false;

  const tokenBuf = Buffer.from(token, "utf8");
  const secretBuf = Buffer.from(secret, "utf8");

  if (tokenBuf.length !== secretBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(tokenBuf, secretBuf);
}

/**
 * Shared handler for executing Paystack recurring renewal cycle via GET (Vercel Cron)
 * or POST (scheduled worker / authenticated administrative trigger).
 *
 * Security & Execution Invariants:
 * 1. Requires valid Authorization: Bearer <CRON_SECRET> for all calls (GET or POST).
 * 2. Ambient user and manager session cookies are strictly ignored.
 * 3. Fails closed with HTTP 401 on missing, empty, or mismatched credentials without executing renewals.
 * 4. Preserves database lease concurrency, idempotency, retry backoff, and payment provider isolation.
 * 5. Never leaks secrets, tokens, or customer credentials in response payloads or error messages.
 */
export async function handleRenewalRequest(
  req: Request,
  options?: RenewalRouteOptions
): Promise<Response> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret = options?.cronSecret ?? process.env.CRON_SECRET?.trim();
    let isAuthorized = false;

    if (cronSecret && isValidBearerToken(authHeader, cronSecret)) {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return Response.json(
        { error: "Unauthorized", message: "Authorization required to trigger billing renewals." },
        { status: 401 }
      );
    }

    const result = await runPaystackRenewalCycle(options);
    return Response.json({ success: true, provider: "paystack", result }, { status: 200 });
  } catch (err: any) {
    const rawMessage = typeof err?.message === "string" ? err.message : "";
    const safeMessage =
      rawMessage && !/secret|key|token|password|bearer|postgres/i.test(rawMessage)
        ? rawMessage
        : "Failed to process renewals.";

    return Response.json(
      { error: "Internal Server Error", message: safeMessage },
      { status: 500 }
    );
  }
}

/**
 * Vercel Cron compatible endpoint (Vercel Cron invokes configured paths via GET).
 * Requires Authorization: Bearer <CRON_SECRET>.
 */
export async function GET(req: Request) {
  return handleRenewalRequest(req);
}

/**
 * POST endpoint for authenticated worker triggers and manual execution.
 * Requires Authorization: Bearer <CRON_SECRET>.
 */
export async function POST(req: Request) {
  return handleRenewalRequest(req);
}
