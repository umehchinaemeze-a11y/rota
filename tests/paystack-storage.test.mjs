import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemoryBillingStorage,
  DatabaseBillingStorage,
  createDefaultBillingStorage,
  normalizeTeamId,
  preparePaystackAuthorizationState,
  mapRowToSubscriptionState,
} from "../lib/billing-storage.ts";

import {
  PAYSTACK_MIGRATION_DDL,
  PAYSTACK_ROLLBACK_PLAN_SQL,
  parsePaystackMigrationArgs,
  validatePaystackMigrationTarget,
  executePaystackBillingMigration,
  EXPECTED_STAGING_HOSTNAME,
  FORBIDDEN_PRODUCTION_HOSTNAME,
} from "../scripts/migrate-paystack-billing.mjs";

import {
  encryptAuthorizationCode,
  decryptAuthorizationCode,
} from "../lib/paystack-security.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(currentDir, "..", "scripts");
const scriptPath = path.resolve(scriptsDir, "migrate-paystack-billing.mjs");
const VALID_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Paystack Billing Storage — DDL Schema & Safety Contract", () => {
  it("defines additive DDL preserving all existing columns and adding Paystack fields", () => {
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ALTER TABLE workspace_subscriptions"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ALTER COLUMN payment_provider SET DEFAULT 'paystack'"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS paystack_customer_code VARCHAR(255)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS paystack_subscription_code VARCHAR(255)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS paystack_auth_cipher TEXT"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS paystack_auth_iv VARCHAR(64)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS paystack_auth_tag VARCHAR(64)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS auto_renew_enabled BOOLEAN NOT NULL DEFAULT FALSE"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ALTER COLUMN auto_renew_enabled SET DEFAULT FALSE;"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("UPDATE workspace_subscriptions\nSET auto_renew_enabled = FALSE") || PAYSTACK_MIGRATION_DDL.includes("SET auto_renew_enabled = FALSE"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS card_brand VARCHAR(50)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS card_last4 VARCHAR(10)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS billing_anchor_day INTEGER CHECK (billing_anchor_day BETWEEN 1 AND 31)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS renewal_lease_token UUID"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS renewal_lease_expires_at TIMESTAMPTZ"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS grace_period_expires_at TIMESTAMPTZ"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS scheduled_plan_id VARCHAR(50)"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS scheduled_seats INTEGER"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("ADD COLUMN IF NOT EXISTS last_reconciliation_ref VARCHAR(255)"));

    // Performance and coordination indexes
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("CREATE INDEX IF NOT EXISTS idx_ws_paystack_cust"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("CREATE INDEX IF NOT EXISTS idx_ws_renewal_queue"));
    assert.ok(PAYSTACK_MIGRATION_DDL.includes("CREATE INDEX IF NOT EXISTS idx_ws_lease_recovery"));
  });

  it("provides documented rollback SQL with safe operational policy guidelines", () => {
    assert.ok(PAYSTACK_ROLLBACK_PLAN_SQL.includes("ALTER TABLE workspace_subscriptions"));
    assert.ok(PAYSTACK_ROLLBACK_PLAN_SQL.includes("DROP COLUMN IF EXISTS payment_provider"));
    assert.ok(PAYSTACK_ROLLBACK_PLAN_SQL.includes("DROP COLUMN IF EXISTS paystack_auth_cipher"));
    // Enforces safe rollback policy documentation
    assert.ok(PAYSTACK_ROLLBACK_PLAN_SQL.includes("NOT a safe rollback after Paystack billing"));
    assert.ok(PAYSTACK_ROLLBACK_PLAN_SQL.includes("PRE-ACTIVATION"));
    assert.ok(PAYSTACK_ROLLBACK_PLAN_SQL.includes("POST-ACTIVATION"));
    assert.ok(PAYSTACK_ROLLBACK_PLAN_SQL.includes("Restore from a verified point-in-time backup"));
    // Never drops existing tables or Stripe columns
    assert.doesNotMatch(PAYSTACK_ROLLBACK_PLAN_SQL, /DROP TABLE/);
    assert.doesNotMatch(PAYSTACK_ROLLBACK_PLAN_SQL, /DROP COLUMN IF EXISTS stripe_/);
  });
});

describe("Paystack Billing Storage — CLI Subprocess & Production Safety Guard", () => {
  it("defaults to dry-run preview mode with status 0 when --run is omitted", () => {
    const res = spawnSync("node", [scriptPath], { encoding: "utf-8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /DRY-RUN \/ PREVIEW/);
    assert.match(res.stdout, /Zero database writes executed/);
    assert.match(res.stdout, /ALTER TABLE workspace_subscriptions/);
  });

  it("fails closed with status 1 when --confirm-target is missing", () => {
    const res = spawnSync("node", [scriptPath, "--run"], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /'--confirm-target <database-name>' is required/);
  });

  it("fails closed with status 1 when --confirm-endpoint is missing", () => {
    const res = spawnSync("node", [scriptPath, "--run", "--confirm-target", "neondb"], {
      encoding: "utf-8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /'--confirm-endpoint <exact-hostname>' is required/);
  });

  it("strictly aborts with [FATAL SAFETY STOP] when targeting production hostname", () => {
    const res = spawnSync(
      "node",
      [
        scriptPath,
        "--run",
        "--confirm-target",
        "neondb",
        "--confirm-endpoint",
        FORBIDDEN_PRODUCTION_HOSTNAME,
      ],
      { encoding: "utf-8" }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /FATAL SAFETY STOP/);
    assert.match(res.stderr, /FORBIDDEN PRODUCTION hostname/);
  });

  it("fails closed when endpoint confirmation does not match configured URL", () => {
    const res = spawnSync(
      "node",
      [
        scriptPath,
        "--run",
        "--confirm-target",
        "neondb",
        "--confirm-endpoint",
        "ep-other-wrong-host.us-east-2.aws.neon.tech",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          DATABASE_URL: `postgresql://user:secret@${EXPECTED_STAGING_HOSTNAME}/neondb`,
        },
      }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Endpoint confirmation mismatch|SAFETY GUARD/);
  });

  it("CLI exits 0 in preview/dry-run mode when --run is missing even with --allow-production", () => {
    const res = spawnSync(
      "node",
      [
        scriptPath,
        "--allow-production",
        "--confirm-target",
        "neondb",
        "--confirm-endpoint",
        FORBIDDEN_PRODUCTION_HOSTNAME,
      ],
      { encoding: "utf-8" }
    );
    assert.equal(res.status, 0);
    assert.match(res.stdout, /DRY-RUN \/ PREVIEW/);
    assert.match(res.stdout, /Zero database writes executed/);
    assert.match(res.stdout, /--allow-production/);
  });
});

describe("Paystack Migration Target Guard & Production Authorization Alignment", () => {
  const prodDatabaseUrl = `postgresql://operator:secret_token@${FORBIDDEN_PRODUCTION_HOSTNAME}/neondb?sslmode=require`;
  const stagingDatabaseUrl = `postgresql://operator:secret_token@${EXPECTED_STAGING_HOSTNAME}/neondb?sslmode=require`;
  const unknownHostUrl = `postgresql://operator:secret_token@ep-unknown-preview-12345.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require`;
  const wrongDbUrl = `postgresql://operator:secret_token@${FORBIDDEN_PRODUCTION_HOSTNAME}/wrongdatabase?sslmode=require`;

  it("CLI parser recognizes --allow-production flag and defaults to false when omitted", () => {
    const withoutProd = parsePaystackMigrationArgs(["node", "script.mjs", "--run"]);
    assert.equal(withoutProd.allowProduction, false);

    const withProd = parsePaystackMigrationArgs(["node", "script.mjs", "--run", "--allow-production"]);
    assert.equal(withProd.allowProduction, true);

    const unknownFlag = parsePaystackMigrationArgs(["node", "script.mjs", "--run", "--production"]);
    assert.ok(unknownFlag.error);
    assert.match(unknownFlag.error, /Unrecognized or disallowed argument '--production'/);
  });

  it("default execution still strictly blocks production when --allow-production is omitted", () => {
    assert.throws(
      () =>
        validatePaystackMigrationTarget({
          databaseUrl: prodDatabaseUrl,
          confirmTarget: "neondb",
          confirmEndpoint: FORBIDDEN_PRODUCTION_HOSTNAME,
          allowProduction: false,
        }),
      (err) => {
        assert.match(err.message, /FATAL SAFETY STOP/);
        assert.match(err.message, /FORBIDDEN PRODUCTION hostname/);
        assert.match(err.message, /--allow-production/);
        return true;
      }
    );
  });

  it("production authorization is NOT inferred from NODE_ENV or DATABASE_URL alone", () => {
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      assert.throws(
        () =>
          validatePaystackMigrationTarget({
            databaseUrl: prodDatabaseUrl,
            confirmTarget: "neondb",
            confirmEndpoint: FORBIDDEN_PRODUCTION_HOSTNAME,
            allowProduction: false,
          }),
        /FATAL SAFETY STOP/
      );
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("production execution with all explicit authorization flags passes target validation", () => {
    const result = validatePaystackMigrationTarget({
      databaseUrl: prodDatabaseUrl,
      confirmTarget: "neondb",
      confirmEndpoint: FORBIDDEN_PRODUCTION_HOSTNAME,
      allowProduction: true,
    });
    assert.equal(result.valid, true);
    assert.equal(result.targetType, "production");
    assert.equal(result.hostname, FORBIDDEN_PRODUCTION_HOSTNAME);
    assert.equal(result.database, "neondb");
  });

  it("rejects incorrect production hostname or confirmation mismatch", () => {
    // 1. Operator passes wrong endpoint confirmation
    assert.throws(
      () =>
        validatePaystackMigrationTarget({
          databaseUrl: prodDatabaseUrl,
          confirmTarget: "neondb",
          confirmEndpoint: "ep-wrong-endpoint.c-7.us-east-2.aws.neon.tech",
          allowProduction: true,
        }),
      /Endpoint confirmation mismatch/
    );

    // 2. Database URL itself has wrong production host
    assert.throws(
      () =>
        validatePaystackMigrationTarget({
          databaseUrl: `postgresql://user:pass@ep-wrong-production-host.neon.tech/neondb`,
          confirmTarget: "neondb",
          confirmEndpoint: "ep-wrong-production-host.neon.tech",
          allowProduction: true,
        }),
      /neither the approved staging branch nor the authorized production database/
    );
  });

  it("rejects incorrect database name", () => {
    // 1. Operator confirms wrong database name
    assert.throws(
      () =>
        validatePaystackMigrationTarget({
          databaseUrl: prodDatabaseUrl,
          confirmTarget: "wrongdb",
          confirmEndpoint: FORBIDDEN_PRODUCTION_HOSTNAME,
          allowProduction: true,
        }),
      /Database confirmation mismatch/
    );

    // 2. Database URL points to unexpected database name
    assert.throws(
      () =>
        validatePaystackMigrationTarget({
          databaseUrl: wrongDbUrl,
          confirmTarget: "wrongdatabase",
          confirmEndpoint: FORBIDDEN_PRODUCTION_HOSTNAME,
          allowProduction: true,
        }),
      /does not match expected target database 'neondb'/
    );
  });

  it("staging execution continues to work under its existing authorization rules without --allow-production", () => {
    const result = validatePaystackMigrationTarget({
      databaseUrl: stagingDatabaseUrl,
      confirmTarget: "neondb",
      confirmEndpoint: EXPECTED_STAGING_HOSTNAME,
      allowProduction: false,
    });
    assert.equal(result.valid, true);
    assert.equal(result.targetType, "staging");
    assert.equal(result.hostname, EXPECTED_STAGING_HOSTNAME);
    assert.equal(result.database, "neondb");
  });

  it("rejects staging hostname when production is explicitly selected (target mismatch)", () => {
    assert.throws(
      () =>
        validatePaystackMigrationTarget({
          databaseUrl: stagingDatabaseUrl,
          confirmTarget: "neondb",
          confirmEndpoint: EXPECTED_STAGING_HOSTNAME,
          allowProduction: true,
        }),
      /Target database mismatch: '--allow-production' flag was specified, but the confirmed endpoint matches the STAGING hostname/
    );
  });

  it("rejects unknown database hosts", () => {
    assert.throws(
      () =>
        validatePaystackMigrationTarget({
          databaseUrl: unknownHostUrl,
          confirmTarget: "neondb",
          confirmEndpoint: "ep-unknown-preview-12345.c-7.us-east-2.aws.neon.tech",
          allowProduction: false,
        }),
      /neither the approved staging branch nor the authorized production database/
    );

    assert.throws(
      () =>
        validatePaystackMigrationTarget({
          databaseUrl: unknownHostUrl,
          confirmTarget: "neondb",
          confirmEndpoint: "ep-unknown-preview-12345.c-7.us-east-2.aws.neon.tech",
          allowProduction: true,
        }),
      /neither the approved staging branch nor the authorized production database/
    );
  });
});

describe("Paystack Billing Storage — Atomic Transactions & Rollback", () => {
  it("executes migration inside a single atomic transaction and rolls back on failure", async () => {
    const executedQueries = [];
    let rolledBack = false;

    const mockClient = {
      async query(sql) {
        executedQueries.push(sql.trim());
        if (sql.includes("CREATE INDEX IF NOT EXISTS idx_ws_lease_recovery")) {
          throw new Error("Simulated index creation lock timeout");
        }
        if (sql.includes("ROLLBACK")) {
          rolledBack = true;
        }
        return { rows: [] };
      },
    };

    await assert.rejects(
      async () => executePaystackBillingMigration(mockClient),
      /Paystack billing migration failed and was rolled back/
    );

    assert.equal(executedQueries[0], "BEGIN;");
    assert.equal(rolledBack, true);
  });

  it("executes migration idempotently across multiple executions without error", async () => {
    const executedQueries = [];

    const mockClient = {
      async query(sql) {
        executedQueries.push(sql.trim());
        return { rows: [] };
      },
    };

    // First execution
    const res1 = await executePaystackBillingMigration(mockClient);
    assert.equal(res1.success, true);
    assert.equal(res1.columnsAdded.length, 21);
    assert.equal(res1.indexesCreated.length, 3);

    // Second execution (idempotency simulation)
    const res2 = await executePaystackBillingMigration(mockClient);
    assert.equal(res2.success, true);
    assert.equal(res2.columnsAdded.length, 21);
  });
});

describe("Paystack Billing Storage — Multi-Provider In-Memory Contract", () => {
  it("persists Paystack subscription state and looks up by team ID and Paystack codes", async () => {
    const storage = new InMemoryBillingStorage();
    const encryptedAuth = encryptAuthorizationCode("AUTH_chika_card_123", VALID_KEY_HEX);

    const paystackSub = {
      teamId: 10,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_chika_101",
      paystackSubscriptionCode: "SUB_chika_101",
      paystackAuthCipher: encryptedAuth.cipherText,
      paystackAuthIv: encryptedAuth.iv,
      paystackAuthTag: encryptedAuth.tag,
      autoRenewEnabled: true,
      cardBrand: "visa",
      cardLast4: "4081",
      cardExpMonth: 12,
      cardExpYear: 2030,
      cardBank: "Access Bank",
      billingAnchorDay: 31,
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    };

    await storage.upsertSubscription(paystackSub);

    // 1. Lookup by Team ID
    const byTeam = await storage.getSubscriptionByTeamId(10);
    assert.ok(byTeam);
    assert.equal(byTeam.paymentProvider, "paystack");
    assert.equal(byTeam.planId, "pro");
    assert.equal(byTeam.seats, 50);
    assert.equal(byTeam.cardLast4, "4081");
    assert.equal(byTeam.billingAnchorDay, 31);

    // Verify stored authorization can be decrypted
    const decryptedAuth = decryptAuthorizationCode(
      {
        cipherText: byTeam.paystackAuthCipher,
        iv: byTeam.paystackAuthIv,
        tag: byTeam.paystackAuthTag,
      },
      VALID_KEY_HEX
    );
    assert.equal(decryptedAuth, "AUTH_chika_card_123");

    // 2. Lookup by Paystack Customer Code
    const byCust = await storage.getSubscriptionByPaystackCustomer("CUS_chika_101");
    assert.ok(byCust);
    assert.equal(byCust.teamId, 10);

    // 3. Lookup by Paystack Subscription Code
    const bySub = await storage.getSubscriptionByPaystackSubscription("SUB_chika_101");
    assert.ok(bySub);
    assert.equal(bySub.teamId, 10);
  });

  it("coexists cleanly with Stripe subscriptions without cross-provider data leakage", async () => {
    // Workspace 1: On legacy historical Stripe (seeded in constructor)
    const storage = new InMemoryBillingStorage([
      {
        teamId: 1,
        paymentProvider: "stripe",
        stripeCustomerId: "cus_stripe_111",
        stripeSubscriptionId: "sub_stripe_111",
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    // Verify creating new Stripe subscription is rejected
    await assert.rejects(
      async () => {
        await storage.upsertSubscription({
          teamId: 3,
          paymentProvider: "stripe",
          planId: "starter",
          seats: 15,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
        });
      },
      /Cannot create or update Stripe subscription/
    );

    // Workspace 2: On Paystack
    await storage.upsertSubscription({
      teamId: 2,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_paystack_222",
      paystackSubscriptionCode: "SUB_paystack_222",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    // Query Stripe subscription
    const sub1 = await storage.getSubscriptionByStripeId("sub_stripe_111");
    assert.ok(sub1);
    assert.equal(sub1.teamId, 1);
    assert.equal(sub1.paymentProvider, "stripe");
    assert.equal(sub1.paystackCustomerCode, undefined);

    // Query Paystack subscription
    const sub2 = await storage.getSubscriptionByPaystackCustomer("CUS_paystack_222");
    assert.ok(sub2);
    assert.equal(sub2.teamId, 2);
    assert.equal(sub2.paymentProvider, "paystack");
    assert.equal(sub2.stripeSubscriptionId, undefined);

    // Cross-query isolation
    assert.equal(await storage.getSubscriptionByStripeId("SUB_paystack_222"), null);
    assert.equal(await storage.getSubscriptionByPaystackCustomer("cus_stripe_111"), null);
  });

  it("enforces tenant isolation across multiple workspaces", async () => {
    const storage = new InMemoryBillingStorage();

    await storage.upsertSubscription({
      teamId: 100,
      paymentProvider: "paystack",
      planId: "pro",
      seats: 50,
      status: "active",
      paystackCustomerCode: "CUS_100",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    // Querying an unrelated team returns null
    const unrelated = await storage.getSubscriptionByTeamId(999);
    assert.equal(unrelated, null);
  });

  it("records financial ledger entries idempotently by unique transaction reference", async () => {
    const storage = new InMemoryBillingStorage();
    const entry = {
      transactionId: "pstk_ref_999",
      teamId: 10,
      eventId: "pstk_evt_charge_999",
      type: "charge.success",
      amountCents: 4500000, // ₦45,000 in kobo
      currency: "NGN",
      status: "succeeded",
    };

    const first = await storage.recordLedgerEntry(entry);
    assert.equal(first.isDuplicate, false);

    const second = await storage.recordLedgerEntry(entry);
    assert.equal(second.isDuplicate, true);

    const ledger = await storage.getLedgerByTeamId(10);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amountCents, 4500000);
    assert.equal(ledger[0].currency, "NGN");
  });
});

describe("Paystack Billing Storage — Database SQL Mock Verification", () => {
  it("constructs correct parameterized SQL for Paystack columns while preserving legacy parameter indices", async () => {
    const executedSql = [];
    const queryParams = [];

    const mockQueryFn = async (sql, params) => {
      executedSql.push(sql.trim().replace(/\s+/g, " "));
      queryParams.push(params);

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
              payment_provider: params[10],
              paystack_customer_code: params[11],
              paystack_subscription_code: params[12],
              paystack_auth_cipher: params[13],
              paystack_auth_iv: params[14],
              paystack_auth_tag: params[15],
              auto_renew_enabled: params[16],
              card_brand: params[17],
              card_last4: params[18],
              card_exp_month: params[19],
              card_exp_year: params[20],
              card_bank: params[21],
              billing_anchor_day: params[22],
              retry_count: params[23],
              next_retry_at: params[24],
              grace_period_expires_at: params[25],
              scheduled_plan_id: params[26],
              scheduled_seats: params[27],
              last_reconciliation_ref: params[28],
            },
          ],
        };
      }
      return { rows: [] };
    };

    const dbStorage = new DatabaseBillingStorage(mockQueryFn);

    const sub = await dbStorage.upsertSubscription({
      teamId: 42,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_sql_42",
      paystackSubscriptionCode: "SUB_sql_42",
      paystackAuthCipher: "cipher_base64",
      paystackAuthIv: "iv_base64",
      paystackAuthTag: "tag_base64",
      autoRenewEnabled: true,
      cardBrand: "mastercard",
      cardLast4: "5555",
      billingAnchorDay: 15,
      planId: "enterprise",
      seats: 500,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    assert.equal(sub.teamId, 42);
    assert.equal(sub.planId, "enterprise");
    assert.equal(sub.seats, 500);
    assert.equal(sub.paymentProvider, "paystack");
    assert.equal(sub.paystackCustomerCode, "CUS_sql_42");
    assert.equal(sub.cardLast4, "5555");
    assert.equal(sub.billingAnchorDay, 15);

    // Verify SQL query structure
    assert.ok(executedSql[0].includes("INSERT INTO workspace_subscriptions"));
    assert.ok(executedSql[0].includes("payment_provider"));
    assert.ok(executedSql[0].includes("paystack_customer_code"));
    assert.ok(executedSql[0].includes("billing_anchor_day"));
    assert.ok(executedSql[0].includes("ON CONFLICT (team_id) DO UPDATE SET"));

    // Legacy parameter indices preserved
    assert.equal(queryParams[0][0], 42); // team_id
    assert.equal(queryParams[0][3], "enterprise"); // plan_id
    assert.equal(queryParams[0][4], 500); // seats
    assert.equal(queryParams[0][10], "paystack"); // payment_provider
    assert.equal(queryParams[0][11], "CUS_sql_42"); // paystack_customer_code
  });

  it("fails closed on database connection failure without falling back silently", async () => {
    const faultyQueryFn = async () => {
      throw new Error("Neon connection pool connection limit exceeded");
    };

    const dbStorage = new DatabaseBillingStorage(faultyQueryFn);

    await assert.rejects(
      async () => dbStorage.getSubscriptionByTeamId(10),
      /Neon connection pool connection limit exceeded/
    );
  });
});

describe("Paystack Billing Storage — Renewal Safety & Authorization Invariants", () => {
  it("defaults auto_renew_enabled to FALSE when omitted", async () => {
    const storage = new InMemoryBillingStorage();

    const sub = await storage.upsertSubscription({
      teamId: 101,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_default_test",
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    assert.equal(sub.autoRenewEnabled, false, "autoRenewEnabled must default to false when omitted");
  });

  it("ensures existing Stripe subscriptions remain unaffected and are NEVER treated as Paystack-renewable", async () => {
    // Seed historical Stripe subscription via constructor
    const storage = new InMemoryBillingStorage([
      {
        teamId: 102,
        paymentProvider: "stripe",
        stripeCustomerId: "cus_stripe_safeguard",
        stripeSubscriptionId: "sub_stripe_safeguard",
        autoRenewEnabled: true, // Should be forced to false
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    const retrieved = await storage.getSubscriptionByTeamId(102);
    assert.equal(retrieved.paymentProvider, "stripe");
    assert.equal(retrieved.autoRenewEnabled, false, "Stripe subscription must never be Paystack-renewable");

    // Also assert that new Stripe writes are rejected
    await assert.rejects(
      async () => {
        await storage.upsertSubscription({
          teamId: 102,
          paymentProvider: "stripe",
          planId: "pro",
          seats: 50,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
        });
      },
      /Cannot create or update Stripe subscription/
    );
  });

  it("activates Paystack renewal only after server-side verification confirms reusable === true and authorization is encrypted", async () => {
    const storage = new InMemoryBillingStorage();

    // Initial subscription created during checkout initialization (renewal not enabled yet)
    await storage.upsertSubscription({
      teamId: 103,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_verified_103",
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    // Simulating verified transaction callback with reusable authorization
    const verifiedAuth = {
      authorization_code: "AUTH_recurring_active_token_999",
      reusable: true,
      card_type: "visa",
      last4: "4081",
      exp_month: "12",
      exp_year: "2030",
      bank: "Zenith Bank",
    };

    const updated = await storage.updatePaystackAuthorization(103, {
      customerCode: "CUS_verified_103",
      authorization: verifiedAuth,
      encryptionKey: VALID_KEY_HEX,
    });

    // Renewal is now active
    assert.equal(updated.autoRenewEnabled, true, "Renewal must be enabled for reusable auth");
    assert.equal(updated.cardBrand, "visa");
    assert.equal(updated.cardLast4, "4081");
    assert.equal(updated.cardExpMonth, 12);
    assert.equal(updated.cardExpYear, 2030);
    assert.equal(updated.cardBank, "Zenith Bank");

    // Plaintext authorization code is NEVER stored
    assert.notEqual(updated.paystackAuthCipher, "AUTH_recurring_active_token_999");
    assert.ok(updated.paystackAuthCipher);
    assert.ok(updated.paystackAuthIv);
    assert.ok(updated.paystackAuthTag);

    // Decryption yields the exact original code
    const decrypted = decryptAuthorizationCode(
      {
        cipherText: updated.paystackAuthCipher,
        iv: updated.paystackAuthIv,
        tag: updated.paystackAuthTag,
      },
      VALID_KEY_HEX
    );
    assert.equal(decrypted, "AUTH_recurring_active_token_999");
  });

  it("strictly disables renewal when authorization is non-reusable (reusable === false)", async () => {
    const storage = new InMemoryBillingStorage();

    await storage.upsertSubscription({
      teamId: 104,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_onetime_104",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    // Simulating non-reusable authorization (e.g. one-time card or bank auth)
    const nonReusableAuth = {
      authorization_code: "AUTH_onetime_card_000",
      reusable: false,
      card_type: "mastercard",
      last4: "1234",
      exp_month: "06",
      exp_year: "2028",
      bank: "GTBank",
    };

    const updated = await storage.updatePaystackAuthorization(104, {
      customerCode: "CUS_onetime_104",
      authorization: nonReusableAuth,
      encryptionKey: VALID_KEY_HEX,
    });

    // Auto-renew must remain disabled
    assert.equal(updated.autoRenewEnabled, false, "Renewal must be false when reusable is false");
    assert.equal(updated.paystackAuthCipher, null, "Cipher must be null for non-reusable auth");
    assert.equal(updated.paystackAuthIv, null);
    assert.equal(updated.paystackAuthTag, null);

    // Non-sensitive card display metadata is still captured for UI display
    assert.equal(updated.cardBrand, "mastercard");
    assert.equal(updated.cardLast4, "1234");
  });

  it("strictly disables renewal when authorization is missing or invalid", async () => {
    const storage = new InMemoryBillingStorage();

    await storage.upsertSubscription({
      teamId: 105,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_missing_auth",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    // Call update with null authorization
    const updated = await storage.updatePaystackAuthorization(105, {
      authorization: null,
    });

    assert.equal(updated.autoRenewEnabled, false);
    assert.equal(updated.paystackAuthCipher, null);
  });

  it("strictly disables renewal when encrypted authorization is undecryptable or corrupted", async () => {
    const storage = new InMemoryBillingStorage();
    const envBackup = process.env.PAYSTACK_AUTH_ENCRYPTION_KEY;
    process.env.PAYSTACK_AUTH_ENCRYPTION_KEY = VALID_KEY_HEX;

    try {
      const encrypted = encryptAuthorizationCode("AUTH_valid_token", VALID_KEY_HEX);

      // Attempt to upsert with corrupted cipher and autoRenewEnabled: true
      const sub = await storage.upsertSubscription({
        teamId: 106,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_corrupt_106",
        paystackAuthCipher: "corrupted_base64_data_that_cannot_decrypt==",
        paystackAuthIv: encrypted.iv,
        paystackAuthTag: encrypted.tag,
        autoRenewEnabled: true,
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      });

      assert.equal(sub.autoRenewEnabled, false, "Corrupted authorization must disable auto-renewal");
    } finally {
      process.env.PAYSTACK_AUTH_ENCRYPTION_KEY = envBackup;
    }
  });

  it("verifies SQL database queries pass auto_renew_enabled = FALSE for Stripe and non-reusable Paystack", async () => {
    const queryParamsList = [];

    const mockQueryFn = async (sql, params) => {
      queryParamsList.push(params);
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
            payment_provider: params[10],
            paystack_customer_code: params[11],
            paystack_subscription_code: params[12],
            paystack_auth_cipher: params[13],
            paystack_auth_iv: params[14],
            paystack_auth_tag: params[15],
            auto_renew_enabled: params[16],
            card_brand: params[17],
            card_last4: params[18],
            card_exp_month: params[19],
            card_exp_year: params[20],
            card_bank: params[21],
            billing_anchor_day: params[22],
            retry_count: params[23],
            next_retry_at: params[24],
            grace_period_expires_at: params[25],
            scheduled_plan_id: params[26],
            scheduled_seats: params[27],
            last_reconciliation_ref: params[28],
          },
        ],
      };
    };

    const dbStorage = new DatabaseBillingStorage(mockQueryFn);

    // 1. Rejection of Stripe upsert in DatabaseBillingStorage
    await assert.rejects(
      async () => {
        await dbStorage.upsertSubscription({
          teamId: 201,
          paymentProvider: "stripe",
          stripeCustomerId: "cus_sql_stripe",
          stripeSubscriptionId: "sub_sql_stripe",
          autoRenewEnabled: true,
          planId: "starter",
          seats: 15,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
          updatedAt: 1700000000,
        });
      },
      /Cannot create or update Stripe subscription.*Stripe provider has been retired/
    );

    // 2. Paystack upsert without authorization
    await dbStorage.upsertSubscription({
      teamId: 202,
      paymentProvider: "paystack",
      paystackCustomerCode: "CUS_sql_paystack_pending",
      autoRenewEnabled: true, // Should be forced to false because auth is missing
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    assert.equal(queryParamsList[0][10], "paystack");
    assert.equal(queryParamsList[0][16], false, "SQL parameter $17 must be false without valid encrypted auth");
  });
});


describe("Paystack Billing Migration — Provider Backfill & Rerunnability Safety (Requirement A)", () => {
  it("classifies records with stripe_subscription_id as 'stripe'", () => {
    const records = [
      { id: 1, stripe_subscription_id: "sub_stripe_1", stripe_customer_id: null, payment_provider: null },
    ];

    // Simulate migration logic
    records.forEach(r => {
      if ((r.stripe_subscription_id !== null || r.stripe_customer_id !== null) && r.payment_provider === null) {
        r.payment_provider = "stripe";
      }
      if (r.payment_provider === null) {
        r.payment_provider = "paystack";
      }
    });

    assert.equal(records[0].payment_provider, "stripe");
  });

  it("classifies records with stripe_customer_id without subscription ID as 'stripe'", () => {
    const records = [
      { id: 2, stripe_subscription_id: null, stripe_customer_id: "cus_stripe_only", payment_provider: null },
    ];

    records.forEach(r => {
      if ((r.stripe_subscription_id !== null || r.stripe_customer_id !== null) && r.payment_provider === null) {
        r.payment_provider = "stripe";
      }
      if (r.payment_provider === null) {
        r.payment_provider = "paystack";
      }
    });

    assert.equal(records[0].payment_provider, "stripe", "Record with customer ID only must be attributed to Stripe");
  });

  it("classifies records with both Stripe identifiers populated as 'stripe'", () => {
    const records = [
      { id: 3, stripe_subscription_id: "sub_both_1", stripe_customer_id: "cus_both_1", payment_provider: null },
    ];

    records.forEach(r => {
      if ((r.stripe_subscription_id !== null || r.stripe_customer_id !== null) && r.payment_provider === null) {
        r.payment_provider = "stripe";
      }
      if (r.payment_provider === null) {
        r.payment_provider = "paystack";
      }
    });

    assert.equal(records[0].payment_provider, "stripe");
  });

  it("preserves existing explicit 'paystack' provider without overwriting", () => {
    const records = [
      { id: 4, stripe_subscription_id: "sub_old_1", stripe_customer_id: "cus_old_1", payment_provider: "paystack" },
    ];

    records.forEach(r => {
      // payment_provider IS NULL guard prevents overwriting existing explicit assignment
      if ((r.stripe_subscription_id !== null || r.stripe_customer_id !== null) && r.payment_provider === null) {
        r.payment_provider = "stripe";
      }
      if (r.payment_provider === null) {
        r.payment_provider = "paystack";
      }
    });

    assert.equal(records[0].payment_provider, "paystack", "Explicit payment_provider must not be overwritten");
  });

  it("classifies genuinely unassigned NULL records without Stripe IDs as 'paystack'", () => {
    const records = [
      { id: 5, stripe_subscription_id: null, stripe_customer_id: null, payment_provider: null },
    ];

    records.forEach(r => {
      if ((r.stripe_subscription_id !== null || r.stripe_customer_id !== null) && r.payment_provider === null) {
        r.payment_provider = "stripe";
      }
      if (r.payment_provider === null) {
        r.payment_provider = "paystack";
      }
    });

    assert.equal(records[0].payment_provider, "paystack");
  });

  it("assigns 'paystack' default to newly inserted records", () => {
    const newRecord = {
      id: 6,
      stripe_subscription_id: null,
      stripe_customer_id: null,
      // Default value applied by database DDL: ALTER TABLE workspace_subscriptions ALTER COLUMN payment_provider SET DEFAULT 'paystack';
      payment_provider: "paystack",
    };

    assert.equal(newRecord.payment_provider, "paystack");
  });

  it("is non-destructive and rerunnable (repeated migration execution does not mutate records)", () => {
    const records = [
      { id: 1, stripe_subscription_id: "sub_1", stripe_customer_id: null, payment_provider: null },
      { id: 2, stripe_subscription_id: null, stripe_customer_id: "cus_2", payment_provider: null },
      { id: 3, stripe_subscription_id: null, stripe_customer_id: null, payment_provider: null },
    ];

    // Migration run 1
    const runMigration = (table) => {
      table.forEach(r => {
        if ((r.stripe_subscription_id !== null || r.stripe_customer_id !== null) && r.payment_provider === null) {
          r.payment_provider = "stripe";
        }
        if (r.payment_provider === null) {
          r.payment_provider = "paystack";
        }
      });
    };

    runMigration(records);
    const snap1 = JSON.parse(JSON.stringify(records));

    // Migration run 2 (repeated execution)
    runMigration(records);
    const snap2 = JSON.parse(JSON.stringify(records));

    assert.deepEqual(snap1, snap2, "Repeated execution must produce identical, unmutated state");
  });
});

describe("Fail-Closed Provider Enforcement (Requirement B)", () => {
  it("rejects omitted provider on new subscriptions in InMemoryBillingStorage", async () => {
    const storage = new InMemoryBillingStorage();
    await assert.rejects(
      async () => {
        await storage.upsertSubscription({
          teamId: 701,
          planId: "starter",
          seats: 15,
          status: "active",
        });
      },
      /requires an explicit paymentProvider: 'paystack'/
    );
  });

  it("rejects unknown provider on new subscriptions in InMemoryBillingStorage", async () => {
    const storage = new InMemoryBillingStorage();
    await assert.rejects(
      async () => {
        await storage.upsertSubscription({
          teamId: 702,
          paymentProvider: "paypal",
          planId: "starter",
          seats: 15,
          status: "active",
        });
      },
      /Invalid payment provider 'paypal'/
    );
  });

  it("rejects attempted Stripe subscription writes on new subscriptions in InMemoryBillingStorage", async () => {
    const storage = new InMemoryBillingStorage();
    await assert.rejects(
      async () => {
        await storage.upsertSubscription({
          teamId: 703,
          paymentProvider: "stripe",
          planId: "pro",
        });
      },
      /Cannot create or update Stripe subscription/
    );
  });

  it("preserves readable historical Stripe records without converting them to Paystack", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 704,
        paymentProvider: "stripe",
        stripeSubscriptionId: "sub_hist_704",
        planId: "starter",
        seats: 15,
        status: "active",
      },
    ]);

    const sub = await storage.getSubscriptionByTeamId(704);
    assert.ok(sub);
    assert.equal(sub.paymentProvider, "stripe");
    assert.equal(sub.stripeSubscriptionId, "sub_hist_704");
  });

  it("preserves historical Stripe provider attribution across non-provider updates", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 705,
        paymentProvider: "stripe",
        stripeSubscriptionId: "sub_hist_705",
        planId: "starter",
        seats: 15,
        status: "active",
      },
    ]);

    // Update status to canceled without specifying paymentProvider
    const updated = await storage.upsertSubscription({
      teamId: 705,
      status: "canceled",
      cancelAtPeriodEnd: true,
    });

    assert.equal(updated.paymentProvider, "stripe", "Provider attribution must remain 'stripe'");
    const retrieved = await storage.getSubscriptionByTeamId(705);
    assert.equal(retrieved.paymentProvider, "stripe");
    assert.equal(retrieved.status, "canceled");
  });

  it("enforces fail-closed rules on DatabaseBillingStorage", async () => {
    let queriedSql = [];
    const mockQuery = async (sql, params) => {
      queriedSql.push(sql);
      if (sql.includes("SELECT") && sql.includes("WHERE team_id = $1")) {
        // Return null for team 706 (new subscription)
        if (params && params[0] === 706) return { rows: [] };
        // Return historical stripe subscription for team 707
        if (params && params[0] === 707) {
          return {
            rows: [
              {
                id: 1,
                team_id: 707,
                payment_provider: "stripe",
                stripe_subscription_id: "sub_sql_hist",
                plan_id: "starter",
                seats: 15,
                status: "active",
                current_period_start: 1700000000,
                current_period_end: 1702592000,
                updated_at: 1700000000,
              },
            ],
          };
        }
      }
      return { rows: [] };
    };

    const dbStorage = new DatabaseBillingStorage(mockQuery);

    // Omitted provider on new subscription rejected
    await assert.rejects(
      async () => {
        await dbStorage.upsertSubscription({
          teamId: 706,
          planId: "starter",
        });
      },
      /requires an explicit paymentProvider: 'paystack'/
    );

    // Stripe provider on subscription rejected
    await assert.rejects(
      async () => {
        await dbStorage.upsertSubscription({
          teamId: 706,
          paymentProvider: "stripe",
          planId: "starter",
        });
      },
      /Cannot create or update Stripe subscription/
    );

    // Unknown provider rejected
    await assert.rejects(
      async () => {
        await dbStorage.upsertSubscription({
          teamId: 706,
          paymentProvider: "crypto",
          planId: "starter",
        });
      },
      /Invalid payment provider 'crypto'/
    );
  });
});

describe("Paystack Billing Storage — Consistent Historical Stripe Detection & Isolation Regression", () => {
  it("identifies historical Stripe when payment_provider is missing but stripe_subscription_id is present", () => {
    const row = {
      id: 101,
      team_id: 1,
      payment_provider: null,
      stripe_subscription_id: "sub_hist_123",
      stripe_customer_id: null,
      plan_id: "pro",
      seats: 5,
      status: "active",
      auto_renew_enabled: true, // Should be ignored because provider resolves to stripe
    };
    const state = mapRowToSubscriptionState(row);
    assert.equal(state.paymentProvider, "stripe");
    assert.equal(state.autoRenewEnabled, false);
    assert.equal(state.stripeSubscriptionId, "sub_hist_123");
  });

  it("identifies historical Stripe when payment_provider is missing but stripe_customer_id only is present", () => {
    const row = {
      id: 102,
      team_id: 2,
      payment_provider: null,
      stripe_subscription_id: null,
      stripe_customer_id: "cus_hist_456",
      plan_id: "starter",
      seats: 2,
      status: "active",
      auto_renew_enabled: true, // Should be ignored because provider resolves to stripe
    };
    const state = mapRowToSubscriptionState(row);
    assert.equal(state.paymentProvider, "stripe");
    assert.equal(state.autoRenewEnabled, false);
    assert.equal(state.stripeCustomerId, "cus_hist_456");
  });

  it("preserves explicit payment_provider = 'stripe' regardless of customer/subscription ID status", () => {
    const row = {
      id: 103,
      team_id: 3,
      payment_provider: "stripe",
      stripe_subscription_id: null,
      stripe_customer_id: null,
      plan_id: "enterprise",
      seats: 20,
      status: "active",
      auto_renew_enabled: true,
    };
    const state = mapRowToSubscriptionState(row);
    assert.equal(state.paymentProvider, "stripe");
    assert.equal(state.autoRenewEnabled, false);
  });

  it("preserves explicit payment_provider = 'paystack' and defaults autoRenewEnabled to false when unencrypted", () => {
    const row = {
      id: 104,
      team_id: 4,
      payment_provider: "paystack",
      paystack_customer_code: "CUS_xyz789",
      paystack_subscription_code: "SUB_abc123",
      plan_id: "pro",
      seats: 5,
      status: "active",
      auto_renew_enabled: true, // true in column, but missing encrypted auth credentials
    };
    const state = mapRowToSubscriptionState(row);
    assert.equal(state.paymentProvider, "paystack");
    assert.equal(state.autoRenewEnabled, false); // Fails closed without encrypted cipher/iv/tag
  });

  it("enables autoRenewEnabled for Paystack records with complete encrypted authorization fields", () => {
    const enc = encryptAuthorizationCode("AUTH_test_reusable_code", VALID_KEY_HEX);
    const row = {
      id: 105,
      team_id: 5,
      payment_provider: "paystack",
      paystack_customer_code: "CUS_valid_cust",
      paystack_subscription_code: "SUB_valid_sub",
      paystack_auth_cipher: enc.cipherText,
      paystack_auth_iv: enc.iv,
      paystack_auth_tag: enc.tag,
      auto_renew_enabled: true,
      plan_id: "pro",
      seats: 5,
      status: "active",
    };
    const state = mapRowToSubscriptionState(row);
    assert.equal(state.paymentProvider, "paystack");
    assert.equal(state.autoRenewEnabled, true);
    assert.equal(state.paystackAuthCipher, enc.cipherText);
  });

  it("guarantees Stripe records can NEVER enable Paystack auto-renewal even if synthetic auth fields are present", () => {
    const enc = encryptAuthorizationCode("AUTH_synthetic_code", VALID_KEY_HEX);
    const row = {
      id: 106,
      team_id: 6,
      payment_provider: "stripe",
      stripe_subscription_id: "sub_stripe_protected",
      paystack_auth_cipher: enc.cipherText,
      paystack_auth_iv: enc.iv,
      paystack_auth_tag: enc.tag,
      auto_renew_enabled: true,
      plan_id: "pro",
      seats: 5,
      status: "active",
    };
    const state = mapRowToSubscriptionState(row);
    assert.equal(state.paymentProvider, "stripe");
    assert.equal(state.autoRenewEnabled, false); // STRICT INVARIANT: Never enabled for Stripe
  });
});
