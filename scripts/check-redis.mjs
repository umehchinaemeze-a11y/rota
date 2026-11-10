#!/usr/bin/env node

/**
 * Diagnostic Tool: Safe Redis Connectivity Verification
 *
 * Verifies real connectivity to the configured Redis instance:
 * 1. Confirms whether REDIS_URL is present in the environment.
 * 2. Attempts a native TCP/TLS RESP connection and evaluates PING -> PONG.
 * 3. Performs an active probe cycle (SET -> GET -> DEL) to confirm write/read usability.
 * 4. Measures round-trip latency.
 *
 * Strict Security Rules:
 * - NEVER prints REDIS_URL, passwords, hostnames, ports, tokens, or credentials.
 * - Categorizes errors into sanitized diagnostic summaries without leaking stack traces.
 * - Explicitly distinguishes between real Redis connections and in-memory mock testing.
 * - Exits with code 0 on verified connectivity; exits with code 1 if unconfigured or unreachable.
 */

import { checkRedisConnectivity } from "../lib/redis.ts";

async function main() {
  console.log("============================================================");
  console.log("              ROTA REDIS CONNECTIVITY CHECK                 ");
  console.log("============================================================");

  const report = await checkRedisConnectivity();

  console.log(`Redis Configured : ${report.configured ? "YES" : "NO"}`);
  console.log(
    `Redis Reachable  : ${report.reachable ? "YES" : "NO"}${
      report.latencyMs ? ` (${report.latencyMs}ms roundtrip)` : ""
    }`
  );
  console.log(`Redis Usable     : ${report.usable ? "YES" : "NO"}`);
  console.log(`Status           : ${report.statusText}`);

  if (report.error) {
    console.log(`Diagnostic Info  : ${report.error}`);
  }

  console.log("------------------------------------------------------------");

  if (!report.configured) {
    console.log("Notice: No real Redis service is currently configured.");
    console.log("Required environment variable:");
    console.log("  REDIS_URL=redis://default:<password>@<host>:<port>");
    console.log("  (or rediss:// for TLS-encrypted Redis clusters)\n");
    console.log("Operating Rules by Environment:");
    console.log("  - Development / Test (NODE_ENV!=production):");
    console.log("    Falls back to safe in-memory sliding window rate limiting.");
    console.log("  - Production (NODE_ENV=production):");
    console.log("    Protected authentication and billing endpoints fail closed (HTTP 503)");
    console.log("    to prevent unthrottled access across distributed instances.");
    console.log("============================================================");
    process.exit(1);
  }

  if (!report.reachable || !report.usable) {
    console.log("Warning: Redis service is configured but currently unreachable or degraded.");
    console.log("Protected authentication and billing endpoints will return HTTP 503 in production");
    console.log("until connectivity is restored.");
    console.log("============================================================");
    process.exit(1);
  }

  console.log("Success: Real Redis service is configured, reachable, and usable.");
  console.log("Distributed atomic sliding-window rate limiting and caching are active.");
  console.log("============================================================");
  process.exit(0);
}

main().catch(() => {
  console.error("Diagnostic execution error.");
  process.exit(1);
});

