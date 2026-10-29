import type { SessionPayload } from "../../../../lib/auth.ts";
import {
  getRecoverableShiftsForUser,
  recoverLegacyShifts,
  normalizeTargetTeamId,
  validateShiftIds,
  ShiftRecoveryError,
  type ShiftRecoveryDependencies,
} from "../../../../lib/shift-recovery.ts";

let prodDepsPromise: Promise<Required<ShiftRecoveryDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<ShiftRecoveryDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("../../../../lib/db.ts"),
      import("../../../../lib/session.ts"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

/**
 * GET /api/shifts/recover
 * Inspects legacy shifts belonging strictly to the authenticated user (team_id IS NULL).
 * Never exposes another user's shifts or orphan shifts.
 */
export async function handleGetRecoverableShifts(
  request: Request,
  dependencies?: ShiftRecoveryDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser || !sessionUser.userId) {
      return Response.json(
        { error: "Authentication required to view recoverable legacy shifts." },
        { status: 401 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    const shifts = await getRecoverableShiftsForUser(sessionUser.userId, executeSql);

    return Response.json(
      {
        recoverableCount: shifts.length,
        shifts,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failed to fetch recoverable shifts:", error);
    return Response.json(
      { error: "Unable to retrieve recoverable legacy shifts." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetRecoverableShifts(request, deps);
}

/**
 * POST /api/shifts/recover
 * Recovers legacy shifts (team_id IS NULL) strictly attributed to the authenticated user.
 * Assigns shifts exclusively to a workspace where the user holds verified membership.
 * Uses atomic CTE row-locking to ensure no concurrent double-claiming.
 */
export async function handlePostRecoverShifts(
  request: Request,
  dependencies?: ShiftRecoveryDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser || !sessionUser.userId) {
      return Response.json(
        { error: "Authentication required to recover legacy shifts." },
        { status: 401 }
      );
    }

    // Parse body if supplied
    let body: unknown = {};
    const text = await request.text();
    if (text && text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return Response.json(
          { error: "Invalid JSON request body." },
          { status: 400 }
        );
      }
    }

    const typedBody = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

    // Resolve target workspace ID
    let targetTeamId: number | null = null;
    if (typedBody.targetTeamId !== undefined) {
      targetTeamId = normalizeTargetTeamId(typedBody.targetTeamId);
      if (targetTeamId === null) {
        return Response.json(
          { error: "A valid target workspace ID (positive integer) is required." },
          { status: 400 }
        );
      }
    } else if (sessionUser.teamId && sessionUser.teamId > 0) {
      targetTeamId = sessionUser.teamId;
    } else {
      return Response.json(
        { error: "Target workspace ID is required. Please specify targetTeamId or join a workspace." },
        { status: 400 }
      );
    }

    // Validate optional shiftIds filter
    const validation = validateShiftIds(typedBody.shiftIds);
    if (!validation.valid) {
      return Response.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    const result = await recoverLegacyShifts({
      userId: sessionUser.userId,
      targetTeamId,
      shiftIds: validation.ids,
      sql: executeSql,
    });

    return Response.json(result, { status: 200 });
  } catch (error: any) {
    if (error instanceof ShiftRecoveryError) {
      return Response.json(
        { error: error.message },
        { status: error.statusCode }
      );
    }

    console.error("Failed to recover legacy shifts:", error);
    return Response.json(
      { error: "An unexpected error occurred while recovering shifts. Please try again." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handlePostRecoverShifts(request, deps);
}
