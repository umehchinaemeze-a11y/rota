import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeTargetHost,
  calculateLatencyPercentiles,
  parseLoadTestArgs,
  PROHIBITED_HOST_PATTERNS,
  handleIsolatedRoute,
  createIsolatedLoadTestServer,
  startIsolatedLoadTestServer,
  runConcurrentLoadTest,
  signTestSessionToken,
  TEST_USERS,
  SCENARIOS,
} from "../scripts/load-test-200vu.mjs";

describe("Load Testing — Target Host Safety & Production Guard", () => {
  it("strictly refuses to execute against the live production deployment (rota-lovat-gamma.vercel.app)", () => {
    assert.throws(
      () => {
        assertSafeTargetHost("https://rota-lovat-gamma.vercel.app");
      },
      (err) => {
        assert.ok(err.message.includes("Safety violation"));
        assert.ok(err.message.includes("prohibited production pattern"));
        return true;
      }
    );
  });

  it("strictly refuses to execute against any *.vercel.app deployment", () => {
    assert.throws(
      () => {
        assertSafeTargetHost("https://rota-staging-preview.vercel.app");
      },
      (err) => {
        assert.ok(err.message.includes("Safety violation"));
        assert.ok(err.message.includes("prohibited production pattern"));
        return true;
      }
    );
  });

  it("permits execution against local development servers without extra confirmation", () => {
    assert.equal(assertSafeTargetHost("http://localhost:3000"), "localhost");
    assert.equal(assertSafeTargetHost("http://127.0.0.1:3000"), "127.0.0.1");
    assert.equal(assertSafeTargetHost("http://[::1]:3000"), "[::1]");
  });

  it("requires explicit two-factor confirmation for external or non-localhost staging hosts", () => {
    // Unconfirmed external staging host throws
    assert.throws(
      () => {
        assertSafeTargetHost("http://staging-internal.lan:8080");
      },
      (err) => {
        assert.ok(err.message.includes("Safety guard"));
        assert.ok(err.message.includes("--confirm-isolated-target staging-internal.lan"));
        return true;
      }
    );

    // Confirmed staging host succeeds
    const verified = assertSafeTargetHost(
      "http://staging-internal.lan:8080",
      "staging-internal.lan"
    );
    assert.equal(verified, "staging-internal.lan");
  });

  it("rejects malformed or empty URLs safely", () => {
    assert.throws(() => assertSafeTargetHost(""), /Target URL is required/);
    assert.throws(() => assertSafeTargetHost(null), /Target URL is required/);
    assert.throws(() => assertSafeTargetHost("not-a-url"), /Invalid target URL/);
  });
});

describe("Load Testing — Latency Percentile & Statistics Engine", () => {
  it("accurately calculates p50, p90, p95, p99, min, max, and avg on known distributions", () => {
    // Generate an ordered distribution from 1ms to 100ms
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1);

    const metrics = calculateLatencyPercentiles(latencies);
    assert.equal(metrics.minMs, 1);
    assert.equal(metrics.maxMs, 100);
    assert.equal(metrics.avgMs, 50.5);
    assert.equal(metrics.p50Ms, 50);
    assert.equal(metrics.p90Ms, 90);
    assert.equal(metrics.p95Ms, 95);
    assert.equal(metrics.p99Ms, 99);
  });

  it("handles empty latency arrays gracefully without crashing or returning NaN", () => {
    const metrics = calculateLatencyPercentiles([]);
    assert.equal(metrics.minMs, 0);
    assert.equal(metrics.maxMs, 0);
    assert.equal(metrics.avgMs, 0);
    assert.equal(metrics.p50Ms, 0);
    assert.equal(metrics.p95Ms, 0);
    assert.equal(metrics.p99Ms, 0);
  });

  it("parses CLI arguments with safety caps on VUs and duration", () => {
    const defaultArgs = parseLoadTestArgs(["node", "scripts/load-test-200vu.mjs"]);
    assert.equal(defaultArgs.vus, 200);
    assert.equal(defaultArgs.durationSeconds, 30);
    assert.equal(defaultArgs.runLoad, false); // Default dry-run

    // Caps excessive VUs to maximum allowed cap (500)
    const cappedArgs = parseLoadTestArgs([
      "node",
      "scripts/load-test-200vu.mjs",
      "--vus",
      "9999",
      "--duration",
      "600",
      "--run-load",
    ]);
    assert.equal(cappedArgs.vus, 500); // capped at 500
    assert.equal(cappedArgs.durationSeconds, 300); // capped at 300
    assert.equal(cappedArgs.runLoad, true);
  });

  it("parses --isolated-server and --save-report flags properly", () => {
    const args = parseLoadTestArgs([
      "node",
      "scripts/load-test-200vu.mjs",
      "--isolated-server",
      "--save-report",
    ]);
    assert.equal(args.isolatedServer, true);
    assert.equal(args.saveReport, true);
  });
});

describe("Load Testing — Isolated Test Environment & Endpoints", () => {
  it("creates HTTP server instance with createIsolatedLoadTestServer", () => {
    const server = createIsolatedLoadTestServer(3098, "127.0.0.1");
    assert.ok(server);
    assert.equal(typeof server.listen, "function");
  });

  it("serves static application shell on GET / with HTTP 200", async () => {
    const res = await handleIsolatedRoute({ method: "GET", path: "/" });
    assert.equal(res.status, 200);
    assert.ok(res.headers["content-type"]?.includes("text/html"));
    const html = await res.text();
    assert.ok(html.includes("Rota"));
  });

  it("authenticates synthetic test manager on POST /api/auth/login", async () => {
    const manager = TEST_USERS[0];
    const res = await handleIsolatedRoute({
      method: "POST",
      path: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: manager.email, password: manager.password }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.email, manager.email);
    assert.equal(body.user.role, "Manager");
    assert.equal(body.user.teamId, 9999);

    const setCookie = res.headers["set-cookie"];
    assert.ok(setCookie && setCookie.includes("rota_session="));
    assert.ok(setCookie.includes("HttpOnly"));
  });

  it("rejects invalid login credentials on POST /api/auth/login with HTTP 401", async () => {
    const res = await handleIsolatedRoute({
      method: "POST",
      path: "/api/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "invalid@example.com", password: "WrongPassword!" }),
    });
    assert.equal(res.status, 401);
  });

  it("serves workspace shifts on GET /api/shifts for authenticated users", async () => {
    const token = signTestSessionToken(TEST_USERS[0]);
    const res = await handleIsolatedRoute({
      method: "GET",
      path: "/api/shifts",
      headers: { cookie: `rota_session=${token}` },
    });
    assert.equal(res.status, 200);
    const shifts = await res.json();
    assert.ok(Array.isArray(shifts));
    assert.ok(shifts.length > 0);
    assert.equal(shifts[0].team_id, 9999);
  });

  it("rejects unauthenticated requests on GET /api/shifts with HTTP 401", async () => {
    const res = await handleIsolatedRoute({ method: "GET", path: "/api/shifts" });
    assert.equal(res.status, 401);
  });

  it("serves keyset-paginated activity feed on GET /api/activity?limit=20", async () => {
    const token = signTestSessionToken(TEST_USERS[0]);
    const res = await handleIsolatedRoute({
      method: "GET",
      path: "/api/activity?limit=20",
      headers: { cookie: `rota_session=${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.activities));
    assert.equal(body.activities.length, 20);
    assert.equal(body.hasMore, true);
    assert.ok(typeof body.nextCursor === "string" && body.nextCursor.length > 0);
  });

  it("serves session user on GET /api/auth/me", async () => {
    const worker = TEST_USERS[1];
    const token = signTestSessionToken(worker);
    const res = await handleIsolatedRoute({
      method: "GET",
      path: "/api/auth/me",
      headers: { cookie: `rota_session=${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, worker.userId);
    assert.equal(body.user.email, worker.email);
    assert.equal(body.user.teamId, 9999);
  });

  it("enforces multi-tenant workspace isolation and rejects foreign team IDs with HTTP 403", async () => {
    const foreignToken = signTestSessionToken({
      userId: 7777,
      email: "foreign@othercorp.internal",
      name: "Foreign User",
      role: "Manager",
      teamId: 1234, // Foreign team ID
    });
    const res = await handleIsolatedRoute({
      method: "GET",
      path: "/api/shifts",
      headers: { cookie: `rota_session=${foreignToken}` },
    });
    assert.equal(res.status, 403);
  });
});

describe("Load Testing — Concurrent Worker Execution Simulation", () => {
  it("executes concurrent requests and aggregates latency percentiles without errors", async () => {
    const results = await runConcurrentLoadTest({
      targetUrl: "http://127.0.0.1:3097",
      vus: 10,
      durationSeconds: 1,
      rampUpSeconds: 0,
      isolatedServer: true,
    });

    assert.equal(results.vus, 10);
    assert.ok(results.totalRequests > 0, "Must record requests");
    assert.ok(results.totalSuccess > 0, "Must record successful requests");
    assert.equal(results.overallErrorRate, 0, "Error rate must be 0%");
    assert.ok(results.throughput > 0, "Throughput must be positive");
    assert.ok(results.percentiles.p50Ms >= 0, "p50 must be recorded");
    assert.ok(results.percentiles.p95Ms >= 0, "p95 must be recorded");

    // All 5 endpoints must have recorded requests
    for (const scenario of SCENARIOS) {
      const ep = results.endpointBreakdown[scenario.name];
      assert.ok(ep, `Endpoint ${scenario.name} must exist in breakdown`);
      assert.ok(ep.requests > 0, `Endpoint ${scenario.name} must have recorded requests`);
    }
  });
});
