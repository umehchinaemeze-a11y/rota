import crypto from "node:crypto";
import { getSessionUser } from "../../../../../lib/session.ts";
import { isManagerRole } from "../../../../../lib/permissions.ts";
import {
  PAYSTACK_PLANS,
  getPaystackPlan,
  defaultPaystackClient,
  type PaystackClientInterface,
} from "../../../../../lib/paystack.ts";
import {
  createDefaultBillingStorage,
  type BillingStorageInterface,
} from "../../../../../lib/billing-storage.ts";
import type { SessionPayload } from "../../../../../lib/auth.ts";

export interface PaystackInitializeOptions {
  client?: PaystackClientInterface;
  storage?: BillingStorageInterface;
  currentTime?: number;
}

/**
 * Pure testable handler for Paystack transaction initialization.
 * Strict Invariants:
 * 1. Server-side NGN pricing validation using integer kobo only.
 * 2. Never trusts prices, amounts, or currencies supplied by the browser.
 * 3. Unique, tamper-evident transaction reference.
 * 4. Workspace-bound and user-bound metadata.
 */
export async function handlePaystackInitialize(
  body: any,
  sessionUser: SessionPayload | null,
  options?: PaystackInitializeOptions
): Promise<{ status: number; body: Record<string, any> }> {
  // 0. Production Configuration Gatekeeping (Strict Fail-Closed)
  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.BILLING_ENVIRONMENT === "production" ||
    process.env.BILLING_STORAGE === "database";
  const hasClientOverride = !!options?.client;
  const secretKey = process.env.PAYSTACK_SECRET_KEY?.trim();

  if (isProduction && !hasClientOverride && !secretKey) {
    return {
      status: 503,
      body: {
        error: "Service Unavailable",
        message: "Payment gateway credentials (PAYSTACK_SECRET_KEY) are not configured in production.",
      },
    };
  }

  // 1. Authentication Gatekeeping
  if (!sessionUser) {
    return {
      status: 401,
      body: {
        error: "Unauthorized",
        message: "Authentication required to initiate billing checkout.",
      },
    };
  }

  // 2. Workspace Membership Gatekeeping
  if (!sessionUser.teamId) {
    return {
      status: 403,
      body: {
        error: "Forbidden",
        message: "User does not belong to an active workspace.",
      },
    };
  }

  // 3. Role-Based Management Authority
  const userTeamRole = (sessionUser as any).teamRole;
  const hasManagementAuthority =
    isManagerRole(sessionUser.role) ||
    userTeamRole === "Owner" ||
    userTeamRole === "Manager" ||
    userTeamRole === "Admin";

  if (!hasManagementAuthority) {
    return {
      status: 403,
      body: {
        error: "Forbidden",
        message: "Only workspace owners or managers can manage billing subscriptions.",
      },
    };
  }

  // 4. Request Body Validation
  if (!body || typeof body !== "object") {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Invalid request body.",
      },
    };
  }

  // 5. Tenant Isolation Guard
  if (
    body.workspaceId !== undefined &&
    String(body.workspaceId) !== String(sessionUser.teamId)
  ) {
    return {
      status: 403,
      body: {
        error: "Forbidden",
        message: "Tenant mismatch: Cannot initiate checkout for another workspace.",
      },
    };
  }

  // 6. Target Plan Validation
  const targetPlan = typeof body.targetPlan === "string" ? body.targetPlan.toLowerCase().trim() : "";
  if (!targetPlan || !PAYSTACK_PLANS[targetPlan]) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Invalid target plan. Must be one of: starter, pro, enterprise.",
      },
    };
  }

  if (targetPlan === "free") {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Cannot checkout free tier. Free tier is the default plan.",
      },
    };
  }

  const planConfig = PAYSTACK_PLANS[targetPlan];
  const targetSeats =
    typeof body.seats === "number" && Number.isInteger(body.seats) && body.seats > 0
      ? body.seats
      : planConfig.maxSeats;

  // Strict Server-Side Integer Kobo Pricing
  const amountKobo = planConfig.monthlyKobo;
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    return {
      status: 500,
      body: {
        error: "Configuration Error",
        message: "Invalid plan pricing configuration.",
      },
    };
  }

  // 7. Check Current Subscription State (Prevent redundant checkout for same plan)
  const storage = options?.storage || createDefaultBillingStorage();
  try {
    const currentSub = await storage.getSubscriptionByTeamId(sessionUser.teamId);
    if (
      currentSub &&
      currentSub.status === "active" &&
      currentSub.planId === targetPlan &&
      currentSub.paymentProvider === "paystack"
    ) {
      return {
        status: 400,
        body: {
          error: "Bad Request",
          message: `Workspace is already subscribed to the ${planConfig.displayName}.`,
        },
      };
    }
  } catch {
    return {
      status: 500,
      body: {
        error: "Internal Server Error",
        message: "Failed to verify current subscription state.",
      },
    };
  }

  // 8. Generate Unique Transaction Reference
  const now = options?.currentTime ?? Math.floor(Date.now() / 1000);
  const randomSuffix = crypto.randomBytes(4).toString("hex");
  const reference = `pstk_init_${sessionUser.teamId}_${targetPlan}_${now}_${randomSuffix}`;

  // 9. Callback URL
  const callbackUrl =
    typeof body.callbackUrl === "string" && body.callbackUrl.trim().length > 0
      ? body.callbackUrl.trim()
      : `/billing?status=success&reference=${reference}`;

  // 10. Call Paystack Provider
  const client = options?.client || defaultPaystackClient;

  try {
    const initResponse = await client.initializeTransaction({
      email: sessionUser.email,
      amountKobo,
      currency: "NGN",
      reference,
      callbackUrl,
      channels: ["card"],
      metadata: {
        workspace_id: sessionUser.teamId,
        user_id: sessionUser.userId,
        plan_id: targetPlan,
        seats: targetSeats,
        amount_kobo: amountKobo,
        currency: "NGN",
        consent_recurring: true,
      },
    });

    return {
      status: 200,
      body: {
        provider: "paystack",
        authorizationUrl: initResponse.data.authorization_url,
        accessCode: initResponse.data.access_code,
        reference: initResponse.data.reference,
        plan: targetPlan,
        seats: targetSeats,
        amountKobo,
        currency: "NGN",
      },
    };
  } catch (err: any) {
    return {
      status: 502,
      body: {
        error: "Payment Gateway Error",
        message: "Failed to initialize Paystack transaction. Please try again later.",
      },
    };
  }
}

import { enforceRateLimit } from "../../../../../lib/rate-limit.ts";

export async function POST(req: Request) {
  try {
    // Rate limiting: 10 initialize attempts per minute per IP
    const { response: rateLimitResp } = await enforceRateLimit(req, {
      action: "billing-initialize",
      limit: 10,
      windowSeconds: 60,
    });
    if (rateLimitResp) {
      return rateLimitResp;
    }

    const sessionUser = await getSessionUser({ revalidateWithDb: true });

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Bad Request", message: "Malformed JSON body." },
        { status: 400 }
      );
    }

    const { status, body: resBody } = await handlePaystackInitialize(body, sessionUser);
    return Response.json(resBody, { status });
  } catch {
    return Response.json(
      {
        error: "Internal Server Error",
        message: "An unexpected error occurred during checkout initialization.",
      },
      { status: 500 }
    );
  }
}
