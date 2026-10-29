import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
} from "../lib/auth.ts";
import { getSessionCookieOptions } from "../lib/session.ts";
import { handleLogin } from "../app/api/auth/login/route.ts";
import { handleRegister } from "../app/api/auth/register/route.ts";
import { handleForgotPassword } from "../app/api/auth/forgot-password/route.ts";

const TEST_SECRET = "test_auth_secret_0123456789abcdef0123456789abcdef";

describe("Phase One: Authentication Cryptographic & Session Primitives", () => {
  it("generates unique salts and hashes for identical passwords", () => {
    const pw = "CorrectHorseBatteryStaple!";
    const res1 = hashPassword(pw);
    const res2 = hashPassword(pw);

    assert.notEqual(res1.salt, res2.salt, "Salts must be distinct and random");
    assert.notEqual(res1.hash, res2.hash, "Hashes with distinct salts must differ");
    assert.equal(verifyPassword(pw, res1.hash, res1.salt), true);
    assert.equal(verifyPassword(pw, res2.hash, res2.salt), true);
  });

  it("verifies passwords in constant time and rejects invalid passwords", () => {
    const { hash, salt } = hashPassword("SuperSecret123");
    assert.equal(verifyPassword("SuperSecret123", hash, salt), true);
    assert.equal(verifyPassword("WrongPassword!", hash, salt), false);
    assert.equal(verifyPassword("", hash, salt), false);
    assert.equal(verifyPassword("SuperSecret123", "", salt), false);
    assert.equal(verifyPassword("SuperSecret123", hash, ""), false);
  });

  it("creates and verifies signed HMAC-SHA256 session tokens", () => {
    const payload = {
      userId: 42,
      email: "engineer@rota.local",
      name: "Lead Engineer",
      role: "Operations",
    };

    const token = createSessionToken(payload, TEST_SECRET, 3600);
    assert.ok(typeof token === "string" && token.includes("."));

    const verified = verifySessionToken(token, TEST_SECRET);
    assert.ok(verified !== null);
    assert.equal(verified.userId, 42);
    assert.equal(verified.email, "engineer@rota.local");
    assert.equal(verified.name, "Lead Engineer");
    assert.equal(verified.role, "Operations");
  });

  it("rejects tampered or expired session tokens", () => {
    const payload = {
      userId: 1,
      email: "staff@rota.local",
      name: "Staff Member",
      role: "Front Desk",
    };

    const validToken = createSessionToken(payload, TEST_SECRET, 3600);
    const [body, sig] = validToken.split(".");

    // Tamper with payload
    const tamperedBody = Buffer.from(JSON.stringify({ ...payload, role: "Admin" })).toString("base64url");
    assert.equal(verifySessionToken(`${tamperedBody}.${sig}`, TEST_SECRET), null);

    // Expired token (negative lifespan)
    const expiredToken = createSessionToken(payload, TEST_SECRET, -60);
    assert.equal(verifySessionToken(expiredToken, TEST_SECRET), null);
  });

  it("enforces HttpOnly, SameSite=Lax, and proper path in cookie options", () => {
    const opts = getSessionCookieOptions();
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.sameSite, "lax");
    assert.equal(opts.path, "/");
    assert.equal(opts.maxAge, 7 * 24 * 60 * 60);

    const logoutOpts = getSessionCookieOptions(0);
    assert.equal(logoutOpts.maxAge, 0);
  });
});

describe("Phase One: Login API Handler (handleLogin)", () => {
  const pwData = hashPassword("validSecretPassword8");
  const existingUser = {
    id: 10,
    email: "sarah@rota.local",
    password_hash: pwData.hash,
    password_salt: pwData.salt,
    name: "Sarah Bello",
    role: "Front Desk",
  };

  function createMockSql(users = [existingUser]) {
    return async (strings, ...values) => {
      const query = strings.join("?");
      if (query.includes("FROM users") && query.includes("LOWER(TRIM(email))")) {
        const emailParam = values[0];
        const match = users.find((u) => u.email.toLowerCase() === String(emailParam).toLowerCase());
        return match ? [match] : [];
      }
      return [];
    };
  }

  it("rejects requests with malformed JSON body", async () => {
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: "this is not json",
    });

    const res = await handleLogin(req, {
      sql: createMockSql(),
      getSecret: () => TEST_SECRET,
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("Invalid JSON"));
  });

  it("rejects requests with missing email or password", async () => {
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sarah@rota.local" }),
    });

    const res = await handleLogin(req, {
      sql: createMockSql(),
      getSecret: () => TEST_SECRET,
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("Email and password are required"));
  });

  it("returns 401 with generic message for non-existent user", async () => {
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "unknown@rota.local", password: "somePassword" }),
    });

    const res = await handleLogin(req, {
      sql: createMockSql(),
      getSecret: () => TEST_SECRET,
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "Invalid email or password.");
  });

  it("returns 401 with generic message for incorrect password", async () => {
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sarah@rota.local", password: "WrongPassword" }),
    });

    const res = await handleLogin(req, {
      sql: createMockSql(),
      getSecret: () => TEST_SECRET,
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "Invalid email or password.");
  });

  it("authenticates valid credentials, sets HttpOnly session cookie, and does not leak secrets", async () => {
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sarah@rota.local", password: "validSecretPassword8" }),
    });

    const res = await handleLogin(req, {
      sql: createMockSql(),
      getSecret: () => TEST_SECRET,
    });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.id, 10);
    assert.equal(data.email, "sarah@rota.local");
    assert.equal(data.name, "Sarah Bello");
    assert.equal(data.role, "Front Desk");
    assert.equal(data.password_hash, undefined, "Password hash must never be returned");
    assert.equal(data.password_salt, undefined, "Password salt must never be returned");

    const cookieHeader = res.headers.get("set-cookie");
    assert.ok(cookieHeader && cookieHeader.includes("rota_session="));
    assert.ok(cookieHeader.toLowerCase().includes("httponly"));
  });
});

describe("Phase One: Registration API Handler (handleRegister)", () => {
  function createRegisterMockSql(existingEmails = ["existing@rota.local"]) {
    const createdUsers = [];
    let nextId = 20;

    return {
      sql: async (strings, ...values) => {
        const query = strings.join("?");
        if (query.includes("FROM users") && query.includes("LOWER(TRIM(email))")) {
          const emailParam = values[0].toLowerCase();
          const found = existingEmails.includes(emailParam) || createdUsers.some((u) => u.email === emailParam);
          return found ? [{ id: 99 }] : [];
        }

        if (query.includes("INSERT INTO users")) {
          const [email, hash, salt, name, role] = values;
          const user = { id: nextId++, email, password_hash: hash, password_salt: salt, name, role };
          createdUsers.push(user);
          return [user];
        }

        return [];
      },
      createdUsers,
    };
  }

  it("rejects registration with missing or invalid fields", async () => {
    const mock = createRegisterMockSql();

    // Short name
    const req1 = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A", email: "new@rota.local", password: "Password123" }),
    });
    const res1 = await handleRegister(req1, { sql: mock.sql, getSecret: () => TEST_SECRET });
    assert.equal(res1.status, 400);

    // Invalid email
    const req2 = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Adaeze Nwosu", email: "invalid-email", password: "Password123" }),
    });
    const res2 = await handleRegister(req2, { sql: mock.sql, getSecret: () => TEST_SECRET });
    assert.equal(res2.status, 400);

    // Short password (< 8 chars)
    const req3 = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Adaeze Nwosu", email: "new@rota.local", password: "short" }),
    });
    const res3 = await handleRegister(req3, { sql: mock.sql, getSecret: () => TEST_SECRET });
    assert.equal(res3.status, 400);
  });

  it("rejects duplicate email registrations with HTTP 409 Conflict", async () => {
    const mock = createRegisterMockSql(["existing@rota.local"]);

    const req = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "EXISTING@rota.local",
        password: "ValidPassword123!",
      }),
    });

    const res = await handleRegister(req, { sql: mock.sql, getSecret: () => TEST_SECRET });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.ok(data.error.includes("already exists"));
  });

  it("registers new account, hashes password, sets session cookie, and prevents unauthorized role escalation", async () => {
    const mock = createRegisterMockSql();

    // Attempting to register as "Admin" or "Supervisor" must be refused and defaulted to "Front Desk"
    const req = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Adaeze Nwosu",
        email: "adaeze@rota.local",
        password: "StrongPassword89!",
        role: "Admin", // Attempted privilege escalation
      }),
    });

    const res = await handleRegister(req, { sql: mock.sql, getSecret: () => TEST_SECRET });
    assert.equal(res.status, 201);

    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.email, "adaeze@rota.local");
    assert.equal(data.user.name, "Adaeze Nwosu");
    assert.equal(data.user.role, "Front Desk", "Must default to Front Desk, preventing self-assigned Admin role");
    assert.equal(data.user.password_hash, undefined);
    assert.equal(data.user.password_salt, undefined);

    // Verify stored user in mock database has valid scrypt hash
    const stored = mock.createdUsers[0];
    assert.ok(stored.password_hash && stored.password_salt);
    assert.equal(verifyPassword("StrongPassword89!", stored.password_hash, stored.password_salt), true);

    // Verify session cookie was set
    const cookieHeader = res.headers.get("set-cookie");
    assert.ok(cookieHeader && cookieHeader.includes("rota_session="));
  });
});

describe("Phase One: Password Recovery API Handler (handleForgotPassword)", () => {
  it("rejects invalid email formats with HTTP 400", async () => {
    const req = new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "invalid-email-format" }),
    });

    const res = await handleForgotPassword(req, {
      sql: async () => [],
    });
    assert.equal(res.status, 400);
  });

  it("returns generic 200 response preventing account enumeration for both known and unknown emails", async () => {
    const req1 = new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "known@rota.local" }),
    });
    const res1 = await handleForgotPassword(req1, {
      sql: async () => [{ id: 1, email: "known@rota.local" }],
    });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.success, true);

    const req2 = new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nonexistent@rota.local" }),
    });
    const res2 = await handleForgotPassword(req2, {
      sql: async () => [],
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.success, true);
    assert.equal(data1.message, data2.message, "Response messages must be identical to prevent enumeration");
  });
});
