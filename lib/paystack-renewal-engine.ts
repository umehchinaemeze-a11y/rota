import crypto from "node:crypto";
import {
  PAYSTACK_PLANS,
  getPaystackPlan,
  defaultPaystackClient,
  type PaystackClientInterface,
} from "./paystack.ts";
import {
  decryptAuthorizationCode,
} from "./paystack-security.ts";
import {
  createDefaultBillingStorage,
  type BillingStorageInterface,
  type DurableSubscriptionState,
} from "./billing-storage.ts";
import {
  advanceCalendarMonth,
  resolveAnchorDay,
} from "./billing-calendar.ts";

export interface RenewalEngineOptions {
  storage?: BillingStorageInterface;
  client?: PaystackClientInterface;
  leaseDurationSeconds?: number;
  currentTime?: number;
  encryptionKey?: string | Buffer;
  limit?: number;
}

export interface RenewalJobResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  reconciled: number;
  uncertain: number;
  details: Array<{
    teamId: number;
    status: "succeeded" | "failed" | "skipped" | "reconciled" | "uncertain";
    reference?: string;
    message?: string;
  }>;
}

/**
 * Enterprise Merchant-Managed Paystack Recurring Renewal Engine
 *
 * Implements:
 * 1. Durable PostgreSQL renewal leases & lease fencing (preventing concurrent worker collisions).
 * 2. Expired lease recovery (automatic reclamation of abandoned leases).
 * 3. Never holds database transactions open during external gateway network requests.
 * 4. Deterministic transaction references to prevent duplicate charges.
 * 5. Gateway prior-check verification before charging to reconcile uncertain states.
 * 6. True UTC calendar-month advancement pinning to customer's billingAnchorDay.
 * 7. Approved 7-day grace period with retries at days 2, 4, 6, and cancel on day 7.
 * 8. Strict provider exclusivity: only processes paymentProvider === 'paystack' records.
 */
export async function runPaystackRenewalCycle(
  options: RenewalEngineOptions = {}
): Promise<RenewalJobResult> {
  const storage = options.storage || createDefaultBillingStorage();
  const client = options.client || defaultPaystackClient;
  const leaseDurationSeconds = options.leaseDurationSeconds ?? 300; // 5-minute lease
  const now = options.currentTime ?? Math.floor(Date.now() / 1000);
  const limit = options.limit ?? 50;

  const result: RenewalJobResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    reconciled: 0,
    uncertain: 0,
    details: [],
  };

  // 1. Find Due Subscriptions
  if (!storage.findDueRenewals || !storage.acquireRenewalLease || !storage.releaseRenewalLease) {
    throw new Error("Billing storage implementation does not support renewal lease coordination.");
  }

  const dueSubscriptions = await storage.findDueRenewals(now, limit);

  for (const sub of dueSubscriptions) {
    result.processed++;

    // 2. Strict Provider Exclusivity: Only process Paystack with auto-renew enabled
    if (sub.paymentProvider !== "paystack" || !sub.autoRenewEnabled) {
      result.skipped++;
      result.details.push({
        teamId: sub.teamId,
        status: "skipped",
        message: "Subscription is not active for Paystack auto-renewal.",
      });
      continue;
    }

    // 3. Durable Lease Acquisition
    const leaseToken = crypto.randomUUID();
    const leaseAcquired = await storage.acquireRenewalLease(
      sub.teamId,
      leaseToken,
      leaseDurationSeconds,
      now
    );

    if (!leaseAcquired) {
      // Another worker or process currently holds an active lease
      result.skipped++;
      result.details.push({
        teamId: sub.teamId,
        status: "skipped",
        message: "Could not acquire renewal lease; worker lock held.",
      });
      continue;
    }

    try {
      // 4. Authorization Decryption Validation
      if (!sub.paystackAuthCipher || !sub.paystackAuthIv || !sub.paystackAuthTag) {
        // Missing credentials: disable auto-renew and transition to past_due
        await storage.upsertSubscription({
          ...sub,
          autoRenewEnabled: false,
          status: "past_due",
          updatedAt: now,
        });
        await storage.releaseRenewalLease(sub.teamId, leaseToken);
        result.failed++;
        result.details.push({
          teamId: sub.teamId,
          status: "failed",
          message: "Missing encrypted authorization components; auto-renewal disabled.",
        });
        continue;
      }

      let plaintextAuthCode: string;
      try {
        plaintextAuthCode = decryptAuthorizationCode(
          {
            cipherText: sub.paystackAuthCipher,
            iv: sub.paystackAuthIv,
            tag: sub.paystackAuthTag,
          },
          options.encryptionKey
        );
      } catch {
        // Undecryptable / corrupted authorization: disable auto-renew
        await storage.upsertSubscription({
          ...sub,
          autoRenewEnabled: false,
          status: "past_due",
          updatedAt: now,
        });
        await storage.releaseRenewalLease(sub.teamId, leaseToken);
        result.failed++;
        result.details.push({
          teamId: sub.teamId,
          status: "failed",
          message: "Authorization code undecryptable; auto-renewal disabled.",
        });
        continue;
      }

      // 5. Deterministic Reference Generation
      const retryCount = sub.retryCount || 0;
      const deterministicReference =
        sub.status === "reconciliation_required" && sub.lastReconciliationRef
          ? sub.lastReconciliationRef
          : `pstk_renew_${sub.teamId}_${sub.currentPeriodEnd}_${retryCount}`;

      // 6. Gateway Prior-Check Verification (Reconciliation before charging)
      // Checks if this exact deterministic reference was already charged
      let priorVerify = null;
      try {
        priorVerify = await client.verifyTransaction(deterministicReference);
      } catch {
        // Gateway 404 or verify error: transaction has not been executed yet
      }

      const planConfig = PAYSTACK_PLANS[sub.planId] || PAYSTACK_PLANS.starter;
      const amountKobo = planConfig.monthlyKobo;
      const anchorDay = sub.billingAnchorDay || resolveAnchorDay(sub.currentPeriodStart);

      if (priorVerify && priorVerify.data && priorVerify.data.status === "success") {
        // Lease fencing check: ensure our lease token has not been overtaken
        const currentRecord = await storage.getSubscriptionByTeamId(sub.teamId);
        if (currentRecord && currentRecord.renewalLeaseToken && currentRecord.renewalLeaseToken !== leaseToken) {
          result.skipped++;
          result.details.push({
            teamId: sub.teamId,
            status: "skipped",
            message: "Renewal lease token was invalidated or claimed by another worker. Stale update prevented.",
          });
          continue;
        }

        // Already successfully charged on gateway: reconcile and advance period
        const newStart = sub.currentPeriodEnd;
        const newEnd = Math.floor(advanceCalendarMonth(newStart, anchorDay).getTime() / 1000);

        await storage.recordLedgerEntry({
          transactionId: deterministicReference,
          teamId: sub.teamId,
          eventId: `pstk_renew_reconciled_${deterministicReference}`,
          type: "renewal.success",
          amountCents: amountKobo,
          currency: "NGN",
          status: "succeeded",
          metadata: { source: "reconciliation_prior_check" },
          createdAt: now,
        });

        await storage.upsertSubscription({
          ...sub,
          status: "active",
          currentPeriodStart: newStart,
          currentPeriodEnd: newEnd,
          retryCount: 0,
          nextRetryAt: null,
          gracePeriodExpiresAt: null,
          lastReconciliationRef: deterministicReference,
          updatedAt: now,
        });

        await storage.releaseRenewalLease(sub.teamId, leaseToken);
        result.reconciled++;
        result.details.push({
          teamId: sub.teamId,
          status: "reconciled",
          reference: deterministicReference,
          message: "Reconciled with previously successful gateway transaction.",
        });
        continue;
      }

      // 7. Execute Merchant-Managed Recurring Charge (OUTSIDE any database transaction)
      let chargeResponse;
      try {
        chargeResponse = await client.chargeAuthorization({
          authorizationCode: plaintextAuthCode,
          email: `workspace_${sub.teamId}@rota.internal`,
          amountKobo,
          currency: "NGN",
          reference: deterministicReference,
          metadata: {
            workspace_id: sub.teamId,
            plan_id: sub.planId,
            seats: sub.seats,
            renewal: true,
            retry_count: retryCount,
          },
        });
      } catch (gatewayErr: any) {
        // Network timeout / gateway error: mark uncertain outcome and reconcile before retrying
        await storage.upsertSubscription({
          ...sub,
          status: "reconciliation_required",
          lastReconciliationRef: deterministicReference,
          updatedAt: now,
        });
        await storage.releaseRenewalLease(sub.teamId, leaseToken);
        result.uncertain++;
        result.details.push({
          teamId: sub.teamId,
          status: "uncertain",
          reference: deterministicReference,
          message: `Gateway call timeout/error: ${gatewayErr?.message || "Uncertain response"}. Reconcile before retrying.`,
        });
        continue;
      }

      // 8. Process Charge Response
      // Lease fencing check: ensure our lease token has not been overtaken before committing charge results
      const currentRecordAfterCharge = await storage.getSubscriptionByTeamId(sub.teamId);
      if (currentRecordAfterCharge && currentRecordAfterCharge.renewalLeaseToken && currentRecordAfterCharge.renewalLeaseToken !== leaseToken) {
        result.skipped++;
        result.details.push({
          teamId: sub.teamId,
          status: "skipped",
          message: "Renewal lease token was invalidated or claimed by another worker. Stale commit prevented.",
        });
        continue;
      }

      const chargeData = chargeResponse?.data;
      if (chargeResponse && chargeResponse.status && chargeData?.status === "success") {
        // Renewal Charge Succeeded: Advance calendar month and record ledger entry
        const newStart = sub.currentPeriodEnd;
        const newEnd = Math.floor(advanceCalendarMonth(newStart, anchorDay).getTime() / 1000);

        await storage.recordLedgerEntry({
          transactionId: deterministicReference,
          teamId: sub.teamId,
          eventId: `pstk_renew_success_${deterministicReference}`,
          type: "renewal.success",
          amountCents: amountKobo,
          currency: "NGN",
          status: "succeeded",
          metadata: {
            channel: chargeData?.channel || chargeData?.authorization?.channel || "card",
            reference: deterministicReference,
            source: "renewal_engine",
          },
          createdAt: now,
        });

        await storage.upsertSubscription({
          ...sub,
          status: "active",
          currentPeriodStart: newStart,
          currentPeriodEnd: newEnd,
          retryCount: 0,
          nextRetryAt: null,
          gracePeriodExpiresAt: null,
          lastReconciliationRef: deterministicReference,
          updatedAt: now,
        });

        await storage.releaseRenewalLease(sub.teamId, leaseToken);
        result.succeeded++;
        result.details.push({
          teamId: sub.teamId,
          status: "succeeded",
          reference: deterministicReference,
          message: "Subscription successfully renewed for next calendar month.",
        });
      } else {
        // Renewal Charge Failed / Declined: Enter or update 7-day grace period
        const newRetryCount = retryCount + 1;
        const graceExpires = sub.gracePeriodExpiresAt || now + 7 * 86400; // 7-day grace period

        await storage.recordLedgerEntry({
          transactionId: deterministicReference,
          teamId: sub.teamId,
          eventId: `pstk_renew_fail_${deterministicReference}`,
          type: "renewal.failed",
          amountCents: amountKobo,
          currency: "NGN",
          status: "failed",
          metadata: {
            reason: chargeData?.gateway_response || "Card declined",
            reference: deterministicReference,
            source: "renewal_engine",
          },
          createdAt: now,
        });

        if (now < graceExpires && newRetryCount < 4) {
          // Retry scheduled at approx +48h (days 2, 4, 6)
          const nextRetryAt = now + 48 * 3600;
          await storage.upsertSubscription({
            ...sub,
            status: "past_due",
            retryCount: newRetryCount,
            nextRetryAt,
            gracePeriodExpiresAt: graceExpires,
            lastReconciliationRef: deterministicReference,
            updatedAt: now,
          });
        } else {
          // Grace Period Expired (day 7) or max retries exhausted: cancel subscription
          await storage.upsertSubscription({
            ...sub,
            status: "canceled",
            autoRenewEnabled: false,
            retryCount: newRetryCount,
            nextRetryAt: null,
            lastReconciliationRef: deterministicReference,
            updatedAt: now,
          });
        }

        await storage.releaseRenewalLease(sub.teamId, leaseToken);
        result.failed++;
        result.details.push({
          teamId: sub.teamId,
          status: "failed",
          reference: deterministicReference,
          message: `Charge declined (${chargeData?.gateway_response || "Declined"}). Status updated with grace period schedule.`,
        });
      }
    } catch (err: any) {
      // Fail-closed recovery: ensure lease is released on unexpected errors
      await storage.releaseRenewalLease(sub.teamId, leaseToken).catch(() => {});
      result.failed++;
      result.details.push({
        teamId: sub.teamId,
        status: "failed",
        message: `Unexpected renewal processing error: ${err?.message || "Unknown error"}`,
      });
    }
  }

  return result;
}
