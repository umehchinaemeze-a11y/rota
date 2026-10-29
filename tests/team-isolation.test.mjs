import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Direct import of team-scoped authorization helper via Node native type stripping
import { canManageTeamShiftRecord, isManagerRole } from "../lib/permissions.ts";

// Direct import of migration transaction logic
import {
  executeMigrationTransaction,
  sanitizeErrorMessage,
  isMigrationRunMode,
  parseMigrationArgs,
  DEMO_TEAM_CONFIG,
} from "../scripts/migrate-team-isolation.mjs";

// Direct import of preflight inspection logic
import {
  executePreflightInspection,
  parsePreflightArgs,
  isPreflightRunMode,
  sanitizeErrorMessage as sanitizePreflightErrorMessage,
  sanitizeTargetHost,
  extractHostname,
  normalizeHostname,
  isValidHostname,
  isValidDatabaseIdentifier,
  isValidEndpointIdentifier,
  categorizeError,
  formatSafeCliError,
  assertReadOnlyQuery,
  EXPECTED_DEMO_EMAILS,
  parseEnvContent,
  resolveEnvLocalPath,
  loadDatabaseUrlFromEnv,
} from "../scripts/preflight-migration.mjs";
import fs from "node:fs";

describe("Team Isolation — Cross-Team Denial Enforcement", () => {
  const employeeTeamA = {
    userId: 1,
    name: "Amara Okafor",
    role: "Front Desk",
    teamId: "team-alpha",
  };

  const supervisorTeamA = {
    userId: 5,
    name: "Chika Nwosu",
    role: "Supervisor",
    teamId: "team-alpha",
  };

  const operationsTeamA = {
    userId: 3,
    name: "Daniel James",
    role: "Operations",
    teamId: "team-alpha",
  };

  const adminTeamA = {
    userId: 9,
    name: "Admin User",
    role: "Admin",
    teamId: "team-alpha",
  };

  const ownerTeamA = {
    userId: 25,
    name: "Owner User",
    role: "Owner",
    teamId: "team-alpha",
  };

  const managerTeamA = {
    userId: 26,
    name: "Manager User",
    role: "Manager",
    teamId: "team-alpha",
  };

  const staffTeamA = {
    userId: 27,
    name: "Staff User",
    role: "Staff",
    teamId: "team-alpha",
  };

  const shiftTeamB = {
    id: 101,
    user_id: 1, // Same user_id, but belongs to another organization/team
    employee_name: "Amara Okafor",
    teamId: "team-beta",
  };

  const otherShiftTeamB = {
    id: 102,
    user_id: 20,
    employee_name: "External Worker",
    teamId: "team-beta",
  };

  it("denies an ordinary employee access to a shift in another team even if user_id matches", () => {
    assert.equal(
      canManageTeamShiftRecord(employeeTeamA, shiftTeamB),
      false,
      "Cross-team access must be denied even if user_id matches"
    );
  });

  it("denies Supervisor access to a shift in another team (no cross-tenant leakage)", () => {
    assert.equal(
      canManageTeamShiftRecord(supervisorTeamA, otherShiftTeamB),
      false,
      "Supervisors must never manage shifts belonging to another team"
    );
  });

  it("denies Operations Manager access to a shift in another team", () => {
    assert.equal(
      canManageTeamShiftRecord(operationsTeamA, otherShiftTeamB),
      false,
      "Operations role must be strictly bounded to authorized team"
    );
  });

  it("denies Admin access to a shift in another team", () => {
    assert.equal(
      canManageTeamShiftRecord(adminTeamA, otherShiftTeamB),
      false,
      "Admins must be strictly isolated to their own team context"
    );
  });

  it("denies Owner access to a shift in another team (strict tenant isolation)", () => {
    assert.equal(
      canManageTeamShiftRecord(ownerTeamA, otherShiftTeamB),
      false,
      "Owners must be strictly isolated to their own team context"
    );
  });

  it("denies Manager access to a shift in another team", () => {
    assert.equal(
      canManageTeamShiftRecord(managerTeamA, otherShiftTeamB),
      false,
      "Managers must be strictly isolated to their own team context"
    );
  });

  it("denies Staff access to a shift in another team even if user_id matches", () => {
    const staffShiftTeamB = {
      id: 105,
      user_id: 27,
      employee_name: "Staff User",
      teamId: "team-beta",
    };
    assert.equal(
      canManageTeamShiftRecord(staffTeamA, staffShiftTeamB),
      false,
      "Staff cannot access shifts belonging to another team even with matching user_id"
    );
  });

  it("denies access when team identifiers differ by casing or whitespace variations", () => {
    const user = { userId: 1, role: "Supervisor", teamId: "TEAM-ALPHA" };
    const shift = { id: 10, user_id: 1, teamId: "team-alpha" };
    // Case sensitivity: "TEAM-ALPHA" vs "team-alpha"
    assert.equal(canManageTeamShiftRecord(user, shift), false);
  });
});

describe("Team Isolation — Same-Team Authorization Rules", () => {
  const employeeAlpha1 = {
    userId: 1,
    name: "Amara Okafor",
    role: "Front Desk",
    teamId: "team-alpha",
  };

  const employeeAlpha2 = {
    userId: 2,
    name: "Sarah Bello",
    role: "Customer Support",
    teamId: "team-alpha",
  };

  const supervisorAlpha = {
    userId: 5,
    name: "Chika Nwosu",
    role: "Supervisor",
    teamId: "team-alpha",
  };

  const operationsAlpha = {
    userId: 3,
    name: "Daniel James",
    role: "Operations",
    teamId: "team-alpha",
  };

  const shiftOwnAlpha = {
    id: 10,
    user_id: 1,
    employee_name: "Amara Okafor",
    teamId: "team-alpha",
  };

  const shiftOtherAlpha = {
    id: 11,
    user_id: 2,
    employee_name: "Sarah Bello",
    teamId: "team-alpha",
  };

  const shiftUnassignedAlpha = {
    id: 12,
    user_id: null,
    employee_name: "Unassigned Shift",
    teamId: "team-alpha",
  };

  const ownerAlpha = {
    userId: 35,
    name: "Alpha Owner",
    role: "Owner",
    teamId: "team-alpha",
  };

  const managerAlpha = {
    userId: 36,
    name: "Alpha Manager",
    role: "Manager",
    teamId: "team-alpha",
  };

  const adminAlpha = {
    userId: 37,
    name: "Alpha Admin",
    role: "Admin",
    teamId: "team-alpha",
  };

  const staffAlpha = {
    userId: 38,
    name: "Alpha Staff",
    role: "Staff",
    teamId: "team-alpha",
  };

  const shiftStaffOwn = {
    id: 15,
    user_id: 38,
    employee_name: "Alpha Staff",
    teamId: "team-alpha",
  };

  it("allows an ordinary employee to manage their own shift within their team", () => {
    assert.equal(canManageTeamShiftRecord(employeeAlpha1, shiftOwnAlpha), true);
  });

  it("denies an ordinary employee from managing another colleague's shift within the same team", () => {
    assert.equal(canManageTeamShiftRecord(employeeAlpha1, shiftOtherAlpha), false);
  });

  it("prohibits ordinary employees from claiming unassigned shifts (user_id IS NULL) within the same team", () => {
    assert.equal(canManageTeamShiftRecord(employeeAlpha1, shiftUnassignedAlpha), false);
  });

  it("allows a Supervisor to manage any shift within their authorized team, including colleague shifts", () => {
    assert.equal(canManageTeamShiftRecord(supervisorAlpha, shiftOwnAlpha), true);
    assert.equal(canManageTeamShiftRecord(supervisorAlpha, shiftOtherAlpha), true);
    assert.equal(canManageTeamShiftRecord(supervisorAlpha, shiftUnassignedAlpha), true);
  });

  it("allows an Operations manager to manage any shift within their authorized team", () => {
    assert.equal(canManageTeamShiftRecord(operationsAlpha, shiftOwnAlpha), true);
    assert.equal(canManageTeamShiftRecord(operationsAlpha, shiftOtherAlpha), true);
    assert.equal(canManageTeamShiftRecord(operationsAlpha, shiftUnassignedAlpha), true);
  });

  it("allows an Owner to manage any shift within their authorized team, including colleague shifts", () => {
    assert.equal(canManageTeamShiftRecord(ownerAlpha, shiftOwnAlpha), true);
    assert.equal(canManageTeamShiftRecord(ownerAlpha, shiftOtherAlpha), true);
    assert.equal(canManageTeamShiftRecord(ownerAlpha, shiftUnassignedAlpha), true);
  });

  it("allows a Manager to manage any shift within their authorized team, including colleague shifts", () => {
    assert.equal(canManageTeamShiftRecord(managerAlpha, shiftOwnAlpha), true);
    assert.equal(canManageTeamShiftRecord(managerAlpha, shiftOtherAlpha), true);
    assert.equal(canManageTeamShiftRecord(managerAlpha, shiftUnassignedAlpha), true);
  });

  it("allows an Admin to manage any shift within their authorized team", () => {
    assert.equal(canManageTeamShiftRecord(adminAlpha, shiftOwnAlpha), true);
    assert.equal(canManageTeamShiftRecord(adminAlpha, shiftOtherAlpha), true);
    assert.equal(canManageTeamShiftRecord(adminAlpha, shiftUnassignedAlpha), true);
  });

  it("allows Staff to manage their own shift within their team, but denies colleague and unassigned shifts", () => {
    assert.equal(canManageTeamShiftRecord(staffAlpha, shiftStaffOwn), true);
    assert.equal(canManageTeamShiftRecord(staffAlpha, shiftOtherAlpha), false);
    assert.equal(canManageTeamShiftRecord(staffAlpha, shiftUnassignedAlpha), false);
  });

  it("correctly evaluates numeric team IDs within the same team", () => {
    const userNumeric = { userId: 10, role: "Front Desk", teamId: 42 };
    const shiftNumeric = { id: 50, user_id: 10, teamId: 42 };
    const shiftDifferentNumeric = { id: 51, user_id: 10, teamId: 43 };

    assert.equal(canManageTeamShiftRecord(userNumeric, shiftNumeric), true);
    assert.equal(canManageTeamShiftRecord(userNumeric, shiftDifferentNumeric), false);
  });
});

describe("Team Isolation — Missing, Null, and Malformed Identifier Guards", () => {
  const validUser = {
    userId: 1,
    name: "Amara Okafor",
    role: "Front Desk",
    teamId: "team-alpha",
  };

  const validShift = {
    id: 10,
    user_id: 1,
    teamId: "team-alpha",
  };

  it("rejects when sessionUser or shiftRecord is null or undefined", () => {
    assert.equal(canManageTeamShiftRecord(null, validShift), false);
    assert.equal(canManageTeamShiftRecord(undefined, validShift), false);
    assert.equal(canManageTeamShiftRecord(validUser, null), false);
    assert.equal(canManageTeamShiftRecord(validUser, undefined), false);
  });

  it("rejects when user teamId is null, undefined, or empty string", () => {
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: null }, validShift), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: undefined }, validShift), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: "" }, validShift), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: "   " }, validShift), false);
  });

  it("rejects when shiftRecord teamId is null, undefined, or empty string", () => {
    assert.equal(canManageTeamShiftRecord(validUser, { ...validShift, teamId: null }), false);
    assert.equal(canManageTeamShiftRecord(validUser, { ...validShift, teamId: undefined }), false);
    assert.equal(canManageTeamShiftRecord(validUser, { ...validShift, teamId: "" }), false);
    assert.equal(canManageTeamShiftRecord(validUser, { ...validShift, teamId: "   " }), false);
  });

  it("rejects non-positive numeric team IDs (zero or negative numbers)", () => {
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: 0 }, { ...validShift, teamId: 0 }), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: -1 }, { ...validShift, teamId: -1 }), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: 1.5 }, { ...validShift, teamId: 1.5 }), false);
  });

  it("rejects invalid or non-string/non-number teamId types (objects, booleans, arrays)", () => {
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: true }, { ...validShift, teamId: true }), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: {} }, { ...validShift, teamId: {} }), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, teamId: ["team-alpha"] }, validShift), false);
  });

  it("rejects invalid user IDs or missing role", () => {
    assert.equal(canManageTeamShiftRecord({ ...validUser, userId: 0 }, validShift), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, userId: -5 }, validShift), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, userId: "1" }, validShift), false);
    assert.equal(canManageTeamShiftRecord({ ...validUser, role: null }, validShift), false);
  });
});

describe("Team Isolation — Simulated Shift Route Handlers & Endpoint Isolation", () => {
  // Test fixture setup mirroring Rota PostgreSQL schema & team-isolation model
  const users = [
    { id: 1, name: "Amara Okafor", email: "amara@example.com" },
    { id: 2, name: "Sarah Bello", email: "sarah@example.com" },
    { id: 3, name: "Daniel James", email: "daniel@example.com" },
    { id: 5, name: "Chika Nwosu", email: "chika@example.com" },
    { id: 6, name: "Alice Admin", email: "alice@example.com" },
    { id: 7, name: "No Team User", email: "noteam@example.com" },
    { id: 8, name: "Bob Beta", email: "bob@beta.com" },
    { id: 9, name: "Boss Beta", email: "boss@beta.com" },
    { id: 10, name: "Jordan Lee", email: "jordan1@example.com" },
    { id: 11, name: "Jordan Lee", email: "jordan2@example.com" },
    { id: 12, name: "Sarah Bello", email: "sarah.beta@example.com" },
    { id: 20, name: "Owner User", email: "owner@example.com" },
    { id: 21, name: "Manager User", email: "manager@example.com" },
  ];

  const memberships = [
    { user_id: 1, team_id: 1, role: "Staff" },
    { user_id: 2, team_id: 1, role: "Staff" },
    { user_id: 3, team_id: 1, role: "Operations" },
    { user_id: 5, team_id: 1, role: "Supervisor" },
    { user_id: 6, team_id: 1, role: "Admin" },
    { user_id: 8, team_id: 2, role: "Staff" },
    { user_id: 9, team_id: 2, role: "Supervisor" },
    { user_id: 10, team_id: 1, role: "Staff" },
    { user_id: 11, team_id: 1, role: "Staff" },
    { user_id: 12, team_id: 2, role: "Staff" },
    { user_id: 20, team_id: 1, role: "Owner" },
    { user_id: 21, team_id: 1, role: "Manager" },
  ];

  const createInitialShifts = () => [
    { id: 101, employee_name: "Amara Okafor", role: "Staff", shift_day: "2026-11-01", user_id: 1, team_id: 1 },
    { id: 102, employee_name: "Sarah Bello", role: "Staff", shift_day: "2026-11-02", user_id: 2, team_id: 1 },
    { id: 201, employee_name: "Bob Beta", role: "Staff", shift_day: "2026-11-01", user_id: 8, team_id: 2 },
    { id: 202, employee_name: "Boss Beta", role: "Supervisor", shift_day: "2026-11-02", user_id: 9, team_id: 2 },
    { id: 301, employee_name: "Unassigned Shift", role: "Staff", shift_day: "2026-11-03", user_id: null, team_id: null },
  ];

  // Route simulation helpers adhering to app/api/shifts/route.ts and app/api/shifts/[id]/route.ts
  function simulateGetCollection(sessionUser, shifts) {
    if (!sessionUser) {
      return { status: 401, error: "Authentication required. Please sign in to view shifts." };
    }
    if (!sessionUser.teamId || typeof sessionUser.teamId !== "number" || sessionUser.teamId <= 0) {
      return { status: 403, error: "Access denied. You are not assigned to an active team." };
    }
    const data = shifts.filter((s) => s.team_id === sessionUser.teamId);
    return { status: 200, data };
  }

  function simulateGetDetail(sessionUser, shifts, rawId) {
    if (!sessionUser) {
      return { status: 401, error: "Authentication required. Please sign in to view shift details." };
    }
    if (!sessionUser.teamId || typeof sessionUser.teamId !== "number" || sessionUser.teamId <= 0) {
      return { status: 403, error: "Access denied. You are not assigned to an active team." };
    }
    const numericId = parseInt(rawId, 10);
    if (Number.isNaN(numericId) || numericId <= 0) {
      return { status: 400, error: "Invalid shift ID." };
    }
    const match = shifts.find((s) => s.id === numericId && s.team_id === sessionUser.teamId);
    if (!match) {
      return { status: 404, error: "Shift not found." };
    }
    return { status: 200, data: match };
  }

  function simulatePost(sessionUser, shifts, body) {
    if (!sessionUser) {
      return { status: 401, error: "Authentication required. Please sign in to create shifts." };
    }
    if (!sessionUser.teamId || typeof sessionUser.teamId !== "number" || sessionUser.teamId <= 0) {
      return { status: 403, error: "Access denied. You are not assigned to an active team." };
    }
    if (!body || typeof body !== "object") {
      return { status: 400, error: "A valid shift date and role are required." };
    }
    const shiftDay = typeof body.shiftDay === "string" ? body.shiftDay.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDay)) {
      return { status: 400, error: "A valid shift date (YYYY-MM-DD) is required." };
    }

    const isManager = isManagerRole(sessionUser.role);

    let finalEmployeeName = sessionUser.name;
    let finalRole = sessionUser.role;
    let finalUserId = sessionUser.userId;

    if (isManager) {
      const inputName = typeof body.employeeName === "string" ? body.employeeName.trim() : "";
      const inputRole = typeof body.role === "string" ? body.role.trim() : "";
      if (inputName) {
        // Verify target employee belongs to the same authorized team
        const matchingMembers = memberships.filter((m) => {
          if (m.team_id !== sessionUser.teamId) return false;
          const u = users.find((user) => user.id === m.user_id);
          return u && u.name.trim().toLowerCase() === inputName.toLowerCase();
        });

        if (matchingMembers.length === 0) {
          return {
            status: 400,
            error: "Assigned employee must be an active member of your team.",
          };
        }

        if (matchingMembers.length > 1) {
          return {
            status: 400,
            error: "Multiple team members share this name. Unable to assign shift unambiguously.",
          };
        }

        const targetMember = matchingMembers[0];
        const targetUser = users.find((user) => user.id === targetMember.user_id);
        finalUserId = targetMember.user_id;
        finalEmployeeName = targetUser ? targetUser.name : inputName;
        finalRole = inputRole || targetMember.role;
      } else if (inputRole) {
        finalRole = inputRole;
      }
    }

    // Always assign team_id server-side from sessionUser.teamId
    const newShift = {
      id: shifts.length > 0 ? Math.max(...shifts.map((s) => s.id)) + 1 : 1,
      employee_name: finalEmployeeName,
      role: finalRole,
      shift_day: shiftDay,
      user_id: finalUserId,
      team_id: sessionUser.teamId,
    };
    shifts.push(newShift);
    return { status: 201, data: newShift };
  }

  function simulatePut(sessionUser, shifts, rawId, body) {
    if (!sessionUser) {
      return { status: 401, error: "Authentication required. Please sign in to edit shifts." };
    }
    if (!sessionUser.teamId || typeof sessionUser.teamId !== "number" || sessionUser.teamId <= 0) {
      return { status: 403, error: "Access denied. You are not assigned to an active team." };
    }
    const numericId = parseInt(rawId, 10);
    if (Number.isNaN(numericId) || numericId <= 0) {
      return { status: 400, error: "Invalid shift ID." };
    }
    const role = typeof body?.role === "string" ? body.role.trim() : "";
    const shiftDay = typeof body?.shiftDay === "string" ? body.shiftDay.trim() : "";
    if (!role || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDay)) {
      return { status: 400, error: "Role and a valid shift date (YYYY-MM-DD) are required." };
    }

    // Query scoped by both id and team_id; cross-team shifts return 404
    const existing = shifts.find((s) => s.id === numericId && s.team_id === sessionUser.teamId);
    if (!existing) {
      return { status: 404, error: "Shift not found." };
    }

    if (!canManageTeamShiftRecord(sessionUser, existing)) {
      return {
        status: 403,
        error: "Unauthorized: You can only edit shifts assigned to your account within your team unless you hold a management role.",
      };
    }

    const isManager = isManagerRole(sessionUser.role);

    let updatedEmployeeName = existing.employee_name;
    let updatedUserId = existing.user_id;

    if (isManager) {
      const inputName = typeof body.employeeName === "string" ? body.employeeName.trim() : "";
      if (inputName) {
        const matchingMembers = memberships.filter((m) => {
          if (m.team_id !== sessionUser.teamId) return false;
          const u = users.find((user) => user.id === m.user_id);
          return u && u.name.trim().toLowerCase() === inputName.toLowerCase();
        });

        if (matchingMembers.length === 0) {
          return {
            status: 400,
            error: "Assigned employee must be an active member of your team.",
          };
        }

        if (matchingMembers.length > 1) {
          return {
            status: 400,
            error: "Multiple team members share this name. Unable to assign shift unambiguously.",
          };
        }

        const targetMember = matchingMembers[0];
        const targetUser = users.find((user) => user.id === targetMember.user_id);
        updatedUserId = targetMember.user_id;
        updatedEmployeeName = targetUser ? targetUser.name : inputName;
      }
    } else {
      updatedUserId = sessionUser.userId;
      updatedEmployeeName = sessionUser.name;
    }

    existing.employee_name = updatedEmployeeName;
    existing.role = role;
    existing.shift_day = shiftDay;
    existing.user_id = updatedUserId;
    return { status: 200, data: { ...existing } };
  }

  function simulateDelete(sessionUser, shifts, rawId) {
    if (!sessionUser) {
      return { status: 401, error: "Authentication required. Please sign in to delete shifts." };
    }
    if (!sessionUser.teamId || typeof sessionUser.teamId !== "number" || sessionUser.teamId <= 0) {
      return { status: 403, error: "Access denied. You are not assigned to an active team." };
    }
    const numericId = parseInt(rawId, 10);
    if (Number.isNaN(numericId) || numericId <= 0) {
      return { status: 400, error: "Invalid shift ID." };
    }

    // Query scoped by both id and team_id; cross-team shifts return 404
    const idx = shifts.findIndex((s) => s.id === numericId && s.team_id === sessionUser.teamId);
    if (idx === -1) {
      return { status: 404, error: "Shift not found." };
    }

    const existing = shifts[idx];
    if (!canManageTeamShiftRecord(sessionUser, existing)) {
      return {
        status: 403,
        error: "Unauthorized: You can only delete shifts assigned to your account within your team unless you hold a management role.",
      };
    }

    shifts.splice(idx, 1);
    return { status: 200, success: true, message: "Shift permanently removed.", id: numericId };
  }

  // Session users for testing
  const userTeam1StaffAmara = { userId: 1, name: "Amara Okafor", role: "Staff", teamId: 1 };
  const userTeam1StaffSarah = { userId: 2, name: "Sarah Bello", role: "Staff", teamId: 1 };
  const userTeam1SupervisorChika = { userId: 5, name: "Chika Nwosu", role: "Supervisor", teamId: 1 };
  const userTeam1OperationsDaniel = { userId: 3, name: "Daniel James", role: "Operations", teamId: 1 };
  const userTeam1AdminAlice = { userId: 6, name: "Alice Admin", role: "Admin", teamId: 1 };
  const userTeam1Owner = { userId: 20, name: "Owner User", role: "Owner", teamId: 1 };
  const userTeam1Manager = { userId: 21, name: "Manager User", role: "Manager", teamId: 1 };
  const userNoTeam = { userId: 7, name: "No Team User", role: "Staff", teamId: null };
  const userTeam2StaffBob = { userId: 8, name: "Bob Beta", role: "Staff", teamId: 2 };
  const userTeam2SupervisorBoss = { userId: 9, name: "Boss Beta", role: "Supervisor", teamId: 2 };

  it("returns 401 Unauthorized for unauthenticated requests across all shift endpoints", () => {
    const shifts = createInitialShifts();
    assert.equal(simulateGetCollection(null, shifts).status, 401);
    assert.equal(simulateGetDetail(null, shifts, "101").status, 401);
    assert.equal(simulatePost(null, shifts, { role: "Staff", shiftDay: "2026-11-10" }).status, 401);
    assert.equal(simulatePut(null, shifts, "101", { role: "Staff", shiftDay: "2026-11-10" }).status, 401);
    assert.equal(simulateDelete(null, shifts, "101").status, 401);
  });

  it("returns 403 Forbidden for authenticated users without active team membership across all endpoints", () => {
    const shifts = createInitialShifts();
    assert.equal(simulateGetCollection(userNoTeam, shifts).status, 403);
    assert.equal(simulateGetDetail(userNoTeam, shifts, "101").status, 403);
    assert.equal(simulatePost(userNoTeam, shifts, { role: "Staff", shiftDay: "2026-11-10" }).status, 403);
    assert.equal(simulatePut(userNoTeam, shifts, "101", { role: "Staff", shiftDay: "2026-11-10" }).status, 403);
    assert.equal(simulateDelete(userNoTeam, shifts, "101").status, 403);
  });

  it("returns 403 Forbidden for users with malformed, zero, or negative team IDs", () => {
    const shifts = createInitialShifts();
    const badUsers = [
      { ...userTeam1StaffAmara, teamId: 0 },
      { ...userTeam1StaffAmara, teamId: -1 },
      { ...userTeam1StaffAmara, teamId: "alpha" },
      { ...userTeam1StaffAmara, teamId: undefined },
    ];
    for (const badUser of badUsers) {
      assert.equal(simulateGetCollection(badUser, shifts).status, 403);
      assert.equal(simulateGetDetail(badUser, shifts, "101").status, 403);
      assert.equal(simulatePost(badUser, shifts, { role: "Staff", shiftDay: "2026-11-10" }).status, 403);
      assert.equal(simulatePut(badUser, shifts, "101", { role: "Staff", shiftDay: "2026-11-10" }).status, 403);
      assert.equal(simulateDelete(badUser, shifts, "101").status, 403);
    }
  });

  it("isolates GET collection results strictly between Team A and Team B", () => {
    const shifts = createInitialShifts();

    const team1Result = simulateGetCollection(userTeam1StaffAmara, shifts);
    assert.equal(team1Result.status, 200);
    assert.equal(team1Result.data.length, 2);
    assert.ok(team1Result.data.every((s) => s.team_id === 1));
    assert.ok(team1Result.data.some((s) => s.id === 101));
    assert.ok(team1Result.data.some((s) => s.id === 102));
    assert.ok(!team1Result.data.some((s) => s.id === 201), "Team 1 must never see Team 2 shifts");

    const team2Result = simulateGetCollection(userTeam2StaffBob, shifts);
    assert.equal(team2Result.status, 200);
    assert.equal(team2Result.data.length, 2);
    assert.ok(team2Result.data.every((s) => s.team_id === 2));
    assert.ok(!team2Result.data.some((s) => s.id === 101), "Team 2 must never see Team 1 shifts");
  });

  it("returns 404 for GET detail of another team's shift (no existence leak)", () => {
    const shifts = createInitialShifts();
    // Shift 201 exists in Team 2. Team 1 user requests it:
    const res = simulateGetDetail(userTeam1StaffAmara, shifts, "201");
    assert.equal(res.status, 404, "Cross-team GET detail must return 404 to avoid leaking shift existence");
    assert.equal(res.error, "Shift not found.");
  });

  it("returns 404 for cross-team PUT and DELETE attempts (never 403, preventing ID scanning)", () => {
    const shifts = createInitialShifts();
    // Team 1 supervisor attempts to edit Shift 201 (Team 2)
    const putRes = simulatePut(userTeam1SupervisorChika, shifts, "201", {
      role: "Staff",
      shiftDay: "2026-11-10",
    });
    assert.equal(putRes.status, 404, "Cross-team PUT must return 404");

    // Team 1 admin attempts to delete Shift 201 (Team 2)
    const delRes = simulateDelete(userTeam1AdminAlice, shifts, "201");
    assert.equal(delRes.status, 404, "Cross-team DELETE must return 404");
  });

  it("allows a manager to assign shifts to a same-team employee in POST and PUT", () => {
    const shifts = createInitialShifts();

    // 1. POST: Supervisor Chika creates a shift explicitly assigned to Sarah Bello (Team 1)
    const postRes = simulatePost(userTeam1SupervisorChika, shifts, {
      employeeName: "Sarah Bello",
      role: "Staff",
      shiftDay: "2026-11-20",
    });
    assert.equal(postRes.status, 201);
    assert.equal(postRes.data.user_id, 2);
    assert.equal(postRes.data.employee_name, "Sarah Bello");
    assert.equal(postRes.data.team_id, 1);

    // 2. PUT: Supervisor Chika reassigns Amara's shift (101) to Sarah Bello
    const putRes = simulatePut(userTeam1SupervisorChika, shifts, "101", {
      employeeName: "Sarah Bello",
      role: "Senior Staff",
      shiftDay: "2026-11-21",
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.user_id, 2);
    assert.equal(putRes.data.employee_name, "Sarah Bello");
    assert.equal(putRes.data.role, "Senior Staff");
    assert.equal(putRes.data.shift_day, "2026-11-21");
  });

  it("consistently rejects cross-team employee assignment with HTTP 400 in both POST and PUT", () => {
    const shifts = createInitialShifts();

    // POST: Team 1 supervisor attempts to assign shift to Bob Beta (who belongs to Team 2)
    const postRes = simulatePost(userTeam1SupervisorChika, shifts, {
      employeeName: "Bob Beta",
      role: "Staff",
      shiftDay: "2026-11-15",
      teamId: 2,
    });
    assert.equal(postRes.status, 400);
    assert.equal(postRes.error, "Assigned employee must be an active member of your team.");

    // PUT: Team 1 supervisor attempts to reassign Shift 101 to Bob Beta (Team 2)
    const putRes = simulatePut(userTeam1SupervisorChika, shifts, "101", {
      employeeName: "Bob Beta",
      role: "Staff",
      shiftDay: "2026-11-15",
    });
    assert.equal(putRes.status, 400);
    assert.equal(putRes.error, "Assigned employee must be an active member of your team.");

    // Verify shift 101 was not mutated or corrupted
    const shift101 = shifts.find((s) => s.id === 101);
    assert.equal(shift101.user_id, 1);
    assert.equal(shift101.employee_name, "Amara Okafor");
  });

  it("consistently rejects unknown employee assignment with HTTP 400 in both POST and PUT", () => {
    const shifts = createInitialShifts();

    // POST: Manager provides a name not found in the team
    const postRes = simulatePost(userTeam1SupervisorChika, shifts, {
      employeeName: "Unknown Ghost Worker",
      role: "Staff",
      shiftDay: "2026-11-15",
    });
    assert.equal(postRes.status, 400);
    assert.equal(postRes.error, "Assigned employee must be an active member of your team.");

    // PUT: Manager provides a name not found in the team
    const putRes = simulatePut(userTeam1SupervisorChika, shifts, "101", {
      employeeName: "Unknown Ghost Worker",
      role: "Staff",
      shiftDay: "2026-11-15",
    });
    assert.equal(putRes.status, 400);
    assert.equal(putRes.error, "Assigned employee must be an active member of your team.");

    // Verify shift 101 remained unchanged
    const shift101 = shifts.find((s) => s.id === 101);
    assert.equal(shift101.user_id, 1);
    assert.equal(shift101.employee_name, "Amara Okafor");
  });

  it("consistently rejects ambiguous duplicate employee names with HTTP 400 in both POST and PUT", () => {
    const shifts = createInitialShifts();

    // POST: Team 1 manager attempts to schedule for "Jordan Lee" (two members in Team 1 share this name: user 10 and 11)
    const postRes = simulatePost(userTeam1SupervisorChika, shifts, {
      employeeName: "Jordan Lee",
      role: "Staff",
      shiftDay: "2026-11-15",
    });
    assert.equal(postRes.status, 400);
    assert.equal(
      postRes.error,
      "Multiple team members share this name. Unable to assign shift unambiguously."
    );

    // PUT: Team 1 manager attempts to reassign Shift 101 to "Jordan Lee"
    const putRes = simulatePut(userTeam1SupervisorChika, shifts, "101", {
      employeeName: "Jordan Lee",
      role: "Staff",
      shiftDay: "2026-11-15",
    });
    assert.equal(putRes.status, 400);
    assert.equal(
      putRes.error,
      "Multiple team members share this name. Unable to assign shift unambiguously."
    );

    // Verify Shift 101 was NOT modified or arbitrarily assigned to user 10 or 11
    const shift101 = shifts.find((s) => s.id === 101);
    assert.equal(shift101.user_id, 1);
    assert.equal(shift101.employee_name, "Amara Okafor");
  });

  it("permits assignment when employee name is unique within the team even if shared across teams", () => {
    const shifts = createInitialShifts();

    // Sarah Bello exists in Team 1 (user 2) AND in Team 2 (user 12).
    // Within Team 1, Sarah Bello is uniquely resolvable.
    const team1Post = simulatePost(userTeam1SupervisorChika, shifts, {
      employeeName: "Sarah Bello",
      role: "Staff",
      shiftDay: "2026-11-16",
    });
    assert.equal(team1Post.status, 201);
    assert.equal(team1Post.data.user_id, 2, "Team 1 manager must assign to Team 1 Sarah Bello");
    assert.equal(team1Post.data.team_id, 1);

    // Within Team 2, Sarah Bello is also uniquely resolvable to user 12.
    const team2Post = simulatePost(userTeam2SupervisorBoss, shifts, {
      employeeName: "Sarah Bello",
      role: "Staff",
      shiftDay: "2026-11-16",
    });
    assert.equal(team2Post.status, 201);
    assert.equal(team2Post.data.user_id, 12, "Team 2 manager must assign to Team 2 Sarah Bello");
    assert.equal(team2Post.data.team_id, 2);
  });

  it("preserves existing assignment when manager updates role or date without employeeName", () => {
    const shifts = createInitialShifts();

    // Supervisor updates Shift 101 (assigned to Amara, user_id = 1) without passing employeeName
    const putRes = simulatePut(userTeam1SupervisorChika, shifts, "101", {
      role: "Floor Lead",
      shiftDay: "2026-11-25",
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.user_id, 1, "Must preserve existing user_id");
    assert.equal(putRes.data.employee_name, "Amara Okafor", "Must preserve existing employee_name");
    assert.equal(putRes.data.role, "Floor Lead");
  });

  it("forces non-manager employee to retain self-assignment when updating own shift", () => {
    const shifts = createInitialShifts();

    // Staff Amara tries to change employeeName to Sarah Bello on her own shift
    const putRes = simulatePut(userTeam1StaffAmara, shifts, "101", {
      employeeName: "Sarah Bello",
      role: "Front Desk",
      shiftDay: "2026-11-05",
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.user_id, 1, "Non-manager must remain assigned to self");
    assert.equal(putRes.data.employee_name, "Amara Okafor", "Non-manager name cannot be spoofed");
  });

  it("allows same-team employee to manage own shift, but denies managing a teammate's shift", () => {
    const shifts = createInitialShifts();

    // Amara updates her own shift (101) -> 200
    const ownPut = simulatePut(userTeam1StaffAmara, shifts, "101", {
      role: "Front Desk",
      shiftDay: "2026-11-05",
    });
    assert.equal(ownPut.status, 200);
    assert.equal(ownPut.data.role, "Front Desk");

    // Amara tries to update Sarah's shift (102) -> 403
    const teammatePut = simulatePut(userTeam1StaffAmara, shifts, "102", {
      role: "Front Desk",
      shiftDay: "2026-11-05",
    });
    assert.equal(teammatePut.status, 403);

    // Amara tries to delete Sarah's shift (102) -> 403
    const teammateDel = simulateDelete(userTeam1StaffAmara, shifts, "102");
    assert.equal(teammateDel.status, 403);
  });

  it("allows same-team Supervisor, Operations, and Admin to manage any shift within their team (simulated)", () => {
    const shifts = createInitialShifts();

    // Supervisor Chika updates Sarah's shift (102) -> 200
    const supPut = simulatePut(userTeam1SupervisorChika, shifts, "102", {
      role: "Senior Staff",
      shiftDay: "2026-11-05",
    });
    assert.equal(supPut.status, 200);

    // Operations Daniel deletes Amara's shift (101) -> 200
    const opsDel = simulateDelete(userTeam1OperationsDaniel, shifts, "101");
    assert.equal(opsDel.status, 200);
    assert.equal(opsDel.success, true);

    // Admin Alice updates Sarah's shift (102) -> 200
    const adminPut = simulatePut(userTeam1AdminAlice, shifts, "102", {
      role: "Lead Staff",
      shiftDay: "2026-11-06",
    });
    assert.equal(adminPut.status, 200);
  });

  it("allows same-team Owner to create and reassign shifts for team members (simulated)", () => {
    const shifts = createInitialShifts();

    // Owner creates shift assigned to Sarah Bello (Team 1, user 2)
    const postRes = simulatePost(userTeam1Owner, shifts, {
      employeeName: "Sarah Bello",
      role: "Front Desk",
      shiftDay: "2026-11-12",
    });
    assert.equal(postRes.status, 201);
    assert.equal(postRes.data.user_id, 2);
    assert.equal(postRes.data.employee_name, "Sarah Bello");
    assert.equal(postRes.data.team_id, 1);

    // Owner reassigns Shift 101 to Sarah Bello
    const putRes = simulatePut(userTeam1Owner, shifts, "101", {
      employeeName: "Sarah Bello",
      role: "Front Desk",
      shiftDay: "2026-11-13",
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.user_id, 2);
    assert.equal(putRes.data.employee_name, "Sarah Bello");
  });

  it("allows same-team Manager to create and reassign shifts for team members (simulated)", () => {
    const shifts = createInitialShifts();

    // Manager creates shift assigned to Amara Okafor (Team 1, user 1)
    const postRes = simulatePost(userTeam1Manager, shifts, {
      employeeName: "Amara Okafor",
      role: "Staff",
      shiftDay: "2026-11-14",
    });
    assert.equal(postRes.status, 201);
    assert.equal(postRes.data.user_id, 1);
    assert.equal(postRes.data.employee_name, "Amara Okafor");
    assert.equal(postRes.data.team_id, 1);

    // Manager reassigns Shift 102 to Amara Okafor
    const putRes = simulatePut(userTeam1Manager, shifts, "102", {
      employeeName: "Amara Okafor",
      role: "Lead Staff",
      shiftDay: "2026-11-15",
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.user_id, 1);
    assert.equal(putRes.data.employee_name, "Amara Okafor");
  });

  it("rejects Owner or Manager attempts to assign shifts to members of another team (simulated)", () => {
    const shifts = createInitialShifts();

    // Owner attempts to assign shift to Bob Beta (Team 2)
    const postRes = simulatePost(userTeam1Owner, shifts, {
      employeeName: "Bob Beta",
      role: "Staff",
      shiftDay: "2026-11-16",
    });
    assert.equal(postRes.status, 400);
    assert.equal(postRes.error, "Assigned employee must be an active member of your team.");

    // Manager attempts to reassign Shift 101 to Bob Beta (Team 2)
    const putRes = simulatePut(userTeam1Manager, shifts, "101", {
      employeeName: "Bob Beta",
      role: "Staff",
      shiftDay: "2026-11-16",
    });
    assert.equal(putRes.status, 400);
    assert.equal(putRes.error, "Assigned employee must be an active member of your team.");
  });

  it("prevents Staff from assigning shifts to colleagues in POST and forces self-assignment (simulated)", () => {
    const shifts = createInitialShifts();

    // Staff Amara attempts to schedule for Sarah Bello
    const postRes = simulatePost(userTeam1StaffAmara, shifts, {
      employeeName: "Sarah Bello",
      role: "Staff",
      shiftDay: "2026-11-17",
    });
    assert.equal(postRes.status, 201);
    // Non-manager role ignores employeeName in POST and assigns strictly to self
    assert.equal(postRes.data.user_id, 1);
    assert.equal(postRes.data.employee_name, "Amara Okafor");
  });

  it("fails closed for pre-migration unassigned shifts with team_id = null", () => {
    const shifts = createInitialShifts();
    // Shift 301 has team_id: null. Neither Team 1 nor Team 2 can access or delete it
    assert.equal(simulateGetDetail(userTeam1StaffAmara, shifts, "301").status, 404);
    assert.equal(simulateGetDetail(userTeam1SupervisorChika, shifts, "301").status, 404);
    assert.equal(simulatePut(userTeam1SupervisorChika, shifts, "301", { role: "Staff", shiftDay: "2026-11-07" }).status, 404);
    assert.equal(simulateDelete(userTeam1AdminAlice, shifts, "301").status, 404);
  });
});

describe("Team Isolation — Migration Transaction Safety & Rollback Mechanics", () => {
  function createMockClient({ failOnQuery, queryResponses = {} } = {}) {
    const executedQueries = [];
    let isClosed = false;

    return {
      executedQueries,
      get isClosed() {
        return isClosed;
      },
      async query(text, params = []) {
        const trimmed = text.trim();
        const normalized = text.replace(/\s+/g, " ").trim();
        executedQueries.push({ text: trimmed, params });

        if (failOnQuery && (trimmed.includes(failOnQuery) || normalized.includes(failOnQuery))) {
          throw new Error(`Simulated database failure during: ${failOnQuery}`);
        }

        if (normalized.includes("INSERT INTO teams")) {
          return queryResponses.insertTeam || { rows: [{ id: 42 }] };
        }
        if (normalized.includes("SELECT id FROM teams")) {
          return queryResponses.selectTeam || { rows: [{ id: 42 }] };
        }
        if (normalized.includes("FROM users")) {
          return (
            queryResponses.selectUsers || {
              rows: [
                { id: 10, email: "amara@rota.local", name: "Amara Okafor", role: "Front Desk" },
                { id: 11, email: "daniel@rota.local", name: "Daniel James", role: "Operations" },
                { id: 12, email: "sarah@rota.local", name: "Sarah Bello", role: "Customer Support" },
                { id: 13, email: "david@rota.local", name: "David Musa", role: "Front Desk" },
                { id: 14, email: "chika@rota.local", name: "Chika Nwosu", role: "Supervisor" },
              ],
            }
          );
        }
        if (normalized.includes("INSERT INTO team_memberships")) {
          return { rows: [] };
        }
        if (normalized.includes("UPDATE shifts")) {
          return { rowCount: 15 };
        }

        return { rows: [] };
      },
      async end() {
        isClosed = true;
        executedQueries.push({ text: "END" });
      },
    };
  }

  it("executes structural schema DDL without requiring demo accounts (default safe mode)", async () => {
    const client = createMockClient();
    const result = await executeMigrationTransaction(client);

    assert.equal(result.success, true);
    assert.equal(result.schemaApplied, true);
    assert.equal(result.demoSeeded, false);
    assert.equal(result.teamId, null);
    assert.equal(result.membersBackfilled, 0);
    assert.equal(result.shiftsBackfilled, 0);

    // Verify transaction ordering: BEGIN -> DDL statements -> COMMIT -> END
    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.equal(queryTexts[0], "BEGIN;");
    assert.ok(queryTexts.some((q) => q.includes("CREATE TABLE IF NOT EXISTS teams")));
    assert.ok(queryTexts.some((q) => q.includes("CREATE TABLE IF NOT EXISTS team_memberships")));
    assert.ok(queryTexts.some((q) => q.includes("ALTER TABLE shifts")));
    assert.ok(queryTexts.some((q) => q.includes("CREATE INDEX IF NOT EXISTS idx_shifts_team_id ON shifts(team_id)")));
    assert.equal(queryTexts[queryTexts.length - 2], "COMMIT;");
    assert.equal(queryTexts[queryTexts.length - 1], "END");
    assert.equal(client.isClosed, true);

    // Zero demo data mutations in default mode
    assert.ok(!queryTexts.some((q) => q.includes("INSERT INTO teams")), "Must not create demo team in default mode");
    assert.ok(!queryTexts.some((q) => q.includes("FROM users")), "Must not query users in default mode");
    assert.ok(!queryTexts.some((q) => q.includes("INSERT INTO team_memberships")), "Must not backfill memberships in default mode");
    assert.ok(!queryTexts.some((q) => q.includes("UPDATE shifts")), "Must not mutate shifts in default mode");
  });

  it("executes all DDL and backfill statements when seedDemoTeam is true", async () => {
    const client = createMockClient();
    const result = await executeMigrationTransaction(client, { seedDemoTeam: true });

    assert.equal(result.success, true);
    assert.equal(result.schemaApplied, true);
    assert.equal(result.demoSeeded, true);
    assert.equal(result.teamId, 42); // Resolved from slug, not assumed 1
    assert.equal(result.membersBackfilled, 5);
    assert.equal(result.shiftsBackfilled, 15);

    // Verify transaction ordering: BEGIN -> statements -> COMMIT -> END
    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.equal(queryTexts[0], "BEGIN;");
    assert.ok(queryTexts.some((q) => q.includes("CREATE TABLE IF NOT EXISTS teams")));
    assert.ok(queryTexts.some((q) => q.includes("CREATE TABLE IF NOT EXISTS team_memberships")));
    assert.ok(queryTexts.some((q) => q.includes("ALTER TABLE shifts")));
    assert.ok(queryTexts.some((q) => q.includes("CREATE INDEX IF NOT EXISTS idx_shifts_team_id ON shifts(team_id)")));
    assert.ok(queryTexts.some((q) => q.includes("INSERT INTO teams")));
    assert.ok(queryTexts.some((q) => q.includes("FROM users") && q.includes("SELECT id")));
    assert.ok(queryTexts.some((q) => q.includes("INSERT INTO team_memberships")));
    assert.ok(queryTexts.some((q) => q.includes("UPDATE shifts")));
    assert.equal(queryTexts[queryTexts.length - 2], "COMMIT;");
    assert.equal(queryTexts[queryTexts.length - 1], "END");
    assert.equal(client.isClosed, true);
  });

  it("executes CREATE INDEX on shifts(team_id) inside the transaction after adding team_id and before commit", async () => {
    const client = createMockClient();
    await executeMigrationTransaction(client);

    const queryTexts = client.executedQueries.map((q) => q.text);
    const alterIdx = queryTexts.findIndex((q) => q.includes("ALTER TABLE shifts"));
    const indexIdx = queryTexts.findIndex((q) =>
      q.includes("CREATE INDEX IF NOT EXISTS idx_shifts_team_id ON shifts(team_id)")
    );
    const commitIdx = queryTexts.findIndex((q) => q === "COMMIT;");

    assert.ok(alterIdx !== -1, "ALTER TABLE shifts must be executed");
    assert.ok(indexIdx !== -1, "CREATE INDEX must be executed");
    assert.ok(
      alterIdx < indexIdx,
      "CREATE INDEX on shifts(team_id) must execute after ALTER TABLE shifts"
    );
    assert.ok(
      indexIdx < commitIdx,
      "CREATE INDEX on shifts(team_id) must execute before COMMIT"
    );
  });

  it("preserves existing user records, password hashes, and salts without modifying users table", async () => {
    const client = createMockClient();
    const result = await executeMigrationTransaction(client);

    assert.equal(result.success, true);
    assert.ok(
      client.executedQueries.every(
        (q) =>
          !q.text.includes("UPDATE users") &&
          !q.text.includes("DELETE FROM users") &&
          !q.text.includes("ALTER TABLE users")
      ),
      "Migration must never mutate users table in any way"
    );
  });

  it("preserves existing shifts without team assignment and never executes UPDATE shifts in default mode", async () => {
    const client = createMockClient();
    const result = await executeMigrationTransaction(client);

    assert.equal(result.success, true);
    assert.equal(result.shiftsBackfilled, 0);
    assert.ok(
      !client.executedQueries.some((q) => q.text.includes("UPDATE shifts")),
      "Default migration must not mutate shifts table; existing shifts safely remain with team_id = NULL"
    );
  });

  it("safely handles repeated migration attempts without modifying existing data or failing (idempotency)", async () => {
    const client1 = createMockClient();
    const result1 = await executeMigrationTransaction(client1);
    assert.equal(result1.success, true);

    const client2 = createMockClient();
    const result2 = await executeMigrationTransaction(client2);
    assert.equal(result2.success, true);

    // Verify all DDL operations use IF NOT EXISTS
    const ddlQueries = client2.executedQueries.filter(
      (q) => q.text.startsWith("CREATE TABLE") || q.text.startsWith("ALTER TABLE") || q.text.startsWith("CREATE INDEX")
    );
    assert.ok(ddlQueries.every((q) => q.text.includes("IF NOT EXISTS")), "All DDL must be strictly idempotent");
  });

  it("resolves team ID dynamically from database by unique slug when seedDemoTeam is true (does not assume team ID 1)", async () => {
    // Custom team ID 999 returned by database
    const client = createMockClient({
      queryResponses: {
        insertTeam: { rows: [{ id: 999 }] },
      },
    });

    const result = await executeMigrationTransaction(client, { seedDemoTeam: true });
    assert.equal(result.teamId, 999);

    // Verify memberships and shifts were assigned to teamId 999
    const membershipQueries = client.executedQueries.filter((q) =>
      q.text.includes("INSERT INTO team_memberships")
    );
    assert.ok(membershipQueries.length > 0);
    assert.ok(membershipQueries.every((q) => q.params[1] === 999));

    const shiftQuery = client.executedQueries.find((q) => q.text.includes("UPDATE shifts"));
    assert.ok(shiftQuery);
    assert.equal(shiftQuery.params[0], 999);
  });

  it("rolls back transaction and closes connection if a statement fails midway", async () => {
    const client = createMockClient({ failOnQuery: "team_memberships" });

    await assert.rejects(
      async () => {
        await executeMigrationTransaction(client);
      },
      (err) => {
        assert.ok(err.message.includes("Simulated database failure"));
        return true;
      }
    );

    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.ok(queryTexts.includes("BEGIN;"));
    assert.ok(queryTexts.includes("ROLLBACK;"));
    assert.ok(!queryTexts.includes("COMMIT;"), "COMMIT must NEVER be executed when a statement fails");
    assert.equal(client.isClosed, true, "Connection must always be closed in finally block");
  });

  it("aborts transaction and rolls back if seedDemoTeam is true but no verified demo accounts are found", async () => {
    const client = createMockClient({
      queryResponses: {
        selectUsers: { rows: [] }, // 0 users found
      },
    });

    await assert.rejects(
      async () => {
        await executeMigrationTransaction(client, { seedDemoTeam: true });
      },
      /Abort: Incomplete demo accounts in database/
    );

    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.ok(queryTexts.includes("ROLLBACK;"));
    assert.ok(!queryTexts.includes("COMMIT;"));
    assert.equal(client.isClosed, true);
  });

  it("aborts transaction and rolls back if seedDemoTeam is true but one or more demo accounts are missing", async () => {
    // 4 of 5 demo accounts present (chika@rota.local missing)
    const client = createMockClient({
      queryResponses: {
        selectUsers: {
          rows: [
            { id: 10, email: "amara@rota.local", name: "Amara Okafor", role: "Front Desk" },
            { id: 11, email: "daniel@rota.local", name: "Daniel James", role: "Operations" },
            { id: 12, email: "sarah@rota.local", name: "Sarah Bello", role: "Customer Support" },
            { id: 13, email: "david@rota.local", name: "David Musa", role: "Front Desk" },
          ],
        },
      },
    });

    await assert.rejects(
      async () => {
        await executeMigrationTransaction(client, { seedDemoTeam: true });
      },
      /Abort: Incomplete demo accounts in database.*missing: chika@rota\.local/i
    );

    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.ok(queryTexts.includes("ROLLBACK;"), "Must roll back transaction when demo accounts are missing");
    assert.ok(!queryTexts.includes("COMMIT;"), "Must never commit when demo accounts are incomplete");
    assert.equal(client.isClosed, true, "Connection must always close");
  });

  it("aborts transaction and rolls back if seedDemoTeam is true and ambiguous duplicate demo email accounts exist", async () => {
    const client = createMockClient({
      queryResponses: {
        selectUsers: {
          rows: [
            { id: 10, email: "amara@rota.local", name: "Amara 1", role: "Staff" },
            { id: 11, email: "amara@rota.local", name: "Amara 2", role: "Staff" }, // duplicate email
          ],
        },
      },
    });

    await assert.rejects(
      async () => {
        await executeMigrationTransaction(client, { seedDemoTeam: true });
      },
      /Abort: Ambiguous duplicate email accounts detected/
    );

    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.ok(queryTexts.includes("ROLLBACK;"));
    assert.ok(!queryTexts.includes("COMMIT;"));
    assert.equal(client.isClosed, true);
  });

  it("preserves existing team name when insert encounters conflict on rerun in demo seeding mode", async () => {
    // DO NOTHING on conflict causes insert returning to be empty; fallback SELECT resolves existing ID 77
    const client = createMockClient({
      queryResponses: {
        insertTeam: { rows: [] },
        selectTeam: { rows: [{ id: 77 }] },
      },
    });

    const result = await executeMigrationTransaction(client, { seedDemoTeam: true });
    assert.equal(result.teamId, 77);

    const insertQuery = client.executedQueries.find((q) => q.text.includes("INSERT INTO teams"));
    assert.ok(insertQuery.text.includes("ON CONFLICT (slug) DO NOTHING"), "Must avoid overwriting existing team name on rerun");

    const selectQuery = client.executedQueries.find((q) => q.text.includes("SELECT id FROM teams WHERE slug"));
    assert.ok(selectQuery, "Must resolve existing team ID by slug when insert encounters conflict");
  });

  it("preserves existing team_memberships roles with DO NOTHING on conflict during rerun in demo seeding mode", async () => {
    const client = createMockClient();
    await executeMigrationTransaction(client, { seedDemoTeam: true });

    const membershipQueries = client.executedQueries.filter((q) =>
      q.text.includes("INSERT INTO team_memberships")
    );
    assert.ok(membershipQueries.length === 5);
    assert.ok(
      membershipQueries.every((q) =>
        q.text.includes("ON CONFLICT (user_id, team_id) DO NOTHING")
      ),
      "Must use DO NOTHING on conflict to preserve existing team_memberships.role on rerun"
    );
  });

  it("flags ambiguous failure on commit error without automatically retrying", async () => {
    const client = createMockClient({ failOnQuery: "COMMIT;" });

    await assert.rejects(
      async () => {
        await executeMigrationTransaction(client);
      },
      (err) => {
        assert.ok(err.message.includes("Ambiguous failure during COMMIT"));
        assert.ok(err.message.includes("Do NOT automatically retry"));
        return true;
      }
    );

    // Verify success was not reported and connection was ended
    assert.equal(client.isClosed, true);
  });

  it("sanitizes database error messages to prevent credential and URL leakage", () => {
    const leakError =
      "Connection to postgresql://neondb_owner:npg_SecretPass123@ep-cool-dawn.us-east-2.neon.tech/neondb failed; password=SecretPass123";
    const sanitized = sanitizeErrorMessage(leakError);

    assert.ok(!sanitized.includes("npg_SecretPass123"), "Passwords in connection URLs must be redacted");
    assert.ok(!sanitized.includes("SecretPass123"), "Password parameter values must be redacted");
    assert.ok(sanitized.includes("[REDACTED]"));
  });

  it("defaults to dry-run mode and requires exact --run flag to enable execution", () => {
    // Missing arguments defaults to false (dry-run)
    assert.equal(isMigrationRunMode(["node", "scripts/migrate-team-isolation.mjs"]), false);
    // Other flags do not enable run mode
    assert.equal(isMigrationRunMode(["node", "scripts/migrate-team-isolation.mjs", "--dry-run"]), false);
    assert.equal(isMigrationRunMode(["node", "scripts/migrate-team-isolation.mjs", "--help"]), false);
    assert.equal(isMigrationRunMode(["node", "scripts/migrate-team-isolation.mjs", "-r"]), false);
    assert.equal(isMigrationRunMode([]), false);

    // Exact --run enables run mode
    assert.equal(isMigrationRunMode(["node", "scripts/migrate-team-isolation.mjs", "--run"]), true);
    assert.equal(isMigrationRunMode(["node", "scripts/migrate-team-isolation.mjs", "--verbose", "--run"]), true);

    // Optional --seed-demo-team parsing
    const defaultParsed = parseMigrationArgs(["node", "scripts/migrate-team-isolation.mjs", "--run"]);
    assert.equal(defaultParsed.run, true);
    assert.equal(defaultParsed.seedDemoTeam, false);

    const seededParsed = parseMigrationArgs([
      "node",
      "scripts/migrate-team-isolation.mjs",
      "--run",
      "--seed-demo-team",
    ]);
    assert.equal(seededParsed.run, true);
    assert.equal(seededParsed.seedDemoTeam, true);
  });

  it("never produces a false success message when commit fails", async () => {
    const client = createMockClient({ failOnQuery: "COMMIT;" });
    let resolvedResult = null;

    try {
      resolvedResult = await executeMigrationTransaction(client);
    } catch {
      // Expected rejection
    }

    assert.equal(resolvedResult, null, "Result must never resolve or report success when commit fails");
  });
});

describe("Team Isolation — Fail-Closed Read-Only Preflight Inspection", () => {
  function createMockPreflightClient({
    dbName = "neondb",
    user = "neondb_owner",
    version = "PostgreSQL 16.2 on x86_64",
    columns = null,
    indexes = null,
    constraints = null,
    users = null,
    shiftCounts = null,
    activityError = null,
    activity = [],
    failOnQuery = null,
    queryError = null,
    failOnEnd = false,
    endError = null,
  } = {}) {
    const executedQueries = [];
    let isClosed = false;

    return {
      executedQueries,
      get isClosed() {
        return isClosed;
      },
      async query(text, params = []) {
        const trimmed = text.trim();
        const normalized = text.replace(/\s+/g, " ").trim();
        executedQueries.push({ text: trimmed, params });

        if (failOnQuery && normalized.includes(failOnQuery)) {
          throw queryError || new Error(`Simulated database failure during: ${failOnQuery}`);
        }

        if (normalized.includes("current_database()")) {
          return {
            rows: [{ db_name: dbName, user_name: user, pg_version: version }],
          };
        }

        if (normalized.includes("information_schema.columns")) {
          return (
            columns || {
              rows: [
                { table_name: "users", column_name: "id", data_type: "integer", is_nullable: "NO" },
                { table_name: "users", column_name: "email", data_type: "character varying", is_nullable: "NO" },
                { table_name: "shifts", column_name: "id", data_type: "integer", is_nullable: "NO" },
                { table_name: "shifts", column_name: "user_id", data_type: "integer", is_nullable: "YES" },
              ],
            }
          );
        }

        if (normalized.includes("pg_indexes")) {
          return indexes || { rows: [] };
        }

        if (normalized.includes("information_schema.table_constraints")) {
          return constraints || { rows: [] };
        }

        if (normalized.includes("FROM users")) {
          return (
            users || {
              rows: [
                { id: 1, email: "amara@rota.local", name: "Amara Okafor", role: "Front Desk" },
                { id: 2, email: "daniel@rota.local", name: "Daniel James", role: "Operations" },
                { id: 3, email: "sarah@rota.local", name: "Sarah Bello", role: "Customer Support" },
                { id: 4, email: "david@rota.local", name: "David Musa", role: "Front Desk" },
                { id: 5, email: "chika@rota.local", name: "Chika Nwosu", role: "Supervisor" },
              ],
            }
          );
        }

        if (normalized.includes("FROM shifts")) {
          return (
            shiftCounts || {
              rows: [
                {
                  total_shifts: 25,
                  eligible_for_backfill: 15,
                  unassigned_shifts: 6,
                  non_demo_shifts: 4,
                  already_assigned_shifts: 0,
                },
              ],
            }
          );
        }

        if (normalized.includes("pg_stat_activity")) {
          if (activityError) {
            throw activityError;
          }
          return { rows: activity };
        }

        return { rows: [] };
      },
      async end() {
        if (failOnEnd || endError) {
          throw endError || new Error("Simulated client.end() failure");
        }
        isClosed = true;
        executedQueries.push({ text: "END" });
      },
    };
  }

  const validInspectionOpts = {
    confirmTarget: "neondb",
    confirmEndpoint: "ep-staging-123.us-east-2.aws.neon.tech",
    hostname: "ep-staging-123.us-east-2.aws.neon.tech",
  };

  it("requires explicit --run-read-only flag and parses target and endpoint arguments safely", () => {
    assert.equal(isPreflightRunMode(["node", "scripts/preflight-migration.mjs"]), false);
    assert.equal(isPreflightRunMode(["node", "scripts/preflight-migration.mjs", "--run"]), false);
    assert.equal(isPreflightRunMode(["node", "scripts/preflight-migration.mjs", "--dry-run"]), false);
    assert.equal(isPreflightRunMode(["node", "scripts/preflight-migration.mjs", "--run-read-only"]), true);

    const parsed = parsePreflightArgs([
      "node",
      "scripts/preflight-migration.mjs",
      "--run-read-only",
      "--confirm-target",
      "staging_db",
      "--confirm-endpoint",
      "ep-staging-branch.us-east-2.aws.neon.tech",
    ]);
    assert.equal(parsed.runReadOnly, true);
    assert.equal(parsed.confirmTarget, "staging_db");
    assert.equal(parsed.confirmEndpoint, "ep-staging-branch.us-east-2.aws.neon.tech");
  });

  it("never imports or invokes the migration, setup-auth, or reset-demo scripts", () => {
    const preflightCode = fs.readFileSync("scripts/preflight-migration.mjs", "utf-8");
    assert.ok(!/import\s+.*from\s+['"].*migrate-team-isolation/i.test(preflightCode));
    assert.ok(!/import\s+.*from\s+['"].*setup-auth-db/i.test(preflightCode));
    assert.ok(!/import\s+.*from\s+['"].*reset-chika-demo/i.test(preflightCode));
    assert.ok(!/import\s*\(['"].*migrate-team-isolation/i.test(preflightCode));
    assert.ok(!/import\s*\(['"].*setup-auth-db/i.test(preflightCode));
    assert.ok(!/import\s*\(['"].*reset-chika-demo/i.test(preflightCode));
    assert.ok(!/require\s*\(['"].*migrate-team-isolation/i.test(preflightCode));
    assert.ok(!/require\s*\(['"].*setup-auth-db/i.test(preflightCode));
    assert.ok(!/require\s*\(['"].*reset-chika-demo/i.test(preflightCode));
  });

  it("enforces read-only SQL: rejects any mutation keywords and wraps inspection in read-only transaction", async () => {
    // Assert read-only guard rejects mutation keywords
    assert.throws(() => assertReadOnlyQuery("INSERT INTO teams (name) VALUES ('x');"), /Safety violation/);
    assert.throws(() => assertReadOnlyQuery("UPDATE shifts SET team_id = 1;"), /Safety violation/);
    assert.throws(() => assertReadOnlyQuery("DELETE FROM shifts;"), /Safety violation/);
    assert.throws(() => assertReadOnlyQuery("CREATE TABLE test (id int);"), /Safety violation/);
    assert.throws(() => assertReadOnlyQuery("ALTER TABLE shifts ADD COLUMN x int;"), /Safety violation/);
    assert.throws(() => assertReadOnlyQuery("DROP TABLE shifts;"), /Safety violation/);
    assert.throws(() => assertReadOnlyQuery("TRUNCATE shifts;"), /Safety violation/);

    // Permitted statements do not throw
    assert.doesNotThrow(() => assertReadOnlyQuery("SELECT * FROM users;"));
    assert.doesNotThrow(() => assertReadOnlyQuery("BEGIN TRANSACTION READ ONLY;"));
    assert.doesNotThrow(() => assertReadOnlyQuery("ROLLBACK;"));
    assert.doesNotThrow(() => assertReadOnlyQuery("SET LOCAL statement_timeout = '5000';"));

    // Verify all queries issued during a full preflight run are strictly read-only
    const client = createMockPreflightClient();
    const report = await executePreflightInspection(client, validInspectionOpts);

    assert.equal(report.success, true);
    const queryTexts = client.executedQueries.map((q) => q.text);

    // Transaction lifecycle
    assert.equal(queryTexts[0], "BEGIN TRANSACTION READ ONLY;");
    assert.ok(queryTexts.includes("SET LOCAL statement_timeout = '5000';"));
    assert.ok(queryTexts.includes("SET LOCAL lock_timeout = '2000';"));
    assert.equal(queryTexts[queryTexts.length - 2], "ROLLBACK;");
    assert.equal(queryTexts[queryTexts.length - 1], "END");
    assert.equal(client.isClosed, true);

    // Ensure zero mutation statements exist in executed queries
    for (const q of queryTexts) {
      if (q !== "END") {
        assertReadOnlyQuery(q);
      }
    }
  });

  it("missing endpoint confirmation prevents connection attempts and fails closed before queries", async () => {
    const client = createMockPreflightClient();

    await assert.rejects(
      async () => {
        await executePreflightInspection(client, { confirmTarget: "neondb" }); // missing confirmEndpoint
      },
      /Operator endpoint confirmation \(--confirm-endpoint <exact_hostname>\) is required/
    );

    // No SQL queries must be executed
    assert.equal(client.executedQueries.length, 0);
  });

  it("partial endpoint prefixes fail before any connection attempt and fail closed", async () => {
    const client = createMockPreflightClient();

    // Partial endpoint prefixes (single label without domain/TLD) must be rejected
    assert.equal(isValidHostname("ep-staging"), false);
    assert.equal(isValidHostname("ep-cool-dawn"), false);
    assert.equal(isValidEndpointIdentifier("ep-staging-preview"), false);

    await assert.rejects(
      async () => {
        await executePreflightInspection(client, {
          confirmTarget: "neondb",
          confirmEndpoint: "ep-staging",
          hostname: "ep-staging-123.us-east-2.aws.neon.tech",
        });
      },
      /Malformed endpoint confirmation/
    );

    // Zero database queries must be executed
    assert.equal(client.executedQueries.length, 0);
  });

  it("wrong hostnames and malformed values fail closed before inspection queries", async () => {
    const client = createMockPreflightClient();

    // Wrong hostname: valid hostname syntax, but does not match configured host
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, {
          confirmTarget: "neondb",
          confirmEndpoint: "ep-wrong-endpoint.us-east-2.aws.neon.tech",
          hostname: "ep-staging-preview.us-east-2.aws.neon.tech",
        });
      },
      /Endpoint confirmation mismatch/
    );

    // Malformed endpoint: starts with '--' (flag passed instead of value)
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, {
          confirmTarget: "neondb",
          confirmEndpoint: "--run",
          hostname: "ep-staging.us-east-2.aws.neon.tech",
        });
      },
      /Malformed endpoint confirmation/
    );

    // Malformed endpoint: full URL passed instead of hostname
    assert.equal(isValidHostname("postgres://ep-staging.us-east-2.aws.neon.tech"), false);
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, {
          confirmTarget: "neondb",
          confirmEndpoint: "postgres://ep-staging.us-east-2.aws.neon.tech",
          hostname: "ep-staging.us-east-2.aws.neon.tech",
        });
      },
      /Malformed endpoint confirmation/
    );

    // Malformed endpoint: path included
    assert.equal(isValidHostname("ep-staging.us-east-2.aws.neon.tech/neondb"), false);
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, {
          confirmTarget: "neondb",
          confirmEndpoint: "ep-staging.us-east-2.aws.neon.tech/neondb",
          hostname: "ep-staging.us-east-2.aws.neon.tech",
        });
      },
      /Malformed endpoint confirmation/
    );

    // Malformed endpoint: port included
    assert.equal(isValidHostname("ep-staging.us-east-2.aws.neon.tech:5432"), false);
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, {
          confirmTarget: "neondb",
          confirmEndpoint: "ep-staging.us-east-2.aws.neon.tech:5432",
          hostname: "ep-staging.us-east-2.aws.neon.tech",
        });
      },
      /Malformed endpoint confirmation/
    );

    // Malformed target database name
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, {
          confirmTarget: "--confirm-endpoint",
          confirmEndpoint: "ep-staging.us-east-2.aws.neon.tech",
          hostname: "ep-staging.us-east-2.aws.neon.tech",
        });
      },
      /Malformed database confirmation/
    );

    assert.equal(client.executedQueries.length, 0);
  });

  it("exact hostname match succeeds through the mocked read-only path (including case-insensitivity and trailing dot)", async () => {
    const client = createMockPreflightClient({ dbName: "staging_db" });

    // 1. Exact match
    const report = await executePreflightInspection(client, {
      confirmTarget: "staging_db",
      confirmEndpoint: "ep-staging-preview-123456.us-east-2.aws.neon.tech",
      hostname: "ep-staging-preview-123456.us-east-2.aws.neon.tech",
    });

    assert.equal(report.success, true);
    assert.equal(report.dbIdentity.database, "staging_db");
    const queryTexts = client.executedQueries.map((q) => q.text);
    assert.equal(queryTexts[0], "BEGIN TRANSACTION READ ONLY;");
    assert.equal(queryTexts[queryTexts.length - 2], "ROLLBACK;");
    assert.equal(client.isClosed, true);

    // 2. Case normalization match
    const clientCase = createMockPreflightClient({ dbName: "staging_db" });
    const reportCase = await executePreflightInspection(clientCase, {
      confirmTarget: "staging_db",
      confirmEndpoint: "EP-STAGING-PREVIEW-123456.US-EAST-2.AWS.NEON.TECH",
      hostname: "ep-staging-preview-123456.us-east-2.aws.neon.tech",
    });
    assert.equal(reportCase.success, true);

    // 3. Trailing dot match (standard DNS FQDN notation)
    const clientDot = createMockPreflightClient({ dbName: "staging_db" });
    const reportDot = await executePreflightInspection(clientDot, {
      confirmTarget: "staging_db",
      confirmEndpoint: "ep-staging-preview-123456.us-east-2.aws.neon.tech.",
      hostname: "ep-staging-preview-123456.us-east-2.aws.neon.tech",
    });
    assert.equal(reportDot.success, true);
  });

  it("production and staging cannot be distinguished by database name alone", async () => {
    // Both production and staging share the default database name 'neondb'
    const prodHost = "ep-prod-master-999.us-east-2.aws.neon.tech";
    const stagingHost = "ep-staging-preview-888.us-east-2.aws.neon.tech";

    const prodClient = createMockPreflightClient({ dbName: "neondb" });

    // 1. Confirming only 'neondb' without endpoint fails closed
    await assert.rejects(
      async () => {
        await executePreflightInspection(prodClient, {
          confirmTarget: "neondb",
          hostname: prodHost,
        });
      },
      /Operator endpoint confirmation/
    );
    assert.equal(prodClient.executedQueries.length, 0);

    // 2. An operator intending to inspect staging will fail closed if connected to production
    await assert.rejects(
      async () => {
        await executePreflightInspection(prodClient, {
          confirmTarget: "neondb",
          confirmEndpoint: stagingHost,
          hostname: prodHost,
        });
      },
      /Endpoint confirmation mismatch/
    );
    assert.equal(prodClient.executedQueries.length, 0);
  });

  it("aborts and fails closed when operator target database name does not match connected database", async () => {
    const client = createMockPreflightClient({ dbName: "production_db" });

    // Mismatched database confirmation (operator specified staging_db, but connected database is production_db)
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, {
          confirmTarget: "staging_db",
          confirmEndpoint: "ep-staging.us-east-2.aws.neon.tech",
          hostname: "ep-staging.us-east-2.aws.neon.tech",
        });
      },
      /Database confirmation mismatch/
    );

    // Client connection must always be released
    assert.equal(client.isClosed, true);
  });

  it("handles absent demo accounts as an informational notice without failing preflight", async () => {
    // Missing sarah@rota.local (e.g. real-user database)
    const clientMissing = createMockPreflightClient({
      users: {
        rows: [
          { id: 1, email: "amara@rota.local", name: "Amara", role: "Staff" },
          { id: 2, email: "daniel@rota.local", name: "Daniel", role: "Ops" },
          { id: 4, email: "david@rota.local", name: "David", role: "Staff" },
          { id: 5, email: "chika@rota.local", name: "Chika", role: "Supervisor" },
        ],
      },
    });

    const reportMissing = await executePreflightInspection(clientMissing, validInspectionOpts);
    assert.equal(reportMissing.success, true, "Missing demo accounts must not fail preflight on a real-user database");
    assert.equal(reportMissing.demoAccounts.isComplete, false);
    assert.ok(reportMissing.demoAccounts.missing.includes("sarah@rota.local"));
    assert.equal(reportMissing.criticalIssues.length, 0);
    assert.ok(reportMissing.warnings.some((w) => w.includes("sarah@rota.local")));
  });

  it("fails closed when ambiguous duplicate demo accounts exist in users table", async () => {
    // Duplicate amara@rota.local
    const clientDup = createMockPreflightClient({
      users: {
        rows: [
          { id: 1, email: "amara@rota.local", name: "Amara 1", role: "Staff" },
          { id: 10, email: "amara@rota.local", name: "Amara 2", role: "Staff" },
          { id: 2, email: "daniel@rota.local", name: "Daniel", role: "Ops" },
          { id: 3, email: "sarah@rota.local", name: "Sarah", role: "Staff" },
          { id: 4, email: "david@rota.local", name: "David", role: "Staff" },
          { id: 5, email: "chika@rota.local", name: "Chika", role: "Supervisor" },
        ],
      },
    });

    const reportDup = await executePreflightInspection(clientDup, validInspectionOpts);
    assert.equal(reportDup.success, false);
    assert.ok(reportDup.demoAccounts.duplicates.includes("amara@rota.local"));
    assert.ok(reportDup.criticalIssues.some((issue) => issue.includes("Ambiguous duplicate demo accounts")));
  });

  it("fails closed when core tables (users, shifts) are missing from information_schema", async () => {
    // Missing 'users' table
    const clientNoUsers = createMockPreflightClient({
      columns: {
        rows: [
          { table_name: "shifts", column_name: "id", data_type: "integer", is_nullable: "NO" },
        ],
      },
    });

    const report = await executePreflightInspection(clientNoUsers, validInspectionOpts);
    assert.equal(report.success, false);
    assert.equal(report.schema.tables.users.exists, false);
    assert.ok(report.criticalIssues.some((issue) => issue.includes("Missing core table 'users'")));
  });

  it("reports unassigned and non-demo shift counts distinctly and includes ownership disclaimer", async () => {
    const client = createMockPreflightClient({
      shiftCounts: {
        rows: [
          {
            total_shifts: 30,
            eligible_for_backfill: 18,
            unassigned_shifts: 7,
            non_demo_shifts: 5,
            already_assigned_shifts: 0,
          },
        ],
      },
    });

    const report = await executePreflightInspection(client, validInspectionOpts);
    assert.equal(report.shiftCounts.totalShifts, 30);
    assert.equal(report.shiftCounts.eligibleForBackfill, 18);
    assert.equal(report.shiftCounts.unassignedShifts, 7);
    assert.equal(report.shiftCounts.nonDemoShifts, 5);
    assert.ok(report.shiftCounts.ownershipDisclaimer.includes("Shift counts alone do not establish ownership"));
    assert.ok(report.warnings.some((w) => w.includes("7 shifts have user_id IS NULL and will NOT be backfilled")));
    assert.ok(report.warnings.some((w) => w.includes("5 shifts belong to users outside the 5 verified demo accounts")));
  });

  it("distinguishes unavailable lock inspection permissions from clean results without false claims", async () => {
    // Permission error (insufficient_privilege)
    const clientPermDenied = createMockPreflightClient({
      activityError: new Error("permission denied for function pg_stat_activity"),
    });

    const reportPerm = await executePreflightInspection(clientPermDenied, validInspectionOpts);
    assert.equal(reportPerm.locks.status, "unavailable");
    assert.ok(reportPerm.locks.details.includes("permission denied"));
    assert.ok(reportPerm.locks.details.includes("Do NOT assume no conflicting locks exist"));

    // Active concurrent queries found
    const clientActive = createMockPreflightClient({
      activity: [{ pid: 1234, usename: "app", state: "active", query: "SELECT pg_sleep(10);" }],
    });

    const reportActive = await executePreflightInspection(clientActive, validInspectionOpts);
    assert.equal(reportActive.locks.status, "active_locks_found");
    assert.equal(reportActive.locks.activeProcesses.length, 1);
    assert.equal(reportActive.locks.activeProcesses[0].pid, 1234);

    // Clean result
    const clientClean = createMockPreflightClient({ activity: [] });
    const reportClean = await executePreflightInspection(clientClean, validInspectionOpts);
    assert.equal(reportClean.locks.status, "clean");
  });

  it("connection failures are sanitized even when they occur before the inspection transaction begins", () => {
    // Simulate raw driver connection exception before inspection transaction
    const sensitiveError = new Error(
      "connect ECONNREFUSED postgresql://super_admin:super_secret_password_xyz@ep-prod-secret-999.us-east-2.aws.neon.tech:5432/neondb?sslmode=require&token=npg_secret_token_123&password=super_secret_password_xyz"
    );

    const formattedCliError = formatSafeCliError(sensitiveError);

    // Verify sensitive items are never leaked
    assert.ok(!formattedCliError.includes("super_secret_password_xyz"));
    assert.ok(!formattedCliError.includes("super_admin"));
    assert.ok(!formattedCliError.includes("npg_secret_token_123"));
    assert.ok(!formattedCliError.includes("ep-prod-secret-999"));
    assert.ok(formattedCliError.includes("[REDACTED_CONNECTION_URL]"));
    assert.ok(formattedCliError.includes("[Connection Error]"));
  });

  it("redacts passwords, tokens, auth errors, and raw URLs in error output and masks endpoint details", () => {
    const leakError =
      "Connection to postgresql://neondb_owner:secret_pass_123@ep-cool-dawn-987654.us-east-2.aws.neon.tech/neondb failed; password=secret_pass_123 token=abc123xyz password authentication failed for user \"neondb_owner\"";
    const sanitized = sanitizePreflightErrorMessage(leakError);

    assert.ok(!sanitized.includes("secret_pass_123"));
    assert.ok(!sanitized.includes("abc123xyz"));
    assert.ok(!sanitized.includes("neondb_owner"));
    assert.ok(sanitized.includes("[REDACTED_CONNECTION_URL]"));
    assert.ok(sanitized.includes("[REDACTED_USER]"));

    const maskedHost = sanitizeTargetHost(
      "postgresql://neondb_owner:pass@ep-cool-dawn-987654.us-east-2.aws.neon.tech/neondb"
    );
    assert.ok(!maskedHost.includes("neondb_owner"));
    assert.ok(!maskedHost.includes("pass"));
    assert.ok(maskedHost.startsWith("ep-cool***"));
  });

  it("ensures read-only transaction ends with ROLLBACK and releases client on both success and failure", async () => {
    // Success case - verifies normal successful path
    const clientSuccess = createMockPreflightClient();
    const report = await executePreflightInspection(clientSuccess, validInspectionOpts);
    assert.equal(report.success, true);
    assert.ok(clientSuccess.executedQueries.some((q) => q.text === "ROLLBACK;"));
    assert.equal(clientSuccess.isClosed, true);

    // Failure mid-inspection
    const clientFail = createMockPreflightClient({ failOnQuery: "information_schema.columns" });
    await assert.rejects(async () => {
      await executePreflightInspection(clientFail, validInspectionOpts);
    });
    assert.ok(clientFail.executedQueries.some((q) => q.text === "ROLLBACK;"));
    assert.equal(clientFail.isClosed, true);
  });

  it("fails closed when ROLLBACK fails after inspection queries succeed", async () => {
    // Simulate failure specifically when executing ROLLBACK
    const client = createMockPreflightClient({
      failOnQuery: "ROLLBACK;",
      queryError: new Error("Simulated connection failure during ROLLBACK; password=secret_token_abc"),
    });

    // 1. Must reject and NOT report success
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, validInspectionOpts);
      },
      (err) => {
        assert.ok(err.message.includes("Preflight inspection failed"));
        assert.ok(err.message.includes("ROLLBACK;"));
        // 2. Sensitive details sanitized
        assert.ok(!err.message.includes("secret_token_abc"));
        assert.ok(err.message.includes("password=[REDACTED]"));
        return true;
      }
    );

    // 3. Rollback was attempted and client cleanup was completed
    assert.ok(client.executedQueries.some((q) => q.text === "ROLLBACK;"));
    assert.equal(client.isClosed, true);
  });

  it("preserves primary inspection error and reports cleanup failure when both inspection and rollback fail", async () => {
    // Client fails on information_schema.columns AND on ROLLBACK
    let columnsFailed = false;
    const client = createMockPreflightClient();
    const originalQuery = client.query.bind(client);

    client.query = async (text, params) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      client.executedQueries.push({ text: text.trim(), params });
      if (normalized.includes("information_schema.columns")) {
        columnsFailed = true;
        throw new Error("Primary catalog inspection failure token=secret_token_xyz password=leak_pass");
      }
      if (columnsFailed && normalized.includes("ROLLBACK")) {
        throw new Error("Secondary rollback failure host=ep-secret-host.neon.tech");
      }
      return originalQuery(text, params);
    };

    await assert.rejects(
      async () => {
        await executePreflightInspection(client, validInspectionOpts);
      },
      (err) => {
        // 1. Primary error remains identifiable
        assert.ok(err.message.includes("Primary catalog inspection failure"));
        // 2. Rollback failure is recorded as cleanup failure without implying rollback succeeded
        assert.ok(err.message.includes("Cleanup failed:"));
        assert.ok(err.message.includes("ROLLBACK failed: Secondary rollback failure"));
        // 3. Sensitive items in both errors are sanitized in message
        assert.ok(!err.message.includes("secret_token_xyz"));
        assert.ok(!err.message.includes("leak_pass"));
        assert.ok(!err.message.includes("ep-secret-host"));
        assert.ok(err.message.includes("token=[REDACTED]"));
        assert.ok(err.message.includes("password=[REDACTED]"));
        assert.ok(err.message.includes("[REDACTED_HOST]"));

        // 4. Surfaced error.stack contains no sensitive values
        assert.ok(typeof err.stack === "string");
        assert.ok(!err.stack.includes("secret_token_xyz"));
        assert.ok(!err.stack.includes("leak_pass"));
        assert.ok(!err.stack.includes("ep-secret-host"));
        assert.ok(err.stack.includes("token=[REDACTED]"));
        assert.ok(err.stack.includes("password=[REDACTED]"));
        return true;
      }
    );

    // Rollback was attempted despite failing, and client cleanup completed
    assert.ok(client.executedQueries.some((q) => q.text.includes("ROLLBACK;")));
    assert.equal(client.isClosed, true);
  });

  it("prevents unqualified success when client closure fails after successful inspection", async () => {
    const sensitiveEndError = new Error(
      "Socket close error: connect ECONNRESET postgresql://owner:secret_123@ep-cool.neon.tech:5432/neondb password=secret_123 token=abc_tok host=ep-cool.neon.tech"
    );

    const client = createMockPreflightClient({
      endError: sensitiveEndError,
    });

    // 1. Must reject and cannot produce an unqualified success report
    await assert.rejects(
      async () => {
        await executePreflightInspection(client, validInspectionOpts);
      },
      (err) => {
        assert.ok(err.message.includes("Preflight inspection cleanup failed"));
        assert.ok(err.message.includes("client closure failed"));
        // 2. Sensitive connection details and credentials must be sanitized in message
        assert.ok(!err.message.includes("secret_123"));
        assert.ok(!err.message.includes("abc_tok"));
        assert.ok(!err.message.includes("ep-cool.neon.tech"));
        assert.ok(err.message.includes("[REDACTED_CONNECTION_URL]"));
        assert.ok(err.message.includes("password=[REDACTED]"));
        assert.ok(err.message.includes("token=[REDACTED]"));
        assert.ok(err.message.includes("[REDACTED_HOST]"));

        // 3. Surfaced error.stack contains no sensitive values
        assert.ok(typeof err.stack === "string");
        assert.ok(!err.stack.includes("secret_123"));
        assert.ok(!err.stack.includes("abc_tok"));
        assert.ok(!err.stack.includes("ep-cool.neon.tech"));
        assert.ok(err.stack.includes("[REDACTED_CONNECTION_URL]"));
        assert.ok(err.stack.includes("password=[REDACTED]"));
        assert.ok(err.stack.includes("token=[REDACTED]"));
        assert.ok(err.stack.includes("[REDACTED_HOST]"));
        return true;
      }
    );

    // 3. Client is not marked closed cleanly
    assert.equal(client.isClosed, false, "Client must not be marked closed when client.end() fails");
  });

  it("preserves primary error and reports cleanup failures when inspection, rollback, and client closure all fail", async () => {
    let queryFailed = false;
    const sensitiveCloseError = new Error("Close failed token=tok_leak host=ep-close-host.neon.tech");
    const client = createMockPreflightClient({
      endError: sensitiveCloseError,
    });
    const originalQuery = client.query.bind(client);

    client.query = async (text, params) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      client.executedQueries.push({ text: text.trim(), params });
      if (normalized.includes("information_schema.columns")) {
        queryFailed = true;
        throw new Error(
          "Primary inspection catalog error password=secret_inspect_pass postgresql://admin:pass@ep-host.neon.tech/neondb"
        );
      }
      if (queryFailed && normalized.includes("ROLLBACK")) {
        throw new Error("Rollback failed token=secret_rollback_token host=ep-rb-host.neon.tech");
      }
      return originalQuery(text, params);
    };

    await assert.rejects(
      async () => {
        await executePreflightInspection(client, validInspectionOpts);
      },
      (err) => {
        // 1. Primary failure is preserved as primary error
        assert.ok(err.message.startsWith("Preflight inspection failed: Primary inspection catalog error"));
        // 2. Both cleanup failures are safely reported
        assert.ok(err.message.includes("Cleanup failed:"));
        assert.ok(err.message.includes("ROLLBACK failed: Rollback failed"));
        assert.ok(err.message.includes("client closure failed: Close failed"));
        // 3. Credentials, URLs, and sensitive host details are sanitized in message
        assert.ok(!err.message.includes("secret_inspect_pass"));
        assert.ok(!err.message.includes("secret_rollback_token"));
        assert.ok(!err.message.includes("tok_leak"));
        assert.ok(!err.message.includes("ep-host.neon.tech"));
        assert.ok(!err.message.includes("ep-rb-host.neon.tech"));
        assert.ok(!err.message.includes("ep-close-host.neon.tech"));
        assert.ok(err.message.includes("password=[REDACTED]"));
        assert.ok(err.message.includes("token=[REDACTED]"));
        assert.ok(err.message.includes("[REDACTED_CONNECTION_URL]"));
        assert.ok(err.message.includes("[REDACTED_HOST]"));

        // 4. Surfaced error.stack contains no sensitive values
        assert.ok(typeof err.stack === "string");
        assert.ok(!err.stack.includes("secret_inspect_pass"));
        assert.ok(!err.stack.includes("secret_rollback_token"));
        assert.ok(!err.stack.includes("tok_leak"));
        assert.ok(!err.stack.includes("ep-host.neon.tech"));
        assert.ok(!err.stack.includes("ep-rb-host.neon.tech"));
        assert.ok(!err.stack.includes("ep-close-host.neon.tech"));
        assert.ok(err.stack.includes("password=[REDACTED]"));
        assert.ok(err.stack.includes("[REDACTED_CONNECTION_URL]"));
        assert.ok(err.stack.includes("[REDACTED_HOST]"));
        return true;
      }
    );

    // Client cleanup was attempted but failed, so isClosed remains false
    assert.equal(client.isClosed, false);
  });
});

describe("Team Isolation — Preflight CLI Subprocess Offline Safety", () => {
  function runPreflightSubprocess(cliArgs = []) {
    // Minimal allowlist of environment variables strictly required to spawn Node on Windows.
    // Excludes all application, database, and credential variables (DATABASE_URL is never copied).
    const REQUIRED_WINDOWS_ENV_KEYS = [
      "SYSTEMROOT", // Required by Windows kernel and C-runtime to locate critical OS DLLs (e.g. kernel32.dll)
      "SystemRoot",
      "WINDIR",     // Windows system directory reference
      "windir",
      "PATH",       // Required for standard runtime DLL resolution
      "Path",
      "PATHEXT",    // Required for Windows executable extension resolution
      "TEMP",       // OS temporary directory path
      "TMP",
    ];

    const minimalEnv = {};
    for (const key of REQUIRED_WINDOWS_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        minimalEnv[key] = process.env[key];
      }
    }

    return spawnSync(
      process.execPath,
      ["scripts/preflight-migration.mjs", ...cliArgs],
      {
        cwd: process.cwd(),
        env: minimalEnv,
        encoding: "utf-8",
        timeout: 5000,
      }
    );
  }

  it("exits with status 0 in preview/safe mode with zero connection when no arguments are provided", () => {
    const res = runPreflightSubprocess([]);
    assert.equal(res.status, 0, "Preview mode must exit with status 0");
    assert.ok(res.stdout.includes("Migration Preflight Audit (DRY-RUN / PREVIEW MODE)"));
    assert.ok(res.stdout.includes("Safety guard active: Zero database queries executed."));
    assert.ok(res.stdout.includes("This script is strictly READ-ONLY."));
  });

  it("fails safely with status 1 when --run-read-only is supplied without --confirm-target", () => {
    const res = runPreflightSubprocess(["--run-read-only"]);
    assert.equal(res.status, 1, "Must exit with status 1 on missing target");
    assert.ok(res.stderr.includes("'--confirm-target <database-name>' is required"));
  });

  it("fails safely with status 1 when --confirm-endpoint is missing", () => {
    const res = runPreflightSubprocess(["--run-read-only", "--confirm-target", "staging_db"]);
    assert.equal(res.status, 1, "Must exit with status 1 on missing endpoint");
    assert.ok(res.stderr.includes("'--confirm-endpoint <exact-hostname>' is required"));
  });

  it("fails safely with status 1 when a partial endpoint hostname (e.g. ep-staging) is supplied", () => {
    const res = runPreflightSubprocess([
      "--run-read-only",
      "--confirm-target",
      "staging_db",
      "--confirm-endpoint",
      "ep-staging",
    ]);
    assert.equal(res.status, 1, "Must exit with status 1 on partial endpoint");
    assert.ok(res.stderr.includes("Malformed '--confirm-endpoint' value"));
    assert.ok(res.stderr.includes("Partial prefixes, URLs, paths, and ports are rejected"));
  });

  it("fails safely with status 1 when a malformed database identifier is supplied", () => {
    const res = runPreflightSubprocess([
      "--run-read-only",
      "--confirm-target",
      "staging db with spaces!",
      "--confirm-endpoint",
      "ep-staging-123.us-east-2.aws.neon.tech",
    ]);
    assert.equal(res.status, 1, "Must exit with status 1 on malformed database identifier");
    assert.ok(res.stderr.includes("Malformed '--confirm-target' value"));
  });

  it("fails safely with status 1 when option flags are supplied in place of argument values", () => {
    // Flag passed in place of target value
    const resTargetFlag = runPreflightSubprocess([
      "--run-read-only",
      "--confirm-target",
      "--confirm-endpoint",
    ]);
    assert.equal(resTargetFlag.status, 1);
    assert.ok(resTargetFlag.stderr.includes("'--confirm-target <database-name>' is required"));

    // Flag passed in place of endpoint value
    const resEndpointFlag = runPreflightSubprocess([
      "--run-read-only",
      "--confirm-target",
      "staging_db",
      "--confirm-endpoint",
      "--help",
    ]);
    assert.equal(resEndpointFlag.status, 1);
    assert.ok(resEndpointFlag.stderr.includes("'--confirm-endpoint <exact-hostname>' is required"));
  });
});

describe("Team Isolation — Offline Hostname Parsing, Normalization, & Environment Safety", () => {
  it("parses unquoted, double-quoted, single-quoted, CRLF, and commented environment variables", () => {
    const sampleEnv = [
      "# Comment line to ignore",
      "",
      "UNQUOTED_URL=postgresql://user:pass@ep-staging.us-east-2.aws.neon.tech/neondb",
      'DOUBLE_QUOTED_URL="postgresql://user:pass@ep-staging-double.us-east-2.aws.neon.tech/neondb"\r',
      "SINGLE_QUOTED_URL='postgresql://user:pass@ep-staging-single.us-east-2.aws.neon.tech/neondb'\r",
      "COMMENTED_URL=postgresql://user:pass@ep-staging-comment.us-east-2.aws.neon.tech/neondb # inline comment",
      "DUPLICATE_KEY=first_wins",
      "DUPLICATE_KEY=second_ignored",
      "   WHITESPACE_KEY   =   value_trimmed   ",
    ].join("\n");

    const parsed = parseEnvContent(sampleEnv);
    assert.equal(parsed.UNQUOTED_URL, "postgresql://user:pass@ep-staging.us-east-2.aws.neon.tech/neondb");
    assert.equal(parsed.DOUBLE_QUOTED_URL, "postgresql://user:pass@ep-staging-double.us-east-2.aws.neon.tech/neondb");
    assert.equal(parsed.SINGLE_QUOTED_URL, "postgresql://user:pass@ep-staging-single.us-east-2.aws.neon.tech/neondb");
    assert.equal(parsed.COMMENTED_URL, "postgresql://user:pass@ep-staging-comment.us-east-2.aws.neon.tech/neondb");
    assert.equal(parsed.DUPLICATE_KEY, "first_wins");
    assert.equal(parsed.WHITESPACE_KEY, "value_trimmed");
    assert.equal(parsed["# Comment line to ignore"], undefined);
  });

  it("extracts and normalizes hostnames accurately across diverse URL structures", () => {
    // Standard URL
    assert.equal(
      extractHostname("postgres://user:pass@ep-cool-dawn-123.us-east-2.aws.neon.tech/neondb"),
      "ep-cool-dawn-123.us-east-2.aws.neon.tech"
    );
    // Uppercase normalization
    assert.equal(
      extractHostname("POSTGRESQL://USER:PASS@EP-COOL-DAWN-123.US-EAST-2.AWS.NEON.TECH/NEONDB"),
      "ep-cool-dawn-123.us-east-2.aws.neon.tech"
    );
    // Trailing dot normalization
    assert.equal(
      normalizeHostname("ep-staging-123.us-east-2.aws.neon.tech."),
      "ep-staging-123.us-east-2.aws.neon.tech"
    );
    // Hostname without scheme
    assert.equal(
      extractHostname("ep-cool-dawn-123.us-east-2.aws.neon.tech"),
      "ep-cool-dawn-123.us-east-2.aws.neon.tech"
    );
    // Invalid / empty inputs
    assert.equal(extractHostname(""), "");
    assert.equal(extractHostname(null), "");
    assert.equal(extractHostname(undefined), "");
    assert.equal(extractHostname("not-a-valid-url:::"), "");
  });

  it("enforces strict endpoint validation and rejects partial, malformed, or mismatched endpoints", () => {
    // Valid endpoints
    assert.equal(isValidEndpointIdentifier("ep-cool-dawn-123.us-east-2.aws.neon.tech"), true);
    assert.equal(isValidEndpointIdentifier("localhost"), true);
    assert.equal(isValidEndpointIdentifier("127.0.0.1"), true);

    // Partial prefix rejection (must not accept bare prefix like 'ep-staging')
    assert.equal(isValidEndpointIdentifier("ep-staging"), false);
    assert.equal(isValidEndpointIdentifier("ep-staging-123"), false);

    // Malformed formats (ports, schemes, paths, whitespace)
    assert.equal(isValidEndpointIdentifier("ep-staging.neon.tech:5432"), false);
    assert.equal(isValidEndpointIdentifier("https://ep-staging.neon.tech"), false);
    assert.equal(isValidEndpointIdentifier("ep-staging.neon.tech/neondb"), false);
    assert.equal(isValidEndpointIdentifier("ep-staging .neon.tech"), false);
    assert.equal(isValidEndpointIdentifier("-leading-dash.neon.tech"), false);

    // Strict inequality: different staging endpoints never match
    const ep1 = normalizeHostname("ep-staging-alpha.us-east-2.aws.neon.tech");
    const ep2 = normalizeHostname("ep-staging-beta.us-east-2.aws.neon.tech");
    assert.notEqual(ep1, ep2);
    assert.equal(ep1 === ep2, false);
  });

  it("masks target host format while maintaining zero secret leakage", () => {
    assert.equal(
      sanitizeTargetHost("postgres://user:pass@ep-cool-dawn-123.us-east-2.aws.neon.tech/neondb"),
      "ep-cool***.us-east-2.aws.neon.tech"
    );
    assert.equal(sanitizeTargetHost("localhost"), "localhost");
    assert.equal(sanitizeTargetHost("127.0.0.1"), "127.0.0.1");
    assert.equal(sanitizeTargetHost(""), "[MASKED_HOST]");
    assert.equal(sanitizeTargetHost(null), "[MASKED_HOST]");
  });
});





