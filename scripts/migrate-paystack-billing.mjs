/**
 * Paystack Billing Schema Migration Script
 *
 * Safety & Transaction Guarantees:
 * 1. Dry-run mode by default. Exits without connecting to any database unless `--run` is explicitly passed.
 * 2. Requires exact `--confirm-target <db>` and `--confirm-endpoint <host>` before opening any network connection.
 * 3. All schema DDL statements execute inside ONE explicit transaction (`BEGIN` ... `COMMIT`).
 * 4. Additive & Non-Destructive: Preserves all existing Stripe columns, Stripe data, billing events,
 *    and financial ledger records completely untouched.
 * 5. Safe to rerun: Uses ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS throughout.
 * 6. Connection cleanup is guaranteed via a `finally` block (`client.end()`).
 * 7. Never prints database credentials, tokens, or raw connection strings.
 */

import {
  loadDatabaseUrlFromEnv,
  validateDatabaseTarget,
  assertStagingDatabaseTarget,
  parseTargetCliArgs,
  sanitizeTargetHost,
  sanitizeErrorMessage,
  EXPECTED_STAGING_HOSTNAME,
  FORBIDDEN_PRODUCTION_HOSTNAME,
} from "./db-target-guard.mjs";

export {
  loadDatabaseUrlFromEnv,
  validateDatabaseTarget,
  assertStagingDatabaseTarget,
  parseTargetCliArgs,
  sanitizeTargetHost,
  sanitizeErrorMessage,
  EXPECTED_STAGING_HOSTNAME,
  FORBIDDEN_PRODUCTION_HOSTNAME,
};

export const PAYSTACK_MIGRATION_DDL = `
-- 1. Additive extension to workspace_subscriptions table
ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50);

-- Explicitly attribute historical Stripe records (those with stripe_subscription_id) to 'stripe' without rewriting them
UPDATE workspace_subscriptions
SET payment_provider = 'stripe'
WHERE (stripe_subscription_id IS NOT NULL OR stripe_customer_id IS NOT NULL)
  AND payment_provider IS NULL;

-- Default all remaining and future records to 'paystack'
UPDATE workspace_subscriptions
SET payment_provider = 'paystack'
WHERE payment_provider IS NULL;

ALTER TABLE workspace_subscriptions
  ALTER COLUMN payment_provider SET NOT NULL,
  ALTER COLUMN payment_provider SET DEFAULT 'paystack';

ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS paystack_customer_code VARCHAR(255),
  ADD COLUMN IF NOT EXISTS paystack_subscription_code VARCHAR(255),
  ADD COLUMN IF NOT EXISTS paystack_auth_cipher TEXT,
  ADD COLUMN IF NOT EXISTS paystack_auth_iv VARCHAR(64),
  ADD COLUMN IF NOT EXISTS paystack_auth_tag VARCHAR(64),
  ADD COLUMN IF NOT EXISTS auto_renew_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS card_brand VARCHAR(50),
  ADD COLUMN IF NOT EXISTS card_last4 VARCHAR(10),
  ADD COLUMN IF NOT EXISTS card_exp_month INTEGER,
  ADD COLUMN IF NOT EXISTS card_exp_year INTEGER,
  ADD COLUMN IF NOT EXISTS card_bank VARCHAR(100),
  ADD COLUMN IF NOT EXISTS billing_anchor_day INTEGER CHECK (billing_anchor_day BETWEEN 1 AND 31),
  ADD COLUMN IF NOT EXISTS renewal_lease_token UUID,
  ADD COLUMN IF NOT EXISTS renewal_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_period_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_plan_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS scheduled_seats INTEGER,
  ADD COLUMN IF NOT EXISTS last_reconciliation_ref VARCHAR(255);

-- Ensure auto_renew_enabled default is explicitly FALSE if column previously existed with DEFAULT TRUE
ALTER TABLE workspace_subscriptions
  ALTER COLUMN auto_renew_enabled SET DEFAULT FALSE;

-- Ensure all non-Paystack subscriptions and subscriptions without valid encrypted auth have auto_renew_enabled = FALSE
UPDATE workspace_subscriptions
SET auto_renew_enabled = FALSE
WHERE payment_provider != 'paystack'
   OR paystack_auth_cipher IS NULL
   OR paystack_auth_iv IS NULL
   OR paystack_auth_tag IS NULL;

-- 2. Performance and queue coordination indexes
CREATE INDEX IF NOT EXISTS idx_ws_paystack_cust
  ON workspace_subscriptions(paystack_customer_code);

CREATE INDEX IF NOT EXISTS idx_ws_renewal_queue
  ON workspace_subscriptions(status, current_period_end, next_retry_at)
  WHERE payment_provider = 'paystack' AND auto_renew_enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_ws_lease_recovery
  ON workspace_subscriptions(renewal_lease_expires_at)
  WHERE renewal_lease_token IS NOT NULL;
`;

export const PAYSTACK_ROLLBACK_PLAN_SQL = `
-- =========================================================================================
-- PAYSTACK SCHEMA ROLLBACK POLICY & OPERATOR SAFETY GUIDELINES
-- =========================================================================================
--
-- CRITICAL SAFETY WARNING:
-- Dropping Paystack columns or payment_provider is NOT a safe rollback after Paystack billing
-- data has been written. Executing destructive DROP COLUMN statements against an active database
-- permanently destroys:
--   1. Provider attribution ('payment_provider') separating Stripe vs Paystack workspaces.
--   2. Customer and subscription identifiers ('paystack_customer_code', 'paystack_subscription_code').
--   3. AES-256-GCM encrypted authorizations and security tags ('paystack_auth_cipher', 'paystack_auth_iv', 'paystack_auth_tag').
--   4. Recurring renewal engine leases and scheduling state ('auto_renew_enabled', 'renewal_lease_*', 'next_retry_at', 'grace_period_expires_at').
--   5. Gateway idempotency and audit references ('last_reconciliation_ref').
--
-- -----------------------------------------------------------------------------------------
-- OPERATIONAL DISTINCTION: PRE-ACTIVATION VS POST-ACTIVATION
-- -----------------------------------------------------------------------------------------
-- SCENARIO A: PRE-ACTIVATION SCHEMA ROLLBACK (SAFE ONLY BEFORE BILLING ACTIVITY)
--   Applicable ONLY if the migration has run, but NO Paystack billing activity has occurred
--   (i.e., all Paystack customer codes, subscription codes, authorizations, and ledger
--   transactions remain NULL / unpopulated).
--   Under this condition only, dropping the added columns safely reverts the schema to the Stage 3 baseline.
--
-- SCENARIO B: POST-ACTIVATION RECOVERY (DESTRUCTIVE COLUMN DROPPING STRICTLY PROHIBITED)
--   If ANY Paystack billing data, customer code, subscription, or encrypted authorization exists,
--   destructive schema rollback (dropping columns) is STRICTLY PROHIBITED unless a separately
--   verified recovery plan preserves all affected data.
--   MANDATED POST-ACTIVATION ACTION:
--   1. Restore from a verified point-in-time backup or branch snapshot (e.g. prod-backup-pre-migration-20261104), OR
--   2. Deploy an operator-reviewed forward-fix (such as disabling renewals with auto_renew_enabled = FALSE
--      or hotfixing application code) while preserving all historical payment and authorization records intact.
--
-- =========================================================================================
-- SQL FOR PRE-ACTIVATION SCHEMA ROLLBACK ONLY (ZERO PAYSTACK BILLING DATA WRITTEN)
-- =========================================================================================
ALTER TABLE workspace_subscriptions
  DROP COLUMN IF EXISTS last_reconciliation_ref,
  DROP COLUMN IF EXISTS scheduled_seats,
  DROP COLUMN IF EXISTS scheduled_plan_id,
  DROP COLUMN IF EXISTS grace_period_expires_at,
  DROP COLUMN IF EXISTS next_retry_at,
  DROP COLUMN IF EXISTS retry_count,
  DROP COLUMN IF EXISTS renewal_lease_expires_at,
  DROP COLUMN IF EXISTS renewal_lease_token,
  DROP COLUMN IF EXISTS billing_anchor_day,
  DROP COLUMN IF EXISTS card_bank,
  DROP COLUMN IF EXISTS card_exp_year,
  DROP COLUMN IF EXISTS card_exp_month,
  DROP COLUMN IF EXISTS card_last4,
  DROP COLUMN IF EXISTS card_brand,
  DROP COLUMN IF EXISTS auto_renew_enabled,
  DROP COLUMN IF EXISTS paystack_auth_tag,
  DROP COLUMN IF EXISTS paystack_auth_iv,
  DROP COLUMN IF EXISTS paystack_auth_cipher,
  DROP COLUMN IF EXISTS paystack_subscription_code,
  DROP COLUMN IF EXISTS paystack_customer_code,
  DROP COLUMN IF EXISTS payment_provider;
`;

export function printPaystackDryRunNotice() {
  console.log("==================================================================");
  console.log("Rota — Paystack Billing Schema Migration (DRY-RUN / PREVIEW MODE)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero database writes executed.");
  console.log("To execute against the staging database, supply all required flags:");
  console.log("  --run");
  console.log("  --confirm-target neondb");
  console.log("  --confirm-endpoint ep-quiet-mode-b5gula0k-pooler.c-7.us-east-2.aws.neon.tech\n");
  console.log("To execute against the production database, supply all required flags:");
  console.log("  --run");
  console.log("  --allow-production");
  console.log("  --confirm-target neondb");
  console.log("  --confirm-endpoint ep-lingering-bread-b5kncjhq-pooler.c-7.us-east-2.aws.neon.tech\n");
  console.log("Planned Additive Schema DDL:");
  console.log(PAYSTACK_MIGRATION_DDL);
  console.log("Preservation Guarantees:");
  console.log("- Preserves all existing Stripe columns (stripe_customer_id, stripe_subscription_id).");
  console.log("- Preserves all existing subscription records, teams, shifts, and memberships.");
  console.log("- Preserves billing_events and billing_ledger tables untouched.");
  console.log("- Adds payment_provider identity ('paystack' default for new records, 'stripe' preserved for historical records).");
  console.log("- Adds encrypted authorization fields (cipher, iv, tag) for AES-256-GCM tokens.");
  console.log("- Adds lease coordination and retry backoff columns.\n");
  console.log("Guarded Rollback Documentation & Operational Recovery Policy:");
  console.log(PAYSTACK_ROLLBACK_PLAN_SQL);
  console.log("CRITICAL OPERATIONAL NOTICE:");
  console.log("- Pre-activation (0 Paystack records): DDL columns may be dropped to return to Stage 3 baseline.");
  console.log("- Post-activation (Paystack data exists): Dropping columns is STRICTLY PROHIBITED as it destroys");
  console.log("  authorizations, provider attribution, and renewal state. Restore from verified backup or forward-fix.");
  console.log("Notice: Hostname and database confirmation verifies operator intent, but does NOT");
  console.log("prove that a branch is disposable. Verify branch isolation in the Neon Console.");
  console.log("==================================================================");
}

/**
 * Pure CLI argument parser for migrate-paystack-billing.mjs
 */
export function parsePaystackMigrationArgs(argv = process.argv) {
  try {
    const { confirmTarget, confirmEndpoint, help, extraFlags } = parseTargetCliArgs(argv, {
      allowedFlags: ["--run", "--env-file", "--allow-production"],
      valuedFlags: ["--env-file"],
    });
    return {
      run: !!extraFlags["--run"],
      allowProduction: !!extraFlags["--allow-production"],
      envFile: typeof extraFlags["--env-file"] === "string" ? extraFlags["--env-file"] : null,
      confirmTarget,
      confirmEndpoint,
      help,
    };
  } catch (err) {
    return {
      error: err.message,
      run: false,
      allowProduction: false,
      envFile: null,
      confirmTarget: null,
      confirmEndpoint: null,
      help: false,
    };
  }
}

/**
 * Validates the database target for the Paystack billing migration.
 *
 * Guarantees:
 * - Default execution strictly rejects the production database.
 * - Explicit production execution requires --run, --allow-production, --confirm-target neondb,
 *   and --confirm-endpoint ep-lingering-bread-b5kncjhq-pooler.c-7.us-east-2.aws.neon.tech.
 * - Staging execution continues to work under its existing authorization rules.
 * - Reject target mismatches (e.g. --allow-production specified against staging endpoint).
 * - Reject unknown hostnames and unexpected database names.
 * - Never infers production authorization from NODE_ENV or DATABASE_URL.
 *
 * @param {object} params
 * @param {string} params.databaseUrl - Configured DATABASE_URL
 * @param {string} params.confirmTarget - Confirmed database name
 * @param {string} params.confirmEndpoint - Confirmed exact hostname
 * @param {boolean} [params.allowProduction=false] - Explicit production authorization flag
 * @returns {{ valid: boolean, targetType: 'staging' | 'production', hostname: string, database: string }}
 */
export function validatePaystackMigrationTarget({
  databaseUrl,
  confirmTarget,
  confirmEndpoint,
  allowProduction = false,
}) {
  const baseValidation = validateDatabaseTarget({
    databaseUrl,
    confirmTarget,
    confirmEndpoint,
  });

  const { hostname, database } = baseValidation;

  if (database.toLowerCase() !== "neondb") {
    throw new Error(
      `[SAFETY GUARD] Target database name '${database}' does not match expected target database 'neondb'. All operations aborted.`
    );
  }

  if (hostname === FORBIDDEN_PRODUCTION_HOSTNAME) {
    if (!allowProduction) {
      throw new Error(
        "[FATAL SAFETY STOP] Target database matches FORBIDDEN PRODUCTION hostname! All queries and operations aborted without explicit '--allow-production' authorization."
      );
    }
    return {
      valid: true,
      targetType: "production",
      hostname,
      database,
    };
  }

  if (hostname === EXPECTED_STAGING_HOSTNAME) {
    if (allowProduction) {
      throw new Error(
        "[SAFETY GUARD] Target database mismatch: '--allow-production' flag was specified, but the confirmed endpoint matches the STAGING hostname. Staging execution must not use '--allow-production'. All operations aborted."
      );
    }
    return {
      valid: true,
      targetType: "staging",
      hostname,
      database,
    };
  }

  throw new Error(
    `[SAFETY GUARD] Target database hostname '${sanitizeTargetHost(hostname)}' is neither the approved staging branch nor the authorized production database. All operations aborted.`
  );
}

/**
 * Executes the Paystack billing schema migration inside a single database transaction.
 *
 * @param {object} client - Database client with query(sql, params)
 * @returns {Promise<{success: boolean, columnsAdded: string[], indexesCreated: string[]}>}
 */
export async function executePaystackBillingMigration(client) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client with query() method is required.");
  }

  let commitAttempted = false;
  let commitSucceeded = false;

  try {
    await client.query("BEGIN;");

    // Execute additive DDL
    await client.query(PAYSTACK_MIGRATION_DDL);

    commitAttempted = true;
    await client.query("COMMIT;");
    commitSucceeded = true;

    return {
      success: true,
      columnsAdded: [
        "payment_provider",
        "paystack_customer_code",
        "paystack_subscription_code",
        "paystack_auth_cipher",
        "paystack_auth_iv",
        "paystack_auth_tag",
        "auto_renew_enabled",
        "card_brand",
        "card_last4",
        "card_exp_month",
        "card_exp_year",
        "card_bank",
        "billing_anchor_day",
        "renewal_lease_token",
        "renewal_lease_expires_at",
        "retry_count",
        "next_retry_at",
        "grace_period_expires_at",
        "scheduled_plan_id",
        "scheduled_seats",
        "last_reconciliation_ref",
      ],
      indexesCreated: [
        "idx_ws_paystack_cust",
        "idx_ws_renewal_queue",
        "idx_ws_lease_recovery",
      ],
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
    throw new Error(`Paystack billing migration failed and was rolled back: ${sanitized}`);
  }
}

async function main() {
  const args = parsePaystackMigrationArgs(process.argv);

  if (args.help || !args.run) {
    printPaystackDryRunNotice();
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

  const databaseUrl = loadDatabaseUrlFromEnv(args.envFile);
  if (!databaseUrl) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
  }

  let target;
  try {
    target = validatePaystackMigrationTarget({
      databaseUrl,
      confirmTarget: args.confirmTarget,
      confirmEndpoint: args.confirmEndpoint,
      allowProduction: args.allowProduction,
    });
  } catch (valErr) {
    console.error("Safety guard error:", sanitizeErrorMessage(valErr.message));
    process.exit(1);
  }

  // Dynamic import of Neon client only after validation passes
  const { Client } = await import("@neondatabase/serverless");
  const client = new Client(databaseUrl);

  try {
    await client.connect();
    const result = await executePaystackBillingMigration(client);
    console.log("Paystack billing schema migration applied successfully!");
    console.log(`Target type: ${target.targetType.toUpperCase()}`);
    console.log(`Target database: ${args.confirmTarget}`);
    console.log(`Target endpoint: ${sanitizeTargetHost(args.confirmEndpoint)}`);
    console.log(`Columns added/verified (${result.columnsAdded.length}): ${result.columnsAdded.join(", ")}`);
    console.log(`Indexes created/verified (${result.indexesCreated.length}): ${result.indexesCreated.join(", ")}`);
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

if (process.argv[1] && process.argv[1].endsWith("migrate-paystack-billing.mjs")) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
