/**
 * Billing Persistence Schema Migration Script
 *
 * Safety & Transaction Guarantees:
 * 1. Dry-run mode by default. Exits without connecting to any database unless `--run` is explicitly passed.
 * 2. Requires exact `--run` CLI flag before opening any database connection or write operation.
 * 3. All schema DDL statements execute on one database connection inside ONE explicit transaction (`BEGIN` ... `COMMIT`).
 * 4. Structural Schema Migration: Creates workspace_subscriptions, billing_events, and billing_ledger tables
 *    relationally tied to teams(id).
 * 5. Preserves all existing users, workspaces, shifts, and memberships completely untouched.
 * 6. On statement failure, attempts a rollback using the same connection before re-throwing the original sanitized error.
 * 7. On ambiguous commit failures (network failure during COMMIT), instructs operator to inspect database state.
 * 8. Connection cleanup is guaranteed via a `finally` block (`client.end()`).
 * 9. Does NOT include destructive automatic rollback commands (documented for manual operator execution only).
 * 10. Never prints database credentials, tokens, or raw connection strings.
 */

import {
  loadDatabaseUrlFromEnv,
  validateDatabaseTarget,
  parseTargetCliArgs,
  sanitizeTargetHost,
  sanitizeErrorMessage,
} from "./db-target-guard.mjs";

export {
  loadDatabaseUrlFromEnv,
  validateDatabaseTarget,
  parseTargetCliArgs,
  sanitizeTargetHost,
  sanitizeErrorMessage,
};

// DDL Migration Statements
export const MIGRATION_DDL = `
-- 1. Create workspace_subscriptions table
-- Relational invariant: team_id is INTEGER UNIQUE NOT NULL REFERENCES teams(id)
CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id SERIAL PRIMARY KEY,
  team_id INTEGER UNIQUE NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255) UNIQUE,
  plan_id VARCHAR(50) NOT NULL DEFAULT 'free',
  seats INTEGER NOT NULL DEFAULT 5,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create billing_events table for durable webhook idempotency
-- Relational invariant: event_id is VARCHAR UNIQUE NOT NULL
CREATE TABLE IF NOT EXISTS billing_events (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  status VARCHAR(50) NOT NULL,
  payload JSONB,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create billing_ledger table for immutable payment history
-- Relational invariant: transaction_id is VARCHAR UNIQUE NOT NULL
CREATE TABLE IF NOT EXISTS billing_ledger (
  id SERIAL PRIMARY KEY,
  transaction_id VARCHAR(255) UNIQUE NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  event_id VARCHAR(255) REFERENCES billing_events(event_id) ON DELETE SET NULL,
  type VARCHAR(50) NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'usd',
  status VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create performance & foreign-key lookup indexes
CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_team_id ON workspace_subscriptions(team_id);
CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_stripe_sub ON workspace_subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_event_id ON billing_events(event_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_team_id ON billing_events(team_id);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_team_id ON billing_ledger(team_id);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_transaction_id ON billing_ledger(transaction_id);
`;

// Guarded Rollback Plan (Documented for explicit manual operator execution only)
export const ROLLBACK_PLAN_SQL = `
-- GUARDED ROLLBACK PLAN
-- Execute only after backing up billing data and verifying persistence is to be reverted:
-- 1. DROP TABLE IF EXISTS billing_ledger;
-- 2. DROP TABLE IF EXISTS billing_events;
-- 3. DROP TABLE IF EXISTS workspace_subscriptions;
`;

export function printBillingDryRunNotice() {
  console.log("==================================================================");
  console.log("Rota — Durable Billing Persistence Migration (DRY-RUN / PREVIEW MODE)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero database writes executed.");
  console.log("To execute against the database, you must supply all required flags:");
  console.log("  --run");
  console.log("  --confirm-target <target_database_name>");
  console.log("  --confirm-endpoint <exact_hostname>\n");
  console.log("Planned Schema DDL:");
  console.log(MIGRATION_DDL);
  console.log("Preservation Guarantees:");
  console.log("- Preserves all existing users, teams, shifts, and team memberships.");
  console.log("- Foreign keys link directly to teams(id INTEGER).");
  console.log("- Enforces UNIQUE (team_id) on workspace_subscriptions to prevent duplicate plans.");
  console.log("- Enforces UNIQUE (event_id) on billing_events for cross-instance idempotency.");
  console.log("- Enforces UNIQUE (transaction_id) on billing_ledger for immutable charge history.\n");
  console.log("Guarded Rollback Documentation:");
  console.log(ROLLBACK_PLAN_SQL);
  console.log("Notice: Hostname and database confirmation verifies operator intent, but does NOT");
  console.log("prove that a branch is disposable or isolated. Verify branch status in the Neon Console.");
  console.log("==================================================================");
}

/**
 * Pure CLI argument parser for migrate-billing-persistence.mjs
 */
export function parseBillingMigrationArgs(argv = process.argv) {
  try {
    const { confirmTarget, confirmEndpoint, help, extraFlags } = parseTargetCliArgs(argv, {
      allowedFlags: ["--run"],
    });
    return {
      run: !!extraFlags["--run"],
      confirmTarget,
      confirmEndpoint,
      help,
    };
  } catch (err) {
    return {
      error: err.message,
      run: false,
      confirmTarget: null,
      confirmEndpoint: null,
      help: false,
    };
  }
}

/**
 * Executes the billing persistence schema migration inside a single database transaction.
 *
 * @param {object} client - Database client with query(sql, params) and optional end()
 * @returns {Promise<{success: boolean, tablesCreated: string[]}>}
 */
export async function executeBillingPersistenceMigration(client) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client with query() method is required.");
  }

  let commitAttempted = false;
  let commitSucceeded = false;

  try {
    await client.query("BEGIN;");

    // Execute structural DDL
    await client.query(MIGRATION_DDL);

    commitAttempted = true;
    await client.query("COMMIT;");
    commitSucceeded = true;

    return {
      success: true,
      tablesCreated: ["workspace_subscriptions", "billing_events", "billing_ledger"],
    };
  } catch (err) {
    if (commitAttempted && !commitSucceeded) {
      const sanitized = sanitizeErrorMessage(err.message);
      throw new Error(
        `AMBIGUOUS COMMIT FAILURE: Transaction COMMIT failed or was interrupted (${sanitized}). ` +
        `Do NOT automatically retry. Inspect database state to verify if schema changes committed.`
      );
    }

    try {
      await client.query("ROLLBACK;");
    } catch {
      // Rollback failure secondary
    }

    const sanitized = sanitizeErrorMessage(err.message);
    throw new Error(`Billing persistence migration failed and was rolled back: ${sanitized}`);
  }
}

async function main() {
  const args = parseBillingMigrationArgs(process.argv);

  if (args.help || !args.run) {
    printBillingDryRunNotice();
    process.exit(0);
  }

  if (args.error) {
    console.error(`Error: ${args.error}`);
    process.exit(1);
  }

  // Mandatory target confirmation checks
  if (!args.confirmTarget) {
    console.error("Error: '--confirm-target <database-name>' is required when running with --run.");
    process.exit(1);
  }

  if (!args.confirmEndpoint) {
    console.error("Error: '--confirm-endpoint <exact-hostname>' is required when running with --run.");
    process.exit(1);
  }

  const databaseUrl = loadDatabaseUrlFromEnv();
  if (!databaseUrl) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
  }

  try {
    validateDatabaseTarget({
      databaseUrl,
      confirmTarget: args.confirmTarget,
      confirmEndpoint: args.confirmEndpoint,
    });
  } catch (valErr) {
    console.error("Safety guard error:", sanitizeErrorMessage(valErr.message));
    process.exit(1);
  }

  // Dynamic import of Neon client only when --run and validation pass
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    const result = await executeBillingPersistenceMigration(client);
    console.log("Billing persistence migration applied successfully!");
    console.log(`Tables created/verified: ${result.tablesCreated.join(", ")}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate-billing-persistence.mjs")) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
