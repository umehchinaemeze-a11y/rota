import { getSessionUser } from "../../../../lib/session.ts";
import { isManagerRole } from "../../../../lib/permissions.ts";
import {
  BillingEventProcessor,
  globalBillingProcessor,
  PLAN_PRICING,
  getPlanPricing,
} from "../../../../lib/billing.ts";
import { calculatePlanProration } from "../../../../lib/proration.ts";
import {
  type StripeClientInterface,
  defaultStripeClient,
} from "../../../../lib/stripe.ts";
import type { SessionPayload } from "../../../../lib/auth.ts";

export interface CreateCheckoutOptions {
  stripeClient?: StripeClientInterface;
  processor?: BillingEventProcessor;
  currentTime?: number;
}

/**
 * Pure testable handler for checkout session creation.
 */
export async function handleCreateCheckoutSession(
  body: any,
  sessionUser: SessionPayload | null,
  options?: CreateCheckoutOptions
): Promise<{ status: number; body: Record<string, any> }> {
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
  if (!targetPlan || !PLAN_PRICING[targetPlan]) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: `Invalid target plan. Must be one of: starter, pro, enterprise.`,
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

  const targetPricing = PLAN_PRICING[targetPlan];
  const targetSeats =
    typeof body.seats === "number" && body.seats > 0
      ? Math.floor(body.seats)
      : targetPricing.maxSeats;

  // 7. Proration & Pricing Calculation
  const processor = options?.processor || globalBillingProcessor;
  const currentSub = processor.getSubscriptionByWorkspace(sessionUser.teamId);
  const now = options?.currentTime ?? Math.floor(Date.now() / 1000);

  let amountCents = targetPricing.priceMonthlyCents;
  let isProrated = false;
  let prorationDetails = null;

  if (currentSub && currentSub.status === "active" && currentSub.planId !== "free") {
    if (currentSub.planId === targetPlan) {
      return {
        status: 400,
        body: {
          error: "Bad Request",
          message: `Workspace is already subscribed to the ${targetPricing.displayName}.`,
        },
      };
    }

    const currentPricing = getPlanPricing(currentSub.planId);
    // Calculate remaining days in 30-day cycle
    const secondsRemaining = Math.max(0, currentSub.currentPeriodEnd - now);
    const daysRemaining = Math.min(30, Math.ceil(secondsRemaining / 86400));

    if (daysRemaining > 0 && daysRemaining < 30) {
      const proration = calculatePlanProration({
        currentPlanPrice: currentPricing.priceMonthly,
        newPlanPrice: targetPricing.priceMonthly,
        totalDaysInCycle: 30,
        daysRemaining,
      });

      if (proration.action === "charge") {
        amountCents = Math.round(proration.amount * 100);
        isProrated = true;
        prorationDetails = {
          daysRemaining: proration.daysRemaining,
          proratedAmount: proration.amount,
          unitDifference: proration.unitDifference,
        };
      }
    }
  }

  // 8. Create Checkout Session via Provider Client
  const stripeClient = options?.stripeClient || defaultStripeClient;
  const successUrl =
    typeof body.successUrl === "string" && body.successUrl.trim().length > 0
      ? body.successUrl.trim()
      : "/settings?billing=success&session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl =
    typeof body.cancelUrl === "string" && body.cancelUrl.trim().length > 0
      ? body.cancelUrl.trim()
      : "/settings?billing=cancel";

  try {
    const session = await stripeClient.createCheckoutSession({
      workspaceId: sessionUser.teamId,
      userId: sessionUser.userId,
      userEmail: sessionUser.email,
      planId: targetPlan,
      seats: targetSeats,
      amountCents,
      currency: "usd",
      successUrl,
      cancelUrl,
      metadata: {
        workspace_id: String(sessionUser.teamId),
        user_id: String(sessionUser.userId),
        plan_id: targetPlan,
        seats: String(targetSeats),
      },
    });

    return {
      status: 200,
      body: {
        sessionId: session.id,
        url: session.url,
        plan: targetPlan,
        seats: targetSeats,
        amountCents,
        prorated: isProrated,
        prorationDetails,
      },
    };
  } catch (err: any) {
    return {
      status: 500,
      body: {
        error: "Payment Provider Error",
        message: "Failed to initiate payment session with provider. Please try again later.",
      },
    };
  }
}

export async function POST(req: Request) {
  try {
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

    const { status, body: resBody } = await handleCreateCheckoutSession(
      body,
      sessionUser
    );
    return Response.json(resBody, { status });
  } catch (error: any) {
    return Response.json(
      {
        error: "Internal Server Error",
        message: "An unexpected error occurred during checkout initialization.",
      },
      { status: 500 }
    );
  }
}
