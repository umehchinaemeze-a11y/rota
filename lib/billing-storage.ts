/**
 * Durable Billing Persistence Storage Interface & Implementations
 *
 * Provides storage abstraction for:
 * 1. Workspace Subscriptions (tied relationally to teams.id)
 * 2. Webhook Event Idempotency Ledger (guaranteeing cross-instance uniqueness)
 * 3. Immutable Financial Ledger & Transaction History
 *
 * Schema Relational Invariant:
 * - teams.id is PostgreSQL INTEGER (SERIAL PRIMARY KEY).
 * - All billing records relationally reference teams(id) ON DELETE CASCADE.
 * - workspace_subscriptions enforces UNIQUE (team_id) to prevent duplicate subscriptions per workspace.
 * - billing_events enforces UNIQUE (event_id) for atomic idempotency.
 * - billing_ledger enforces UNIQUE (transaction_id) to prevent duplicate charges.
 */

import { sql as defaultSql } from "./db.ts";

export interface DurableSubscriptionState {
  id?: number;
  teamId: number;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  planId: string;
  seats: number;
  status: "active" | "past_due" | "canceled" | "trialing";
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd?: boolean;
  createdAt?: number;
  updatedAt: number;
}

export interface DurableBillingEvent {
  id?: number;
  eventId: string;
  eventType: string;
  teamId?: number | null;
  status: "processed" | "ignored_duplicate" | "ignored_out_of_order" | "failed";
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
  currency: string;
  status: "succeeded" | "failed" | "pending" | "refunded";
  metadata?: any;
  createdAt?: number;
}

export interface BillingStorageInterface {
  // Webhook Event Idempotency
  recordEvent(event: DurableBillingEvent): Promise<{ isDuplicate: boolean; event: DurableBillingEvent }>;
  isEventProcessed(eventId: string): Promise<boolean>;

  // Workspace Subscription State
  getSubscriptionByTeamId(teamId: number): Promise<DurableSubscriptionState | null>;
  getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<DurableSubscriptionState | null>;
  upsertSubscription(sub: DurableSubscriptionState): Promise<DurableSubscriptionState>;

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
 * Simulates database uniqueness constraints and atomic upsert behavior.
 */
export class InMemoryBillingStorage implements BillingStorageInterface {
  private events = new Map<string, DurableBillingEvent>();
  private subscriptionsByTeamId = new Map<number, DurableSubscriptionState>();
  private subscriptionsByStripeId = new Map<string, number>(); // stripeSubId -> teamId
  private ledger = new Map<string, DurableLedgerEntry>(); // transactionId -> entry

  constructor(initialSubscriptions?: DurableSubscriptionState[]) {
    if (initialSubscriptions) {
      for (const sub of initialSubscriptions) {
        this.subscriptionsByTeamId.set(sub.teamId, { ...sub });
        if (sub.stripeSubscriptionId) {
          this.subscriptionsByStripeId.set(sub.stripeSubscriptionId, sub.teamId);
        }
      }
    }
  }

  async recordEvent(event: DurableBillingEvent): Promise<{ isDuplicate: boolean; event: DurableBillingEvent }> {
    if (this.events.has(event.eventId)) {
      return { isDuplicate: true, event: { ...this.events.get(event.eventId)! } };
    }
    const saved: DurableBillingEvent = {
      ...event,
      processedAt: event.processedAt || Math.floor(Date.now() / 1000),
    };
    this.events.set(event.eventId, saved);
    return { isDuplicate: false, event: saved };
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
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

  async upsertSubscription(sub: DurableSubscriptionState): Promise<DurableSubscriptionState> {
    const existing = this.subscriptionsByTeamId.get(sub.teamId);
    const updated: DurableSubscriptionState = {
      ...existing,
      ...sub,
      updatedAt: sub.updatedAt || Math.floor(Date.now() / 1000),
      createdAt: existing?.createdAt || sub.createdAt || Math.floor(Date.now() / 1000),
    };

    this.subscriptionsByTeamId.set(sub.teamId, updated);
    if (updated.stripeSubscriptionId) {
      this.subscriptionsByStripeId.set(updated.stripeSubscriptionId, updated.teamId);
    }
    return { ...updated };
  }

  async recordLedgerEntry(entry: DurableLedgerEntry): Promise<{ isDuplicate: boolean; entry: DurableLedgerEntry }> {
    if (this.ledger.has(entry.transactionId)) {
      return { isDuplicate: true, entry: { ...this.ledger.get(entry.transactionId)! } };
    }
    const saved: DurableLedgerEntry = {
      ...entry,
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
 * Database-backed storage implementation for PostgreSQL/Neon.
 * Uses atomic SQL transactions and ON CONFLICT clauses for persistent idempotency.
 */
export class DatabaseBillingStorage implements BillingStorageInterface {
  private query: QueryFunction;

  constructor(queryFn: QueryFunction) {
    this.query = queryFn;
  }

  async recordEvent(event: DurableBillingEvent): Promise<{ isDuplicate: boolean; event: DurableBillingEvent }> {
    // Atomic insert with ON CONFLICT DO NOTHING
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

  async isEventProcessed(eventId: string): Promise<boolean> {
    const sql = `SELECT 1 FROM billing_events WHERE event_id = $1;`;
    const res = await this.query(sql, [eventId]);
    return res.rows.length > 0;
  }

  async getSubscriptionByTeamId(teamId: number): Promise<DurableSubscriptionState | null> {
    const sql = `
      SELECT id, team_id, stripe_customer_id, stripe_subscription_id, plan_id, seats, status,
             EXTRACT(EPOCH FROM current_period_start)::BIGINT AS current_period_start,
             EXTRACT(EPOCH FROM current_period_end)::BIGINT AS current_period_end,
             cancel_at_period_end,
             EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at,
             EXTRACT(EPOCH FROM updated_at)::BIGINT AS updated_at
      FROM workspace_subscriptions
      WHERE team_id = $1;
    `;
    const res = await this.query(sql, [teamId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      teamId: r.team_id,
      stripeCustomerId: r.stripe_customer_id,
      stripeSubscriptionId: r.stripe_subscription_id,
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

  async getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<DurableSubscriptionState | null> {
    const sql = `
      SELECT id, team_id, stripe_customer_id, stripe_subscription_id, plan_id, seats, status,
             EXTRACT(EPOCH FROM current_period_start)::BIGINT AS current_period_start,
             EXTRACT(EPOCH FROM current_period_end)::BIGINT AS current_period_end,
             cancel_at_period_end,
             EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at,
             EXTRACT(EPOCH FROM updated_at)::BIGINT AS updated_at
      FROM workspace_subscriptions
      WHERE stripe_subscription_id = $1;
    `;
    const res = await this.query(sql, [stripeSubscriptionId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      teamId: r.team_id,
      stripeCustomerId: r.stripe_customer_id,
      stripeSubscriptionId: r.stripe_subscription_id,
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

  async upsertSubscription(sub: DurableSubscriptionState): Promise<DurableSubscriptionState> {
    const sql = `
      INSERT INTO workspace_subscriptions (
        team_id, stripe_customer_id, stripe_subscription_id, plan_id, seats, status,
        current_period_start, current_period_end, cancel_at_period_end, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        TO_TIMESTAMP($7), TO_TIMESTAMP($8), $9, TO_TIMESTAMP($10)
      )
      ON CONFLICT (team_id) DO UPDATE SET
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, workspace_subscriptions.stripe_customer_id),
        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, workspace_subscriptions.stripe_subscription_id),
        plan_id = EXCLUDED.plan_id,
        seats = EXCLUDED.seats,
        status = EXCLUDED.status,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        updated_at = EXCLUDED.updated_at
      RETURNING id, team_id, stripe_customer_id, stripe_subscription_id, plan_id, seats, status,
                EXTRACT(EPOCH FROM current_period_start)::BIGINT AS current_period_start,
                EXTRACT(EPOCH FROM current_period_end)::BIGINT AS current_period_end,
                cancel_at_period_end,
                EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at,
                EXTRACT(EPOCH FROM updated_at)::BIGINT AS updated_at;
    `;
    const now = Math.floor(Date.now() / 1000);
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
    ];

    const res = await this.query(sql, params);
    const r = res.rows[0];
    return {
      id: r.id,
      teamId: r.team_id,
      stripeCustomerId: r.stripe_customer_id,
      stripeSubscriptionId: r.stripe_subscription_id,
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

  async recordLedgerEntry(entry: DurableLedgerEntry): Promise<{ isDuplicate: boolean; entry: DurableLedgerEntry }> {
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
      entry.amountCents,
      entry.currency || "usd",
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
 *
 * Selection Rules:
 * 1. If BILLING_STORAGE === "memory", returns InMemoryBillingStorage (for tests & offline verification).
 * 2. If BILLING_STORAGE === "database" or NODE_ENV === "production":
 *    - Requires DATABASE_URL to be present.
 *    - Throws Error if DATABASE_URL is missing — prohibits silent fallback to in-memory storage.
 *    - Returns DatabaseBillingStorage connected to the PostgreSQL client.
 * 3. In development or test without explicit BILLING_STORAGE:
 *    - If DATABASE_URL is present, returns DatabaseBillingStorage.
 *    - Otherwise, defaults to InMemoryBillingStorage.
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

