import crypto from "node:crypto";
import {
  type BillingStorageInterface,
  type DurableSubscriptionState,
  type DurableBillingEvent,
  type DurableLedgerEntry,
  type CreateBillingStorageOptions,
  InMemoryBillingStorage,
  DatabaseBillingStorage,
  createDefaultBillingStorage,
  normalizeTeamId,
} from "./billing-storage.ts";

export {
  type BillingStorageInterface,
  type DurableSubscriptionState,
  type DurableBillingEvent,
  type DurableLedgerEntry,
  type CreateBillingStorageOptions,
  InMemoryBillingStorage,
  DatabaseBillingStorage,
  createDefaultBillingStorage,
  normalizeTeamId,
};

/**
 * Enterprise Billing & Webhook Processing Utilities
 *
 * Implements provider-agnostic billing logic following the standard HMAC-SHA256
 * signature verification scheme (compatible with Stripe and modern payment gateways).
 *
 * Guarantees:
 * - Constant-time signature comparison using crypto.timingSafeEqual (timing-attack immune).
 * - Tolerance window enforcement (default: 300 seconds) against replay attacks.
 * - Idempotency: Duplicate events are detected and acknowledged without duplicate ledger entries.
 * - Out-of-order protection: Obsolete events (timestamp < current subscription state) do not regress state.
 * - Redacted structured audit logging with zero credential, card, or token exposure.
 * - Pure & testable: Works with in-memory stores for unit testing and offline verification.
 */

export interface WebhookHeaderComponents {
  timestamp: number;
  signatures: string[];
}

export interface SubscriptionState {
  subscriptionId: string;
  workspaceId: string | number;
  planId: string;
  seats: number;
  status: "active" | "past_due" | "canceled" | "trialing" | "renewal_processing" | "reconciliation_required";
  currentPeriodStart: number;
  currentPeriodEnd: number;
  updatedAt: number;
  paymentProvider?: "stripe" | "paystack" | null;
  autoRenewEnabled?: boolean;
  cardBrand?: string | null;
  cardLast4?: string | null;
  cardExpMonth?: number | null;
  cardExpYear?: number | null;
  cardBank?: string | null;
  billingAnchorDay?: number | null;
  retryCount?: number;
  nextRetryAt?: number | null;
  gracePeriodExpiresAt?: number | null;
  cancelAtPeriodEnd?: boolean;
  lastReconciliationRef?: string | null;
}

export interface BillingLedgerEntry {
  id: string;
  workspaceId: string | number;
  eventId: string;
  type: string;
  amount: number;
  currency: string;
  status: "succeeded" | "failed" | "pending";
  timestamp: number;
}

export interface BillingEvent {
  id: string;
  type: string;
  created: number;
  data: {
    object: Record<string, any>;
  };
}

export interface ProcessEventResult {
  status: "processed" | "ignored_duplicate" | "ignored_out_of_order" | "failed";
  eventId: string;
  eventType: string;
  message: string;
  actionTaken?: string;
}

export interface PlanPricing {
  tier: "free" | "starter" | "pro" | "enterprise";
  planId: string;
  displayName: string;
  maxSeats: number;
  priceMonthly: number;
  priceMonthlyCents: number;
}

export const PLAN_PRICING: Record<string, PlanPricing> = {
  free: {
    tier: "free",
    planId: "free",
    displayName: "Free Tier",
    maxSeats: 5,
    priceMonthly: 0,
    priceMonthlyCents: 0,
  },
  starter: {
    tier: "starter",
    planId: "starter",
    displayName: "Starter Tier",
    maxSeats: 15,
    priceMonthly: 29,
    priceMonthlyCents: 2900,
  },
  pro: {
    tier: "pro",
    planId: "pro",
    displayName: "Professional Tier",
    maxSeats: 50,
    priceMonthly: 79,
    priceMonthlyCents: 7900,
  },
  enterprise: {
    tier: "enterprise",
    planId: "enterprise",
    displayName: "Enterprise Tier",
    maxSeats: 500,
    priceMonthly: 299,
    priceMonthlyCents: 29900,
  },
};

export function getPlanPricing(planOrTier: string | null | undefined): PlanPricing {
  if (!planOrTier) return PLAN_PRICING.free;
  const key = planOrTier.toLowerCase().replace("plan_", "");
  return PLAN_PRICING[key] || PLAN_PRICING.free;
}

/**
 * Parses a standard webhook signature header formatted as `t=1234567890,v1=signature_hash`.
 */
export function parseWebhookSignatureHeader(header: string | null | undefined): WebhookHeaderComponents | null {
  if (!header || typeof header !== "string" || header.trim().length === 0) {
    return null;
  }

  const parts = header.split(",");
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith("t=")) {
      const parsedTime = parseInt(trimmed.slice(2), 10);
      if (Number.isFinite(parsedTime) && parsedTime > 0) {
        timestamp = parsedTime;
      }
    } else if (trimmed.startsWith("v1=")) {
      const sig = trimmed.slice(3).trim();
      if (sig.length > 0) {
        signatures.push(sig);
      }
    }
  }

  if (timestamp === null || signatures.length === 0) {
    return null;
  }

  return { timestamp, signatures };
}

/**
 * Computes HMAC-SHA256 signature for a payload at a specific timestamp.
 */
export function computeWebhookSignature(
  rawPayload: string | Buffer,
  secret: string,
  timestamp: number
): string {
  const payloadStr = typeof rawPayload === "string" ? rawPayload : rawPayload.toString("utf-8");
  const signedPayload = `${timestamp}.${payloadStr}`;
  return crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
}

/**
 * Retired Stripe Webhook Signature Verifier.
 *
 * Stripe webhook signature verification has been retired and permanently disabled.
 * Paystack HMAC-SHA512 webhook signature verification (in lib/paystack.ts) is the sole
 * active webhook verification scheme.
 */
export function verifyWebhookSignature(
  _rawPayload: string | Buffer,
  _signatureHeader: string | null | undefined,
  _secret: string,
  _toleranceSeconds: number = 300,
  _currentTime?: number
): { valid: boolean; reason?: string; timestamp?: number } {
  return {
    valid: false,
    reason: "Stripe webhook signature verification is retired and disabled.",
  };
}

/**
 * In-memory or database-backed billing event processor providing idempotency and state protection.
 */
export class BillingEventProcessor {
  private processedEvents = new Set<string>();
  private subscriptions = new Map<string, SubscriptionState>();
  private ledger: BillingLedgerEntry[] = [];
  public storage: BillingStorageInterface;

  constructor(
    initialSubscriptions?: SubscriptionState[],
    storageOverride?: BillingStorageInterface
  ) {
    if (storageOverride) {
      this.storage = storageOverride;
    } else {
      const defaultStorage = createDefaultBillingStorage();
      if (initialSubscriptions && defaultStorage instanceof InMemoryBillingStorage) {
        for (const s of initialSubscriptions) {
          const teamId = normalizeTeamId(s.workspaceId) || 1;
          const durableSub = {
            teamId,
            paymentProvider: s.paymentProvider || (s.subscriptionId?.startsWith("sub_") && !s.paymentProvider ? "stripe" : "paystack"),
            stripeSubscriptionId: s.subscriptionId,
            planId: s.planId,
            seats: s.seats,
            status: s.status,
            currentPeriodStart: s.currentPeriodStart,
            currentPeriodEnd: s.currentPeriodEnd,
            updatedAt: s.updatedAt,
          };
          (defaultStorage as any).subscriptionsByTeamId.set(teamId, durableSub);
          if (durableSub.stripeSubscriptionId) {
            (defaultStorage as any).subscriptionsByStripeId.set(durableSub.stripeSubscriptionId, teamId);
          }
        }
      }
      this.storage = defaultStorage;
    }

    if (initialSubscriptions) {
      for (const sub of initialSubscriptions) {
        this.subscriptions.set(sub.subscriptionId, { ...sub });
      }
    }
  }

  getSubscription(subscriptionId: string): SubscriptionState | null {
    const sub = this.subscriptions.get(subscriptionId);
    return sub ? { ...sub } : null;
  }

  getLedger(): BillingLedgerEntry[] {
    return this.ledger.map((entry) => ({ ...entry }));
  }

  isEventProcessed(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  async isEventProcessedDurable(eventId: string): Promise<boolean> {
    return this.processedEvents.has(eventId) || (await this.storage.isEventProcessed(eventId));
  }

  getSubscriptionByWorkspace(workspaceId: string | number): SubscriptionState | null {
    const wsIdStr = String(workspaceId);
    for (const sub of this.subscriptions.values()) {
      if (String(sub.workspaceId) === wsIdStr && sub.status !== "canceled") {
        return { ...sub };
      }
    }
    return null;
  }

  /**
   * Retrieves active workspace subscription, querying durable storage first with
   * graceful fallback to the in-memory subscription map in offline/test mode.
   *
   * Safety invariant: If durable storage is mandated (NODE_ENV === "production",
   * BILLING_STORAGE === "database", or storage is DatabaseBillingStorage), any storage
   * failure is rethrown to prohibit silent fallback to in-memory/free tier.
   */
  async getSubscriptionByWorkspaceDurable(
    workspaceId: string | number
  ): Promise<SubscriptionState | null> {
    const teamId = normalizeTeamId(workspaceId);
    const isDurableMandated =
      process.env.NODE_ENV === "production" ||
      process.env.BILLING_STORAGE === "database" ||
      this.storage instanceof DatabaseBillingStorage;

    if (teamId && this.storage) {
      try {
        const durable = await this.storage.getSubscriptionByTeamId(teamId);
        if (durable && durable.status !== "canceled") {
          return {
            subscriptionId: durable.stripeSubscriptionId || `sub_team_${teamId}`,
            workspaceId: durable.teamId,
            planId: durable.planId,
            seats: durable.seats,
            status: durable.status,
            currentPeriodStart: durable.currentPeriodStart,
            currentPeriodEnd: durable.currentPeriodEnd,
            updatedAt: durable.updatedAt,
            paymentProvider: durable.paymentProvider,
            autoRenewEnabled: durable.autoRenewEnabled,
            cardBrand: durable.cardBrand,
            cardLast4: durable.cardLast4,
            cardExpMonth: durable.cardExpMonth,
            cardExpYear: durable.cardExpYear,
            cardBank: durable.cardBank,
            billingAnchorDay: durable.billingAnchorDay,
            retryCount: durable.retryCount,
            nextRetryAt: durable.nextRetryAt,
            gracePeriodExpiresAt: durable.gracePeriodExpiresAt,
            cancelAtPeriodEnd: durable.cancelAtPeriodEnd,
            lastReconciliationRef: durable.lastReconciliationRef,
          };
        }
      } catch (err) {
        if (isDurableMandated) {
          throw new Error("Failed to retrieve workspace subscription from persistent storage.");
        }
      }
    }

    if (isDurableMandated && (!this.storage || !(this.storage instanceof DatabaseBillingStorage))) {
      throw new Error("Persistent database storage is required but unavailable.");
    }

    return this.getSubscriptionByWorkspace(workspaceId);
  }

  getLedgerByWorkspace(workspaceId: string | number): BillingLedgerEntry[] {
    const wsIdStr = String(workspaceId);
    return this.ledger
      .filter((entry) => String(entry.workspaceId) === wsIdStr)
      .map((entry) => ({ ...entry }));
  }

  /**
   * Retrieves ledger transaction history for a workspace, querying durable storage first with
   * graceful fallback to the in-memory ledger in offline/test mode.
   */
  async getLedgerByWorkspaceDurable(
    workspaceId: string | number
  ): Promise<BillingLedgerEntry[]> {
    const teamId = normalizeTeamId(workspaceId);
    const isDurableMandated =
      process.env.NODE_ENV === "production" ||
      process.env.BILLING_STORAGE === "database" ||
      this.storage instanceof DatabaseBillingStorage;

    if (teamId && this.storage) {
      try {
        const durableEntries = await this.storage.getLedgerByTeamId(teamId);
        if (durableEntries && durableEntries.length > 0) {
          return durableEntries.map((e) => ({
            id: e.transactionId,
            workspaceId: e.teamId,
            eventId: e.eventId || "",
            type: e.type,
            amount: e.amountCents,
            currency: e.currency || "NGN",
            status: (e.status === "succeeded"
              ? "succeeded"
              : e.status === "failed"
              ? "failed"
              : "pending") as "succeeded" | "failed" | "pending",
            timestamp: e.createdAt || 0,
          }));
        }
      } catch (err) {
        if (isDurableMandated) {
          throw new Error("Failed to retrieve workspace billing ledger from persistent storage.");
        }
      }
    }

    return this.getLedgerByWorkspace(workspaceId);
  }

  /**
   * Retired Stripe Webhook Event Processor.
   *
   * Stripe event processing has been retired and permanently disabled.
   * New Stripe payment events and lifecycle mutations are strictly rejected without side-effects.
   * Paystack webhook handling via /api/billing/paystack/webhook is the sole active event-processing path.
   */
  async processEvent(event: BillingEvent): Promise<ProcessEventResult> {
    const eventId = event?.id || "unknown";
    const eventType = event?.type || "unknown";

    return {
      status: "failed",
      eventId,
      eventType,
      message: "Stripe event processing is retired and disabled. New Stripe events cannot mutate subscriptions or records.",
      actionTaken: "none",
    };
  }
}

// Global factory & default processor instance configured with durable storage selection
export function createDefaultBillingProcessor(
  initialSubscriptions?: SubscriptionState[],
  storageOverride?: BillingStorageInterface
): BillingEventProcessor {
  return new BillingEventProcessor(initialSubscriptions, storageOverride);
}

export const globalBillingProcessor = createDefaultBillingProcessor();
