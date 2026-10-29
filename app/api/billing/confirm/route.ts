import { getSessionUser } from "../../../../lib/session.ts";
import {
  BillingEventProcessor,
  globalBillingProcessor,
  type ProcessEventResult,
} from "../../../../lib/billing.ts";
import {
  type StripeClientInterface,
  defaultStripeClient,
} from "../../../../lib/stripe.ts";
import type { SessionPayload } from "../../../../lib/auth.ts";

export interface ConfirmPaymentOptions {
  stripeClient?: StripeClientInterface;
  processor?: BillingEventProcessor;
}

/**
 * Pure testable handler for server-side payment confirmation.
 * Strict Security Invariant: Never trusts client-reported amounts, tiers, or payment statuses.
 * Always retrieves and validates the session directly from the payment provider.
 */
export async function handleConfirmPayment(
  body: any,
  sessionUser: SessionPayload | null,
  options?: ConfirmPaymentOptions
): Promise<{ status: number; body: Record<string, any> }> {
  // 1. Authentication Gatekeeping
  if (!sessionUser) {
    return {
      status: 401,
      body: {
        error: "Unauthorized",
        message: "Authentication required to confirm payment.",
      },
    };
  }

  // 2. Active Workspace Gatekeeping
  if (!sessionUser.teamId) {
    return {
      status: 403,
      body: {
        error: "Forbidden",
        message: "User does not belong to an active workspace.",
      },
    };
  }

  // 3. Request Parameter Validation
  if (!body || typeof body !== "object") {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Invalid request body.",
      },
    };
  }

  const rawSessionId = body.sessionId;
  if (!rawSessionId || typeof rawSessionId !== "string" || !rawSessionId.trim()) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Missing or invalid sessionId in request body.",
      },
    };
  }

  const sessionId = rawSessionId.trim();

  // 4. Server-Side Verification: Retrieve Authoritative Session Directly from Provider
  const stripeClient = options?.stripeClient || defaultStripeClient;
  let session;
  try {
    session = await stripeClient.retrieveCheckoutSession(sessionId);
  } catch {
    return {
      status: 502,
      body: {
        error: "Bad Gateway",
        message: "Unable to verify checkout session with payment provider. Please try again later.",
      },
    };
  }

  if (!session) {
    return {
      status: 404,
      body: {
        error: "Not Found",
        message: `Checkout session '${sessionId}' was not found on the payment provider.`,
      },
    };
  }

  // 5. Authoritative Server-Side Status Check (Never trust client claims)
  // Strict Security Invariant: payment_status must strictly be "paid".
  // A status of "complete" with payment_status "unpaid" must be rejected.
  const isPaid = session.payment_status === "paid";
  if (!isPaid) {
    return {
      status: 422,
      body: {
        error: "Payment Incomplete",
        message: `Checkout session '${sessionId}' is not confirmed as paid. Provider payment_status: '${session.payment_status}'.`,
      },
    };
  }

  // 6. Tenant Boundary Verification: Session Must Belong to Caller's Workspace
  const sessionWorkspaceId = session.metadata?.workspace_id;
  if (String(sessionWorkspaceId) !== String(sessionUser.teamId)) {
    return {
      status: 403,
      body: {
        error: "Forbidden",
        message: "Tenant mismatch: This checkout session does not belong to your active workspace.",
      },
    };
  }

  // 7. Authoritative State Update: Use Authoritative Provider Fields ONLY
  // Discard any client-supplied amount, status, tier, or seats
  const processor = options?.processor || globalBillingProcessor;

  const result: ProcessEventResult = await processor.processEvent({
    id: `evt_confirm_${session.id}`,
    type: "checkout.session.completed",
    created: session.created || Math.floor(Date.now() / 1000),
    data: {
      object: session,
    },
  });

  const updatedSub = processor.getSubscriptionByWorkspace(sessionUser.teamId);

  return {
    status: 200,
    body: {
      success: true,
      subscription: updatedSub,
      outcome: result.status,
      message:
        result.status === "ignored_duplicate"
          ? `Payment for session ${sessionId} already confirmed and active.`
          : `Payment verified server-side. Workspace subscription activated.`,
    },
  };
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

    const { status, body: resBody } = await handleConfirmPayment(
      body,
      sessionUser
    );
    return Response.json(resBody, { status });
  } catch (error: any) {
    return Response.json(
      {
        error: "Internal Server Error",
        message: "An unexpected error occurred during payment confirmation.",
      },
      { status: 500 }
    );
  }
}
