import { canManageTeamShiftRecord, isManagerRole } from "../../../../lib/permissions.ts";
import type { SessionPayload } from "../../../../lib/auth.ts";

export type RouteContext = {
  params: Promise<{ id: string }>;
};

export type ShiftItemRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<Required<ShiftItemRouteDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<ShiftItemRouteDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("@/lib/db"),
      import("@/lib/session"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleGetShiftById(
  request: Request,
  context: RouteContext,
  dependencies?: ShiftItemRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    // 1. Authenticate caller and obtain authoritative team membership
    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required. Please sign in to view shift details." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Access denied. You are not assigned to an active team." },
        { status: 403 }
      );
    }

    const { id } = await context.params;
    const numericId = parseInt(id, 10);

    if (Number.isNaN(numericId) || numericId <= 0) {
      return Response.json({ error: "Invalid shift ID." }, { status: 400 });
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    // 2. Query shift strictly scoped by both shift ID and authenticated user's team ID.
    // Shifts belonging to other teams return 404 to avoid leaking existence.
    const rows = await executeSql`
      SELECT
        id,
        employee_name,
        role,
        user_id,
        team_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day,
        created_at
      FROM shifts
      WHERE id = ${numericId} AND team_id = ${sessionUser.teamId}
      LIMIT 1;
    `;

    if (!rows || rows.length === 0) {
      return Response.json({ error: "Shift not found." }, { status: 404 });
    }

    return Response.json(rows[0]);
  } catch (error) {
    console.error("Failed to fetch shift by ID:", error);
    return Response.json(
      { error: "Unable to fetch shift details." },
      { status: 500 }
    );
  }
}

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetShiftById(request, context, deps);
}

export async function handlePutShift(
  request: Request,
  context: RouteContext,
  dependencies?: ShiftItemRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    // 1. Authenticate caller and obtain authoritative team membership
    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required. Please sign in to edit shifts." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Access denied. You are not assigned to an active team." },
        { status: 403 }
      );
    }

    // 2. Validate shift ID parameter
    const { id } = await context.params;
    const numericId = parseInt(id, 10);
    if (Number.isNaN(numericId) || numericId <= 0) {
      return Response.json({ error: "Invalid shift ID." }, { status: 400 });
    }

    // 3. Parse and validate JSON request body
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
        { error: "A valid shift date and role are required." },
        { status: 400 }
      );
    }

    const typedBody = body as Record<string, unknown>;
    const role = typeof typedBody.role === "string" ? typedBody.role.trim() : "";
    const shiftDay = typeof typedBody.shiftDay === "string" ? typedBody.shiftDay.trim() : "";

    if (!role || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDay)) {
      return Response.json(
        { error: "Role and a valid shift date (YYYY-MM-DD) are required." },
        { status: 400 }
      );
    }

    const parsedDate = new Date(`${shiftDay}T00:00:00.000Z`);
    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== shiftDay
    ) {
      return Response.json(
        { error: "The provided shift date is invalid." },
        { status: 400 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    // 4. Retrieve existing shift from database scoped to team_id.
    // Cross-team updates return 404 to avoid leaking shift existence across tenants.
    const existing = await executeSql`
      SELECT id, employee_name, role, user_id, team_id
      FROM shifts
      WHERE id = ${numericId} AND team_id = ${sessionUser.teamId}
      LIMIT 1;
    `;

    if (!existing || existing.length === 0) {
      return Response.json({ error: "Shift not found." }, { status: 404 });
    }

    const existingShift = existing[0];

    // 5. Server-side team-scoped permission check.
    const isAuthorized = canManageTeamShiftRecord(sessionUser, existingShift);
    if (!isAuthorized) {
      return Response.json(
        {
          error:
            "Unauthorized: You can only edit shifts assigned to your account within your team unless you hold a management role.",
        },
        { status: 403 }
      );
    }

    const isManager = isManagerRole(sessionUser.role);

    // 6. Ownership preservation:
    // Ordinary employees can only edit shift dates/roles on their own shifts.
    // Managers can also reassign or edit the employee name, restricted to the same team.
    let updatedEmployeeName = existingShift.employee_name;
    let updatedUserId = existingShift.user_id;

    if (isManager) {
      const inputName =
        typeof typedBody.employeeName === "string"
          ? typedBody.employeeName.trim()
          : "";

      if (inputName) {
        let userMatch: { id: number; name: string }[] = [];
        try {
          userMatch = await executeSql`
            SELECT u.id, u.name
            FROM users u
            JOIN team_memberships tm ON tm.user_id = u.id
            WHERE tm.team_id = ${sessionUser.teamId}
              AND LOWER(TRIM(u.name)) = ${inputName.toLowerCase()}
            LIMIT 2;
          `;
        } catch (dbError) {
          console.error("Failed to verify team membership for reassigned employee:", dbError);
          return Response.json(
            { error: "Unable to verify employee team membership." },
            { status: 500 }
          );
        }

        if (!userMatch || userMatch.length === 0) {
          return Response.json(
            { error: "Assigned employee must be an active member of your team." },
            { status: 400 }
          );
        }

        if (userMatch.length > 1) {
          return Response.json(
            { error: "Multiple team members share this name. Unable to assign shift unambiguously." },
            { status: 400 }
          );
        }

        updatedUserId = userMatch[0].id;
        updatedEmployeeName = userMatch[0].name;
      }
    } else {
      // Ensure the shift remains strictly tied to the authenticated user's ID
      updatedUserId = sessionUser.userId;
      updatedEmployeeName = sessionUser.name;
    }

    // 7. Parameterized database update strictly scoped to shift id and team_id
    const result = await executeSql`
      UPDATE shifts
      SET
        employee_name = ${updatedEmployeeName},
        role = ${role},
        shift_day = ${shiftDay},
        user_id = ${updatedUserId}
      WHERE id = ${numericId} AND team_id = ${sessionUser.teamId}
      RETURNING
        id,
        employee_name,
        role,
        user_id,
        team_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day,
        created_at;
    `;

    return Response.json(result[0], { status: 200 });
  } catch (error) {
    console.error("Failed to update shift:", error);
    return Response.json(
      { error: "Unable to update shift." },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handlePutShift(request, context, deps);
}

export async function handleDeleteShift(
  request: Request,
  context: RouteContext,
  dependencies?: ShiftItemRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    // 1. Authenticate caller and obtain authoritative team membership
    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required. Please sign in to delete shifts." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Access denied. You are not assigned to an active team." },
        { status: 403 }
      );
    }

    // 2. Validate shift ID parameter
    const { id } = await context.params;
    const numericId = parseInt(id, 10);
    if (Number.isNaN(numericId) || numericId <= 0) {
      return Response.json({ error: "Invalid shift ID." }, { status: 400 });
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    // 3. Retrieve existing shift from database scoped to team_id.
    // Cross-team deletions return 404 to avoid leaking shift existence.
    const existing = await executeSql`
      SELECT id, employee_name, role, user_id, team_id
      FROM shifts
      WHERE id = ${numericId} AND team_id = ${sessionUser.teamId}
      LIMIT 1;
    `;

    if (!existing || existing.length === 0) {
      return Response.json({ error: "Shift not found." }, { status: 404 });
    }

    const existingShift = existing[0];

    // 4. Server-side team-scoped permission check
    const isAuthorized = canManageTeamShiftRecord(sessionUser, existingShift);
    if (!isAuthorized) {
      return Response.json(
        {
          error:
            "Unauthorized: You can only delete shifts assigned to your account within your team unless you hold a management role.",
        },
        { status: 403 }
      );
    }

    // 5. Parameterized database deletion strictly scoped to team_id
    await executeSql`
      DELETE FROM shifts
      WHERE id = ${numericId} AND team_id = ${sessionUser.teamId};
    `;

    return Response.json(
      { success: true, message: "Shift permanently removed.", id: numericId },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failed to delete shift:", error);
    return Response.json(
      { error: "Unable to delete shift." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleDeleteShift(request, context, deps);
}
