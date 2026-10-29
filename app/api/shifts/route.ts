import { isManagerRole } from "../../../lib/permissions.ts";
import type { SessionPayload } from "../../../lib/auth.ts";

export type ShiftRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<Required<ShiftRouteDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<ShiftRouteDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("@/lib/db"),
      import("@/lib/session"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleGetShifts(
  dependencies?: ShiftRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to view shifts." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active team membership found for this account." },
        { status: 403 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    const shifts = await executeSql`
      SELECT
        id,
        employee_name,
        role,
        user_id,
        team_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day,
        created_at
      FROM shifts
      WHERE team_id = ${sessionUser.teamId}
      ORDER BY shift_day ASC, id ASC
    `;

    return Response.json(shifts);
  } catch (error) {
    console.error("Failed to fetch shifts:", error);
    return Response.json(
      { error: "Unable to fetch shifts." },
      { status: 500 }
    );
  }
}

export async function GET(): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetShifts(deps);
}

export async function handlePostShift(
  request: Request,
  dependencies?: ShiftRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    // 1. Authenticate session and fetch authoritative role from database
    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required. Please sign in to create shifts." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: An active team membership is required to create shifts." },
        { status: 403 }
      );
    }

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
        { error: "Shift date is required." },
        { status: 400 }
      );
    }

    const typedBody = body as Record<string, unknown>;
    const shiftDay =
      typeof typedBody.shiftDay === "string" ? typedBody.shiftDay.trim() : "";

    // 2. Validate shift date format and calendar validity
    if (!shiftDay || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDay)) {
      return Response.json(
        { error: "A valid shift date (YYYY-MM-DD) is required." },
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

    // 3. Ownership and role rules:
    // Ignore all client-supplied identity/role headers or impersonation fields.
    const isManager = isManagerRole(sessionUser.role);

    let finalEmployeeName = sessionUser.name;
    let finalRole = sessionUser.role;
    let finalUserId = sessionUser.userId;

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    if (isManager) {
      // Managers may schedule for another employee in the SAME team if provided in the body
      const inputName =
        typeof typedBody.employeeName === "string"
          ? typedBody.employeeName.trim()
          : "";
      const inputRole =
        typeof typedBody.role === "string" ? typedBody.role.trim() : "";

      if (inputName) {
        let userMatch: { id: number; name: string; role: string }[] = [];
        try {
          userMatch = await executeSql`
            SELECT u.id, u.name, tm.role
            FROM users u
            JOIN team_memberships tm ON tm.user_id = u.id
            WHERE tm.team_id = ${sessionUser.teamId}
              AND LOWER(TRIM(u.name)) = ${inputName.toLowerCase()}
            LIMIT 2;
          `;
        } catch (dbError) {
          console.error("Failed to verify team membership for assigned employee:", dbError);
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

        finalUserId = userMatch[0].id;
        finalEmployeeName = userMatch[0].name;
        finalRole = inputRole || userMatch[0].role;
      } else if (inputRole) {
        finalRole = inputRole;
      }
    }

    // 4. Parameterized insert into database with server-assigned team_id
    const result = await executeSql`
      INSERT INTO shifts (employee_name, role, shift_day, user_id, team_id)
      VALUES (${finalEmployeeName}, ${finalRole}, ${shiftDay}, ${finalUserId}, ${sessionUser.teamId})
      RETURNING
        id,
        employee_name,
        role,
        user_id,
        team_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day,
        created_at;
    `;

    return Response.json(result[0], { status: 201 });
  } catch (error) {
    console.error("Failed to create shift:", error);
    return Response.json(
      { error: "Unable to create shift." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handlePostShift(request, deps);
}
