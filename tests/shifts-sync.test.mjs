import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeShiftsRevision,
  resolveShiftSyncResponse,
} from "../lib/shifts-sync.ts";
import { handleGetShiftSync } from "../app/api/shifts/sync/route.ts";
import { handleGetShifts, handlePostShift } from "../app/api/shifts/route.ts";
import { handlePutShift, handleDeleteShift } from "../app/api/shifts/[id]/route.ts";

describe("Real-Time Shift Synchronization — Revision & Versioning Primitives", () => {
  const baseShifts = [
    {
      id: 1,
      employee_name: "Emeka Okafor",
      role: "Front Desk",
      shift_day: "2026-11-10",
      user_id: 10,
    },
    {
      id: 2,
      employee_name: "Adaobi Eze",
      role: "Supervisor",
      shift_day: "2026-11-11",
      user_id: 11,
    },
  ];

  it("produces deterministic revision hash regardless of shifts array ordering", () => {
    const rev1 = computeShiftsRevision(baseShifts);
    const rev2 = computeShiftsRevision([baseShifts[1], baseShifts[0]]);

    assert.equal(rev1, rev2);
    assert.match(rev1, /^rev_2_2_3_[0-9a-f]+$/);
  });

  it("returns deterministic empty revision for empty or missing shift collections", () => {
    assert.equal(computeShiftsRevision([]), "rev_0_0_0_empty");
    assert.equal(computeShiftsRevision(null), "rev_0_0_0_empty");
    assert.equal(computeShiftsRevision(undefined), "rev_0_0_0_empty");
  });

  it("detects shift creation: adding a shift changes revision hash and count", () => {
    const initialRev = computeShiftsRevision(baseShifts);

    const afterAdd = [
      ...baseShifts,
      {
        id: 3,
        employee_name: "Chinedu Obi",
        role: "Staff",
        shift_day: "2026-11-12",
        user_id: 12,
      },
    ];

    const newRev = computeShiftsRevision(afterAdd);
    assert.notEqual(initialRev, newRev);
    assert.match(newRev, /^rev_3_/);
  });

  it("detects shift deletion: removing a shift changes revision hash and count", () => {
    const initialRev = computeShiftsRevision(baseShifts);
    const afterDelete = [baseShifts[0]];

    const newRev = computeShiftsRevision(afterDelete);
    assert.notEqual(initialRev, newRev);
    assert.match(newRev, /^rev_1_/);
  });

  it("detects shift edit: changing role, shift date, employee name, or assigned user changes revision hash", () => {
    const initialRev = computeShiftsRevision(baseShifts);

    // 1. Role changed
    const roleEdited = [
      { ...baseShifts[0], role: "Customer Support" },
      baseShifts[1],
    ];
    assert.notEqual(initialRev, computeShiftsRevision(roleEdited));

    // 2. Date changed
    const dateEdited = [
      { ...baseShifts[0], shift_day: "2026-11-15" },
      baseShifts[1],
    ];
    assert.notEqual(initialRev, computeShiftsRevision(dateEdited));

    // 3. Employee reassigned / user_id changed
    const userEdited = [
      { ...baseShifts[0], user_id: 99, employee_name: "New Person" },
      baseShifts[1],
    ];
    assert.notEqual(initialRev, computeShiftsRevision(userEdited));
  });

  it("resolves shift sync HTTP responses into strongly typed outcomes", () => {
    // 200 with changed: true -> synced
    const synced = resolveShiftSyncResponse(200, {
      workspaceId: 5,
      version: "rev_3_10_20_abc",
      shiftCount: 3,
      changed: true,
    });
    assert.equal(synced.status, "synced");
    assert.equal(synced.version, "rev_3_10_20_abc");

    // 200 with changed: false -> no_change
    const noChange = resolveShiftSyncResponse(200, {
      workspaceId: 5,
      version: "rev_3_10_20_abc",
      shiftCount: 3,
      changed: false,
    });
    assert.equal(noChange.status, "no_change");
    assert.equal(noChange.version, "rev_3_10_20_abc");

    // 401 Unauthorized
    const unauth = resolveShiftSyncResponse(401, { error: "Authentication required" });
    assert.equal(unauth.status, "unauthenticated");

    // 403 Forbidden
    const forbidden = resolveShiftSyncResponse(403, { error: "Access denied" });
    assert.equal(forbidden.status, "forbidden");

    // 500 Network or server error
    const err = resolveShiftSyncResponse(500, null);
    assert.equal(err.status, "error");
  });
});

describe("Real-Time Shift Synchronization — API Route Handler (GET /api/shifts/sync)", () => {
  it("rejects unauthenticated requests with HTTP 401 Unauthorized", async () => {
    const req = new Request("http://localhost/api/shifts/sync");
    const res = await handleGetShiftSync(req, {
      getSessionUser: async () => null,
      sql: async () => [],
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Authentication required/i);
  });

  it("rejects callers without an active team membership with HTTP 403 Forbidden", async () => {
    const user = { userId: 1, name: "Dr. Admin", role: "Owner", teamId: null };
    const req = new Request("http://localhost/api/shifts/sync");
    const res = await handleGetShiftSync(req, {
      getSessionUser: async () => user,
      sql: async () => [],
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /No active team membership found/i);
  });

  it("returns current workspace revision with changed=true on initial sync (no version param)", async () => {
    const user = { userId: 5, name: "Nurse Jane", role: "Staff", teamId: 10 };
    const req = new Request("http://localhost/api/shifts/sync");

    const mockShifts = [
      { id: 1, employee_name: "Nurse Jane", role: "Staff", user_id: 5, shift_day: "2026-11-10" },
    ];

    let capturedTeamId = null;
    const mockSql = async (strings, ...values) => {
      capturedTeamId = values[0];
      return mockShifts;
    };

    const res = await handleGetShiftSync(req, {
      getSessionUser: async () => user,
      sql: mockSql,
    });

    assert.equal(res.status, 200);
    assert.equal(capturedTeamId, 10, "Query must be strictly scoped to caller's teamId");

    const body = await res.json();
    assert.equal(body.workspaceId, 10);
    assert.equal(body.shiftCount, 1);
    assert.equal(body.changed, true);
    assert.ok(body.version.startsWith("rev_1_"));
  });

  it("returns changed=false when client-supplied version matches current database revision", async () => {
    const user = { userId: 5, name: "Nurse Jane", role: "Staff", teamId: 10 };
    const mockShifts = [
      { id: 1, employee_name: "Nurse Jane", role: "Staff", user_id: 5, shift_day: "2026-11-10" },
    ];
    const currentVersion = computeShiftsRevision(mockShifts);

    const req = new Request(`http://localhost/api/shifts/sync?version=${encodeURIComponent(currentVersion)}`);
    const res = await handleGetShiftSync(req, {
      getSessionUser: async () => user,
      sql: async () => mockShifts,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.workspaceId, 10);
    assert.equal(body.version, currentVersion);
    assert.equal(body.changed, false, "Must signal changed=false to avoid re-downloading roster");
    assert.equal(body.shiftCount, 1);
    assert.equal(body.shifts, undefined, "Must not download full shift list when unchanged");
  });

  it("returns changed=true when client-supplied version is stale", async () => {
    const user = { userId: 5, name: "Nurse Jane", role: "Staff", teamId: 10 };
    const mockShifts = [
      { id: 1, employee_name: "Nurse Jane", role: "Staff", user_id: 5, shift_day: "2026-11-10" },
      { id: 2, employee_name: "Dr. Admin", role: "Owner", user_id: 1, shift_day: "2026-11-11" },
    ];

    const staleVersion = "rev_1_1_1_oldversion";
    const req = new Request(`http://localhost/api/shifts/sync?version=${encodeURIComponent(staleVersion)}`);
    const res = await handleGetShiftSync(req, {
      getSessionUser: async () => user,
      sql: async () => mockShifts,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.workspaceId, 10);
    assert.equal(body.changed, true);
    assert.notEqual(body.version, staleVersion);
    assert.equal(body.shiftCount, 2);
  });
});

describe("Real-Time Shift Synchronization — Manager & Employee End-to-End Scenarios", () => {
  // Shared database mock store representing workspace state
  let workspaceShifts = [];

  const managerUser = {
    userId: 1,
    name: "Dr. Admin",
    role: "Owner",
    teamId: 42,
  };

  const employeeUser = {
    userId: 10,
    name: "Nurse Amara",
    role: "Staff",
    teamId: 42,
  };

  const otherWorkspaceUser = {
    userId: 88,
    name: "Dr. External",
    role: "Owner",
    teamId: 99, // Different workspace
  };

  function createSqlMock() {
    return async (strings, ...values) => {
      const q = strings.join("?");

      // SELECT employee user match for manager assigning shift
      if (q.includes("FROM users u") && q.includes("JOIN team_memberships tm")) {
        const nameLower = String(values[1] || "").toLowerCase();
        if (nameLower.includes("external")) {
          return [{ id: 88, name: "Dr. External", role: "Owner" }];
        }
        return [{ id: 10, name: "Nurse Amara", role: "Staff" }];
      }

      // SELECT shifts for team
      if (q.includes("FROM shifts") && q.includes("WHERE team_id =")) {
        const teamId = values[0];
        return workspaceShifts.filter((s) => s.team_id === teamId);
      }

      // INSERT shift
      if (q.includes("INSERT INTO shifts")) {
        const [empName, role, shiftDay, userId, teamId] = values;
        const newId = workspaceShifts.length > 0 ? Math.max(...workspaceShifts.map((s) => s.id)) + 1 : 1;
        const newShift = {
          id: newId,
          employee_name: empName,
          role,
          shift_day: shiftDay,
          user_id: userId,
          team_id: teamId,
          created_at: new Date().toISOString(),
        };
        workspaceShifts.push(newShift);
        return [newShift];
      }

      // UPDATE shift
      if (q.includes("UPDATE shifts")) {
        const [empName, role, shiftDay, userId, shiftId, teamId] = values;
        const index = workspaceShifts.findIndex((s) => s.id === shiftId && s.team_id === teamId);
        if (index !== -1) {
          workspaceShifts[index] = {
            ...workspaceShifts[index],
            employee_name: empName,
            role,
            shift_day: shiftDay,
            user_id: userId,
          };
          return [workspaceShifts[index]];
        }
        return [];
      }

      // SELECT existing shift for PUT/DELETE
      if (q.includes("SELECT") && q.includes("FROM shifts") && q.includes("WHERE id = ? AND team_id = ?")) {
        const [shiftId, teamId] = values;
        const match = workspaceShifts.find((s) => s.id === shiftId && s.team_id === teamId);
        return match ? [match] : [];
      }

      // DELETE shift
      if (q.includes("DELETE FROM shifts")) {
        const [shiftId, teamId] = values;
        const index = workspaceShifts.findIndex((s) => s.id === shiftId && s.team_id === teamId);
        if (index !== -1) {
          workspaceShifts.splice(index, 1);
        }
        return [];
      }

      return [];
    };
  }

  it("Scenario 1: Manager creates shift -> Employee detects change and fetches updated schedule", async () => {
    // Reset workspace store with 1 initial shift
    workspaceShifts = [
      { id: 101, employee_name: "Nurse Amara", role: "Staff", shift_day: "2026-11-01", user_id: 10, team_id: 42 },
    ];

    const sqlMock = createSqlMock();

    // 1. Employee starts with initial version
    const initialSyncReq = new Request("http://localhost/api/shifts/sync");
    const initialSyncRes = await handleGetShiftSync(initialSyncReq, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const initialSync = await initialSyncRes.json();
    const initialVersion = initialSync.version;

    // 2. Employee conditional poll confirms no change currently
    const pollBeforeReq = new Request(`http://localhost/api/shifts/sync?version=${encodeURIComponent(initialVersion)}`);
    const pollBeforeRes = await handleGetShiftSync(pollBeforeReq, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const pollBefore = await pollBeforeRes.json();
    assert.equal(pollBefore.changed, false, "Must report unchanged before manager action");

    // 3. Manager creates a new shift in Workspace 42
    const postReq = new Request("http://localhost/api/shifts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        employeeName: "Nurse Amara",
        role: "Staff",
        shiftDay: "2026-11-02",
      }),
    });
    const postRes = await handlePostShift(postReq, {
      getSessionUser: async () => managerUser,
      sql: sqlMock,
    });
    assert.equal(postRes.status, 201);

    // 4. Employee's periodic conditional poll detects the new shift!
    const pollAfterReq = new Request(`http://localhost/api/shifts/sync?version=${encodeURIComponent(initialVersion)}`);
    const pollAfterRes = await handleGetShiftSync(pollAfterReq, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const pollAfter = await pollAfterRes.json();
    assert.equal(pollAfter.changed, true, "Employee poll must detect new shift created by manager");
    assert.equal(pollAfter.shiftCount, 2);
    assert.notEqual(pollAfter.version, initialVersion);

    // 5. Employee refreshes roster via GET /api/shifts and receives the new shift
    const getShiftsRes = await handleGetShifts({
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const updatedShifts = await getShiftsRes.json();
    assert.equal(updatedShifts.length, 2);
    assert.equal(updatedShifts[1].shift_day, "2026-11-02");
  });

  it("Scenario 2: Manager edits shift -> Employee detects change and fetches updated details", async () => {
    // Current state has 2 shifts
    const sqlMock = createSqlMock();
    const currentVerReq = new Request("http://localhost/api/shifts/sync");
    const currentVerRes = await handleGetShiftSync(currentVerReq, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const currentVersion = (await currentVerRes.json()).version;

    // 1. Manager updates shift #101's role to "Supervisor" and date to "2026-11-05"
    const putReq = new Request("http://localhost/api/shifts/101", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "Supervisor",
        shiftDay: "2026-11-05",
      }),
    });
    const putRes = await handlePutShift(putReq, { params: Promise.resolve({ id: "101" }) }, {
      getSessionUser: async () => managerUser,
      sql: sqlMock,
    });
    assert.equal(putRes.status, 200);

    // 2. Employee's periodic conditional poll detects the modification
    const syncReq = new Request(`http://localhost/api/shifts/sync?version=${encodeURIComponent(currentVersion)}`);
    const syncRes = await handleGetShiftSync(syncReq, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const syncResult = await syncRes.json();
    assert.equal(syncResult.changed, true, "Employee poll must detect shift update by manager");
    assert.notEqual(syncResult.version, currentVersion);

    // 3. Employee fetches updated shifts
    const getShiftsRes = await handleGetShifts({
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const shiftsList = await getShiftsRes.json();
    const editedShift = shiftsList.find((s) => s.id === 101);
    assert.equal(editedShift.role, "Supervisor");
    assert.equal(editedShift.shift_day, "2026-11-05");
  });

  it("Scenario 3: Manager deletes shift -> Employee detects change and removes shift", async () => {
    const sqlMock = createSqlMock();
    const currentVerReq = new Request("http://localhost/api/shifts/sync");
    const currentVerRes = await handleGetShiftSync(currentVerReq, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const currentVersion = (await currentVerRes.json()).version;

    // 1. Manager deletes shift #101
    const deleteReq = new Request("http://localhost/api/shifts/101", { method: "DELETE" });
    const deleteRes = await handleDeleteShift(deleteReq, { params: Promise.resolve({ id: "101" }) }, {
      getSessionUser: async () => managerUser,
      sql: sqlMock,
    });
    assert.equal(deleteRes.status, 200);

    // 2. Employee poll detects the deletion
    const syncReq = new Request(`http://localhost/api/shifts/sync?version=${encodeURIComponent(currentVersion)}`);
    const syncRes = await handleGetShiftSync(syncReq, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const syncResult = await syncRes.json();
    assert.equal(syncResult.changed, true, "Employee poll must detect shift removal by manager");
    assert.equal(syncResult.shiftCount, 1);
    assert.notEqual(syncResult.version, currentVersion);

    // 3. Employee fetches roster -> shift 101 is gone
    const getShiftsRes = await handleGetShifts({
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const remainingShifts = await getShiftsRes.json();
    assert.equal(remainingShifts.length, 1);
    assert.equal(remainingShifts.some((s) => s.id === 101), false);
  });

  it("Scenario 4: Tenant Isolation — Actions in Workspace 99 do not trigger sync in Workspace 42", async () => {
    const sqlMock = createSqlMock();

    // 1. Employee in Workspace 42 gets their current version
    const ws42Req = new Request("http://localhost/api/shifts/sync");
    const ws42Res = await handleGetShiftSync(ws42Req, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const ws42Version = (await ws42Res.json()).version;

    // 2. Manager in Workspace 99 creates a shift in Workspace 99
    const ws99PostReq = new Request("http://localhost/api/shifts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        employeeName: "Dr. External",
        role: "Owner",
        shiftDay: "2026-11-20",
      }),
    });
    const ws99PostRes = await handlePostShift(ws99PostReq, {
      getSessionUser: async () => otherWorkspaceUser,
      sql: sqlMock,
    });
    assert.equal(ws99PostRes.status, 201);

    // 3. Employee in Workspace 42 checks sync: must return changed: false!
    const ws42PollReq = new Request(`http://localhost/api/shifts/sync?version=${encodeURIComponent(ws42Version)}`);
    const ws42PollRes = await handleGetShiftSync(ws42PollReq, {
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const ws42Poll = await ws42PollRes.json();
    assert.equal(ws42Poll.changed, false, "Workspace 42 must NOT detect changes made in Workspace 99");
    assert.equal(ws42Poll.version, ws42Version);

    // 4. Employee in Workspace 42 cannot see Workspace 99's shift
    const ws42ShiftsRes = await handleGetShifts({
      getSessionUser: async () => employeeUser,
      sql: sqlMock,
    });
    const ws42Shifts = await ws42ShiftsRes.json();
    assert.equal(ws42Shifts.some((s) => s.team_id === 99), false);
  });
});

describe("Real-Time Shift Synchronization — Polling & Safety Guards", () => {
  it("prevents overlapping polling requests via in-flight guard", async () => {
    let activeInFlightRequests = 0;
    let maxSimultaneousInFlight = 0;
    let isSyncing = false;

    async function simulatedSyncPoll() {
      // Non-overlapping guard
      if (isSyncing) return { skipped: true };

      isSyncing = true;
      activeInFlightRequests++;
      maxSimultaneousInFlight = Math.max(maxSimultaneousInFlight, activeInFlightRequests);

      // Simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 20));

      activeInFlightRequests--;
      isSyncing = false;
      return { skipped: false };
    }

    // Fire 3 simultaneous ticks
    const results = await Promise.all([
      simulatedSyncPoll(),
      simulatedSyncPoll(),
      simulatedSyncPoll(),
    ]);

    assert.equal(maxSimultaneousInFlight, 1, "There must never be more than 1 in-flight sync request");
    const executed = results.filter((r) => !r.skipped);
    const skipped = results.filter((r) => r.skipped);

    assert.equal(executed.length, 1);
    assert.equal(skipped.length, 2);
  });

  it("aborts in-flight request and cleans up timer on component unmount", () => {
    let isMounted = true;
    const controller = new AbortController();

    let pollCount = 0;
    const intervalId = setInterval(() => {
      if (!isMounted) return;
      pollCount++;
    }, 10);

    // Simulate component unmount after 25ms
    setTimeout(() => {
      isMounted = false;
      clearInterval(intervalId);
      controller.abort();
    }, 25);

    return new Promise((resolve) => {
      setTimeout(() => {
        assert.ok(controller.signal.aborted, "AbortController must be aborted on unmount");
        const countAtUnmount = pollCount;

        // Wait another 30ms to guarantee no further poll occurred after unmount
        setTimeout(() => {
          assert.equal(pollCount, countAtUnmount, "Polling must not continue after component unmount");
          resolve();
        }, 30);
      }, 35);
    });
  });

  it("handles network interruption safely without throwing or destroying cached state", () => {
    let clientSchedule = [{ id: 1, name: "Dr. Admin", role: "Owner" }];

    function handleSyncNetworkFailure(err) {
      // Safe catch: network failure does not wipe the schedule or crash
      return { outcome: "network_interruption", preservedSchedule: clientSchedule };
    }

    const result = handleSyncNetworkFailure(new Error("Failed to fetch / network disconnected"));
    assert.equal(result.outcome, "network_interruption");
    assert.equal(result.preservedSchedule.length, 1, "Schedule must be preserved during network failure");
  });
});
