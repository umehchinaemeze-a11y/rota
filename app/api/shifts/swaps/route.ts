import type { SessionPayload } from "../../../../lib/auth.ts";
import { isManagerRole } from "../../../../lib/permissions.ts";
import {
  validateSwapRequest,
  ensureShiftSwapsTable,
  type ShiftEntity,
} from "../../../../lib/shift-swaps.ts";

export type ShiftSwapRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<Required<ShiftSwapRouteDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<ShiftSwapRouteDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("@/lib/db"),
      import("@/lib/session"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleGetSwaps(
  request: Request,
  dependencies?: ShiftSwapRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to view shift swap requests." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace membership found." },
        { status: 403 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    const isManager = isManagerRole(sessionUser.role);

    let rows: any[] = [];
    try {
      if (isManager) {
        rows = await executeSql`
          SELECT
            s.id,
            s.team_id,
            s.requester_user_id,
            u_req.name AS requester_name,
            s.target_user_id,
            u_tgt.name AS target_employee_name,
            s.source_shift_id,
            TO_CHAR(src.shift_day, 'YYYY-MM-DD') AS source_shift_day,
            src.role AS source_role,
            s.target_shift_id,
            TO_CHAR(tgt.shift_day, 'YYYY-MM-DD') AS target_shift_day,
            tgt.role AS target_role,
            s.status,
            s.reason,
            s.decided_by,
            u_dec.name AS decided_by_name,
            s.decision_notes,
            s.created_at,
            s.decided_at
          FROM shift_swaps s
          LEFT JOIN users u_req ON u_req.id = s.requester_user_id
          LEFT JOIN users u_tgt ON u_tgt.id = s.target_user_id
          LEFT JOIN users u_dec ON u_dec.id = s.decided_by
          LEFT JOIN shifts src ON src.id = s.source_shift_id
          LEFT JOIN shifts tgt ON tgt.id = s.target_shift_id
          WHERE s.team_id = ${sessionUser.teamId}
          ORDER BY s.created_at DESC;
        `;
      } else {
        rows = await executeSql`
          SELECT
            s.id,
            s.team_id,
            s.requester_user_id,
            u_req.name AS requester_name,
            s.target_user_id,
            u_tgt.name AS target_employee_name,
            s.source_shift_id,
            TO_CHAR(src.shift_day, 'YYYY-MM-DD') AS source_shift_day,
            src.role AS source_role,
            s.target_shift_id,
            TO_CHAR(tgt.shift_day, 'YYYY-MM-DD') AS target_shift_day,
            tgt.role AS target_role,
            s.status,
            s.reason,
            s.decided_by,
            u_dec.name AS decided_by_name,
            s.decision_notes,
            s.created_at,
            s.decided_at
          FROM shift_swaps s
          LEFT JOIN users u_req ON u_req.id = s.requester_user_id
          LEFT JOIN users u_tgt ON u_tgt.id = s.target_user_id
          LEFT JOIN users u_dec ON u_dec.id = s.decided_by
          LEFT JOIN shifts src ON src.id = s.source_shift_id
          LEFT JOIN shifts tgt ON tgt.id = s.target_shift_id
          WHERE s.team_id = ${sessionUser.teamId}
            AND (s.requester_user_id = ${sessionUser.userId} OR s.target_user_id = ${sessionUser.userId})
          ORDER BY s.created_at DESC;
        `;
      }
    } catch {
      // Table may not yet be initialized in mock or fresh database
      try {
        await ensureShiftSwapsTable(executeSql);
        rows = [];
      } catch {
        rows = [];
      }
    }

    return Response.json(rows || []);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to fetch shift swaps:", error);
    return Response.json(
      { error: "Unable to retrieve shift swap requests." },
      { status: 500 }
    );
  }
}

export async function handlePostSwap(
  request: Request,
  dependencies?: ShiftSwapRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to request shift swaps." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace membership found." },
        { status: 403 }
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    const sourceShiftId = Number(body?.sourceShiftId);
    const targetShiftId = Number(body?.targetShiftId);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

    if (!Number.isInteger(sourceShiftId) || sourceShiftId <= 0 || !Number.isInteger(targetShiftId) || targetShiftId <= 0) {
      return Response.json(
        { error: "Valid positive integers for sourceShiftId and targetShiftId are required." },
        { status: 400 }
      );
    }

    if (sourceShiftId === targetShiftId) {
      return Response.json(
        { error: "Cannot swap a shift with itself." },
        { status: 400 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    // Retrieve both shifts strictly from caller's team
    let shifts: ShiftEntity[] = [];
    try {
      shifts = await executeSql`
        SELECT
          id,
          employee_name,
          role,
          user_id,
          team_id,
          TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day
        FROM shifts
        WHERE id IN (${sourceShiftId}, ${targetShiftId})
          AND team_id = ${sessionUser.teamId};
      `;
    } catch (err) {
      console.error("Database query error on shifts lookup:", err);
      return Response.json(
        { error: "Unable to verify shift records." },
        { status: 500 }
      );
    }

    const sourceShift = shifts.find((s) => Number(s.id) === sourceShiftId) || null;
    const targetShift = shifts.find((s) => Number(s.id) === targetShiftId) || null;

    if (!sourceShift) {
      return Response.json(
        { error: "Source shift not found in your workspace." },
        { status: 404 }
      );
    }

    if (!targetShift) {
      return Response.json(
        { error: "Target replacement shift not found in your workspace." },
        { status: 404 }
      );
    }

    // Business and RBAC Validation
    const validation = validateSwapRequest(
      { sourceShiftId, targetShiftId, reason },
      sessionUser,
      sourceShift,
      targetShift
    );

    if (!validation.valid) {
      const statusCode = validation.code === "UNAUTHORIZED" ? 403 : 400;
      return Response.json({ error: validation.error }, { status: statusCode });
    }

    // Check for existing pending swap conflict
    try {
      const conflicts = await executeSql`
        SELECT id
        FROM shift_swaps
        WHERE team_id = ${sessionUser.teamId}
          AND status = 'pending'
          AND (
            source_shift_id IN (${sourceShiftId}, ${targetShiftId})
            OR target_shift_id IN (${sourceShiftId}, ${targetShiftId})
          )
        LIMIT 1;
      `;

      if (conflicts && conflicts.length > 0) {
        return Response.json(
          { error: "A pending swap request already exists for one of these shifts." },
          { status: 409 }
        );
      }
    } catch {
      // Table may not yet be initialized in mock or fresh database
      try {
        await ensureShiftSwapsTable(executeSql);
      } catch {}
    }

    // Insert new pending swap request
    const inserted = await executeSql`
      INSERT INTO shift_swaps (
        team_id,
        requester_user_id,
        target_user_id,
        source_shift_id,
        target_shift_id,
        status,
        reason
      ) VALUES (
        ${sessionUser.teamId},
        ${sessionUser.userId},
        ${targetShift.user_id},
        ${sourceShiftId},
        ${targetShiftId},
        'pending',
        ${reason || null}
      )
      RETURNING *;
    `;

    // Notify target employee of swap proposal
    if (targetShift.user_id && Number(targetShift.user_id) !== Number(sessionUser.userId)) {
      try {
        const { dispatchNotification } = await import("../../../../lib/notifications-dispatch.ts");
        await dispatchNotification(executeSql, {
          teamId: sessionUser.teamId,
          targetUserId: Number(targetShift.user_id),
          category: "swap_requested",
          entityId: inserted[0].id,
          payload: {
            requesterName: sessionUser.name,
            shiftDay: targetShift.shift_day,
            role: targetShift.role,
          },
        });
      } catch (err) {
        console.warn("Failed to dispatch swap_requested notification:", err);
      }
    }

    return Response.json(inserted[0], { status: 201 });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to create shift swap request:", error);
    return Response.json(
      { error: "Unable to submit shift swap request." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetSwaps(request, deps);
}

export async function POST(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handlePostSwap(request, deps);
}
