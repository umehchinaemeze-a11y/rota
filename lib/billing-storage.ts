/**
 * Durable Billing Persistence Storage Interface & Implementations
 *
 * Provides storage abstraction for:
 * 1. Workspace Subscriptions (tied relationally to teams.id, supporting Stripe and Paystack)
 * 2. Webhook Event Idempotency Ledger (guaranteeing cross-instance uniqueness)
 * 3. Immutable Financial Ledger & Transaction History
 *
 * Schema Relational Invariants:
 * - teams.id is PostgreSQL INTEGER (SERIAL PRIMARY KEY).
 * - workspace_subscriptions relationally references teams(id) ON DELETE CASCADE.
 * - billing_events references teams(id) ON DELETE SET NULL.
 * - billing_ledger references teams(id) ON DELETE RESTRICT to protect financial audit history.
 * - workspace_subscriptions enforces UNIQUE (team_id) to prevent duplicate subscriptions per workspace.
 * - billing_events enforces UNIQUE (event_id) for atomic idempotency.
 * - billing_ledger enforces UNIQUE (transaction_id) to prevent duplicate charges.
 * - Multi-provider support: supports payment_provider ('stripe' or 'paystack') with zero regression.
 */

import { sql as defaultSql } from "./db.ts";
import { encryptAuthorizationCode, decryptAuthorizationCode } from "./paystack-security.ts";

export type PaymentProvider = "stripe" | "paystack";

export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "trialing"
  | "renewal_processing"
  | "reconciliation_required";

export interface DurableSubscriptionState {
  id?: number;
  teamId: number;
  paymentProvider?: PaymentProvider;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  paystackCustomerCode?: string | null;
  paystackSubscriptionCode?: string | null;
  paystackAuthCipher?: string | null;
  paystackAuthIv?: string | null;
  paystackAuthTag?: string | null;
  autoRenewEnabled?: boolean;
  cardBrand?: string | null;
  cardLast4?: string | null;
  cardExpMonth?: number | null;
  cardExpYear?: number | null;
  cardBank?: string | null;
  billingAnchorDay?: number | null;
  renewalLeaseToken?: string | null;
  renewalLeaseExpiresAt?: number | null;
  retryCount?: number;
  nextRetryAt?: number | null;
  gracePeriodExpiresAt?: number | null;
  scheduledPlanId?: string | null;
  scheduledSeats?: number | null;
  lastReconciliationRef?: string | null;
  planId: string;
  seats: number;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd?: boolean;
  createdAt?: number;
  updatedAt: number;
}

export type BillingEventStatus =
  | "pending"
  | "processed"
  | "failed"
  | "ignored_duplicate"
  | "ignored_out_of_order";

export interface DurableBillingEvent {
  id?: number;
  eventId: string;
  eventType: string;
  teamId?: number | null;
  status: BillingEventStatus;
  payload?: any;
  processedAt?: number;
}

export interface DurableLedgerEntry {
  id?: number;
  transactionId: string;
  teamId: number;
  eventId?: string | null;
  type: string;
  amountCents: number;
  amountKobo?: number;
  currency?: string;
  status: "succeeded" | "failed" | "pending" | "refunded";
  metadata?: any;
  createdAt?: number;
}

export interface UpdatePaystackAuthorizationParams {
  customerCode?: string;
  subscriptionCode?: string;
  authorization?: {
    authorization_code?: string;
    reusable?: boolean;
    card_type?: string;
    last4?: string;
    exp_month?: string | number;
    exp_year?: string | number;
    bank?: string;
    [key: string]: any;
  } | null;
  encryptionKey?: string | Buffer;
}

export interface PreparedPaystackAuthorization {
  autoRenewEnabled: boolean;
  paystackAuthCipher: string | null;
  paystackAuthIv: string | null;
  paystackAuthTag: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  cardBank: string | null;
  reason?: string;
}

/**
 * Prepares and validates Paystack authorization state.
 *
 * Invariants:
 * 1. autoRenewEnabled is enabled ONLY when authorization.reusable === true,
 *    authorization_code is present, and encryption succeeds.
 * 2. Missing, non-reusable, invalid, or undecryptable authorizations ALWAYS result
 *    in autoRenewEnabled: false.
 */
export function preparePaystackAuthorizationState(params: {
  authorization?: {
    authorization_code?: string;
    reusable?: boolean;
    card_type?: string;
    last4?: string;
    exp_month?: string | number;
    exp_year?: string | number;
    bank?: string;
    [key: string]: any;
  } | null;
  encryptionKey?: string | Buffer;
}): PreparedPaystackAuthorization {
  const auth = params.authorization;
  if (!auth || typeof auth !== "object") {
    return {
      autoRenewEnabled: false,
      paystackAuthCipher: null,
      paystackAuthIv: null,
      paystackAuthTag: null,
      cardBrand: null,
      cardLast4: null,
      cardExpMonth: null,
      cardExpYear: null,
      cardBank: null,
      reason: "Missing authorization payload",
    };
  }

  const cardBrand = auth.card_type || null;
  const cardLast4 = auth.last4 || null;
  const cardExpMonth = auth.exp_month != null ? Number(auth.exp_month) : null;
  const cardExpYear = auth.exp_year != null ? Number(auth.exp_year) : null;
  const cardBank = auth.bank || null;

  // Non-reusable authorization: auto-renew is strictly disabled
  if (auth.reusable !== true) {
    return {
      autoRenewEnabled: false,
      paystackAuthCipher: null,
      paystackAuthIv: null,
      paystackAuthTag: null,
      cardBrand,
      cardLast4,
      cardExpMonth,
      cardExpYear,
      cardBank,
      reason: "Authorization is not reusable",
    };
  }

  const authCode = auth.authorization_code;
  if (!authCode || typeof authCode !== "string" || !authCode.trim()) {
    return {
      autoRenewEnabled: false,
      paystackAuthCipher: null,
      paystackAuthIv: null,
      paystackAuthTag: null,
      cardBrand,
      cardLast4,
      cardExpMonth,
      cardExpYear,
      cardBank,
      reason: "Missing authorization code string",
    };
  }

  try {
    const encrypted = encryptAuthorizationCode(authCode.trim(), params.encryptionKey);
    // Sanity-check decryptability immediately with the resolved key
    decryptAuthorizationCode(encrypted, params.encryptionKey);

    return {
      autoRenewEnabled: true,
      paystackAuthCipher: encrypted.cipherText,
      paystackAuthIv: encrypted.iv,
      paystackAuthTag: encrypted.tag,
      cardBrand,
      cardLast4,
      cardExpMonth,
      cardExpYear,
      cardBank,
    };
  } catch (err: any) {
    return {
      autoRenewEnabled: false,
      paystackAuthCipher: null,
      paystackAuthIv: null,
      paystackAuthTag: null,
      cardBrand,
      cardLast4,
      cardExpMonth,
      cardExpYear,
      cardBank,
      reason: `Encryption failure: ${err?.message || "Unknown error"}`,
    };
  }
}

export interface BillingStorageInterface {
  // Webhook Event Idempotency
  recordEvent(event: DurableBillingEvent): Promise<{ isDuplicate: boolean; event: DurableBillingEvent }>;
  isEventProcessed(eventId: string): Promise<boolean>;
  updateEventStatus?(eventId: string, status: BillingEventStatus, payload?: any): Promise<boolean>;

  // Workspace Subscription State
  getSubscriptionByTeamId(teamId: number): Promise<DurableSubscriptionState | null>;
  getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<DurableSubscriptionState | null>;
  getSubscriptionByPaystackCustomer?(customerCode: string): Promise<DurableSubscriptionState | null>;
  getSubscriptionByPaystackSubscription?(subscriptionCode: string): Promise<DurableSubscriptionState | null>;
  upsertSubscription(sub: DurableSubscriptionState): Promise<DurableSubscriptionState>;
  updatePaystackAuthorization?(
    teamId: number,
    params: UpdatePaystackAuthorizationParams
  ): Promise<DurableSubscriptionState>;

  // Renewal Engine Leases & Queue
  findDueRenewals?(nowEpoch: number, limit?: number): Promise<DurableSubscriptionState[]>;
  acquireRenewalLease?(teamId: number, leaseToken: string, leaseDurationSeconds: number, nowEpoch?: number): Promise<boolean>;
  releaseRenewalLease?(teamId: number, leaseToken: string): Promise<boolean>;

  // Financial Ledger
  recordLedgerEntry(entry: DurableLedgerEntry): Promise<{ isDuplicate: boolean; entry: DurableLedgerEntry }>;
  getLedgerByTeamId(teamId: number): Promise<DurableLedgerEntry[]>;
  getAllLedgerEntries?(): Promise<DurableLedgerEntry[]>;
}

/**
 * Normalizes input workspace/team ID to a verified positive integer matching teams.id.
 */
export function normalizeTeamId(val: unknown): number | null {
  if (typeof val === "number" && Number.isInteger(val) && val > 0) {
    return val;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * In-Memory storage implementation for offline unit testing and test-mode execution.
 * Simulates database uniqueness constraints and atomic upsert behavior for both Stripe & Paystack.
 */
export class InMemoryBillingStorage implements BillingStorageInterface {
  private events = new Map<string, DurableBillingEvent>();
  private subscriptionsByTeamId = new Map<number, DurableSubscriptionState>();
  private subscriptionsByStripeId = new Map<string, number>(); // stripeSubId -> teamId
  private subscriptionsByPaystackCustomer = new Map<string, number>(); // paystackCustCode -> teamId
  private subscriptionsByPaystackSub = new Map<string, number>(); // paystackSubCode -> teamId
  private ledger = new Map<string, DurableLedgerEntry>(); // transactionId -> entry

  constructor(initialSubscriptions?: DurableSubscriptionState[]) {
    if (initialSubscriptions) {
      for (const sub of initialSubscriptions) {
        const isHistoricalStripe = Boolean(sub.stripeSubscriptionId || sub.stripeCustomerId);
        const paymentProvider: PaymentProvider = sub.paymentProvider || (isHistoricalStripe ? "stripe" : "paystack");
        const isPaystack = paymentProvider === "paystack";
        const hasEncryptedAuth = Boolean(sub.paystackAuthCipher && sub.paystackAuthIv && sub.paystackAuthTag);
        const autoRenew = isPaystack && hasEncryptedAuth && Boolean(sub.autoRenewEnabled);
        this.subscriptionsByTeamId.set(sub.teamId, { ...sub, paymentProvider, autoRenewEnabled: autoRenew });
        if (sub.stripeSubscriptionId) {
          this.subscriptionsByStripeId.set(sub.stripeSubscriptionId, sub.teamId);
        }
        if (sub.paystackCustomerCode) {
          this.subscriptionsByPaystackCustomer.set(sub.paystackCustomerCode, sub.teamId);
        }
        if (sub.paystackSubscriptionCode) {
          this.subscriptionsByPaystackSub.set(sub.paystackSubscriptionCode, sub.teamId);
        }
      }
    }
  }

  async recordEvent(event: DurableBillingEvent): Promise<{ isDuplicate: boolean; event: DurableBillingEvent }> {
    if (
      event.eventType.startsWith("customer.subscription.") ||
      event.eventType.startsWith("checkout.session.") ||
      event.eventType.startsWith("invoice.") ||
      event.eventId.startsWith("evt_")
    ) {
      throw new Error(
        `Cannot record Stripe event "${event.eventId}": Stripe provider has been retired. New payment events must use Paystack.`
      );
    }
    const existing = this.events.get(event.eventId);
    if (existing) {
      if (existing.status === "processed") {
        return { isDuplicate: true, event: { ...existing } };
      }
      existing.status = event.status;
      if (event.payload !== undefined) existing.payload = event.payload;
      existing.processedAt = event.processedAt || Math.floor(Date.now() / 1000);
      return { isDuplicate: false, event: { ...existing } };
    }
    const saved: DurableBillingEvent = {
      ...event,
      processedAt: event.processedAt || Math.floor(Date.now() / 1000),
    };
    this.events.set(event.eventId, saved);
    return { isDuplicate: false, event: saved };
  }

  async updateEventStatus(eventId: string, status: BillingEventStatus, payload?: any): Promise<boolean> {
    const existing = this.events.get(eventId);
    if (!existing) return false;
    existing.status = status;
    if (payload !== undefined) existing.payload = payload;
    existing.processedAt = Math.floor(Date.now() / 1000);
    return true;
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    const evt = this.events.get(eventId);
    return evt !== undefined && evt.status === "processed";
  }

  async getSubscriptionByTeamId(teamId: number): Promise<DurableSubscriptionState | null> {
    const sub = this.subscriptionsByTeamId.get(teamId);
    return sub ? { ...sub } : null;
  }

  async getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<DurableSubscriptionState | null> {
    const teamId = this.subscriptionsByStripeId.get(stripeSubscriptionId);
    if (teamId === undefined) return null;
    return this.getSubscriptionByTeamId(teamId);
  }

  async getSubscriptionByPaystackCustomer(customerCode: string): Promise<DurableSubscriptionState | null> {
    const teamId = this.subscriptionsByPaystackCustomer.get(customerCode);
    if (teamId === undefined) return null;
    return this.getSubscriptionByTeamId(teamId);
  }

  async getSubscriptionByPaystackSubscription(subscriptionCode: string): Promise<DurableSubscriptionState | null> {
    const teamId = this.subscriptionsByPaystackSub.get(subscriptionCode);
    if (teamId === undefined) return null;
    return this.getSubscriptionByTeamId(teamId);
  }

    async upsertSubscription(sub: DurableSubscriptionState): Promise<DurableSubscriptionState> {
    const existing = this.subscriptionsByTeamId.get(sub.teamId);

    // Rule: Stripe provider is permanently retired. Prohibit new Stripe subscriptions or Stripe mutations.
    if ((sub.paymentProvider as string) === "stripe") {
      throw new Error(
        `Cannot create or update Stripe subscription for team ${sub.teamId}: Stripe provider has been retired. New subscriptions must use Paystack.`
      );
    }

    // Reject unknown providers (anything other than 'paystack' or 'stripe')
    if (sub.paymentProvider !== undefined && sub.paymentProvider !== "paystack" && (sub.paymentProvider as string) !== "stripe") {
      throw new Error(
        `Invalid payment provider '${sub.paymentProvider}' for team ${sub.teamId}. Active subscriptions must use 'paystack'.`
      );
    }

    // Fail-Closed Enforcement: New subscriptions must explicitly specify paymentProvider: 'paystack'
    // An omitted provider on a new subscription must be rejected.
    if (!existing) {
      if (!sub.paymentProvider) {
        throw new Error(
          `New subscription for team ${sub.teamId} requires an explicit paymentProvider: 'paystack'. Omitted provider is rejected.`
        );
      }
      if (sub.paymentProvider !== "paystack") {
        throw new Error(
          `New subscription for team ${sub.teamId} must use 'paystack'. Provided: '${sub.paymentProvider}'.`
        );
      }
    }

    // Historical Record Preservation: Updates to historical Stripe records must not change their provider attribution
    let paymentProvider: PaymentProvider;
    if (existing) {
      if (existing.paymentProvider === "stripe") {
        // If updating a historical Stripe subscription, preserve 'stripe' unless explicitly migrated to 'paystack'
        paymentProvider = sub.paymentProvider === "paystack" ? "paystack" : "stripe";
      } else {
        paymentProvider = "paystack";
      }
    } else {
      paymentProvider = "paystack";
    }

    // Strict Provider Isolation: Workspace has migrated to Paystack.
    // Stripe lifecycle events cannot mutate or downgrade an active Paystack subscription.
    if (
      existing &&
      existing.paymentProvider === "paystack" &&
      sub.stripeSubscriptionId &&
      !sub.paystackCustomerCode &&
      sub.paymentProvider !== "paystack"
    ) {
      return { ...existing };
    }

    const isPaystack = paymentProvider === "paystack";

    let autoRenewEnabled = sub.autoRenewEnabled === true;
    if (!isPaystack) {
      autoRenewEnabled = false;
    } else if (autoRenewEnabled) {
      const cipher = sub.paystackAuthCipher ?? existing?.paystackAuthCipher;
      const iv = sub.paystackAuthIv ?? existing?.paystackAuthIv;
      const tag = sub.paystackAuthTag ?? existing?.paystackAuthTag;

      if (!cipher || !iv || !tag) {
        autoRenewEnabled = false;
      } else {
        const key = process.env.PAYSTACK_AUTH_ENCRYPTION_KEY;
        if (key) {
          try {
            decryptAuthorizationCode({ cipherText: cipher, iv, tag }, key);
          } catch {
            autoRenewEnabled = false;
          }
        }
      }
    }

    const updated: DurableSubscriptionState = {
      ...existing,
      ...sub,
      paymentProvider,
      autoRenewEnabled,
      updatedAt: sub.updatedAt || Math.floor(Date.now() / 1000),
      createdAt: existing?.createdAt || sub.createdAt || Math.floor(Date.now() / 1000),
    };

    this.subscriptionsByTeamId.set(sub.teamId, updated);
    if (updated.stripeSubscriptionId) {
      this.subscriptionsByStripeId.set(updated.stripeSubscriptionId, updated.teamId);
    }
    if (updated.paystackCustomerCode) {
      this.subscriptionsByPaystackCustomer.set(updated.paystackCustomerCode, updated.teamId);
    }
    if (updated.paystackSubscriptionCode) {
      this.subscriptionsByPaystackSub.set(updated.paystackSubscriptionCode, updated.teamId);
    }
    return { ...updated };
  }

  async updatePaystackAuthorization(
    teamId: number,
    params: UpdatePaystackAuthorizationParams
  ): Promise<DurableSubscriptionState> {
    const existing = await this.getSubscriptionByTeamId(teamId);
    if (!existing) {
      throw new Error(`Cannot update Paystack authorization: no subscription found for team ${teamId}.`);
    }

    const prepared = preparePaystackAuthorizationState({
      authorization: params.authorization,
      encryptionKey: params.encryptionKey,
    });

    return this.upsertSubscription({
      ...existing,
      paymentProvider: "paystack",
      paystackCustomerCode: params.customerCode ?? existing.paystackCustomerCode,
      paystackSubscriptionCode: params.subscriptionCode ?? existing.paystackSubscriptionCode,
      paystackAuthCipher: prepared.paystackAuthCipher,
      paystackAuthIv: prepared.paystackAuthIv,
      paystackAuthTag: prepared.paystackAuthTag,
      autoRenewEnabled: prepared.autoRenewEnabled,
      cardBrand: prepared.cardBrand ?? existing.cardBrand,
      cardLast4: prepared.cardLast4 ?? existing.cardLast4,
      cardExpMonth: prepared.cardExpMonth ?? existing.cardExpMonth,
      cardExpYear: prepared.cardExpYear ?? existing.cardExpYear,
      cardBank: prepared.cardBank ?? existing.cardBank,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  async findDueRenewals(nowEpoch: number = Math.floor(Date.now() / 1000), limit: number = 50): Promise<DurableSubscriptionState[]> {
    const results: DurableSubscriptionState[] = [];
    for (const sub of this.subscriptionsByTeamId.values()) {
      if (
        sub.paymentProvider === "paystack" &&
        sub.autoRenewEnabled === true &&
        (sub.status === "active" || sub.status === "past_due" || sub.status === "reconciliation_required") &&
        (sub.currentPeriodEnd <= nowEpoch ||
          (sub.status === "past_due" && sub.nextRetryAt != null && sub.nextRetryAt <= nowEpoch) ||
          sub.status === "reconciliation_required") &&
        (!sub.renewalLeaseExpiresAt || sub.renewalLeaseExpiresAt <= nowEpoch)
      ) {
        results.push({ ...sub });
      }
    }
    return results.sort((a, b) => a.currentPeriodEnd - b.currentPeriodEnd).slice(0, limit);
  }

  async acquireRenewalLease(
    teamId: number,
    leaseToken: string,
    leaseDurationSeconds: number,
    nowEpoch: number = Math.floor(Date.now() / 1000)
  ): Promise<boolean> {
    const sub = this.subscriptionsByTeamId.get(teamId);
    if (!sub) return false;
    if (sub.renewalLeaseExpiresAt && sub.renewalLeaseExpiresAt > nowEpoch) {
      return false; // Active lease held by another worker
    }
    sub.renewalLeaseToken = leaseToken;
    sub.renewalLeaseExpiresAt = nowEpoch + leaseDurationSeconds;
    return true;
  }

  async releaseRenewalLease(teamId: number, leaseToken: string): Promise<boolean> {
    const sub = this.subscriptionsByTeamId.get(teamId);
    if (!sub) return false;
    if (sub.renewalLeaseToken === leaseToken) {
      sub.renewalLeaseToken = null;
      sub.renewalLeaseExpiresAt = null;
      return true;
    }
    return false;
  }

  async recordLedgerEntry(entry: DurableLedgerEntry): Promise<{ isDuplicate: boolean; entry: DurableLedgerEntry }> {
    if (entry.transactionId.startsWith("ch_") || entry.type === "checkout_session_completed") {
      throw new Error(
        `Cannot record Stripe ledger entry "${entry.transactionId}": Stripe provider has been retired.`
      );
    }
    const rawAmount = entry.amountKobo !== undefined ? entry.amountKobo : entry.amountCents;
    if (rawAmount === undefined || !Number.isInteger(rawAmount) || rawAmount < 0) {
      throw new TypeError(`Ledger amount must be a non-negative integer. Received: ${rawAmount}`);
    }
    const currency = (entry.currency && entry.currency.trim()) ? entry.currency.trim() : "NGN";
    if (this.ledger.has(entry.transactionId)) {
      return { isDuplicate: true, entry: { ...this.ledger.get(entry.transactionId)! } };
    }
    const saved: DurableLedgerEntry = {
      ...entry,
      amountCents: rawAmount,
      amountKobo: currency === "NGN" ? rawAmount : undefined,
      currency,
      createdAt: entry.createdAt || Math.floor(Date.now() / 1000),
    };
    this.ledger.set(entry.transactionId, saved);
    return { isDuplicate: false, entry: saved };
  }

  async getLedgerByTeamId(teamId: number): Promise<DurableLedgerEntry[]> {
    const results: DurableLedgerEntry[] = [];
    for (const item of this.ledger.values()) {
      if (item.teamId === teamId) {
        results.push({ ...item });
      }
    }
    return results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async getAllLedgerEntries(): Promise<DurableLedgerEntry[]> {
    return Array.from(this.ledger.values()).map((e) => ({ ...e }));
  }
}

export type QueryFunction = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

/**
 * Normalizes any SQL client or query function into a consistent QueryFunction returning { rows, rowCount }.
 * Supports:
 * - Neon clients with .query(sql, params)
 * - Raw functions (sql, params) => Promise<{ rows }>
 * - Raw functions (sql, params) => Promise<any[]>
 */
export function normalizeQueryClient(clientOrFn: any): QueryFunction {
  if (typeof clientOrFn?.query === "function") {
    return async (sqlText: string, params?: any[]) => {
      const result = await clientOrFn.query(sqlText, params);
      if (result && Array.isArray(result.rows)) {
        return {
          rows: result.rows,
          rowCount: typeof result.rowCount === "number" ? result.rowCount : result.rows.length,
        };
      }
      if (Array.isArray(result)) {
        return {
          rows: result,
          rowCount: result.length,
        };
      }
      return { rows: [], rowCount: 0 };
    };
  }

  if (typeof clientOrFn === "function") {
    return async (sqlText: string, params?: any[]) => {
      if (typeof (clientOrFn as any).query === "function") {
        const result = await (clientOrFn as any).query(sqlText, params);
        if (result && Array.isArray(result.rows)) {
          return {
            rows: result.rows,
            rowCount: typeof result.rowCount === "number" ? result.rowCount : result.rows.length,
          };
        }
        if (Array.isArray(result)) {
          return {
            rows: result,
            rowCount: result.length,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      const result = await clientOrFn(sqlText, params);
      if (result && Array.isArray(result.rows)) {
        return {
          rows: result.rows,
          rowCount: typeof result.rowCount === "number" ? result.rowCount : result.rows.length,
        };
      }
      if (Array.isArray(result)) {
        return {
          rows: result,
          rowCount: result.length,
        };
      }
      return { rows: [], rowCount: 0 };
    };
  }

  throw new Error("Invalid SQL client or query function provided to DatabaseBillingStorage.");
}

/**
 * Maps database row to DurableSubscriptionState with full default handling.
 *
 * Provider Fallback Guarantee:
 * Agreeing exactly with Stage 4 migration backfill logic:
 * When payment_provider is not explicitly set on the record, a row is attributed to 'stripe'
 * if either stripe_subscription_id OR stripe_customer_id is present.
 * Otherwise, default to 'paystack'. Explicitly stored payment_provider values ('paystack' | 'stripe')
 * are preserved verbatim.
 */
export function mapRowToSubscriptionState(r: any): DurableSubscriptionState {
  const isHistoricalStripe = Boolean(r.stripe_subscription_id || r.stripe_customer_id);
  const paymentProvider: PaymentProvider = r.payment_provider || (isHistoricalStripe ? "stripe" : "paystack");
  const isPaystack = paymentProvider === "paystack";
  const hasEncryptedAuth = Boolean(r.paystack_auth_cipher && r.paystack_auth_iv && r.paystack_auth_tag);
  // Auto-renew is enabled only if paymentProvider is paystack, valid encrypted auth is stored, and auto_renew_enabled is true
  // Historical Stripe records (or records without complete AES-256-GCM credentials) CAN NEVER enable Paystack auto-renewal.
  const autoRenewEnabled = isPaystack && hasEncryptedAuth && Boolean(r.auto_renew_enabled);

  return {
    id: r.id,
    teamId: r.team_id,
    paymentProvider,
    stripeCustomerId: r.stripe_customer_id ?? null,
    stripeSubscriptionId: r.stripe_subscription_id ?? null,
    paystackCustomerCode: r.paystack_customer_code ?? null,
    paystackSubscriptionCode: r.paystack_subscription_code ?? null,
    paystackAuthCipher: r.paystack_auth_cipher ?? null,
    paystackAuthIv: r.paystack_auth_iv ?? null,
    paystackAuthTag: r.paystack_auth_tag ?? null,
    autoRenewEnabled,
    cardBrand: r.card_brand ?? null,
    cardLast4: r.card_last4 ?? null,
    cardExpMonth: r.card_exp_month != null ? Number(r.card_exp_month) : null,
    cardExpYear: r.card_exp_year != null ? Number(r.card_exp_year) : null,
    cardBank: r.card_bank ?? null,
    billingAnchorDay: r.billing_anchor_day != null ? Number(r.billing_anchor_day) : null,
    renewalLeaseToken: r.renewal_lease_token ?? null,
    renewalLeaseExpiresAt: r.renewal_lease_expires_at != null ? Number(r.renewal_lease_expires_at) : null,
    retryCount: Number(r.retry_count) || 0,
    nextRetryAt: r.next_retry_at != null ? Number(r.next_retry_at) : null,
    gracePeriodExpiresAt: r.grace_period_expires_at != null ? Number(r.grace_period_expires_at) : null,
    scheduledPlanId: r.scheduled_plan_id ?? null,
    scheduledSeats: r.scheduled_seats != null ? Number(r.scheduled_seats) : null,
    lastReconciliationRef: r.last_reconciliation_ref ?? null,
    planId: r.plan_id,
    seats: r.seats,
    status: r.status,
    currentPeriodStart: Number(r.current_period_start) || 0,
    currentPeriodEnd: Number(r.current_period_end) || 0,
    cancelAtPeriodEnd: !!r.cancel_at_period_end,
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  };
}

const SELECT_SUBSCRIPTION_SQL = `
  SELECT id, team_id, stripe_customer_id, stripe_subscription_id, plan_id, seats, status,
         EXTRACT(EPOCH FROM current_period_start)::BIGINT AS current_period_start,
         EXTRACT(EPOCH FROM current_period_end)::BIGINT AS current_period_end,
         cancel_at_period_end,
         EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at,
         EXTRACT(EPOCH FROM updated_at)::BIGINT AS updated_at,
         payment_provider, paystack_customer_code, paystack_subscription_code,
         paystack_auth_cipher, paystack_auth_iv, paystack_auth_tag, auto_renew_enabled,
         card_brand, card_last4, card_exp_month, card_exp_year, card_bank,
         billing_anchor_day, renewal_lease_token,
         EXTRACT(EPOCH FROM renewal_lease_expires_at)::BIGINT AS renewal_lease_expires_at,
         retry_count,
         EXTRACT(EPOCH FROM next_retry_at)::BIGINT AS next_retry_at,
         EXTRACT(EPOCH FROM grace_period_expires_at)::BIGINT AS grace_period_expires_at,
         scheduled_plan_id, scheduled_seats, last_reconciliation_ref
  FROM workspace_subscriptions
`;

/**
 * Database-backed storage implementation for PostgreSQL/Neon.
 * Uses atomic SQL transactions and ON CONFLICT clauses for persistent idempotency.
 */
export class DatabaseBillingStorage implements BillingStorageInterface {
  private query: QueryFunction;

  constructor(queryFnOrClient: QueryFunction | any) {
    this.query = normalizeQueryClient(queryFnOrClient);
  }

  async recordEvent(event: DurableBillingEvent): Promise<{ isDuplicate: boolean; event: DurableBillingEvent }> {
    if (
      event.eventType.startsWith("customer.subscription.") ||
      event.eventType.startsWith("checkout.session.") ||
      event.eventType.startsWith("invoice.") ||
      event.eventId.startsWith("evt_")
    ) {
      throw new Error(
        `Cannot record Stripe event "${event.eventId}": Stripe provider has been retired. New payment events must use Paystack.`
      );
    }
    const sql = `
      INSERT INTO billing_events (event_id, event_type, team_id, status, payload, processed_at)
      VALUES ($1, $2, $3, $4, $5, TO_TIMESTAMP($6))
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id, event_id, event_type, team_id, status, EXTRACT(EPOCH FROM processed_at)::BIGINT AS processed_at;
    `;
    const epoch = event.processedAt || Math.floor(Date.now() / 1000);
    const params = [
      event.eventId,
      event.eventType,
      event.teamId ?? null,
      event.status,
      event.payload ? JSON.stringify(event.payload) : null,
      epoch,
    ];

    const result = await this.query(sql, params);

    if (result.rows.length === 0) {
      // Event already recorded (duplicate)
      const existingSql = `
        SELECT id, event_id, event_type, team_id, status, EXTRACT(EPOCH FROM processed_at)::BIGINT AS processed_at
        FROM billing_events
        WHERE event_id = $1;
      `;
      const existingRes = await this.query(existingSql, [event.eventId]);
      const existing = existingRes.rows[0] || event;
      return {
        isDuplicate: true,
        event: {
          id: existing.id,
          eventId: existing.event_id,
          eventType: existing.event_type,
          teamId: existing.team_id,
          status: existing.status,
          processedAt: Number(existing.processed_at),
        },
      };
    }

    const row = result.rows[0];
    return {
      isDuplicate: false,
      event: {
        id: row.id,
        eventId: row.event_id,
        eventType: row.event_type,
        teamId: row.team_id,
        status: row.status,
        processedAt: Number(row.processed_at),
      },
    };
  }

  async updateEventStatus(eventId: string, status: BillingEventStatus, payload?: any): Promise<boolean> {
    const sql = `
      UPDATE billing_events
      SET status = $2,
          payload = COALESCE($3, payload),
          processed_at = TO_TIMESTAMP($4)
      WHERE event_id = $1;
    `;
    const epoch = Math.floor(Date.now() / 1000);
    const res = await this.query(sql, [
      eventId,
      status,
      payload !== undefined ? JSON.stringify(payload) : null,
      epoch,
    ]);
    return (res.rows && res.rows.length > 0) || (typeof res.rowCount === "number" && res.rowCount > 0);
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    const sql = `SELECT 1 FROM billing_events WHERE event_id = $1 AND status = 'processed';`;
    const res = await this.query(sql, [eventId]);
    return res.rows.length > 0;
  }

  async getSubscriptionByTeamId(teamId: number): Promise<DurableSubscriptionState | null> {
    const sql = `${SELECT_SUBSCRIPTION_SQL} WHERE team_id = $1;`;
    const res = await this.query(sql, [teamId]);
    if (res.rows.length === 0) return null;
    return mapRowToSubscriptionState(res.rows[0]);
  }

  async getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<DurableSubscriptionState | null> {
    const sql = `${SELECT_SUBSCRIPTION_SQL} WHERE stripe_subscription_id = $1;`;
    const res = await this.query(sql, [stripeSubscriptionId]);
    if (res.rows.length === 0) return null;
    return mapRowToSubscriptionState(res.rows[0]);
  }

  async getSubscriptionByPaystackCustomer(customerCode: string): Promise<DurableSubscriptionState | null> {
    const sql = `${SELECT_SUBSCRIPTION_SQL} WHERE paystack_customer_code = $1;`;
    const res = await this.query(sql, [customerCode]);
    if (res.rows.length === 0) return null;
    return mapRowToSubscriptionState(res.rows[0]);
  }

  async getSubscriptionByPaystackSubscription(subscriptionCode: string): Promise<DurableSubscriptionState | null> {
    const sql = `${SELECT_SUBSCRIPTION_SQL} WHERE paystack_subscription_code = $1;`;
    const res = await this.query(sql, [subscriptionCode]);
    if (res.rows.length === 0) return null;
    return mapRowToSubscriptionState(res.rows[0]);
  }

  async upsertSubscription(sub: DurableSubscriptionState): Promise<DurableSubscriptionState> {
    // Preserve parameter order $1..$10 exactly matching legacy test suites for backwards compatibility
    const sql = `
      INSERT INTO workspace_subscriptions (
        team_id, stripe_customer_id, stripe_subscription_id, plan_id, seats, status,
        current_period_start, current_period_end, cancel_at_period_end, updated_at,
        payment_provider, paystack_customer_code, paystack_subscription_code,
        paystack_auth_cipher, paystack_auth_iv, paystack_auth_tag, auto_renew_enabled,
        card_brand, card_last4, card_exp_month, card_exp_year, card_bank,
        billing_anchor_day, retry_count, next_retry_at, grace_period_expires_at,
        scheduled_plan_id, scheduled_seats, last_reconciliation_ref
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        TO_TIMESTAMP($7), TO_TIMESTAMP($8), $9, TO_TIMESTAMP($10),
        $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20, $21, $22,
        $23, $24,
        CASE WHEN $25::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($25) END,
        CASE WHEN $26::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($26) END,
        $27, $28, $29
      )
      ON CONFLICT (team_id) DO UPDATE SET
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, workspace_subscriptions.stripe_customer_id),
        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, workspace_subscriptions.stripe_subscription_id),
        plan_id = CASE WHEN workspace_subscriptions.payment_provider = 'paystack' AND EXCLUDED.payment_provider = 'stripe' THEN workspace_subscriptions.plan_id ELSE EXCLUDED.plan_id END,
        seats = CASE WHEN workspace_subscriptions.payment_provider = 'paystack' AND EXCLUDED.payment_provider = 'stripe' THEN workspace_subscriptions.seats ELSE EXCLUDED.seats END,
        status = CASE WHEN workspace_subscriptions.payment_provider = 'paystack' AND EXCLUDED.payment_provider = 'stripe' THEN workspace_subscriptions.status ELSE EXCLUDED.status END,
        current_period_start = CASE WHEN workspace_subscriptions.payment_provider = 'paystack' AND EXCLUDED.payment_provider = 'stripe' THEN workspace_subscriptions.current_period_start ELSE EXCLUDED.current_period_start END,
        current_period_end = CASE WHEN workspace_subscriptions.payment_provider = 'paystack' AND EXCLUDED.payment_provider = 'stripe' THEN workspace_subscriptions.current_period_end ELSE EXCLUDED.current_period_end END,
        cancel_at_period_end = CASE WHEN workspace_subscriptions.payment_provider = 'paystack' AND EXCLUDED.payment_provider = 'stripe' THEN workspace_subscriptions.cancel_at_period_end ELSE EXCLUDED.cancel_at_period_end END,
        updated_at = EXCLUDED.updated_at,
        payment_provider = COALESCE(EXCLUDED.payment_provider, workspace_subscriptions.payment_provider),
        paystack_customer_code = COALESCE(EXCLUDED.paystack_customer_code, workspace_subscriptions.paystack_customer_code),
        paystack_subscription_code = COALESCE(EXCLUDED.paystack_subscription_code, workspace_subscriptions.paystack_subscription_code),
        paystack_auth_cipher = COALESCE(EXCLUDED.paystack_auth_cipher, workspace_subscriptions.paystack_auth_cipher),
        paystack_auth_iv = COALESCE(EXCLUDED.paystack_auth_iv, workspace_subscriptions.paystack_auth_iv),
        paystack_auth_tag = COALESCE(EXCLUDED.paystack_auth_tag, workspace_subscriptions.paystack_auth_tag),
        auto_renew_enabled = CASE WHEN workspace_subscriptions.payment_provider = 'paystack' AND EXCLUDED.payment_provider = 'stripe' THEN workspace_subscriptions.auto_renew_enabled ELSE EXCLUDED.auto_renew_enabled END,
        card_brand = COALESCE(EXCLUDED.card_brand, workspace_subscriptions.card_brand),
        card_last4 = COALESCE(EXCLUDED.card_last4, workspace_subscriptions.card_last4),
        card_exp_month = COALESCE(EXCLUDED.card_exp_month, workspace_subscriptions.card_exp_month),
        card_exp_year = COALESCE(EXCLUDED.card_exp_year, workspace_subscriptions.card_exp_year),
        card_bank = COALESCE(EXCLUDED.card_bank, workspace_subscriptions.card_bank),
        billing_anchor_day = COALESCE(EXCLUDED.billing_anchor_day, workspace_subscriptions.billing_anchor_day),
        retry_count = EXCLUDED.retry_count,
        next_retry_at = EXCLUDED.next_retry_at,
        grace_period_expires_at = EXCLUDED.grace_period_expires_at,
        scheduled_plan_id = EXCLUDED.scheduled_plan_id,
        scheduled_seats = EXCLUDED.scheduled_seats,
        last_reconciliation_ref = EXCLUDED.last_reconciliation_ref
      RETURNING id, team_id, stripe_customer_id, stripe_subscription_id, plan_id, seats, status,
                EXTRACT(EPOCH FROM current_period_start)::BIGINT AS current_period_start,
                EXTRACT(EPOCH FROM current_period_end)::BIGINT AS current_period_end,
                cancel_at_period_end,
                EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at,
                EXTRACT(EPOCH FROM updated_at)::BIGINT AS updated_at,
                payment_provider, paystack_customer_code, paystack_subscription_code,
                paystack_auth_cipher, paystack_auth_iv, paystack_auth_tag, auto_renew_enabled,
                card_brand, card_last4, card_exp_month, card_exp_year, card_bank,
                billing_anchor_day, renewal_lease_token,
                EXTRACT(EPOCH FROM renewal_lease_expires_at)::BIGINT AS renewal_lease_expires_at,
                retry_count,
                EXTRACT(EPOCH FROM next_retry_at)::BIGINT AS next_retry_at,
                EXTRACT(EPOCH FROM grace_period_expires_at)::BIGINT AS grace_period_expires_at,
                scheduled_plan_id, scheduled_seats, last_reconciliation_ref;
    `;
    // 1. Attempted Stripe subscription write must be rejected
    if ((sub.paymentProvider as string) === "stripe") {
      throw new Error(
        `Cannot create or update Stripe subscription for team ${sub.teamId}: Stripe provider has been retired. New subscriptions must use Paystack.`
      );
    }

    // 2. Reject unknown providers
    if (sub.paymentProvider !== undefined && sub.paymentProvider !== "paystack" && (sub.paymentProvider as string) !== "stripe") {
      throw new Error(
        `Invalid payment provider '${sub.paymentProvider}' for team ${sub.teamId}. Active subscriptions must use 'paystack'.`
      );
    }

    // 3. Provider determination and fail-closed validation
    let paymentProvider: PaymentProvider;
    if (sub.paymentProvider === undefined) {
      // An omitted provider on a new subscription must be rejected.
      const existing = await this.getSubscriptionByTeamId(sub.teamId);
      if (!existing) {
        throw new Error(
          `New subscription for team ${sub.teamId} requires an explicit paymentProvider: 'paystack'. Omitted provider is rejected.`
        );
      }
      // Historical Record Preservation: Updates to historical Stripe records must not change their provider attribution
      paymentProvider = existing.paymentProvider === "stripe" ? "stripe" : "paystack";
    } else {
      paymentProvider = sub.paymentProvider;
    }

    const now = Math.floor(Date.now() / 1000);
    const isPaystack = paymentProvider === "paystack";

    // Enforce renewal safety:
    // 1. Stripe records are never Paystack-renewable
    // 2. Default is false if omitted
    // 3. Paystack renewal enabled only if valid encrypted authorization is present
    let autoRenewEnabled = sub.autoRenewEnabled === true;
    if (!isPaystack) {
      autoRenewEnabled = false;
    } else if (autoRenewEnabled) {
      if (!sub.paystackAuthCipher || !sub.paystackAuthIv || !sub.paystackAuthTag) {
        autoRenewEnabled = false;
      } else {
        const key = process.env.PAYSTACK_AUTH_ENCRYPTION_KEY;
        if (key) {
          try {
            decryptAuthorizationCode(
              {
                cipherText: sub.paystackAuthCipher,
                iv: sub.paystackAuthIv,
                tag: sub.paystackAuthTag,
              },
              key
            );
          } catch {
            autoRenewEnabled = false;
          }
        }
      }
    }

    const params = [
      sub.teamId,
      sub.stripeCustomerId ?? null,
      sub.stripeSubscriptionId ?? null,
      sub.planId,
      sub.seats,
      sub.status,
      sub.currentPeriodStart || now,
      sub.currentPeriodEnd || now + 30 * 86400,
      sub.cancelAtPeriodEnd ?? false,
      sub.updatedAt || now,
      paymentProvider,
      sub.paystackCustomerCode ?? null,
      sub.paystackSubscriptionCode ?? null,
      sub.paystackAuthCipher ?? null,
      sub.paystackAuthIv ?? null,
      sub.paystackAuthTag ?? null,
      autoRenewEnabled,
      sub.cardBrand ?? null,
      sub.cardLast4 ?? null,
      sub.cardExpMonth ?? null,
      sub.cardExpYear ?? null,
      sub.cardBank ?? null,
      sub.billingAnchorDay ?? null,
      sub.retryCount ?? 0,
      sub.nextRetryAt ?? null,
      sub.gracePeriodExpiresAt ?? null,
      sub.scheduledPlanId ?? null,
      sub.scheduledSeats ?? null,
      sub.lastReconciliationRef ?? null,
    ];

    const res = await this.query(sql, params);
    if (!res.rows || res.rows.length === 0) {
      throw new Error("Failed to upsert workspace subscription: query returned no rows.");
    }
    return mapRowToSubscriptionState(res.rows[0]);
  }

  async updatePaystackAuthorization(
    teamId: number,
    params: UpdatePaystackAuthorizationParams
  ): Promise<DurableSubscriptionState> {
    const existing = await this.getSubscriptionByTeamId(teamId);
    if (!existing) {
      throw new Error(`Cannot update Paystack authorization: no subscription found for team ${teamId}.`);
    }

    const prepared = preparePaystackAuthorizationState({
      authorization: params.authorization,
      encryptionKey: params.encryptionKey,
    });

    return this.upsertSubscription({
      ...existing,
      paymentProvider: "paystack",
      paystackCustomerCode: params.customerCode ?? existing.paystackCustomerCode,
      paystackSubscriptionCode: params.subscriptionCode ?? existing.paystackSubscriptionCode,
      paystackAuthCipher: prepared.paystackAuthCipher,
      paystackAuthIv: prepared.paystackAuthIv,
      paystackAuthTag: prepared.paystackAuthTag,
      autoRenewEnabled: prepared.autoRenewEnabled,
      cardBrand: prepared.cardBrand ?? existing.cardBrand,
      cardLast4: prepared.cardLast4 ?? existing.cardLast4,
      cardExpMonth: prepared.cardExpMonth ?? existing.cardExpMonth,
      cardExpYear: prepared.cardExpYear ?? existing.cardExpYear,
      cardBank: prepared.cardBank ?? existing.cardBank,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  async findDueRenewals(
    nowEpoch: number = Math.floor(Date.now() / 1000),
    limit: number = 50
  ): Promise<DurableSubscriptionState[]> {
    const sql = `
      ${SELECT_SUBSCRIPTION_SQL}
      WHERE payment_provider = 'paystack'
        AND auto_renew_enabled = TRUE
        AND status IN ('active', 'past_due', 'reconciliation_required')
        AND (
          current_period_end <= TO_TIMESTAMP($1)
          OR (status = 'past_due' AND next_retry_at IS NOT NULL AND next_retry_at <= TO_TIMESTAMP($1))
          OR status = 'reconciliation_required'
        )
        AND (renewal_lease_expires_at IS NULL OR renewal_lease_expires_at <= TO_TIMESTAMP($1))
      ORDER BY current_period_end ASC
      LIMIT $2;
    `;
    const res = await this.query(sql, [nowEpoch, limit]);
    return res.rows.map(mapRowToSubscriptionState);
  }

  async acquireRenewalLease(
    teamId: number,
    leaseToken: string,
    leaseDurationSeconds: number,
    nowEpoch: number = Math.floor(Date.now() / 1000)
  ): Promise<boolean> {
    const sql = `
      UPDATE workspace_subscriptions
      SET renewal_lease_token = $2::UUID,
          renewal_lease_expires_at = TO_TIMESTAMP($3)
      WHERE team_id = $1
        AND (renewal_lease_expires_at IS NULL OR renewal_lease_expires_at <= TO_TIMESTAMP($4))
      RETURNING team_id;
    `;
    const expiresAt = nowEpoch + leaseDurationSeconds;
    const res = await this.query(sql, [teamId, leaseToken, expiresAt, nowEpoch]);
    return (res.rows && res.rows.length > 0) || (typeof res.rowCount === "number" && res.rowCount > 0);
  }

  async releaseRenewalLease(teamId: number, leaseToken: string): Promise<boolean> {
    const sql = `
      UPDATE workspace_subscriptions
      SET renewal_lease_token = NULL,
          renewal_lease_expires_at = NULL
      WHERE team_id = $1
        AND renewal_lease_token = $2::UUID
      RETURNING team_id;
    `;
    const res = await this.query(sql, [teamId, leaseToken]);
    return (res.rows && res.rows.length > 0) || (typeof res.rowCount === "number" && res.rowCount > 0);
  }

  async recordLedgerEntry(entry: DurableLedgerEntry): Promise<{ isDuplicate: boolean; entry: DurableLedgerEntry }> {
    if (entry.transactionId.startsWith("ch_") || entry.type === "checkout_session_completed") {
      throw new Error(
        `Cannot record Stripe ledger entry "${entry.transactionId}": Stripe provider has been retired.`
      );
    }
    const rawAmount = entry.amountKobo !== undefined ? entry.amountKobo : entry.amountCents;
    if (rawAmount === undefined || !Number.isInteger(rawAmount) || rawAmount < 0) {
      throw new TypeError(`Ledger amount must be a non-negative integer. Received: ${rawAmount}`);
    }
    const currency = (entry.currency && entry.currency.trim()) ? entry.currency.trim() : "NGN";
    const sql = `
      INSERT INTO billing_ledger (transaction_id, team_id, event_id, type, amount_cents, currency, status, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TO_TIMESTAMP($9))
      ON CONFLICT (transaction_id) DO NOTHING
      RETURNING id, transaction_id, team_id, event_id, type, amount_cents, currency, status,
                EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at;
    `;
    const epoch = entry.createdAt || Math.floor(Date.now() / 1000);
    const params = [
      entry.transactionId,
      entry.teamId,
      entry.eventId ?? null,
      entry.type,
      rawAmount,
      currency,
      entry.status,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      epoch,
    ];

    const res = await this.query(sql, params);
    if (res.rows.length === 0) {
      // Transaction already recorded
      const existingSql = `
        SELECT id, transaction_id, team_id, event_id, type, amount_cents, currency, status,
               EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at
        FROM billing_ledger
        WHERE transaction_id = $1;
      `;
      const existingRes = await this.query(existingSql, [entry.transactionId]);
      const existing = existingRes.rows[0] || entry;
      return {
        isDuplicate: true,
        entry: {
          id: existing.id,
          transactionId: existing.transaction_id,
          teamId: existing.team_id,
          eventId: existing.event_id,
          type: existing.type,
          amountCents: existing.amount_cents,
          amountKobo: existing.currency === "NGN" ? existing.amount_cents : undefined,
          currency: existing.currency,
          status: existing.status,
          createdAt: Number(existing.created_at),
        },
      };
    }

    const r = res.rows[0];
    return {
      isDuplicate: false,
      entry: {
        id: r.id,
        transactionId: r.transaction_id,
        teamId: r.team_id,
        eventId: r.event_id,
        type: r.type,
        amountCents: r.amount_cents,
        amountKobo: r.currency === "NGN" ? r.amount_cents : undefined,
        currency: r.currency,
        status: r.status,
        createdAt: Number(r.created_at),
      },
    };
  }

  async getLedgerByTeamId(teamId: number): Promise<DurableLedgerEntry[]> {
    const sql = `
      SELECT id, transaction_id, team_id, event_id, type, amount_cents, currency, status,
             EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at
      FROM billing_ledger
      WHERE team_id = $1
      ORDER BY created_at DESC, id DESC;
    `;
    const res = await this.query(sql, [teamId]);
    return res.rows.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      teamId: r.team_id,
      eventId: r.event_id,
      type: r.type,
      amountCents: r.amount_cents,
      amountKobo: r.currency === "NGN" ? r.amount_cents : undefined,
      currency: r.currency,
      status: r.status,
      createdAt: Number(r.created_at),
    }));
  }
}

export interface CreateBillingStorageOptions {
  env?: Record<string, string | undefined>;
  sqlClient?: any;
}

/**
 * Creates the appropriate billing storage implementation.
 */
export function createDefaultBillingStorage(
  options: CreateBillingStorageOptions = {}
): BillingStorageInterface {
  const env = options.env ?? process.env;
  const isProduction = env.NODE_ENV === "production";
  const explicitStorage = env.BILLING_STORAGE?.trim().toLowerCase();
  const databaseUrl = env.DATABASE_URL?.trim();
  const sqlClient = options.sqlClient ?? defaultSql;

  if (explicitStorage === "memory") {
    return new InMemoryBillingStorage();
  }

  if (explicitStorage === "database" || isProduction) {
    if (!databaseUrl || databaseUrl.length === 0) {
      throw new Error(
        "Durable billing persistence is required (BILLING_STORAGE=database or NODE_ENV=production), but DATABASE_URL is not configured. Silently falling back to in-memory storage is prohibited."
      );
    }
    return new DatabaseBillingStorage(sqlClient);
  }

  if (databaseUrl && databaseUrl.length > 0) {
    return new DatabaseBillingStorage(sqlClient);
  }

  return new InMemoryBillingStorage();
}
