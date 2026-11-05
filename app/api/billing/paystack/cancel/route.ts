import { getSessionUser } from "../../../../../lib/session.ts";
import { isManagerRole } from "../../../../../lib/permissions.ts";
import {
  createDefaultBillingStorage,
  type BillingStorageInterface,
} from "../../../../../lib/billing-storage.ts";
import type { SessionPayload } from "../../../../../lib/auth.ts";
import { sanitizeSubscriptionForClient } from "../verify/route.ts";

export interface CancelSubscriptionOptions {
  storage?: BillingStorageInterface;
  currentTime?: number;
}

/**
 * Pure testable handler for Paystack subscription cancellation.
 *
 * Invariants:
 * 1. For merchant-managed recurring billing, cancellation disables future scheduled
 *    charges and auto-renewal locally.
 * 2. Does NOT delete members, shifts, or workspace data.
 * 3. Keeps access active until currentPeriodEnd (cancel_at_period_end = true).
 */
export async function handleCancelPaystackSubscription(
  sessionUser: SessionPayload | null,
  options?: CancelSubscriptionOptions
): Promise<{ status: number; body: Record<string, any> }> {
  if (!sessionUser) {
    return {
      status: 401,
      body: { error: "Unauthorized", message: "Authentication required to cancel subscription." },
    };
  }

  if (!sessionUser.teamId) {
    return {
      status: 403,
      body: { error: "Forbidden", message: "User does not belong to an active workspace." },
    };
  }

  const userTeamRole = (sessionUser as any).teamRole;
  const hasAuthority =
    isManagerRole(sessionUser.role) ||
    userTeamRole === "Owner" ||
    userTeamRole === "Manager" ||
    userTeamRole === "Admin";

  if (!hasAuthority) {
    return {
      status: 403,
      body: { error: "Forbidden", message: "Only workspace owners or managers can cancel billing." },
    };
  }

  const storage = options?.storage || createDefaultBillingStorage();
  const currentSub = await storage.getSubscriptionByTeamId(sessionUser.teamId);

  if (!currentSub || currentSub.planId === "free") {
    return {
      status: 400,
      body: { error: "Bad Request", message: "Workspace is currently on the free plan; no paid subscription to cancel." },
    };
  }

  const now = options?.currentTime ?? Math.floor(Date.now() / 1000);

  const updatedSub = await storage.upsertSubscription({
    ...currentSub,
    cancelAtPeriodEnd: true,
    autoRenewEnabled: false,
    updatedAt: now,
  });

    return {
      status: 200,
      body: {
        success: true,
        provider: "paystack",
        message: "Subscription auto-renewal canceled. Access will remain active until the end of your billing period.",
        subscription: sanitizeSubscriptionForClient(updatedSub),
      },
    };
}

export async function POST() {
  try {
    const sessionUser = await getSessionUser({ revalidateWithDb: true });
    const { status, body } = await handleCancelPaystackSubscription(sessionUser);
    return Response.json(body, { status });
  } catch {
    return Response.json(
      { error: "Internal Server Error", message: "Failed to process cancellation." },
      { status: 500 }
    );
  }
}
