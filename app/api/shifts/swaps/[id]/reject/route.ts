import type { SessionPayload } from "../../../../../../lib/auth.ts";
import { isManagerRole } from "../../../../../../lib/permissions.ts";
import { canCancelSwap, type ShiftSwapRecord } from "../../../../../../lib/shift-swaps.ts";

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
      import("@/lib/db"),
      import("@/lib/session"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleRejectSwap(
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
        { error: "Authentication required to decide shift swaps." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace membership found." },
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

    // 1. Fetch swap record strictly within workspace boundary
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

    // Concurrency check: must still be pending
    if (swap.status !== "pending") {
      return Response.json(
        { error: `This shift swap request has already been decided (${swap.status}).` },
        { status: 409 }
      );
    }

    // 2. Authorization guard: Manager or Requester
    const isManager = isManagerRole(sessionUser.role);
    const isRequester = Number(sessionUser.userId) === Number(swap.requester_user_id);

    if (!isManager && !isRequester) {
      return Response.json(
        { error: "Forbidden: You do not have authority to reject or cancel this shift swap request." },
        { status: 403 }
      );
    }

    const targetStatus = isManager ? "rejected" : "cancelled";

    // 3. Atomic transition
    const transitionRes = await executeSql`
      UPDATE shift_swaps
      SET
        status = ${targetStatus},
        decided_by = ${sessionUser.userId},
        decision_notes = ${decisionNotes},
        decided_at = NOW()
      WHERE id = ${swapId} AND status = 'pending'
      RETURNING *;
    `;

    if (!transitionRes || transitionRes.length === 0) {
      return Response.json(
        { error: "Concurrent update detected: Swap request has already been decided." },
        { status: 409 }
      );
    }

    // Notify requester of rejection if decided by a manager
    if (isManager && swap.requester_user_id) {
      try {
        const { dispatchNotification } = await import("../../../../../../lib/notifications-dispatch.ts");
        await dispatchNotification(executeSql, {
          teamId: sessionUser.teamId,
          targetUserId: Number(swap.requester_user_id),
          category: "swap_rejected",
          entityId: swapId,
          payload: {
            actorName: sessionUser.name,
            notes: decisionNotes || undefined,
          },
        });
      } catch (err) {
        console.warn("Failed to dispatch swap_rejected notification:", err);
      }
    }

    return Response.json({
      success: true,
      message: isManager ? "Shift swap request has been rejected." : "Shift swap request has been cancelled.",
      swap: transitionRes[0],
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to reject shift swap:", error);
    return Response.json(
      { error: "Unable to process shift swap decision." },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleRejectSwap(request, context, deps);
}
