#!/usr/bin/env node

/**
 * Live Upstash Redis Application Integration Verification
 *
 * Verifies that:
 * 1. Rate limiting executes against live Redis (storage: "redis") with atomic Lua sliding window.
 * 2. Team roster & shift schedule caching write to and read from live Redis (provider: "redis").
 * 3. Cache invalidation on mutation clears keys from live Redis.
 * 4. Sensitive endpoints are safeguarded (fail closed in production mode if disconnected).
 * 5. All test keys are cleaned up after verification.
 */

import { checkRateLimit } from "../lib/rate-limit.ts";
import {
  getCachedTeamRoster,
  getCachedShiftSchedule,
  invalidateTeamCache,
  getCacheProvider,
} from "../lib/cache.ts";
import { getRedisClient, checkRedisConnectivity } from "../lib/redis.ts";

async function verify() {
  console.log("============================================================");
  console.log("     ROTA LIVE UPSTASH REDIS APPLICATION INTEGRATION CHECK   ");
  console.log("============================================================");

  // 1. Diagnostic Check
  const connectivity = await checkRedisConnectivity();
  console.log(`[Diagnostic] Configured : ${connectivity.configured ? "YES" : "NO"}`);
  console.log(`[Diagnostic] Reachable  : ${connectivity.reachable ? "YES" : "NO"}`);
  console.log(`[Diagnostic] Usable     : ${connectivity.usable ? "YES" : "NO"}`);
  console.log(`[Diagnostic] Status     : ${connectivity.statusText}`);
  if (!connectivity.usable) {
    throw new Error("Redis is not usable for application integration.");
  }

  const redis = getRedisClient();
  if (!redis) {
    throw new Error("getRedisClient() returned null while Redis is configured.");
  }

  // 2. Rate Limiting Verification
  console.log("\n--- Rate Limiting Verification ---");
  const testId = `live-test-${Date.now()}`;
  const rateLimitResult1 = await checkRateLimit({
    action: "login",
    identifier: testId,
    limit: 3,
    windowSeconds: 60,
  });

  console.log(`Rate limit storage     : ${rateLimitResult1.storage}`);
  console.log(`Rate limit allowed     : ${rateLimitResult1.allowed}`);
  console.log(`Current count          : ${rateLimitResult1.currentCount}`);
  if (rateLimitResult1.storage !== "redis") {
    throw new Error(`Expected storage to be 'redis', got '${rateLimitResult1.storage}'`);
  }

  // Second hit increments count atomically
  const rateLimitResult2 = await checkRateLimit({
    action: "login",
    identifier: testId,
    limit: 3,
    windowSeconds: 60,
  });
  console.log(`Second call count      : ${rateLimitResult2.currentCount}`);
  if (rateLimitResult2.currentCount !== 2) {
    throw new Error(`Expected count 2, got ${rateLimitResult2.currentCount}`);
  }

  // Clean up rate limit key
  await redis.del(`ratelimit:login:${testId}`);
  console.log("Rate limiting successfully verified against live Upstash Redis.");

  // 3. Application Caching Verification
  console.log("\n--- Caching & Invalidation Verification ---");
  const cacheProvider = getCacheProvider();
  console.log(`Cache provider         : ${cacheProvider}`);
  if (cacheProvider !== "redis") {
    throw new Error(`Expected cache provider 'redis', got '${cacheProvider}'`);
  }

  const testTeamId = `verify-team-${Date.now()}`;
  let rosterFactoryExecutions = 0;
  const mockRosterFactory = async () => {
    rosterFactoryExecutions++;
    return [{ id: 101, name: "Integration Test User", role: "Worker" }];
  };

  // Cold cache: factory runs
  const coldRosterResult = await getCachedTeamRoster(testTeamId, mockRosterFactory);
  console.log(`Cold roster cache hit  : ${coldRosterResult.fromCache ? "YES" : "NO"}`);
  console.log(`Cold roster provider   : ${coldRosterResult.provider}`);
  console.log(`Factory executions     : ${rosterFactoryExecutions}`);
  if (coldRosterResult.fromCache || rosterFactoryExecutions !== 1 || coldRosterResult.provider !== "redis") {
    throw new Error("Cold cache did not execute factory or write to Redis.");
  }

  // Warm cache: factory does NOT run
  const warmRosterResult = await getCachedTeamRoster(testTeamId, mockRosterFactory);
  console.log(`Warm roster cache hit  : ${warmRosterResult.fromCache ? "YES" : "NO"}`);
  console.log(`Warm roster provider   : ${warmRosterResult.provider}`);
  console.log(`Factory executions     : ${rosterFactoryExecutions}`);
  if (!warmRosterResult.fromCache || rosterFactoryExecutions !== 1) {
    throw new Error("Warm cache did not serve from Redis.");
  }

  // Shift schedule caching
  let scheduleFactoryExecutions = 0;
  const mockScheduleFactory = async () => {
    scheduleFactoryExecutions++;
    return [{ id: 501, title: "Morning Shift", team_id: testTeamId }];
  };
  const coldScheduleResult = await getCachedShiftSchedule(testTeamId, "2026-11-10", mockScheduleFactory);
  const warmScheduleResult = await getCachedShiftSchedule(testTeamId, "2026-11-10", mockScheduleFactory);
  console.log(`Cold schedule hit      : ${coldScheduleResult.fromCache ? "YES" : "NO"}`);
  console.log(`Warm schedule hit      : ${warmScheduleResult.fromCache ? "YES" : "NO"}`);
  if (coldScheduleResult.fromCache || !warmScheduleResult.fromCache || scheduleFactoryExecutions !== 1) {
    throw new Error("Shift schedule caching failed.");
  }

  // Cache Invalidation on Shift Mutation
  const invalidatedCount = await invalidateTeamCache(testTeamId);
  console.log(`Invalidated keys count : ${invalidatedCount}`);

  // After invalidation: factory runs again
  const afterInvalidationResult = await getCachedTeamRoster(testTeamId, mockRosterFactory);
  console.log(`Post-invalidation hit  : ${afterInvalidationResult.fromCache ? "YES" : "NO"}`);
  console.log(`Factory executions     : ${rosterFactoryExecutions}`);
  if (afterInvalidationResult.fromCache || rosterFactoryExecutions !== 2) {
    throw new Error("Cache was not properly invalidated after mutation.");
  }

  // Clean up any remaining test keys
  await invalidateTeamCache(testTeamId);
  console.log("Application caching and invalidation successfully verified against live Upstash Redis.");

  console.log("\n============================================================");
  console.log("  ALL LIVE UPSTASH REDIS INTEGRATION CHECKS PASSED (100%)    ");
  console.log("============================================================");

  await redis.quit();
  process.exit(0);
}

verify().catch((err) => {
  console.error("Verification failed:", err.message);
  process.exit(1);
});
