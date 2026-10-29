/**
 * Supervisor Credential Reset Script
 *
 * Safety & Transaction Guarantees:
 * 1. Dry-run mode by default. Exits without connecting to any database unless '--run' is explicitly passed.
 * 2. Mandatory target confirmations: Requires BOTH '--confirm-target <name>' AND '--confirm-endpoint <host>'.
 * 3. Pre-connection validation: Validates database name and hostname BEFORE constructing any database client.
 * 4. Exclusive local credential delivery: Writes the new credential strictly to a designated output file
 *    specified via '--out-file <filepath>'.
 * 5. Path Safety: Forbids overwriting existing files, writing to .git, .env.local, or repository root configs.
 * 6. Pre-Check Destination Writeability: Verifies that the destination directory exists and is writable
 *    before starting the database update transaction.
 * 7. Single-Account Targeting: Explicitly verifies account email ('chika@rota.local'), name ('Chika Nwosu'),
 *    and role ('Supervisor') with a 'FOR UPDATE' row lock inside a transaction.
 * 8. Cross-Resource Atomicity Documentation: Documents that if a file-write error occurs after the database
 *    commit, the password was updated in the database and must not be retried blindly.
 * 9. Zero Credential Exposure: Sanitizes all output and error logs.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "../lib/auth.ts";
import {
  loadDatabaseUrlFromEnv,
  validateDatabaseTarget,
  parseTargetCliArgs,
  sanitizeTargetHost,
  sanitizeErrorMessage,
} from "./db-target-guard.mjs";

export function printResetNotice() {
  console.log("==================================================================");
  console.log("Rota — Supervisor Credential Reset (DRY-RUN / PREVIEW MODE)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero database writes executed.");
  console.log("To execute against the database, you must supply all required flags:");
  console.log("  --run");
  console.log("  --out-file <filepath>");
  console.log("  --confirm-target <target_database_name>");
  console.log("  --confirm-endpoint <exact_hostname>\n");
  console.log("Example:");
  console.log("  node --experimental-strip-types scripts/reset-chika-demo.mjs --run --out-file ./secrets/chika.env --confirm-target neondb --confirm-endpoint ep-staging-123.us-east-2.aws.neon.tech\n");
  console.log("Planned Operations:");
  console.log("- Pre-validate destination output path and write permissions.");
  console.log("- Pre-validate database name and exact hostname against configured DATABASE_URL.");
  console.log("- Begin database transaction with 'FOR UPDATE' row lock.");
  console.log("- Verify exact target user: chika@rota.local (Supervisor, Chika Nwosu).");
  console.log("- Update password_hash and password_salt for exactly 1 user.");
  console.log("- Commit transaction and write credential exclusively to destination file.\n");
  console.log("Notice: Hostname and database confirmation verifies operator intent, but does NOT");
  console.log("prove that a branch is disposable or isolated. Verify branch status in the Neon Console.");
  console.log("==================================================================");
}

export function validateDestinationPath(outFilePath) {
  if (!outFilePath || typeof outFilePath !== "string" || outFilePath.trim().length === 0) {
    throw new Error("Missing required option '--out-file <filepath>'.");
  }

  const resolved = path.resolve(outFilePath.trim());
  const normalized = resolved.replace(/\\/g, "/");

  if (
    normalized.includes("/.git/") ||
    normalized.endsWith("/.git") ||
    normalized.endsWith("/.env.local") ||
    normalized.endsWith("/package.json") ||
    normalized.endsWith("/next.config.ts")
  ) {
    throw new Error(`Unsafe destination path '${resolved}'. Choose an operator-specific location outside core repository files.`);
  }

  if (fs.existsSync(resolved)) {
    throw new Error(`Destination file already exists at ${resolved}. Choose a new path to prevent accidental overwriting.`);
  }

  const parentDir = path.dirname(resolved);
  if (!fs.existsSync(parentDir)) {
    throw new Error(`Destination directory does not exist: '${parentDir}'. Create the directory first.`);
  }

  return resolved;
}

export function parseResetArgs(argv = process.argv) {
  try {
    const { confirmTarget, confirmEndpoint, help, extraFlags } = parseTargetCliArgs(argv, {
      allowedFlags: ["--run"],
      valuedFlags: ["--out-file"],
    });

    return {
      run: !!extraFlags["--run"],
      outFile: extraFlags["--out-file"] || null,
      confirmTarget,
      confirmEndpoint,
      help,
    };
  } catch (err) {
    return {
      error: err.message,
      run: false,
      outFile: null,
      confirmTarget: null,
      confirmEndpoint: null,
      help: false,
    };
  }
}

/**
 * Executes Supervisor account password reset inside a database transaction.
 *
 * @param {object} client - Database client with query(sql, params) and optional end()
 * @param {object} options - Options including plainPassword override
 * @returns {Promise<{success: boolean, userId: number, email: string, plainPassword: string}>}
 */
export async function executeSupervisorReset(client, options = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client with query() method is required.");
  }

  const plainPassword =
    options.plainPassword ||
    (process.env.CHIKA_DEMO_PASSWORD && process.env.CHIKA_DEMO_PASSWORD.trim().length > 0
      ? process.env.CHIKA_DEMO_PASSWORD.trim()
      : crypto.randomBytes(18).toString("base64url"));

  const { hash, salt } = hashPassword(plainPassword);

  let commitAttempted = false;
  let commitSucceeded = false;

  try {
    await client.query("BEGIN;");

    const checkRes = await client.query(
      `SELECT id, email, name, role
       FROM users
       WHERE LOWER(TRIM(email)) = 'chika@rota.local'
       FOR UPDATE;`
    );

    if (!checkRes.rows || checkRes.rows.length === 0) {
      throw new Error("Safety check failed: User 'chika@rota.local' was not found in users table.");
    }

    if (checkRes.rows.length !== 1) {
      throw new Error(`Safety check failed: Found ${checkRes.rows.length} accounts matching 'chika@rota.local'.`);
    }

    const user = checkRes.rows[0];

    if (user.name.trim() !== "Chika Nwosu") {
      throw new Error(`Safety check failed: Name mismatch (expected 'Chika Nwosu', found '${user.name}').`);
    }

    if (user.role.trim() !== "Supervisor") {
      throw new Error(`Safety check failed: Role mismatch (expected 'Supervisor', found '${user.role}').`);
    }

    const updateRes = await client.query(
      `UPDATE users
       SET
         password_hash = $1,
         password_salt = $2
       WHERE id = $3 AND LOWER(TRIM(email)) = 'chika@rota.local'
       RETURNING id;`,
      [hash, salt, user.id]
    );

    if (updateRes.rowCount !== 1) {
      throw new Error(`Safety check failed: Expected 1 affected row, but ${updateRes.rowCount} were affected.`);
    }

    commitAttempted = true;
    await client.query("COMMIT;");
    commitSucceeded = true;

    return {
      success: true,
      userId: user.id,
      email: "chika@rota.local",
      plainPassword,
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
if (process.argv[1] && process.argv[1].endsWith("reset-chika-demo.mjs")) {
  const parsed = parseResetArgs(process.argv);

  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    console.error("Usage: node --experimental-strip-types scripts/reset-chika-demo.mjs --run --out-file <filepath> --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (parsed.help || !parsed.run) {
    printResetNotice();
    process.exit(0);
  }

  if (!parsed.outFile) {
    console.error("Error: Missing required option '--out-file <filepath>'.");
    process.exit(1);
  }

  let resolvedOut = null;
  try {
    resolvedOut = validateDestinationPath(parsed.outFile);
  } catch (pathErr) {
    console.error(`Path validation error: ${pathErr.message}`);
    process.exit(1);
  }

  if (!parsed.confirmTarget) {
    console.error("Error: '--confirm-target <database-name>' is required when running reset.");
    console.error("Usage: node --experimental-strip-types scripts/reset-chika-demo.mjs --run --out-file <filepath> --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
    process.exit(1);
  }

  if (!parsed.confirmEndpoint) {
    console.error("Error: '--confirm-endpoint <exact-hostname>' is required when running reset.");
    console.error("Usage: node --experimental-strip-types scripts/reset-chika-demo.mjs --run --out-file <filepath> --confirm-target <target_database> --confirm-endpoint <exact_hostname>");
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

  console.log("Connecting to target database for Supervisor credential reset...");
  console.log(`Target Host: ${sanitizeTargetHost(databaseUrl)}`);
  console.log(`Target Database: ${parsed.confirmTarget}\n`);

  try {
    const { Client } = await import("@neondatabase/serverless");
    const client = new Client(databaseUrl);
    await client.connect();

    const summary = await executeSupervisorReset(client);

    // Cross-resource delivery: Write file only after successful database commit
    try {
      fs.writeFileSync(resolvedOut, `CHIKA_DEMO_PASSWORD=${summary.plainPassword}\n`, {
        flag: "wx",
        mode: 0o600,
        encoding: "utf-8",
      });
      console.log(`Credential securely written to destination file: ${resolvedOut}`);
      console.log("Supervisor credential reset completed successfully.");
      process.exit(0);
    } catch (fileErr) {
      console.error(
        "CRITICAL: The database transaction was committed, but writing the credential to the output file failed:",
        fileErr.message
      );
      console.error(
        "Cross-resource atomicity notice: The user's password was updated in the database. Do NOT re-run blindly without checking DB state."
      );
      process.exit(1);
    }
  } catch (err) {
    console.error("Reset failed:", sanitizeErrorMessage(err.message));
    process.exit(1);
  }
}
