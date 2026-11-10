/**
 * Rota — Paystack Staging Environment & Safety Invariant Verification Script
 *
 * Verifies all staging environment variables and schema invariants WITHOUT
 * displaying secret values, passwords, or full credentials.
 */

import fs from "node:fs";
import path from "node:path";
import {
  parseEnvContent,
  extractHostname,
  extractDatabaseName,
  sanitizeTargetHost,
  EXPECTED_STAGING_HOSTNAME,
  FORBIDDEN_PRODUCTION_HOSTNAME,
  assertStagingDatabaseTarget,
} from "./db-target-guard.mjs";

const ENV_FILE = process.env.STAGING_ENV_FILE || ".env.billing-staging.local";

export function auditStagingEnvironment(envContent) {
  const env = parseEnvContent(envContent);
  const report = {
    envFile: ENV_FILE,
    variables: {},
    safetyPass: true,
    blockers: [],
    warnings: [],
  };

  // 1. DATABASE_URL
  const dbUrl = env.DATABASE_URL || "";
  const dbHost = extractHostname(dbUrl);
  const dbName = extractDatabaseName(dbUrl);

  if (!dbUrl) {
    report.safetyPass = false;
    report.variables.DATABASE_URL = { status: "MISSING", secureNote: "DATABASE_URL is not set" };
    report.blockers.push("DATABASE_URL is missing in staging environment file.");
  } else if (dbHost === FORBIDDEN_PRODUCTION_HOSTNAME) {
    report.safetyPass = false;
    report.variables.DATABASE_URL = {
      status: "FATAL_PRODUCTION_DETECTED",
      secureNote: "Target matches FORBIDDEN production host!",
    };
    report.blockers.push("DATABASE_URL points to FORBIDDEN PRODUCTION database!");
  } else if (dbHost !== EXPECTED_STAGING_HOSTNAME) {
    report.safetyPass = false;
    report.variables.DATABASE_URL = {
      status: "INVALID_TARGET",
      secureNote: `Target '${sanitizeTargetHost(dbHost)}' does not match expected staging host`,
    };
    report.blockers.push(`DATABASE_URL host does not match expected staging branch: ${sanitizeTargetHost(EXPECTED_STAGING_HOSTNAME)}`);
  } else if (dbName.toLowerCase() !== "neondb") {
    report.safetyPass = false;
    report.variables.DATABASE_URL = {
      status: "INVALID_DB",
      secureNote: `Database '${dbName}' is not 'neondb'`,
    };
    report.blockers.push("Database name is not 'neondb'");
  } else {
    report.variables.DATABASE_URL = {
      status: "VALID_STAGING",
      secureNote: `Verified staging target: ${sanitizeTargetHost(dbHost)} (database: ${dbName})`,
    };
  }

  // 2. BILLING_STORAGE
  const storage = env.BILLING_STORAGE || "";
  if (storage === "database") {
    report.variables.BILLING_STORAGE = {
      status: "VALID",
      secureNote: "Configured as 'database' (PostgreSQL persistence enabled)",
    };
  } else {
    report.variables.BILLING_STORAGE = {
      status: "WARNING",
      secureNote: `Set to '${storage || "unspecified"}', expected 'database' for full persistence`,
    };
    report.warnings.push("BILLING_STORAGE should be explicitly set to 'database'");
  }

  // 3. AUTH_SECRET
  const authSecret = env.AUTH_SECRET || "";
  if (!authSecret) {
    report.safetyPass = false;
    report.variables.AUTH_SECRET = { status: "MISSING", secureNote: "Missing session auth secret" };
    report.blockers.push("AUTH_SECRET is required for authenticated sessions");
  } else if (authSecret.length < 32) {
    report.variables.AUTH_SECRET = {
      status: "WARNING",
      secureNote: `Configured (${authSecret.length} chars, recommend >= 32 chars)`,
    };
    report.warnings.push("AUTH_SECRET should be >= 32 characters for security");
  } else {
    report.variables.AUTH_SECRET = {
      status: "CONFIGURED",
      secureNote: `Configured (${authSecret.length} chars)`,
    };
  }

  // 4. PAYSTACK_SECRET_KEY
  const pstkSecret = (env.PAYSTACK_SECRET_KEY || "").trim();
  if (!pstkSecret) {
    report.safetyPass = false;
    report.variables.PAYSTACK_SECRET_KEY = { status: "MISSING", secureNote: "Not configured" };
    report.blockers.push("PAYSTACK_SECRET_KEY is missing");
  } else if (pstkSecret.startsWith("sk_live_")) {
    report.safetyPass = false;
    report.variables.PAYSTACK_SECRET_KEY = {
      status: "FATAL_LIVE_KEY_DETECTED",
      secureNote: "STRICT VIOLATION: Live production key detected!",
    };
    report.blockers.push("FATAL: Live Paystack secret key detected in staging! Only sk_test_ keys allowed.");
  } else if (pstkSecret.includes("placeholder")) {
    report.variables.PAYSTACK_SECRET_KEY = {
      status: "PLACEHOLDER",
      secureNote: "Configured with test placeholder (requires operator's actual sk_test_ key before gateway call)",
    };
    report.warnings.push("PAYSTACK_SECRET_KEY is currently a placeholder. Gateway calls will fail until actual sk_test_ key is provided.");
  } else if (pstkSecret.startsWith("sk_test_")) {
    report.variables.PAYSTACK_SECRET_KEY = {
      status: "CONFIGURED_TEST",
      secureNote: `Configured test secret key (prefix: sk_test_, length: ${pstkSecret.length} chars)`,
    };
  } else {
    report.safetyPass = false;
    report.variables.PAYSTACK_SECRET_KEY = {
      status: "INVALID_PREFIX",
      secureNote: "Must start with 'sk_test_'",
    };
    report.blockers.push("PAYSTACK_SECRET_KEY must start with 'sk_test_'");
  }

  // 5. PAYSTACK_PUBLIC_KEY
  const pstkPublic = (env.PAYSTACK_PUBLIC_KEY || "").trim();
  if (!pstkPublic) {
    report.safetyPass = false;
    report.variables.PAYSTACK_PUBLIC_KEY = { status: "MISSING", secureNote: "Not configured" };
    report.blockers.push("PAYSTACK_PUBLIC_KEY is missing");
  } else if (pstkPublic.startsWith("pk_live_")) {
    report.safetyPass = false;
    report.variables.PAYSTACK_PUBLIC_KEY = {
      status: "FATAL_LIVE_KEY_DETECTED",
      secureNote: "STRICT VIOLATION: Live production key detected!",
    };
    report.blockers.push("FATAL: Live Paystack public key detected in staging! Only pk_test_ keys allowed.");
  } else if (pstkPublic.includes("placeholder")) {
    report.variables.PAYSTACK_PUBLIC_KEY = {
      status: "PLACEHOLDER",
      secureNote: "Configured with test placeholder (requires operator's actual pk_test_ key before gateway call)",
    };
    report.warnings.push("PAYSTACK_PUBLIC_KEY is currently a placeholder. Inline checkout requires actual pk_test_ key.");
  } else if (pstkPublic.startsWith("pk_test_")) {
    report.variables.PAYSTACK_PUBLIC_KEY = {
      status: "CONFIGURED_TEST",
      secureNote: `Configured test public key (prefix: pk_test_, length: ${pstkPublic.length} chars)`,
    };
  } else {
    report.safetyPass = false;
    report.variables.PAYSTACK_PUBLIC_KEY = {
      status: "INVALID_PREFIX",
      secureNote: "Must start with 'pk_test_'",
    };
    report.blockers.push("PAYSTACK_PUBLIC_KEY must start with 'pk_test_'");
  }

  // 6. PAYSTACK_AUTH_ENCRYPTION_KEY
  const encKey = (env.PAYSTACK_AUTH_ENCRYPTION_KEY || "").trim();
  const hex64Regex = /^[0-9a-fA-F]{64}$/;
  if (!encKey) {
    report.safetyPass = false;
    report.variables.PAYSTACK_AUTH_ENCRYPTION_KEY = {
      status: "MISSING",
      secureNote: "Required for AES-256-GCM encryption of reusable authorization tokens",
    };
    report.blockers.push("PAYSTACK_AUTH_ENCRYPTION_KEY is missing");
  } else if (!hex64Regex.test(encKey)) {
    report.safetyPass = false;
    report.variables.PAYSTACK_AUTH_ENCRYPTION_KEY = {
      status: "INVALID_FORMAT",
      secureNote: `Invalid key format: expected exactly 64 hex characters (got ${encKey.length})`,
    };
    report.blockers.push("PAYSTACK_AUTH_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes)");
  } else {
    report.variables.PAYSTACK_AUTH_ENCRYPTION_KEY = {
      status: "CONFIGURED_VALID",
      secureNote: "Valid 256-bit AES hex key (64 hex characters / 32 bytes)",
    };
  }

  // 7. CRON_SECRET
  const cronSecret = (env.CRON_SECRET || "").trim();
  if (!cronSecret) {
    report.safetyPass = false;
    report.variables.CRON_SECRET = {
      status: "MISSING",
      secureNote: "Required for authenticating off-session renewal trigger",
    };
    report.blockers.push("CRON_SECRET is missing");
  } else {
    report.variables.CRON_SECRET = {
      status: "CONFIGURED",
      secureNote: `Configured (${cronSecret.length} chars)`,
    };
  }

  // 8. NEXT_PUBLIC_APP_URL
  const appUrl = (env.NEXT_PUBLIC_APP_URL || "").trim();
  if (!appUrl) {
    report.variables.NEXT_PUBLIC_APP_URL = {
      status: "MISSING",
      secureNote: "Defaults to http://127.0.0.1:3000",
    };
    report.warnings.push("NEXT_PUBLIC_APP_URL is not set; will default to local host");
  } else {
    try {
      const parsedUrl = new URL(appUrl);
      report.variables.NEXT_PUBLIC_APP_URL = {
        status: "CONFIGURED",
        secureNote: `Origin: ${parsedUrl.origin} (${parsedUrl.protocol === "https:" ? "HTTPS public/tunnel" : "HTTP local"})`,
      };
    } catch {
      report.variables.NEXT_PUBLIC_APP_URL = {
        status: "INVALID_URL",
        secureNote: "Malformed URL",
      };
      report.warnings.push("NEXT_PUBLIC_APP_URL is not a valid URL");
    }
  }

  return report;
}

async function verifyStagingDatabaseSchema(databaseUrl) {
  assertStagingDatabaseTarget(databaseUrl);
  const { Client } = await import("@neondatabase/serverless");
  const client = new Client(databaseUrl);

  try {
    await client.connect();

    // Query information_schema for columns in workspace_subscriptions
    const { rows } = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'workspace_subscriptions'
      ORDER BY column_name;
    `);

    const existingColumns = new Set(rows.map((r) => r.column_name));
    const requiredPaystackColumns = [
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
    ];

    const missingColumns = requiredPaystackColumns.filter((col) => !existingColumns.has(col));

    // Verify indexes
    const idxRes = await client.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'workspace_subscriptions';
    `);
    const existingIndexes = new Set(idxRes.rows.map((r) => r.indexname));
    const requiredIndexes = [
      "idx_ws_paystack_cust",
      "idx_ws_renewal_queue",
      "idx_ws_lease_recovery",
    ];
    const missingIndexes = requiredIndexes.filter((idx) => !existingIndexes.has(idx));

    return {
      connected: true,
      totalColumns: rows.length,
      paystackColumnsVerified: requiredPaystackColumns.length - missingColumns.length,
      missingColumns,
      missingIndexes,
    };
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

async function main() {
  console.log("==================================================================");
  console.log("Rota — Paystack Staging Environment Verification");
  console.log("==================================================================");

  const resolvedPath = path.resolve(process.cwd(), ENV_FILE);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`ERROR: Environment file '${ENV_FILE}' not found at ${resolvedPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolvedPath, "utf-8");
  const report = auditStagingEnvironment(content);

  console.log(`\nInspecting: ${ENV_FILE}`);
  console.log("------------------------------------------------------------------");
  for (const [varName, info] of Object.entries(report.variables)) {
    console.log(`  ${varName.padEnd(30)} : [${info.status}] ${info.secureNote}`);
  }
  console.log("------------------------------------------------------------------");

  if (report.warnings.length > 0) {
    console.log("\nWarnings / Operator Action Items:");
    for (const w of report.warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (report.blockers.length > 0) {
    console.log("\nBlocking Safety / Configuration Issues:");
    for (const b of report.blockers) {
      console.log(`  [BLOCKER] ${b}`);
    }
    process.exit(1);
  }

  // Verify staging DB connection and schema
  console.log("\nVerifying Staging Database Schema Invariants...");
  const env = parseEnvContent(content);
  try {
    const dbReport = await verifyStagingDatabaseSchema(env.DATABASE_URL);
    console.log(`  Connection Status           : [CONNECTED] To isolated Neon staging branch`);
    console.log(`  Paystack Columns Verified   : ${dbReport.paystackColumnsVerified}/21 columns active`);
    if (dbReport.missingColumns.length > 0) {
      console.error(`  Missing Columns             : ${dbReport.missingColumns.join(", ")}`);
      process.exit(1);
    }
    if (dbReport.missingIndexes.length > 0) {
      console.error(`  Missing Indexes             : ${dbReport.missingIndexes.join(", ")}`);
      process.exit(1);
    }
    console.log(`  Queue & Performance Indexes : All 3 indexes active (cust, renewal queue, lease recovery)`);
    console.log("\n>> STAGING ENVIRONMENT IS FULLY PREPARED AND SAFE <<");
    console.log("Zero credentials or secret values were exposed.");
  } catch (err) {
    console.error(`\nDatabase verification failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("verify-paystack-staging-env.mjs")) {
  main().catch((err) => {
    console.error("Verification execution error:", err.message);
    process.exit(1);
  });
}
