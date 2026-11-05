import { getSessionUser } from "../../../lib/session.ts";
import {
  BillingEventProcessor,
  globalBillingProcessor,
  getPlanPricing,
} from "../../../lib/billing.ts";
import { getPaystackPlan } from "../../../lib/paystack.ts";
import {
  evaluateSeatCapacity,
  resolveSeatLimit,
} from "../../../lib/seat-limit.ts";
import type { SessionPayload } from "../../../lib/auth.ts";

export interface GetBillingOptions {
  processor?: BillingEventProcessor;
  activeMemberCount?: number;
}

/**
 * Pure testable handler for retrieving workspace billing and subscription status.
 */
export async function handleGetBillingStatus(
  sessionUser: SessionPayload | null,
  options?: GetBillingOptions
): Promise<{ status: number; body: Record<string, any> }> {
  if (!sessionUser) {
    return {
      status: 401,
      body: {
        error: "Unauthorized",
        message: "Authentication required to view billing details.",
      },
    };
  }

  if (!sessionUser.teamId) {
    return {
      status: 403,
      body: {
        error: "Forbidden",
        message: "User does not belong to an active workspace.",
      },
    };
  }

  const processor = options?.processor || globalBillingProcessor;

  let sub = null;
  let ledger = [];
  try {
    sub =
      typeof (processor as any).getSubscriptionByWorkspaceDurable === "function"
        ? await (processor as any).getSubscriptionByWorkspaceDurable(sessionUser.teamId)
        : processor.getSubscriptionByWorkspace(sessionUser.teamId);

    ledger =
      typeof (processor as any).getLedgerByWorkspaceDurable === "function"
        ? await (processor as any).getLedgerByWorkspaceDurable(sessionUser.teamId)
        : processor.getLedgerByWorkspace(sessionUser.teamId);
  } catch {
    return {
      status: 500,
      body: {
        error: "Internal Server Error",
        message: "Failed to retrieve billing status from persistent storage.",
      },
    };
  }

  const tier = sub?.planId || "free";
  const seatLimit = sub?.seats || resolveSeatLimit(tier);
  const activeMembers = options?.activeMemberCount ?? 1;

  const capacity = evaluateSeatCapacity(
    sessionUser.teamId,
    activeMembers,
    tier,
    seatLimit
  );

  const state =
    !sub || sub.planId === "free"
      ? "FREE"
      : sub.status === "past_due"
        ? "PAST_DUE"
        : sub.status === "canceled"
          ? "CANCELED"
          : sub.status === "trialing"
            ? "TRIALING"
            : sub.status === "active"
              ? "ACTIVE"
              : String(sub.status).toUpperCase();

  return {
    status: 200,
    body: {
      workspaceId: sessionUser.teamId,
      state,
      subscription: sub || {
        subscriptionId: null,
        workspaceId: sessionUser.teamId,
        planId: "free",
        seats: 5,
        status: "active",
      },
      plan: getPlanPricing(tier),
      paystackPlan: getPaystackPlan(tier),
      seatLimit,
      capacity,
      ledger,
    },
  };
}

export async function GET() {
  try {
    const sessionUser = await getSessionUser({ revalidateWithDb: true });
    const { status, body } = await handleGetBillingStatus(sessionUser);
    return Response.json(body, { status });
  } catch (error: any) {
    return Response.json(
      {
        error: "Internal Server Error",
        message: "An unexpected error occurred while loading billing status.",
      },
      { status: 500 }
    );
  }
}
