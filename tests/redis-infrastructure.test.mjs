import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  MockRedisClient,
  setCustomRedisClient,
  getRedisClient,
  getRedisStatus,
  isRedisConfigured,
  checkRedisConnectivity,
  sanitizeRedisUrl,
} from "../lib/redis.ts";

import {
  checkRateLimit,
  enforceRateLimit,
  resetRateLimits,
  buildRateLimitHeaders,
  getClientIp,
  PROTECTED_SENSITIVE_ACTIONS,
  createServiceUnavailableResponse,
} from "../lib/rate-limit.ts";

import {
  RedisCacheStore,
  MemoryCacheStore,
  getCachedTeamRoster,
  getCachedShiftSchedule,
  invalidateTeamCache,
  setCustomCacheStore,
  getCacheProvider,
  buildRosterCacheKey,
  buildShiftCalendarCacheKey,
  CACHE_TTL,
} from "../lib/cache.ts";

import { handleLogin } from "../app/api/auth/login/route.ts";
import { handleRegister } from "../app/api/auth/register/route.ts";
import { handleForgotPassword } from "../app/api/auth/forgot-password/route.ts";
import { handleResetPassword } from "../app/api/auth/reset-password/route.ts";
import { handleCreateInvitation } from "../app/api/teams/invitations/route.ts";
import { handleAcceptInvitation } from "../app/api/teams/invitations/accept/route.ts";
import { POST as handlePaystackPost } from "../app/api/billing/paystack/initialize/route.ts";
import { handleGetShifts, handlePostShift } from "../app/api/shifts/route.ts";
import { handlePutShift, handleDeleteShift } from "../app/api/shifts/[id]/route.ts";

describe("Redis Infrastructure & Distributed Rate Limiting", () => {
  let mockRedis;

  beforeEach(async () => {
    mockRedis = new MockRedisClient();
    setCustomRedisClient(mockRedis);
    setCustomCacheStore(new RedisCacheStore(mockRedis));
    await resetRateLimits("ratelimit:", mockRedis);
  });

  afterEach(async () => {
    await resetRateLimits("ratelimit:", mockRedis);
    setCustomRedisClient(null);
    setCustomCacheStore(null);
  });

  describe("Redis Client & Telemetry", () => {
    it("reports configured and connected status accurately without silent fallback claims", async () => {
      const status = getRedisStatus();
      assert.equal(status.configured, true);
      assert.equal(status.connected, true);
      assert.equal(status.provider, "redis");
      assert.equal(isRedisConfigured(), true);

      // Ping check
      const pong = await mockRedis.ping();
      assert.equal(pong, "PONG");
    });

    it("switches telemetry to memory_fallback when unconfigured", () => {
      setCustomRedisClient(null);
      const savedEnv = process.env.REDIS_URL;
      delete process.env.REDIS_URL;

      const status = getRedisStatus();
      assert.equal(status.configured, false);
      assert.equal(status.connected, false);
      assert.equal(status.provider, "memory_fallback");

      if (savedEnv) process.env.REDIS_URL = savedEnv;
    });
  });

  describe("Redis-Backed Rate Limiter (Atomic Sliding Window)", () => {
    it("permits requests up to quota limit and rejects limit + 1 with HTTP 429", async () => {
      const key = "ratelimit:test-quota:192.168.1.10";
      const limit = 5;
      const windowSeconds = 60;
      const now = Date.now();

      for (let i = 1; i <= limit; i++) {
        const result = await checkRateLimit(key, limit, windowSeconds, now + i * 10, {
          redisClient: mockRedis,
        });
        assert.equal(result.allowed, true, `Hit #${i} should be allowed`);
        assert.equal(result.currentCount, i);
        assert.equal(result.remaining, limit - i);
        assert.equal(result.storage, "redis");
      }

      // Limit + 1 must be blocked
      const blocked = await checkRateLimit(key, limit, windowSeconds, now + (limit + 1) * 10, {
        redisClient: mockRedis,
      });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.remaining, 0);
      assert.equal(blocked.currentCount, 5);
      assert.ok(blocked.resetSeconds > 0);
      assert.equal(blocked.storage, "redis");
    });

    it("resets quota after sliding-window duration elapses (TTL expiry)", async () => {
      const key = "ratelimit:test-expiry:192.168.1.20";
      const limit = 3;
      const windowSeconds = 2; // 2 seconds
      const t0 = 1000000;

      // Exhaust limit at t0
      for (let i = 0; i < limit; i++) {
        const res = await checkRateLimit(key, limit, windowSeconds, t0 + i * 100, {
          redisClient: mockRedis,
        });
        assert.equal(res.allowed, true);
      }

      // Immediate subsequent call is blocked
      const blocked = await checkRateLimit(key, limit, windowSeconds, t0 + 500, {
        redisClient: mockRedis,
      });
      assert.equal(blocked.allowed, false);

      // Advance time past the 2-second window (t0 + 2500ms)
      const afterWindow = await checkRateLimit(key, limit, windowSeconds, t0 + 2500, {
        redisClient: mockRedis,
      });
      assert.equal(afterWindow.allowed, true, "Quota must reset after window expiry");
      assert.equal(afterWindow.currentCount, 1);
      assert.equal(afterWindow.remaining, limit - 1);
    });

    it("guarantees atomic quota enforcement under concurrent parallel requests", async () => {
      const key = "ratelimit:test-concurrency:10.0.0.1";
      const limit = 10;
      const windowSeconds = 30;
      const totalConcurrent = 25;
      const now = Date.now();

      // Fire 25 simultaneous checks with randomized offset within 50ms
      const promises = Array.from({ length: totalConcurrent }, (_, i) =>
        checkRateLimit(key, limit, windowSeconds, now + i * 2, {
          redisClient: mockRedis,
        })
      );

      const results = await Promise.all(promises);
      const allowedCount = results.filter((r) => r.allowed).length;
      const blockedCount = results.filter((r) => !r.allowed).length;

      assert.equal(allowedCount, limit, `Exactly ${limit} requests must succeed`);
      assert.equal(blockedCount, totalConcurrent - limit, `Exactly ${totalConcurrent - limit} requests must be throttled`);
    });

    it("generates correct rate-limiting response headers", async () => {
      const req = new Request("http://localhost/test", {
        headers: { "x-forwarded-for": "203.0.113.195" },
      });

      const { response, result } = await enforceRateLimit(req, {
        action: "header-check",
        limit: 1,
        windowSeconds: 60,
        redisClient: mockRedis,
      });

      assert.equal(response, null, "First request must be allowed");
      const headersFirst = buildRateLimitHeaders(result);
      assert.equal(headersFirst["X-RateLimit-Limit"], "1");
      assert.equal(headersFirst["X-RateLimit-Remaining"], "0");
      assert.equal(headersFirst["X-RateLimit-Storage"], "redis");
      assert.equal(headersFirst["Retry-After"], undefined);

      // Second request -> Blocked
      const { response: blockedResp, result: blockedResult } = await enforceRateLimit(req, {
        action: "header-check",
        limit: 1,
        windowSeconds: 60,
        redisClient: mockRedis,
      });

      assert.ok(blockedResp !== null);
      assert.equal(blockedResp.status, 429);
      assert.equal(blockedResp.headers.get("X-RateLimit-Limit"), "1");
      assert.equal(blockedResp.headers.get("X-RateLimit-Remaining"), "0");
      assert.equal(blockedResp.headers.get("X-RateLimit-Storage"), "redis");
      assert.ok(blockedResp.headers.get("Retry-After") !== null);

      const body = await blockedResp.json();
      assert.match(body.error, /Too many requests/i);
    });

    it("falls back to in-memory sliding window gracefully when Redis fails", async () => {
      mockRedis.setSimulateFailure(true);

      const key = "ratelimit:test-failover:127.0.0.1";
      const limit = 2;
      const windowSeconds = 60;
      const now = Date.now();

      // First call: Redis throws, falls back to memory store, succeeds
      const res1 = await checkRateLimit(key, limit, windowSeconds, now, {
        redisClient: mockRedis,
      });
      assert.equal(res1.allowed, true);
      assert.equal(res1.storage, "memory_fallback");

      // Second call: Allowed in memory
      const res2 = await checkRateLimit(key, limit, windowSeconds, now + 10, {
        redisClient: mockRedis,
      });
      assert.equal(res2.allowed, true);
      assert.equal(res2.storage, "memory_fallback");

      // Third call: Blocked in memory
      const res3 = await checkRateLimit(key, limit, windowSeconds, now + 20, {
        redisClient: mockRedis,
      });
      assert.equal(res3.allowed, false);
      assert.equal(res3.storage, "memory_fallback");
    });
  });

  describe("Rate-Limited API Endpoints Verification", () => {
    it("enforces rate limiting on /api/auth/login", async () => {
      const mockSql = async () => [];
      const makeReq = () =>
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.1" },
          body: JSON.stringify({ email: "invalid@example.com", password: "WrongPassword1!" }),
        });

      const loginDeps = {
        sql: mockSql,
        getSecret: () => "test-secret-test-secret-test-secret-1234",
      };

      // Login limit is 10/min
      for (let i = 0; i < 10; i++) {
        const resp = await handleLogin(makeReq(), loginDeps);
        // Should return 401 (invalid credentials) rather than 429
        assert.equal(resp.status, 401);
      }

      // 11th request must be throttled with HTTP 429
      const throttled = await handleLogin(makeReq(), loginDeps);
      assert.equal(throttled.status, 429);
      assert.equal(throttled.headers.get("X-RateLimit-Storage"), "redis");
      assert.ok(throttled.headers.get("Retry-After"));
    });

    it("enforces rate limiting on /api/auth/register", async () => {
      const mockSql = async () => [];
      const makeReq = () =>
        new Request("http://localhost/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.2" },
          body: JSON.stringify({ email: "bad", password: "123", name: "" }),
        });

      for (let i = 0; i < 10; i++) {
        const resp = await handleRegister(makeReq(), { sql: mockSql });
        assert.equal(resp.status, 400); // Validation failure
      }

      const throttled = await handleRegister(makeReq(), { sql: mockSql });
      assert.equal(throttled.status, 429);
      assert.equal(throttled.headers.get("X-RateLimit-Storage"), "redis");
    });

    it("enforces rate limiting on /api/auth/forgot-password", async () => {
      const mockSql = async () => [];
      const makeReq = () =>
        new Request("http://localhost/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.3" },
          body: JSON.stringify({ email: "user@example.com" }),
        });

      // Forgot password limit is 5/min
      for (let i = 0; i < 5; i++) {
        const resp = await handleForgotPassword(makeReq(), { sql: mockSql });
        assert.equal(resp.status, 200);
      }

      const throttled = await handleForgotPassword(makeReq(), { sql: mockSql });
      assert.equal(throttled.status, 429);
      assert.equal(throttled.headers.get("X-RateLimit-Storage"), "redis");
    });

    it("enforces rate limiting on /api/auth/reset-password", async () => {
      const mockSql = async () => [];
      const makeReq = () =>
        new Request("http://localhost/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.4" },
          body: JSON.stringify({ token: "invalid", newPassword: "ValidPassword123!" }),
        });

      // Reset password limit is 5/min
      for (let i = 0; i < 5; i++) {
        const resp = await handleResetPassword(makeReq(), { sql: mockSql });
        assert.equal(resp.status, 400); // Invalid token
      }

      const throttled = await handleResetPassword(makeReq(), { sql: mockSql });
      assert.equal(throttled.status, 429);
      assert.equal(throttled.headers.get("X-RateLimit-Storage"), "redis");
    });

    it("enforces rate limiting on workspace invitations creation", async () => {
      const mockSession = { userId: 1, email: "manager@example.com", name: "Manager", role: "Manager", teamId: 10 };
      const mockSql = async () => [];
      const makeReq = () =>
        new Request("http://localhost/api/teams/invitations", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.5" },
          body: JSON.stringify({ email: "invitee@example.com", role: "Staff" }),
        });

      for (let i = 0; i < 10; i++) {
        const resp = await handleCreateInvitation(makeReq(), {
          sql: mockSql,
          skipRateLimit: false,
          getSessionUser: async () => mockSession,
          getSecret: () => "test-secret-test-secret-test-secret-1234",
        });
        assert.ok(resp.status !== 429);
      }

      const throttled = await handleCreateInvitation(makeReq(), {
        sql: mockSql,
        skipRateLimit: false,
        getSessionUser: async () => mockSession,
        getSecret: () => "test-secret-test-secret-test-secret-1234",
      });
      assert.equal(throttled.status, 429);
      assert.equal(throttled.headers.get("X-RateLimit-Storage"), "redis");
    });

    it("enforces rate limiting on workspace invitation acceptance", async () => {
      const mockSession = { userId: 2, email: "staff@example.com", name: "Staff", role: "Staff", teamId: 0 };
      const makeReq = () =>
        new Request("http://localhost/api/teams/invitations/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.6" },
          body: JSON.stringify({ token: "invalid-token" }),
        });

      for (let i = 0; i < 10; i++) {
        const resp = await handleAcceptInvitation(makeReq(), {
          skipRateLimit: false,
          getSessionUser: async () => mockSession,
          getSecret: () => "test-secret-test-secret-test-secret-1234",
        });
        assert.equal(resp.status, 400); // Invalid token
      }

      const throttled = await handleAcceptInvitation(makeReq(), {
        skipRateLimit: false,
        getSessionUser: async () => mockSession,
        getSecret: () => "test-secret-test-secret-test-secret-1234",
      });
      assert.equal(throttled.status, 429);
      assert.equal(throttled.headers.get("X-RateLimit-Storage"), "redis");
    });

    it("enforces rate limiting on Paystack payment initialization", async () => {
      const makeReq = () =>
        new Request("http://localhost/api/billing/paystack/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.7" },
          body: JSON.stringify({ planCode: "pro" }),
        });

      // 10 initialize requests per minute
      for (let i = 0; i < 10; i++) {
        const resp = await handlePaystackPost(makeReq());
        assert.ok(resp.status !== 429);
      }

      const throttled = await handlePaystackPost(makeReq());
      assert.equal(throttled.status, 429);
      assert.equal(throttled.headers.get("X-RateLimit-Storage"), "redis");
    });
  });

  describe("Redis-Backed Application Caching", () => {
    it("caches team roster in Redis and serves subsequent reads from cache", async () => {
      let dbExecutions = 0;
      const mockDbFactory = async () => {
        dbExecutions++;
        return [
          { userId: 1, name: "Alice", role: "Manager" },
          { userId: 2, name: "Bob", role: "Staff" },
        ];
      };

      const cacheStore = new RedisCacheStore(mockRedis);

      // Miss
      const res1 = await getCachedTeamRoster(42, mockDbFactory, cacheStore);
      assert.equal(res1.fromCache, false);
      assert.equal(res1.provider, "redis");
      assert.equal(dbExecutions, 1);
      assert.equal(res1.data.length, 2);

      // Hit
      const res2 = await getCachedTeamRoster(42, mockDbFactory, cacheStore);
      assert.equal(res2.fromCache, true);
      assert.equal(res2.provider, "redis");
      assert.equal(dbExecutions, 1, "Factory must not be re-called on cache hit");
      assert.deepEqual(res2.data, res1.data);

      // Verify raw Redis key exists
      const rawInRedis = await mockRedis.get(buildRosterCacheKey(42));
      assert.ok(rawInRedis !== null);
      assert.match(rawInRedis, /Alice/);
    });

    it("caches shift schedules independently per date range", async () => {
      let queries = 0;
      const factory = async () => {
        queries++;
        return [{ id: 1, shiftDay: "2026-11-15", employeeName: "Alice" }];
      };

      const cacheStore = new RedisCacheStore(mockRedis);

      // Nov 2026 -> Miss
      const nov = await getCachedShiftSchedule(10, "2026-11", factory, cacheStore);
      assert.equal(nov.fromCache, false);
      assert.equal(queries, 1);

      // Dec 2026 -> Miss
      const dec = await getCachedShiftSchedule(10, "2026-12", factory, cacheStore);
      assert.equal(dec.fromCache, false);
      assert.equal(queries, 2);

      // Nov 2026 -> Hit
      const novHit = await getCachedShiftSchedule(10, "2026-11", factory, cacheStore);
      assert.equal(novHit.fromCache, true);
      assert.equal(queries, 2);
    });

    it("invalidates all team cache entries on shift mutations", async () => {
      const cacheStore = new RedisCacheStore(mockRedis);
      const teamId = 88;

      let rosterLoads = 0;
      let shiftLoads = 0;

      await getCachedTeamRoster(teamId, async () => {
        rosterLoads++;
        return ["Roster Data"];
      }, cacheStore);

      await getCachedShiftSchedule(teamId, "all", async () => {
        shiftLoads++;
        return ["Shift Data"];
      }, cacheStore);

      assert.equal(rosterLoads, 1);
      assert.equal(shiftLoads, 1);

      // Mutate and invalidate
      const invalidatedCount = await invalidateTeamCache(teamId, cacheStore);
      assert.ok(invalidatedCount >= 2, "Invalidation must clear both roster and schedule");

      // Verify subsequent reads query DB again
      await getCachedTeamRoster(teamId, async () => {
        rosterLoads++;
        return ["Roster Data"];
      }, cacheStore);

      await getCachedShiftSchedule(teamId, "all", async () => {
        shiftLoads++;
        return ["Shift Data"];
      }, cacheStore);

      assert.equal(rosterLoads, 2, "Roster factory must re-run after invalidation");
      assert.equal(shiftLoads, 2, "Shift factory must re-run after invalidation");
    });

    it("falls back to memory caching when Redis encounters an error", async () => {
      const cacheStore = new RedisCacheStore(mockRedis);
      mockRedis.setSimulateFailure(true);

      let factoryCalls = 0;
      const factory = async () => {
        factoryCalls++;
        return { message: "Fallback Resilient" };
      };

      // Set & get through fallback
      const first = await getCachedTeamRoster(123, factory, cacheStore);
      assert.equal(first.fromCache, false);
      assert.equal(factoryCalls, 1);

      const second = await getCachedTeamRoster(123, factory, cacheStore);
      assert.equal(second.fromCache, true);
      assert.equal(factoryCalls, 1);
      assert.equal(second.data.message, "Fallback Resilient");
    });
  });

  describe("API Shift Mutation Cache Invalidation Hooks", () => {
    it("invalidates cache when a new shift is created via handlePostShift", async () => {
      const teamId = 15;
      const cacheStore = new RedisCacheStore(mockRedis);

      // Populate schedule cache
      await getCachedShiftSchedule(teamId, "all", async () => [{ id: 1 }], cacheStore);
      assert.ok((await mockRedis.get(buildShiftCalendarCacheKey(teamId, "all"))) !== null);

      const mockSql = async (strings, ...values) => {
        const query = strings.join("?");
        if (query.includes("INSERT INTO shifts")) {
          return [{
            id: 101,
            employee_name: "Alice",
            role: "Manager",
            user_id: 1,
            team_id: teamId,
            shift_day: "2026-11-20",
            created_at: new Date().toISOString(),
          }];
        }
        return [];
      };

      const req = new Request("http://localhost/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shiftDay: "2026-11-20", role: "Manager" }),
      });

      const res = await handlePostShift(req, {
        sql: mockSql,
        getSessionUser: async () => ({
          userId: 1,
          email: "alice@example.com",
          name: "Alice",
          role: "Manager",
          teamId,
        }),
        cacheStore,
      });

      assert.equal(res.status, 201);
      // Cache for team 15 must now be invalidated
      const cachedAfter = await mockRedis.get(buildShiftCalendarCacheKey(teamId, "all"));
      assert.equal(cachedAfter, null, "Cache must be cleared after shift creation");
    });

    it("invalidates cache when a shift is edited via handlePutShift", async () => {
      const teamId = 15;
      const shiftId = "55";
      const cacheStore = new RedisCacheStore(mockRedis);

      await getCachedShiftSchedule(teamId, "all", async () => [{ id: 55 }], cacheStore);
      assert.ok((await mockRedis.get(buildShiftCalendarCacheKey(teamId, "all"))) !== null);

      const mockSql = async (strings, ...values) => {
        const query = strings.join("?");
        if (query.includes("SELECT") && query.includes("FROM shifts")) {
          return [{ id: 55, employee_name: "Alice", role: "Manager", user_id: 1, team_id: teamId }];
        }
        if (query.includes("UPDATE shifts")) {
          return [{
            id: 55,
            employee_name: "Alice",
            role: "Supervisor",
            user_id: 1,
            team_id: teamId,
            shift_day: "2026-11-21",
            created_at: new Date().toISOString(),
          }];
        }
        return [];
      };

      const req = new Request(`http://localhost/api/shifts/${shiftId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shiftDay: "2026-11-21", role: "Supervisor" }),
      });

      const res = await handlePutShift(req, { params: Promise.resolve({ id: shiftId }) }, {
        sql: mockSql,
        getSessionUser: async () => ({
          userId: 1,
          email: "alice@example.com",
          name: "Alice",
          role: "Manager",
          teamId,
        }),
        cacheStore,
      });

      assert.equal(res.status, 200);
      const cachedAfter = await mockRedis.get(buildShiftCalendarCacheKey(teamId, "all"));
      assert.equal(cachedAfter, null, "Cache must be cleared after shift update");
    });

    it("invalidates cache when a shift is deleted via handleDeleteShift", async () => {
      const teamId = 15;
      const shiftId = "55";
      const cacheStore = new RedisCacheStore(mockRedis);

      await getCachedShiftSchedule(teamId, "all", async () => [{ id: 55 }], cacheStore);
      assert.ok((await mockRedis.get(buildShiftCalendarCacheKey(teamId, "all"))) !== null);

      const mockSql = async (strings, ...values) => {
        const query = strings.join("?");
        if (query.includes("SELECT") && query.includes("FROM shifts")) {
          return [{ id: 55, employee_name: "Alice", role: "Manager", user_id: 1, team_id: teamId, shift_day: "2026-11-21" }];
        }
        if (query.includes("DELETE FROM shifts")) {
          return [];
        }
        return [];
      };

      const req = new Request(`http://localhost/api/shifts/${shiftId}`, {
        method: "DELETE",
      });

      const res = await handleDeleteShift(req, { params: Promise.resolve({ id: shiftId }) }, {
        sql: mockSql,
        getSessionUser: async () => ({
          userId: 1,
          email: "alice@example.com",
          name: "Alice",
          role: "Manager",
          teamId,
        }),
        cacheStore,
      });

      assert.equal(res.status, 200);
      const cachedAfter = await mockRedis.get(buildShiftCalendarCacheKey(teamId, "all"));
      assert.equal(cachedAfter, null, "Cache must be cleared after shift deletion");
    });
  });

  describe("Production Fail-Safe Hardening & Zero-Leakage Resilience", () => {
    let savedNodeEnv;

    beforeEach(() => {
      savedNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
      process.env.NODE_ENV = savedNodeEnv;
      setCustomRedisClient(mockRedis);
    });

    it("returns HTTP 503 for all sensitive endpoints when Redis is unconfigured in production", async () => {
      process.env.NODE_ENV = "production";
      setCustomRedisClient(null);
      const savedUrl = process.env.REDIS_URL;
      delete process.env.REDIS_URL;

      try {
        const dummySql = async () => [];
        const dummySession = { userId: 1, email: "u@ex.com", name: "User", role: "Manager", teamId: 10 };
        const dummySecret = () => "test-secret-test-secret-test-secret-1234";

        const endpoints = [
          {
            name: "login",
            call: () => handleLogin(new Request("http://localhost/api/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: "a@b.com", password: "Password123!" }),
            }), { sql: dummySql, getSecret: dummySecret }),
          },
          {
            name: "register",
            call: () => handleRegister(new Request("http://localhost/api/auth/register", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: "a@b.com", password: "Password123!", name: "A" }),
            }), { sql: dummySql, getSecret: dummySecret }),
          },
          {
            name: "forgot-password",
            call: () => handleForgotPassword(new Request("http://localhost/api/auth/forgot-password", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: "a@b.com" }),
            }), { sql: dummySql, getSecret: dummySecret }),
          },
          {
            name: "reset-password",
            call: () => handleResetPassword(new Request("http://localhost/api/auth/reset-password", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: "t", newPassword: "Password123!" }),
            }), { sql: dummySql, getSecret: dummySecret }),
          },
          {
            name: "create-invitation",
            call: () => handleCreateInvitation(new Request("http://localhost/api/teams/invitations", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: "invite@b.com", role: "Staff" }),
            }), { sql: dummySql, getSessionUser: async () => dummySession, getSecret: dummySecret, skipRateLimit: false }),
          },
          {
            name: "accept-invitation",
            call: () => handleAcceptInvitation(new Request("http://localhost/api/teams/invitations/accept", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: "tok" }),
            }), { getSessionUser: async () => dummySession, getSecret: dummySecret, skipRateLimit: false }),
          },
          {
            name: "paystack-initialize",
            call: () => handlePaystackPost(new Request("http://localhost/api/billing/paystack/initialize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ planCode: "pro" }),
            })),
          },
        ];

        for (const ep of endpoints) {
          const resp = await ep.call();
          assert.equal(resp.status, 503, `Endpoint ${ep.name} must return 503 in production when Redis is unconfigured`);
          assert.equal(resp.headers.get("X-RateLimit-Storage"), "unavailable");
          assert.equal(resp.headers.get("Retry-After"), "30");

          const body = await resp.json();
          assert.equal(body.error, "Service Unavailable");
          assert.match(body.message, /Rate limiting service is temporarily unavailable/i);

          // Zero leakage check
          const rawText = JSON.stringify(body);
          assert.ok(!rawText.includes("redis://"), "Response must not leak redis URL");
          assert.ok(!rawText.includes("password"), "Response must not leak password");
          assert.ok(!rawText.includes("stack"), "Response must not leak stack trace");
        }
      } finally {
        if (savedUrl) process.env.REDIS_URL = savedUrl;
      }
    });

    it("returns HTTP 503 for sensitive endpoints when Redis connection throws in production", async () => {
      process.env.NODE_ENV = "production";
      mockRedis.setSimulateFailure(true);

      const dummySql = async () => [];
      const dummySecret = () => "test-secret-test-secret-test-secret-1234";

      const resp = await handleLogin(new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "Password123!" }),
      }), { sql: dummySql, getSecret: dummySecret });

      assert.equal(resp.status, 503);
      assert.equal(resp.headers.get("X-RateLimit-Storage"), "unavailable");
      assert.equal(resp.headers.get("Retry-After"), "30");
      const body = await resp.json();
      assert.equal(body.error, "Service Unavailable");
    });

    it("retains in-memory fallback behaviour in development and test environments", async () => {
      process.env.NODE_ENV = "test";
      mockRedis.setSimulateFailure(true);

      const dummySql = async () => [];
      const dummySecret = () => "test-secret-test-secret-test-secret-1234";

      // Login should proceed to credential check (returning 401) rather than failing closed with 503
      const resp = await handleLogin(new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invalid@example.com", password: "WrongPassword1!" }),
      }), { sql: dummySql, getSecret: dummySecret });

      assert.equal(resp.status, 401, "Development/test must fall back to memory without blocking requests");
    });

    it("restores distributed rate limiting immediately upon Redis recovery", async () => {
      process.env.NODE_ENV = "production";

      // 1. Redis is down -> 503
      mockRedis.setSimulateFailure(true);
      const req = () => new Request("http://localhost/test", {
        headers: { "x-forwarded-for": "10.10.10.1" },
      });

      const { response: failResp } = await enforceRateLimit(req(), {
        action: "login",
        limit: 2,
        windowSeconds: 60,
        redisClient: mockRedis,
      });
      assert.ok(failResp !== null);
      assert.equal(failResp.status, 503);

      // 2. Redis recovers -> normal distributed rate limiting restored
      mockRedis.setSimulateFailure(false);

      const { response: okResp, result: res1 } = await enforceRateLimit(req(), {
        action: "login",
        limit: 2,
        windowSeconds: 60,
        redisClient: mockRedis,
      });
      assert.equal(okResp, null, "Recovered Redis must allow request");
      assert.equal(res1.storage, "redis");
      assert.equal(res1.remaining, 1);

      // Second request -> still allowed
      const { response: okResp2, result: res2 } = await enforceRateLimit(req(), {
        action: "login",
        limit: 2,
        windowSeconds: 60,
        redisClient: mockRedis,
      });
      assert.equal(okResp2, null);
      assert.equal(res2.remaining, 0);

      // Third request -> quota exceeded -> HTTP 429
      const { response: throttledResp } = await enforceRateLimit(req(), {
        action: "login",
        limit: 2,
        windowSeconds: 60,
        redisClient: mockRedis,
      });
      assert.ok(throttledResp !== null);
      assert.equal(throttledResp.status, 429);
      assert.equal(throttledResp.headers.get("X-RateLimit-Storage"), "redis");
    });

    it("keeps application caching fallback separate without returning 503 or breaking isolation", async () => {
      process.env.NODE_ENV = "production";
      mockRedis.setSimulateFailure(true);

      const cacheStore = new RedisCacheStore(mockRedis);
      let dbCalls = 0;
      const factory = async () => {
        dbCalls++;
        return [{ id: 1, name: "Team 1 Member" }];
      };

      // In production with Redis failing, cache must fall back to DB factory, not throw 503
      const result = await getCachedTeamRoster(50, factory, cacheStore);
      assert.equal(result.fromCache, false);
      assert.equal(result.data.length, 1);
      assert.equal(dbCalls, 1);

      // Subsequent read served from memory fallback
      const cached = await getCachedTeamRoster(50, factory, cacheStore);
      assert.equal(cached.fromCache, true);
      assert.equal(dbCalls, 1);
    });

    it("verifies safe diagnostic connectivity reporting without secret exposure", async () => {
      // 1. Unconfigured state
      const unconfigured = await checkRedisConnectivity("");
      assert.equal(unconfigured.configured, false);
      assert.equal(unconfigured.reachable, false);
      assert.equal(unconfigured.usable, false);
      assert.equal(unconfigured.statusText, "Not Configured");

      // 2. Healthy mock check
      mockRedis.setSimulateFailure(false);
      const healthy = await checkRedisConnectivity(mockRedis);
      assert.equal(healthy.configured, true);
      assert.equal(healthy.reachable, true);
      assert.equal(healthy.usable, true);
      assert.equal(healthy.statusText, "Connected");
      assert.ok(typeof healthy.latencyMs === "number");

      // 3. Failing check
      mockRedis.setSimulateFailure(true);
      const failing = await checkRedisConnectivity(mockRedis);
      assert.equal(failing.reachable, false);
      assert.equal(failing.usable, false);
      assert.equal(failing.statusText, "Unreachable");

      // 4. URL Sanitization check: password and credentials completely stripped
      const sensitiveUrl = "redis://default:TopSecretPassword123@redis-node-1.cache.aws.com:6379";
      const sanitized = sanitizeRedisUrl(sensitiveUrl);
      assert.equal(sanitized, "redis://***:***@redis-node-1.cache.aws.com:6379");
      assert.ok(!sanitized.includes("TopSecretPassword123"));
    });
  });
});
