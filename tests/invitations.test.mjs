import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createInvitationToken,
  verifyInvitationToken,
  canInviteToWorkspace,
  INVITATION_TTL_SECONDS,
} from "../lib/invitations.ts";
import {
  handleCreateInvitation,
  handleVerifyInvitation,
} from "../app/api/teams/invitations/route.ts";
import { handleAcceptInvitation } from "../app/api/teams/invitations/accept/route.ts";
import { verifySessionToken } from "../lib/auth.ts";

const TEST_SECRET = "test_auth_secret_0123456789abcdef0123456789abcdef";

describe("Team Invitations — Cryptographic Token Primitives", () => {
  it("creates a signed tamper-evident invitation token", () => {
    const payload = {
      teamId: 42,
      teamName: "St. Jude Clinic",
      role: "Front Desk",
      email: "nurse@clinic.example",
      invitedBy: 1,
      invitedByName: "Dr. Admin",
    };

    const token = createInvitationToken(payload, TEST_SECRET);
    assert.equal(typeof token, "string");
    assert.ok(token.includes("."));

    const verified = verifyInvitationToken(token, TEST_SECRET);
    assert.ok(verified !== null);
    assert.equal(verified.teamId, 42);
    assert.equal(verified.teamName, "St. Jude Clinic");
    assert.equal(verified.role, "Front Desk");
    assert.equal(verified.email, "nurse@clinic.example");
    assert.equal(verified.invitedBy, 1);
    assert.equal(verified.invitedByName, "Dr. Admin");
    assert.ok(verified.exp > Math.floor(Date.now() / 1000));
  });

  it("rejects tokens signed with a different secret", () => {
    const payload = {
      teamId: 10,
      teamName: "Apex Rota",
      role: "Operations",
      invitedBy: 5,
      invitedByName: "Operations Lead",
    };

    const token = createInvitationToken(payload, TEST_SECRET);
    const result = verifyInvitationToken(token, "wrong_secret_12345678901234567890123456789012");
    assert.equal(result, null);
  });

  it("rejects tampered payloads", () => {
    const payload = {
      teamId: 10,
      teamName: "Apex Rota",
      role: "Front Desk",
      invitedBy: 2,
      invitedByName: "Lead Admin",
    };

    const token = createInvitationToken(payload, TEST_SECRET);
    const [encoded, sig] = token.split(".");

    // Tamper with payload (escalate role to Admin)
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    decoded.role = "Admin";
    const tamperedEncoded = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const tamperedToken = `${tamperedEncoded}.${sig}`;

    assert.equal(verifyInvitationToken(tamperedToken, TEST_SECRET), null);
  });

  it("rejects expired invitation tokens", () => {
    const payload = {
      teamId: 10,
      teamName: "Apex Rota",
      role: "Supervisor",
      invitedBy: 1,
      invitedByName: "Owner",
    };

    // TTL = -10 seconds (already expired)
    const expiredToken = createInvitationToken(payload, TEST_SECRET, -10);
    assert.equal(verifyInvitationToken(expiredToken, TEST_SECRET), null);
  });

  it("correctly identifies manager roles authorized to invite", () => {
    assert.equal(canInviteToWorkspace("Owner"), true);
    assert.equal(canInviteToWorkspace("Admin"), true);
    assert.equal(canInviteToWorkspace("Supervisor"), true);
    assert.equal(canInviteToWorkspace("Manager"), true);
    assert.equal(canInviteToWorkspace("Operations"), true);

    assert.equal(canInviteToWorkspace("Front Desk"), false);
    assert.equal(canInviteToWorkspace("Customer Support"), false);
    assert.equal(canInviteToWorkspace("Staff"), false);
    assert.equal(canInviteToWorkspace(null), false);
    assert.equal(canInviteToWorkspace(undefined), false);
  });
});

describe("Team Invitations — Creation API Handler (POST /api/teams/invitations)", () => {
  it("rejects unauthenticated requests with HTTP 401", async () => {
    const req = new Request("http://localhost/api/teams/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Front Desk" }),
    });

    const res = await handleCreateInvitation(req, {
      getSessionUser: async () => null,
      sql: async () => [],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Authentication required/);
  });

  it("rejects invitations with invalid role", async () => {
    const user = { userId: 1, name: "Dr. Owner", role: "Owner", email: "owner@rota.local" };
    const req = new Request("http://localhost/api/teams/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "SuperHacker" }),
    });

    const res = await handleCreateInvitation(req, {
      getSessionUser: async () => user,
      sql: async () => [{ team_id: 1, role: "Owner", team_name: "Clinic" }],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Invalid role/);
  });

  it("rejects invitations offering the Owner role", async () => {
    const user = { userId: 1, name: "Dr. Owner", role: "Owner", email: "owner@rota.local" };
    const req = new Request("http://localhost/api/teams/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Owner" }),
    });

    const res = await handleCreateInvitation(req, {
      getSessionUser: async () => user,
      sql: async () => [{ team_id: 1, role: "Owner", team_name: "Clinic" }],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Owner role cannot be granted via team invitation/);
  });

  it("rejects non-manager callers with HTTP 403 Forbidden", async () => {
    const user = { userId: 5, name: "Staff Member", role: "Front Desk", email: "staff@rota.local" };
    const req = new Request("http://localhost/api/teams/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Front Desk" }),
    });

    const res = await handleCreateInvitation(req, {
      getSessionUser: async () => user,
      sql: async () => [{ team_id: 1, role: "Front Desk", team_name: "Clinic" }],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /do not have authority/);
  });

  it("rejects creation when workspace seat limit is reached (HTTP 409 Conflict)", async () => {
    const user = { userId: 1, name: "Dr. Owner", role: "Owner", email: "owner@rota.local" };
    const req = new Request("http://localhost/api/teams/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Front Desk" }),
    });

    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("FROM team_memberships tm")) {
        return [{ team_id: 1, role: "Owner", team_name: "Full Clinic" }];
      }
      if (q.includes("COUNT(*)::int as count")) {
        // Free tier capacity = 5. Already at 5 members.
        return [{ count: 5 }];
      }
      if (q.includes("FROM workspace_subscriptions")) {
        return [{ plan_id: "free", seats: 5, status: "active" }];
      }
      return [];
    };

    const res = await handleCreateInvitation(req, {
      getSessionUser: async () => user,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /seat capacity/i);
  });

  it("successfully creates invitation and returns link when authorized and capacity is available", async () => {
    const user = { userId: 1, name: "Dr. Owner", role: "Owner", email: "owner@rota.local" };
    const req = new Request("http://localhost/api/teams/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Supervisor", email: "supervisor@clinic.com" }),
    });

    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("FROM team_memberships tm")) {
        return [{ team_id: 10, role: "Owner", team_name: "General Hospital" }];
      }
      if (q.includes("COUNT(*)::int as count")) {
        return [{ count: 2 }]; // 2 active members of 5 allowed
      }
      if (q.includes("FROM workspace_subscriptions")) {
        return [{ plan_id: "free", seats: 5, status: "active" }];
      }
      return [];
    };

    const res = await handleCreateInvitation(req, {
      getSessionUser: async () => user,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.teamId, 10);
    assert.equal(body.teamName, "General Hospital");
    assert.equal(body.role, "Supervisor");
    assert.ok(body.token);
    assert.ok(body.inviteUrl.includes("/invite?token="));

    // Verify generated token
    const verified = verifyInvitationToken(body.token, TEST_SECRET);
    assert.ok(verified !== null);
    assert.equal(verified.teamId, 10);
    assert.equal(verified.email, "supervisor@clinic.com");
  });
});

describe("Team Invitations — Verification API Handler (GET /api/teams/invitations)", () => {
  it("rejects missing token with HTTP 400", async () => {
    const req = new Request("http://localhost/api/teams/invitations");
    const res = await handleVerifyInvitation(req, { getSecret: () => TEST_SECRET });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /token parameter/i);
  });

  it("rejects invalid token with HTTP 400", async () => {
    const req = new Request("http://localhost/api/teams/invitations?token=invalid.token");
    const res = await handleVerifyInvitation(req, { getSecret: () => TEST_SECRET });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid or has expired/i);
  });

  it("returns verified invitation details for valid token", async () => {
    const token = createInvitationToken(
      {
        teamId: 77,
        teamName: "Emergency Care",
        role: "Operations",
        invitedBy: 1,
        invitedByName: "Dr. Admin",
        email: "staff@hospital.org",
      },
      TEST_SECRET
    );

    const req = new Request(`http://localhost/api/teams/invitations?token=${token}`);
    const res = await handleVerifyInvitation(req, { getSecret: () => TEST_SECRET });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.valid, true);
    assert.equal(body.teamId, 77);
    assert.equal(body.teamName, "Emergency Care");
    assert.equal(body.role, "Operations");
    assert.equal(body.invitedByName, "Dr. Admin");
    assert.equal(body.email, "staff@hospital.org");
  });
});

describe("Team Invitations — Acceptance API Handler (POST /api/teams/invitations/accept)", () => {
  it("rejects unauthenticated user with HTTP 401", async () => {
    const req = new Request("http://localhost/api/teams/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "some.token" }),
    });

    const res = await handleAcceptInvitation(req, {
      getSessionUser: async () => null,
      sql: async () => [],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 401);
  });

  it("rejects expired token with HTTP 400", async () => {
    const user = { userId: 20, name: "Nurse Jane", role: "Front Desk", email: "jane@clinic.org" };
    const expiredToken = createInvitationToken(
      {
        teamId: 1,
        teamName: "Clinic",
        role: "Front Desk",
        invitedBy: 1,
        invitedByName: "Owner",
      },
      TEST_SECRET,
      -100
    );

    const req = new Request("http://localhost/api/teams/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: expiredToken }),
    });

    const res = await handleAcceptInvitation(req, {
      getSessionUser: async () => user,
      sql: async () => [],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid or has expired/i);
  });

  it("rejects when user is already a member of the workspace (HTTP 409 Conflict)", async () => {
    const user = { userId: 20, name: "Nurse Jane", role: "Front Desk", email: "jane@clinic.org" };
    const token = createInvitationToken(
      {
        teamId: 5,
        teamName: "Downtown Clinic",
        role: "Front Desk",
        invitedBy: 1,
        invitedByName: "Owner",
      },
      TEST_SECRET
    );

    const req = new Request("http://localhost/api/teams/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("WHERE user_id = ? AND team_id = ?")) {
        return [{ id: 99, role: "Front Desk", is_default: true }];
      }
      return [];
    };

    const res = await handleAcceptInvitation(req, {
      getSessionUser: async () => user,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /already a member/i);
  });

  it("rejects acceptance when seat limit is exceeded (HTTP 409 Conflict)", async () => {
    const user = { userId: 20, name: "Nurse Jane", role: "Front Desk", email: "jane@clinic.org" };
    const token = createInvitationToken(
      {
        teamId: 5,
        teamName: "Full Clinic",
        role: "Front Desk",
        invitedBy: 1,
        invitedByName: "Owner",
      },
      TEST_SECRET
    );

    const req = new Request("http://localhost/api/teams/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("WHERE user_id = ? AND team_id = ?")) {
        return []; // Not yet a member
      }
      if (q.includes("SELECT user_id") && q.includes("FROM team_memberships")) {
        return [
          { user_id: 1 },
          { user_id: 2 },
          { user_id: 3 },
          { user_id: 4 },
          { user_id: 5 },
        ]; // Already at max capacity of 5
      }
      if (q.includes("FROM workspace_subscriptions")) {
        return [{ plan_id: "free", seats: 5, status: "active" }];
      }
      return [];
    };

    const res = await handleAcceptInvitation(req, {
      getSessionUser: async () => user,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /seat capacity/i);
  });

  it("successfully joins workspace, inserts membership, and sets updated session cookie", async () => {
    const user = { userId: 20, name: "Nurse Jane", role: "Staff", email: "jane@clinic.org" };
    const token = createInvitationToken(
      {
        teamId: 5,
        teamName: "Apex Medical",
        role: "Front Desk",
        invitedBy: 1,
        invitedByName: "Dr. Admin",
      },
      TEST_SECRET
    );

    const req = new Request("http://localhost/api/teams/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    let insertedMembership = null;
    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("WHERE user_id = ? AND team_id = ?")) {
        return []; // Not yet a member
      }
      if (q.includes("SELECT user_id") && q.includes("FROM team_memberships")) {
        return [{ user_id: 1 }, { user_id: 2 }]; // 2 active members (seat limit is 5)
      }
      if (q.includes("WHERE user_id = ? AND is_default = TRUE")) {
        return []; // Has no existing default team
      }
      if (q.includes("INSERT INTO team_memberships")) {
        insertedMembership = {
          id: 101,
          team_id: values[0],
          user_id: values[1],
          role: values[2],
          is_default: values[3],
        };
        return [insertedMembership];
      }
      return [];
    };

    const res = await handleAcceptInvitation(req, {
      getSessionUser: async () => user,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.membership.teamId, 5);
    assert.equal(body.membership.teamName, "Apex Medical");
    assert.equal(body.membership.role, "Front Desk");
    assert.equal(body.membership.isDefault, true);

    // Verify DB insertion
    assert.ok(insertedMembership !== null);
    assert.equal(insertedMembership.team_id, 5);
    assert.equal(insertedMembership.user_id, 20);
    assert.equal(insertedMembership.role, "Front Desk");
    assert.equal(insertedMembership.is_default, true);

    // Verify Set-Cookie header updates active teamId in session
    const setCookie = res.headers.get("Set-Cookie");
    assert.ok(setCookie !== null);
    assert.match(setCookie, /rota_session=/);

    // Extract token and verify updated session has teamId = 5
    const sessionTokenMatch = setCookie.match(/rota_session=([^;]+)/);
    assert.ok(sessionTokenMatch);
    const updatedPayload = verifySessionToken(sessionTokenMatch[1], TEST_SECRET);
    assert.ok(updatedPayload !== null);
    assert.equal(updatedPayload.userId, 20);
    assert.equal(updatedPayload.teamId, 5);
  });
});

describe("Team Invitations — Authoritative Plan Limits & Seat Capacity Checks", () => {
  async function executeCreateWithSeats({ planId, seats, memberCount, status = "active" }) {
    const user = { userId: 1, name: "Dr. Owner", role: "Owner", email: "owner@rota.test" };
    const req = new Request("http://localhost/api/teams/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "Staff" }),
    });

    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("FROM team_memberships tm")) {
        return [{ team_id: 10, role: "Owner", team_name: "Capacity Clinic" }];
      }
      if (q.includes("COUNT(*)::int as count")) {
        return [{ count: memberCount }];
      }
      if (q.includes("FROM workspace_subscriptions")) {
        return [{ plan_id: planId, seats: seats, status }];
      }
      return [];
    };

    return handleCreateInvitation(req, {
      getSessionUser: async () => user,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });
  }

  async function executeAcceptWithSeats({ planId, seats, memberCount, status = "active" }) {
    const user = { userId: 9999, name: "New Candidate", role: "Staff", email: "candidate@rota.test" };
    const token = createInvitationToken(
      {
        teamId: 10,
        teamName: "Capacity Clinic",
        role: "Staff",
        invitedBy: 1,
        invitedByName: "Owner",
      },
      TEST_SECRET
    );

    const req = new Request("http://localhost/api/teams/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const mockMembers = Array.from({ length: memberCount }, (_, i) => ({ user_id: i + 1 }));

    const mockSql = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("WHERE user_id = ? AND team_id = ?")) {
        return []; // Not yet a member
      }
      if (q.includes("SELECT user_id") && q.includes("FROM team_memberships")) {
        return mockMembers;
      }
      if (q.includes("FROM workspace_subscriptions")) {
        return [{ plan_id: planId, seats: seats, status }];
      }
      if (q.includes("WHERE user_id = ? AND is_default = TRUE")) {
        return [];
      }
      if (q.includes("INSERT INTO team_memberships")) {
        return [{ id: 101, team_id: 10, user_id: 9999, role: "Staff", is_default: true }];
      }
      return [];
    };

    return handleAcceptInvitation(req, {
      getSessionUser: async () => user,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });
  }

  // 1. Free Tier (5 Seats Limit)
  it("enforces Free tier limit (5 seats): allows creation at 4 members, rejects at 5", async () => {
    const allowRes = await executeCreateWithSeats({ planId: "free", seats: 5, memberCount: 4 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeCreateWithSeats({ planId: "free", seats: 5, memberCount: 5 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity|seat limit/i);
  });

  it("enforces Free tier limit (5 seats): allows acceptance at 4 members, rejects at 5", async () => {
    const allowRes = await executeAcceptWithSeats({ planId: "free", seats: 5, memberCount: 4 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeAcceptWithSeats({ planId: "free", seats: 5, memberCount: 5 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity/i);
  });

  // 2. Starter Tier (15 Seats Limit)
  it("enforces Starter tier limit (15 seats): allows creation at 14 members, rejects at 15", async () => {
    const allowRes = await executeCreateWithSeats({ planId: "starter", seats: 15, memberCount: 14 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeCreateWithSeats({ planId: "starter", seats: 15, memberCount: 15 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity|seat limit/i);
  });

  it("enforces Starter tier limit (15 seats): allows acceptance at 14 members, rejects at 15", async () => {
    const allowRes = await executeAcceptWithSeats({ planId: "starter", seats: 15, memberCount: 14 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeAcceptWithSeats({ planId: "starter", seats: 15, memberCount: 15 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity/i);
  });

  // 3. Pro Tier (50 Seats Limit)
  it("enforces Pro tier limit (50 seats): allows creation at 49 members, rejects at 50", async () => {
    const allowRes = await executeCreateWithSeats({ planId: "pro", seats: 50, memberCount: 49 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeCreateWithSeats({ planId: "pro", seats: 50, memberCount: 50 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity|seat limit/i);
  });

  it("enforces Pro tier limit (50 seats): allows acceptance at 49 members, rejects at 50", async () => {
    const allowRes = await executeAcceptWithSeats({ planId: "pro", seats: 50, memberCount: 49 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeAcceptWithSeats({ planId: "pro", seats: 50, memberCount: 50 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity/i);
  });

  // 4. Enterprise Tier (500 Seats Limit)
  it("enforces Enterprise tier limit (500 seats): allows creation at 499 members, rejects at 500", async () => {
    const allowRes = await executeCreateWithSeats({ planId: "enterprise", seats: 500, memberCount: 499 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeCreateWithSeats({ planId: "enterprise", seats: 500, memberCount: 500 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity|seat limit/i);
  });

  it("enforces Enterprise tier limit (500 seats): allows acceptance at 499 members, rejects at 500", async () => {
    const allowRes = await executeAcceptWithSeats({ planId: "enterprise", seats: 500, memberCount: 499 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeAcceptWithSeats({ planId: "enterprise", seats: 500, memberCount: 500 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity/i);
  });

  // 5. Custom Seats Override (e.g. Starter tier with 25 custom seats)
  it("enforces custom seats override: allows creation at 24, rejects at 25", async () => {
    const allowRes = await executeCreateWithSeats({ planId: "starter", seats: 25, memberCount: 24 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeCreateWithSeats({ planId: "starter", seats: 25, memberCount: 25 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity|seat limit/i);
  });

  it("enforces custom seats override: allows acceptance at 24, rejects at 25", async () => {
    const allowRes = await executeAcceptWithSeats({ planId: "starter", seats: 25, memberCount: 24 });
    assert.equal(allowRes.status, 200);

    const rejectRes = await executeAcceptWithSeats({ planId: "starter", seats: 25, memberCount: 25 });
    assert.equal(rejectRes.status, 409);
    const body = await rejectRes.json();
    assert.match(body.error, /maximum seat capacity/i);
  });

  // 6. Inactive/Canceled Subscription Fallback to Free Tier (5 Seats)
  it("falls back to Free tier (5 seats) when subscription status is canceled", async () => {
    // Even if plan_id is enterprise, canceled status means 5-seat free limit applies
    const rejectRes = await executeCreateWithSeats({
      planId: "enterprise",
      seats: 500,
      memberCount: 5,
      status: "canceled",
    });
    assert.equal(rejectRes.status, 409);

    const rejectAcceptRes = await executeAcceptWithSeats({
      planId: "enterprise",
      seats: 500,
      memberCount: 5,
      status: "canceled",
    });
    assert.equal(rejectAcceptRes.status, 409);
    const body = await rejectAcceptRes.json();
    assert.match(body.error, /maximum seat capacity/i);
  });
});
