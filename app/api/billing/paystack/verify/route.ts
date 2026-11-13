import { getSessionUser } from "../../../../../lib/session.ts";
import { isSameOriginRequest } from "../../../../../lib/oauth/safe-redirect.ts";
import {
  PAYSTACK_PLANS,
  getPaystackPlan,
  defaultPaystackClient,
  type PaystackClientInterface,
} from "../../../../../lib/paystack.ts";
import {
  createDefaultBillingStorage,
  preparePaystackAuthorizationState,
  type BillingStorageInterface,
  type DurableSubscriptionState,
} from "../../../../../lib/billing-storage.ts";
import { advanceCalendarMonth, resolveAnchorDay } from "../../../../../lib/billing-calendar.ts";
import type { SessionPayload } from "../../../../../lib/auth.ts";

export interface PaystackVerifyOptions {
  client?: PaystackClientInterface;
  storage?: BillingStorageInterface;
  currentTime?: number;
  encryptionKey?: string | Buffer;
}

/**
 * Pure testable handler for server-side Paystack payment verification and activation.
 *
 * Strict Security Invariants:
 * 1. Never trusts payment status, amounts, or plans supplied by the browser.
 * 2. Authoritative server-side verification directly against the Paystack gateway.
 * 3. Strict amount, currency, reference, and workspace matching.
 * 4. Idempotent confirmation: multiple callbacks for the same transaction acknowledge safely.
 * 5. Reusable authorization encryption (AES-256-GCM); plaintext is NEVER stored.
 * 6. Non-reusable authorizations strictly result in autoRenewEnabled: false.
 */
export function sanitizeSubscriptionForClient(
  sub: DurableSubscriptionState | null | undefined
): Record<string, any> | null {
  if (!sub) return null;
  const {
    paystackAuthCipher,
    paystackAuthIv,
    paystackAuthTag,
    renewalLeaseToken,
    ...clientSafe
  } = sub;
  return clientSafe;
}

export async function handlePaystackVerify(
  body: any,
  sessionUser: SessionPayload | null,
  options?: PaystackVerifyOptions
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
        message: "Authentication required to verify payment.",
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

  // 3. Request Body Validation
  if (!body || typeof body !== "object") {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Invalid request body.",
      },
    };
  }

  const rawReference = body.reference || body.trxref;
  if (!rawReference || typeof rawReference !== "string" || !rawReference.trim()) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Missing or invalid payment reference.",
      },
    };
  }

  const reference = rawReference.trim();

  // 4. Authoritative Gateway Verification
  const client = options?.client || defaultPaystackClient;
  let verifyResult;
  try {
    verifyResult = await client.verifyTransaction(reference);
  } catch {
    return {
      status: 502,
      body: {
        error: "Bad Gateway",
        message: "Unable to verify transaction with Paystack. Please try again later.",
      },
    };
  }

  if (!verifyResult || !verifyResult.data) {
    return {
      status: 404,
      body: {
        error: "Not Found",
        message: `Transaction '${reference}' was not found on Paystack gateway.`,
      },
    };
  }

  const txData = verifyResult.data;

  // 5. Authoritative Status Check
  if (txData.status !== "success") {
    return {
      status: 422,
      body: {
        error: "Unprocessable Payment",
        message: `Payment verification failed: transaction status is '${txData.status}'.`,
        gatewayResponse: txData.gateway_response || txData.status,
      },
    };
  }

  // 6. Strict Currency Matching
  if (txData.currency !== "NGN") {
    return {
      status: 422,
      body: {
        error: "Currency Mismatch",
        message: `Unexpected currency '${txData.currency}'. Expected 'NGN'.`,
      },
    };
  }

  // 7. Workspace / Tenant Isolation Matching
  const metadata = txData.metadata || {};
  const metaWorkspaceId = metadata.workspace_id;
  if (!metaWorkspaceId || String(metaWorkspaceId) !== String(sessionUser.teamId)) {
    return {
      status: 403,
      body: {
        error: "Tenant Mismatch",
        message: "Transaction workspace does not match authenticated user workspace.",
      },
    };
  }

  // 8. Strict Plan & Amount Matching
  const planId = typeof metadata.plan_id === "string" ? metadata.plan_id.toLowerCase().trim() : "";
  const planConfig = PAYSTACK_PLANS[planId];
  if (!planConfig || planId === "free") {
    return {
      status: 422,
      body: {
        error: "Invalid Plan",
        message: `Transaction references an unrecognized or invalid plan '${planId}'.`,
      },
    };
  }

  const expectedAmountKobo = planConfig.monthlyKobo;
  if (txData.amount !== expectedAmountKobo) {
    return {
      status: 422,
      body: {
        error: "Amount Mismatch",
        message: `Transaction amount ${txData.amount} kobo does not match expected plan price ${expectedAmountKobo} kobo.`,
      },
    };
  }

  // 9. Idempotency Check via Storage Financial Ledger
  const storage = options?.storage || createDefaultBillingStorage();
  const now = options?.currentTime ?? Math.floor(Date.now() / 1000);
  const eventId = `pstk_verify_${reference}`;

  // Short-circuit if event was already authoritatively processed
  if (await storage.isEventProcessed(eventId)) {
    const existingSub = await storage.getSubscriptionByTeamId(sessionUser.teamId);
    return {
      status: 200,
      body: {
        success: true,
        idempotent: true,
        provider: "paystack",
        message: "Transaction already verified and processed.",
        reference,
        subscription: sanitizeSubscriptionForClient(existingSub),
      },
    };
  }

  // Pre-persist event with status 'pending' to satisfy relational foreign key in billing_ledger.
  // Invariant: Pending event is NOT considered processed, ensuring failed operations remain retryable.
  await storage.recordEvent({
    eventId,
    eventType: "payment.verified",
    teamId: sessionUser.teamId,
    status: "pending",
    payload: {
      reference,
      amount: txData.amount,
      currency: txData.currency,
      channel: txData.channel,
      status: txData.status,
      plan: planId,
    },
    processedAt: now,
  });

  try {
    // Check if ledger already recorded this transaction
    const ledgerResult = await storage.recordLedgerEntry({
      transactionId: reference,
      teamId: sessionUser.teamId,
      eventId,
      type: "charge.success",
      amountCents: txData.amount, // in kobo
      currency: "NGN",
      status: "succeeded",
      metadata: {
        paystack_reference: reference,
        customer_code: txData.customer?.customer_code,
        authorization_reusable: txData.authorization?.reusable ?? false,
        channel: txData.channel || "card",
      },
      createdAt: now,
    });

    const existingSub = await storage.getSubscriptionByTeamId(sessionUser.teamId);
    if (
      ledgerResult.isDuplicate &&
      existingSub &&
      existingSub.status === "active" &&
      existingSub.paymentProvider === "paystack"
    ) {
      // Already fully activated previously
      if (typeof storage.updateEventStatus === "function") {
        await storage.updateEventStatus(eventId, "processed");
      }
      return {
        status: 200,
        body: {
          success: true,
          idempotent: true,
          message: "Transaction already verified and processed.",
          reference,
          subscription: sanitizeSubscriptionForClient(existingSub),
        },
      };
    }

    // 10. Authorization Processing & Encryption
    const preparedAuth = preparePaystackAuthorizationState({
      authorization: txData.authorization,
      encryptionKey: options?.encryptionKey,
    });

    // 11. Calendar-Month Advance & Anchor Day Pinning
    const currentPeriodStart = now;
    const anchorDay = resolveAnchorDay(now);
    const currentPeriodEnd = Math.floor(advanceCalendarMonth(now, anchorDay).getTime() / 1000);
    const seats = Number(metadata.seats) || planConfig.maxSeats;

    // 12. Authoritative Subscription Activation
    const subscriptionState: DurableSubscriptionState = {
      teamId: sessionUser.teamId,
      paymentProvider: "paystack",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paystackCustomerCode: txData.customer?.customer_code || null,
      paystackSubscriptionCode: null,
      paystackAuthCipher: preparedAuth.paystackAuthCipher,
      paystackAuthIv: preparedAuth.paystackAuthIv,
      paystackAuthTag: preparedAuth.paystackAuthTag,
      autoRenewEnabled: preparedAuth.autoRenewEnabled,
      cardBrand: preparedAuth.cardBrand,
      cardLast4: preparedAuth.cardLast4,
      cardExpMonth: preparedAuth.cardExpMonth,
      cardExpYear: preparedAuth.cardExpYear,
      cardBank: preparedAuth.cardBank,
      billingAnchorDay: anchorDay,
      renewalLeaseToken: null,
      renewalLeaseExpiresAt: null,
      retryCount: 0,
      nextRetryAt: null,
      gracePeriodExpiresAt: null,
      scheduledPlanId: null,
      scheduledSeats: null,
      lastReconciliationRef: reference,
      planId,
      seats,
      status: "active",
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: false,
      updatedAt: now,
    };

    const activatedSub = await storage.upsertSubscription(subscriptionState);

    // 13. Mark Event as PROCESSED only after BOTH ledger insertion AND subscription activation succeed
    if (typeof storage.updateEventStatus === "function") {
      await storage.updateEventStatus(eventId, "processed", {
        reference,
        amount: txData.amount,
        currency: txData.currency,
        channel: txData.channel,
        status: txData.status,
        plan: planId,
      });
    } else {
      await storage.recordEvent({
        eventId,
        eventType: "payment.verified",
        teamId: sessionUser.teamId,
        status: "processed",
        payload: {
          reference,
          amount: txData.amount,
          currency: txData.currency,
          channel: txData.channel,
          status: txData.status,
          plan: planId,
        },
        processedAt: now,
      });
    }

    return {
      status: 200,
      body: {
        success: true,
        provider: "paystack",
        reference,
        subscription: sanitizeSubscriptionForClient(activatedSub),
        plan: planConfig,
        autoRenewEnabled: activatedSub.autoRenewEnabled,
      },
    };
  } catch (err: any) {
    // Failure-safe transition: mark event as 'failed' so it remains un-processed and retryable
    if (typeof storage.updateEventStatus === "function") {
      try {
        await storage.updateEventStatus(eventId, "failed", { error: err?.message || String(err) });
      } catch {
        // Suppress secondary error
      }
    }
    throw err;
  }
}

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

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

    const { status, body: resBody } = await handlePaystackVerify(body, sessionUser);
    return Response.json(resBody, { status });
  } catch (err) {
    console.error("Payment verification route failure:", err);
    return Response.json(
      {
        error: "Internal Server Error",
        message: "An unexpected error occurred during payment verification.",
      },
      { status: 500 }
    );
  }
}
