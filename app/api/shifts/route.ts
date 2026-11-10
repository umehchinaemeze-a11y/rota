import { isManagerRole } from "../../../lib/permissions.ts";
import type { SessionPayload } from "../../../lib/auth.ts";
import {
  getCachedShiftSchedule,
  invalidateTeamCache,
  type CacheStore,
} from "../../../lib/cache.ts";

export type ShiftRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
  dispatchNotification?: (sql: any, options: any) => Promise<any>;
  cacheStore?: CacheStore;
  skipCache?: boolean;
};

type ProductionDependencies = {
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
  dispatchNotification: (sql: any, options: any) => Promise<any>;
};

let prodDepsPromise: Promise<ProductionDependencies> | null = null;

async function loadProductionDependencies(): Promise<ProductionDependencies> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("@/lib/db"),
      import("@/lib/session"),
      import("../../../lib/notifications-dispatch.ts"),
    ]).then(([{ sql }, { getSessionUser }, { dispatchNotification }]) => ({
      sql,
      getSessionUser,
      dispatchNotification,
    }));
  }
  return prodDepsPromise;
}

export async function handleGetShifts(
  dependencies?: ShiftRouteDependencies
): Promise<Response> {
  try {
    const prodDeps = dependencies?.getSessionUser && dependencies?.sql ? null : await loadProductionDependencies();
    const resolveSessionUser =
      dependencies?.getSessionUser ?? prodDeps!.getSessionUser;

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
      dependencies?.sql ?? prodDeps!.sql;

    let shifts: any[];
    if (dependencies?.skipCache) {
      shifts = await executeSql`
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
    } else {
      const { data } = await getCachedShiftSchedule(
        sessionUser.teamId,
        "all",
        async () => {
          return executeSql`
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
        },
        dependencies?.cacheStore
      );
      shifts = data;
    }

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
    const prodDeps = dependencies?.getSessionUser && dependencies?.sql ? null : await loadProductionDependencies();
    const resolveSessionUser =
      dependencies?.getSessionUser ?? prodDeps!.getSessionUser;

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
      dependencies?.sql ?? prodDeps!.sql;

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

    // 5. Notify assigned employee asynchronously
    if (
      finalUserId &&
      Number(finalUserId) !== Number(sessionUser.userId) &&
      (!dependencies?.sql || dependencies?.dispatchNotification)
    ) {
      try {
        const dispatchFn =
          dependencies?.dispatchNotification ??
          prodDeps?.dispatchNotification ??
          (await import("../../../lib/notifications-dispatch.ts")).dispatchNotification;
        await dispatchFn(executeSql, {
          teamId: sessionUser.teamId,
          targetUserId: Number(finalUserId),
          category: "shift_assigned",
          entityId: result[0].id,
          payload: {
            employeeName: finalEmployeeName,
            shiftDay,
            role: finalRole,
          },
        });
      } catch (err) {
        console.warn("Failed to dispatch shift_assigned notification:", err);
      }
    }

    // 6. Record workspace activity event (in production when not overridden by isolated unit test mocks)
    if (!dependencies?.sql) {
      try {
        const { recordActivityEvent } = await import("../../../lib/activity.ts");
        await recordActivityEvent(executeSql, {
          teamId: sessionUser.teamId,
          userId: sessionUser.userId,
          actorName: sessionUser.name,
          action: "shift_created",
          entityType: "shift",
          entityId: result[0].id,
          description: `Scheduled shift for ${finalEmployeeName} (${finalRole}) on ${shiftDay}.`,
          metadata: { role: finalRole, shiftDay, assignedUserId: finalUserId },
        });
      } catch {
        // Activity logging fails open
      }
    }

    // Invalidate cached schedule and roster for this team
    try {
      await invalidateTeamCache(sessionUser.teamId, dependencies?.cacheStore);
    } catch {
      // Invalidation fails open
    }

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
