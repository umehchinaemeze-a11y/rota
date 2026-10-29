import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseIndexMigrationArgs,
  executeDefaultMembershipIndexMigration,
  INDEX_NAME,
  INDEX_DDL,
  CONFLICT_CHECK_SQL,
  INDEX_INSPECTION_SQL,
  TABLE_CHECK_SQL,
} from "../scripts/migrate-default-membership-index.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(currentDir, "..", "scripts");
const scriptPath = path.resolve(scriptsDir, "migrate-default-membership-index.mjs");

describe("Default Membership Partial Unique Index Migration — CLI Argument Parser", () => {
  it("defaults to dry-run mode when --run is omitted", () => {
    const res = parseIndexMigrationArgs(["node", "script.mjs"]);
    assert.equal(res.run, false);
    assert.equal(res.confirmTarget, null);
    assert.equal(res.confirmEndpoint, null);
  });

  it("parses valid CLI flags accurately", () => {
    const res = parseIndexMigrationArgs([
      "node",
      "script.mjs",
      "--run",
      "--confirm-target",
      "neondb",
      "--confirm-endpoint",
      "ep-staging-123.us-east-2.aws.neon.tech",
    ]);
    assert.equal(res.run, true);
    assert.equal(res.confirmTarget, "neondb");
    assert.equal(res.confirmEndpoint, "ep-staging-123.us-east-2.aws.neon.tech");
  });

  it("rejects unknown or misspelled flags with actionable error", () => {
    const res = parseIndexMigrationArgs(["node", "script.mjs", "--runn"]);
    assert.ok(res.error);
    assert.match(res.error, /Unrecognized or disallowed argument '--runn'/);
    assert.equal(res.run, false);
  });
});

describe("Default Membership Partial Unique Index Migration — Subprocess Safety & Dry-Run", () => {
  it("runs offline on dry-run by default with zero database writes", () => {
    const res = spawnSync("node", [scriptPath], { encoding: "utf-8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /DRY-RUN \/ PREVIEW/);
    assert.match(res.stdout, /Zero database writes executed/);
    assert.match(res.stdout, /CREATE UNIQUE INDEX idx_team_memberships_user_default/);
  });

  it("rejects execution without --confirm-target with exit code 1", () => {
    const res = spawnSync("node", [scriptPath, "--run"], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /'--confirm-target <database-name>' is required/);
  });

  it("rejects execution without --confirm-endpoint with exit code 1", () => {
    const res = spawnSync(
      "node",
      [scriptPath, "--run", "--confirm-target", "neondb"],
      { encoding: "utf-8" }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /'--confirm-endpoint <exact-hostname>' is required/);
  });

  it("fails closed on endpoint hostname mismatch and never leaks credentials", () => {
    const res = spawnSync(
      "node",
      [
        scriptPath,
        "--run",
        "--confirm-target",
        "neondb",
        "--confirm-endpoint",
        "ep-staging-safe-123.us-east-2.aws.neon.tech",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          DATABASE_URL:
            "postgresql://mock_user:super_secret_pw_leak_test_999@ep-prod-mute-888.us-east-2.aws.neon.tech/neondb",
        },
      }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Endpoint confirmation mismatch/);
    assert.doesNotMatch(res.stdout, /super_secret_pw_leak_test_999/);
    assert.doesNotMatch(res.stderr, /super_secret_pw_leak_test_999/);
  });
});

describe("Default Membership Partial Unique Index Migration — In-Memory Client Execution", () => {
  function createMockClient(options = {}) {
    const executedQueries = [];

    return {
      executedQueries,
      query: async (sqlText, params = []) => {
        const normalized = String(sqlText).trim();
        executedQueries.push({ text: normalized, params });

        // Simulate table check
        if (normalized.includes("to_regclass")) {
          return { rows: [{ table_exists: options.tableExists !== false ? "team_memberships" : null }] };
        }

        // Simulate index inspection
        if (normalized.includes("pg_indexes")) {
          if (options.existingIndexDef) {
            return {
              rows: [{ indexname: INDEX_NAME, indexdef: options.existingIndexDef }],
            };
          }
          return { rows: [] };
        }

        // Simulate conflict check
        if (normalized.includes("HAVING COUNT(*) > 1")) {
          if (options.conflicts && options.conflicts.length > 0) {
            return { rows: options.conflicts };
          }
          return { rows: [] };
        }

        // Simulate DDL execution failure
        if (options.failOnDdl && normalized.includes("CREATE UNIQUE INDEX")) {
          throw new Error("Simulated DDL failure");
        }

        return { rowCount: 1, rows: [] };
      },
    };
  }

  it("aborts when team_memberships table does not exist in target database", async () => {
    const client = createMockClient({ tableExists: false });
    await assert.rejects(
      () => executeDefaultMembershipIndexMigration(client),
      /Table 'team_memberships' does not exist in target database/
    );
  });

  it("detects existing index with matching definition and exits cleanly without re-executing DDL", async () => {
    const matchingDef =
      "CREATE UNIQUE INDEX idx_team_memberships_user_default ON public.team_memberships USING btree (user_id) WHERE (is_default = true)";
    const client = createMockClient({ existingIndexDef: matchingDef });

    const result = await executeDefaultMembershipIndexMigration(client);
    assert.equal(result.success, true);
    assert.equal(result.alreadyExisted, true);
    assert.equal(result.indexCreated, false);
    assert.match(result.message, /already exists with matching unique definition/);

    const ddlExecuted = client.executedQueries.some((q) => q.text.includes("CREATE UNIQUE INDEX"));
    assert.equal(ddlExecuted, false, "Must not re-execute DDL when index already exists");
  });

  it("aborts with error if index exists with unexpected or conflicting definition", async () => {
    const conflictingDef =
      "CREATE INDEX idx_team_memberships_user_default ON public.team_memberships (user_id)"; // non-unique, no WHERE clause
    const client = createMockClient({ existingIndexDef: conflictingDef });

    await assert.rejects(
      () => executeDefaultMembershipIndexMigration(client),
      /already exists with an unexpected definition/
    );
  });

  it("detects conflicting users with multiple default memberships and aborts without modifying data", async () => {
    const client = createMockClient({
      conflicts: [
        { user_id: 10, default_count: 2 },
        { user_id: 15, default_count: 3 },
      ],
    });

    await assert.rejects(
      () => executeDefaultMembershipIndexMigration(client),
      /Pre-migration conflict detected: 2 user\(s\) currently have multiple default memberships/
    );

    const ddlExecuted = client.executedQueries.some((q) => q.text.includes("CREATE UNIQUE INDEX"));
    assert.equal(ddlExecuted, false, "Must never execute DDL when conflicting data is detected");
  });

  it("creates unique partial index inside a transaction when no conflicts exist", async () => {
    const client = createMockClient();

    const result = await executeDefaultMembershipIndexMigration(client);
    assert.equal(result.success, true);
    assert.equal(result.alreadyExisted, false);
    assert.equal(result.indexCreated, true);

    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.ok(queryTexts.includes("BEGIN;"), "Must begin explicit transaction");
    assert.ok(queryTexts.some((q) => q.includes("CREATE UNIQUE INDEX")), "Must execute index DDL");
    assert.ok(queryTexts.includes("COMMIT;"), "Must commit transaction");
  });

  it("rolls back cleanly if DDL creation encounters an error", async () => {
    const client = createMockClient({ failOnDdl: true });

    await assert.rejects(
      () => executeDefaultMembershipIndexMigration(client),
      /Simulated DDL failure/
    );

    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.ok(queryTexts.includes("ROLLBACK;"), "Must execute ROLLBACK upon DDL failure");
  });
});
