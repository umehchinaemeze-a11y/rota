import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTargetTeamId,
  validateShiftIds,
  getRecoverableShiftsForUser,
  verifyWorkspaceMembership,
  verifyShiftOwnershipAndEligibility,
  recoverLegacyShifts,
  countUnassignedOrphanShifts,
  ShiftRecoveryError,
} from "../lib/shift-recovery.ts";

import {
  handleGetRecoverableShifts,
  handlePostRecoverShifts,
} from "../app/api/shifts/recover/route.ts";
import { resolveShiftRecoveryResponse } from "../lib/shifts-client.ts";
import { handleGetTeams } from "../app/api/teams/route.ts";

/**
 * Creates an in-memory database mock supporting the recovery SQL queries.
 */
function createMockDb({ users = [], memberships = [], shifts = [] } = {}) {
  const state = {
    users: users.map((u) => ({ ...u })),
    memberships: memberships.map((m) => ({ ...m })),
    shifts: shifts.map((s) => ({ ...s })),
    queryLog: [],
  };

  const sql = async (strings, ...values) => {
    const query = strings.join("?");
    state.queryLog.push({ query, values });

    // 1. Team memberships check: WHERE user_id = ${userId} AND team_id = ${teamId}
    if (query.includes("FROM team_memberships") && query.includes("WHERE user_id =")) {
      const [userId, teamId] = values;
      const found = state.memberships.find(
        (m) => m.user_id === userId && m.team_id === teamId
      );
      return found ? [found] : [];
    }

    // 2. Count unassigned orphan shifts
    if (query.includes("COUNT(*)::int AS count") && query.includes("FROM shifts")) {
      const count = state.shifts.filter(
        (s) => (s.user_id === null || s.user_id === undefined) && (s.team_id === null || s.team_id === undefined)
      ).length;
      return [{ count }];
    }

    // 3. Shifts ownership/eligibility pre-check: WHERE id = ANY(${shiftIds})
    if (query.includes("FROM shifts") && query.includes("WHERE id = ANY(")) {
      const [shiftIds] = values;
      const idSet = new Set(Array.isArray(shiftIds) ? shiftIds : [shiftIds]);
      return state.shifts.filter((s) => idSet.has(s.id));
    }

    // 4. Recoverable shifts query: WHERE user_id = ${userId} AND team_id IS NULL
    if (query.includes("FROM shifts") && query.includes("WHERE user_id =") && query.includes("team_id IS NULL") && !query.includes("UPDATE")) {
      const [userId] = values;
      return state.shifts
        .filter((s) => s.user_id === userId && (s.team_id === null || s.team_id === undefined))
        .map((s) => ({
          ...s,
          shift_day: typeof s.shift_day === "string" ? s.shift_day.slice(0, 10) : s.shift_day,
        }));
    }

    // 5. CTE Atomic Update with row-level locking (FOR UPDATE)
    if (query.includes("UPDATE shifts s") && query.includes("SET team_id =")) {
      // Pattern:
      // With shiftIds: [userId, shiftIds, targetTeamId, userId]
      // Without shiftIds: [userId, targetTeamId, userId]
      let userId, targetTeamId, shiftIdsFilter;
      if (values.length === 4) {
        userId = values[0];
        shiftIdsFilter = new Set(Array.isArray(values[1]) ? values[1] : [values[1]]);
        targetTeamId = values[2];
      } else {
        userId = values[0];
        targetTeamId = values[1];
        shiftIdsFilter = null;
      }

      const updated = [];
      for (const shift of state.shifts) {
        const matchesUser = shift.user_id === userId;
        const matchesTeamNull = shift.team_id === null || shift.team_id === undefined;
        const matchesId = shiftIdsFilter ? shiftIdsFilter.has(shift.id) : true;

        if (matchesUser && matchesTeamNull && matchesId) {
          shift.team_id = targetTeamId;
          updated.push({
            id: shift.id,
            employee_name: shift.employee_name,
            role: shift.role,
            user_id: shift.user_id,
            team_id: shift.team_id,
            shift_day: typeof shift.shift_day === "string" ? shift.shift_day.slice(0, 10) : shift.shift_day,
            created_at: shift.created_at,
          });
        }
      }
      return updated;
    }

    return [];
  };

  return { state, sql };
}

describe("Shift Recovery — Helper Functions & Parameter Validation", () => {
  it("normalizeTargetTeamId handles valid numbers and numeric strings", () => {
    assert.equal(normalizeTargetTeamId(1), 1);
    assert.equal(normalizeTargetTeamId(42), 42);
    assert.equal(normalizeTargetTeamId("10"), 10);
    assert.equal(normalizeTargetTeamId("  99  "), 99);
  });

  it("normalizeTargetTeamId rejects invalid values", () => {
    assert.equal(normalizeTargetTeamId(0), null);
    assert.equal(normalizeTargetTeamId(-5), null);
    assert.equal(normalizeTargetTeamId(3.14), null);
    assert.equal(normalizeTargetTeamId(""), null);
    assert.equal(normalizeTargetTeamId("abc"), null);
    assert.equal(normalizeTargetTeamId(null), null);
    assert.equal(normalizeTargetTeamId(undefined), null);
    assert.equal(normalizeTargetTeamId({}), null);
  });

  it("validateShiftIds handles undefined, empty, and valid positive integer arrays", () => {
    assert.deepEqual(validateShiftIds(undefined), { valid: true, ids: undefined });
    assert.deepEqual(validateShiftIds(null), { valid: true, ids: undefined });
    assert.deepEqual(validateShiftIds([]), { valid: true, ids: [] });
    assert.deepEqual(validateShiftIds([1, 2, 3]), { valid: true, ids: [1, 2, 3] });
    assert.deepEqual(validateShiftIds(["4", 5, "6"]), { valid: true, ids: [4, 5, 6] });
  });

  it("validateShiftIds rejects non-arrays or arrays with invalid IDs", () => {
    const notArray = validateShiftIds("1,2,3");
    assert.equal(notArray.valid, false);
    assert.match(notArray.error, /must be an array/);

    const negativeId = validateShiftIds([1, -2, 3]);
    assert.equal(negativeId.valid, false);
    assert.match(negativeId.error, /positive integers/);

    const stringId = validateShiftIds([1, "bad", 3]);
    assert.equal(stringId.valid, false);
    assert.match(stringId.error, /positive integers/);
  });
});

describe("Shift Recovery API — Authentication & Authorization Gatekeeping", () => {
  it("rejects unauthenticated GET requests with HTTP 401", async () => {
    const req = new Request("http://localhost/api/shifts/recover", { method: "GET" });
    const res = await handleGetRecoverableShifts(req, {
      getSessionUser: async () => null,
      sql: async () => [],
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Authentication required/);
  });

  it("rejects unauthenticated POST requests with HTTP 401", async () => {
    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 10 }),
    });
    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => null,
      sql: async () => [],
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Authentication required/);
  });

  it("rejects POST recovery when caller has no workspace and targetTeamId is omitted", async () => {
    const userWithoutTeam = {
      userId: 5,
      email: "user@rota.local",
      name: "No Team User",
      role: "Staff",
      teamId: null,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => userWithoutTeam,
      sql: async () => [],
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Target workspace ID is required/);
  });

  it("rejects POST recovery when user is not an authorized member of target workspace (HTTP 403)", async () => {
    const user = {
      userId: 5,
      email: "user@rota.local",
      name: "Team Member",
      role: "Staff",
      teamId: 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const { sql } = createMockDb({
      memberships: [
        { id: 1, user_id: 5, team_id: 10, role: "Staff" }, // Member of team 10, NOT 99
      ],
      shifts: [
        { id: 1, employee_name: "Team Member", role: "Staff", user_id: 5, team_id: null, shift_day: "2026-11-01" },
      ],
    });

    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 99 }), // Unauthorized workspace
    });

    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => user,
      sql,
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /not an authorized member/);
  });
});

describe("Shift Recovery API — Privacy & Read Isolation (GET)", () => {
  it("returns only legacy shifts strictly belonging to the authenticated user", async () => {
    const userA = {
      userId: 10,
      email: "amara@rota.local",
      name: "Amara Okafor",
      role: "Front Desk",
      teamId: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const { sql } = createMockDb({
      shifts: [
        // User A's legacy shifts (claimable)
        { id: 101, employee_name: "Amara Okafor", role: "Front Desk", user_id: 10, team_id: null, shift_day: "2026-11-01", created_at: "2026-10-01T08:00:00Z" },
        { id: 102, employee_name: "Amara Okafor", role: "Front Desk", user_id: 10, team_id: null, shift_day: "2026-11-02", created_at: "2026-10-01T08:00:00Z" },
        // User A's already-assigned shift (not claimable)
        { id: 103, employee_name: "Amara Okafor", role: "Front Desk", user_id: 10, team_id: 1, shift_day: "2026-11-03", created_at: "2026-10-01T08:00:00Z" },
        // User B's legacy shift (never expose!)
        { id: 201, employee_name: "Chika Nwosu", role: "Supervisor", user_id: 20, team_id: null, shift_day: "2026-11-01", created_at: "2026-10-01T08:00:00Z" },
        // Orphan legacy shift with user_id = null (never expose!)
        { id: 301, employee_name: "Amara Okafor", role: "Front Desk", user_id: null, team_id: null, shift_day: "2026-11-04", created_at: "2026-10-01T08:00:00Z" },
      ],
    });

    const req = new Request("http://localhost/api/shifts/recover", { method: "GET" });
    const res = await handleGetRecoverableShifts(req, {
      getSessionUser: async () => userA,
      sql,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.recoverableCount, 2);
    assert.equal(body.shifts.length, 2);

    // Verify exactly shifts 101 and 102 returned
    const returnedIds = body.shifts.map((s) => s.id);
    assert.deepEqual(returnedIds, [101, 102]);

    // Verify all returned shifts belong to User A and have team_id null
    for (const shift of body.shifts) {
      assert.equal(shift.user_id, 10);
      assert.equal(shift.team_id, null);
    }
  });

  it("returns an empty list when all user shifts are already assigned", async () => {
    const userA = {
      userId: 10,
      email: "amara@rota.local",
      name: "Amara Okafor",
      role: "Front Desk",
      teamId: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const { sql } = createMockDb({
      shifts: [
        { id: 101, employee_name: "Amara Okafor", role: "Front Desk", user_id: 10, team_id: 1, shift_day: "2026-11-01" },
      ],
    });

    const req = new Request("http://localhost/api/shifts/recover", { method: "GET" });
    const res = await handleGetRecoverableShifts(req, {
      getSessionUser: async () => userA,
      sql,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.recoverableCount, 0);
    assert.deepEqual(body.shifts, []);
  });
});

describe("Shift Recovery API — Cross-User Denial & Anti-Claiming Guards (POST)", () => {
  it("rejects attempt to claim shifts belonging to another user with HTTP 403", async () => {
    const userA = {
      userId: 10,
      email: "user_a@rota.local",
      name: "User Alpha",
      role: "Staff",
      teamId: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const { sql } = createMockDb({
      memberships: [{ id: 1, user_id: 10, team_id: 1, role: "Staff" }],
      shifts: [
        { id: 200, employee_name: "User Bravo", role: "Staff", user_id: 20, team_id: null, shift_day: "2026-11-01" },
      ],
    });

    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 1, shiftIds: [200] }),
    });

    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => userA,
      sql,
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /belongs to another account/);
  });

  it("rejects attempt to claim unassigned orphan shift (user_id IS NULL) even if name matches (HTTP 403)", async () => {
    const userA = {
      userId: 10,
      email: "user_a@rota.local",
      name: "Same Name",
      role: "Staff",
      teamId: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const { sql } = createMockDb({
      memberships: [{ id: 1, user_id: 10, team_id: 1, role: "Staff" }],
      shifts: [
        // Name matches user, but user_id is NULL (unverified legacy shift)
        { id: 300, employee_name: "Same Name", role: "Staff", user_id: null, team_id: null, shift_day: "2026-11-01" },
      ],
    });

    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 1, shiftIds: [300] }),
    });

    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => userA,
      sql,
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /no registered owner/);
  });

  it("rejects attempt to claim non-existent shift ID with HTTP 404", async () => {
    const userA = {
      userId: 10,
      email: "user_a@rota.local",
      name: "User Alpha",
      role: "Staff",
      teamId: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const { sql } = createMockDb({
      memberships: [{ id: 1, user_id: 10, team_id: 1, role: "Staff" }],
      shifts: [],
    });

    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 1, shiftIds: [9999] }),
    });

    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => userA,
      sql,
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /not found/);
  });

  it("rejects attempt to claim shift that is already assigned to a team with HTTP 409 Conflict", async () => {
    const userA = {
      userId: 10,
      email: "user_a@rota.local",
      name: "User Alpha",
      role: "Staff",
      teamId: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const { sql } = createMockDb({
      memberships: [{ id: 1, user_id: 10, team_id: 1, role: "Staff" }],
      shifts: [
        { id: 105, employee_name: "User Alpha", role: "Staff", user_id: 10, team_id: 2, shift_day: "2026-11-01" },
      ],
    });

    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 1, shiftIds: [105] }),
    });

    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => userA,
      sql,
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /already assigned/);
  });

  it("rejects malformed JSON body with HTTP 400", async () => {
    const user = { userId: 10, email: "u@rota.local", name: "U", role: "Staff", teamId: 1, exp: 9999999999 };
    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json-content",
    });

    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => user,
      sql: async () => [],
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Invalid JSON/);
  });
});

describe("Shift Recovery API — Shift Data Preservation", () => {
  it("preserves shift IDs, dates, roles, employee names, and created_at fields exactly", async () => {
    const user = {
      userId: 42,
      email: "dev@rota.local",
      name: "Daniel James",
      role: "Operations",
      teamId: 5,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const originalShifts = [
      {
        id: 701,
        employee_name: "Daniel James",
        role: "Operations Specialist",
        user_id: 42,
        team_id: null,
        shift_day: "2026-12-15",
        created_at: "2026-09-01T10:30:00.000Z",
      },
      {
        id: 702,
        employee_name: "Daniel James",
        role: "On-Call Lead",
        user_id: 42,
        team_id: null,
        shift_day: "2026-12-16",
        created_at: "2026-09-02T11:00:00.000Z",
      },
    ];

    const { state, sql } = createMockDb({
      memberships: [{ id: 1, user_id: 42, team_id: 5, role: "Operations" }],
      shifts: originalShifts,
    });

    const req = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 5 }),
    });

    const res = await handlePostRecoverShifts(req, {
      getSessionUser: async () => user,
      sql,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.recoveredCount, 2);

    // Verify in-memory state after recovery:
    // Every single field except team_id must be completely identical!
    for (const original of originalShifts) {
      const recovered = state.shifts.find((s) => s.id === original.id);
      assert.ok(recovered, `Shift ${original.id} must exist in state`);
      assert.equal(recovered.id, original.id);
      assert.equal(recovered.employee_name, original.employee_name);
      assert.equal(recovered.role, original.role);
      assert.equal(recovered.user_id, original.user_id);
      assert.equal(recovered.shift_day, original.shift_day);
      assert.equal(recovered.created_at, original.created_at);
      // Only team_id is changed
      assert.equal(recovered.team_id, 5);
    }
  });
});

describe("Shift Recovery API — Repeat Requests & Idempotency", () => {
  it("subsequent identical recovery requests gracefully return recoveredCount: 0 without error", async () => {
    const user = {
      userId: 7,
      email: "ada@rota.local",
      name: "Ada Lovelace",
      role: "Engineer",
      teamId: 12,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const { sql } = createMockDb({
      memberships: [{ id: 1, user_id: 7, team_id: 12, role: "Engineer" }],
      shifts: [
        { id: 801, employee_name: "Ada Lovelace", role: "Engineer", user_id: 7, team_id: null, shift_day: "2026-11-20" },
      ],
    });

    // 1. First execution: recovers 1 shift
    const req1 = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 12 }),
    });

    const res1 = await handlePostRecoverShifts(req1, {
      getSessionUser: async () => user,
      sql,
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.success, true);
    assert.equal(body1.recoveredCount, 1);
    assert.equal(body1.shifts.length, 1);

    // 2. Second execution (repeat request): returns 0 recovered cleanly
    const req2 = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 12 }),
    });

    const res2 = await handlePostRecoverShifts(req2, {
      getSessionUser: async () => user,
      sql,
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.success, true);
    assert.equal(body2.recoveredCount, 0);
    assert.deepEqual(body2.shifts, []);
    assert.match(body2.message, /No legacy shifts pending recovery/);
  });
});

describe("Shift Recovery API — Concurrency Protection Simulation", () => {
  it("two concurrent recovery claims cleanly resolve without double-assignment", async () => {
    const user = {
      userId: 88,
      email: "concurrency@rota.local",
      name: "Concurrent Worker",
      role: "Staff",
      teamId: 20,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    // Shared mock database with 3 legacy shifts
    const { state, sql } = createMockDb({
      memberships: [{ id: 1, user_id: 88, team_id: 20, role: "Staff" }],
      shifts: [
        { id: 901, employee_name: "Concurrent Worker", role: "Staff", user_id: 88, team_id: null, shift_day: "2026-11-21" },
        { id: 902, employee_name: "Concurrent Worker", role: "Staff", user_id: 88, team_id: null, shift_day: "2026-11-22" },
        { id: 903, employee_name: "Concurrent Worker", role: "Staff", user_id: 88, team_id: null, shift_day: "2026-11-23" },
      ],
    });

    // Simulate two concurrent requests arriving in parallel
    const promise1 = recoverLegacyShifts({
      userId: 88,
      targetTeamId: 20,
      sql,
    });

    const promise2 = recoverLegacyShifts({
      userId: 88,
      targetTeamId: 20,
      sql,
    });

    const [result1, result2] = await Promise.all([promise1, promise2]);

    assert.equal(result1.success, true);
    assert.equal(result2.success, true);

    // Sum of recovered shifts between both concurrent workers must equal exactly 3
    const totalRecovered = result1.recoveredCount + result2.recoveredCount;
    assert.equal(totalRecovered, 3, "Total recovered shifts across concurrent requests must equal 3 exactly");

    // All 3 shifts in database state must now have team_id = 20
    for (const shift of state.shifts) {
      assert.equal(shift.team_id, 20);
    }
  });
});

describe("Shift Recovery — Orphan Shifts & Administrator Audit Helper", () => {
  it("preserves unassigned orphan shifts (user_id IS NULL) and counts them accurately", async () => {
    const { state, sql } = createMockDb({
      shifts: [
        { id: 1, employee_name: "Known User", role: "Staff", user_id: 5, team_id: null, shift_day: "2026-11-01" },
        { id: 2, employee_name: "Orphan Shift A", role: "Staff", user_id: null, team_id: null, shift_day: "2026-11-02" },
        { id: 3, employee_name: "Orphan Shift B", role: "Front Desk", user_id: null, team_id: null, shift_day: "2026-11-03" },
        { id: 4, employee_name: "Assigned Shift", role: "Staff", user_id: null, team_id: 10, shift_day: "2026-11-04" },
      ],
    });

    const orphanCount = await countUnassignedOrphanShifts(sql);
    assert.equal(orphanCount, 2, "Only shifts with both user_id IS NULL and team_id IS NULL are counted as orphan legacy shifts");

    // Regular recovery by user 5
    const result = await recoverLegacyShifts({
      userId: 5,
      targetTeamId: 1,
      sql: async (strings, ...values) => {
        // Membership check
        if (strings.join("?").includes("FROM team_memberships")) {
          return [{ id: 1, user_id: 5, team_id: 1, role: "Staff" }];
        }
        return sql(strings, ...values);
      },
    });

    assert.equal(result.recoveredCount, 1);
    assert.equal(result.shifts[0].id, 1);

    // Orphan shifts 2 and 3 must still have user_id IS NULL and team_id IS NULL
    const shift2 = state.shifts.find((s) => s.id === 2);
    const shift3 = state.shifts.find((s) => s.id === 3);
    assert.equal(shift2.team_id, null);
    assert.equal(shift2.user_id, null);
    assert.equal(shift3.team_id, null);
    assert.equal(shift3.user_id, null);
  });
});

describe("Shift Recovery UI Outcome Resolver — resolveShiftRecoveryResponse", () => {
  it("resolves 401 Unauthorized to unauthenticated status with sign-in guidance", () => {
    const outcome = resolveShiftRecoveryResponse(401, { error: "Authentication required." });
    assert.equal(outcome.status, "unauthenticated");
    assert.match(outcome.message, /Authentication required/);
  });

  it("resolves 403 Forbidden to forbidden status with custom server message", () => {
    const outcome = resolveShiftRecoveryResponse(403, {
      error: "Access denied: You are not an authorized member of the target workspace.",
    });
    assert.equal(outcome.status, "forbidden");
    assert.match(outcome.message, /not an authorized member/);
  });

  it("resolves 409 Conflict to conflict status", () => {
    const outcome = resolveShiftRecoveryResponse(409, { error: "One or more shifts have already been assigned." });
    assert.equal(outcome.status, "conflict");
    assert.match(outcome.message, /already been assigned/);
  });

  it("resolves 200 OK to success status with recovered count and target workspace", () => {
    const outcome = resolveShiftRecoveryResponse(200, {
      success: true,
      message: "Successfully recovered 3 legacy shift(s).",
      recoveredCount: 3,
      targetTeamId: 10,
    });
    assert.equal(outcome.status, "success");
    if (outcome.status === "success") {
      assert.equal(outcome.recoveredCount, 3);
      assert.equal(outcome.targetTeamId, 10);
      assert.match(outcome.message, /Successfully recovered/);
    }
  });

  it("resolves 500 or unknown errors safely without leaking internal details", () => {
    const outcome = resolveShiftRecoveryResponse(500, { error: "Database transaction deadlock" });
    assert.equal(outcome.status, "error");
    assert.match(outcome.message, /Database transaction deadlock/);

    const fallbackOutcome = resolveShiftRecoveryResponse(500, null);
    assert.equal(fallbackOutcome.status, "error");
    assert.match(fallbackOutcome.message, /Failed to recover legacy shifts/);
  });
});

describe("Shift Recovery UI Flow Integration — End-to-End Simulation", () => {
  it("simulates full UI recovery lifecycle: discover, list workspaces, confirm, recover, and refresh", async () => {
    const user = {
      userId: 55,
      email: "doctor@rota.local",
      name: "Dr. Amara",
      role: "Staff",
      teamId: 10,
    };

    const { state, sql } = createMockDb({
      memberships: [
        { id: 1, user_id: 55, team_id: 10, role: "Staff", is_default: true },
        { id: 2, user_id: 55, team_id: 12, role: "Consultant", is_default: false },
      ],
      shifts: [
        { id: 501, employee_name: "Dr. Amara", role: "Staff", user_id: 55, team_id: null, shift_day: "2026-11-10" },
        { id: 502, employee_name: "Dr. Amara", role: "Staff", user_id: 55, team_id: null, shift_day: "2026-11-11" },
      ],
    });

    // 1. UI checks for recoverable shifts on load (GET /api/shifts/recover)
    const getReq = new Request("http://localhost/api/shifts/recover", { method: "GET" });
    const getRes = await handleGetRecoverableShifts(getReq, {
      getSessionUser: async () => user,
      sql,
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.recoverableCount, 2);
    assert.equal(getData.shifts.length, 2);

    // 2. UI opens recovery modal and fetches user's authorized workspaces (GET /api/teams)
    const teamsRes = await handleGetTeams({
      getSessionUser: async () => user,
      sql: async (strings) => {
        if (strings.join("?").includes("FROM teams t")) {
          return [
            { id: 10, name: "City General", slug: "city-general", role: "Staff", is_default: true },
            { id: 12, name: "Starlight Clinic", slug: "starlight-clinic", role: "Consultant", is_default: false },
          ];
        }
        return [];
      },
    });
    assert.equal(teamsRes.status, 200);
    const teamsData = await teamsRes.json();
    assert.equal(teamsData.teams.length, 2);

    // 3. UI submits recovery with user-selected authorized workspace (POST /api/shifts/recover)
    const postReq = new Request("http://localhost/api/shifts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetTeamId: 10 }),
    });
    const postRes = await handlePostRecoverShifts(postReq, {
      getSessionUser: async () => user,
      sql,
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    const outcome = resolveShiftRecoveryResponse(postRes.status, postData);
    assert.equal(outcome.status, "success");
    if (outcome.status === "success") {
      assert.equal(outcome.recoveredCount, 2);
      assert.equal(outcome.targetTeamId, 10);
    }

    // 4. UI refreshes recoverable shifts (GET /api/shifts/recover) -> now 0 shifts pending
    const refreshReq = new Request("http://localhost/api/shifts/recover", { method: "GET" });
    const refreshRes = await handleGetRecoverableShifts(refreshReq, {
      getSessionUser: async () => user,
      sql,
    });
    assert.equal(refreshRes.status, 200);
    const refreshData = await refreshRes.json();
    assert.equal(refreshData.recoverableCount, 0);
    assert.deepEqual(refreshData.shifts, []);

    // 5. Database state verified: shifts are now assigned to team 10
    const shift1 = state.shifts.find((s) => s.id === 501);
    const shift2 = state.shifts.find((s) => s.id === 502);
    assert.equal(shift1.team_id, 10);
    assert.equal(shift2.team_id, 10);
  });
});

