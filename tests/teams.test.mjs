import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleCreateTeam, handleGetTeams, generateBaseSlug } from "../app/api/teams/route.ts";
import { verifySessionToken } from "../lib/auth.ts";
import { canManageTeamShiftRecord } from "../lib/permissions.ts";

const TEST_SECRET = "test_auth_secret_0123456789abcdef0123456789abcdef";

describe("Workspace Creation API Handler — Base Slug Generation", () => {
  it("normalizes names to clean URL-safe slugs", () => {
    assert.equal(generateBaseSlug("Apex Health Services"), "apex-health-services");
    assert.equal(generateBaseSlug("  St. Jude's & Co.  "), "st-jude-s-co");
    assert.equal(generateBaseSlug("---Leading---Edge---"), "leading-edge");
    assert.equal(generateBaseSlug("Café & Bistro 2026!"), "caf-bistro-2026");
  });

  it("falls back to 'workspace' for empty or symbol-only names", () => {
    assert.equal(generateBaseSlug(""), "workspace");
    assert.equal(generateBaseSlug("   "), "workspace");
    assert.equal(generateBaseSlug("!@#$%^&*()"), "workspace");
  });

  it("truncates excessively long base slugs to 60 characters", () => {
    const longName = "A".repeat(120);
    const slug = generateBaseSlug(longName);
    assert.ok(slug.length <= 60);
  });
});

describe("Workspace Creation API Handler — Authentication & Authorization Gatekeeping", () => {
  it("rejects unauthenticated requests with HTTP 401 Unauthorized", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Workspace" }),
    });

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => null,
      sql: async () => [],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.match(data.error, /Authentication required/);
  });

  it("rejects users who already belong to an existing workspace with HTTP 403 Forbidden", async () => {
    const existingUser = {
      userId: 5,
      email: "existing@rota.local",
      name: "Existing Member",
      role: "Staff",
      teamId: 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Workspace" }),
    });

    let sqlCalls = 0;
    const mockSql = async (strings, ...values) => {
      sqlCalls++;
      const query = strings.join("?");
      if (query.includes("FROM team_memberships")) {
        // Return existing membership
        return [{ id: 100, team_id: 10 }];
      }
      return [];
    };

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => existingUser,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /already assigned to a workspace/);
  });
});

describe("Workspace Creation API Handler — Request Validation", () => {
  const unassignedUser = {
    userId: 42,
    email: "newowner@rota.local",
    name: "New Owner",
    role: "Front Desk", // Global user role remains Front Desk
    teamId: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("rejects malformed JSON body with HTTP 400", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid-json",
    });

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: async () => [], // No memberships
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /Invalid JSON request body/);
  });

  it("rejects workspace name with fewer than 2 characters with HTTP 400", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A" }),
    });

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: async () => [],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /between 2 and 100 characters/);
  });

  it("rejects workspace name exceeding 100 characters with HTTP 400", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X".repeat(101) }),
    });

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: async () => [],
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /between 2 and 100 characters/);
  });
});

describe("Workspace Creation API Handler — Atomic Creation & Role Isolation", () => {
  const unassignedUser = {
    userId: 88,
    email: "creator@rota.local",
    name: "Adaeze Nwosu",
    role: "Front Desk", // Global user position
    teamId: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("successfully creates workspace, assigns Owner membership, sets session cookie, and does not alter global users.role", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Starlight Clinic" }),
    });

    const capturedQueries = [];
    const mockSql = async (strings, ...values) => {
      const query = strings.join("?");
      capturedQueries.push({ query, values });

      // 1. Check existing memberships -> none
      if (query.includes("FROM team_memberships") && query.includes("SELECT id, team_id")) {
        return [];
      }

      // 2. Pre-check slug -> not taken
      if (query.includes("FROM teams WHERE slug =")) {
        return [];
      }

      // 3. Atomic CTE insertion
      if (query.includes("WITH new_team AS") && query.includes("INSERT INTO teams")) {
        const [nameParam, slugParam, userIdParam] = values;
        assert.equal(nameParam, "Starlight Clinic");
        assert.equal(slugParam, "starlight-clinic");
        assert.equal(userIdParam, 88);

        return [
          {
            team_id: 15,
            team_name: "Starlight Clinic",
            team_slug: "starlight-clinic",
            membership_id: 201,
            role: "Owner",
          },
        ];
      }

      return [];
    };

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 201);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.team.id, 15);
    assert.equal(data.team.name, "Starlight Clinic");
    assert.equal(data.team.slug, "starlight-clinic");
    assert.equal(data.team.role, "Owner");

    // Verify cookie was issued with new teamId and role
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie && setCookie.includes("rota_session="));
    assert.ok(setCookie.toLowerCase().includes("httponly"));

    const tokenMatch = setCookie.match(/rota_session=([^;]+)/);
    assert.ok(tokenMatch);
    const verifiedSession = verifySessionToken(tokenMatch[1], TEST_SECRET);
    assert.ok(verifiedSession);
    assert.equal(verifiedSession.userId, 88);
    assert.equal(verifiedSession.teamId, 15);
    assert.equal(verifiedSession.role, "Owner");

    // Verify global user role is unchanged: users table was NEVER updated
    const updateUsersQuery = capturedQueries.find((q) => q.query.toLowerCase().includes("update users"));
    assert.equal(updateUsersQuery, undefined, "Must NOT update users.role in users table");

    // Verify the created session passes canManageTeamShiftRecord as an Owner
    const isAuthorized = canManageTeamShiftRecord(
      {
        userId: verifiedSession.userId,
        name: verifiedSession.name,
        role: verifiedSession.role, // 'Owner'
        teamId: verifiedSession.teamId, // 15
      },
      {
        id: 99,
        user_id: 2, // Colleague's shift
        employee_name: "Colleague",
        teamId: 15, // Same team
      }
    );
    assert.equal(isAuthorized, true, "New workspace Owner must have management authority within their workspace");
  });
});

describe("Workspace Creation API Handler — Slug Collision & Database Failure Handling", () => {
  const unassignedUser = {
    userId: 90,
    email: "collision@rota.local",
    name: "Collision Tester",
    role: "Front Desk",
    teamId: null,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("handles slug collisions gracefully with bounded retries and suffix allocation", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "General Hospital" }),
    });

    let attemptCount = 0;
    const mockSql = async (strings, ...values) => {
      const query = strings.join("?");

      if (query.includes("FROM team_memberships")) return [];
      if (query.includes("FROM teams WHERE slug =")) return []; // Pre-check passes

      if (query.includes("WITH new_team AS")) {
        attemptCount++;
        if (attemptCount === 1) {
          // Simulate PostgreSQL unique violation on teams.slug
          const err = new Error("duplicate key value violates unique constraint \"teams_slug_key\"");
          err.code = "23505";
          throw err;
        }

        // Second attempt with randomized suffix succeeds
        const slugParam = values[1];
        assert.ok(slugParam.startsWith("general-hospital-"));
        return [
          {
            team_id: 22,
            team_name: "General Hospital",
            team_slug: slugParam,
            membership_id: 301,
            role: "Owner",
          },
        ];
      }

      return [];
    };

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(attemptCount, 2, "Must retry on slug collision");
    assert.ok(data.team.slug.startsWith("general-hospital-"));
  });

  it("returns HTTP 409 Conflict when slug collisions persist past maximum attempts", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Perpetual Collision" }),
    });

    let attemptCount = 0;
    const mockSql = async (strings) => {
      const query = strings.join("?");
      if (query.includes("FROM team_memberships")) return [];
      if (query.includes("FROM teams WHERE slug =")) return [];

      if (query.includes("WITH new_team AS")) {
        attemptCount++;
        const err = new Error("duplicate key value violates unique constraint \"teams_slug_key\"");
        err.code = "23505";
        throw err;
      }
      return [];
    };

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 409);
    assert.equal(attemptCount, 3, "Must stop after 3 bounded attempts");
    const data = await res.json();
    assert.match(data.error, /Unable to allocate a unique workspace identifier/);
  });

  it("does not retry slug generation when a membership uniqueness constraint is violated", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Concurrent Membership Workspace" }),
    });

    let attemptCount = 0;
    const mockSql = async (strings) => {
      const query = strings.join("?");
      if (query.includes("FROM team_memberships")) return [];
      if (query.includes("FROM teams WHERE slug =")) return [];

      if (query.includes("WITH new_team AS")) {
        attemptCount++;
        // Simulate concurrent creation hitting default membership unique index (23505)
        const err = new Error('duplicate key value violates unique constraint "idx_team_memberships_user_default"');
        err.code = "23505";
        err.constraint = "idx_team_memberships_user_default";
        throw err;
      }
      return [];
    };

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    // Must NOT retry as slug collision (attemptCount must be exactly 1)
    assert.equal(attemptCount, 1, "Must NOT retry slug generation on membership constraint failure");
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /already assigned to a workspace/);
  });

  it("fails closed with HTTP 500 without retrying for unknown unique constraint violations", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unknown Constraint Workspace" }),
    });

    let attemptCount = 0;
    const mockSql = async (strings) => {
      const query = strings.join("?");
      if (query.includes("FROM team_memberships")) return [];
      if (query.includes("FROM teams WHERE slug =")) return [];

      if (query.includes("WITH new_team AS")) {
        attemptCount++;
        const err = new Error('duplicate key value violates unique constraint "some_unrelated_key"');
        err.code = "23505";
        err.constraint = "some_unrelated_key";
        throw err;
      }
      return [];
    };

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(attemptCount, 1, "Must NOT retry slug generation on unknown constraint violation");
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.error, "Failed to create workspace. Please try again.");
  });

  it("returns HTTP 500 when database fails without leaking SQL or connection details", async () => {
    const req = new Request("http://localhost/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Error Workspace" }),
    });

    const mockSql = async (strings) => {
      const query = strings.join("?");
      if (query.includes("FROM team_memberships")) {
        throw new Error("Connection terminated unexpectedly: postgresql://secret_user:secret_pw@host/db");
      }
      return [];
    };

    const res = await handleCreateTeam(req, {
      getSessionUser: async () => unassignedUser,
      sql: mockSql,
      getSecret: () => TEST_SECRET,
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.error, "Unable to verify existing workspace memberships. Please try again.");
    assert.doesNotMatch(JSON.stringify(data), /secret_pw/);
    assert.doesNotMatch(JSON.stringify(data), /postgresql/);
  });
});

describe("Workspace Listing API Handler — GET /api/teams", () => {
  it("rejects unauthenticated requests with HTTP 401 Unauthorized", async () => {
    const res = await handleGetTeams({
      getSessionUser: async () => null,
      sql: async () => [],
    });

    assert.equal(res.status, 401);
    const data = await res.json();
    assert.match(data.error, /Authentication required/);
  });

  it("returns authorized workspaces for the authenticated user", async () => {
    const user = {
      userId: 15,
      email: "member@rota.local",
      name: "Member User",
      role: "Owner",
      teamId: 10,
    };

    const mockTeams = [
      { id: 10, name: "Alpha Clinic", slug: "alpha-clinic", role: "Owner", is_default: true },
      { id: 12, name: "Beta Medical", slug: "beta-medical", role: "Staff", is_default: false },
    ];

    const res = await handleGetTeams({
      getSessionUser: async () => user,
      sql: async (strings) => {
        if (strings.join("?").includes("FROM teams t")) {
          return mockTeams;
        }
        return [];
      },
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.teams));
    assert.equal(data.teams.length, 2);
    assert.equal(data.teams[0].name, "Alpha Clinic");
    assert.equal(data.teams[1].name, "Beta Medical");
  });

  it("returns HTTP 500 when database fails without leaking credentials", async () => {
    const user = {
      userId: 15,
      email: "member@rota.local",
      name: "Member User",
      role: "Staff",
      teamId: 10,
    };

    const res = await handleGetTeams({
      getSessionUser: async () => user,
      sql: async () => {
        throw new Error("Connection terminated: postgresql://secret_user:secret_pw@host/db");
      },
    });

    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.error, "Failed to list workspaces.");
    assert.doesNotMatch(JSON.stringify(data), /secret_pw/);
    assert.doesNotMatch(JSON.stringify(data), /postgresql/);
  });
});
