/**
 * Billing Provider Verification Badge Resolver
 *
 * Enforces strict verification accuracy invariants:
 * 1. An unverified provider must NEVER default to "paystack".
 * 2. "Verified via Paystack" is strictly reserved for paid subscriptions with an explicit,
 *    authoritative backend paymentProvider record.
 * 3. "Verified via Stripe" is strictly reserved for historical Stripe subscriptions with
 *    authoritative historical payment evidence (e.g. successful ledger transaction).
 * 4. Free Plan, missing subscriptions, or unverified transactions must display
 *    neutral or unverified status.
 */

export type PaymentProvider = "paystack" | "stripe" | null;

export interface BillingBadgeParams {
  planId?: string | null;
  paymentProvider?: PaymentProvider;
  subscriptionStatus?: string | null;
  isHistorical?: boolean;
  isNew?: boolean;
  hasPaymentEvidence?: boolean;
  ledger?: Array<{
    status?: string;
    transactionId?: string;
    amount?: number;
    amountCents?: number;
    type?: string;
  }> | null;
}

export interface BillingBadgeResult {
  text: string;
  isVerified: boolean;
  className: string;
  provider: PaymentProvider;
}

export function resolveBillingVerificationBadge(
  params: BillingBadgeParams
): BillingBadgeResult {
  const plan = params.planId?.trim().toLowerCase() || "free";
  const rawProvider = params.paymentProvider;
  const provider: PaymentProvider =
    rawProvider === "paystack" || rawProvider === "stripe" ? rawProvider : null;

  // 1. Free plan or absent subscription: neutral non-paid state
  if (plan === "free" || !params.planId) {
    return {
      text: "No paid subscription yet",
      isVerified: false,
      className: "text-slate-500 font-normal",
      provider: null,
    };
  }

  // 2. Paid tier (starter, pro, enterprise) but provider is missing or unverified
  if (!provider) {
    return {
      text: "Pending Provider Verification",
      isVerified: false,
      className: "text-amber-700 font-medium",
      provider: null,
    };
  }

  // 3. Paid plan with canceled subscription
  if (params.subscriptionStatus === "canceled") {
    return {
      text: `Canceled · Prior ${provider === "stripe" ? "Stripe" : "Paystack"}`,
      isVerified: false,
      className: "text-slate-500 font-medium",
      provider,
    };
  }

  // 4. Paid plan with explicitly verified Paystack payment
  if (provider === "paystack") {
    return {
      text: "Authoritative · Verified via Paystack",
      isVerified: true,
      className: "text-emerald-700 font-medium",
      provider: "paystack",
    };
  }

  // 5. Paid plan with Stripe payment provider
  if (provider === "stripe") {
    // New Stripe subscriptions cannot be represented as verified since Stripe is retired
    if (params.isNew === true || params.isHistorical === false) {
      return {
        text: "Stripe Retired · Unverified",
        isVerified: false,
        className: "text-rose-700 font-medium",
        provider: "stripe",
      };
    }

    // Historical financial verification requires suitable historical payment evidence
    // (e.g. corresponding successful historical ledger entry)
    let hasEvidence = params.hasPaymentEvidence === true;
    if (params.hasPaymentEvidence === undefined && Array.isArray(params.ledger) && params.ledger.length > 0) {
      hasEvidence = params.ledger.some(
        (entry) => entry && entry.status === "succeeded"
      );
    }

    if (!hasEvidence) {
      return {
        text: "Historical Stripe · Unverified",
        isVerified: false,
        className: "text-amber-700 font-medium",
        provider: "stripe",
      };
    }

    return {
      text: "Authoritative · Verified via Stripe",
      isVerified: true,
      className: "text-emerald-700 font-medium",
      provider: "stripe",
    };
  }

  // Default fallback
  return {
    text: "No paid subscription yet",
    isVerified: false,
    className: "text-slate-500 font-normal",
    provider: null,
  };
}
