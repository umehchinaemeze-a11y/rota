import type { SessionPayload } from "../../../../../../lib/auth.ts";
import { isManagerRole } from "../../../../../../lib/permissions.ts";
import { isSameOriginRequest } from "../../../../../../lib/oauth/safe-redirect.ts";
import type { ShiftEntity, ShiftSwapRecord } from "../../../../../../lib/shift-swaps.ts";

export type RouteContext = {
  params: Promise<{ id: string }>;
};

export type ShiftSwapItemRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<Required<ShiftSwapItemRouteDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<ShiftSwapItemRouteDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("../../../../../../lib/db.ts"),
      import("../../../../../../lib/session.ts"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleApproveSwap(
  request: Request,
  context: RouteContext,
  dependencies?: ShiftSwapItemRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to approve shift swaps." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace membership found." },
        { status: 403 }
      );
    }

    // Role check: Only workspace managers can approve swaps
    if (!isManagerRole(sessionUser.role)) {
      return Response.json(
        { error: "Forbidden: Only workspace managers can approve shift swap requests." },
        { status: 403 }
      );
    }

    const { id } = await context.params;
    const swapId = Number(id);

    if (!Number.isInteger(swapId) || swapId <= 0) {
      return Response.json(
        { error: "Invalid shift swap ID." },
        { status: 400 }
      );
    }

    let decisionNotes: string | null = null;
    try {
      const body = await request.json();
      if (body && typeof body.notes === "string") {
        decisionNotes = body.notes.trim();
      }
    } catch {
      // Body is optional
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    // 1. Fetch swap request strictly scoped to workspace
    const swapRows: ShiftSwapRecord[] = await executeSql`
      SELECT *
      FROM shift_swaps
      WHERE id = ${swapId} AND team_id = ${sessionUser.teamId}
      LIMIT 1;
    `;

    if (!swapRows || swapRows.length === 0) {
      return Response.json(
        { error: "Shift swap request not found." },
        { status: 404 }
      );
    }

    const swap = swapRows[0];

    // Concurrency guard: reject if swap is not pending
    if (swap.status !== "pending") {
      return Response.json(
        { error: `This shift swap request has already been decided (${swap.status}).` },
        { status: 409 }
      );
    }

    // 2. Fetch both shifts to verify current assignments still match
    const shiftRows: ShiftEntity[] = await executeSql`
      SELECT
        id,
        employee_name,
        role,
        user_id,
        team_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day
      FROM shifts
      WHERE id IN (${swap.source_shift_id}, ${swap.target_shift_id})
        AND team_id = ${sessionUser.teamId};
    `;

    const sourceShift = shiftRows.find((s) => Number(s.id) === Number(swap.source_shift_id));
    const targetShift = shiftRows.find((s) => Number(s.id) === Number(swap.target_shift_id));

    if (!sourceShift || !targetShift) {
      return Response.json(
        { error: "One or both shifts involved in this swap no longer exist in this workspace." },
        { status: 409 }
      );
    }

    // Integrity check: verify that assignments haven't been changed concurrently
    if (
      Number(sourceShift.user_id) !== Number(swap.requester_user_id) ||
      Number(targetShift.user_id) !== Number(swap.target_user_id)
    ) {
      return Response.json(
        { error: "Shift assignments have changed since this swap was requested. Approval cannot proceed." },
        { status: 409 }
      );
    }

    // Capture original assignments before updating
    const sourceEmployeeName = sourceShift.employee_name;
    const sourceUserId = sourceShift.user_id;
    const targetEmployeeName = targetShift.employee_name;
    const targetUserId = targetShift.user_id;

    // 3. Atomically exchange shift assignments and mark swap approved
    // Transaction execution with rollback guard
    let updatedSwap: ShiftSwapRecord | null = null;
    let rollbackNeeded = false;

    await executeSql`BEGIN;`;

    try {
      // Optimistic concurrency check during state transition
      const transitionRes = await executeSql`
        UPDATE shift_swaps
        SET
          status = 'approved',
          decided_by = ${sessionUser.userId},
          decision_notes = ${decisionNotes},
          decided_at = NOW()
        WHERE id = ${swapId} AND status = 'pending'
        RETURNING *;
      `;

      if (!transitionRes || transitionRes.length === 0) {
        rollbackNeeded = true;
        await executeSql`ROLLBACK;`;
        return Response.json(
          { error: "Concurrent approval detected: Swap request has already been decided." },
          { status: 409 }
        );
      }

      updatedSwap = transitionRes[0];

      // Update source shift with target employee's identity
      await executeSql`
        UPDATE shifts
        SET
          employee_name = ${targetEmployeeName},
          user_id = ${targetUserId}
        WHERE id = ${sourceShift.id} AND team_id = ${sessionUser.teamId};
      `;

      // Update target shift with source employee's identity
      await executeSql`
        UPDATE shifts
        SET
          employee_name = ${sourceEmployeeName},
          user_id = ${sourceUserId}
        WHERE id = ${targetShift.id} AND team_id = ${sessionUser.teamId};
      `;

      await executeSql`COMMIT;`;
    } catch (txError) {
      if (!rollbackNeeded) {
        try {
          await executeSql`ROLLBACK;`;
        } catch {}
      }
      throw txError;
    }

    // Notify both affected employees of swap approval
    try {
      const { dispatchNotification } = await import("../../../../../../lib/notifications-dispatch.ts");
      if (swap.requester_user_id) {
        await dispatchNotification(executeSql, {
          teamId: sessionUser.teamId,
          targetUserId: Number(swap.requester_user_id),
          category: "swap_approved",
          entityId: swapId,
          payload: {
            actorName: sessionUser.name,
            shiftDay: sourceShift.shift_day,
            role: sourceShift.role,
          },
        });
      }
      if (swap.target_user_id && Number(swap.target_user_id) !== Number(swap.requester_user_id)) {
        await dispatchNotification(executeSql, {
          teamId: sessionUser.teamId,
          targetUserId: Number(swap.target_user_id),
          category: "swap_approved",
          entityId: swapId,
          payload: {
            actorName: sessionUser.name,
            shiftDay: targetShift.shift_day,
            role: targetShift.role,
          },
        });
      }
    } catch (err) {
      console.warn("Failed to dispatch swap_approved notifications:", err);
    }

    // Invalidate team shift schedule and roster cache
    try {
      const { invalidateTeamCache } = await import("../../../../../../lib/cache.ts");
      await invalidateTeamCache(sessionUser.teamId);
    } catch {
      // Cache invalidation fails open
    }

    return Response.json({
      success: true,
      message: "Shift swap approved and schedule updated.",
      swap: updatedSwap,
      swappedShifts: {
        sourceShiftId: sourceShift.id,
        newSourceEmployee: targetShift.employee_name,
        targetShiftId: targetShift.id,
        newTargetEmployee: sourceShift.employee_name,
      },
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to approve shift swap:", error);
    return Response.json(
      { error: "Unable to approve shift swap request." },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const deps = await loadProductionDependencies();
  return handleApproveSwap(request, context, deps);
}
