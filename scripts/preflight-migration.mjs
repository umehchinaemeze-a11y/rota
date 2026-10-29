/**
 * Team Isolation Migration — Fail-Closed Read-Only Preflight Inspection Script
 *
 * Safety & Read-Only Guarantees:
 * 1. Read-only by design: Never executes INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE,
 *    GRANT, REVOKE, or any other schema/data mutation statements.
 * 2. Never imports, wraps, or triggers other migration, setup, or reset scripts.
 * 3. Default dry-run mode: Exits with notice and zero database connection unless '--run-read-only' is supplied.
 * 4. Two-factor target confirmation: Requires BOTH '--confirm-target <database-name>' AND
 *    '--confirm-endpoint <exact-hostname>' exactly matching the configured target host and connected database.
 *    Fails closed if either confirmation is missing, malformed, or mismatched.
 * 5. Explicit read-only transaction: Begins with 'BEGIN TRANSACTION READ ONLY;' and sets finite statement
 *    and lock timeouts ('5000' and '2000' ms) to prevent hanging.
 * 6. Always terminates with 'ROLLBACK;' and closes the connection in a 'finally' block.
 * 7. Never prints raw DATABASE_URL, passwords, tokens, full connection strings, or raw driver errors.
 * 8. Distinguishes unavailable lock inspection permissions from clean results.
 * 9. Explicitly reports backup / Neon branch status as unverified, requiring human confirmation.
 */import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Re-export shared target guard and environment utilities
export * from "./db-target-guard.mjs";
import {
  parseEnvContent,
  resolveEnvLocalPath,
  loadDatabaseUrlFromEnv,
  normalizeHostname,
  extractHostname,
  extractDatabaseName,
  sanitizeTargetHost,
  sanitizeErrorMessage,
  isValidDatabaseIdentifier,
  isValidHostname,
  isValidEndpointIdentifier,
  validateDatabaseTarget,
  parseTargetCliArgs,
} from "./db-target-guard.mjs";

// The five canonical verified demo accounts required for team isolation
export const EXPECTED_DEMO_EMAILS = [
  "amara@rota.local",
  "daniel@rota.local",
  "sarah@rota.local",
  "david@rota.local",
  "chika@rota.local",
];

// Mutation statement detector to guarantee strictly read-only execution
const MUTATION_REGEX = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i;

export function assertReadOnlyQuery(sql) {
  if (typeof sql === "string" && MUTATION_REGEX.test(sql.trim())) {
    throw new Error(
      "Safety violation: Preflight is strictly read-only and must never execute mutation SQL."
    );
  }
}

export function categorizeError(err) {
  const msg = (err?.message || (typeof err === "string" ? err : "")).toLowerCase();
  if (msg.includes("target confirmation") || msg.includes("endpoint confirmation") || msg.includes("mismatch")) {
    return "Target Mismatch";
  }
  if (msg.includes("safety violation") || msg.includes("read-only")) {
    return "Safety Guard";
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return "Timeout";
  }
  if (
    msg.includes("connect") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("authentication") ||
    msg.includes("connection")
  ) {
    return "Connection Error";
  }
  if (msg.includes("permission denied") || msg.includes("insufficient_privilege")) {
    return "Permission Denied";
  }
  return "Inspection Error";
}

export function formatSafeCliError(err) {
  const category = categorizeError(err);
  const rawMsg = err?.message || (typeof err === "string" ? err : "An unexpected failure occurred.");
  const sanitized = sanitizeErrorMessage(rawMsg);
  return `[${category}] ${sanitized}`;
}

export function parsePreflightArgs(argv = process.argv) {
  const args = argv.slice(2);
  let runReadOnly = false;
  let confirmTarget = null;
  let confirmEndpoint = null;
  let help = false;
  let error = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--run-read-only") {
      runReadOnly = true;
    } else if (arg === "--confirm-target" || arg === "--confirm-database") {
      i++;
      if (i < args.length && args[i] && !args[i].startsWith("-")) {
        confirmTarget = args[i].trim();
      }
    } else if (
      arg === "--confirm-endpoint" ||
      arg === "--confirm-host" ||
      arg === "--confirm-hostname" ||
      arg === "--confirm-endpoint-prefix"
    ) {
      i++;
      if (i < args.length && args[i] && !args[i].startsWith("-")) {
        confirmEndpoint = args[i].trim();
      }
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      error = `Unrecognized or disallowed argument '${arg}'.`;
    }
  }

  return { runReadOnly, confirmTarget, confirmEndpoint, help, error };
}

export function isPreflightRunMode(argv = process.argv) {
  return parsePreflightArgs(argv).runReadOnly;
}

export function printPreflightNotice() {
  console.log("==================================================================");
  console.log("Rota — Migration Preflight Audit (DRY-RUN / PREVIEW MODE)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero database queries executed.");
  console.log("This script is strictly READ-ONLY. It never mutates schema or data.\n");
  console.log("To connect and run the read-only inspection, supply all required flags:");
  console.log("  --run-read-only");
  console.log("  --confirm-target <target_database_name>");
  console.log("  --confirm-endpoint <exact_hostname>\n");
  console.log("Example:");
  console.log("  node scripts/preflight-migration.mjs --run-read-only --confirm-target neondb --confirm-endpoint ep-staging-123.us-east-2.aws.neon.tech\n");
  console.log("Planned Read-Only Verifications:");
  console.log("- Confirm database identity and exact host endpoint against operator confirmation.");
  console.log("- Inspect tables and column definitions (users, shifts, teams, team_memberships).");
  console.log("- Inspect foreign keys, uniqueness constraints, and idx_shifts_team_id.");
  console.log("- Inspect demo accounts status (informational for real-user databases; required only if --seed-demo-team is used).");
  console.log("- Enumerate shift counts: backfill-eligible, unassigned, and non-demo quarantined shifts.");
  console.log("- Check for active conflicting locks or queries (or report permission unavailability).");
  console.log("- Report backup and disposable Neon-branch prerequisites as unverified.");
  console.log("- Notice: Exact hostname matching does not prove a branch is disposable.");
  console.log("==================================================================");
}

/**
 * Executes a strictly read-only preflight inspection using the supplied client.
 *
 * @param {object} client - Database client with query(sql, params) and optional end()
 * @param {object} options - Inspection options including confirmTarget and confirmEndpoint
 * @returns {Promise<object>} Comprehensive preflight report
 */
export async function executePreflightInspection(client, options = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client with query() method is required.");
  }

  const { confirmTarget, confirmEndpoint } = options;

  if (!confirmTarget || typeof confirmTarget !== "string" || confirmTarget.trim().length === 0) {
    throw new Error(
      "Safety guard: Operator target database confirmation (--confirm-target <name>) is required to prevent accidental connection."
    );
  }
  if (!isValidDatabaseIdentifier(confirmTarget)) {
    throw new Error(
      "Safety guard: Malformed database confirmation. Provide a valid database name (e.g. 'neondb')."
    );
  }

  if (!confirmEndpoint || typeof confirmEndpoint !== "string" || confirmEndpoint.trim().length === 0) {
    throw new Error(
      "Safety guard: Operator endpoint confirmation (--confirm-endpoint <exact_hostname>) is required to prevent accidental connection across branches."
    );
  }
  if (!isValidEndpointIdentifier(confirmEndpoint)) {
    throw new Error(
      "Safety guard: Malformed endpoint confirmation. Provide the exact, fully qualified hostname (e.g. 'ep-cool-dawn-123456.us-east-2.aws.neon.tech'). Partial prefixes, URLs, paths, and ports are rejected."
    );
  }

  // Verify endpoint confirmation against configured connection host before running inspection queries
  const configuredHost = normalizeHostname(
    options.hostname ||
    (options.databaseUrl ? extractHostname(options.databaseUrl) : "") ||
    client?.host ||
    client?.connection?.host ||
    ""
  );

  if (configuredHost) {
    const normalizedEndpoint = normalizeHostname(confirmEndpoint);
    const endpointMatches = configuredHost === normalizedEndpoint;
    if (!endpointMatches) {
      throw new Error(
        "Endpoint confirmation mismatch: Expected hostname does not match the configured host. Inspection aborted."
      );
    }
  }

  const criticalIssues = [];
  const warnings = [];

  let inspectionError = null;
  let rollbackError = null;
  let closeError = null;
  let reportResult = null;

  // Helper query wrapper to enforce read-only assertion on every statement
  async function safeQuery(sql, params = []) {
    assertReadOnlyQuery(sql);
    return client.query(sql, params);
  }

  try {
    // 1. Begin explicit read-only transaction with finite statement/lock timeouts
    await safeQuery("BEGIN TRANSACTION READ ONLY;");
    await safeQuery("SET LOCAL statement_timeout = '5000';");
    await safeQuery("SET LOCAL lock_timeout = '2000';");

    // 2. Inspect database identity
    const dbIdentityRes = await safeQuery(
      "SELECT current_database() AS db_name, current_user AS user_name, version() AS pg_version;"
    );
    const dbRow = dbIdentityRes?.rows?.[0] || {};
    const currentDb = dbRow.db_name || "";
    const currentUser = dbRow.user_name || "";
    const pgVersion = dbRow.pg_version ? dbRow.pg_version.split(" on ")[0] : "PostgreSQL";

    if (currentDb.toLowerCase() !== confirmTarget.trim().toLowerCase()) {
      throw new Error(
        `Database confirmation mismatch: Connected database does not match the specified target confirmation. Inspection aborted.`
      );
    }

    const dbIdentity = {
      database: currentDb,
      user: currentUser,
      version: pgVersion,
    };

    // 3. Inspect presence and types of relevant tables and columns
    const columnsRes = await safeQuery(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'shifts', 'teams', 'team_memberships')
      ORDER BY table_name, ordinal_position;
    `);

    const rawColumns = columnsRes?.rows || [];
    const tables = {
      users: { exists: false, columns: {} },
      shifts: { exists: false, columns: {} },
      teams: { exists: false, columns: {} },
      team_memberships: { exists: false, columns: {} },
    };

    for (const row of rawColumns) {
      if (tables[row.table_name]) {
        tables[row.table_name].exists = true;
        tables[row.table_name].columns[row.column_name] = {
          type: row.data_type,
          nullable: row.is_nullable === "YES",
        };
      }
    }

    if (!tables.users.exists) {
      criticalIssues.push("Missing core table 'users'. Cannot proceed with team isolation migration.");
    }
    if (!tables.shifts.exists) {
      criticalIssues.push("Missing core table 'shifts'. Cannot proceed with team isolation migration.");
    }

    const teamIdColumn = tables.shifts.columns?.team_id
      ? { exists: true, type: tables.shifts.columns.team_id.type }
      : { exists: false, type: null };

    // 4. Inspect relevant constraints and indexes
    const indexesRes = await safeQuery(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('users', 'shifts', 'teams', 'team_memberships');
    `);

    const rawIndexes = indexesRes?.rows || [];
    const indexExists = rawIndexes.some((idx) => idx.indexname === "idx_shifts_team_id");

    const constraintsRes = await safeQuery(`
      SELECT
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name IN ('users', 'shifts', 'teams', 'team_memberships');
    `);

    const rawConstraints = constraintsRes?.rows || [];
    const constraints = rawConstraints.map((c) => ({
      table: c.table_name,
      name: c.constraint_name,
      type: c.constraint_type,
      column: c.column_name,
      foreignTable: c.foreign_table_name || null,
    }));

    // 5. Inspect demo accounts
    let foundDemoUsers = [];
    let missingDemoEmails = [...EXPECTED_DEMO_EMAILS];
    let duplicateDemoEmails = [];

    if (tables.users.exists) {
      const lowerExpected = EXPECTED_DEMO_EMAILS.map((e) => e.toLowerCase());
      const usersRes = await safeQuery(
        `SELECT id, email, name, role
         FROM users
         WHERE LOWER(TRIM(email)) = ANY($1);`,
        [lowerExpected]
      );

      foundDemoUsers = usersRes?.rows || [];

      const seenEmails = new Set();
      const dupSet = new Set();
      for (const u of foundDemoUsers) {
        const normalized = u.email.toLowerCase().trim();
        if (seenEmails.has(normalized)) {
          dupSet.add(normalized);
        } else {
          seenEmails.add(normalized);
        }
      }

      duplicateDemoEmails = Array.from(dupSet);
      missingDemoEmails = EXPECTED_DEMO_EMAILS.filter(
        (e) => !seenEmails.has(e.toLowerCase().trim())
      );

      if (duplicateDemoEmails.length > 0) {
        criticalIssues.push(
          `Ambiguous duplicate demo accounts detected in 'users' table: ${duplicateDemoEmails.join(", ")}.`
        );
      }

      if (missingDemoEmails.length > 0) {
        warnings.push(
          `Notice: Demo accounts (${missingDemoEmails.join(", ")}) not present in 'users' table. ` +
          `Structural schema migration can proceed safely for real users; legacy demo seeding (--seed-demo-team) will be skipped.`
        );
      }
    }

    const demoAccountsReport = {
      expected: EXPECTED_DEMO_EMAILS,
      found: foundDemoUsers.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role })),
      missing: missingDemoEmails,
      duplicates: duplicateDemoEmails,
      isComplete: missingDemoEmails.length === 0 && duplicateDemoEmails.length === 0,
    };

    // 6. Inspect shift counts and backfill eligibility
    let shiftCounts = {
      totalShifts: 0,
      eligibleForBackfill: 0,
      unassignedShifts: 0,
      nonDemoShifts: 0,
      alreadyAssignedShifts: 0,
      ownershipDisclaimer:
        "Note: Shift counts alone do not establish ownership or authorize a backfill; operator review is required.",
    };

    if (tables.shifts.exists) {
      const demoUserIds = foundDemoUsers.map((u) => u.id);

      // Perform read-only shift count breakdown
      const shiftCountRes = await safeQuery(
        `SELECT
           COUNT(*)::INTEGER AS total_shifts,
           COUNT(*) FILTER (WHERE user_id = ANY($1) AND (team_id IS NULL OR team_id = 0))::INTEGER AS eligible_for_backfill,
           COUNT(*) FILTER (WHERE user_id IS NULL)::INTEGER AS unassigned_shifts,
           COUNT(*) FILTER (WHERE user_id IS NOT NULL AND NOT (user_id = ANY($1)))::INTEGER AS non_demo_shifts,
           COUNT(*) FILTER (WHERE team_id IS NOT NULL AND team_id > 0)::INTEGER AS already_assigned_shifts
         FROM shifts;`,
        [demoUserIds]
      );

      const counts = shiftCountRes?.rows?.[0] || {};
      shiftCounts.totalShifts = Number(counts.total_shifts) || 0;
      shiftCounts.eligibleForBackfill = Number(counts.eligible_for_backfill) || 0;
      shiftCounts.unassignedShifts = Number(counts.unassigned_shifts) || 0;
      shiftCounts.nonDemoShifts = Number(counts.non_demo_shifts) || 0;
      shiftCounts.alreadyAssignedShifts = Number(counts.already_assigned_shifts) || 0;

      if (shiftCounts.unassignedShifts > 0) {
        warnings.push(
          `Notice: ${shiftCounts.unassignedShifts} shifts have user_id IS NULL and will NOT be backfilled. They will remain team_id = NULL (quarantined/inaccessible in tenant UI).`
        );
      }

      if (shiftCounts.nonDemoShifts > 0) {
        warnings.push(
          `Notice: ${shiftCounts.nonDemoShifts} shifts belong to users outside the 5 verified demo accounts. They will remain team_id = NULL unless external team rules are applied.`
        );
      }
    }

    // 7. Check active locks / activity (with explicit permission unavailability handling)
    let lockReport = {
      status: "clean",
      details: "No active conflicting queries detected.",
      activeProcesses: [],
    };

    try {
      const activityRes = await safeQuery(`
        SELECT pid, usename, state, query
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND state = 'active'
          AND query NOT ILIKE '%pg_stat_activity%';
      `);

      const activeQueries = activityRes?.rows || [];
      if (activeQueries.length > 0) {
        lockReport.status = "active_locks_found";
        lockReport.details = `Detected ${activeQueries.length} concurrent active queries. Verify before running DDL.`;
        lockReport.activeProcesses = activeQueries.map((q) => ({
          pid: q.pid,
          user: q.usename,
          state: q.state,
          query: q.query ? q.query.slice(0, 100) : "",
        }));
        warnings.push(lockReport.details);
      }
    } catch (activityErr) {
      lockReport.status = "unavailable";
      lockReport.details = `Lock inspection unavailable due to restricted database permissions: ${sanitizeErrorMessage(activityErr.message)}. Do NOT assume no conflicting locks exist.`;
      warnings.push(lockReport.details);
    }

    // 8. Backup / PITR / Disposable branch verification
    const backupReport = {
      status: "unverified",
      notice:
        "Neon point-in-time recovery and branch status cannot be confirmed solely through SQL queries. Operator must verify backup / branch status in Neon Console before proceeding with migration.",
    };
    warnings.push(backupReport.notice);

    // 9. Conclude read-only transaction cleanly
    await safeQuery("ROLLBACK;");

    const success = criticalIssues.length === 0;

    reportResult = {
      success,
      dbIdentity,
      schema: {
        tables,
        teamIdColumn,
        indexExists,
        constraints,
      },
      demoAccounts: demoAccountsReport,
      shiftCounts,
      locks: lockReport,
      backupPrerequisite: backupReport,
      criticalIssues,
      warnings,
    };
  } catch (err) {
    inspectionError = err;
    try {
      await safeQuery("ROLLBACK;");
    } catch (rbErr) {
      rollbackError = rbErr;
    }
  } finally {
    if (client && typeof client.end === "function") {
      try {
        await client.end();
      } catch (cErr) {
        closeError = cErr;
      }
    }
  }

  if (inspectionError) {
    let msg = `Preflight inspection failed: ${sanitizeErrorMessage(inspectionError.message)}`;
    const cleanupIssues = [];
    if (rollbackError) {
      cleanupIssues.push(`ROLLBACK failed: ${sanitizeErrorMessage(rollbackError.message)}`);
    }
    if (closeError) {
      cleanupIssues.push(`client closure failed: ${sanitizeErrorMessage(closeError.message)}`);
    }
    if (cleanupIssues.length > 0) {
      msg += ` (Cleanup failed: ${cleanupIssues.join("; ")})`;
    }
    const finalErr = new Error(msg);
    if (typeof inspectionError.stack === "string") {
      const sanitizedStack = sanitizeErrorMessage(inspectionError.stack);
      const firstLineBreak = sanitizedStack.indexOf("\n");
      if (firstLineBreak !== -1) {
        finalErr.stack = `${finalErr.name}: ${msg}${sanitizedStack.slice(firstLineBreak)}`;
      } else {
        finalErr.stack = `${finalErr.name}: ${msg}`;
      }
    } else if (typeof finalErr.stack === "string") {
      finalErr.stack = sanitizeErrorMessage(finalErr.stack);
    }
    throw finalErr;
  }

  if (closeError) {
    const err = new Error(
      `Preflight inspection cleanup failed: client closure failed: ${sanitizeErrorMessage(closeError.message)}`
    );
    if (typeof err.stack === "string") {
      err.stack = sanitizeErrorMessage(err.stack);
    }
    throw err;
  }

  return reportResult;
}

// CLI execution block
if (process.argv[1] && process.argv[1].endsWith("preflight-migration.mjs")) {
  const parsed = parsePreflightArgs(process.argv);

  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    console.error("Usage: node scripts/preflight-migration.mjs --run-read-only --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  const { runReadOnly, confirmTarget, confirmEndpoint, help } = parsed;

  if (help || !runReadOnly) {
    printPreflightNotice();
    process.exit(0);
  }

  if (!confirmTarget) {
    console.error("Error: '--confirm-target <database-name>' is required when running in read-only mode.");
    console.error("Usage: node scripts/preflight-migration.mjs --run-read-only --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (!isValidDatabaseIdentifier(confirmTarget)) {
    console.error("Error: Malformed '--confirm-target' value. Provide a valid database name (e.g. 'neondb').");
    process.exit(1);
  }

  if (!confirmEndpoint) {
    console.error("Error: '--confirm-endpoint <exact-hostname>' is required when running in read-only mode.");
    console.error("Usage: node scripts/preflight-migration.mjs --run-read-only --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (!isValidEndpointIdentifier(confirmEndpoint)) {
    console.error("Error: Malformed '--confirm-endpoint' value. Provide the exact, fully qualified hostname (e.g. 'ep-cool-dawn-123456.us-east-2.aws.neon.tech'). Partial prefixes, URLs, paths, and ports are rejected.");
    process.exit(1);
  }

  // Load DATABASE_URL safely via loadDatabaseUrlFromEnv without logging file contents
  const databaseUrl = loadDatabaseUrlFromEnv();
  if (!databaseUrl) {
    console.error("Configuration error: DATABASE_URL is not set.");
    process.exit(1);
  }

  // Pre-connection safety validation: Verifies database name and exact hostname
  try {
    validateDatabaseTarget({
      databaseUrl,
      confirmTarget,
      confirmEndpoint,
    });
  } catch (valErr) {
    console.error("Safety guard error:", sanitizeErrorMessage(valErr.message));
    process.exit(1);
  }

  console.log("Connecting to target database in strictly read-only mode...");
  console.log(`Target Host: ${sanitizeTargetHost(databaseUrl)}`);
  console.log(`Expected Database: ${confirmTarget}\n`);

  try {
    const { Client } = await import("@neondatabase/serverless");
    const client = new Client(databaseUrl);
    await client.connect();

    const report = await executePreflightInspection(client, {
      confirmTarget,
      confirmEndpoint,
      databaseUrl,
    });

    console.log("==================================================================");
    console.log("Rota — Migration Preflight Audit Report");
    console.log("==================================================================");
    console.log(`Database: ${report.dbIdentity.database} (User: ${report.dbIdentity.user})`);
    console.log(`PostgreSQL Engine: ${report.dbIdentity.version}`);
    console.log("------------------------------------------------------------------");
    console.log("Schema State:");
    console.log(`- 'users' table: ${report.schema.tables.users.exists ? "Present" : "MISSING"}`);
    console.log(`- 'shifts' table: ${report.schema.tables.shifts.exists ? "Present" : "MISSING"}`);
    console.log(`- 'teams' table: ${report.schema.tables.teams.exists ? "Already Exists" : "Not Yet Created"}`);
    console.log(`- 'team_memberships' table: ${report.schema.tables.team_memberships.exists ? "Already Exists" : "Not Yet Created"}`);
    console.log(`- 'shifts.team_id' column: ${report.schema.teamIdColumn.exists ? `Present (${report.schema.teamIdColumn.type})` : "Not Yet Added"}`);
    console.log(`- 'idx_shifts_team_id' index: ${report.schema.indexExists ? "Present" : "Not Yet Created"}`);
    console.log("------------------------------------------------------------------");
    console.log("Demo Accounts Check:");
    console.log(`- Expected (${report.demoAccounts.expected.length}): ${report.demoAccounts.expected.join(", ")}`);
    console.log(`- Found Verified (${report.demoAccounts.found.length}): ${report.demoAccounts.found.map((u) => u.email).join(", ")}`);
    if (report.demoAccounts.missing.length > 0) {
      console.log(`- Missing: ${report.demoAccounts.missing.join(", ")} (Informational for real-user databases)`);
    }
    if (report.demoAccounts.duplicates.length > 0) {
      console.log(`- Duplicates: ${report.demoAccounts.duplicates.join(", ")}`);
    }
    console.log("------------------------------------------------------------------");
    console.log("Shift Records Impact Preview:");
    console.log(`- Total Shifts: ${report.shiftCounts.totalShifts}`);
    console.log(`- Eligible for Backfill: ${report.shiftCounts.eligibleForBackfill}`);
    console.log(`- Unassigned Shifts (user_id IS NULL): ${report.shiftCounts.unassignedShifts}`);
    console.log(`- External / Non-Demo Shifts: ${report.shiftCounts.nonDemoShifts}`);
    console.log(`- Already Assigned Shifts: ${report.shiftCounts.alreadyAssignedShifts}`);
    console.log(`- Note: ${report.shiftCounts.ownershipDisclaimer}`);
    console.log("------------------------------------------------------------------");
    console.log("Lock & Activity Status:");
    console.log(`- Status: ${report.locks.status}`);
    console.log(`- Details: ${report.locks.details}`);
    console.log("------------------------------------------------------------------");
    console.log("Backup & Branch Status:");
    console.log(`- Status: ${report.backupPrerequisite.status}`);
    console.log(`- Notice: ${report.backupPrerequisite.notice}`);
    console.log("==================================================================");

    if (report.criticalIssues.length > 0) {
      console.error("\nPREFLIGHT FAILED — Safety-critical issues detected:");
      for (const issue of report.criticalIssues) {
        console.error(`  [CRITICAL] ${issue}`);
      }
      process.exit(1);
    } else {
      console.log("\nPREFLIGHT PASSED — All safety-critical checks verified.");
      if (report.warnings.length > 0) {
        console.log("Notices for operator review before running migration:");
        for (const warn of report.warnings) {
          console.log(`  [NOTICE] ${warn}`);
        }
      }
      process.exit(0);
    }
  } catch (err) {
    console.error("Preflight execution encountered a fatal error:", formatSafeCliError(err));
    process.exit(1);
  }
}
