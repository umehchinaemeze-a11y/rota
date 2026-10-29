import test from "node:test";
import assert from "node:assert/strict";
import { createLazyNeonClient } from "../lib/db.ts";

test("Lazy Neon Database Client — Offline Compatibility Tests", async (t) => {
  await t.test("importing lib/db.ts with DATABASE_URL unset does not throw", async () => {
    const savedUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      const dbModule = await import(`../lib/db.ts?test_import_${Date.now()}`);
      assert.ok(dbModule.sql, "Exported sql client should be defined");
      assert.strictEqual(typeof dbModule.sql, "function", "Exported sql should be a callable function/proxy");
    } finally {
      if (savedUrl !== undefined) {
        process.env.DATABASE_URL = savedUrl;
      }
    }
  });

  await t.test("executing a query without DATABASE_URL throws the expected configuration error", async () => {
    const client = createLazyNeonClient({
      getDatabaseUrl: () => undefined,
      neonFactory: () => {
        throw new Error("Factory should not be called when URL is missing");
      },
    });

    assert.throws(
      () => {
        client`SELECT 1;`;
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, "DATABASE_URL is not configured.");
        return true;
      }
    );
  });

  await t.test("executing a query with empty or whitespace DATABASE_URL throws configuration error", async () => {
    const client = createLazyNeonClient({
      getDatabaseUrl: () => "   ",
      neonFactory: () => {
        throw new Error("Factory should not be called when URL is empty");
      },
    });

    assert.throws(
      () => {
        client`SELECT 1;`;
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, "DATABASE_URL is not configured.");
        return true;
      }
    );
  });

  await t.test("mocked Neon client receives original template strings and interpolated parameter values unchanged", async () => {
    let capturedStrings = null;
    let capturedValues = [];
    let factoryCalledWithUrl = null;

    const mockClient = (strings, ...values) => {
      capturedStrings = strings;
      capturedValues = values;
      return Promise.resolve([{ id: 1, email: values[0] }]);
    };

    const client = createLazyNeonClient({
      getDatabaseUrl: () => "postgres://mock-db-host/test",
      neonFactory: (url) => {
        factoryCalledWithUrl = url;
        return mockClient;
      },
    });

    const paramEmail = "operator@example.com";
    const paramRole = "Admin";
    const result = await client`SELECT * FROM users WHERE email = ${paramEmail} AND role = ${paramRole};`;

    assert.strictEqual(factoryCalledWithUrl, "postgres://mock-db-host/test");
    assert.ok(Array.isArray(capturedStrings), "Should pass TemplateStringsArray");
    assert.strictEqual(capturedStrings[0], "SELECT * FROM users WHERE email = ");
    assert.strictEqual(capturedStrings[1], " AND role = ");
    assert.strictEqual(capturedStrings[2], ";");
    assert.deepStrictEqual(capturedValues, ["operator@example.com", "Admin"]);
    assert.deepStrictEqual(result, [{ id: 1, email: "operator@example.com" }]);
  });

  await t.test("repeated calls reuse the cached client without re-invoking factory", async () => {
    let factoryInvocations = 0;

    const mockClient = (strings, ...values) => {
      return Promise.resolve([{ count: values[0] }]);
    };

    const client = createLazyNeonClient({
      getDatabaseUrl: () => "postgres://mock-db-host/test",
      neonFactory: () => {
        factoryInvocations++;
        return mockClient;
      },
    });

    assert.strictEqual(factoryInvocations, 0, "Client must not be initialized before first call");

    await client`SELECT ${1};`;
    assert.strictEqual(factoryInvocations, 1, "Factory should be called on first query");

    await client`SELECT ${2};`;
    assert.strictEqual(factoryInvocations, 1, "Factory must not be called again on second query");

    await client`SELECT ${3};`;
    assert.strictEqual(factoryInvocations, 1, "Factory must not be called again on third query");
  });

  await t.test("failed client initialization does not leave an invalid client cached", async () => {
    let attempt = 0;

    const mockClient = (strings, ...values) => {
      return Promise.resolve([{ status: "recovered" }]);
    };

    const client = createLazyNeonClient({
      getDatabaseUrl: () => "postgres://mock-db-host/test",
      neonFactory: () => {
        attempt++;
        if (attempt === 1) {
          throw new Error("Simulated transient factory failure");
        }
        return mockClient;
      },
    });

    assert.throws(
      () => {
        client`SELECT 1;`;
      },
      (err) => {
        assert.strictEqual(err.message, "Simulated transient factory failure");
        return true;
      }
    );

    const result = await client`SELECT 1;`;
    assert.strictEqual(attempt, 2, "Factory must be called again after previous failure");
    assert.deepStrictEqual(result, [{ status: "recovered" }]);
  });

  await t.test("property lookups on the proxy do not trigger initialization", () => {
    let factoryCalled = false;

    const client = createLazyNeonClient({
      getDatabaseUrl: () => undefined,
      neonFactory: () => {
        factoryCalled = true;
        return () => Promise.resolve([]);
      },
    });

    // Function properties and standard lookups should read from target function without triggering getClient
    assert.strictEqual(client.then, undefined, "client.then is naturally undefined on a function");
    assert.strictEqual(typeof client.name, "string");
    assert.strictEqual(typeof client.length, "number");
    assert.strictEqual(factoryCalled, false, "Property lookups must not invoke factory");
  });

  await t.test("custom test options are strictly rejected in production", () => {
    const savedEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";

      assert.throws(
        () => {
          createLazyNeonClient({
            neonFactory: () => (() => Promise.resolve([])),
          });
        },
        (err) => {
          assert.strictEqual(err.message, "Custom database client options are not permitted in production.");
          return true;
        }
      );

      assert.throws(
        () => {
          createLazyNeonClient({
            getDatabaseUrl: () => "postgres://injected",
          });
        },
        (err) => {
          assert.strictEqual(err.message, "Custom database client options are not permitted in production.");
          return true;
        }
      );
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
