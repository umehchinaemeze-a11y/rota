import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeTargetHost,
  calculateLatencyPercentiles,
  parseLoadTestArgs,
  PROHIBITED_HOST_PATTERNS,
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
});
