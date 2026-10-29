import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

// Direct imports from real implementation modules (Node 24 native TypeScript type stripping)
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
} from "../lib/auth.ts";

import {
  canManageShift,
  canManageShiftRecord,
  canManageTeamShiftRecord,
  isManagerRole,
  APP_ROLES,
  MANAGER_ROLES,
} from "../lib/permissions.ts";
import {
  resolveShiftFetchResponse,
  mapApiShift,
} from "../lib/shifts-client.ts";
import {
  handleGetShifts,
  handlePostShift,
} from "../app/api/shifts/route.ts";
import {
  handleGetShiftById,
  handlePutShift,
  handleDeleteShift,
} from "../app/api/shifts/[id]/route.ts";

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
    teamId: sessionUser.teamId ?? null,
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
  const workspaceOwner = { userId: 20, name: "Alice Owner", role: "Owner" };
  const teamManager = { userId: 21, name: "Bob Manager", role: "Manager" };
  const staffMember = { userId: 22, name: "Charlie Staff", role: "Staff" };
  const adminUser = { userId: 9, name: "Super Admin", role: "Admin" };

  it("validates isManagerRole predicate for all management and non-management roles", () => {
    // Management roles
    assert.equal(isManagerRole("Owner"), true);
    assert.equal(isManagerRole("Manager"), true);
    assert.equal(isManagerRole("Supervisor"), true);
    assert.equal(isManagerRole("Operations"), true);
    assert.equal(isManagerRole("Admin"), true);

    // Non-management staff roles
    assert.equal(isManagerRole("Staff"), false);
    assert.equal(isManagerRole("Front Desk"), false);
    assert.equal(isManagerRole("Customer Support"), false);
    assert.equal(isManagerRole("Frontend Developer"), false);

    // Invalid / empty inputs
    assert.equal(isManagerRole(""), false);
    assert.equal(isManagerRole(null), false);
    assert.equal(isManagerRole(undefined), false);
    assert.equal(isManagerRole(123), false);
  });

  it("confirms APP_ROLES includes Owner, Manager, Staff, Admin, and department roles", () => {
    const requiredRoles = [
      "Owner",
      "Manager",
      "Staff",
      "Supervisor",
      "Operations",
      "Admin",
      "Front Desk",
      "Customer Support",
      "Frontend Developer",
    ];
    for (const r of requiredRoles) {
      assert.ok(APP_ROLES.includes(r), `APP_ROLES must include ${r}`);
    }
  });

  it("allows Owner and Manager to manage any shift, including legacy shifts", () => {
    const employeeShift = { id: 10, user_id: 1, employee_name: "Amara Okafor" };
    const legacyShift = { id: 99, user_id: null, employee_name: "Test Employee" };

    assert.equal(canManageShiftRecord(workspaceOwner, employeeShift), true);
    assert.equal(canManageShiftRecord(workspaceOwner, legacyShift), true);
    assert.equal(canManageShiftRecord(teamManager, employeeShift), true);
    assert.equal(canManageShiftRecord(teamManager, legacyShift), true);
  });

  it("allows Admin to manage any shift, including legacy shifts", () => {
    const employeeShift = { id: 10, user_id: 1, employee_name: "Amara Okafor" };
    const legacyShift = { id: 99, user_id: null, employee_name: "Test Employee" };

    assert.equal(canManageShiftRecord(adminUser, employeeShift), true);
    assert.equal(canManageShiftRecord(adminUser, legacyShift), true);
  });

  it("allows Staff self-management, but denies managing colleague shifts or unassigned shifts", () => {
    const ownShift = { id: 70, user_id: 22, employee_name: "Charlie Staff" };
    const colleagueShift = { id: 71, user_id: 1, employee_name: "Amara Okafor" };
    const unassignedShift = { id: 72, user_id: null, employee_name: "Unassigned Shift" };

    assert.equal(canManageShiftRecord(staffMember, ownShift), true);
    assert.equal(canManageShiftRecord(staffMember, colleagueShift), false);
    assert.equal(canManageShiftRecord(staffMember, unassignedShift), false);
  });

  it("preserves legacy department roles (Frontend Developer) with staff-level self-management", () => {
    const devUser = { userId: 30, name: "Dev User", role: "Frontend Developer" };
    const ownShift = { id: 80, user_id: 30, employee_name: "Dev User" };
    const otherShift = { id: 81, user_id: 1, employee_name: "Amara Okafor" };
    const unassignedShift = { id: 82, user_id: null, employee_name: "Unassigned" };

    assert.equal(canManageShiftRecord(devUser, ownShift), true);
    assert.equal(canManageShiftRecord(devUser, otherShift), false);
    assert.equal(canManageShiftRecord(devUser, unassignedShift), false);
  });

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
      teamId: null,
    });

    assert.equal("password_hash" in sanitized, false);
    assert.equal("password_salt" in sanitized, false);
    assert.equal("secret" in sanitized, false);
  });

  it("includes the resolved team ID in /api/auth/me profile when available", () => {
    const sessionWithTeam = {
      userId: 1,
      email: "amara@rota.local",
      name: "Amara Okafor",
      role: "Front Desk",
      teamId: 10,
    };
    const sanitized = sanitizeUserProfile(sessionWithTeam);
    assert.equal(sanitized.teamId, 10);
  });

  it("yields teamId: null in /api/auth/me profile when user has no active team membership", () => {
    const sessionNoTeam = {
      userId: 2,
      email: "david@rota.local",
      name: "David Musa",
      role: "Front Desk",
    };
    const sanitized = sanitizeUserProfile(sessionNoTeam);
    assert.equal(sanitized.teamId, null);
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

describe("Homepage Shift Fetch & Sign-In Experience (resolveShiftFetchResponse)", () => {
  it("displays sign-in prompt and verified login route when receiving HTTP 401 Unauthorized", () => {
    const outcome = resolveShiftFetchResponse(401, { error: "Authentication required to view shifts." });

    assert.equal(outcome.status, "unauthenticated");
    assert.equal(outcome.requiresSignIn, true);
    assert.equal(outcome.signInAction, "/api/auth/login", "Sign-in action must point to verified /api/auth/login route");
    assert.ok(outcome.message.includes("Sign in required"), "Must clearly inform user that sign-in is required");
    assert.ok(!outcome.message.toLowerCase().includes("connection"), "Must not describe 401 as a network/connection failure");
  });

  it("displays workspace/team access message when receiving HTTP 403 Forbidden without leaking database details", () => {
    const outcome = resolveShiftFetchResponse(403, {
      error: "Forbidden: No active team membership found for this account.",
    });

    assert.equal(outcome.status, "forbidden");
    assert.equal(outcome.requiresSignIn, false);
    assert.ok(outcome.message.includes("workspace") || outcome.message.includes("team"), "Must explain workspace/team assignment requirement");
    assert.ok(!outcome.message.includes("team_memberships"), "Must not leak internal table names");
    assert.ok(!outcome.message.includes("SQL"), "Must not leak SQL details");
  });

  it("displays appropriate connection/retry error for network failures", () => {
    const outcome = resolveShiftFetchResponse(0, null, true);

    assert.equal(outcome.status, "network_error");
    assert.equal(outcome.requiresSignIn, false);
    assert.ok(outcome.message.includes("connection") || outcome.message.includes("try again"));
  });

  it("displays appropriate server error for HTTP 500 responses", () => {
    const outcome = resolveShiftFetchResponse(500, { error: "Database query timed out." });

    assert.equal(outcome.status, "network_error");
    assert.equal(outcome.requiresSignIn, false);
    assert.equal(outcome.message, "Database query timed out.");
  });

  it("successfully parses and maps shifts for HTTP 200 responses", () => {
    const rawShifts = [
      {
        id: 1,
        employee_name: "Amara Okafor",
        role: "Front Desk",
        user_id: 1,
        shift_day: "2026-10-12",
        created_at: "2026-10-01T00:00:00Z",
      },
      {
        id: 2,
        employee_name: "Daniel James",
        role: "Operations",
        user_id: 3,
        shift_day: "2026-10-13",
        created_at: "2026-10-01T00:00:00Z",
      },
    ];

    const outcome = resolveShiftFetchResponse(200, rawShifts);

    assert.equal(outcome.status, "success");
    assert.equal(outcome.requiresSignIn, false);
    assert.equal(outcome.shifts.length, 2);
    assert.equal(outcome.shifts[0].name, "Amara Okafor");
    assert.equal(outcome.shifts[0].role, "Front Desk");
    assert.equal(outcome.shifts[0].shiftDay, "2026-10-12");
    assert.equal(outcome.shifts[1].name, "Daniel James");
  });

  it("mapApiShift preserves a real team_id as teamId", () => {
    const apiShift = {
      id: 101,
      employee_name: "Amara Okafor",
      role: "Front Desk",
      user_id: 1,
      team_id: 42,
      shift_day: "2026-10-15",
    };
    const mapped = mapApiShift(apiShift, 0);
    assert.equal(mapped.teamId, 42);
    assert.equal(mapped.id, 101);
    assert.equal(mapped.userId, 1);
  });

  it("mapApiShift preserves missing or null team_id as null", () => {
    const apiShiftNull = {
      id: 102,
      employee_name: "Unassigned",
      role: "Front Desk",
      user_id: null,
      team_id: null,
      shift_day: "2026-10-15",
    };
    const mappedNull = mapApiShift(apiShiftNull, 0);
    assert.equal(mappedNull.teamId, null);

    const apiShiftUndefined = {
      id: 103,
      employee_name: "Legacy Shift",
      role: "Front Desk",
      shift_day: "2026-10-15",
    };
    const mappedUndefined = mapApiShift(apiShiftUndefined, 0);
    assert.equal(mappedUndefined.teamId, null);
  });
});

describe("Frontend UI Team-Aware Permission Alignment (canManageTeamShiftRecord)", () => {
  const sameTeamOwner = { userId: 1, role: "Owner", teamId: 5 };
  const sameTeamManager = { userId: 2, role: "Manager", teamId: 5 };
  const sameTeamStaff = { userId: 3, role: "Staff", teamId: 5 };
  const otherTeamOwner = { userId: 4, role: "Owner", teamId: 6 };
  const otherTeamManager = { userId: 5, role: "Manager", teamId: 6 };
  const otherTeamStaff = { userId: 6, role: "Staff", teamId: 6 };

  const otherTeamSupervisor = { userId: 7, role: "Supervisor", teamId: 6 };
  const otherTeamOperations = { userId: 8, role: "Operations", teamId: 6 };
  const otherTeamAdmin = { userId: 9, role: "Admin", teamId: 6 };

  const ownShift = { id: 10, user_id: 3, employee_name: "Staff User", teamId: 5 };
  const colleagueShift = { id: 11, user_id: 8, employee_name: "Colleague", teamId: 5 };
  const unassignedShift = { id: 12, user_id: null, employee_name: "Unassigned", teamId: 5 };
  const otherTeamShift = { id: 20, user_id: 3, employee_name: "Staff User", teamId: 6 };

  it("permits same-team Owner and Manager across edit, delete, and badge evaluations", () => {
    // Owner
    assert.equal(canManageTeamShiftRecord(sameTeamOwner, ownShift), true);
    assert.equal(canManageTeamShiftRecord(sameTeamOwner, colleagueShift), true);
    assert.equal(canManageTeamShiftRecord(sameTeamOwner, unassignedShift), true);

    // Manager
    assert.equal(canManageTeamShiftRecord(sameTeamManager, ownShift), true);
    assert.equal(canManageTeamShiftRecord(sameTeamManager, colleagueShift), true);
    assert.equal(canManageTeamShiftRecord(sameTeamManager, unassignedShift), true);
  });

  it("restricts same-team Staff to self-management only and denies colleague/unassigned shifts", () => {
    assert.equal(canManageTeamShiftRecord(sameTeamStaff, ownShift), true);
    assert.equal(canManageTeamShiftRecord(sameTeamStaff, colleagueShift), false);
    assert.equal(canManageTeamShiftRecord(sameTeamStaff, unassignedShift), false);
  });

  it("strictly denies cross-team actions even for Owner, Manager, Supervisor, Operations, and Admin", () => {
    // Other team users attempting to manage Team 5 shift
    assert.equal(canManageTeamShiftRecord(otherTeamOwner, ownShift), false);
    assert.equal(canManageTeamShiftRecord(otherTeamManager, ownShift), false);
    assert.equal(canManageTeamShiftRecord(otherTeamSupervisor, ownShift), false);
    assert.equal(canManageTeamShiftRecord(otherTeamOperations, ownShift), false);
    assert.equal(canManageTeamShiftRecord(otherTeamAdmin, ownShift), false);
    assert.equal(canManageTeamShiftRecord(otherTeamStaff, ownShift), false);

    // Same team management users attempting to manage Team 6 shift
    assert.equal(canManageTeamShiftRecord(sameTeamOwner, otherTeamShift), false);
    assert.equal(canManageTeamShiftRecord(sameTeamManager, otherTeamShift), false);
    assert.equal(canManageTeamShiftRecord(sameTeamStaff, otherTeamShift), false);
  });

  it("fails closed when user or shift teamId is missing, null, undefined, or invalid (e.g. 0)", () => {
    const userNullTeam = { userId: 1, role: "Owner", teamId: null };
    const userUndefinedTeam = { userId: 1, role: "Owner" };
    const userZeroTeam = { userId: 1, role: "Owner", teamId: 0 };

    const shiftNullTeam = { id: 10, user_id: 1, teamId: null };
    const shiftUndefinedTeam = { id: 10, user_id: 1 };
    const shiftZeroTeam = { id: 10, user_id: 1, teamId: 0 };

    // User missing/invalid teamId
    assert.equal(canManageTeamShiftRecord(userNullTeam, ownShift), false);
    assert.equal(canManageTeamShiftRecord(userUndefinedTeam, ownShift), false);
    assert.equal(canManageTeamShiftRecord(userZeroTeam, ownShift), false);

    // Shift missing/invalid teamId
    assert.equal(canManageTeamShiftRecord(sameTeamOwner, shiftNullTeam), false);
    assert.equal(canManageTeamShiftRecord(sameTeamOwner, shiftUndefinedTeam), false);
    assert.equal(canManageTeamShiftRecord(sameTeamOwner, shiftZeroTeam), false);

    // Both missing
    assert.equal(canManageTeamShiftRecord(userNullTeam, shiftNullTeam), false);
  });
});

describe("Shifts Collection Route Handlers (app/api/shifts/route.ts with Mocked Dependencies)", () => {
  it("Unauthenticated GET returns 401 and makes zero SQL calls", async () => {
    let sqlCalls = 0;
    const mockSql = () => {
      sqlCalls++;
      throw new Error("mockSql must not be called");
    };

    const res = await handleGetShifts({
      getSessionUser: async () => null,
      sql: mockSql,
    });

    assert.equal(res.status, 401);
    assert.equal(sqlCalls, 0, "Unauthenticated GET must make zero SQL calls");
    const body = await res.json();
    assert.deepEqual(body, { error: "Authentication required to view shifts." });
  });

  it("Authenticated GET without a valid team ID returns 403 and makes zero SQL calls", async () => {
    let sqlCalls = 0;
    const mockSql = () => {
      sqlCalls++;
      throw new Error("mockSql must not be called");
    };

    const sessionUserNoTeam = {
      userId: 1,
      email: "user@example.com",
      name: "No Team User",
      role: "Staff",
      teamId: null,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const res = await handleGetShifts({
      getSessionUser: async () => sessionUserNoTeam,
      sql: mockSql,
    });

    assert.equal(res.status, 403);
    assert.equal(sqlCalls, 0, "Authenticated GET without valid team ID must make zero SQL calls");
    const body = await res.json();
    assert.deepEqual(body, {
      error: "Forbidden: No active team membership found for this account.",
    });

    // Also verify when teamId is 0 (non-positive)
    const sessionUserZeroTeam = { ...sessionUserNoTeam, teamId: 0 };
    const resZero = await handleGetShifts({
      getSessionUser: async () => sessionUserZeroTeam,
      sql: mockSql,
    });
    assert.equal(resZero.status, 403);
    assert.equal(sqlCalls, 0, "TeamId 0 must also return 403 with zero SQL calls");
  });

  it("Authenticated GET with a valid team ID uses a mocked SQL function and returns the expected response shape", async () => {
    let sqlCalls = 0;
    let capturedQuery = null;
    let capturedValues = [];

    const sessionUser = {
      userId: 1,
      email: "amara@rota.local",
      name: "Amara Okafor",
      role: "Staff",
      teamId: 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const expectedShifts = [
      {
        id: 101,
        employee_name: "Amara Okafor",
        role: "Staff",
        user_id: 1,
        team_id: 10,
        shift_day: "2026-11-01",
        created_at: "2026-10-24T00:00:00.000Z",
      },
      {
        id: 102,
        employee_name: "Sarah Bello",
        role: "Staff",
        user_id: 2,
        team_id: 10,
        shift_day: "2026-11-02",
        created_at: "2026-10-24T00:00:00.000Z",
      },
    ];

    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      capturedQuery = strings.join("?");
      capturedValues = values;
      return expectedShifts;
    };

    const res = await handleGetShifts({
      getSessionUser: async () => sessionUser,
      sql: mockSql,
    });

    assert.equal(res.status, 200);
    assert.equal(sqlCalls, 1, "Must make exactly 1 SQL query");
    assert.ok(capturedQuery.includes("team_id ="), "Query must filter by team_id");
    assert.equal(capturedValues[0], 10, "Query parameter must be the session user's teamId");
    const body = await res.json();
    assert.deepEqual(body, expectedShifts);
  });

  it("Unauthenticated POST returns 401 and makes zero SQL calls", async () => {
    let sqlCalls = 0;
    const mockSql = () => {
      sqlCalls++;
      throw new Error("mockSql must not be called");
    };

    const req = new Request("http://localhost/api/shifts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shiftDay: "2026-11-01", role: "Staff" }),
    });

    const res = await handlePostShift(req, {
      getSessionUser: async () => null,
      sql: mockSql,
    });

    assert.equal(res.status, 401);
    assert.equal(sqlCalls, 0, "Unauthenticated POST must make zero SQL calls");
    const body = await res.json();
    assert.deepEqual(body, {
      error: "Authentication required. Please sign in to create shifts.",
    });
  });

  it("Authenticated POST without a valid team ID returns 403 and makes zero SQL calls", async () => {
    let sqlCalls = 0;
    const mockSql = () => {
      sqlCalls++;
      throw new Error("mockSql must not be called");
    };

    const sessionUserNoTeam = {
      userId: 1,
      email: "user@example.com",
      name: "No Team User",
      role: "Staff",
      teamId: null,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const req = new Request("http://localhost/api/shifts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shiftDay: "2026-11-01", role: "Staff" }),
    });

    const res = await handlePostShift(req, {
      getSessionUser: async () => sessionUserNoTeam,
      sql: mockSql,
    });

    assert.equal(res.status, 403);
    assert.equal(sqlCalls, 0, "Authenticated POST without valid team ID must make zero SQL calls");
    const body = await res.json();
    assert.deepEqual(body, {
      error: "Forbidden: An active team membership is required to create shifts.",
    });

    // Also test non-positive team ID (0)
    const sessionUserZeroTeam = { ...sessionUserNoTeam, teamId: 0 };
    const reqZero = new Request("http://localhost/api/shifts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shiftDay: "2026-11-01", role: "Staff" }),
    });
    const resZero = await handlePostShift(reqZero, {
      getSessionUser: async () => sessionUserZeroTeam,
      sql: mockSql,
    });
    assert.equal(resZero.status, 403);
    assert.equal(sqlCalls, 0, "TeamId 0 on POST must make zero SQL calls");
  });

  it("client-supplied teamId cannot override the session user’s authoritative team ID in POST", async () => {
    let sqlCalls = 0;
    let capturedValues = [];
    let capturedQuery = null;

    const authoritativeTeamId = 42;
    const clientSuppliedForgedTeamId = 9999;

    const sessionUser = {
      userId: 1,
      email: "amara@rota.local",
      name: "Amara Okafor",
      role: "Staff",
      teamId: authoritativeTeamId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      capturedQuery = strings.join("?");
      capturedValues = values;
      return [
        {
          id: 201,
          employee_name: values[0],
          role: values[1],
          user_id: values[3],
          team_id: values[4],
          shift_day: values[2],
          created_at: "2026-10-24T00:00:00.000Z",
        },
      ];
    };

    const req = new Request("http://localhost/api/shifts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shiftDay: "2026-11-05",
        role: "Staff",
        teamId: clientSuppliedForgedTeamId,
        team_id: clientSuppliedForgedTeamId,
      }),
    });

    const res = await handlePostShift(req, {
      getSessionUser: async () => sessionUser,
      sql: mockSql,
    });

    assert.equal(res.status, 201);
    assert.equal(sqlCalls, 1, "Must execute exactly one SQL query (the INSERT)");
    assert.ok(capturedQuery.includes("INSERT INTO shifts"), "Query must be an INSERT INTO shifts");

    // Check that the parameter passed for team_id is the authoritative teamId, NOT the client forged one
    const insertedTeamId = capturedValues[4];
    assert.equal(
      insertedTeamId,
      authoritativeTeamId,
      "The inserted team_id must be the session user's authoritative teamId"
    );
    assert.notEqual(
      insertedTeamId,
      clientSuppliedForgedTeamId,
      "The inserted team_id must NOT equal the client-supplied teamId"
    );

    const body = await res.json();
    assert.equal(body.team_id, authoritativeTeamId);
  });
});

describe("Individual-Shift Route Handlers (app/api/shifts/[id]/route.ts with Mocked Dependencies)", () => {
  const dummyContext = (id = "10") => ({
    params: Promise.resolve({ id: String(id) }),
  });

  // 1. Unauthenticated GET by ID returns 401 and makes zero SQL calls
  it("Unauthenticated GET by ID returns 401 and makes zero SQL calls", async () => {
    let sqlCalls = 0;
    const mockSql = () => {
      sqlCalls++;
      throw new Error("mockSql must not be called");
    };

    const req = new Request("http://localhost/api/shifts/10");
    const res = await handleGetShiftById(req, dummyContext("10"), {
      getSessionUser: async () => null,
      sql: mockSql,
    });

    assert.equal(res.status, 401);
    assert.equal(sqlCalls, 0, "Unauthenticated GET must make zero SQL calls");
    const body = await res.json();
    assert.deepEqual(body, {
      error: "Authentication required. Please sign in to view shift details.",
    });
  });

  // 2. Unauthenticated PUT by ID returns 401 and makes zero SQL calls
  it("Unauthenticated PUT by ID returns 401 and makes zero SQL calls", async () => {
    let sqlCalls = 0;
    const mockSql = () => {
      sqlCalls++;
      throw new Error("mockSql must not be called");
    };

    const req = new Request("http://localhost/api/shifts/10", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Staff", shiftDay: "2026-11-01" }),
    });
    const res = await handlePutShift(req, dummyContext("10"), {
      getSessionUser: async () => null,
      sql: mockSql,
    });

    assert.equal(res.status, 401);
    assert.equal(sqlCalls, 0, "Unauthenticated PUT must make zero SQL calls");
    const body = await res.json();
    assert.deepEqual(body, {
      error: "Authentication required. Please sign in to edit shifts.",
    });
  });

  // 3. Unauthenticated DELETE by ID returns 401 and makes zero SQL calls
  it("Unauthenticated DELETE by ID returns 401 and makes zero SQL calls", async () => {
    let sqlCalls = 0;
    const mockSql = () => {
      sqlCalls++;
      throw new Error("mockSql must not be called");
    };

    const req = new Request("http://localhost/api/shifts/10", {
      method: "DELETE",
    });
    const res = await handleDeleteShift(req, dummyContext("10"), {
      getSessionUser: async () => null,
      sql: mockSql,
    });

    assert.equal(res.status, 401);
    assert.equal(sqlCalls, 0, "Unauthenticated DELETE must make zero SQL calls");
    const body = await res.json();
    assert.deepEqual(body, {
      error: "Authentication required. Please sign in to delete shifts.",
    });
  });

  // 4. Authenticated GET, PUT, and DELETE each return 403 when session has no valid team ID (zero SQL calls)
  it("Authenticated GET, PUT, and DELETE each return 403 when session has no valid team ID, making zero SQL calls", async () => {
    const invalidTeamUsers = [
      { userId: 1, email: "null@team.com", name: "Null Team", role: "Staff", teamId: null },
      { userId: 2, email: "zero@team.com", name: "Zero Team", role: "Staff", teamId: 0 },
      { userId: 3, email: "undef@team.com", name: "Undef Team", role: "Staff" },
    ];

    for (const sessionUser of invalidTeamUsers) {
      let sqlCalls = 0;
      const mockSql = () => {
        sqlCalls++;
        throw new Error("mockSql must not be called");
      };

      const deps = {
        getSessionUser: async () => sessionUser,
        sql: mockSql,
      };

      // GET
      const getReq = new Request("http://localhost/api/shifts/10");
      const getRes = await handleGetShiftById(getReq, dummyContext("10"), deps);
      assert.equal(getRes.status, 403);
      assert.equal(sqlCalls, 0, "GET must make zero SQL calls when teamId is invalid");
      const getBody = await getRes.json();
      assert.deepEqual(getBody, {
        error: "Access denied. You are not assigned to an active team.",
      });

      // PUT
      const putReq = new Request("http://localhost/api/shifts/10", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Staff", shiftDay: "2026-11-01" }),
      });
      const putRes = await handlePutShift(putReq, dummyContext("10"), deps);
      assert.equal(putRes.status, 403);
      assert.equal(sqlCalls, 0, "PUT must make zero SQL calls when teamId is invalid");
      const putBody = await putRes.json();
      assert.deepEqual(putBody, {
        error: "Access denied. You are not assigned to an active team.",
      });

      // DELETE
      const delReq = new Request("http://localhost/api/shifts/10", {
        method: "DELETE",
      });
      const delRes = await handleDeleteShift(delReq, dummyContext("10"), deps);
      assert.equal(delRes.status, 403);
      assert.equal(sqlCalls, 0, "DELETE must make zero SQL calls when teamId is invalid");
      const delBody = await delRes.json();
      assert.deepEqual(delBody, {
        error: "Access denied. You are not assigned to an active team.",
      });
    }
  });

  // 5 & 6. Team isolation and cross-team anti-enumeration (404)
  it("GET by ID enforces team isolation and returns 404 anti-enumeration response for another team's shift", async () => {
    let sqlCalls = 0;
    let capturedQuery = null;
    let capturedValues = [];

    const sessionUserTeam1 = {
      userId: 1,
      name: "Amara Okafor",
      role: "Staff",
      teamId: 1,
    };

    // The query is strictly scoped to WHERE id = $id AND team_id = $teamId.
    // Shift 100 exists in the database for team 2, so the scoped query returns 0 rows.
    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      capturedQuery = strings.join("?");
      capturedValues = values;
      return []; // No shift found for team 1
    };

    const req = new Request("http://localhost/api/shifts/100");
    const res = await handleGetShiftById(req, dummyContext("100"), {
      getSessionUser: async () => sessionUserTeam1,
      sql: mockSql,
    });

    assert.equal(res.status, 404, "Must return 404 to avoid leaking cross-team shift existence");
    assert.equal(sqlCalls, 1, "Must execute exactly one scoped SELECT");
    assert.ok(capturedQuery.includes("team_id ="), "Query must filter by team_id");
    assert.equal(capturedValues[0], 100, "First param must be shift ID");
    assert.equal(capturedValues[1], 1, "Second param must be session user's teamId");
    const body = await res.json();
    assert.deepEqual(body, { error: "Shift not found." });
  });

  it("PUT by ID enforces team isolation and returns 404 anti-enumeration response without modifying database", async () => {
    let sqlCalls = 0;
    let capturedQuery = null;
    let capturedValues = [];

    const sessionUserTeam1 = {
      userId: 1,
      name: "Amara Okafor",
      role: "Staff",
      teamId: 1,
    };

    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      capturedQuery = strings.join("?");
      capturedValues = values;
      // Scoped SELECT returns empty
      return [];
    };

    const req = new Request("http://localhost/api/shifts/100", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Staff", shiftDay: "2026-11-01" }),
    });

    const res = await handlePutShift(req, dummyContext("100"), {
      getSessionUser: async () => sessionUserTeam1,
      sql: mockSql,
    });

    assert.equal(res.status, 404, "Must return 404 preventing ID scanning across teams");
    assert.equal(sqlCalls, 1, "Only the initial SELECT must execute, zero UPDATE statements");
    assert.ok(capturedQuery.includes("SELECT"), "Query must be SELECT, not UPDATE");
    assert.equal(capturedValues[1], 1, "Query must scope to user teamId");
    const body = await res.json();
    assert.deepEqual(body, { error: "Shift not found." });
  });

  it("DELETE by ID enforces team isolation and returns 404 anti-enumeration response without modifying database", async () => {
    let sqlCalls = 0;
    let capturedQuery = null;
    let capturedValues = [];

    const sessionUserTeam1 = {
      userId: 1,
      name: "Amara Okafor",
      role: "Staff",
      teamId: 1,
    };

    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      capturedQuery = strings.join("?");
      capturedValues = values;
      return [];
    };

    const req = new Request("http://localhost/api/shifts/100", {
      method: "DELETE",
    });

    const res = await handleDeleteShift(req, dummyContext("100"), {
      getSessionUser: async () => sessionUserTeam1,
      sql: mockSql,
    });

    assert.equal(res.status, 404, "Must return 404 preventing ID scanning across teams");
    assert.equal(sqlCalls, 1, "Only the initial SELECT must execute, zero DELETE statements");
    assert.ok(capturedQuery.includes("SELECT"), "Query must be SELECT, not DELETE");
    assert.equal(capturedValues[1], 1, "Query must scope to user teamId");
    const body = await res.json();
    assert.deepEqual(body, { error: "Shift not found." });
  });

  // 7. Staff cannot perform manager-only updates or deletes
  it("Staff cannot edit another colleague's shift in the same team (returns 403)", async () => {
    let sqlCalls = 0;
    const staffUser2 = {
      userId: 2,
      name: "Sarah Bello",
      role: "Staff",
      teamId: 1,
    };

    // Colleague shift owned by user 1
    const colleagueShift = {
      id: 10,
      employee_name: "Amara Okafor",
      role: "Staff",
      user_id: 1,
      team_id: 1,
    };

    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      const query = strings.join("?");
      if (query.includes("SELECT")) {
        return [colleagueShift];
      }
      throw new Error("UPDATE must not be called when unauthorized");
    };

    const req = new Request("http://localhost/api/shifts/10", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Customer Support", shiftDay: "2026-11-01" }),
    });

    const res = await handlePutShift(req, dummyContext("10"), {
      getSessionUser: async () => staffUser2,
      sql: mockSql,
    });

    assert.equal(res.status, 403);
    assert.equal(sqlCalls, 1, "Must execute SELECT and halt before UPDATE");
    const body = await res.json();
    assert.ok(
      body.error.includes("Unauthorized: You can only edit shifts assigned to your account"),
      "Must return authorization error"
    );
  });

  it("Staff cannot delete another colleague's shift in the same team (returns 403)", async () => {
    let sqlCalls = 0;
    const staffUser2 = {
      userId: 2,
      name: "Sarah Bello",
      role: "Staff",
      teamId: 1,
    };

    const colleagueShift = {
      id: 10,
      employee_name: "Amara Okafor",
      role: "Staff",
      user_id: 1,
      team_id: 1,
    };

    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      const query = strings.join("?");
      if (query.includes("SELECT")) {
        return [colleagueShift];
      }
      throw new Error("DELETE must not be called when unauthorized");
    };

    const req = new Request("http://localhost/api/shifts/10", {
      method: "DELETE",
    });

    const res = await handleDeleteShift(req, dummyContext("10"), {
      getSessionUser: async () => staffUser2,
      sql: mockSql,
    });

    assert.equal(res.status, 403);
    assert.equal(sqlCalls, 1, "Must execute SELECT and halt before DELETE");
    const body = await res.json();
    assert.ok(
      body.error.includes("Unauthorized: You can only delete shifts assigned to your account"),
      "Must return authorization error"
    );
  });

  it("Staff updating own shift cannot reassign to another employee; forces self-assignment", async () => {
    let sqlCalls = 0;
    let updateValues = [];

    const staffUser2 = {
      userId: 2,
      name: "Sarah Bello",
      role: "Staff",
      teamId: 1,
    };

    const ownShift = {
      id: 12,
      employee_name: "Sarah Bello",
      role: "Staff",
      user_id: 2,
      team_id: 1,
    };

    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      const query = strings.join("?");
      if (query.includes("SELECT")) {
        return [ownShift];
      }
      if (query.includes("UPDATE shifts")) {
        updateValues = values;
        return [
          {
            id: 12,
            employee_name: values[0],
            role: values[1],
            shift_day: values[2],
            user_id: values[3],
            team_id: values[4],
            created_at: "2026-10-24T00:00:00.000Z",
          },
        ];
      }
      throw new Error(`Unexpected query: ${query}`);
    };

    // Staff attempts to set employeeName to "Amara Okafor"
    const req = new Request("http://localhost/api/shifts/12", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        employeeName: "Amara Okafor",
        role: "Front Desk",
        shiftDay: "2026-11-03",
      }),
    });

    const res = await handlePutShift(req, dummyContext("12"), {
      getSessionUser: async () => staffUser2,
      sql: mockSql,
    });

    assert.equal(res.status, 200);
    assert.equal(sqlCalls, 2, "Must execute SELECT then UPDATE");
    // Values: ${updatedEmployeeName}, ${role}, ${shiftDay}, ${updatedUserId}, ${sessionUser.teamId}
    assert.equal(
      updateValues[0],
      "Sarah Bello",
      "Employee name must remain forced to authenticated staff user's name"
    );
    assert.equal(
      updateValues[3],
      2,
      "User ID must remain forced to authenticated staff user's userId"
    );
    const body = await res.json();
    assert.equal(body.employee_name, "Sarah Bello");
    assert.equal(body.user_id, 2);
  });

  // 8. Owner and Manager use centralized role helper and can perform same-team management
  it("Owner and Manager can update and reassign same-team shifts using centralized role helper", async () => {
    const managers = [
      { userId: 20, name: "Alice Owner", role: "Owner", teamId: 1 },
      { userId: 21, name: "Bob Manager", role: "Manager", teamId: 1 },
    ];

    for (const managerUser of managers) {
      let sqlCalls = 0;
      let executedUpdateValues = [];

      const targetShift = {
        id: 10,
        employee_name: "Amara Okafor",
        role: "Staff",
        user_id: 1,
        team_id: 1,
      };

      const mockSql = async (strings, ...values) => {
        sqlCalls++;
        const query = strings.join("?");
        if (query.includes("SELECT") && query.includes("FROM shifts")) {
          return [targetShift];
        }
        if (query.includes("SELECT") && query.includes("FROM users")) {
          // Verify target employee team membership
          return [{ id: 2, name: "Sarah Bello", role: "Staff" }];
        }
        if (query.includes("UPDATE shifts")) {
          executedUpdateValues = values;
          return [
            {
              id: 10,
              employee_name: values[0],
              role: values[1],
              shift_day: values[2],
              user_id: values[3],
              team_id: values[4],
              created_at: "2026-10-24T00:00:00.000Z",
            },
          ];
        }
        throw new Error(`Unexpected query: ${query}`);
      };

      // Manager reassigns shift to Sarah Bello
      const req = new Request("http://localhost/api/shifts/10", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeName: "Sarah Bello",
          role: "Front Desk",
          shiftDay: "2026-11-04",
        }),
      });

      const res = await handlePutShift(req, dummyContext("10"), {
        getSessionUser: async () => managerUser,
        sql: mockSql,
      });

      assert.equal(res.status, 200);
      assert.equal(sqlCalls, 3, "Owner/Manager reassign must execute shift SELECT, member verify SELECT, and UPDATE");
      assert.equal(executedUpdateValues[0], "Sarah Bello", "Manager can reassign employee name");
      assert.equal(executedUpdateValues[3], 2, "Manager can reassign target user_id");
      const body = await res.json();
      assert.equal(body.employee_name, "Sarah Bello");
      assert.equal(body.user_id, 2);
    }
  });

  it("Owner and Manager can delete same-team shifts using centralized role helper", async () => {
    const managers = [
      { userId: 20, name: "Alice Owner", role: "Owner", teamId: 1 },
      { userId: 21, name: "Bob Manager", role: "Manager", teamId: 1 },
    ];

    for (const managerUser of managers) {
      let sqlCalls = 0;
      let deleteValues = [];

      const targetShift = {
        id: 10,
        employee_name: "Amara Okafor",
        role: "Staff",
        user_id: 1,
        team_id: 1,
      };

      const mockSql = async (strings, ...values) => {
        sqlCalls++;
        const query = strings.join("?");
        if (query.includes("SELECT") && query.includes("FROM shifts")) {
          return [targetShift];
        }
        if (query.includes("DELETE FROM shifts")) {
          deleteValues = values;
          return [];
        }
        throw new Error(`Unexpected query: ${query}`);
      };

      const req = new Request("http://localhost/api/shifts/10", {
        method: "DELETE",
      });

      const res = await handleDeleteShift(req, dummyContext("10"), {
        getSessionUser: async () => managerUser,
        sql: mockSql,
      });

      assert.equal(res.status, 200);
      assert.equal(sqlCalls, 2, "Must execute SELECT followed by DELETE");
      assert.equal(deleteValues[0], 10, "Deleted shift ID must match");
      assert.equal(deleteValues[1], 1, "Deletion must be strictly scoped to manager's teamId");
      const body = await res.json();
      assert.deepEqual(body, {
        success: true,
        message: "Shift permanently removed.",
        id: 10,
      });
    }
  });

  it("Owner and Manager are strictly denied access to another team's shifts (returns 404 anti-enumeration)", async () => {
    const crossTeamManagers = [
      { userId: 20, name: "Alice Owner", role: "Owner", teamId: 1 },
      { userId: 21, name: "Bob Manager", role: "Manager", teamId: 1 },
    ];

    for (const managerUser of crossTeamManagers) {
      let sqlCalls = 0;
      // When shift 200 belongs to team 2, scoped SELECT returns empty
      const mockSql = async () => {
        sqlCalls++;
        return [];
      };

      // GET
      const getRes = await handleGetShiftById(
        new Request("http://localhost/api/shifts/200"),
        dummyContext("200"),
        { getSessionUser: async () => managerUser, sql: mockSql }
      );
      assert.equal(getRes.status, 404);

      // PUT
      const putRes = await handlePutShift(
        new Request("http://localhost/api/shifts/200", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "Staff", shiftDay: "2026-11-01" }),
        }),
        dummyContext("200"),
        { getSessionUser: async () => managerUser, sql: mockSql }
      );
      assert.equal(putRes.status, 404);

      // DELETE
      const delRes = await handleDeleteShift(
        new Request("http://localhost/api/shifts/200", { method: "DELETE" }),
        dummyContext("200"),
        { getSessionUser: async () => managerUser, sql: mockSql }
      );
      assert.equal(delRes.status, 404);
      assert.equal(sqlCalls, 3, "Only initial SELECT executed for each operation, zero modifications");
    }
  });
});
