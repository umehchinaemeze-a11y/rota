import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hashRefreshToken,
  generateSecureToken,
  formatRefreshToken,
  parseRefreshToken,
  getRefreshCookieOptions,
  serializeRefreshCookie,
  clearRefreshCookie,
  createAuthSession,
  rotateAuthSession,
  revokeCurrentSession,
  revokeAllUserSessions,
  isSessionRevoked,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
} from "../lib/refresh-tokens.ts";

import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
} from "../lib/auth.ts";

import { handleLogin } from "../app/api/auth/login/route.ts";
import { handleRegister } from "../app/api/auth/register/route.ts";
import { handleRefresh } from "../app/api/auth/refresh/route.ts";
import { handleLogout } from "../app/api/auth/logout/route.ts";
import { handleLogoutAll } from "../app/api/auth/logout-all/route.ts";
import * as logoutRoute from "../app/api/auth/logout/route.ts";
import * as logoutAllRoute from "../app/api/auth/logout-all/route.ts";

const TEST_SECRET = "test_auth_secret_0123456789abcdef0123456789abcdef";

function createMockAuthDb(initialUsers = [], initialMemberships = []) {
  const users = [...initialUsers];
  const memberships = [...initialMemberships];
  const authSessions = [];
  const usedTokens = [];
  let nextSessionId = 1;
  let nextUsedId = 1;

  async function sql(strings, ...values) {
    const rawQuery = strings.join("?");

    // CREATE TABLE / INDEX
    if (rawQuery.includes("CREATE TABLE") || rawQuery.includes("CREATE INDEX")) {
      return [];
    }

    // INSERT INTO auth_sessions
    if (rawQuery.includes("INSERT INTO auth_sessions")) {
      const [sessionId, userId, teamId, tokenHash, familyId, userAgent, ipAddress, expiresAt] = values;
      const record = {
        id: nextSessionId++,
        session_id: sessionId,
        user_id: Number(userId),
        team_id: teamId ? Number(teamId) : null,
        token_hash: tokenHash,
        family_id: familyId,
        revoked: false,
        revoked_reason: null,
        user_agent: userAgent ?? null,
        ip_address: ipAddress ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: expiresAt,
      };
      authSessions.push(record);
      return [record];
    }

    // SELECT FROM used_refresh_tokens WHERE token_hash = ?
    if (rawQuery.includes("FROM used_refresh_tokens") && rawQuery.includes("token_hash =")) {
      const hash = values[0];
      const match = usedTokens.find((t) => t.token_hash === hash);
      return match ? [match] : [];
    }

    // UPDATE auth_sessions SET revoked = TRUE, revoked_reason = 'reuse_detected' WHERE family_id = ?
    if (rawQuery.includes("UPDATE auth_sessions") && rawQuery.includes("family_id =")) {
      const familyId = values[0];
      const updated = [];
      for (const s of authSessions) {
        if (s.family_id === familyId) {
          s.revoked = true;
          s.revoked_reason = "reuse_detected";
          s.updated_at = new Date().toISOString();
          updated.push(s);
        }
      }
      return updated;
    }

    // UPDATE auth_sessions SET revoked = TRUE WHERE user_id = ?
    if (rawQuery.includes("UPDATE auth_sessions") && rawQuery.includes("user_id =")) {
      const [reason, userId] = values;
      const updated = [];
      for (const s of authSessions) {
        if (s.user_id === Number(userId) && !s.revoked) {
          s.revoked = true;
          s.revoked_reason = reason;
          s.updated_at = new Date().toISOString();
          updated.push(s);
        }
      }
      return updated;
    }

    // UPDATE auth_sessions SET revoked = TRUE WHERE session_id = ?
    if (rawQuery.includes("UPDATE auth_sessions") && rawQuery.includes("session_id =") && rawQuery.includes("revoked = TRUE")) {
      const [reason, sessionId] = values;
      const match = authSessions.find((s) => s.session_id === sessionId);
      if (match) {
        match.revoked = true;
        match.revoked_reason = reason;
        match.updated_at = new Date().toISOString();
        return [{ id: match.id }];
      }
      return [];
    }

    // INSERT INTO used_refresh_tokens
    if (rawQuery.includes("INSERT INTO used_refresh_tokens")) {
      const [sessionId, familyId, tokenHash] = values;
      const rec = { id: nextUsedId++, session_id: sessionId, family_id: familyId, token_hash: tokenHash };
      usedTokens.push(rec);
      return [rec];
    }

    // UPDATE auth_sessions SET token_hash = ... WHERE session_id = ? AND token_hash = ? AND revoked = FALSE
    if (rawQuery.includes("UPDATE auth_sessions") && rawQuery.includes("token_hash =") && rawQuery.includes("WHERE session_id =")) {
      const [newHash, expiresAt, userAgent, ipAddress, sessionId, oldHash] = values;
      const match = authSessions.find(
        (s) => s.session_id === sessionId && s.token_hash === oldHash && !s.revoked
      );
      if (match) {
        match.token_hash = newHash;
        match.expires_at = expiresAt;
        if (userAgent) match.user_agent = userAgent;
        if (ipAddress) match.ip_address = ipAddress;
        match.updated_at = new Date().toISOString();
        return [match];
      }
      return [];
    }

    // SELECT FROM auth_sessions JOIN users ... WHERE s.session_id = ?
    if (rawQuery.includes("FROM auth_sessions") && rawQuery.includes("session_id =")) {
      const sessionId = values[0];
      const sess = authSessions.find((s) => s.session_id === sessionId);
      if (!sess) return [];
      const user = users.find((u) => u.id === sess.user_id);
      return [
        {
          ...sess,
          user_id: user ? user.id : sess.user_id,
          email: user ? user.email : "user@example.com",
          name: user ? user.name : "User",
          default_role: user ? user.role : "Staff",
        },
      ];
    }

    // SELECT FROM team_memberships WHERE user_id = ?
    if (rawQuery.includes("FROM team_memberships") && rawQuery.includes("user_id =")) {
      const userId = Number(values[0]);
      return memberships.filter((m) => m.user_id === userId);
    }

    // SELECT FROM users WHERE LOWER(TRIM(email)) = ?
    if (rawQuery.includes("FROM users") && rawQuery.includes("LOWER(TRIM(email))")) {
      const email = String(values[0]).toLowerCase();
      const match = users.find((u) => u.email.toLowerCase() === email);
      return match ? [match] : [];
    }

    // SELECT FROM users WHERE id = ?
    if (rawQuery.includes("FROM users") && rawQuery.includes("WHERE id =")) {
      const id = Number(values[0]);
      const match = users.find((u) => u.id === id);
      return match ? [match] : [];
    }

    // INSERT INTO users
    if (rawQuery.includes("INSERT INTO users")) {
      const [email, hash, salt, name, role] = values;
      const newUser = { id: users.length + 1, email, password_hash: hash, password_salt: salt, name, role };
      users.push(newUser);
      return [newUser];
    }

    return [];
  }

  return { sql, authSessions, usedTokens, users, memberships };
}

describe("Refresh Token Cryptographic & Token Helpers", () => {
  it("hashes secrets deterministically with SHA-256 and never matches raw plaintext", () => {
    const secret = generateSecureToken(32);
    const hash1 = hashRefreshToken(secret);
    const hash2 = hashRefreshToken(secret);

    assert.equal(hash1, hash2, "Identical secret must produce identical hash");
    assert.notEqual(hash1, secret, "Hashed token must never match raw secret");
    assert.equal(hash1.length, 64, "SHA-256 hex digest must be 64 characters");
  });

  it("formats and parses valid refresh tokens with session ID and secret", () => {
    const sessionId = generateSecureToken(24);
    const secret = generateSecureToken(32);
    const raw = formatRefreshToken(sessionId, secret);

    assert.ok(raw.includes("."), "Formatted refresh token must contain separator");
    const parsed = parseRefreshToken(raw);
    assert.ok(parsed !== null);
    assert.equal(parsed.sessionId, sessionId);
    assert.equal(parsed.secret, secret);
  });

  it("rejects malformed refresh tokens during parsing", () => {
    assert.equal(parseRefreshToken("noseparator"), null);
    assert.equal(parseRefreshToken(".secret"), null);
    assert.equal(parseRefreshToken("session."), null);
    assert.equal(parseRefreshToken("part1.part2.part3"), null);
    assert.equal(parseRefreshToken(""), null);
    assert.equal(parseRefreshToken(null), null);
    assert.equal(parseRefreshToken(undefined), null);
  });

  it("generates secure HttpOnly, SameSite=Lax cookie options", () => {
    const opts = getRefreshCookieOptions();
    assert.equal(opts.name, REFRESH_COOKIE_NAME);
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.sameSite, "lax");
    assert.equal(opts.path, "/");
    assert.equal(opts.maxAge, REFRESH_TOKEN_TTL_SECONDS);

    const serialized = serializeRefreshCookie("token123");
    assert.ok(serialized.includes("rota_refresh=token123"));
    assert.ok(serialized.includes("HttpOnly"));
    assert.ok(serialized.includes("SameSite=Lax"));
    assert.ok(serialized.includes(`Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`));

    const cleared = clearRefreshCookie();
    assert.ok(cleared.includes("Max-Age=0"));
  });
});

describe("Short-Lived Access Tokens Lifecycle", () => {
  it("enforces 15-minute access token lifespan (900 seconds)", () => {
    assert.equal(ACCESS_TOKEN_TTL_SECONDS, 15 * 60);

    const payload = {
      userId: 1,
      email: "amara@rota.local",
      name: "Amara Okafor",
      role: "Front Desk",
      sessionId: "sess_123",
    };

    const token = createSessionToken(payload, TEST_SECRET, ACCESS_TOKEN_TTL_SECONDS);
    const verified = verifySessionToken(token, TEST_SECRET);
    assert.ok(verified !== null);
    assert.equal(verified.sessionId, "sess_123");

    const now = Math.floor(Date.now() / 1000);
    assert.ok(verified.exp <= now + ACCESS_TOKEN_TTL_SECONDS);
    assert.ok(verified.exp >= now + ACCESS_TOKEN_TTL_SECONDS - 2);
  });

  it("rejects expired access tokens", () => {
    const payload = {
      userId: 1,
      email: "amara@rota.local",
      name: "Amara Okafor",
      role: "Front Desk",
    };

    const expiredToken = createSessionToken(payload, TEST_SECRET, -10);
    assert.equal(verifySessionToken(expiredToken, TEST_SECRET), null);
  });
});

describe("Login and Registration with Refresh Tokens", () => {
  const pw = hashPassword("StrongPassword123!");
  const existingUser = {
    id: 10,
    email: "manager@rota.local",
    password_hash: pw.hash,
    password_salt: pw.salt,
    name: "Adaeze Manager",
    role: "Supervisor",
  };

  it("issues both short-lived session token and long-lived refresh token on login", async () => {
    const db = createMockAuthDb([existingUser]);

    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "manager@rota.local", password: "StrongPassword123!" }),
    });

    const res = await handleLogin(req, {
      sql: db.sql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.email, "manager@rota.local");

    // Verify Set-Cookie headers contain both tokens
    const cookieHeader = res.headers.get("set-cookie");
    assert.ok(cookieHeader.includes("rota_session="), "Must set short-lived session cookie");
    assert.ok(cookieHeader.includes("rota_refresh="), "Must set long-lived refresh cookie");

    // Verify database row created in auth_sessions
    assert.equal(db.authSessions.length, 1);
    const session = db.authSessions[0];
    assert.equal(session.user_id, 10);
    assert.equal(session.revoked, false);
    assert.ok(session.token_hash, "Must store token hash");
    // Verify raw secret was not stored
    assert.equal(session.token_hash.length, 64, "Stored hash must be SHA-256 hex");
  });

  it("issues both session token and refresh token on user registration", async () => {
    const db = createMockAuthDb();

    const req = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "New Employee",
        email: "newemployee@rota.local",
        password: "NewPassword123!",
      }),
    });

    const res = await handleRegister(req, {
      sql: db.sql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 201);
    const cookieHeader = res.headers.get("set-cookie");
    assert.ok(cookieHeader.includes("rota_session="));
    assert.ok(cookieHeader.includes("rota_refresh="));
    assert.equal(db.authSessions.length, 1);
  });
});

describe("Token Rotation and Reuse Detection", () => {
  it("rotates refresh token successfully and invalidates old token", async () => {
    const db = createMockAuthDb([
      { id: 5, email: "worker@rota.local", name: "Worker One", role: "Staff" },
    ]);

    // Create session
    const sessionData = await createAuthSession(db.sql, { userId: 5 });
    const originalRefreshToken = sessionData.refreshToken;

    const req = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: {
        cookie: `${REFRESH_COOKIE_NAME}=${originalRefreshToken}`,
      },
    });

    const res = await handleRefresh(req, {
      sql: db.sql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.email, "worker@rota.local");

    // Check cookies: new session token and new rotated refresh token
    const cookieHeader = res.headers.get("set-cookie");
    assert.ok(cookieHeader.includes("rota_session="));
    assert.ok(cookieHeader.includes("rota_refresh="));

    // Verify old token was moved to used_refresh_tokens
    assert.equal(db.usedTokens.length, 1);
    assert.equal(db.usedTokens[0].session_id, sessionData.sessionId);

    // Verify auth_sessions has updated token_hash
    const storedSession = db.authSessions.find((s) => s.session_id === sessionData.sessionId);
    assert.ok(storedSession);
    const parsedOld = parseRefreshToken(originalRefreshToken);
    const oldHash = hashRefreshToken(parsedOld.secret);
    assert.notEqual(storedSession.token_hash, oldHash, "Database token hash must be updated to new secret");
  });

  it("detects token reuse and terminates the entire session family", async () => {
    const db = createMockAuthDb([
      { id: 5, email: "worker@rota.local", name: "Worker One", role: "Staff" },
    ]);

    const sessionData = await createAuthSession(db.sql, { userId: 5 });
    const originalRefreshToken = sessionData.refreshToken;

    // Legitimate rotation 1
    const req1 = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${originalRefreshToken}` },
    });
    const res1 = await handleRefresh(req1, { sql: db.sql, getSecret: () => TEST_SECRET });
    assert.equal(res1.status, 200);

    // Stolen / Replay attempt: Attacker tries to use the ALREADY ROTATED originalRefreshToken
    const reqReuse = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${originalRefreshToken}` },
    });
    const resReuse = await handleRefresh(reqReuse, { sql: db.sql, getSecret: () => TEST_SECRET });

    // Must be rejected with 401
    assert.equal(resReuse.status, 401);
    const reuseData = await resReuse.json();
    assert.equal(reuseData.status, "reuse_detected");
    assert.ok(reuseData.error.includes("reuse detected"));

    // Verify the ENTIRE family was revoked in the database
    const storedSession = db.authSessions.find((s) => s.session_id === sessionData.sessionId);
    assert.equal(storedSession.revoked, true);
    assert.equal(storedSession.revoked_reason, "reuse_detected");

    // Any subsequent attempt with any token from that session must now be rejected
    const reqSubsequent = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${originalRefreshToken}` },
    });
    const resSubsequent = await handleRefresh(reqSubsequent, { sql: db.sql, getSecret: () => TEST_SECRET });
    assert.equal(resSubsequent.status, 401);
  });

  it("rejects expired refresh tokens", async () => {
    const db = createMockAuthDb([
      { id: 5, email: "worker@rota.local", name: "Worker One", role: "Staff" },
    ]);

    const sessionData = await createAuthSession(db.sql, { userId: 5 });
    // Manually expire the session in the database
    const stored = db.authSessions.find((s) => s.session_id === sessionData.sessionId);
    stored.expires_at = new Date(Date.now() - 1000).toISOString();

    const req = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${sessionData.refreshToken}` },
    });

    const res = await handleRefresh(req, { sql: db.sql, getSecret: () => TEST_SECRET });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.status, "expired");
  });

  it("rejects tampered or forged refresh token secrets", async () => {
    const db = createMockAuthDb([
      { id: 5, email: "worker@rota.local", name: "Worker One", role: "Staff" },
    ]);

    const sessionData = await createAuthSession(db.sql, { userId: 5 });
    const forgedToken = formatRefreshToken(sessionData.sessionId, generateSecureToken(32));

    const req = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${forgedToken}` },
    });

    const res = await handleRefresh(req, { sql: db.sql, getSecret: () => TEST_SECRET });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.status, "invalid");
  });

  it("rejects refresh requests with missing cookie and clears cookie headers", async () => {
    const db = createMockAuthDb();
    const req = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: {},
    });

    const res = await handleRefresh(req, { sql: db.sql, getSecret: () => TEST_SECRET });
    assert.equal(res.status, 401);
    const cookieHeader = res.headers.get("set-cookie");
    assert.ok(cookieHeader.includes("Max-Age=0"), "Failed refresh must clear cookies");
  });
});

describe("Logout Lifecycle (Current Device vs All Devices)", () => {
  it("logs out current device and revokes only that specific session", async () => {
    const db = createMockAuthDb([
      { id: 12, email: "multi@rota.local", name: "Multi Device User", role: "Staff" },
    ]);

    // User logs in on Device A and Device B
    const sessionA = await createAuthSession(db.sql, { userId: 12, userAgent: "DeviceA" });
    const sessionB = await createAuthSession(db.sql, { userId: 12, userAgent: "DeviceB" });

    assert.equal(db.authSessions.length, 2);

    // Logout from Device A
    const reqA = new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${REFRESH_COOKIE_NAME}=${sessionA.refreshToken}`,
      },
    });

    const resA = await handleLogout(reqA, {
      sql: db.sql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(resA.status, 200);
    const dataA = await resA.json();
    assert.equal(dataA.success, true);
    assert.equal(dataA.message, "Logged out successfully.");

    // Verify session A is revoked
    const storedA = db.authSessions.find((s) => s.session_id === sessionA.sessionId);
    assert.equal(storedA.revoked, true);
    assert.equal(storedA.revoked_reason, "user_logout");

    // Verify session B remains ACTIVE
    const storedB = db.authSessions.find((s) => s.session_id === sessionB.sessionId);
    assert.equal(storedB.revoked, false);

    // Refreshing on Device B still works
    const reqRefreshB = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${sessionB.refreshToken}` },
    });
    const resRefreshB = await handleRefresh(reqRefreshB, { sql: db.sql, getSecret: () => TEST_SECRET });
    assert.equal(resRefreshB.status, 200);
  });

  it("logs out from all devices via ?all=true and revokes every active session for that user", async () => {
    const db = createMockAuthDb([
      { id: 12, email: "multi@rota.local", name: "Multi Device User", role: "Staff" },
      { id: 99, email: "other@rota.local", name: "Other User", role: "Staff" },
    ]);

    // User 12 has 3 sessions across phone, tablet, and desktop
    const sess1 = await createAuthSession(db.sql, { userId: 12 });
    const sess2 = await createAuthSession(db.sql, { userId: 12 });
    const sess3 = await createAuthSession(db.sql, { userId: 12 });

    // User 99 has 1 session
    const otherSess = await createAuthSession(db.sql, { userId: 99 });

    assert.equal(db.authSessions.filter((s) => s.revoked === false).length, 4);

    // User 12 triggers logout from all devices
    const reqLogoutAll = new Request("http://localhost/api/auth/logout?all=true", {
      method: "POST",
    });

    const resLogoutAll = await handleLogout(reqLogoutAll, {
      sql: db.sql,
      getSessionUser: async () => ({
        userId: 12,
        email: "multi@rota.local",
        name: "Multi Device User",
        role: "Staff",
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    });

    assert.equal(resLogoutAll.status, 200);
    const data = await resLogoutAll.json();
    assert.ok(data.message.includes("all devices"));

    // All 3 sessions of User 12 must be revoked
    const user12ActiveSessions = db.authSessions.filter(
      (s) => s.user_id === 12 && s.revoked === false
    );
    assert.equal(user12ActiveSessions.length, 0, "All sessions of User 12 must be terminated");

    // Other user's sessions must remain completely untouched (Workspace & User Isolation)
    const otherActiveSessions = db.authSessions.filter(
      (s) => s.user_id === 99 && s.revoked === false
    );
    assert.equal(otherActiveSessions.length, 1, "Other user's sessions must not be affected");
  });

  it("exports POST handler and does not export GET handler on logout route modules (CSRF hardening)", () => {
    assert.equal(typeof logoutRoute.POST, "function", "app/api/auth/logout must export POST");
    assert.equal(typeof logoutRoute.GET, "undefined", "app/api/auth/logout must not export GET");
    assert.equal(typeof logoutAllRoute.POST, "function", "app/api/auth/logout-all must export POST");
    assert.equal(typeof logoutAllRoute.GET, "undefined", "app/api/auth/logout-all must not export GET");
  });

  it("logs out from all devices via handleLogoutAll and preserves cookie-clearing behavior", async () => {
    const db = createMockAuthDb([
      { id: 14, email: "all-devices@rota.local", name: "All Devices User", role: "Staff" },
      { id: 98, email: "keep@rota.local", name: "Keep Active User", role: "Staff" },
    ]);

    await createAuthSession(db.sql, { userId: 14, userAgent: "Phone" });
    await createAuthSession(db.sql, { userId: 14, userAgent: "Laptop" });
    await createAuthSession(db.sql, { userId: 98, userAgent: "Desktop" });

    assert.equal(db.authSessions.filter((s) => !s.revoked).length, 3);

    const req = new Request("http://localhost/api/auth/logout-all", {
      method: "POST",
    });

    const res = await handleLogoutAll(req, {
      sql: db.sql,
      getSessionUser: async () => ({
        userId: 14,
        email: "all-devices@rota.local",
        name: "All Devices User",
        role: "Staff",
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.message.includes("all devices"));

    // Verify all sessions of User 14 are revoked
    const user14Active = db.authSessions.filter((s) => s.user_id === 14 && !s.revoked);
    assert.equal(user14Active.length, 0, "All sessions of User 14 must be terminated");

    // Verify other user's session remains active
    const user98Active = db.authSessions.filter((s) => s.user_id === 98 && !s.revoked);
    assert.equal(user98Active.length, 1, "Other user's session must not be revoked");

    // Verify cookie clearing headers are present
    const setCookie = res.headers.get("set-cookie") || "";
    assert.ok(setCookie.includes("Max-Age=0"), "Set-Cookie headers must clear auth cookies");
  });
});

describe("Multi-Tenant User and Workspace Isolation", () => {
  it("enforces user isolation so refresh operations never affect other accounts", async () => {
    const db = createMockAuthDb([
      { id: 1, email: "user1@rota.local", name: "User One", role: "Front Desk" },
      { id: 2, email: "user2@rota.local", name: "User Two", role: "Manager" },
    ]);

    const sess1 = await createAuthSession(db.sql, { userId: 1, teamId: 10 });
    const sess2 = await createAuthSession(db.sql, { userId: 2, teamId: 20 });

    // User 1 refreshes
    const req1 = new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${sess1.refreshToken}` },
    });
    const res1 = await handleRefresh(req1, { sql: db.sql, getSecret: () => TEST_SECRET });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.user.id, 1);
    assert.equal(data1.user.teamId, 10);

    // Verify User 2's session is untouched
    const stored2 = db.authSessions.find((s) => s.session_id === sess2.sessionId);
    assert.equal(stored2.revoked, false);
    assert.equal(stored2.user_id, 2);
    assert.equal(stored2.team_id, 20);
  });
});

