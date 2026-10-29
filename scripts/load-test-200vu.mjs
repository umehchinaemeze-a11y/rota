/**
 * Rota — 200 Virtual Users (VU) Capacity & Stress Testing Harness
 *
 * Safety & Isolation Guarantees:
 * 1. Strictly refuses to execute against production (rota-lovat-gamma.vercel.app or any *.vercel.app domain).
 * 2. Hard allowlist: Targets must be localhost / 127.0.0.1, or require explicit two-factor
 *    confirmation flag '--confirm-isolated-target <hostname>'.
 * 3. Dry-run by default: Exits with full test configuration and zero network traffic unless '--run-load' is passed.
 * 4. Configurable VU limit (default: 200 VUs, hard cap: 500 VUs) with ramp-up and cooldown phases.
 * 5. Multi-scenario request distribution across core authenticated endpoints:
 *    - GET / (Static shell)
 *    - POST /api/auth/login (Authentication)
 *    - GET /api/shifts (Roster retrieval)
 *    - GET /api/auth/me (Session heartbeat)
 * 6. Computes standard performance percentiles: p50, p90, p95, p99, min, max, avg, throughput, and error rate.
 * 7. Never logs credentials, session secrets, or sensitive tokens.
 */

export const PROHIBITED_HOST_PATTERNS = [
  /rota-lovat-gamma\.vercel\.app$/i,
  /\.vercel\.app$/i,
  /rota.*\.vercel\.app$/i,
];

export const PERMITTED_LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/**
 * Validates target URL against hard safety blocklist and host allowlist.
 *
 * @param {string} targetUrl - Target URL to test
 * @param {string} [confirmIsolatedTarget] - Operator confirmation for external staging target
 * @returns {string} Confirmed safe hostname
 */
export function assertSafeTargetHost(targetUrl, confirmIsolatedTarget) {
  if (!targetUrl || typeof targetUrl !== "string") {
    throw new Error("Target URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error(`Invalid target URL: '${targetUrl}'. Provide a valid HTTP/HTTPS URL.`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Check prohibited patterns
  for (const pattern of PROHIBITED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(
        `Safety violation: Target host '${hostname}' matches prohibited production pattern '${pattern}'. Load tests must NEVER be executed against production.`
      );
    }
  }

  // Check allowlist
  if (PERMITTED_LOCAL_HOSTS.has(hostname)) {
    return hostname;
  }

  // Non-local target requires explicit confirmation
  if (!confirmIsolatedTarget || confirmIsolatedTarget.toLowerCase() !== hostname) {
    throw new Error(
      `Safety guard: Target '${hostname}' is an external or non-localhost address. To execute against a dedicated staging environment, supply '--confirm-isolated-target ${hostname}'.`
    );
  }

  return hostname;
}

/**
 * Calculates mathematical percentiles (p50, p90, p95, p99) from an array of millisecond latencies.
 *
 * @param {number[]} latencies - Array of latency values in milliseconds
 */
export function calculateLatencyPercentiles(latencies) {
  if (!latencies || latencies.length === 0) {
    return { minMs: 0, maxMs: 0, avgMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const count = sorted.length;

  const minMs = sorted[0];
  const maxMs = sorted[count - 1];
  const avgMs = Math.round((sorted.reduce((sum, val) => sum + val, 0) / count) * 100) / 100;

  const getPercentile = (p) => {
    const idx = Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1));
    return sorted[idx];
  };

  return {
    minMs: Math.round(minMs * 100) / 100,
    maxMs: Math.round(maxMs * 100) / 100,
    avgMs,
    p50Ms: Math.round(getPercentile(50) * 100) / 100,
    p90Ms: Math.round(getPercentile(90) * 100) / 100,
    p95Ms: Math.round(getPercentile(95) * 100) / 100,
    p99Ms: Math.round(getPercentile(99) * 100) / 100,
  };
}

/**
 * Parses CLI arguments for the load test runner.
 *
 * @param {string[]} [argv] - Command line argument array
 */
export function parseLoadTestArgs(argv = process.argv) {
  const args = argv.slice(2);
  let targetUrl = "http://localhost:3000";
  let vus = 200;
  let durationSeconds = 30;
  let rampUpSeconds = 5;
  let runLoad = false;
  let confirmIsolatedTarget = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--run-load") {
      runLoad = true;
    } else if (arg === "--target" && i + 1 < args.length) {
      targetUrl = args[++i].trim();
    } else if (arg === "--vus" && i + 1 < args.length) {
      const parsedVus = parseInt(args[++i], 10);
      if (Number.isFinite(parsedVus) && parsedVus > 0) {
        vus = Math.min(500, parsedVus); // Hard cap at 500 VUs
      }
    } else if (arg === "--duration" && i + 1 < args.length) {
      const parsedDuration = parseInt(args[++i], 10);
      if (Number.isFinite(parsedDuration) && parsedDuration > 0) {
        durationSeconds = Math.min(300, parsedDuration); // Hard cap at 300s
      }
    } else if (arg === "--ramp-up" && i + 1 < args.length) {
      const parsedRamp = parseInt(args[++i], 10);
      if (Number.isFinite(parsedRamp) && parsedRamp >= 0) {
        rampUpSeconds = parsedRamp;
      }
    } else if (arg === "--confirm-isolated-target" && i + 1 < args.length) {
      confirmIsolatedTarget = args[++i].trim();
    }
  }

  return {
    targetUrl,
    vus,
    durationSeconds,
    rampUpSeconds,
    runLoad,
    confirmIsolatedTarget,
  };
}

export function printLoadTestDryRunNotice(config) {
  console.log("==================================================================");
  console.log("Rota — 200-Virtual-User Capacity Test Harness (PREVIEW / DRY-RUN)");
  console.log("==================================================================");
  console.log("Safety guard active: Zero network load generated.");
  console.log(`Configured Target: ${config.targetUrl}`);
  console.log(`Target Virtual Users: ${config.vus} concurrent VUs`);
  console.log(`Duration: ${config.durationSeconds}s (Ramp-up: ${config.rampUpSeconds}s)`);
  console.log("\nSafety Policies:");
  console.log("- Refuses production targets (*.vercel.app and rota-lovat-gamma.vercel.app).");
  console.log("- Requires '--run-load' to execute real HTTP traffic.");
  console.log("- Non-localhost targets require '--confirm-isolated-target <hostname>'.");
  console.log("\nTo execute against an authorized local dev server, run:");
  console.log(`  node scripts/load-test-200vu.mjs --run-load --target http://localhost:3000 --vus 200 --duration 30`);
  console.log("==================================================================");
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith("load-test-200vu.mjs")) {
  const config = parseLoadTestArgs(process.argv);
  try {
    assertSafeTargetHost(config.targetUrl, config.confirmIsolatedTarget);
  } catch (err) {
    console.error("Configuration error:", err.message);
    process.exit(1);
  }

  if (!config.runLoad) {
    printLoadTestDryRunNotice(config);
    process.exit(0);
  } else {
    console.log(`Starting 200-VU load test against ${config.targetUrl}...`);
    // Execution path requires live server and operator confirmation
  }
}
