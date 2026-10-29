/**
 * Safe Migration Script: Unique Partial Index on team_memberships(user_id) WHERE is_default = TRUE
 *
 * Invariant Enforced:
 * A user may belong to multiple workspaces, but can have at most ONE default workspace (is_default = TRUE).
 *
 * Safety & Transaction Guarantees:
 * 1. Dry-run mode by default. Exits without connecting to any database unless '--run' is explicitly passed.
 * 2. Mandatory target confirmations: Requires BOTH '--confirm-target <name>' AND '--confirm-endpoint <host>'.
 * 3. Pre-connection validation: Validates database name and hostname BEFORE constructing any database client.
 * 4. Conflict Pre-Detection: Queries for existing duplicate default memberships before index creation.
 *    Aborts immediately with actionable error if conflicting rows exist; NEVER modifies or deletes data automatically.
 * 5. Index Inspection: Checks pg_indexes catalog to verify whether an index with this name already exists
 *    and verifies whether its definition matches before attempting creation.
 * 6. Explicit Transaction: Runs DDL inside a guarded transaction block with clean rollback on failure.
 * 7. Connection Cleanup: Always closes connection in 'finally' block.
 * 8. Zero Credential Exposure: Sanitizes all output and error logs.
 */

import {
  loadDatabaseUrlFromEnv,
  validateDatabaseTarget,
  parseTargetCliArgs,
  sanitizeTargetHost,
  sanitizeErrorMessage,
} from "./db-target-guard.mjs";

export const INDEX_NAME = "idx_team_memberships_user_default";

export const INDEX_DDL = `CREATE UNIQUE INDEX idx_team_memberships_user_default ON team_memberships(user_id) WHERE is_default = TRUE;`;

export const CONFLICT_CHECK_SQL = `
  SELECT user_id, COUNT(*) AS default_count
  FROM team_memberships
  WHERE is_default = TRUE
  GROUP BY user_id
  HAVING COUNT(*) > 1;
`;

export const INDEX_INSPECTION_SQL = `
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE tablename = 'team_memberships'
    AND indexname = 'idx_team_memberships_user_default';
`;

export const TABLE_CHECK_SQL = `
  SELECT to_regclass('public.team_memberships') AS table_exists;
`;

export function printDryRunNotice() {
  console.log("==================================================================");
  console.log("Rota — Default Membership Partial Unique Index (DRY-RUN / PREVIEW)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero database writes executed.");
  console.log("To execute against the database, you must supply all required flags:");
  console.log("  --run");
  console.log("  --confirm-target <target_database_name>");
  console.log("  --confirm-endpoint <exact_hostname>\n");
  console.log("Example:");
  console.log("  node scripts/migrate-default-membership-index.mjs --run --confirm-target neondb --confirm-endpoint ep-staging-123.us-east-2.aws.neon.tech\n");
  console.log("Planned Operations:");
  console.log(`1. Verify 'team_memberships' table exists in target database.`);
  console.log(`2. Inspect pg_indexes to detect if '${INDEX_NAME}' already exists.`);
  console.log(`3. Check for conflicting users with multiple 'is_default = TRUE' rows (aborts if found).`);
  console.log(`4. Execute DDL transaction:`);
  console.log(`   ${INDEX_DDL}\n`);
  console.log("Notice: Hostname and database confirmation verifies operator intent, but does NOT");
  console.log("prove that a branch is disposable or isolated. Verify branch status in the Neon Console.");
  console.log("==================================================================");
}

/**
 * Pure CLI argument parser for migrate-default-membership-index.mjs
 */
export function parseIndexMigrationArgs(argv = process.argv) {
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
 * Executes default membership partial unique index creation with pre-inspection and conflict detection.
 *
 * @param {object} client - Database client with query(sql, params) and optional end()
 * @returns {Promise<{success: boolean, alreadyExisted: boolean, indexCreated: boolean, message: string}>}
 */
export async function executeDefaultMembershipIndexMigration(client) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client with query() method is required.");
  }

  let commitAttempted = false;
  let commitSucceeded = false;

  try {
    // 1. Verify table exists
    const tableRes = await client.query(TABLE_CHECK_SQL);
    const tableExists = tableRes?.rows?.[0]?.table_exists;
    if (!tableExists) {
      throw new Error(
        "Table 'team_memberships' does not exist in target database. Run team-isolation migration first."
      );
    }

    // 2. Inspect existing index definitions
    const indexInspectionRes = await client.query(INDEX_INSPECTION_SQL);
    const existingIndex = indexInspectionRes?.rows?.[0];

    if (existingIndex) {
      const def = (existingIndex.indexdef || "").toLowerCase();
      const isUnique = def.includes("unique");
      const hasUserId = def.includes("user_id");
      const hasWhereClause = def.includes("is_default = true") || def.includes("is_default");

      if (isUnique && hasUserId && hasWhereClause) {
        return {
          success: true,
          alreadyExisted: true,
          indexCreated: false,
          message: `Index '${INDEX_NAME}' already exists with matching unique definition.`,
        };
      } else {
        throw new Error(
          `Index '${INDEX_NAME}' already exists with an unexpected definition: ${existingIndex.indexdef}`
        );
      }
    }

    // 3. Check for conflicting data: multiple default memberships for any user
    const conflictRes = await client.query(CONFLICT_CHECK_SQL);
    const conflicts = conflictRes?.rows || [];

    if (conflicts.length > 0) {
      const conflictSummary = conflicts
        .map((c) => `user_id ${c.user_id} (${c.default_count} defaults)`)
        .join(", ");
      throw new Error(
        `Pre-migration conflict detected: ${conflicts.length} user(s) currently have multiple default memberships (${conflictSummary}). ` +
        `Manual resolution required before applying unique index. No changes were made.`
      );
    }

    // 4. Begin explicit transaction and create index
    await client.query("BEGIN;");

    await client.query(INDEX_DDL);

    try {
      commitAttempted = true;
      await client.query("COMMIT;");
      commitSucceeded = true;
    } catch (commitErr) {
      throw new Error(
        `Ambiguous failure during COMMIT: ${sanitizeErrorMessage(commitErr.message)}. ` +
        `The transaction status cannot be guaranteed. Do NOT automatically retry.`
      );
    }

    return {
      success: true,
      alreadyExisted: false,
      indexCreated: true,
      message: `Successfully created unique partial index '${INDEX_NAME}' on team_memberships(user_id) WHERE is_default = TRUE.`,
    };
  } catch (err) {
    if (!commitSucceeded && !commitAttempted) {
      try {
        await client.query("ROLLBACK;");
      } catch (rollbackErr) {
        console.error("Rollback attempt encountered an error:", sanitizeErrorMessage(rollbackErr.message));
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
if (process.argv[1] && process.argv[1].endsWith("migrate-default-membership-index.mjs")) {
  const parsed = parseIndexMigrationArgs(process.argv);

  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    console.error("Usage: node scripts/migrate-default-membership-index.mjs --run --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (parsed.help || !parsed.run) {
    printDryRunNotice();
    process.exit(0);
  }

  if (!parsed.confirmTarget) {
    console.error("Error: '--confirm-target <database-name>' is required when running migration.");
    console.error("Usage: node scripts/migrate-default-membership-index.mjs --run --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (!parsed.confirmEndpoint) {
    console.error("Error: '--confirm-endpoint <exact-hostname>' is required when running migration.");
    console.error("Usage: node scripts/migrate-default-membership-index.mjs --run --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
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
      confirmTarget: parsed.confirmTarget,
      confirmEndpoint: parsed.confirmEndpoint,
    });
  } catch (valErr) {
    console.error("Safety guard error:", sanitizeErrorMessage(valErr.message));
    process.exit(1);
  }

  console.log("Connecting to target database for default membership index migration...");
  console.log(`Target Host: ${sanitizeTargetHost(databaseUrl)}`);
  console.log(`Target Database: ${parsed.confirmTarget}\n`);

  try {
    const { Client } = await import("@neondatabase/serverless");
    const client = new Client(databaseUrl);
    await client.connect();

    const summary = await executeDefaultMembershipIndexMigration(client);
    console.log("Migration completed:", summary.message);
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", sanitizeErrorMessage(err.message));
    process.exit(1);
  }
}
