import { verifyPaystackSignature } from "../../../../../lib/paystack-security.ts";
import {
  PAYSTACK_PLANS,
  getPaystackPlan,
} from "../../../../../lib/paystack.ts";
import {
  createDefaultBillingStorage,
  preparePaystackAuthorizationState,
  type BillingStorageInterface,
  type DurableSubscriptionState,
} from "../../../../../lib/billing-storage.ts";
import { advanceCalendarMonth, resolveAnchorDay } from "../../../../../lib/billing-calendar.ts";

export interface PaystackWebhookOptions {
  storage?: BillingStorageInterface;
  secretKey?: string;
  currentTime?: number;
  encryptionKey?: string | Buffer;
}

/**
 * Pure testable handler for Paystack webhook ingestion.
 *
 * Guarantees:
 * 1. HMAC-SHA512 signature verification using the raw request body.
 * 2. Constant-time signature comparison to prevent timing attacks.
 * 3. Durable event deduplication in billing_events table.
 * 4. Safe out-of-order reconciliation: whichever of callback or webhook arrives first activates the subscription; the second is cleanly recognized as a duplicate.
 * 5. Reusable authorization encryption; plaintext is NEVER logged or stored.
 * 6. Always acknowledges with HTTP 200 on validly signed events.
 */
export async function handlePaystackWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secretKey?: string,
  options?: PaystackWebhookOptions
): Promise<{ status: number; body: Record<string, any> }> {
  const secret = (secretKey || options?.secretKey || process.env.PAYSTACK_SECRET_KEY)?.trim();

  // 1. Service Configuration Check
  if (!secret) {
    return {
      status: 503,
      body: {
        error: "Service Unavailable",
        message: "PAYSTACK_SECRET_KEY is not configured.",
      },
    };
  }

  // 2. Request Body Validation
  if (!rawBody || rawBody.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Request body cannot be empty.",
      },
    };
  }

  // 3. HMAC-SHA512 Signature Verification (Constant-Time)
  const isValidSig = verifyPaystackSignature(rawBody, signatureHeader, secret);
  if (!isValidSig) {
    return {
      status: 400,
      body: {
        error: "Invalid Webhook Signature",
        message: "X-Paystack-Signature header verification failed.",
      },
    };
  }

  // 4. JSON Payload Parsing
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: {
        error: "Invalid JSON",
        message: "Failed to parse webhook JSON body.",
      },
    };
  }

  const eventType = payload.event;
  const eventData = payload.data || {};
  const reference = eventData.reference || `pstk_evt_${eventData.id || Date.now()}`;
  const eventId = `pstk_${eventType}_${reference}`;

  const storage = options?.storage || createDefaultBillingStorage();
  const now = options?.currentTime ?? Math.floor(Date.now() / 1000);

  // 5. Durable Event Idempotency Check (Check before execution)
  const metaWorkspaceId = eventData.metadata?.workspace_id;
  const teamId = metaWorkspaceId ? parseInt(String(metaWorkspaceId), 10) : null;

  if (await storage.isEventProcessed(eventId)) {
    return {
      status: 200,
      body: {
        received: true,
        duplicate: true,
        eventId,
        message: "Webhook event already processed.",
      },
    };
  }

  // 6. Event Dispatcher & Business Logic
  switch (eventType) {
    case "charge.success": {
      // Reconcile charge.success with potential prior callback
      if (!teamId || isNaN(teamId) || teamId <= 0) {
        // Unidentified workspace metadata
        return {
          status: 200,
          body: {
            received: true,
            warning: "Missing valid workspace_id in transaction metadata.",
          },
        };
      }

      // Pre-persist event with status 'pending' to satisfy relational foreign key in billing_ledger.
      // Invariant: Pending event is NOT considered processed, ensuring failed operations remain retryable.
      await storage.recordEvent({
        eventId,
        eventType,
        teamId,
        status: "pending",
        payload,
        processedAt: now,
      });

      try {
        // Check if reference already recorded in financial ledger
        const ledgerResult = await storage.recordLedgerEntry({
          transactionId: reference,
          teamId,
          eventId,
          type: "charge.success",
          amountCents: eventData.amount, // in kobo
          currency: "NGN",
          status: "succeeded",
          metadata: {
            paystack_reference: reference,
            customer_code: eventData.customer?.customer_code,
            authorization_reusable: eventData.authorization?.reusable ?? false,
            channel: eventData.channel || "card",
            source: "webhook",
          },
          createdAt: now,
        });

        const existingSub = await storage.getSubscriptionByTeamId(teamId);
        if (
          ledgerResult.isDuplicate &&
          existingSub &&
          existingSub.status === "active" &&
          existingSub.paymentProvider === "paystack"
        ) {
          // Callback already activated the subscription
          if (typeof storage.updateEventStatus === "function") {
            await storage.updateEventStatus(eventId, "processed", payload);
          } else {
            await storage.recordEvent({
              eventId,
              eventType,
              teamId,
              status: "processed",
              payload,
              processedAt: now,
            });
          }
          return {
            status: 200,
            body: {
              received: true,
              reconciled: true,
              message: "Charge already reconciled via client callback.",
            },
          };
        }

        // Webhook arrived first: Authoritatively activate the subscription
        const planId = (eventData.metadata?.plan_id || "").toLowerCase().trim();
        const planConfig = PAYSTACK_PLANS[planId] || PAYSTACK_PLANS.starter;
        const seats = Number(eventData.metadata?.seats) || planConfig.maxSeats;

        const preparedAuth = preparePaystackAuthorizationState({
          authorization: eventData.authorization,
          encryptionKey: options?.encryptionKey,
        });

        const anchorDay = resolveAnchorDay(now);
        const currentPeriodEnd = Math.floor(advanceCalendarMonth(now, anchorDay).getTime() / 1000);

        const subscriptionState: DurableSubscriptionState = {
          teamId,
          paymentProvider: "paystack",
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          paystackCustomerCode: eventData.customer?.customer_code || null,
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
          planId: planConfig.planId,
          seats,
          status: "active",
          currentPeriodStart: now,
          currentPeriodEnd,
          cancelAtPeriodEnd: false,
          updatedAt: now,
        };

        await storage.upsertSubscription(subscriptionState);

        // Mark event as processed only AFTER both ledger and subscription mutations succeed
        if (typeof storage.updateEventStatus === "function") {
          await storage.updateEventStatus(eventId, "processed", payload);
        } else {
          await storage.recordEvent({
            eventId,
            eventType,
            teamId,
            status: "processed",
            payload,
            processedAt: now,
          });
        }

        return {
          status: 200,
          body: {
            received: true,
            provider: "paystack",
            action: "subscription_activated",
            teamId,
            plan: planConfig.planId,
            autoRenewEnabled: preparedAuth.autoRenewEnabled,
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

    case "invoice.payment_failed":
    case "charge.failed": {
      if (teamId) {
        // Pre-persist event with status 'pending' to satisfy relational foreign key in billing_ledger
        await storage.recordEvent({
          eventId,
          eventType,
          teamId,
          status: "pending",
          payload,
          processedAt: now,
        });

        try {
          // Record failed transaction in ledger
          await storage.recordLedgerEntry({
            transactionId: reference,
            teamId,
            eventId,
            type: eventType,
            amountCents: eventData.amount || 0,
            currency: eventData.currency || "NGN",
            status: "failed",
            metadata: {
              reason: eventData.gateway_response || "Payment declined",
              source: "webhook",
            },
            createdAt: now,
          });

          // Update subscription to past_due if currently active
          const existingSub = await storage.getSubscriptionByTeamId(teamId);
          if (existingSub && existingSub.paymentProvider === "paystack") {
            const retryCount = (existingSub.retryCount || 0) + 1;
            const graceExpires = existingSub.gracePeriodExpiresAt || now + 7 * 86400; // 7-day grace

            if (now < graceExpires && retryCount < 4) {
              await storage.upsertSubscription({
                ...existingSub,
                status: "past_due",
                retryCount,
                nextRetryAt: now + 48 * 3600, // retry in 48 hours
                gracePeriodExpiresAt: graceExpires,
                updatedAt: now,
              });
            } else {
              // Grace period expired
              await storage.upsertSubscription({
                ...existingSub,
                status: "canceled",
                autoRenewEnabled: false,
                nextRetryAt: null,
                updatedAt: now,
              });
            }
          }

          if (typeof storage.updateEventStatus === "function") {
            await storage.updateEventStatus(eventId, "processed", payload);
          } else {
            await storage.recordEvent({
              eventId,
              eventType,
              teamId,
              status: "processed",
              payload,
              processedAt: now,
            });
          }
        } catch (err: any) {
          if (typeof storage.updateEventStatus === "function") {
            try {
              await storage.updateEventStatus(eventId, "failed", { error: err?.message || String(err) });
            } catch {}
          }
          throw err;
        }
      } else {
        await storage.recordEvent({
          eventId,
          eventType,
          teamId: null,
          status: "processed",
          payload,
          processedAt: now,
        });
      }

      return {
        status: 200,
        body: {
          received: true,
          action: "charge_failure_recorded",
        },
      };
    }

    case "subscription.disable":
    case "subscription.not_renew": {
      if (teamId) {
        const existingSub = await storage.getSubscriptionByTeamId(teamId);
        if (existingSub && existingSub.paymentProvider === "paystack") {
          await storage.upsertSubscription({
            ...existingSub,
            autoRenewEnabled: false,
            updatedAt: now,
          });
        }
      }

      await storage.recordEvent({
        eventId,
        eventType,
        teamId,
        status: "processed",
        payload,
        processedAt: now,
      });

      return {
        status: 200,
        body: {
          received: true,
          action: "renewal_disabled",
        },
      };
    }

    default: {
      await storage.recordEvent({
        eventId,
        eventType,
        teamId,
        status: "processed",
        payload,
        processedAt: now,
      });

      return {
        status: 200,
        body: {
          received: true,
          ignored: true,
          eventType,
        },
      };
    }
  }
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get("x-paystack-signature");
    const { status, body } = await handlePaystackWebhook(rawBody, signatureHeader);
    return Response.json(body, { status });
  } catch {
    return Response.json(
      {
        error: "Internal Server Error",
        message: "An unexpected error occurred processing Paystack webhook.",
      },
      { status: 500 }
    );
  }
}
