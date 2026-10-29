/**
 * Team Isolation Schema Migration & Backfill Script
 *
 * Safety & Transaction Guarantees:
 * 1. Dry-run mode by default. Exits without connecting to any database unless `--run` is explicitly passed.
 * 2. Requires exact `--run` CLI flag before opening any database connection or write operation.
 * 3. All schema DDL and data backfill statements execute on one database connection inside ONE explicit transaction (`BEGIN` ... `COMMIT`).
 * 4. Structural Schema Migration: Applies teams, team_memberships, shifts.team_id, and idx_shifts_team_id
 *    without requiring or mutating any @rota.local demo accounts.
 * 5. Optional Demo Seeding: Controlled by explicit `--seed-demo-team` flag. Without this flag, zero demo
 *    records are created, leaving real users, credentials, password hashes, and sessions completely untouched.
 * 6. On statement failure, attempts a rollback using the same connection before re-throwing the original sanitized error.
 * 7. On ambiguous commit failures (network failure during COMMIT), instructs the operator to inspect database state rather than auto-retrying.
 * 8. Connection cleanup is guaranteed via a `finally` block (`client.end()`).
 * 9. Does NOT include destructive automatic rollback commands (documented for manual operator execution only).
 * 10. Never prints database credentials, tokens, or raw connection strings.
 */

import fs from "node:fs";
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

// Verified demo team configuration (used only when --seed-demo-team is explicitly enabled)
export const DEMO_TEAM_CONFIG = {
  name: "Main Operations",
  slug: "main-operations",
  demoEmails: [
    "amara@rota.local",
    "daniel@rota.local",
    "sarah@rota.local",
    "david@rota.local",
    "chika@rota.local",
  ],
};

// DDL Migration Statements
export const MIGRATION_DDL = `
-- 1. Create teams table
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create team_memberships table
CREATE TABLE IF NOT EXISTS team_memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL,
  is_default BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, team_id)
);

-- 3. Add nullable team_id column to shifts table
ALTER TABLE shifts
ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);

-- 4. Create index on shifts.team_id for fast team-scoped queries
CREATE INDEX IF NOT EXISTS idx_shifts_team_id ON shifts(team_id);
`;

// Guarded Rollback Plan (Documented for explicit manual operator execution only)
export const ROLLBACK_PLAN_SQL = `
-- GUARDED ROLLBACK PLAN
-- Execute only after backing up database tables and verifying team separation is no longer required:
-- 1. ALTER TABLE shifts DROP COLUMN IF EXISTS team_id;
-- 2. DROP TABLE IF EXISTS team_memberships;
-- 3. DROP TABLE IF EXISTS teams;
`;

export function printDryRunNotice() {
  console.log("==================================================================");
  console.log("Rota — Team Isolation Migration (DRY-RUN / PREVIEW MODE)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero database writes executed.");
  console.log("To execute against the database, you must supply all required flags:");
  console.log("  --run");
  console.log("  --confirm-target <target_database_name>");
  console.log("  --confirm-endpoint <exact_hostname>\n");
  console.log("Optional flag for legacy demo environments only:");
  console.log("  --seed-demo-team   (Seed 'Main Operations' workspace and map legacy demo accounts)\n");
  console.log("Planned Schema DDL (Applied in default mode):");
  console.log(MIGRATION_DDL);
  console.log("Default Mode Behavior (Real-User Safe):");
  console.log("- Applies structural schema changes: teams, team_memberships, shifts.team_id, idx_shifts_team_id.");
  console.log("- Does NOT require or modify @rota.local accounts.");
  console.log("- Preserves all existing users, password hashes, password salts, and active sessions.");
  console.log("- Leaves existing shifts unchanged (team_id remains NULL pending workspace assignment).\n");
  console.log("Optional Demo Seeding (--seed-demo-team):");
  console.log(`- Workspace Name: "${DEMO_TEAM_CONFIG.name}" (Slug: "${DEMO_TEAM_CONFIG.slug}")`);
  console.log("- Demo accounts resolved dynamically by email (no assumed IDs):");
  DEMO_TEAM_CONFIG.demoEmails.forEach((email) => console.log(`    • ${email}`));
  console.log("- Shifts mapped only where shift.user_id matches verified demo users.\n");
  console.log("Guarded Rollback Documentation:");
  console.log(ROLLBACK_PLAN_SQL);
  console.log("Notice: Hostname and database confirmation verifies operator intent, but does NOT");
  console.log("prove that a branch is disposable or isolated. Verify branch status in the Neon Console.");
  console.log("==================================================================");
}

/**
 * Executes the migration DDL and backfill inside a single database transaction.
 *
 * @param {object} client - Database client with query(sql, params) and optional end()
 * @param {object} [options={}] - Migration options
 * @param {boolean} [options.seedDemoTeam=false] - Whether to seed the demo 'Main Operations' workspace and map demo users
 * @returns {Promise<{success: boolean, schemaApplied: boolean, demoSeeded: boolean, teamId: number|null, membersBackfilled: number, shiftsBackfilled: number}>}
 */
export async function executeMigrationTransaction(client, options = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client with query() method is required.");
  }

  const seedDemoTeam = Boolean(options.seedDemoTeam);
  let commitAttempted = false;
  let commitSucceeded = false;

  try {
    // 1. Begin the explicit transaction
    await client.query("BEGIN;");

    // 2. Sequential structural DDL operations (always executed, safe for all databases)
    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_memberships (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL,
        is_default BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, team_id)
      );
    `);

    await client.query(`
      ALTER TABLE shifts
      ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shifts_team_id ON shifts(team_id);
    `);

    let resolvedTeamId = null;
    let membersBackfilled = 0;
    let shiftsBackfilled = 0;

    // Optional legacy demo fixture seeding (ONLY if explicitly enabled via options.seedDemoTeam)
    if (seedDemoTeam) {
      // 3. Resolve team ID by unique slug (do not assume team ID 1, preserve existing team name)
      const teamInsertRes = await client.query(
        `INSERT INTO teams (name, slug)
         VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id;`,
        [DEMO_TEAM_CONFIG.name, DEMO_TEAM_CONFIG.slug]
      );

      resolvedTeamId = teamInsertRes?.rows?.[0]?.id;
      if (!resolvedTeamId) {
        // Fallback query by slug if team already exists and insert encountered conflict
        const teamSelectRes = await client.query(
          `SELECT id FROM teams WHERE slug = $1 LIMIT 1;`,
          [DEMO_TEAM_CONFIG.slug]
        );
        resolvedTeamId = teamSelectRes?.rows?.[0]?.id;
      }

      if (!resolvedTeamId || typeof resolvedTeamId !== "number" || resolvedTeamId <= 0) {
        throw new Error(
          `Failed to resolve a valid positive integer team ID for slug "${DEMO_TEAM_CONFIG.slug}".`
        );
      }

      // 4. Resolve demo accounts dynamically by verified email
      const lowerEmails = DEMO_TEAM_CONFIG.demoEmails.map((e) => e.toLowerCase());
      const userRes = await client.query(
        `SELECT id, email, name, role
         FROM users
         WHERE LOWER(TRIM(email)) = ANY($1);`,
        [lowerEmails]
      );

      const foundUsers = userRes?.rows || [];

      // Safety guard: Check for ambiguous duplicate email accounts
      const emailSet = new Set(foundUsers.map((u) => u.email.toLowerCase().trim()));
      if (emailSet.size !== foundUsers.length) {
        throw new Error("Abort: Ambiguous duplicate email accounts detected in users table.");
      }

      // Safety guard: Require all configured demo accounts to be present exactly once
      const missingEmails = DEMO_TEAM_CONFIG.demoEmails.filter(
        (e) => !emailSet.has(e.toLowerCase().trim())
      );
      if (missingEmails.length > 0 || foundUsers.length !== DEMO_TEAM_CONFIG.demoEmails.length) {
        throw new Error(
          `Abort: Incomplete demo accounts in database. Expected ${DEMO_TEAM_CONFIG.demoEmails.length} verified accounts, but missing: ${missingEmails.join(", ")}.`
        );
      }

      // 5. Backfill team_memberships for verified demo users (preserve existing role if already present)
      for (const user of foundUsers) {
        await client.query(
          `INSERT INTO team_memberships (user_id, team_id, role, is_default)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (user_id, team_id) DO NOTHING;`,
          [user.id, resolvedTeamId, user.role]
        );
      }

      // 6. Backfill shifts strictly for verified demo users where team_id IS NULL
      const verifiedUserIds = foundUsers.map((u) => u.id);
      const shiftRes = await client.query(
        `UPDATE shifts
         SET team_id = $1
         WHERE user_id = ANY($2)
           AND team_id IS NULL;`,
        [resolvedTeamId, verifiedUserIds]
      );

      membersBackfilled = foundUsers.length;
      shiftsBackfilled = shiftRes?.rowCount ?? 0;
    }

    // 7. Commit transaction
    try {
      commitAttempted = true;
      await client.query("COMMIT;");
      commitSucceeded = true;
    } catch (commitErr) {
      // Ambiguous connection failure during COMMIT: Do not auto-retry!
      throw new Error(
        `Ambiguous failure during COMMIT: ${sanitizeErrorMessage(commitErr.message)}. ` +
        `The transaction status cannot be guaranteed. Do NOT automatically retry. Operator must inspect database state before retrying.`
      );
    }

    return {
      success: true,
      schemaApplied: true,
      demoSeeded: seedDemoTeam,
      teamId: resolvedTeamId,
      membersBackfilled,
      shiftsBackfilled,
    };
  } catch (err) {
    if (!commitSucceeded && !commitAttempted) {
      // Attempt rollback only if commit was not already attempted
      try {
        await client.query("ROLLBACK;");
      } catch (rollbackErr) {
        console.error("Rollback attempt encountered an error:", sanitizeErrorMessage(rollbackErr.message));
      }
    }
    throw err;
  } finally {
    // 8. Always close or release connection
    if (client && typeof client.end === "function") {
      try {
        await client.end();
      } catch {
        // Silently close
      }
    }
  }
}

export function parseMigrationArgs(argv = process.argv) {
  try {
    const { confirmTarget, confirmEndpoint, help, extraFlags } = parseTargetCliArgs(argv, {
      allowedFlags: ["--run", "--seed-demo-team"],
    });
    return {
      run: !!extraFlags["--run"],
      seedDemoTeam: !!extraFlags["--seed-demo-team"],
      confirmTarget,
      confirmEndpoint,
      help,
    };
  } catch (err) {
    return {
      error: err.message,
      run: false,
      seedDemoTeam: false,
      confirmTarget: null,
      confirmEndpoint: null,
      help: false,
    };
  }
}

export function isMigrationRunMode(argv = process.argv) {
  const args = argv.slice(2);
  return args.includes("--run");
}

// CLI execution block
if (process.argv[1] && process.argv[1].endsWith("migrate-team-isolation.mjs")) {
  const parsed = parseMigrationArgs(process.argv);

  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    console.error("Usage: node scripts/migrate-team-isolation.mjs --run [--seed-demo-team] --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (parsed.help || !parsed.run) {
    printDryRunNotice();
    process.exit(0);
  }

  if (!parsed.confirmTarget) {
    console.error("Error: '--confirm-target <database-name>' is required when running migration.");
    console.error("Usage: node scripts/migrate-team-isolation.mjs --run [--seed-demo-team] --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (!parsed.confirmEndpoint) {
    console.error("Error: '--confirm-endpoint <exact-hostname>' is required when running migration.");
    console.error("Usage: node scripts/migrate-team-isolation.mjs --run [--seed-demo-team] --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  const databaseUrl = loadDatabaseUrlFromEnv();
  if (!databaseUrl) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
  }

  // Pre-connection safety validation: Verifies target before any client construction
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

  console.log("Connecting to target database for team-isolation migration...");
  console.log(`Target Host: ${sanitizeTargetHost(databaseUrl)}`);
  console.log(`Target Database: ${parsed.confirmTarget}`);
  console.log(`Demo Seeding: ${parsed.seedDemoTeam ? "ENABLED (--seed-demo-team)" : "DISABLED (pure schema migration)"}\n`);

  try {
    const { Client } = await import("@neondatabase/serverless");
    const client = new Client(databaseUrl);
    await client.connect();

    const summary = await executeMigrationTransaction(client, {
      seedDemoTeam: parsed.seedDemoTeam,
    });
    console.log("Migration executed and committed successfully:", summary);
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", sanitizeErrorMessage(err.message));
    process.exit(1);
  }
}
