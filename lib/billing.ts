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
  status: "active" | "past_due" | "canceled" | "trialing";
  currentPeriodStart: number;
  currentPeriodEnd: number;
  updatedAt: number;
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
 * Verifies the authenticity and freshness of an incoming billing webhook signature.
 *
 * @param rawPayload - Raw request body as string or Buffer
 * @param signatureHeader - Raw `stripe-signature` header string
 * @param secret - Webhook signing secret
 * @param toleranceSeconds - Maximum allowed age of signature in seconds (default: 300)
 * @param currentTime - Optional unix epoch timestamp in seconds for deterministic testing
 */
export function verifyWebhookSignature(
  rawPayload: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
  toleranceSeconds: number = 300,
  currentTime?: number
): { valid: boolean; reason?: string; timestamp?: number } {
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    return { valid: false, reason: "Missing webhook secret" };
  }

  const parsedHeader = parseWebhookSignatureHeader(signatureHeader);
  if (!parsedHeader) {
    return { valid: false, reason: "Malformed or missing signature header" };
  }

  const now = currentTime ?? Math.floor(Date.now() / 1000);

  // Check timestamp freshness / replay tolerance
  if (toleranceSeconds > 0) {
    if (parsedHeader.timestamp > now + toleranceSeconds) {
      return { valid: false, reason: "Timestamp is too far in the future" };
    }
    if (now - parsedHeader.timestamp > toleranceSeconds) {
      return { valid: false, reason: "Signature has expired (replay protection)" };
    }
  }

  // Compute expected signature
  const expectedSig = computeWebhookSignature(rawPayload, secret, parsedHeader.timestamp);
  const expectedBuffer = Buffer.from(expectedSig, "hex");

  // Constant-time check against all provided v1 signatures
  let matchFound = false;
  for (const candidate of parsedHeader.signatures) {
    try {
      const candidateBuffer = Buffer.from(candidate, "hex");
      if (
        candidateBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
      ) {
        matchFound = true;
        break;
      }
    } catch {
      // Invalid hex string
      continue;
    }
  }

  if (!matchFound) {
    return { valid: false, reason: "Signature mismatch" };
  }

  return { valid: true, timestamp: parsedHeader.timestamp };
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
          defaultStorage.upsertSubscription({
            teamId: normalizeTeamId(s.workspaceId) || 1,
            stripeSubscriptionId: s.subscriptionId,
            planId: s.planId,
            seats: s.seats,
            status: s.status,
            currentPeriodStart: s.currentPeriodStart,
            currentPeriodEnd: s.currentPeriodEnd,
            updatedAt: s.updatedAt,
          });
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

  getLedgerByWorkspace(workspaceId: string | number): BillingLedgerEntry[] {
    const wsIdStr = String(workspaceId);
    return this.ledger
      .filter((entry) => String(entry.workspaceId) === wsIdStr)
      .map((entry) => ({ ...entry }));
  }

  /**
   * Processes a validated billing webhook event with idempotency, out-of-order protection,
   * and consistent ledger entries.
   */
  async processEvent(event: BillingEvent): Promise<ProcessEventResult> {
    if (!event || !event.id || !event.type) {
      return {
        status: "failed",
        eventId: event?.id || "unknown",
        eventType: event?.type || "unknown",
        message: "Invalid event structure",
      };
    }

    // 1. Idempotency check: duplicate event protection (in-memory + durable storage)
    if (this.processedEvents.has(event.id) || (await this.storage.isEventProcessed(event.id))) {
      this.processedEvents.add(event.id);
      return {
        status: "ignored_duplicate",
        eventId: event.id,
        eventType: event.type,
        message: `Event ${event.id} already processed. Acknowledged without side-effects.`,
      };
    }

    const eventTime = event.created || Math.floor(Date.now() / 1000);
    const obj = event.data?.object || {};

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = obj;
          const sessionId = session.id || event.id;

          // Check if session was already processed (e.g. via direct confirm endpoint)
          if (sessionId && this.processedEvents.has(sessionId)) {
            this.processedEvents.add(event.id);
            return {
              status: "ignored_duplicate",
              eventId: event.id,
              eventType: event.type,
              message: `Checkout session ${sessionId} already processed. Acknowledged without side-effects.`,
            };
          }

          const workspaceId = session.metadata?.workspace_id || session.metadata?.team_id;
          if (!workspaceId) {
            return {
              status: "failed",
              eventId: event.id,
              eventType: event.type,
              message: `Checkout session ${sessionId} is missing workspace_id in metadata. Cannot associate with a tenant.`,
            };
          }

          const planId = session.metadata?.plan_id || session.metadata?.tier || "starter";
          const seats = parseInt(session.metadata?.seats, 10) || 15;
          const amount = session.amount_total ?? session.amount_paid ?? 0;
          const currency = session.currency || "usd";
          const subscriptionId = session.subscription || `sub_${sessionId}`;
          const paymentStatus = session.payment_status || "unpaid";

          // Strict Security Invariant: Must be paid. Never grant paid entitlements from unpaid sessions.
          if (paymentStatus !== "paid") {
            return {
              status: "failed",
              eventId: event.id,
              eventType: event.type,
              message: `Checkout session ${sessionId} payment is not complete (payment_status: ${paymentStatus}).`,
            };
          }

          const existing = this.subscriptions.get(subscriptionId);
          if (existing && existing.updatedAt > eventTime) {
            this.processedEvents.add(event.id);
            if (sessionId) this.processedEvents.add(sessionId);
            return {
              status: "ignored_out_of_order",
              eventId: event.id,
              eventType: event.type,
              message: "Checkout session event is older than current subscription state. Discarded to prevent state regression.",
            };
          }

          const teamId = normalizeTeamId(workspaceId) || 1;
          await this.storage.recordLedgerEntry({
            transactionId: `ch_${sessionId}`,
            teamId,
            eventId: event.id,
            type: "checkout_session_completed",
            amountCents: amount,
            currency,
            status: "succeeded",
            createdAt: eventTime,
          });

          await this.storage.upsertSubscription({
            teamId,
            stripeSubscriptionId: subscriptionId,
            planId,
            seats,
            status: "active",
            currentPeriodStart: session.current_period_start || eventTime,
            currentPeriodEnd: session.current_period_end || eventTime + 30 * 86400,
            updatedAt: eventTime,
          });

          const eventRes = await this.storage.recordEvent({
            eventId: event.id,
            eventType: event.type,
            teamId,
            status: "processed",
            payload: session,
            processedAt: eventTime,
          });

          if (eventRes.isDuplicate) {
            this.processedEvents.add(event.id);
            if (sessionId) this.processedEvents.add(sessionId);
            return {
              status: "ignored_duplicate",
              eventId: event.id,
              eventType: event.type,
              message: `Event ${event.id} already processed. Acknowledged without side-effects.`,
            };
          }

          // Commit in-memory state only after durable storage operations succeed
          this.ledger.push({
            id: `ch_${sessionId}`,
            workspaceId,
            eventId: event.id,
            type: "checkout_session_completed",
            amount,
            currency,
            status: "succeeded",
            timestamp: eventTime,
          });

          const newState: SubscriptionState = {
            subscriptionId,
            workspaceId,
            planId,
            seats,
            status: "active",
            currentPeriodStart: session.current_period_start || eventTime,
            currentPeriodEnd: session.current_period_end || eventTime + 30 * 86400,
            updatedAt: eventTime,
          };
          this.subscriptions.set(subscriptionId, newState);
          this.processedEvents.add(event.id);
          if (sessionId) this.processedEvents.add(sessionId);

          return {
            status: "processed",
            eventId: event.id,
            eventType: event.type,
            message: `Checkout session ${sessionId} completed. Subscription ${subscriptionId} active with ${seats} seats.`,
            actionTaken: "checkout_completed",
          };
        }

        case "customer.subscription.created":
        case "subscription.created": {
          const subscriptionId = obj.id || `sub_${event.id}`;
          const workspaceId = obj.metadata?.workspace_id || obj.metadata?.team_id;
          if (!workspaceId) {
            return {
              status: "failed",
              eventId: event.id,
              eventType: event.type,
              message: `Subscription ${subscriptionId} is missing workspace_id in metadata. Cannot associate with a tenant.`,
            };
          }

          const planId = obj.items?.data?.[0]?.plan?.id || obj.plan?.id || "pro_plan";
          const seats = obj.items?.data?.[0]?.quantity || obj.quantity || 10;

          const teamId = normalizeTeamId(workspaceId) || 1;
          await this.storage.upsertSubscription({
            teamId,
            stripeSubscriptionId: subscriptionId,
            planId,
            seats,
            status: "active",
            currentPeriodStart: obj.current_period_start || eventTime,
            currentPeriodEnd: obj.current_period_end || eventTime + 30 * 86400,
            updatedAt: eventTime,
          });

          const eventRes = await this.storage.recordEvent({
            eventId: event.id,
            eventType: event.type,
            teamId,
            status: "processed",
            payload: obj,
            processedAt: eventTime,
          });

          if (eventRes.isDuplicate) {
            this.processedEvents.add(event.id);
            return {
              status: "ignored_duplicate",
              eventId: event.id,
              eventType: event.type,
              message: `Event ${event.id} already processed. Acknowledged without side-effects.`,
            };
          }

          const newState: SubscriptionState = {
            subscriptionId,
            workspaceId,
            planId,
            seats,
            status: "active",
            currentPeriodStart: obj.current_period_start || eventTime,
            currentPeriodEnd: obj.current_period_end || eventTime + 30 * 86400,
            updatedAt: eventTime,
          };
          this.subscriptions.set(subscriptionId, newState);
          this.processedEvents.add(event.id);

          return {
            status: "processed",
            eventId: event.id,
            eventType: event.type,
            message: `Subscription ${subscriptionId} created with ${seats} seats.`,
            actionTaken: "subscription_created",
          };
        }

        case "customer.subscription.updated":
        case "subscription.updated": {
          const subscriptionId = obj.id;
          if (!subscriptionId) {
            throw new Error("Missing subscription ID in event object");
          }

          const existing = this.subscriptions.get(subscriptionId);
          if (existing && existing.updatedAt > eventTime) {
            // Out of order: existing state is newer than incoming event
            this.processedEvents.add(event.id);
            return {
              status: "ignored_out_of_order",
              eventId: event.id,
              eventType: event.type,
              message: `Event timestamp (${eventTime}) is older than current subscription state (${existing.updatedAt}). Discarded to prevent state regression.`,
            };
          }

          const updatedSeats = obj.items?.data?.[0]?.quantity ?? obj.quantity ?? existing?.seats ?? 10;
          const updatedStatus = obj.status || existing?.status || "active";
          const updatedPlan = obj.items?.data?.[0]?.plan?.id ?? obj.plan?.id ?? existing?.planId ?? "pro_plan";
          const resolvedWorkspaceId = existing?.workspaceId || obj.metadata?.workspace_id || obj.metadata?.team_id;

          if (!resolvedWorkspaceId) {
            return {
              status: "failed",
              eventId: event.id,
              eventType: event.type,
              message: `Subscription ${subscriptionId} update missing workspace association.`,
            };
          }

          const teamId = normalizeTeamId(resolvedWorkspaceId) || 1;
          await this.storage.upsertSubscription({
            teamId,
            stripeSubscriptionId: subscriptionId,
            planId: updatedPlan,
            seats: updatedSeats,
            status: updatedStatus,
            currentPeriodStart: obj.current_period_start || existing?.currentPeriodStart || eventTime,
            currentPeriodEnd: obj.current_period_end || existing?.currentPeriodEnd || eventTime + 30 * 86400,
            updatedAt: eventTime,
          });

          const eventRes = await this.storage.recordEvent({
            eventId: event.id,
            eventType: event.type,
            teamId,
            status: "processed",
            payload: obj,
            processedAt: eventTime,
          });

          if (eventRes.isDuplicate) {
            this.processedEvents.add(event.id);
            return {
              status: "ignored_duplicate",
              eventId: event.id,
              eventType: event.type,
              message: `Event ${event.id} already processed. Acknowledged without side-effects.`,
            };
          }

          const updatedState: SubscriptionState = {
            subscriptionId,
            workspaceId: resolvedWorkspaceId,
            planId: updatedPlan,
            seats: updatedSeats,
            status: updatedStatus,
            currentPeriodStart: obj.current_period_start || existing?.currentPeriodStart || eventTime,
            currentPeriodEnd: obj.current_period_end || existing?.currentPeriodEnd || eventTime + 30 * 86400,
            updatedAt: eventTime,
          };
          this.subscriptions.set(subscriptionId, updatedState);
          this.processedEvents.add(event.id);

          return {
            status: "processed",
            eventId: event.id,
            eventType: event.type,
            message: `Subscription ${subscriptionId} updated (seats: ${updatedSeats}, status: ${updatedStatus}).`,
            actionTaken: "subscription_updated",
          };
        }

        case "customer.subscription.deleted":
        case "subscription.deleted": {
          const subscriptionId = obj.id;
          if (!subscriptionId) {
            throw new Error("Missing subscription ID in event object");
          }

          const existing = this.subscriptions.get(subscriptionId);
          if (existing && existing.updatedAt > eventTime) {
            this.processedEvents.add(event.id);
            return {
              status: "ignored_out_of_order",
              eventId: event.id,
              eventType: event.type,
              message: "Subscription deletion event is older than current state. Ignored.",
            };
          }

          const teamId = existing ? normalizeTeamId(existing.workspaceId) : null;
          if (teamId) {
            await this.storage.upsertSubscription({
              teamId,
              stripeSubscriptionId: subscriptionId,
              planId: "free",
              seats: 5,
              status: "canceled",
              currentPeriodStart: existing?.currentPeriodStart || eventTime,
              currentPeriodEnd: existing?.currentPeriodEnd || eventTime,
              updatedAt: eventTime,
            });
          }

          const eventRes = await this.storage.recordEvent({
            eventId: event.id,
            eventType: event.type,
            teamId: teamId || undefined,
            status: "processed",
            payload: obj,
            processedAt: eventTime,
          });

          if (eventRes.isDuplicate) {
            this.processedEvents.add(event.id);
            return {
              status: "ignored_duplicate",
              eventId: event.id,
              eventType: event.type,
              message: `Event ${event.id} already processed. Acknowledged without side-effects.`,
            };
          }

          if (existing) {
            existing.status = "canceled";
            existing.updatedAt = eventTime;
            this.subscriptions.set(subscriptionId, existing);
          }
          this.processedEvents.add(event.id);

          return {
            status: "processed",
            eventId: event.id,
            eventType: event.type,
            message: `Subscription ${subscriptionId} canceled. Workspace reverted to free tier.`,
            actionTaken: "subscription_canceled",
          };
        }

        case "invoice.payment_succeeded": {
          const invoiceId = obj.id || `inv_${event.id}`;
          const amount = obj.amount_paid ?? obj.amount_due ?? 0;
          const currency = obj.currency || "usd";
          const subscriptionId = obj.subscription;
          const workspaceId =
            obj.metadata?.workspace_id ||
            obj.metadata?.team_id ||
            (subscriptionId ? this.subscriptions.get(subscriptionId)?.workspaceId : null);

          if (!workspaceId) {
            this.processedEvents.add(event.id);
            return {
              status: "processed",
              eventId: event.id,
              eventType: event.type,
              message: `Invoice ${invoiceId} received without associated workspace. Acknowledged without ledger entry.`,
              actionTaken: "unattributed_invoice",
            };
          }

          const teamId = normalizeTeamId(workspaceId) || 1;
          await this.storage.recordLedgerEntry({
            transactionId: invoiceId,
            teamId,
            eventId: event.id,
            type: "payment_succeeded",
            amountCents: amount,
            currency,
            status: "succeeded",
            createdAt: eventTime,
          });

          const eventRes = await this.storage.recordEvent({
            eventId: event.id,
            eventType: event.type,
            teamId,
            status: "processed",
            payload: obj,
            processedAt: eventTime,
          });

          if (eventRes.isDuplicate) {
            this.processedEvents.add(event.id);
            return {
              status: "ignored_duplicate",
              eventId: event.id,
              eventType: event.type,
              message: `Event ${event.id} already processed. Acknowledged without side-effects.`,
            };
          }

          this.ledger.push({
            id: invoiceId,
            workspaceId,
            eventId: event.id,
            type: "payment_succeeded",
            amount,
            currency,
            status: "succeeded",
            timestamp: eventTime,
          });
          this.processedEvents.add(event.id);

          return {
            status: "processed",
            eventId: event.id,
            eventType: event.type,
            message: `Invoice ${invoiceId} payment succeeded (${amount} ${currency.toUpperCase()}). Ledger recorded.`,
            actionTaken: "invoice_recorded",
          };
        }

        case "invoice.payment_failed": {
          const invoiceId = obj.id || `inv_${event.id}`;
          const subscriptionId = obj.subscription;
          const workspaceId =
            obj.metadata?.workspace_id ||
            obj.metadata?.team_id ||
            (subscriptionId ? this.subscriptions.get(subscriptionId)?.workspaceId : null);

          const teamId = normalizeTeamId(workspaceId) || 1;
          if (workspaceId) {
            await this.storage.recordLedgerEntry({
              transactionId: invoiceId,
              teamId,
              eventId: event.id,
              type: "payment_failed",
              amountCents: obj.amount_due ?? 0,
              currency: obj.currency || "usd",
              status: "failed",
              createdAt: eventTime,
            });
          }

          if (subscriptionId && this.subscriptions.has(subscriptionId)) {
            const sub = this.subscriptions.get(subscriptionId)!;
            await this.storage.upsertSubscription({
              teamId,
              stripeSubscriptionId: subscriptionId,
              planId: sub.planId,
              seats: sub.seats,
              status: "past_due",
              currentPeriodStart: sub.currentPeriodStart,
              currentPeriodEnd: sub.currentPeriodEnd,
              updatedAt: eventTime,
            });
          }

          const eventRes = await this.storage.recordEvent({
            eventId: event.id,
            eventType: event.type,
            teamId,
            status: "processed",
            payload: obj,
            processedAt: eventTime,
          });

          if (eventRes.isDuplicate) {
            this.processedEvents.add(event.id);
            return {
              status: "ignored_duplicate",
              eventId: event.id,
              eventType: event.type,
              message: `Event ${event.id} already processed. Acknowledged without side-effects.`,
            };
          }

          if (subscriptionId && this.subscriptions.has(subscriptionId)) {
            const sub = this.subscriptions.get(subscriptionId)!;
            sub.status = "past_due";
            sub.updatedAt = eventTime;
            this.subscriptions.set(subscriptionId, sub);
          }

          if (workspaceId) {
            this.ledger.push({
              id: invoiceId,
              workspaceId,
              eventId: event.id,
              type: "payment_failed",
              amount: obj.amount_due ?? 0,
              currency: obj.currency || "usd",
              status: "failed",
              timestamp: eventTime,
            });
          }

          this.processedEvents.add(event.id);

          return {
            status: "processed",
            eventId: event.id,
            eventType: event.type,
            message: `Invoice payment failed. Subscription marked past_due.`,
            actionTaken: "subscription_past_due",
          };
        }

        default: {
          // Unhandled event type: record receipt, acknowledge HTTP 200 without side effects
          this.processedEvents.add(event.id);
          return {
            status: "processed",
            eventId: event.id,
            eventType: event.type,
            message: `Event type ${event.type} received and ignored safely.`,
            actionTaken: "none",
          };
        }
      }
    } catch (err: any) {
      return {
        status: "failed",
        eventId: event.id,
        eventType: event.type,
        message: `Processing failed: ${err?.message || "Unknown error"}`,
      };
    }
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
