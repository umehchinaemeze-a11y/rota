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
    assert.ok(MIGRATION_DDL.includes("team_id INTEGER NOT NULL REFERENCES teams(id)"));
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
      eventId: "evt_test_100",
      eventType: "checkout.session.completed",
      teamId: 1,
      status: "processed",
    };

    const first = await storage.recordEvent(event);
    assert.equal(first.isDuplicate, false);
    assert.equal(await storage.isEventProcessed("evt_test_100"), true);

    const second = await storage.recordEvent(event);
    assert.equal(second.isDuplicate, true);
  });

  it("upserts subscription state atomically without creating duplicate team rows", async () => {
    const storage = new InMemoryBillingStorage();
    const initial = {
      teamId: 10,
      stripeSubscriptionId: "sub_initial",
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

    // Upgrade workspace 10 to Pro plan (50 seats)
    await storage.upsertSubscription({
      teamId: 10,
      stripeSubscriptionId: "sub_upgraded",
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
    assert.equal(sub2.stripeSubscriptionId, "sub_upgraded");
  });

  it("records ledger entries idempotently by unique transaction ID", async () => {
    const storage = new InMemoryBillingStorage();
    const entry = {
      transactionId: "ch_cs_test_123",
      teamId: 10,
      eventId: "evt_123",
      type: "checkout_session_completed",
      amountCents: 2900,
      currency: "usd",
      status: "succeeded",
    };

    const first = await storage.recordLedgerEntry(entry);
    assert.equal(first.isDuplicate, false);

    const second = await storage.recordLedgerEntry(entry);
    assert.equal(second.isDuplicate, true);

    const ledger = await storage.getLedgerByTeamId(10);
    assert.equal(ledger.length, 1);
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

    // 1. Record event
    const eventRes = await dbStorage.recordEvent({
      eventId: "evt_sql_1",
      eventType: "checkout.session.completed",
      teamId: 5,
      status: "processed",
      processedAt: 1700000000,
    });
    assert.equal(eventRes.isDuplicate, false);
    assert.ok(executedSql[0].includes("INSERT INTO billing_events"));
    assert.ok(executedSql[0].includes("ON CONFLICT (event_id) DO NOTHING"));
    assert.equal(queryParams[0][0], "evt_sql_1");
    assert.equal(queryParams[0][2], 5);

    // 2. Upsert subscription
    const subRes = await dbStorage.upsertSubscription({
      teamId: 5,
      stripeSubscriptionId: "sub_sql_1",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });
    assert.equal(subRes.planId, "pro");
    assert.equal(subRes.seats, 50);
    assert.ok(executedSql[1].includes("INSERT INTO workspace_subscriptions"));
    assert.ok(executedSql[1].includes("ON CONFLICT (team_id) DO UPDATE SET"));

    // 3. Record ledger entry
    const ledgerRes = await dbStorage.recordLedgerEntry({
      transactionId: "ch_sql_1",
      teamId: 5,
      eventId: "evt_sql_1",
      type: "checkout_session_completed",
      amountCents: 7900,
      currency: "usd",
      status: "succeeded",
      createdAt: 1700000000,
    });
    assert.equal(ledgerRes.isDuplicate, false);
    assert.ok(executedSql[2].includes("INSERT INTO billing_ledger"));
    assert.ok(executedSql[2].includes("ON CONFLICT (transaction_id) DO NOTHING"));
  });
});

describe("Durable Billing Persistence — Subscription Lifecycle & Concurrency Transitions", () => {
  it("transitions cleanly through complete subscription lifecycle (create, upgrade, downgrade, cancel)", async () => {
    const storage = new InMemoryBillingStorage();
    const processor = new BillingEventProcessor(undefined, storage);

    // 1. Initial creation (Starter plan, 15 seats)
    const createRes = await processor.processEvent({
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
    assert.equal(createRes.status, "processed");

    let sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub.planId, "starter");
    assert.equal(sub.seats, 15);
    assert.equal(sub.status, "active");

    // 2. Upgrade to Pro plan (50 seats)
    const upgradeRes = await processor.processEvent({
      id: "evt_cycle_2",
      type: "customer.subscription.updated",
      created: 1700010000,
      data: {
        object: {
          id: "sub_lifecycle_1",
          metadata: { workspace_id: "20" },
          items: { data: [{ plan: { id: "pro" }, quantity: 50 }] },
          status: "active",
        },
      },
    });
    assert.equal(upgradeRes.status, "processed");

    sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub.planId, "pro");
    assert.equal(sub.seats, 50);

    // 3. Downgrade to Starter plan (15 seats)
    const downgradeRes = await processor.processEvent({
      id: "evt_cycle_3",
      type: "customer.subscription.updated",
      created: 1700020000,
      data: {
        object: {
          id: "sub_lifecycle_1",
          metadata: { workspace_id: "20" },
          items: { data: [{ plan: { id: "starter" }, quantity: 15 }] },
          status: "active",
        },
      },
    });
    assert.equal(downgradeRes.status, "processed");

    sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub.planId, "starter");
    assert.equal(sub.seats, 15);

    // 4. Cancellation (Reverts to Free tier baseline, canceled status)
    const cancelRes = await processor.processEvent({
      id: "evt_cycle_4",
      type: "customer.subscription.deleted",
      created: 1700030000,
      data: {
        object: {
          id: "sub_lifecycle_1",
          metadata: { workspace_id: "20" },
        },
      },
    });
    assert.equal(cancelRes.status, "processed");

    sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub.status, "canceled");
  });

  it("handles concurrent duplicate event arrivals without duplicate entitlements or ledger records", async () => {
    const storage = new InMemoryBillingStorage();
    const processor = new BillingEventProcessor(undefined, storage);

    const event = {
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

    // Simulate two simultaneous webhook deliveries hitting the processor concurrently
    const [result1, result2] = await Promise.all([
      processor.processEvent(event),
      processor.processEvent(event),
    ]);

    // One must succeed as processed, the other must be ignored as duplicate
    const outcomes = [result1.status, result2.status].sort();
    assert.deepEqual(outcomes, ["ignored_duplicate", "processed"]);

    // Exactly one ledger entry was written
    const ledger = await storage.getLedgerByTeamId(40);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amountCents, 7900);

    // Subscription status is active
    const sub = await storage.getSubscriptionByTeamId(40);
    assert.equal(sub.planId, "pro");
    assert.equal(sub.seats, 50);
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

    // Mock storage that fails on the first upsert attempt to simulate transient database error
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
        return { isDuplicate: false, event };
      },
      async isEventProcessed(eventId) {
        return false;
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

    const processor = new BillingEventProcessor(undefined, faultyStorage);

    const event = {
      id: "evt_transaction_retry_test",
      type: "checkout.session.completed",
      created: 1700000000,
      data: {
        object: {
          id: "cs_retry_101",
          payment_status: "paid",
          status: "complete",
          amount_total: 2900,
          currency: "usd",
          subscription: "sub_retry_101",
          metadata: { workspace_id: "55", plan_id: "starter", seats: "15" },
        },
      },
    };

    // First attempt: encounters transient database failure
    const attempt1 = await processor.processEvent(event);
    assert.equal(attempt1.status, "failed");
    assert.ok(attempt1.message.includes("Simulated transient PostgreSQL transaction deadlock"));

    // Event must NOT be permanently recorded as processed
    assert.equal(processor.isEventProcessed(event.id), false);
    assert.equal(await processor.isEventProcessedDurable(event.id), false);

    // Second attempt (database recovered): retry should proceed and succeed rather than being rejected as duplicate
    failFirstAttempt = false;
    const attempt2 = await processor.processEvent(event);
    assert.equal(attempt2.status, "processed");
    assert.equal(attempt2.actionTaken, "checkout_completed");

    // NOW event is recorded as processed
    assert.equal(processor.isEventProcessed(event.id), true);
  });
});

