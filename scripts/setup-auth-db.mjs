/**
 * Authentication Database Setup & Verified Account Seeding Script
 *
 * Safety & Transaction Guarantees:
 * 1. Dry-run mode by default. Exits without connecting to any database unless '--run' is explicitly passed.
 * 2. Mandatory target confirmations: Requires BOTH '--confirm-target <name>' AND '--confirm-endpoint <host>'.
 * 3. Pre-connection validation: Validates database name and hostname BEFORE constructing any database client.
 * 4. Safe Insert-Only Seeding: Uses 'ON CONFLICT (email) DO NOTHING'. Never overwrites existing passwords,
 *    salts, names, or roles of previously provisioned accounts.
 * 5. Explicit Transaction: All operations execute within a single transaction ('BEGIN' ... 'COMMIT').
 *    Rolls back cleanly on any failure before committing.
 * 6. Connection cleanup: Guaranteed closure in 'finally' block.
 * 7. Zero Credential Exposure: Sanitizes all output and error logs.
 */

import crypto from "node:crypto";
import {
  loadDatabaseUrlFromEnv,
  validateDatabaseTarget,
  parseTargetCliArgs,
  sanitizeTargetHost,
  sanitizeErrorMessage,
} from "./db-target-guard.mjs";

export const INITIAL_AUTH_ACCOUNTS = [
  { email: "amara@rota.local", name: "Amara Okafor", role: "Front Desk" },
  { email: "daniel@rota.local", name: "Daniel James", role: "Operations" },
  { email: "sarah@rota.local", name: "Sarah Bello", role: "Customer Support" },
  { email: "david@rota.local", name: "David Musa", role: "Front Desk" },
  { email: "chika@rota.local", name: "Chika Nwosu", role: "Supervisor" },
];

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function printSetupNotice() {
  console.log("==================================================================");
  console.log("Rota — Authentication Database Setup (DRY-RUN / PREVIEW MODE)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero database writes executed.");
  console.log("To execute against the database, you must supply all required flags:");
  console.log("  --run");
  console.log("  --confirm-target <target_database_name>");
  console.log("  --confirm-endpoint <exact_hostname>\n");
  console.log("Example:");
  console.log("  node scripts/setup-auth-db.mjs --run --confirm-target neondb --confirm-endpoint ep-staging-123.us-east-2.aws.neon.tech\n");
  console.log("Planned Operations:");
  console.log("- Create 'users' table if not exists.");
  console.log("- Add nullable 'user_id' column to 'shifts' if not exists.");
  console.log("- Insert verified accounts (ON CONFLICT DO NOTHING — existing accounts are preserved):");
  INITIAL_AUTH_ACCOUNTS.forEach((acc) => console.log(`    • ${acc.email} (${acc.role})`));
  console.log("- Link existing shifts to user_id where employee_name matches.\n");
  console.log("Notice: Hostname and database confirmation verifies operator intent, but does NOT");
  console.log("prove that a branch is disposable or isolated. Verify branch status in the Neon Console.");
  console.log("==================================================================");
}

/**
 * Pure CLI argument parser for setup-auth-db.mjs
 */
export function parseSetupArgs(argv = process.argv) {
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
 * Executes authentication schema creation and verified account seeding transactionally.
 *
 * @param {object} client - Database client with query(sql, params) and optional end()
 * @param {object} options - Optional overrides (e.g. initialAccounts, seedPassword)
 * @returns {Promise<{success: boolean, accountsCreated: number, existingPreserved: number, shiftsLinked: number}>}
 */
export async function executeAuthDbSetup(client, options = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client with query() method is required.");
  }

  const accounts = options.initialAccounts || INITIAL_AUTH_ACCOUNTS;
  let commitAttempted = false;
  let commitSucceeded = false;

  try {
    await client.query("BEGIN;");

    // 1. Create users table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        password_salt VARCHAR(64) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. Add user_id to shifts if not exists
    await client.query(`
      ALTER TABLE shifts
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
    `);

    // 3. Insert accounts strictly with ON CONFLICT (email) DO NOTHING
    // This preserves existing accounts and never overwrites existing passwords/salts
    let accountsCreated = 0;
    let existingPreserved = 0;

    for (const user of accounts) {
      const rawPassword =
        options.seedPassword ||
        process.env.SEED_INITIAL_PASSWORD ||
        crypto.randomBytes(16).toString("hex");

      const { hash, salt } = hashPassword(rawPassword);

      const res = await client.query(
        `INSERT INTO users (email, password_hash, password_salt, name, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING
         RETURNING id;`,
        [user.email.toLowerCase().trim(), hash, salt, user.name, user.role]
      );

      if (res && res.rows && res.rows.length > 0) {
        accountsCreated++;
      } else {
        existingPreserved++;
      }
    }

    // 4. Link unassigned shifts to users based on matching employee_name
    const shiftLinkRes = await client.query(`
      UPDATE shifts s
      SET user_id = u.id
      FROM users u
      WHERE LOWER(TRIM(s.employee_name)) = LOWER(TRIM(u.name))
        AND s.user_id IS NULL;
    `);

    const shiftsLinked = shiftLinkRes?.rowCount ?? 0;

    commitAttempted = true;
    await client.query("COMMIT;");
    commitSucceeded = true;

    return {
      success: true,
      accountsCreated,
      existingPreserved,
      shiftsLinked,
    };
  } catch (err) {
    if (!commitSucceeded && !commitAttempted) {
      try {
        await client.query("ROLLBACK;");
      } catch (rbErr) {
        console.error("Rollback failed:", sanitizeErrorMessage(rbErr.message));
      }
    }
    throw err;
  } finally {
    if (client && typeof client.end === "function") {
      try {
        await client.end();
      } catch {}
    }
  }
}

// CLI execution block
if (process.argv[1] && process.argv[1].endsWith("setup-auth-db.mjs")) {
  const parsed = parseSetupArgs(process.argv);

  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    console.error("Usage: node scripts/setup-auth-db.mjs --run --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (parsed.help || !parsed.run) {
    printSetupNotice();
    process.exit(0);
  }

  if (!parsed.confirmTarget) {
    console.error("Error: '--confirm-target <database-name>' is required when running setup.");
    console.error("Usage: node scripts/setup-auth-db.mjs --run --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (!parsed.confirmEndpoint) {
    console.error("Error: '--confirm-endpoint <exact-hostname>' is required when running setup.");
    console.error("Usage: node scripts/setup-auth-db.mjs --run --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  const databaseUrl = loadDatabaseUrlFromEnv();
  if (!databaseUrl) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
  }

  // Pre-connection safety validation
  try {
    validateDatabaseTarget({
      databaseUrl,
      confirmTarget: parsed.confirmTarget,
      confirmEndpoint: parsed.confirmEndpoint,
    });
  } catch (valErr) {
    console.error("Safety guard error:", sanitizeErrorMessage(valErr.message));
    process.exit(1);
  }

  console.log("Connecting to target database for authentication setup...");
  console.log(`Target Host: ${sanitizeTargetHost(databaseUrl)}`);
  console.log(`Target Database: ${parsed.confirmTarget}\n`);

  try {
    const { Client } = await import("@neondatabase/serverless");
    const client = new Client(databaseUrl);
    await client.connect();

    const summary = await executeAuthDbSetup(client);
    console.log("Authentication database setup completed successfully:", summary);
    process.exit(0);
  } catch (err) {
    console.error("Setup failed:", sanitizeErrorMessage(err.message));
    process.exit(1);
  }
}
