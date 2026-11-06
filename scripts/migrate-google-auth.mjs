/**
 * Safe Migration Script: Google Identity and OAuth Transaction Support
 *
 * Adds:
 * 1. user_identities for Google subject mappings.
 * 2. oauth_transactions for one-time state/PKCE/nonce transactions.
 * 3. Nullable password_hash/password_salt for Google-only accounts.
 * 4. A deferred database invariant preventing users with no authentication method.
 *
 * Safety guarantees:
 * - Dry-run by default. No database connection unless --run is supplied.
 * - Requires exact database name and hostname confirmations.
 * - Runs all DDL inside a guarded transaction.
 * - Does not modify existing users, passwords, roles, or memberships.
 * - Never prints credentials, tokens, or connection strings.
 */

import {
  loadDatabaseUrlFromEnv,
  parseTargetCliArgs,
  sanitizeErrorMessage,
  sanitizeTargetHost,
  validateDatabaseTarget,
} from "./db-target-guard.mjs";

export const AUTH_METHOD_FUNCTION_NAME = "rota_assert_user_has_auth_method";

export const AUTH_METHOD_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION ${AUTH_METHOD_FUNCTION_NAME}()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_user_id integer;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    target_user_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_user_id := OLD.user_id;
  ELSE
    target_user_id := NEW.user_id;
  END IF;

  -- Cascading user deletion has already removed the parent row. Nothing to enforce.
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = target_user_id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM users u
    WHERE u.id = target_user_id
      AND u.password_hash IS NOT NULL
      AND u.password_salt IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1
    FROM user_identities i
    WHERE i.user_id = target_user_id
  ) THEN
    RAISE EXCEPTION 'User % must have a password or linked identity', target_user_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
`;

export const MIGRATION_STATEMENTS = [
  "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;",
  "ALTER TABLE users ALTER COLUMN password_salt DROP NOT NULL;",
  `CREATE TABLE IF NOT EXISTS user_identities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL CHECK (provider = 'google'),
    provider_subject VARCHAR(255) NOT NULL,
    provider_email VARCHAR(255) NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    UNIQUE (provider, provider_subject),
    UNIQUE (user_id, provider)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
    ON user_identities(user_id);`,
  `CREATE TABLE IF NOT EXISTS oauth_transactions (
    id SERIAL PRIMARY KEY,
    state_hash VARCHAR(64) UNIQUE NOT NULL,
    nonce VARCHAR(255) NOT NULL,
    code_verifier VARCHAR(255) NOT NULL,
    purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('login', 'link')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    redirect_after VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
  );`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_transactions_expires_at
    ON oauth_transactions(expires_at);`,
  AUTH_METHOD_FUNCTION_DDL,
  "DROP TRIGGER IF EXISTS rota_users_auth_method_check ON users;",
  `CREATE CONSTRAINT TRIGGER rota_users_auth_method_check
    AFTER INSERT OR UPDATE OR DELETE ON users
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION ${AUTH_METHOD_FUNCTION_NAME}();`,
  "DROP TRIGGER IF EXISTS rota_identity_auth_method_check ON user_identities;",
  `CREATE CONSTRAINT TRIGGER rota_identity_auth_method_check
    AFTER INSERT OR UPDATE OR DELETE ON user_identities
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION ${AUTH_METHOD_FUNCTION_NAME}();`,
];

export const MIGRATION_DDL = MIGRATION_STATEMENTS.join("\n");

export const EXISTING_USERS_CHECK_SQL = `
  SELECT COUNT(*)::INTEGER AS invalid_count
  FROM users
  WHERE password_hash IS NULL OR password_salt IS NULL;
`;

export const REQUIRED_TABLES_CHECK_SQL = `
  SELECT
    to_regclass('public.users') AS users_table,
    to_regclass('public.team_memberships') AS memberships_table;
`;

export function printDryRunNotice() {
  console.log("==================================================================");
  console.log("Rota - Google Authentication Schema Migration (DRY-RUN / PREVIEW)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero database writes executed.");
  console.log("To execute against the database, supply all required flags:");
  console.log("  --run");
  console.log("  --confirm-target <target_database_name>");
  console.log("  --confirm-endpoint <exact_hostname>\n");
  console.log("Planned Operations:");
  console.log("1. Verify users and team_memberships tables exist.");
  console.log("2. Abort if any existing user has a null password hash or salt.");
  console.log("3. Make password_hash and password_salt nullable.");
  console.log("4. Create user_identities and oauth_transactions with uniqueness constraints.");
  console.log("5. Create deferred triggers preventing users with no auth method.");
  console.log("6. Commit all changes atomically.\n");
  console.log("Notice: Hostname and database confirmation verifies operator intent, but does NOT");
  console.log("prove that a branch is disposable or isolated. Verify branch status in the Neon Console.");
  console.log("==================================================================");
}

export function parseGoogleAuthMigrationArgs(argv = process.argv) {
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
 * Executes the Google auth schema migration against a connected client.
 *
 * @param {object} client - Database client with query(sql, params) and optional end()
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function executeGoogleAuthMigration(client) {
  if (!client || typeof client.query !== "function") {
    throw new Error("A valid database client with query() method is required.");
  }

  let commitSucceeded = false;

  try {
    const tablesRes = await client.query(REQUIRED_TABLES_CHECK_SQL);
    const tables = tablesRes?.rows?.[0] || {};

    if (!tables.users_table) {
      throw new Error("Table 'users' does not exist in target database. Run auth setup first.");
    }
    if (!tables.memberships_table) {
      throw new Error(
        "Table 'team_memberships' does not exist in target database. Run team-isolation migration first."
      );
    }

    const existingRes = await client.query(EXISTING_USERS_CHECK_SQL);
    const invalidCount = Number(existingRes?.rows?.[0]?.invalid_count || 0);
    if (invalidCount > 0) {
      throw new Error(
        `Pre-migration conflict detected: ${invalidCount} existing user(s) have a null password hash or salt. No changes were made.`
      );
    }

    await client.query("BEGIN;");
    for (const statement of MIGRATION_STATEMENTS) {
      await client.query(statement);
    }
    await client.query("COMMIT;");
    commitSucceeded = true;

    return {
      success: true,
      message:
        "Google authentication schema applied: user identities, OAuth transactions, nullable password fields, and auth-method invariant.",
    };
  } catch (err) {
    if (!commitSucceeded) {
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

if (process.argv[1] && process.argv[1].endsWith("migrate-google-auth.mjs")) {
  const parsed = parseGoogleAuthMigrationArgs(process.argv);

  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    console.error(
      "Usage: node scripts/migrate-google-auth.mjs --run --confirm-target <target_database> --confirm-endpoint <exact_hostname>"
    );
    process.exit(1);
  }

  if (parsed.help || !parsed.run) {
    printDryRunNotice();
    process.exit(0);
  }

  if (!parsed.confirmTarget || !parsed.confirmEndpoint) {
    console.error(
      "Error: '--confirm-target' and '--confirm-endpoint' are required when running the migration."
    );
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

  console.log("Connecting to target database for Google authentication migration...");
  console.log(`Target Host: ${sanitizeTargetHost(databaseUrl)}`);
  console.log(`Target Database: ${parsed.confirmTarget}\n`);

  try {
    const { Client } = await import("@neondatabase/serverless");
    const client = new Client(databaseUrl);
    await client.connect();

    const summary = await executeGoogleAuthMigration(client);
    console.log("Migration completed:", summary.message);
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", sanitizeErrorMessage(err.message));
    process.exit(1);
  }
}
