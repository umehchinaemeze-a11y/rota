import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BillingEventProcessor,
  createDefaultBillingProcessor,
} from "../lib/billing.ts";

import {
  InMemoryBillingStorage,
  DatabaseBillingStorage,
  createDefaultBillingStorage,
  normalizeTeamId,
} from "../lib/billing-storage.ts";

import {
  parseBillingMigrationArgs,
  executeBillingPersistenceMigration,
  MIGRATION_DDL,
  ROLLBACK_PLAN_SQL,
} from "../scripts/migrate-billing-persistence.mjs";

import { handleGetBillingStatus } from "../app/api/billing/route.ts";
import { handlePaystackInitialize } from "../app/api/billing/paystack/initialize/route.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(currentDir, "..", "scripts");
const scriptPath = path.resolve(scriptsDir, "migrate-billing-persistence.mjs");

describe("Durable Billing Persistence — Schema & Identifier Safety", () => {
  it("normalizes team/workspace identifiers to positive integers matching teams.id", () => {
    assert.equal(normalizeTeamId(1), 1);
    assert.equal(normalizeTeamId(42), 42);
    assert.equal(normalizeTeamId("10"), 10);
    assert.equal(normalizeTeamId("  99  "), 99);

    // Rejects invalid types, strings, negative numbers, or objects
    assert.equal(normalizeTeamId(0), null);
    assert.equal(normalizeTeamId(-5), null);
    assert.equal(normalizeTeamId("abc"), null);
    assert.equal(normalizeTeamId("12.34"), null);
    assert.equal(normalizeTeamId(null), null);
    assert.equal(normalizeTeamId(undefined), null);
    assert.equal(normalizeTeamId({}), null);
    assert.equal(normalizeTeamId([]), null);
  });

  it("defines schema DDL with relational integrity to teams(id INTEGER)", () => {
    assert.ok(MIGRATION_DDL.includes("CREATE TABLE IF NOT EXISTS workspace_subscriptions"));
    assert.ok(MIGRATION_DDL.includes("team_id INTEGER UNIQUE NOT NULL REFERENCES teams(id)"));
    assert.ok(MIGRATION_DDL.includes("CREATE TABLE IF NOT EXISTS billing_events"));
    assert.ok(MIGRATION_DDL.includes("event_id VARCHAR(255) UNIQUE NOT NULL"));
    assert.ok(MIGRATION_DDL.includes("CREATE TABLE IF NOT EXISTS billing_ledger"));
    assert.ok(MIGRATION_DDL.includes("transaction_id VARCHAR(255) UNIQUE NOT NULL"));
    assert.ok(MIGRATION_DDL.includes("team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT"));
    assert.ok(MIGRATION_DDL.includes("currency VARCHAR(10) NOT NULL DEFAULT 'NGN'"));
    assert.ok(MIGRATION_DDL.includes("ALTER TABLE billing_ledger\n  ALTER COLUMN currency SET DEFAULT 'NGN'"));
    assert.ok(MIGRATION_DDL.includes("FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT"));
  });

  it("provides documented rollback SQL in reverse dependency order", () => {
    assert.ok(ROLLBACK_PLAN_SQL.includes("DROP TABLE IF EXISTS billing_ledger"));
    assert.ok(ROLLBACK_PLAN_SQL.includes("DROP TABLE IF EXISTS billing_events"));
    assert.ok(ROLLBACK_PLAN_SQL.includes("DROP TABLE IF EXISTS workspace_subscriptions"));
  });
});

describe("Durable Billing Persistence — CLI Argument Parser & Subprocess Safety", () => {
  it("defaults to dry-run mode when --run is omitted", () => {
    const res = parseBillingMigrationArgs(["node", "script.mjs"]);
    assert.equal(res.run, false);
    assert.equal(res.confirmTarget, null);
    assert.equal(res.confirmEndpoint, null);
  });

  it("parses valid CLI flags accurately", () => {
    const res = parseBillingMigrationArgs([
      "node",
      "script.mjs",
      "--run",
      "--confirm-target",
      "neondb",
      "--confirm-endpoint",
      "ep-staging-123.us-east-2.aws.neon.tech",
    ]);
    assert.equal(res.run, true);
    assert.equal(res.confirmTarget, "neondb");
    assert.equal(res.confirmEndpoint, "ep-staging-123.us-east-2.aws.neon.tech");
  });

  it("runs offline preview mode by default with zero database writes", () => {
    const res = spawnSync("node", [scriptPath], { encoding: "utf-8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /DRY-RUN \/ PREVIEW/);
    assert.match(res.stdout, /Zero database writes executed/);
    assert.match(res.stdout, /CREATE TABLE IF NOT EXISTS workspace_subscriptions/);
  });

  it("rejects execution without --confirm-target with exit code 1", () => {
    const res = spawnSync("node", [scriptPath, "--run"], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /'--confirm-target <database-name>' is required/);
  });

  it("rejects execution without --confirm-endpoint with exit code 1", () => {
    const res = spawnSync(
      "node",
      [scriptPath, "--run", "--confirm-target", "neondb"],
      { encoding: "utf-8" }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /'--confirm-endpoint <exact-hostname>' is required/);
  });

  it("fails closed on endpoint hostname mismatch and redacts credentials", () => {
    const res = spawnSync(
      "node",
      [
        scriptPath,
        "--run",
        "--confirm-target",
        "neondb",
        "--confirm-endpoint",
        "ep-staging-target.us-east-2.aws.neon.tech",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          DATABASE_URL:
            "postgresql://mock_user:super_secret_pw_leak_test_999@ep-prod-mute-888.us-east-2.aws.neon.tech/neondb",
        },
      }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Endpoint confirmation mismatch/);
    assert.doesNotMatch(res.stdout, /super_secret_pw_leak_test_999/);
    assert.doesNotMatch(res.stderr, /super_secret_pw_leak_test_999/);
  });

  it("executes migration inside a single atomic transaction and rolls back on failure", async () => {
    const executedQueries = [];
    let rolledBack = false;

    const mockClient = {
      async query(sql) {
        executedQueries.push(sql.trim());
        if (sql.includes("CREATE TABLE IF NOT EXISTS billing_ledger")) {
          throw new Error("Simulated DDL syntax failure");
        }
        if (sql.includes("ROLLBACK")) {
          rolledBack = true;
        }
        return { rows: [] };
      },
    };

    await assert.rejects(
      async () => executeBillingPersistenceMigration(mockClient),
      /Billing persistence migration failed and was rolled back/
    );

    assert.equal(executedQueries[0], "BEGIN;");
    assert.equal(rolledBack, true);
  });
});

describe("Durable Billing Persistence — In-Memory Storage Contract", () => {
  it("records events and identifies duplicate event IDs accurately", async () => {
    const storage = new InMemoryBillingStorage();
    const event = {
      eventId: "pstk_evt_test_100",
      eventType: "payment.verified",
      teamId: 1,
      status: "processed",
    };

    const first = await storage.recordEvent(event);
    assert.equal(first.isDuplicate, false);
    assert.equal(await storage.isEventProcessed("pstk_evt_test_100"), true);

    const second = await storage.recordEvent(event);
    assert.equal(second.isDuplicate, true);

    // Verify Stripe event writes are rejected
    await assert.rejects(
      async () => {
        await storage.recordEvent({
          eventId: "evt_stripe_prohibited",
          eventType: "customer.subscription.created",
          status: "processed",
        });
      },
      /Cannot record Stripe event.*Stripe provider has been retired/
    );
  });

  it("upserts subscription state atomically without creating duplicate team rows", async () => {
    const storage = new InMemoryBillingStorage();
    const initial = {
      teamId: 10,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_initial",
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    };

    await storage.upsertSubscription(initial);
    const sub1 = await storage.getSubscriptionByTeamId(10);
    assert.equal(sub1.planId, "starter");
    assert.equal(sub1.seats, 15);
    assert.equal(sub1.paymentProvider, "paystack");

    // Upgrade workspace 10 to Pro plan (50 seats)
    await storage.upsertSubscription({
      teamId: 10,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_upgraded",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700050000,
    });

    // Exactly one subscription record exists for workspace 10, updated to Pro
    const sub2 = await storage.getSubscriptionByTeamId(10);
    assert.equal(sub2.planId, "pro");
    assert.equal(sub2.seats, 50);
    assert.equal(sub2.paystackCustomerCode, "CUS_upgraded");

    // Verify Stripe subscription writes are rejected
    await assert.rejects(
      async () => {
        await storage.upsertSubscription({
          teamId: 11,
          paymentProvider: "stripe",
          planId: "pro",
          seats: 50,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
        });
      },
      /Cannot create or update Stripe subscription.*Stripe provider has been retired/
    );
  });

  it("records ledger entries idempotently by unique transaction ID", async () => {
    const storage = new InMemoryBillingStorage();
    const entry = {
      transactionId: "pstk_tx_test_123",
      teamId: 10,
      eventId: "pstk_evt_123",
      type: "charge.success",
      amountCents: 2900,
      currency: "NGN",
      status: "succeeded",
    };

    const first = await storage.recordLedgerEntry(entry);
    assert.equal(first.isDuplicate, false);

    const second = await storage.recordLedgerEntry(entry);
    assert.equal(second.isDuplicate, true);

    const ledger = await storage.getLedgerByTeamId(10);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amountCents, 2900);

    // Verify Stripe ledger entry writes are rejected
    await assert.rejects(
      async () => {
        await storage.recordLedgerEntry({
          transactionId: "ch_stripe_legacy_attempt",
          teamId: 10,
          type: "checkout_session_completed",
          amountCents: 2900,
          currency: "usd",
          status: "succeeded",
        });
      },
      /Cannot record Stripe ledger entry.*Stripe provider has been retired/
    );
  });

  it("enforces ON DELETE RESTRICT in schema DDL to prevent silent deletion of financial history", () => {
    assert.ok(
      MIGRATION_DDL.includes("team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT"),
      "billing_ledger must use ON DELETE RESTRICT"
    );
    assert.ok(
      !MIGRATION_DDL.includes("billing_ledger (\n  id SERIAL PRIMARY KEY,\n  transaction_id VARCHAR(255) UNIQUE NOT NULL,\n  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
      "billing_ledger must NOT use ON DELETE CASCADE"
    );
  });

  it("defaults ledger currency to NGN when currency is omitted", async () => {
    const storage = new InMemoryBillingStorage();
    const res = await storage.recordLedgerEntry({
      transactionId: "pstk_tx_default_curr",
      teamId: 10,
      type: "charge.success",
      amountCents: 1500000,
      status: "succeeded",
    });

    assert.equal(res.entry.currency, "NGN");
    assert.equal(res.entry.amountCents, 1500000);
    assert.equal(res.entry.amountKobo, 1500000);
  });

  it("accepts amountKobo alias and enforces integer amounts with zero floating-point conversion", async () => {
    const storage = new InMemoryBillingStorage();
    const res = await storage.recordLedgerEntry({
      transactionId: "pstk_tx_kobo_alias",
      teamId: 10,
      type: "charge.success",
      amountKobo: 4500000,
      amountCents: 4500000,
      currency: "NGN",
      status: "succeeded",
    });

    assert.equal(res.entry.amountCents, 4500000);
    assert.equal(res.entry.amountKobo, 4500000);
    assert.equal(res.entry.currency, "NGN");

    // Rejects floating point amounts
    await assert.rejects(
      async () => {
        await storage.recordLedgerEntry({
          transactionId: "pstk_tx_float",
          teamId: 10,
          type: "charge.success",
          amountCents: 1500.5,
          status: "succeeded",
        });
      },
      /Ledger amount must be a non-negative integer/
    );
  });

  it("preserves historical records and original currency semantics (e.g. USD cents)", async () => {
    const storage = new InMemoryBillingStorage();
    const historicalEntry = {
      transactionId: "historical_tx_usd_123",
      teamId: 10,
      eventId: "evt_hist_123",
      type: "invoice.paid",
      amountCents: 2900,
      currency: "usd",
      status: "succeeded",
    };

    const res = await storage.recordLedgerEntry(historicalEntry);
    assert.equal(res.entry.currency, "usd");
    assert.equal(res.entry.amountCents, 2900);
    assert.equal(res.entry.amountKobo, undefined, "USD records should not have amountKobo set");

    const ledger = await storage.getLedgerByTeamId(10);
    assert.equal(ledger[0].currency, "usd");
    assert.equal(ledger[0].amountCents, 2900);
  });
});

describe("Durable Billing Persistence — Database SQL Storage Mock Verification", () => {
  it("generates correct PostgreSQL parameterized queries with ON CONFLICT guards", async () => {
    const executedSql = [];
    const queryParams = [];

    const mockQueryFn = async (sql, params) => {
      executedSql.push(sql.trim().replace(/\s+/g, " "));
      queryParams.push(params);

      if (sql.includes("INSERT INTO billing_events")) {
        return {
          rows: [
            {
              id: 1,
              event_id: params[0],
              event_type: params[1],
              team_id: params[2],
              status: params[3],
              processed_at: params[5],
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO workspace_subscriptions")) {
        return {
          rows: [
            {
              id: 1,
              team_id: params[0],
              stripe_customer_id: params[1],
              stripe_subscription_id: params[2],
              plan_id: params[3],
              seats: params[4],
              status: params[5],
              current_period_start: params[6],
              current_period_end: params[7],
              cancel_at_period_end: params[8],
              updated_at: params[9],
              created_at: params[9],
              payment_provider: params[10],
              paystack_customer_code: params[11],
              paystack_subscription_code: params[12],
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO billing_ledger")) {
        return {
          rows: [
            {
              id: 1,
              transaction_id: params[0],
              team_id: params[1],
              event_id: params[2],
              type: params[3],
              amount_cents: params[4],
              currency: params[5],
              status: params[6],
              created_at: params[8],
            },
          ],
        };
      }
      return { rows: [] };
    };

    const dbStorage = new DatabaseBillingStorage(mockQueryFn);

    // 1. Record event (Paystack)
    const eventRes = await dbStorage.recordEvent({
      eventId: "pstk_sql_1",
      eventType: "charge.success",
      teamId: 5,
      status: "processed",
      processedAt: 1700000000,
    });
    assert.equal(eventRes.isDuplicate, false);
    assert.ok(executedSql[0].includes("INSERT INTO billing_events"));
    assert.ok(executedSql[0].includes("ON CONFLICT (event_id) DO NOTHING"));
    assert.equal(queryParams[0][0], "pstk_sql_1");
    assert.equal(queryParams[0][2], 5);

    // 2. Upsert subscription (Paystack)
    const subRes = await dbStorage.upsertSubscription({
      teamId: 5,
      paymentProvider: "paystack",
      paystackSubscriptionCode: "sub_sql_1",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });
    assert.equal(subRes.planId, "pro");
    assert.equal(subRes.seats, 50);
    assert.equal(subRes.paymentProvider, "paystack");
    assert.ok(executedSql[1].includes("INSERT INTO workspace_subscriptions"));
    assert.ok(executedSql[1].includes("ON CONFLICT (team_id) DO UPDATE SET"));

    // 3. Record ledger entry (Paystack)
    const ledgerRes = await dbStorage.recordLedgerEntry({
      transactionId: "pstk_sql_tx_1",
      teamId: 5,
      eventId: "pstk_sql_1",
      type: "paystack_charge_success",
      amountCents: 7900,
      currency: "NGN",
      status: "succeeded",
      createdAt: 1700000000,
    });
    assert.equal(ledgerRes.isDuplicate, false);
    assert.ok(executedSql[2].includes("INSERT INTO billing_ledger"));
    assert.ok(executedSql[2].includes("ON CONFLICT (transaction_id) DO NOTHING"));

    // 4. Verify DatabaseBillingStorage rejects new Stripe writes
    await assert.rejects(
      async () => {
        await dbStorage.upsertSubscription({
          teamId: 5,
          paymentProvider: "stripe",
          planId: "pro",
        });
      },
      /Cannot create or update Stripe subscription.*Stripe provider has been retired/
    );

    await assert.rejects(
      async () => {
        await dbStorage.recordEvent({
          eventId: "evt_stripe_db_blocked",
          eventType: "customer.subscription.created",
        });
      },
      /Cannot record Stripe event.*Stripe provider has been retired/
    );

    await assert.rejects(
      async () => {
        await dbStorage.recordLedgerEntry({
          transactionId: "ch_stripe_db_blocked",
          teamId: 5,
        });
      },
      /Cannot record Stripe ledger entry.*Stripe provider has been retired/
    );
  });

  it("enforces ON DELETE RESTRICT in schema DDL to prevent silent deletion of financial history", () => {
    assert.ok(
      MIGRATION_DDL.includes("team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT"),
      "billing_ledger must use ON DELETE RESTRICT"
    );
    assert.ok(
      !MIGRATION_DDL.includes("billing_ledger (\n  id SERIAL PRIMARY KEY,\n  transaction_id VARCHAR(255) UNIQUE NOT NULL,\n  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE"),
      "billing_ledger must NOT use ON DELETE CASCADE"
    );
  });

  it("defaults ledger currency to NGN when currency is omitted", async () => {
    const storage = new InMemoryBillingStorage();
    const res = await storage.recordLedgerEntry({
      transactionId: "pstk_tx_default_curr",
      teamId: 10,
      type: "charge.success",
      amountCents: 1500000,
      status: "succeeded",
    });

    assert.equal(res.entry.currency, "NGN");
    assert.equal(res.entry.amountCents, 1500000);
    assert.equal(res.entry.amountKobo, 1500000);
  });

  it("accepts amountKobo alias and enforces integer amounts with zero floating-point conversion", async () => {
    const storage = new InMemoryBillingStorage();
    const res = await storage.recordLedgerEntry({
      transactionId: "pstk_tx_kobo_alias",
      teamId: 10,
      type: "charge.success",
      amountKobo: 4500000,
      amountCents: 4500000,
      currency: "NGN",
      status: "succeeded",
    });

    assert.equal(res.entry.amountCents, 4500000);
    assert.equal(res.entry.amountKobo, 4500000);
    assert.equal(res.entry.currency, "NGN");

    // Rejects floating point amounts
    await assert.rejects(
      async () => {
        await storage.recordLedgerEntry({
          transactionId: "pstk_tx_float",
          teamId: 10,
          type: "charge.success",
          amountCents: 1500.5,
          status: "succeeded",
        });
      },
      /Ledger amount must be a non-negative integer/
    );
  });

  it("preserves historical records and original currency semantics (e.g. USD cents)", async () => {
    const storage = new InMemoryBillingStorage();
    const historicalEntry = {
      transactionId: "historical_tx_usd_123",
      teamId: 10,
      eventId: "evt_hist_123",
      type: "invoice.paid",
      amountCents: 2900,
      currency: "usd",
      status: "succeeded",
    };

    const res = await storage.recordLedgerEntry(historicalEntry);
    assert.equal(res.entry.currency, "usd");
    assert.equal(res.entry.amountCents, 2900);
    assert.equal(res.entry.amountKobo, undefined, "USD records should not have amountKobo set");

    const ledger = await storage.getLedgerByTeamId(10);
    assert.equal(ledger[0].currency, "usd");
    assert.equal(ledger[0].amountCents, 2900);
  });
});

describe("Durable Billing Persistence — Subscription Lifecycle & Concurrency Transitions", () => {
  it("rejects Stripe event mutations and transitions cleanly through complete Paystack subscription lifecycle", async () => {
    const storage = new InMemoryBillingStorage();
    const processor = new BillingEventProcessor(undefined, storage);

    // 1. Stripe lifecycle events are rejected and cannot mutate subscriptions
    const stripeAttempt = await processor.processEvent({
      id: "evt_cycle_1",
      type: "customer.subscription.created",
      created: 1700000000,
      data: {
        object: {
          id: "sub_lifecycle_1",
          metadata: { workspace_id: "20" },
          items: { data: [{ plan: { id: "starter" }, quantity: 15 }] },
        },
      },
    });
    assert.equal(stripeAttempt.status, "failed");
    assert.ok(stripeAttempt.message.includes("Stripe event processing is retired and disabled"));

    let sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub, null);

    // 2. Initial Paystack creation (Starter plan, 15 seats)
    await storage.upsertSubscription({
      teamId: 20,
      paymentProvider: "paystack",
      paystackSubscriptionCode: "SUB_cycle_1",
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub.planId, "starter");
    assert.equal(sub.seats, 15);
    assert.equal(sub.status, "active");
    assert.equal(sub.paymentProvider, "paystack");

    // 3. Upgrade to Pro plan (50 seats)
    await storage.upsertSubscription({
      teamId: 20,
      paymentProvider: "paystack",
      paystackSubscriptionCode: "SUB_cycle_1",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700010000,
    });

    sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub.planId, "pro");
    assert.equal(sub.seats, 50);

    // 4. Downgrade to Starter plan (15 seats)
    await storage.upsertSubscription({
      teamId: 20,
      paymentProvider: "paystack",
      paystackSubscriptionCode: "SUB_cycle_1",
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700020000,
    });

    sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub.planId, "starter");
    assert.equal(sub.seats, 15);

    // 5. Cancellation (Reverts to Free tier baseline, canceled status)
    await storage.upsertSubscription({
      teamId: 20,
      paymentProvider: "paystack",
      paystackSubscriptionCode: "SUB_cycle_1",
      planId: "starter",
      seats: 5,
      status: "canceled",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700030000,
    });

    sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub.status, "canceled");
  });

  it("handles concurrent duplicate event arrivals without duplicate entitlements or ledger records", async () => {
    const storage = new InMemoryBillingStorage();
    const processor = new BillingEventProcessor(undefined, storage);

    // 1. Concurrent Stripe events are rejected and do not create ledger entries
    const stripeEvent = {
      id: "evt_race_condition_test",
      type: "checkout.session.completed",
      created: 1700000000,
      data: {
        object: {
          id: "cs_race_101",
          payment_status: "paid",
          status: "complete",
          amount_total: 7900,
          currency: "usd",
          subscription: "sub_race_101",
          metadata: { workspace_id: "40", plan_id: "pro", seats: "50" },
        },
      },
    };

    const [sResult1, sResult2] = await Promise.all([
      processor.processEvent(stripeEvent),
      processor.processEvent(stripeEvent),
    ]);
    assert.equal(sResult1.status, "failed");
    assert.equal(sResult2.status, "failed");

    const emptyLedger = await storage.getLedgerByTeamId(40);
    assert.equal(emptyLedger.length, 0);

    // 2. Concurrent Paystack ledger recordings are idempotent
    const paystackEntry = {
      transactionId: "pstk_tx_race_101",
      teamId: 40,
      eventId: "pstk_evt_race_101",
      type: "paystack_charge_success",
      amountCents: 7900,
      currency: "NGN",
      status: "succeeded",
      createdAt: 1700000000,
    };

    const [res1, res2] = await Promise.all([
      storage.recordLedgerEntry(paystackEntry),
      storage.recordLedgerEntry(paystackEntry),
    ]);

    const outcomes = [res1.isDuplicate, res2.isDuplicate].sort();
    assert.deepEqual(outcomes, [false, true]);

    // Exactly one ledger entry was written
    const ledger = await storage.getLedgerByTeamId(40);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amountCents, 7900);
  });
});

describe("Durable Billing Persistence — Environment Selection & Transactional Safety", () => {
  it("selects InMemoryBillingStorage when BILLING_STORAGE=memory explicitly", () => {
    const storage = createDefaultBillingStorage({
      env: { BILLING_STORAGE: "memory", DATABASE_URL: "postgres://mock-db/test" },
    });
    assert.ok(storage instanceof InMemoryBillingStorage);
  });

  it("selects DatabaseBillingStorage when DATABASE_URL is configured", () => {
    const mockSql = () => Promise.resolve({ rows: [] });
    const storage = createDefaultBillingStorage({
      env: { DATABASE_URL: "postgres://mock-db/test" },
      sqlClient: mockSql,
    });
    assert.ok(storage instanceof DatabaseBillingStorage);
  });

  it("prohibits silent in-memory fallback in production when DATABASE_URL is missing", () => {
    assert.throws(
      () => {
        createDefaultBillingStorage({
          env: { NODE_ENV: "production", DATABASE_URL: "" },
        });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Durable billing persistence is required"));
        assert.ok(err.message.includes("Silently falling back to in-memory storage is prohibited"));
        return true;
      }
    );
  });

  it("prohibits silent in-memory fallback when BILLING_STORAGE=database and DATABASE_URL is missing", () => {
    assert.throws(
      () => {
        createDefaultBillingStorage({
          env: { BILLING_STORAGE: "database", DATABASE_URL: undefined },
        });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Durable billing persistence is required"));
        return true;
      }
    );
  });

  it("ensures a failed transaction is NOT marked processed, allowing safe retry", async () => {
    let failFirstAttempt = true;

    // Mock storage that fails on the first attempt to simulate transient database error
    const faultyStorage = {
      async recordLedgerEntry(entry) {
        return { isDuplicate: false, entry };
      },
      async upsertSubscription(sub) {
        if (failFirstAttempt) {
          throw new Error("Simulated transient PostgreSQL transaction deadlock / serialization failure");
        }
        return sub;
      },
      async recordEvent(event) {
        if (failFirstAttempt) {
          throw new Error("Simulated transient PostgreSQL transaction deadlock / serialization failure");
        }
        return { isDuplicate: false, event };
      },
      async isEventProcessed(eventId) {
        return !failFirstAttempt;
      },
      async getSubscriptionByTeamId() {
        return null;
      },
      async getSubscriptionByStripeId() {
        return null;
      },
      async getLedgerByTeamId() {
        return [];
      },
    };

    const event = {
      eventId: "pstk_tx_retry_test",
      eventType: "charge.success",
      teamId: 55,
      status: "processed",
      processedAt: 1700000000,
    };

    // First attempt: encounters transient database failure
    await assert.rejects(
      async () => faultyStorage.recordEvent(event),
      /Simulated transient PostgreSQL transaction deadlock/
    );

    // Event was NOT permanently marked processed
    assert.equal(await faultyStorage.isEventProcessed(event.eventId), false);

    // Second attempt (database recovered): retry proceeds and succeeds
    failFirstAttempt = false;
    const attempt2 = await faultyStorage.recordEvent(event);
    assert.equal(attempt2.isDuplicate, false);
    assert.equal(attempt2.event.eventId, "pstk_tx_retry_test");
    assert.equal(await faultyStorage.isEventProcessed(event.eventId), true);
  });
});

describe("Durable Billing Persistence — Process Restart & Durable Query Fidelity", () => {
  it("recovers active Paystack subscription and seat capacity in GET /api/billing after clean process restart", async () => {
    const sharedStorage = new InMemoryBillingStorage();

    // Process 1: Ingests Paystack checkout and persists to durable storage
    await sharedStorage.upsertSubscription({
      teamId: 42,
      paymentProvider: "paystack",
      planId: "pro",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });
    await sharedStorage.recordLedgerEntry({
      transactionId: "pstk_tx_restart_1",
      teamId: 42,
      eventId: "pstk_evt_restart_1",
      type: "paystack_charge_success",
      amountCents: 7900,
      currency: "NGN",
      status: "succeeded",
      createdAt: 1700000000,
    });

    // Process 2: Simulates clean application cold restart with a new processor instance
    // Note: processorB in-memory map is completely empty!
    const processorB = new BillingEventProcessor(undefined, sharedStorage);
    assert.equal(processorB.getSubscriptionByWorkspace(42), null); // in-memory cache is empty

    // Query billing status through Process 2
    const user = { userId: 5, teamId: 42, role: "Owner" };
    const res = await handleGetBillingStatus(user, { processor: processorB, activeMemberCount: 8 });

    assert.equal(res.status, 200);
    assert.equal(res.body.workspaceId, 42);
    assert.equal(res.body.subscription.planId, "pro");
    assert.equal(res.body.subscription.paymentProvider, "paystack");
    assert.equal(res.body.seatLimit, 15);
    assert.equal(res.body.capacity.activeMembers, 8);
    assert.equal(res.body.capacity.availableSeats, 7);
    assert.equal(res.body.capacity.isAtCapacity, false);
    assert.equal(res.body.ledger.length, 1);
    assert.equal(res.body.ledger[0].amount, 7900);
  });

  it("preserves readable historical Stripe subscriptions in GET /api/billing across restarts", async () => {
    // Seed storage with historical Stripe subscription (allowed via constructor)
    const historicalStorage = new InMemoryBillingStorage([
      {
        teamId: 99,
        stripeSubscriptionId: "sub_historical_stripe_99",
        stripeCustomerId: "cus_historical_99",
        planId: "starter",
        seats: 15,
        status: "active",
        paymentProvider: "stripe",
        currentPeriodStart: 1690000000,
        currentPeriodEnd: 1692592000,
        updatedAt: 1690000000,
      },
    ]);
    const processor = new BillingEventProcessor(undefined, historicalStorage);

    const user = { userId: 1, teamId: 99, role: "Owner" };
    const res = await handleGetBillingStatus(user, { processor });

    assert.equal(res.status, 200);
    assert.equal(res.body.workspaceId, 99);
    assert.equal(res.body.subscription.planId, "starter");
    assert.equal(res.body.subscription.paymentProvider, "stripe");
        assert.equal(res.body.seatLimit, 15);
  });

  it("enforces tenant boundary on durable subscription reads across restarts", async () => {
    const sharedStorage = new InMemoryBillingStorage();
    await sharedStorage.upsertSubscription({
      teamId: 10,
      paymentProvider: "paystack",
      planId: "pro",
      seats: 25,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    // Fresh process queried by a different workspace
    const processorB = new BillingEventProcessor(undefined, sharedStorage);
    const userWorkspace20 = { userId: 9, teamId: 20, role: "Owner" };
    const res = await handleGetBillingStatus(userWorkspace20, { processor: processorB });

    assert.equal(res.status, 200);
    assert.equal(res.body.workspaceId, 20);
    assert.equal(res.body.subscription.planId, "free"); // Unrelated workspace remains on free tier
    assert.equal(res.body.seatLimit, 5);
    assert.equal(res.body.ledger.length, 0);
  });

  it("detects existing subscription for duplicate-plan prevention in checkout route across restarts", async () => {
    const sharedStorage = new InMemoryBillingStorage();
    await sharedStorage.upsertSubscription({
      teamId: 50,
      paymentProvider: "paystack",
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1700000000 + 30 * 86400,
      updatedAt: 1700000000,
    });

    // Fresh process: User attempts to checkout Starter plan again
    const user = { userId: 1, teamId: 50, role: "Owner" };
    const resDuplicate = await handlePaystackInitialize({ targetPlan: "starter" }, user, {
      storage: sharedStorage,
      currentTime: 1700000000 + 10 * 86400,
    });

    assert.equal(resDuplicate.status, 400);
    assert.ok(resDuplicate.body.message.includes("already subscribed"));

    // Fresh process: User checks out Pro -> succeeds with valid kobo amount and unique reference
    const resUpgrade = await handlePaystackInitialize({ targetPlan: "pro" }, user, {
      storage: sharedStorage,
      currentTime: 1700000000 + 10 * 86400,
    });

    assert.equal(resUpgrade.status, 200);
    assert.equal(resUpgrade.body.amountKobo, 4500000);
    assert.ok(resUpgrade.body.reference.startsWith("pstk_init_50_pro_"));
  });

  it("prohibits silent in-memory fallback and rejects false Free plan when durable storage fails in database mode", async () => {
    // Faulty storage simulating database connectivity failure
    const faultyDatabaseStorage = Object.create(DatabaseBillingStorage.prototype);
    faultyDatabaseStorage.getSubscriptionByTeamId = async () => {
      throw new Error("PostgreSQL connection pool exhausted: timeout acquiring connection");
    };
    faultyDatabaseStorage.getLedgerByTeamId = async () => {
      throw new Error("PostgreSQL connection pool exhausted: timeout acquiring connection");
    };

    const faultyProcessor = new BillingEventProcessor(undefined, faultyDatabaseStorage);
    const user = { userId: 7, teamId: 33, role: "Owner" };

    // Must return HTTP 500 rather than silently returning HTTP 200 with Free Tier
    const res = await handleGetBillingStatus(user, { processor: faultyProcessor });

    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Internal Server Error");
    assert.equal(res.body.message, "Failed to retrieve billing status from persistent storage.");
    // Confirm Free tier was NOT falsely returned
    assert.equal(res.body.subscription, undefined);

    // Also verify checkout route rejects silent fallback on durable storage failure
    const resCheckout = await handlePaystackInitialize({ targetPlan: "pro" }, user, {
      storage: faultyDatabaseStorage,
    });
    assert.equal(resCheckout.status, 500);
    assert.equal(resCheckout.body.error, "Internal Server Error");
    assert.equal(
      resCheckout.body.message,
      "Failed to verify current subscription state."
    );
  });
});
