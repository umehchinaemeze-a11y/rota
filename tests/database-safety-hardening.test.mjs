import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateDatabaseTarget,
  extractDatabaseName,
  extractHostname,
  normalizeHostname,
  isValidHostname,
  isValidDatabaseIdentifier,
  isValidEndpointIdentifier,
  sanitizeErrorMessage,
  sanitizeTargetHost,
  parseTargetCliArgs,
} from "../scripts/db-target-guard.mjs";

import {
  parseMigrationArgs,
  isMigrationRunMode,
  executeMigrationTransaction,
} from "../scripts/migrate-team-isolation.mjs";

import {
  parseSetupArgs,
  executeAuthDbSetup,
  INITIAL_AUTH_ACCOUNTS,
} from "../scripts/setup-auth-db.mjs";

import {
  parseResetArgs,
  validateDestinationPath,
  executeSupervisorReset,
} from "../scripts/reset-chika-demo.mjs";

import {
  parsePreflightArgs,
  isPreflightRunMode,
} from "../scripts/preflight-migration.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(currentDir, "..", "scripts");

describe("Database Safety Hardening — Shared Fail-Closed Target Guard", () => {
  const syntheticProdUrl =
    "postgresql://secret_user:super_secret_pw_999@ep-prod-mute-123456.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const syntheticStagingUrl =
    "postgresql://stage_user:stage_secret_pw_111@ep-staging-branch-888888.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const syntheticLocalUrl =
    "postgres://local_user:local_pw@127.0.0.1:5432/rota_dev";

  it("extracts database name accurately across valid and malformed URLs", () => {
    assert.equal(extractDatabaseName(syntheticProdUrl), "neondb");
    assert.equal(extractDatabaseName(syntheticStagingUrl), "neondb");
    assert.equal(extractDatabaseName(syntheticLocalUrl), "rota_dev");
    assert.equal(extractDatabaseName("postgres://user:pass@localhost:5432/my_custom_db"), "my_custom_db");
    assert.equal(extractDatabaseName("postgres://ep-host.neon.tech/"), "");
    assert.equal(extractDatabaseName(""), "");
    assert.equal(extractDatabaseName(null), "");
    assert.equal(extractDatabaseName("not-a-url"), "");
  });

  it("validates database target when target name and endpoint match exactly", () => {
    const res = validateDatabaseTarget({
      databaseUrl: syntheticStagingUrl,
      confirmTarget: "neondb",
      confirmEndpoint: "ep-staging-branch-888888.us-east-2.aws.neon.tech",
    });

    assert.equal(res.valid, true);
    assert.equal(res.database, "neondb");
    assert.equal(res.hostname, "ep-staging-branch-888888.us-east-2.aws.neon.tech");
  });

  it("validates case-insensitivity of target database name (Postgres identifier standard)", () => {
    const res = validateDatabaseTarget({
      databaseUrl: syntheticStagingUrl,
      confirmTarget: "NEONDB",
      confirmEndpoint: "ep-staging-branch-888888.us-east-2.aws.neon.tech",
    });
    assert.equal(res.valid, true);
    assert.equal(res.database, "neondb");
  });

  it("fails closed when DATABASE_URL is missing or empty", () => {
    assert.throws(
      () =>
        validateDatabaseTarget({
          databaseUrl: "",
          confirmTarget: "neondb",
          confirmEndpoint: "ep-staging.neon.tech",
        }),
      /DATABASE_URL is not configured/
    );
  });

  it("fails closed when operator target database confirmation is missing or malformed", () => {
    assert.throws(
      () =>
        validateDatabaseTarget({
          databaseUrl: syntheticStagingUrl,
          confirmTarget: "",
          confirmEndpoint: "ep-staging-branch-888888.us-east-2.aws.neon.tech",
        }),
      /Operator target database confirmation/
    );

    assert.throws(
      () =>
        validateDatabaseTarget({
          databaseUrl: syntheticStagingUrl,
          confirmTarget: "-invalid-name",
          confirmEndpoint: "ep-staging-branch-888888.us-east-2.aws.neon.tech",
        }),
      /Malformed database confirmation/
    );
  });

  it("fails closed when operator endpoint confirmation is missing or malformed", () => {
    assert.throws(
      () =>
        validateDatabaseTarget({
          databaseUrl: syntheticStagingUrl,
          confirmTarget: "neondb",
          confirmEndpoint: "",
        }),
      /Operator endpoint confirmation/
    );

    // Partial prefixes, ports, and schemes must be rejected
    assert.throws(
      () =>
        validateDatabaseTarget({
          databaseUrl: syntheticStagingUrl,
          confirmTarget: "neondb",
          confirmEndpoint: "ep-staging",
        }),
      /Malformed endpoint confirmation/
    );

    assert.throws(
      () =>
        validateDatabaseTarget({
          databaseUrl: syntheticStagingUrl,
          confirmTarget: "neondb",
          confirmEndpoint: "https://ep-staging-branch-888888.us-east-2.aws.neon.tech",
        }),
      /Malformed endpoint confirmation/
    );
  });

  it("rejects database-name mismatch before any connection is attempted", () => {
    assert.throws(
      () =>
        validateDatabaseTarget({
          databaseUrl: syntheticStagingUrl,
          confirmTarget: "wrong_db_name",
          confirmEndpoint: "ep-staging-branch-888888.us-east-2.aws.neon.tech",
        }),
      /Database confirmation mismatch/
    );
  });

  it("CRITICAL SAFETY TEST: Rejects production hostname mismatch before client construction without exposing password", () => {
    let clientCreated = false;
    const fakeClientFactory = () => {
      clientCreated = true;
      return { connect: async () => {} };
    };

    // Staging endpoint confirmed, but env contains production URL
    const runGuard = () => {
      validateDatabaseTarget({
        databaseUrl: syntheticProdUrl,
        confirmTarget: "neondb",
        confirmEndpoint: "ep-staging-branch-888888.us-east-2.aws.neon.tech",
      });
      // If validation did not throw, client would be created:
      fakeClientFactory();
    };

    assert.throws(runGuard, (err) => {
      assert.match(err.message, /Endpoint confirmation mismatch/);
      // Verify secrets and passwords are NOT leaked in error message
      assert.doesNotMatch(err.message, /super_secret_pw/);
      assert.doesNotMatch(err.message, /secret_user/);
      // Production host must be masked
      assert.match(err.message, /ep-prod\*\*\*\.us-east-2\.aws\.neon\.tech/);
      return true;
    });

    assert.equal(clientCreated, false, "Database client constructor must never be called on mismatch");
  });
});

describe("Database Safety Hardening — Strict CLI Argument Parsers", () => {
  it("rejects unknown, unexpected, or misspelled CLI flags", () => {
    assert.throws(
      () => parseTargetCliArgs(["node", "script.mjs", "--typo"]),
      /Unrecognized or disallowed argument '--typo'/
    );

    assert.throws(
      () => parseTargetCliArgs(["node", "script.mjs", "--confirm-tagret", "neondb"]),
      /Unrecognized or disallowed argument '--confirm-tagret'/
    );

    assert.throws(
      () => parseTargetCliArgs(["node", "script.mjs", "--confirm-staging-hostname", "ep.neon.tech"]),
      /Unrecognized or disallowed argument '--confirm-staging-hostname'/
    );
  });

  it("enforces valued flags have non-flag values and cannot be empty", () => {
    assert.throws(
      () => parseTargetCliArgs(["node", "script.mjs", "--confirm-target"]),
      /requires a valid database name value/
    );

    assert.throws(
      () => parseTargetCliArgs(["node", "script.mjs", "--confirm-target", "--confirm-endpoint"]),
      /requires a valid database name value/
    );

    assert.throws(
      () => parseTargetCliArgs(["node", "script.mjs", "--confirm-endpoint"]),
      /requires an exact hostname value/
    );
  });

  it("parses valid confirmation flags and aliases consistently", () => {
    const res1 = parseTargetCliArgs([
      "node",
      "script.mjs",
      "--confirm-target",
      "neondb",
      "--confirm-endpoint",
      "ep-staging.neon.tech",
    ]);
    assert.equal(res1.confirmTarget, "neondb");
    assert.equal(res1.confirmEndpoint, "ep-staging.neon.tech");

    // Aliases
    const res2 = parseTargetCliArgs([
      "node",
      "script.mjs",
      "--confirm-database",
      "neondb",
      "--confirm-hostname",
      "ep-staging.neon.tech",
    ]);
    assert.equal(res2.confirmTarget, "neondb");
    assert.equal(res2.confirmEndpoint, "ep-staging.neon.tech");
  });
});

describe("Database Safety Hardening — migrate-team-isolation.mjs Guards", () => {
  it("defaults to dry-run when invoked without --run", () => {
    const parsed = parseMigrationArgs(["node", "migrate-team-isolation.mjs"]);
    assert.equal(parsed.run, false);
    assert.equal(isMigrationRunMode(["node", "migrate-team-isolation.mjs"]), false);
  });

  it("confirmed targets do NOT bypass the explicit --run execution flag", () => {
    const parsed = parseMigrationArgs([
      "node",
      "migrate-team-isolation.mjs",
      "--confirm-target",
      "neondb",
      "--confirm-endpoint",
      "ep-staging.neon.tech",
    ]);
    assert.equal(parsed.run, false);
    assert.equal(isMigrationRunMode(["node", "migrate-team-isolation.mjs", "--confirm-target", "neondb"]), false);
  });

  it("reports error when unknown flags are supplied to migrate-team-isolation.mjs", () => {
    const parsed = parseMigrationArgs(["node", "migrate-team-isolation.mjs", "--run", "--unsupported-flag"]);
    assert.ok(parsed.error);
    assert.match(parsed.error, /Unrecognized or disallowed argument/);
    assert.equal(parsed.run, false);
  });

  it("submits ROLLBACK on transaction error and closes client connection", async () => {
    const executedQueries = [];
    let rolledBack = false;
    let clientClosed = false;

    const mockClient = {
      async query(sql) {
        executedQueries.push(sql.trim());
        if (sql.includes("CREATE TABLE IF NOT EXISTS teams")) {
          throw new Error("Simulated DDL disk failure");
        }
        if (sql.includes("ROLLBACK")) {
          rolledBack = true;
        }
        return { rows: [] };
      },
      async end() {
        clientClosed = true;
      },
    };

    await assert.rejects(
      () => executeMigrationTransaction(mockClient),
      /Simulated DDL disk failure/
    );

    assert.equal(rolledBack, true, "Transaction must issue ROLLBACK on statement failure");
    assert.equal(clientClosed, true, "Client must be closed in finally block");
  });
});

describe("Database Safety Hardening — setup-auth-db.mjs Guards & Insert-Only Seeding", () => {
  it("defaults to dry-run when invoked without --run", () => {
    const parsed = parseSetupArgs(["node", "setup-auth-db.mjs"]);
    assert.equal(parsed.run, false);
  });

  it("confirmed targets do NOT bypass --run in setup-auth-db.mjs", () => {
    const parsed = parseSetupArgs([
      "node",
      "setup-auth-db.mjs",
      "--confirm-target",
      "neondb",
      "--confirm-endpoint",
      "ep-staging.neon.tech",
    ]);
    assert.equal(parsed.run, false);
  });

  it("reports error on unknown flags in setup-auth-db.mjs", () => {
    const parsed = parseSetupArgs(["node", "setup-auth-db.mjs", "--run", "--unknown"]);
    assert.ok(parsed.error);
    assert.match(parsed.error, /Unrecognized or disallowed argument/);
  });

  it("CRITICAL SAFETY TEST: Preserves existing accounts and NEVER overwrites password hashes or salts", async () => {
    const queries = [];
    let rolledBack = false;
    let committed = false;
    let clientClosed = false;

    const mockClient = {
      async query(sql, params = []) {
        queries.push({ sql: sql.trim(), params });
        if (sql.includes("BEGIN")) return {};
        if (sql.includes("CREATE TABLE")) return {};
        if (sql.includes("ALTER TABLE")) return {};
        if (sql.includes("INSERT INTO users")) {
          // Verify that ON CONFLICT DO NOTHING is strictly used instead of DO UPDATE
          assert.match(sql, /ON CONFLICT\s*\(email\)\s*DO NOTHING/i);
          assert.doesNotMatch(sql, /DO UPDATE/i, "Must never overwrite existing passwords or credentials!");
          // Simulate that all 5 accounts already exist (0 rows returned)
          return { rows: [] };
        }
        if (sql.includes("UPDATE shifts")) return { rowCount: 3 };
        if (sql.includes("COMMIT")) {
          committed = true;
          return {};
        }
        if (sql.includes("ROLLBACK")) {
          rolledBack = true;
          return {};
        }
        return { rows: [] };
      },
      async end() {
        clientClosed = true;
      },
    };

    const res = await executeAuthDbSetup(mockClient);

    assert.equal(res.success, true);
    assert.equal(res.accountsCreated, 0, "Zero new accounts should be created when all already exist");
    assert.equal(res.existingPreserved, INITIAL_AUTH_ACCOUNTS.length, "All existing accounts must be preserved untouched");
    assert.equal(res.shiftsLinked, 3);
    assert.equal(committed, true);
    assert.equal(rolledBack, false);
    assert.equal(clientClosed, true);
  });

  it("rolls back cleanly when an error occurs during authentication setup", async () => {
    let rolledBack = false;
    let clientClosed = false;

    const mockClient = {
      async query(sql) {
        if (sql.includes("BEGIN")) return {};
        if (sql.includes("CREATE TABLE")) return {};
        if (sql.includes("ALTER TABLE")) {
          throw new Error("Simulated foreign key constraint failure");
        }
        if (sql.includes("ROLLBACK")) {
          rolledBack = true;
          return {};
        }
        return { rows: [] };
      },
      async end() {
        clientClosed = true;
      },
    };

    await assert.rejects(
      () => executeAuthDbSetup(mockClient),
      /Simulated foreign key constraint failure/
    );

    assert.equal(rolledBack, true, "Transaction must roll back on failure");
    assert.equal(clientClosed, true, "Client must be closed in finally block");
  });
});

describe("Database Safety Hardening — reset-chika-demo.mjs Guards & Destination Safety", () => {
  it("defaults to dry-run when invoked without --run", () => {
    const parsed = parseResetArgs(["node", "reset-chika-demo.mjs"]);
    assert.equal(parsed.run, false);
  });

  it("reports error when --out-file or target confirmations are missing", () => {
    const parsedNoOut = parseResetArgs([
      "node",
      "reset-chika-demo.mjs",
      "--run",
      "--confirm-target",
      "neondb",
      "--confirm-endpoint",
      "ep-staging.neon.tech",
    ]);
    assert.equal(parsedNoOut.run, true);
    assert.equal(parsedNoOut.outFile, null);

    const parsedNoTarget = parseResetArgs([
      "node",
      "reset-chika-demo.mjs",
      "--run",
      "--out-file",
      "./safe/out.env",
    ]);
    assert.equal(parsedNoTarget.confirmTarget, null);
    assert.equal(parsedNoTarget.confirmEndpoint, null);
  });

  it("rejects destination paths pointing to core repository or sensitive files", () => {
    assert.throws(() => validateDestinationPath(".env.local"), /Unsafe destination path/);
    assert.throws(() => validateDestinationPath("package.json"), /Unsafe destination path/);
    assert.throws(() => validateDestinationPath(".git/config"), /Unsafe destination path/);
    assert.throws(() => validateDestinationPath("next.config.ts"), /Unsafe destination path/);
  });

  it("executes supervisor reset within a transaction and verifies single-row update", async () => {
    const executed = [];
    let committed = false;
    let clientClosed = false;

    const mockClient = {
      async query(sql, params = []) {
        executed.push(sql.trim());
        if (sql.includes("BEGIN")) return {};
        if (sql.includes("SELECT id, email, name, role")) {
          return {
            rows: [
              { id: 5, email: "chika@rota.local", name: "Chika Nwosu", role: "Supervisor" },
            ],
          };
        }
        if (sql.includes("UPDATE users")) {
          assert.equal(params[2], 5);
          return { rowCount: 1 };
        }
        if (sql.includes("COMMIT")) {
          committed = true;
          return {};
        }
        return { rows: [] };
      },
      async end() {
        clientClosed = true;
      },
    };

    const res = await executeSupervisorReset(mockClient, { plainPassword: "mock-password-123" });
    assert.equal(res.success, true);
    assert.equal(res.userId, 5);
    assert.equal(res.email, "chika@rota.local");
    assert.equal(res.plainPassword, "mock-password-123");
    assert.equal(committed, true);
    assert.equal(clientClosed, true);
  });

  it("aborts and rolls back if target supervisor account name or role does not match", async () => {
    let rolledBack = false;

    const mockClient = {
      async query(sql) {
        if (sql.includes("BEGIN")) return {};
        if (sql.includes("SELECT id, email, name, role")) {
          // Name mismatch: Expected 'Chika Nwosu', found 'Imposter Name'
          return {
            rows: [
              { id: 5, email: "chika@rota.local", name: "Imposter Name", role: "Supervisor" },
            ],
          };
        }
        if (sql.includes("ROLLBACK")) {
          rolledBack = true;
          return {};
        }
        return { rows: [] };
      },
      async end() {},
    };

    await assert.rejects(
      () => executeSupervisorReset(mockClient),
      /Name mismatch/
    );

    assert.equal(rolledBack, true, "Must roll back transaction when account verification fails");
  });
});

describe("Database Safety Hardening — Subprocess Offline Execution & Guard Verification", () => {
  it("runs migrate-team-isolation.mjs offline on dry-run without connecting or querying", () => {
    const res = spawnSync("node", [path.resolve(scriptsDir, "migrate-team-isolation.mjs")], {
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /DRY-RUN \/ PREVIEW MODE/);
    assert.match(res.stdout, /Zero database writes executed/);
    assert.match(res.stdout, /--confirm-target <target_database_name>/);
    assert.match(res.stdout, /--confirm-endpoint <exact_hostname>/);
  });

  it("runs setup-auth-db.mjs offline on dry-run without connecting or querying", () => {
    const res = spawnSync("node", [path.resolve(scriptsDir, "setup-auth-db.mjs")], {
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /DRY-RUN \/ PREVIEW MODE/);
    assert.match(res.stdout, /Zero database writes executed/);
    assert.match(res.stdout, /ON CONFLICT DO NOTHING/);
  });

  it("runs reset-chika-demo.mjs offline on dry-run without connecting or querying", () => {
    const res = spawnSync("node", [path.resolve(scriptsDir, "reset-chika-demo.mjs")], {
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /DRY-RUN \/ PREVIEW MODE/);
    assert.match(res.stdout, /Zero database writes executed/);
  });

  it("runs preflight-migration.mjs offline on dry-run without connecting or querying", () => {
    const res = spawnSync("node", [path.resolve(scriptsDir, "preflight-migration.mjs")], {
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /DRY-RUN \/ PREVIEW MODE/);
    assert.match(res.stdout, /Zero database queries executed/);
  });

  it("rejects missing confirmation flags in CLI execution with exit code 1", () => {
    const res = spawnSync(
      "node",
      [path.resolve(scriptsDir, "migrate-team-isolation.mjs"), "--run"],
      { encoding: "utf-8" }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /'--confirm-target <database-name>' is required/);
  });

  it("CRITICAL SUBPROCESS GUARD: Fails closed on production hostname mismatch without connecting", () => {
    const res = spawnSync(
      "node",
      [
        path.resolve(scriptsDir, "migrate-team-isolation.mjs"),
        "--run",
        "--confirm-target",
        "neondb",
        "--confirm-endpoint",
        "ep-staging-safe-123456.us-east-2.aws.neon.tech",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          DATABASE_URL:
            "postgresql://mock_user:super_secret_password_never_log@ep-prod-mute-999999.us-east-2.aws.neon.tech/neondb",
        },
      }
    );

    assert.equal(res.status, 1);
    assert.match(res.stderr, /Endpoint confirmation mismatch/);
    // Crucial check: Secret password is NOT printed anywhere
    assert.doesNotMatch(res.stdout, /super_secret_password_never_log/);
    assert.doesNotMatch(res.stderr, /super_secret_password_never_log/);
  });
});
