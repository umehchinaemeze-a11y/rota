import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  executePasswordReset,
  resetTokenRegistry,
} from "../lib/password-reset.ts";
import {
  checkRateLimit,
  enforceRateLimit,
  resetRateLimits,
} from "../lib/rate-limit.ts";
import {
  validateInput,
  shiftCreateSchema,
  shiftSwapRequestSchema,
  userSettingsSchema,
  resetPasswordSchema,
} from "../lib/validation.ts";
import { handleResetPassword } from "../app/api/auth/reset-password/route.ts";
import { handleForgotPassword } from "../app/api/auth/forgot-password/route.ts";
import { POST as handlePaystackCancelPost } from "../app/api/billing/paystack/cancel/route.ts";
import { POST as handlePaystackInitPost } from "../app/api/billing/paystack/initialize/route.ts";
import { POST as handlePaystackVerifyPost } from "../app/api/billing/paystack/verify/route.ts";
import { POST as handleSwapApprovePost } from "../app/api/shifts/swaps/[id]/approve/route.ts";
import { POST as handleSwapRejectPost } from "../app/api/shifts/swaps/[id]/reject/route.ts";
import { POST as handleSwapsPost } from "../app/api/shifts/swaps/route.ts";
import { POST as handleShiftsPost } from "../app/api/shifts/route.ts";
import { PUT as handleShiftPut, DELETE as handleShiftDelete } from "../app/api/shifts/[id]/route.ts";
import { POST as handleShiftRecoverPost } from "../app/api/shifts/recover/route.ts";
import { POST as handleNotificationsPost } from "../app/api/notifications/route.ts";
import { PUT as handleNotifPrefPut, POST as handleNotifPrefPost } from "../app/api/notifications/preferences/route.ts";
import { POST as handleNotifTokensPost, DELETE as handleNotifTokensDelete } from "../app/api/notifications/tokens/route.ts";
import { PUT as handleSettingsPut, POST as handleSettingsPost } from "../app/api/settings/route.ts";
import { POST as handleInvitationsPost } from "../app/api/teams/invitations/route.ts";
import { POST as handleAcceptInvitationPost } from "../app/api/teams/invitations/accept/route.ts";
import { POST as handleActivityPost } from "../app/api/activity/route.ts";
import { POST as handleRefreshPost } from "../app/api/auth/refresh/route.ts";
import { POST as handleLogoutPost } from "../app/api/auth/logout/route.ts";
import { POST as handleLogoutAllPost } from "../app/api/auth/logout-all/route.ts";

const TEST_SECRET = "super-secret-auth-key-at-least-32-characters-long!";

describe("Password Reset Cryptographic Token & Verification", () => {
  beforeEach(() => {
    resetTokenRegistry();
  });

  it("generates a valid signed HMAC-SHA256 reset token with 1-hour expiration", async () => {
    const { token, tokenId, expiresAt } = createPasswordResetToken(
      101,
      "engineer@rota.local",
      TEST_SECRET,
      3600
    );

    assert.ok(token);
    assert.ok(tokenId);
    assert.ok(token.includes("."));
    assert.ok(expiresAt > Math.floor(Date.now() / 1000));

    const result = await verifyPasswordResetToken(token, TEST_SECRET);
    assert.equal(result.valid, true);
    assert.equal(result.payload?.userId, 101);
    assert.equal(result.payload?.email, "engineer@rota.local");
    assert.equal(result.payload?.tokenId, tokenId);
    assert.equal(result.payload?.type, "password_reset");
  });

  it("rejects tampered password reset tokens with invalid signature", async () => {
    const { token } = createPasswordResetToken(
      101,
      "user@rota.local",
      TEST_SECRET,
      3600
    );
    const [payloadBase64, sig] = token.split(".");

    // Tamper with payload (change userId)
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf-8"));
    payload.userId = 999;
    const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tamperedToken = `${tamperedPayload}.${sig}`;

    const result = await verifyPasswordResetToken(tamperedToken, TEST_SECRET);
    assert.equal(result.valid, false);
    assert.equal(result.error, "Invalid token signature.");
  });

  it("rejects expired password reset tokens", async () => {
    // Token created with negative TTL (already expired)
    const { token } = createPasswordResetToken(
      101,
      "user@rota.local",
      TEST_SECRET,
      -100
    );

    const result = await verifyPasswordResetToken(token, TEST_SECRET);
    assert.equal(result.valid, false);
    assert.equal(result.error, "Password reset token has expired.");
  });

  it("enforces single-use policy by rejecting tokens once consumed", async () => {
    const { token, tokenId } = createPasswordResetToken(
      101,
      "user@rota.local",
      TEST_SECRET,
      3600
    );

    // First verification: valid
    const firstCheck = await verifyPasswordResetToken(token, TEST_SECRET);
    assert.equal(firstCheck.valid, true);

    // Mock SQL for reset execution
    const mockUsers = [{ id: 101, email: "user@rota.local" }];
    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("UPDATE users")) {
        return mockUsers;
      }
      if (q.includes("UPDATE auth_sessions")) {
        return [{ id: 1 }];
      }
      return [];
    };

    // Execute password reset
    const execResult = await executePasswordReset(mockSql, tokenId, 101, "NewSecurePassword123!");
    assert.equal(execResult.success, true);

    // Second verification with the exact same token MUST be rejected
    const secondCheck = await verifyPasswordResetToken(token, TEST_SECRET);
    assert.equal(secondCheck.valid, false);
    assert.equal(secondCheck.error, "Password reset token has already been used.");
  });
});

describe("Sliding-Window Rate Limiting Engine", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("permits requests within rate limit quota", () => {
    const key = "test:ip:192.168.1.1";
    const limit = 3;
    const windowSeconds = 60;
    const now = 1000000;

    const r1 = checkRateLimit(key, limit, windowSeconds, now);
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 2);

    const r2 = checkRateLimit(key, limit, windowSeconds, now + 1000);
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 1);

    const r3 = checkRateLimit(key, limit, windowSeconds, now + 2000);
    assert.equal(r3.allowed, true);
    assert.equal(r3.remaining, 0);
  });

  it("blocks requests exceeding the limit and provides accurate reset time", () => {
    const key = "test:ip:10.0.0.5";
    const limit = 2;
    const windowSeconds = 60;
    const now = 1000000;

    checkRateLimit(key, limit, windowSeconds, now);
    checkRateLimit(key, limit, windowSeconds, now + 5000);

    // 3rd attempt exceeds limit
    const r3 = checkRateLimit(key, limit, windowSeconds, now + 10000);
    assert.equal(r3.allowed, false);
    assert.equal(r3.remaining, 0);
    // Reset should be based on oldest hit (now) + 60s
    assert.equal(r3.resetSeconds, 50); // (1000000 + 60000 - 1010000) / 1000 = 50s
  });

  it("slides the window forward as time advances", () => {
    const key = "test:ip:172.16.0.1";
    const limit = 2;
    const windowSeconds = 60;
    const t0 = 1000000;

    checkRateLimit(key, limit, windowSeconds, t0);
    checkRateLimit(key, limit, windowSeconds, t0 + 10000);

    // Blocked at t0 + 20s
    const blocked = checkRateLimit(key, limit, windowSeconds, t0 + 20000);
    assert.equal(blocked.allowed, false);

    // Advance time past the 60s window of the first hit (t0 + 65s)
    const afterWindow = checkRateLimit(key, limit, windowSeconds, t0 + 65000);
    assert.equal(afterWindow.allowed, true);
    assert.equal(afterWindow.remaining, 0); // only 1 slot freed
  });

  it("isolates counters per IP address independently", () => {
    const limit = 1;
    const windowSeconds = 60;
    const now = 1000000;

    const rA1 = checkRateLimit("ip:1.1.1.1", limit, windowSeconds, now);
    assert.equal(rA1.allowed, true);

    const rA2 = checkRateLimit("ip:1.1.1.1", limit, windowSeconds, now);
    assert.equal(rA2.allowed, false);

    // Different IP should not be affected
    const rB1 = checkRateLimit("ip:2.2.2.2", limit, windowSeconds, now);
    assert.equal(rB1.allowed, true);
  });
});

describe("Zod Input Validation Schemas", () => {
  it("validates shift payload and rejects end_time earlier than start_time", () => {
    const validShift = {
      title: "Morning Operations",
      start_time: "2026-11-15T08:00:00Z",
      end_time: "2026-11-15T16:00:00Z",
      user_id: 5,
    };
    const v1 = validateInput(shiftCreateSchema, validShift);
    assert.equal(v1.success, true);

    // Invalid: end before start
    const invalidShift = {
      title: "Invalid Shift",
      start_time: "2026-11-15T16:00:00Z",
      end_time: "2026-11-15T08:00:00Z",
    };
    const v2 = validateInput(shiftCreateSchema, invalidShift);
    assert.equal(v2.success, false);
    assert.ok(v2.error.includes("End time must be strictly after start time"));
  });

  it("validates swap requests and parses string numbers safely", () => {
    const validSwap = {
      shiftId: "42",
      targetUserId: "99",
      reason: "Need coverage for dental appointment",
    };
    const res = validateInput(shiftSwapRequestSchema, validSwap);
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.shiftId, 42);
      assert.equal(res.data.targetUserId, 99);
    }
  });

  it("validates user settings and rejects invalid quiet hours format", () => {
    const validSettings = {
      theme: "dark",
      language: "es",
      quiet_hours_enabled: true,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:30",
    };
    const v1 = validateInput(userSettingsSchema, validSettings);
    assert.equal(v1.success, true);

    // Malformed time
    const invalidSettings = {
      quiet_hours_start: "25:00", // invalid hour
    };
    const v2 = validateInput(userSettingsSchema, invalidSettings);
    assert.equal(v2.success, false);
  });

  it("validates password reset schema and enforces 8-character minimum", () => {
    const validPayload = {
      token: "valid-token-string-sample",
      newPassword: "SecurePassword99!",
    };
    const v1 = validateInput(resetPasswordSchema, validPayload);
    assert.equal(v1.success, true);

    const weakPayload = {
      token: "valid-token-string-sample",
      newPassword: "short",
    };
    const v2 = validateInput(resetPasswordSchema, weakPayload);
    assert.equal(v2.success, false);
    assert.ok(v2.error.includes("at least 8 characters"));
  });
});

describe("Password Reset API Route Handler (handleResetPassword)", () => {
  beforeEach(() => {
    resetTokenRegistry();
    resetRateLimits();
  });

  it("rejects malformed JSON body with HTTP 400", async () => {
    const req = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await handleResetPassword(req, {
      skipRateLimit: true,
      getSecret: () => TEST_SECRET,
    });
    assert.equal(res.status, 400);
  });

  it("rejects reset requests with weak password (< 8 chars)", async () => {
    const req = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: "token1234567890", newPassword: "weak" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await handleResetPassword(req, {
      skipRateLimit: true,
      getSecret: () => TEST_SECRET,
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("at least 8 characters"));
  });

  it("rejects invalid or tampered reset token", async () => {
    const req = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: "invalid.token.here", newPassword: "ValidPassword123!" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await handleResetPassword(req, {
      skipRateLimit: true,
      getSecret: () => TEST_SECRET,
    });
    assert.equal(res.status, 400);
  });

  it("successfully updates password, consumes token, and revokes sessions", async () => {
    const { token } = createPasswordResetToken(
      55,
      "user@rota.local",
      TEST_SECRET,
      3600
    );

    let passwordUpdated = false;
    let sessionsRevoked = false;

    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("UPDATE users")) {
        passwordUpdated = true;
        return [{ id: 55, email: "user@rota.local" }];
      }
      if (q.includes("UPDATE auth_sessions")) {
        sessionsRevoked = true;
        return [{ id: 1 }];
      }
      return [];
    };

    const req = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword: "BrandNewPassword123!" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await handleResetPassword(req, {
      skipRateLimit: true,
      getSecret: () => TEST_SECRET,
      sql: mockSql,
    });

    assert.equal(res.status, 200);
    assert.equal(passwordUpdated, true);
    assert.equal(sessionsRevoked, true);

    // Second request with same token must fail (single use)
    const req2 = new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword: "AnotherPassword123!" }),
      headers: { "Content-Type": "application/json" },
    });
    const res2 = await handleResetPassword(req2, {
      skipRateLimit: true,
      getSecret: () => TEST_SECRET,
      sql: mockSql,
    });
    assert.equal(res2.status, 400);
    const data2 = await res2.json();
    assert.ok(data2.error.includes("already been used"));
  });

  it("enforces sliding-window rate limit on reset-password endpoint", async () => {
    const makeReq = () =>
      new Request("http://localhost/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token: "any-token-string", newPassword: "Password123!" }),
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.1" },
      });

    // Limit is 5 per min
    for (let i = 0; i < 5; i++) {
      const res = await handleResetPassword(makeReq(), {
        getSecret: () => TEST_SECRET,
        sql: async () => [],
      });
      // Expected to fail with token error (400), not rate limited (429)
      assert.notEqual(res.status, 429);
    }

    // 6th request from same IP must be rate limited
    const throttledRes = await handleResetPassword(makeReq(), {
      getSecret: () => TEST_SECRET,
      sql: async () => [],
    });
    assert.equal(throttledRes.status, 429);
    assert.ok(throttledRes.headers.get("Retry-After"));
    assert.equal(throttledRes.headers.get("X-RateLimit-Limit"), "5");
  });
});

describe("State-Changing API Routes — CSRF & Same-Origin Enforcement", () => {
  const CANONICAL_ORIGIN = "https://rota-lovat-gamma.vercel.app";
  const EVIL_ORIGIN = "https://evil.example";

  const dummyContext = { params: Promise.resolve({ id: "1" }) };

  const endpointsToTest = [
    {
      name: "POST /api/billing/paystack/cancel",
      handler: (req) => handlePaystackCancelPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/billing/paystack/cancel",
      method: "POST",
    },
    {
      name: "POST /api/billing/paystack/initialize",
      handler: (req) => handlePaystackInitPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/billing/paystack/initialize",
      method: "POST",
    },
    {
      name: "POST /api/billing/paystack/verify",
      handler: (req) => handlePaystackVerifyPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/billing/paystack/verify",
      method: "POST",
    },
    {
      name: "POST /api/shifts/swaps/1/approve",
      handler: (req) => handleSwapApprovePost(req, dummyContext),
      url: "https://rota-lovat-gamma.vercel.app/api/shifts/swaps/1/approve",
      method: "POST",
    },
    {
      name: "POST /api/shifts/swaps/1/reject",
      handler: (req) => handleSwapRejectPost(req, dummyContext),
      url: "https://rota-lovat-gamma.vercel.app/api/shifts/swaps/1/reject",
      method: "POST",
    },
    {
      name: "POST /api/shifts/swaps",
      handler: (req) => handleSwapsPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/shifts/swaps",
      method: "POST",
    },
    {
      name: "POST /api/shifts",
      handler: (req) => handleShiftsPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/shifts",
      method: "POST",
    },
    {
      name: "PUT /api/shifts/1",
      handler: (req) => handleShiftPut(req, dummyContext),
      url: "https://rota-lovat-gamma.vercel.app/api/shifts/1",
      method: "PUT",
    },
    {
      name: "DELETE /api/shifts/1",
      handler: (req) => handleShiftDelete(req, dummyContext),
      url: "https://rota-lovat-gamma.vercel.app/api/shifts/1",
      method: "DELETE",
    },
    {
      name: "POST /api/shifts/recover",
      handler: (req) => handleShiftRecoverPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/shifts/recover",
      method: "POST",
    },
    {
      name: "POST /api/notifications",
      handler: (req) => handleNotificationsPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/notifications",
      method: "POST",
    },
    {
      name: "PUT /api/notifications/preferences",
      handler: (req) => handleNotifPrefPut(req),
      url: "https://rota-lovat-gamma.vercel.app/api/notifications/preferences",
      method: "PUT",
    },
    {
      name: "POST /api/notifications/preferences",
      handler: (req) => handleNotifPrefPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/notifications/preferences",
      method: "POST",
    },
    {
      name: "POST /api/notifications/tokens",
      handler: (req) => handleNotifTokensPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/notifications/tokens",
      method: "POST",
    },
    {
      name: "DELETE /api/notifications/tokens",
      handler: (req) => handleNotifTokensDelete(req),
      url: "https://rota-lovat-gamma.vercel.app/api/notifications/tokens",
      method: "DELETE",
    },
    {
      name: "PUT /api/settings",
      handler: (req) => handleSettingsPut(req),
      url: "https://rota-lovat-gamma.vercel.app/api/settings",
      method: "PUT",
    },
    {
      name: "POST /api/settings",
      handler: (req) => handleSettingsPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/settings",
      method: "POST",
    },
    {
      name: "POST /api/teams/invitations",
      handler: (req) => handleInvitationsPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/teams/invitations",
      method: "POST",
    },
    {
      name: "POST /api/teams/invitations/accept",
      handler: (req) => handleAcceptInvitationPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/teams/invitations/accept",
      method: "POST",
    },
    {
      name: "POST /api/activity",
      handler: (req) => handleActivityPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/activity",
      method: "POST",
    },
    {
      name: "POST /api/auth/refresh",
      handler: (req) => handleRefreshPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/auth/refresh",
      method: "POST",
    },
    {
      name: "POST /api/auth/logout-all",
      handler: (req) => handleLogoutAllPost(req),
      url: "https://rota-lovat-gamma.vercel.app/api/auth/logout-all",
      method: "POST",
    },
  ];

  for (const ep of endpointsToTest) {
    it(`${ep.name} rejects cross-origin requests with HTTP 403 Forbidden`, async () => {
      const req = new Request(ep.url, {
        method: ep.method,
        headers: {
          Origin: EVIL_ORIGIN,
          "Content-Type": "application/json",
        },
        body: ep.method !== "DELETE" && ep.method !== "GET" ? "{}" : undefined,
      });

      const res = await ep.handler(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error, "Invalid request origin.");
    });

    it(`${ep.name} rejects missing Origin/Referer requests with HTTP 403 Forbidden`, async () => {
      const req = new Request(ep.url, {
        method: ep.method,
        headers: {
          "Content-Type": "application/json",
        },
        body: ep.method !== "DELETE" && ep.method !== "GET" ? "{}" : undefined,
      });

      const res = await ep.handler(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error, "Invalid request origin.");
    });

    it(`${ep.name} accepts canonical origin requests`, async () => {
      const req = new Request(ep.url, {
        method: ep.method,
        headers: {
          Origin: CANONICAL_ORIGIN,
          "Content-Type": "application/json",
        },
        body: ep.method !== "DELETE" && ep.method !== "GET" ? "{}" : undefined,
      });

      const res = await ep.handler(req);
      assert.notEqual(res.status, 403, `Must not be blocked by origin validation on ${ep.name}`);
    });
  }

  describe("POST /api/auth/logout Origin Security & Client Preservation", () => {
    it("rejects cross-origin logout attempts with HTTP 403", async () => {
      const req = new Request("https://rota-lovat-gamma.vercel.app/api/auth/logout", {
        method: "POST",
        headers: {
          Origin: EVIL_ORIGIN,
        },
      });

      const res = await handleLogoutPost(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error, "Invalid request origin.");
    });

    it("accepts canonical origin logout requests", async () => {
      const req = new Request("https://rota-lovat-gamma.vercel.app/api/auth/logout", {
        method: "POST",
        headers: {
          Origin: CANONICAL_ORIGIN,
        },
      });

      const res = await handleLogoutPost(req);
      assert.equal(res.status, 200);
    });

    it("preserves native Expo/React Native mobile logout requests without Origin/Referer", async () => {
      const req = new Request("https://rota-lovat-gamma.vercel.app/api/auth/logout", {
        method: "POST",
        headers: {},
      });

      const res = await handleLogoutPost(req);
      assert.equal(res.status, 200);
    });
  });
});

