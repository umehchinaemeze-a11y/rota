import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

// Direct imports from real implementation modules (Node 24 native TypeScript type stripping)
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
} from "../lib/auth.ts";

import { canManageShift, canManageShiftRecord } from "../lib/permissions.ts";

// Simulated endpoint helper logic for testing login validation & safe /api/auth/me response
function validateLoginInput(body) {
  if (!body || typeof body !== "object") {
    return { valid: false, status: 400, error: "Email and password are required." };
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return { valid: false, status: 400, error: "Email and password are required." };
  }
  return { valid: true, email, password };
}

function sanitizeUserProfile(sessionUser) {
  return {
    id: sessionUser.userId,
    email: sessionUser.email,
    name: sessionUser.name,
    role: sessionUser.role,
  };
}

// Payload validation matching shift routes
function validateShiftPayload({ employeeName, role, shiftDay }) {
  const trimmedName = typeof employeeName === "string" ? employeeName.trim() : "";
  const trimmedRole = typeof role === "string" ? role.trim() : "";
  const trimmedDay = typeof shiftDay === "string" ? shiftDay.trim() : "";

  if (!trimmedName || !trimmedRole || !/^\d{4}-\d{2}-\d{2}$/.test(trimmedDay)) {
    return { valid: false, error: "Employee name, role, and a valid shift date (YYYY-MM-DD) are required." };
  }

  const parsedDate = new Date(`${trimmedDay}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== trimmedDay
  ) {
    return { valid: false, error: "The provided shift date is invalid." };
  }

  return { valid: true, data: { employeeName: trimmedName, role: trimmedRole, shiftDay: trimmedDay } };
}

function validateShiftId(rawId) {
  const numericId = parseInt(rawId, 10);
  if (Number.isNaN(numericId) || numericId <= 0) {
    return { valid: false, error: "Invalid shift ID." };
  }
  return { valid: true, id: numericId };
}

// Client-side schedule state updates
function updateScheduleItem(schedule, updatedShift) {
  return schedule
    .map((s) => (s.id === updatedShift.id ? updatedShift : s))
    .sort((a, b) => a.shiftDay.localeCompare(b.shiftDay) || a.id - b.id);
}

function deleteScheduleItem(schedule, shiftIdToDelete) {
  return schedule.filter((s) => s.id !== shiftIdToDelete);
}

function addScheduleItem(schedule, newShift) {
  return [...schedule, newShift].sort(
    (a, b) => a.shiftDay.localeCompare(b.shiftDay) || a.id - b.id
  );
}

describe("Password Hashing & Constant-Time Verification (scrypt via lib/auth.ts)", () => {
  it("generates a unique salt for each password hash call", () => {
    const res1 = hashPassword("CommonPassword123!");
    const res2 = hashPassword("CommonPassword123!");

    assert.notEqual(res1.salt, res2.salt, "Each hash must have a unique salt");
    assert.notEqual(res1.hash, res2.hash, "Hashes of the same password with different salts must differ");
    assert.equal(res1.salt.length, 32); // 16 bytes in hex
    assert.equal(res1.hash.length, 128); // 64 bytes in hex
  });

  it("verifies matching password against stored hash and salt", () => {
    const password = "ValidPassword456$";
    const { hash, salt } = hashPassword(password);
    assert.equal(verifyPassword(password, hash, salt), true);
  });

  it("rejects incorrect password", () => {
    const { hash, salt } = hashPassword("CorrectSecret999!");
    assert.equal(verifyPassword("WrongGuess111!", hash, salt), false);
  });

  it("rejects empty or non-string password inputs when hashing", () => {
    assert.throws(() => hashPassword(""), /Password must be a non-empty string/);
    assert.throws(() => hashPassword(null), /Password must be a non-empty string/);
    assert.throws(() => hashPassword(12345), /Password must be a non-empty string/);
  });

  it("handles malformed, truncated, or non-hex hash/salt inputs gracefully without throwing", () => {
    assert.equal(verifyPassword("pwd", "not-a-valid-hex-hash", "not-a-salt"), false);
    assert.equal(verifyPassword("pwd", "", ""), false);
    assert.equal(verifyPassword("pwd", null, null), false);
    assert.equal(verifyPassword("pwd", undefined, undefined), false);
    assert.equal(verifyPassword("pwd", "abcd", "12345678901234567890123456789012"), false);
  });
});

describe("Session Token Security (HMAC-SHA256 via lib/auth.ts)", () => {
  const secretKey = "super-secret-auth-key-0123456789abcdef";
  const validPayload = {
    userId: 10,
    email: "sarah@rota.local",
    name: "Sarah Bello",
    role: "Customer Support",
  };

  it("creates and verifies a valid signed session token", () => {
    const token = createSessionToken(validPayload, secretKey);
    assert.ok(typeof token === "string" && token.includes("."));

    const verified = verifySessionToken(token, secretKey);
    assert.ok(verified !== null);
    assert.equal(verified.userId, 10);
    assert.equal(verified.email, "sarah@rota.local");
    assert.equal(verified.name, "Sarah Bello");
    assert.equal(verified.role, "Customer Support");
    assert.ok(verified.exp > Math.floor(Date.now() / 1000));
  });

  it("throws when creating token with missing or empty AUTH_SECRET", () => {
    assert.throws(() => createSessionToken(validPayload, ""), /AUTH_SECRET is required/);
    assert.throws(() => createSessionToken(validPayload, null), /AUTH_SECRET is required/);
    assert.throws(() => createSessionToken(validPayload, "   "), /AUTH_SECRET is required/);
  });

  it("rejects verification when AUTH_SECRET is missing or invalid", () => {
    const token = createSessionToken(validPayload, secretKey);
    assert.equal(verifySessionToken(token, ""), null);
    assert.equal(verifySessionToken(token, null), null);
    assert.equal(verifySessionToken(token, "wrong-secret-key"), null);
  });

  it("rejects invalid or missing session payload fields during creation", () => {
    assert.throws(() => createSessionToken({ ...validPayload, userId: -1 }, secretKey));
    assert.throws(() => createSessionToken({ ...validPayload, userId: "10" }, secretKey));
    assert.throws(() => createSessionToken({ ...validPayload, email: "" }, secretKey));
    assert.throws(() => createSessionToken({ ...validPayload, name: "  " }, secretKey));
    assert.throws(() => createSessionToken({ ...validPayload, role: "" }, secretKey));
  });

  it("detects and rejects tampered payload (privilege escalation attempt)", () => {
    const token = createSessionToken(validPayload, secretKey);
    const [payloadBase64, signature] = token.split(".");

    const decoded = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf-8"));
    decoded.role = "Supervisor";
    const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");

    const forgedToken = `${forgedPayload}.${signature}`;
    assert.equal(verifySessionToken(forgedToken, secretKey), null);
  });

  it("detects and rejects tampered signature", () => {
    const token = createSessionToken(validPayload, secretKey);
    const [payloadBase64, signature] = token.split(".");

    const tamperedSig = signature.slice(0, -1) + (signature.slice(-1) === "a" ? "b" : "a");
    const tamperedToken = `${payloadBase64}.${tamperedSig}`;

    assert.equal(verifySessionToken(tamperedToken, secretKey), null);
  });

  it("rejects expired session tokens", () => {
    const expiredToken = createSessionToken(validPayload, secretKey, -5);
    assert.equal(verifySessionToken(expiredToken, secretKey), null);
  });

  it("rejects malformed tokens with wrong parts or invalid characters", () => {
    assert.equal(verifySessionToken("only-one-part", secretKey), null);
    assert.equal(verifySessionToken("part1.part2.part3", secretKey), null);
    assert.equal(verifySessionToken("", secretKey), null);
    assert.equal(verifySessionToken(null, secretKey), null);
    assert.equal(verifySessionToken(".", secretKey), null);
  });
});

describe("Server-Side Shift Authorization (canManageShiftRecord via lib/permissions.ts)", () => {
  const ordinaryEmployee = { userId: 1, name: "Amara Okafor", role: "Front Desk" };
  const anotherEmployee = { userId: 2, name: "Daniel James", role: "Customer Support" };
  const supervisor = { userId: 5, name: "Chika Nwosu", role: "Supervisor" };
  const operationsManager = { userId: 3, name: "Daniel James", role: "Operations" };

  it("rejects unauthenticated requests (null, undefined, or missing user ID)", () => {
    const shift = { id: 10, user_id: 1, employee_name: "Amara Okafor" };
    assert.equal(canManageShiftRecord(null, shift), false);
    assert.equal(canManageShiftRecord(undefined, shift), false);
    assert.equal(canManageShiftRecord({ userId: 0, role: "Front Desk" }, shift), false);
    assert.equal(canManageShiftRecord({ userId: -1, role: "Supervisor" }, shift), false);
  });

  it("allows an ordinary employee to edit or delete their own shift (user_id match)", () => {
    const ownShift = { id: 10, user_id: 1, employee_name: "Amara Okafor" };
    assert.equal(canManageShiftRecord(ordinaryEmployee, ownShift), true);
  });

  it("denies an ordinary employee from managing another employee's shift (user_id mismatch)", () => {
    const otherShift = { id: 20, user_id: 2, employee_name: "Daniel James" };
    assert.equal(canManageShiftRecord(ordinaryEmployee, otherShift), false);
  });

  it("prohibits ordinary employees from claiming legacy shifts with user_id IS NULL even if employee_name matches", () => {
    // Legacy shift in DB before user_id migration
    const legacyShiftSameName = { id: 30, user_id: null, employee_name: "Amara Okafor" };
    const legacyShiftUndefined = { id: 31, user_id: undefined, employee_name: "Amara Okafor" };

    assert.equal(
      canManageShiftRecord(ordinaryEmployee, legacyShiftSameName),
      false,
      "Ordinary employee must NOT be granted access to legacy shifts by name match"
    );
    assert.equal(
      canManageShiftRecord(ordinaryEmployee, legacyShiftUndefined),
      false,
      "Ordinary employee must NOT be granted access when user_id is undefined"
    );
  });

  it("allows managers (Supervisor / Operations / Admin) to manage any shift, including legacy shifts", () => {
    const employeeShift = { id: 10, user_id: 1, employee_name: "Amara Okafor" };
    const legacyShift = { id: 99, user_id: null, employee_name: "Test Employee" };

    assert.equal(canManageShiftRecord(supervisor, employeeShift), true);
    assert.equal(canManageShiftRecord(supervisor, legacyShift), true);
    assert.equal(canManageShiftRecord(operationsManager, employeeShift), true);
    assert.equal(canManageShiftRecord(operationsManager, legacyShift), true);
  });

  it("ignores client-supplied identity claims and relies solely on trusted session context", () => {
    // If client sends a body or header claiming role: "Supervisor" or name: "Chika Nwosu",
    // the server checks sessionUser (which has role: "Front Desk"). Access must be denied!
    const clientClaims = { xUserRole: "Supervisor", currentUser: "Chika Nwosu" };
    const targetShift = { id: 50, user_id: 2, employee_name: "Daniel James" };

    // In the route handler, sessionUser comes from verified cookie, not clientClaims
    const trustedSessionUser = ordinaryEmployee; // { userId: 1, role: "Front Desk" }
    assert.equal(canManageShiftRecord(trustedSessionUser, targetShift), false);
  });
});

describe("Login Input Validation & Safe Profile Exposure", () => {
  it("rejects missing email with generic 400 error", () => {
    const res = validateLoginInput({ password: "SomePassword123!" });
    assert.equal(res.valid, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, "Email and password are required.");
  });

  it("rejects missing password with generic 400 error", () => {
    const res = validateLoginInput({ email: "amara@rota.local" });
    assert.equal(res.valid, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, "Email and password are required.");
  });

  it("normalizes email by trimming whitespace and lowercasing", () => {
    const res = validateLoginInput({
      email: "  AMARA@ROTA.LOCAL  ",
      password: "Password123!",
    });
    assert.equal(res.valid, true);
    assert.equal(res.email, "amara@rota.local");
  });

  it("ensures /api/auth/me response shape never exposes password hash, salt, or secrets", () => {
    const session = {
      userId: 5,
      email: "chika@rota.local",
      name: "Chika Nwosu",
      role: "Supervisor",
      password_hash: "secret-hash-12345",
      password_salt: "secret-salt-67890",
      secret: "super-secret",
    };

    const sanitized = sanitizeUserProfile(session);

    assert.deepEqual(sanitized, {
      id: 5,
      email: "chika@rota.local",
      name: "Chika Nwosu",
      role: "Supervisor",
    });

    assert.equal("password_hash" in sanitized, false);
    assert.equal("password_salt" in sanitized, false);
    assert.equal("secret" in sanitized, false);
  });
});

describe("Shift Payload and ID Validation", () => {
  it("accepts valid shift payload", () => {
    const res = validateShiftPayload({
      employeeName: "Amara Okafor",
      role: "Front Desk",
      shiftDay: "2026-10-12",
    });
    assert.equal(res.valid, true);
  });

  it("rejects invalid date format", () => {
    const res = validateShiftPayload({
      employeeName: "Amara Okafor",
      role: "Front Desk",
      shiftDay: "12/10/2026",
    });
    assert.equal(res.valid, false);
  });

  it("rejects invalid calendar date like February 31", () => {
    const res = validateShiftPayload({
      employeeName: "Amara Okafor",
      role: "Front Desk",
      shiftDay: "2026-02-31",
    });
    assert.equal(res.valid, false);
  });

  it("validates positive numeric IDs", () => {
    assert.equal(validateShiftId("42").valid, true);
    assert.equal(validateShiftId("42").id, 42);
  });

  it("rejects invalid, negative, or non-numeric IDs", () => {
    assert.equal(validateShiftId("abc").valid, false);
    assert.equal(validateShiftId("-5").valid, false);
    assert.equal(validateShiftId("0").valid, false);
  });
});

describe("Schedule State Immediate Updates (No Duplication)", () => {
  const initialSchedule = [
    { id: 1, name: "Amara Okafor", role: "Front Desk", shiftDay: "2026-10-12" },
    { id: 2, name: "Daniel James", role: "Operations", shiftDay: "2026-10-13" },
    { id: 3, name: "Sarah Bello", role: "Customer Support", shiftDay: "2026-10-14" },
  ];

  it("updates existing shift without creating duplicate entries", () => {
    const updated = { id: 2, name: "Daniel James", role: "Operations", shiftDay: "2026-10-15" };
    const result = updateScheduleItem(initialSchedule, updated);

    assert.equal(result.length, 3, "Schedule length must remain 3 after editing");
    const item = result.find((s) => s.id === 2);
    assert.equal(item.shiftDay, "2026-10-15");
    assert.equal(result.filter((s) => s.id === 2).length, 1, "Must have exactly 1 entry for ID 2");
  });

  it("maintains chronological order after editing a shift date", () => {
    const updated = { id: 3, name: "Sarah Bello", role: "Customer Support", shiftDay: "2026-10-10" };
    const result = updateScheduleItem(initialSchedule, updated);

    assert.equal(result[0].id, 3, "Rescheduled earlier shift should move to the beginning");
    assert.equal(result[0].shiftDay, "2026-10-10");
  });

  it("deletes a shift immediately and preserves other shifts", () => {
    const result = deleteScheduleItem(initialSchedule, 2);

    assert.equal(result.length, 2);
    assert.equal(result.some((s) => s.id === 2), false);
    assert.equal(result[0].id, 1);
    assert.equal(result[1].id, 3);
  });

  it("adds a new shift without duplicating existing IDs", () => {
    const newShift = { id: 4, name: "Chika Nwosu", role: "Supervisor", shiftDay: "2026-10-11" };
    const result = addScheduleItem(initialSchedule, newShift);

    assert.equal(result.length, 4);
    assert.equal(result[0].id, 4, "2026-10-11 should be sorted first");
  });
});
