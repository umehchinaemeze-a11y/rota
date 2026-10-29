import crypto from "node:crypto";
import type { SessionPayload } from "../../../lib/auth.ts";
import { createSessionToken } from "../../../lib/auth.ts";
import { getAuthSecret, serializeSessionCookie } from "../../../lib/session.ts";

export type CreateTeamDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
  getSecret?: () => string;
};

let prodDepsPromise: Promise<{
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
}> | null = null;

async function loadProductionDependencies() {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("../../../lib/db.ts"),
      import("../../../lib/session.ts"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export function generateBaseSlug(name: string): string {
  const normalized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const base = normalized.length > 0 ? normalized : "workspace";
  // Truncate to maximum 60 characters to leave headroom for collision suffixes (column max: 100)
  return base.slice(0, 60);
}

export async function handleCreateTeam(
  request: Request,
  deps: CreateTeamDependencies = {}
): Promise<Response> {
  try {
    // 1. Resolve dependencies
    const { getSessionUser: prodGetSessionUser, sql: prodSql } =
      !deps.getSessionUser || !deps.sql
        ? await loadProductionDependencies()
        : { getSessionUser: deps.getSessionUser, sql: deps.sql };

    const resolveSessionUser = deps.getSessionUser ?? prodGetSessionUser;
    const executeSql = deps.sql ?? prodSql;
    const secret = deps.getSecret ? deps.getSecret() : getAuthSecret();

    // 2. Authenticate caller
    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser || !sessionUser.userId) {
      return Response.json(
        { error: "Authentication required. Please sign in to create a workspace." },
        { status: 401 }
      );
    }

    // 3. Gatekeeping: Reject users who already have any team membership
    let existingMemberships: any[] = [];
    try {
      existingMemberships = await executeSql`
        SELECT id, team_id
        FROM team_memberships
        WHERE user_id = ${sessionUser.userId}
        LIMIT 1;
      `;
    } catch (membershipErr) {
      console.error("Failed to check existing memberships:", membershipErr);
      return Response.json(
        { error: "Unable to verify existing workspace memberships. Please try again." },
        { status: 500 }
      );
    }

    if (existingMemberships && existingMemberships.length > 0) {
      return Response.json(
        {
          error:
            "Account is already assigned to a workspace. Initial workspace creation is restricted to unassigned users.",
        },
        { status: 403 }
      );
    }

    // 4. Parse and validate JSON request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object") {
      return Response.json(
        { error: "Workspace name is required." },
        { status: 400 }
      );
    }

    const typedBody = body as Record<string, unknown>;
    const name = typeof typedBody.name === "string" ? typedBody.name.trim() : "";

    if (!name || name.length < 2 || name.length > 100) {
      return Response.json(
        { error: "Workspace name must be between 2 and 100 characters." },
        { status: 400 }
      );
    }

    // 5. Generate slug and handle potential collisions with bounded retries (max 3 attempts)
    const baseSlug = generateBaseSlug(name);
    let chosenSlug = baseSlug;

    // Pre-check slug availability
    try {
      const existingSlug = await executeSql`
        SELECT id FROM teams WHERE slug = ${chosenSlug} LIMIT 1;
      `;
      if (existingSlug && existingSlug.length > 0) {
        const suffix = crypto.randomBytes(2).toString("hex");
        chosenSlug = `${baseSlug.slice(0, 90)}-${suffix}`;
      }
    } catch {
      // If pre-check fails, continue to bounded insert loop
    }

    let createdRows: any[] = [];
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Atomic single-statement CTE insertion:
        // Creates the teams row and team_memberships row atomically in PostgreSQL.
        // If either insert fails, PostgreSQL aborts the entire statement.
        // Does NOT modify users.role, preserving global user position.
        createdRows = await executeSql`
          WITH new_team AS (
            INSERT INTO teams (name, slug)
            VALUES (${name}, ${chosenSlug})
            RETURNING id, name, slug
          ),
          new_membership AS (
            INSERT INTO team_memberships (user_id, team_id, role, is_default)
            SELECT ${sessionUser.userId}, new_team.id, 'Owner', TRUE
            FROM new_team
            RETURNING id, team_id, role
          )
          SELECT
            new_team.id AS team_id,
            new_team.name AS team_name,
            new_team.slug AS team_slug,
            new_membership.id AS membership_id,
            new_membership.role AS role
          FROM new_team, new_membership;
        `;

        if (createdRows && createdRows.length > 0) {
          break; // Successfully created
        }
      } catch (insertError: any) {
        const errorMsg = String(insertError?.message || "");
        const constraintName = String(insertError?.constraint || "").toLowerCase();
        const errorDetail = String(insertError?.detail || "");

        // 1. Identify teams slug uniqueness conflicts
        const isSlugCollision =
          constraintName === "teams_slug_key" ||
          errorMsg.includes("teams_slug_key") ||
          (insertError?.code === "23505" &&
            (errorMsg.includes("teams_slug") ||
              errorMsg.includes("slug") ||
              errorDetail.includes("slug")));

        if (isSlugCollision && attempt < MAX_ATTEMPTS) {
          // Bounded retry with randomized suffix
          const retrySuffix = crypto.randomBytes(attempt === 1 ? 2 : 3).toString("hex");
          chosenSlug = `${baseSlug.slice(0, 88)}-${retrySuffix}`;
          continue;
        }

        // 2. Identify membership uniqueness conflicts (e.g. concurrent creation)
        const isMembershipCollision =
          constraintName === "idx_team_memberships_user_default" ||
          constraintName === "team_memberships_user_id_team_id_key" ||
          errorMsg.includes("idx_team_memberships_user_default") ||
          errorMsg.includes("team_memberships") ||
          (insertError?.code === "23505" &&
            (errorMsg.includes("is_default") ||
              errorDetail.includes("user_id") ||
              constraintName.includes("team_memberships")));

        if (isMembershipCollision) {
          console.warn("Workspace membership conflict encountered during creation:", errorMsg);
          return Response.json(
            {
              error:
                "Account is already assigned to a workspace. Initial workspace creation is restricted to unassigned users.",
            },
            { status: 409 }
          );
        }

        if (isSlugCollision) {
          return Response.json(
            { error: "Unable to allocate a unique workspace identifier. Please choose a different name." },
            { status: 409 }
          );
        }

        console.error("Workspace atomic creation failed:", errorMsg);
        return Response.json(
          { error: "Failed to create workspace. Please try again." },
          { status: 500 }
        );
      }
    }

    if (!createdRows || createdRows.length === 0) {
      return Response.json(
        { error: "Failed to create workspace. Please try again." },
        { status: 500 }
      );
    }

    const createdTeam = createdRows[0];

    // 6. Issue updated session cookie with the new workspace teamId and active role
    const updatedToken = createSessionToken(
      {
        userId: sessionUser.userId,
        email: sessionUser.email,
        name: sessionUser.name,
        role: "Owner",
        teamId: createdTeam.team_id,
      },
      secret
    );

    return Response.json(
      {
        success: true,
        message: "Workspace created successfully.",
        team: {
          id: createdTeam.team_id,
          name: createdTeam.team_name,
          slug: createdTeam.team_slug,
          role: createdTeam.role,
        },
      },
      {
        status: 201,
        headers: {
          "Set-Cookie": serializeSessionCookie(updatedToken),
        },
      }
    );
  } catch (error) {
    console.error("Workspace creation processing error occurred.");
    return Response.json(
      { error: "An unexpected error occurred while creating workspace. Please try again." },
      { status: 500 }
    );
  }
}

export async function handleGetTeams(
  deps: CreateTeamDependencies = {}
): Promise<Response> {
  try {
    const { getSessionUser: prodGetSessionUser, sql: prodSql } =
      !deps.getSessionUser || !deps.sql
        ? await loadProductionDependencies()
        : { getSessionUser: deps.getSessionUser, sql: deps.sql };

    const resolveSessionUser = deps.getSessionUser ?? prodGetSessionUser;
    const executeSql = deps.sql ?? prodSql;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser || !sessionUser.userId) {
      return Response.json(
        { error: "Authentication required to view workspaces." },
        { status: 401 }
      );
    }

    const memberships = await executeSql`
      SELECT
        t.id,
        t.name,
        t.slug,
        tm.role,
        tm.is_default
      FROM teams t
      JOIN team_memberships tm ON tm.team_id = t.id
      WHERE tm.user_id = ${sessionUser.userId}
      ORDER BY tm.is_default DESC, t.name ASC;
    `;

    return Response.json({
      teams: memberships || [],
    });
  } catch (error) {
    console.error("Failed to list workspaces:", error);
    return Response.json(
      { error: "Failed to list workspaces." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return handleGetTeams();
}

export async function POST(request: Request) {
  return handleCreateTeam(request);
}
