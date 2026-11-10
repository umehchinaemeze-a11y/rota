import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateSwapRequest,
  canApproveSwap,
  canCancelSwap,
} from "../lib/shift-swaps.ts";
import {
  handleGetSwaps,
  handlePostSwap,
} from "../app/api/shifts/swaps/route.ts";
import { handleApproveSwap } from "../app/api/shifts/swaps/[id]/approve/route.ts";
import { handleRejectSwap } from "../app/api/shifts/swaps/[id]/reject/route.ts";
import { computeShiftsRevision } from "../lib/shifts-sync.ts";

describe("Shift Swaps — Pure Validation & Authorization Primitives", () => {
  const sessionStaff = {
    userId: 10,
    email: "nurse@clinic.ng",
    name: "Nurse Jane",
    role: "Staff",
    teamId: 5,
  };

  const sessionManager = {
    userId: 1,
    email: "dr.admin@clinic.ng",
    name: "Dr. Admin",
    role: "Owner",
    teamId: 5,
  };

  const shiftOwn = {
    id: 101,
    employee_name: "Nurse Jane",
    role: "Staff",
    user_id: 10,
    team_id: 5,
    shift_day: "2026-11-20",
  };

  const shiftColleague = {
    id: 102,
    employee_name: "Emeka Okafor",
    role: "Front Desk",
    user_id: 20,
    team_id: 5,
    shift_day: "2026-11-21",
  };

  const shiftOtherWorkspace = {
    id: 999,
    employee_name: "Dr. External",
    role: "Staff",
    user_id: 88,
    team_id: 99, // Different workspace
    shift_day: "2026-11-21",
  };

  it("validates valid swap request between two upcoming shifts in same workspace", () => {
    const res = validateSwapRequest(
      { sourceShiftId: 101, targetShiftId: 102 },
      sessionStaff,
      shiftOwn,
      shiftColleague,
      "2026-11-15"
    );
    assert.equal(res.valid, true);
  });

  it("rejects swap request when non-manager employee does not own the source shift", () => {
    const res = validateSwapRequest(
      { sourceShiftId: 102, targetShiftId: 101 },
      sessionStaff,
      shiftColleague, // Owned by user 20, not sessionStaff (10)
      shiftOwn,
      "2026-11-15"
    );
    assert.equal(res.valid, false);
    assert.equal(res.code, "UNAUTHORIZED");
  });

  it("allows a manager to propose swap on behalf of employees in the workspace", () => {
    const res = validateSwapRequest(
      { sourceShiftId: 101, targetShiftId: 102 },
      sessionManager,
      shiftOwn,
      shiftColleague,
      "2026-11-15"
    );
    assert.equal(res.valid, true);
  });

  it("rejects cross-workspace swaps (target shift in another team)", () => {
    const res = validateSwapRequest(
      { sourceShiftId: 101, targetShiftId: 999 },
      sessionStaff,
      shiftOwn,
      shiftOtherWorkspace,
      "2026-11-15"
    );
    assert.equal(res.valid, false);
    assert.equal(res.code, "CROSS_WORKSPACE");
  });

  it("rejects swapping a shift with itself", () => {
    const res = validateSwapRequest(
      { sourceShiftId: 101, targetShiftId: 101 },
      sessionStaff,
      shiftOwn,
      shiftOwn,
      "2026-11-15"
    );
    assert.equal(res.valid, false);
    assert.equal(res.code, "SELF_SWAP");
  });

  it("rejects swapping with a shift assigned to the same user", () => {
    const anotherOwnShift = { ...shiftOwn, id: 103, shift_day: "2026-11-25" };
    const res = validateSwapRequest(
      { sourceShiftId: 101, targetShiftId: 103 },
      sessionStaff,
      shiftOwn,
      anotherOwnShift,
      "2026-11-15"
    );
    assert.equal(res.valid, false);
    assert.equal(res.code, "SELF_SWAP");
  });

  it("rejects swapping past shifts", () => {
    const pastShift = { ...shiftOwn, shift_day: "2026-10-01" };
    const res = validateSwapRequest(
      { sourceShiftId: 101, targetShiftId: 102 },
      sessionStaff,
      pastShift,
      shiftColleague,
      "2026-11-15" // Today is Nov 15
    );
    assert.equal(res.valid, false);
    assert.equal(res.code, "PAST_SHIFT");
  });

  it("authorizes only managers to approve swaps", () => {
    const swap = { team_id: 5, requester_user_id: 10 };
    assert.equal(canApproveSwap(sessionManager, swap), true);
    assert.equal(canApproveSwap(sessionStaff, swap), false);

    // Cross-team manager cannot approve
    const crossTeamManager = { ...sessionManager, teamId: 99 };
    assert.equal(canApproveSwap(crossTeamManager, swap), false);
  });

  it("authorizes managers or original requester to cancel/reject swaps", () => {
    const swap = { team_id: 5, requester_user_id: 10 };
    assert.equal(canCancelSwap(sessionManager, swap), true);
    assert.equal(canCancelSwap(sessionStaff, swap), true); // Requester can cancel

    // Unrelated employee cannot cancel
    const thirdPartyStaff = { ...sessionStaff, userId: 99 };
    assert.equal(canCancelSwap(thirdPartyStaff, swap), false);
  });
});

describe("Shift Swaps API — Creation & Listing Handlers", () => {
  const staffUser = { userId: 10, name: "Nurse Jane", role: "Staff", teamId: 5 };
  const colleagueUser = { userId: 20, name: "Emeka Okafor", role: "Front Desk", teamId: 5 };

  let inMemorySwaps = [];
  let inMemoryShifts = [
    { id: 101, employee_name: "Nurse Jane", role: "Staff", user_id: 10, team_id: 5, shift_day: "2026-11-20" },
    { id: 102, employee_name: "Emeka Okafor", role: "Front Desk", user_id: 20, team_id: 5, shift_day: "2026-11-21" },
    { id: 999, employee_name: "Dr. External", role: "Staff", user_id: 88, team_id: 99, shift_day: "2026-11-21" },
  ];

  function createMockSql() {
    return async (strings, ...values) => {
      const q = strings.join("?");

      if (q.includes("FROM shifts") && q.includes("WHERE id IN")) {
        const teamId = values[values.length - 1];
        const requestedIds = values.slice(0, values.length - 1);
        return inMemoryShifts.filter((s) => s.team_id === teamId && requestedIds.includes(s.id));
      }

      if (q.includes("FROM shift_swaps") && q.includes("WHERE team_id = ?") && q.includes("status = 'pending'")) {
        const teamId = values[0];
        const s1 = values[1];
        const s2 = values[2];
        return inMemorySwaps.filter(
          (sw) =>
            sw.team_id === teamId &&
            sw.status === "pending" &&
            (sw.source_shift_id === s1 ||
              sw.source_shift_id === s2 ||
              sw.target_shift_id === s1 ||
              sw.target_shift_id === s2)
        );
      }

      if (q.includes("INSERT INTO shift_swaps")) {
        const teamId = values[0];
        const reqUserId = values[1];
        const tgtUserId = values[2];
        const srcShiftId = values[3];
        const tgtShiftId = values[4];
        const reason = values[values.length - 1];
        const newSwap = {
          id: inMemorySwaps.length + 1,
          team_id: teamId,
          requester_user_id: reqUserId,
          target_user_id: tgtUserId,
          source_shift_id: srcShiftId,
          target_shift_id: tgtShiftId,
          status: "pending",
          reason,
          created_at: new Date().toISOString(),
        };
        inMemorySwaps.push(newSwap);
        return [newSwap];
      }

      if (q.includes("FROM shift_swaps s")) {
        return inMemorySwaps.map((s) => ({
          ...s,
          requester_name: "Nurse Jane",
          target_employee_name: "Emeka Okafor",
          source_shift_day: "2026-11-20",
          source_role: "Staff",
          target_shift_day: "2026-11-21",
          target_role: "Front Desk",
        }));
      }

      return [];
    };
  }

  it("rejects unauthenticated swap submission with HTTP 401", async () => {
    const req = new Request("http://localhost/api/shifts/swaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceShiftId: 101, targetShiftId: 102 }),
    });

    const res = await handlePostSwap(req, {
      getSessionUser: async () => null,
      sql: createMockSql(),
    });

    assert.equal(res.status, 401);
  });

  it("submits valid swap request and records pending record", async () => {
    inMemorySwaps = [];
    const req = new Request("http://localhost/api/shifts/swaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceShiftId: 101,
        targetShiftId: 102,
        reason: "Need to attend dental appointment",
      }),
    });

    const res = await handlePostSwap(req, {
      getSessionUser: async () => staffUser,
      sql: createMockSql(),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.source_shift_id, 101);
    assert.equal(body.target_shift_id, 102);
    assert.equal(body.status, "pending");
    assert.equal(body.reason, "Need to attend dental appointment");
    assert.equal(inMemorySwaps.length, 1);
  });

  it("rejects duplicate or conflicting swap request when one is already pending (HTTP 409)", async () => {
    // Attempt to submit another swap request for shift 101 while previous is pending
    const req = new Request("http://localhost/api/shifts/swaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceShiftId: 101,
        targetShiftId: 102,
      }),
    });

    const res = await handlePostSwap(req, {
      getSessionUser: async () => staffUser,
      sql: createMockSql(),
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /pending swap request already exists/i);
  });

  it("rejects cross-workspace swap request with HTTP 404 (anti-enumeration)", async () => {
    const req = new Request("http://localhost/api/shifts/swaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceShiftId: 101,
        targetShiftId: 999, // In team 99
      }),
    });

    const res = await handlePostSwap(req, {
      getSessionUser: async () => staffUser,
      sql: createMockSql(),
    });

    assert.equal(res.status, 404);
  });

  it("lists swap requests for authenticated workspace member", async () => {
    const req = new Request("http://localhost/api/shifts/swaps");
    const res = await handleGetSwaps(req, {
      getSessionUser: async () => staffUser,
      sql: createMockSql(),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Array.isArray(body), true);
    assert.equal(body.length, 1);
    assert.equal(body[0].source_shift_id, 101);
    assert.equal(body[0].target_shift_id, 102);
  });
});

describe("Shift Swaps API — Approval, Rejection & Atomic Rollback", () => {
  const managerUser = { userId: 1, name: "Dr. Admin", role: "Owner", teamId: 5 };
  const staffUser = { userId: 10, name: "Nurse Jane", role: "Staff", teamId: 5 };

  let currentSwaps = [];
  let currentShifts = [];

  function resetState() {
    currentShifts = [
      { id: 101, employee_name: "Nurse Jane", role: "Staff", user_id: 10, team_id: 5, shift_day: "2026-11-20" },
      { id: 102, employee_name: "Emeka Okafor", role: "Front Desk", user_id: 20, team_id: 5, shift_day: "2026-11-21" },
    ];
    currentSwaps = [
      {
        id: 1,
        team_id: 5,
        requester_user_id: 10,
        target_user_id: 20,
        source_shift_id: 101,
        target_shift_id: 102,
        status: "pending",
        reason: "Family event",
      },
    ];
  }

  function createTxSqlMock({ failOnShiftUpdate = false } = {}) {
    let inTransaction = false;
    let rollbackExecuted = false;
    let commitExecuted = false;

    const sqlFn = async (strings, ...values) => {
      const q = strings.join("?");

      if (q.includes("BEGIN")) {
        inTransaction = true;
        return [];
      }
      if (q.includes("COMMIT")) {
        commitExecuted = true;
        inTransaction = false;
        return [];
      }
      if (q.includes("ROLLBACK")) {
        rollbackExecuted = true;
        inTransaction = false;
        return [];
      }

      // SELECT swap
      if (q.includes("FROM shift_swaps") && q.includes("WHERE id = ? AND team_id = ?")) {
        const [swapId, teamId] = values;
        return currentSwaps.filter((s) => s.id === swapId && s.team_id === teamId);
      }

      // SELECT shifts for swap verification
      if (q.includes("FROM shifts") && q.includes("WHERE id IN")) {
        const teamId = values[values.length - 1];
        const s1 = values[0];
        const s2 = values[1];
        return currentShifts
          .filter((s) => s.team_id === teamId && (s.id === s1 || s.id === s2))
          .map((s) => ({ ...s }));
      }

      // UPDATE shift_swaps approval/rejection transition
      if (q.includes("UPDATE shift_swaps") && q.includes("status = 'pending'")) {
        let swapId;
        let newStatus;
        let decidedBy;
        let notes;
        if (q.includes("status = 'approved'")) {
          newStatus = "approved";
          [decidedBy, notes, swapId] = values;
        } else {
          [newStatus, decidedBy, notes, swapId] = values;
        }
        const swap = currentSwaps.find((s) => s.id === Number(swapId) && s.status === "pending");
        if (!swap) return []; // Concurrency: 0 rows returned if already decided
        swap.status = newStatus;
        swap.decided_by = decidedBy;
        swap.decision_notes = notes;
        swap.decided_at = new Date().toISOString();
        return [swap];
      }

      // UPDATE shifts
      if (q.includes("UPDATE shifts")) {
        if (failOnShiftUpdate) {
          throw new Error("Simulated database failure during shift assignment update!");
        }
        const [newEmpName, newUserId, shiftId, teamId] = values;
        const shift = currentShifts.find((s) => s.id === shiftId && s.team_id === teamId);
        if (shift) {
          shift.employee_name = newEmpName;
          shift.user_id = newUserId;
        }
        return shift ? [shift] : [];
      }

      return [];
    };

    sqlFn.getTransactionState = () => ({ inTransaction, rollbackExecuted, commitExecuted });
    return sqlFn;
  }

  it("rejects non-manager employee from approving swap with HTTP 403", async () => {
    resetState();
    const sqlMock = createTxSqlMock();

    const req = new Request("http://localhost/api/shifts/swaps/1/approve", { method: "POST" });
    const res = await handleApproveSwap(req, { params: Promise.resolve({ id: "1" }) }, {
      getSessionUser: async () => staffUser,
      sql: sqlMock,
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Only workspace managers can approve/i);
    assert.equal(currentSwaps[0].status, "pending");
  });

  it("successfully approves swap: atomically exchanges assignments on both shifts", async () => {
    resetState();
    const sqlMock = createTxSqlMock();

    const initialRevision = computeShiftsRevision(currentShifts);

    const req = new Request("http://localhost/api/shifts/swaps/1/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Approved by manager" }),
    });

    const res = await handleApproveSwap(req, { params: Promise.resolve({ id: "1" }) }, {
      getSessionUser: async () => managerUser,
      sql: sqlMock,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    // Verify swap record is approved
    assert.equal(currentSwaps[0].status, "approved");
    assert.equal(currentSwaps[0].decided_by, 1);
    assert.equal(currentSwaps[0].decision_notes, "Approved by manager");

    // Verify both shifts were exchanged:
    // Shift 101 (Nov 20) now assigned to Emeka Okafor (userId 20)
    const shift101 = currentShifts.find((s) => s.id === 101);
    assert.equal(shift101.employee_name, "Emeka Okafor");
    assert.equal(shift101.user_id, 20);

    // Shift 102 (Nov 21) now assigned to Nurse Jane (userId 10)
    const shift102 = currentShifts.find((s) => s.id === 102);
    assert.equal(shift102.employee_name, "Nurse Jane");
    assert.equal(shift102.user_id, 10);

    // Verify revision changed so real-time sync notifies other members
    const newRevision = computeShiftsRevision(currentShifts);
    assert.notEqual(initialRevision, newRevision, "Schedule revision must change after swap approval");

    const txState = sqlMock.getTransactionState();
    assert.equal(txState.commitExecuted, true, "Transaction must commit successfully");
  });

  it("prevents concurrent approvals from double-assigning (HTTP 409 on second attempt)", async () => {
    resetState();
    const sqlMock = createTxSqlMock();

    const approveCall = () =>
      handleApproveSwap(
        new Request("http://localhost/api/shifts/swaps/1/approve", { method: "POST" }),
        { params: Promise.resolve({ id: "1" }) },
        { getSessionUser: async () => managerUser, sql: sqlMock }
      );

    // Fire two approval calls
    const [res1, res2] = await Promise.all([approveCall(), approveCall()]);

    const statuses = [res1.status, res2.status].sort();
    assert.equal(statuses[0], 200, "First approval must succeed");
    assert.equal(statuses[1], 409, "Second concurrent approval must be rejected with 409 Conflict");
  });

  it("executes atomic rollback if any shift update fails, preserving original assignments", async () => {
    resetState();
    // Simulate error during shift update
    const sqlMock = createTxSqlMock({ failOnShiftUpdate: true });

    const req = new Request("http://localhost/api/shifts/swaps/1/approve", { method: "POST" });
    const res = await handleApproveSwap(req, { params: Promise.resolve({ id: "1" }) }, {
      getSessionUser: async () => managerUser,
      sql: sqlMock,
    });

    assert.equal(res.status, 500);

    const txState = sqlMock.getTransactionState();
    assert.equal(txState.rollbackExecuted, true, "Rollback must execute on database failure");

    // Verify original assignments remain untouched
    const shift101 = currentShifts.find((s) => s.id === 101);
    assert.equal(shift101.employee_name, "Nurse Jane");
    assert.equal(shift101.user_id, 10);
  });

  it("manager rejects swap request -> status transitions to 'rejected'", async () => {
    resetState();
    const sqlMock = createTxSqlMock();

    const req = new Request("http://localhost/api/shifts/swaps/1/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "Understaffed on that weekend" }),
    });

    const res = await handleRejectSwap(req, { params: Promise.resolve({ id: "1" }) }, {
      getSessionUser: async () => managerUser,
      sql: sqlMock,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.swap.status, "rejected");
    assert.equal(body.swap.decision_notes, "Understaffed on that weekend");

    // Shifts remain unchanged
    const shift101 = currentShifts.find((s) => s.id === 101);
    assert.equal(shift101.user_id, 10);
  });

  it("employee cancels their own pending swap -> status transitions to 'cancelled'", async () => {
    resetState();
    const sqlMock = createTxSqlMock();

    const req = new Request("http://localhost/api/shifts/swaps/1/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "No longer needed" }),
    });

    const res = await handleRejectSwap(req, { params: Promise.resolve({ id: "1" }) }, {
      getSessionUser: async () => staffUser, // Requester
      sql: sqlMock,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.swap.status, "cancelled");
  });
});
