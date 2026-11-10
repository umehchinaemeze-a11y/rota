import type { SessionPayload } from "../../../../lib/auth.ts";
import { computeShiftsRevision, type ShiftRevisionInput } from "../../../../lib/shifts-sync.ts";

export type ShiftSyncRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<Required<ShiftSyncRouteDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<ShiftSyncRouteDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("@/lib/db"),
      import("@/lib/session"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleGetShiftSync(
  request: Request,
  dependencies?: ShiftSyncRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    // 1. Authenticate session with database revalidation
    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to sync shifts." },
        { status: 401 }
      );
    }

    // 2. Strict Workspace Isolation Guard
    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active team membership found for this account." },
        { status: 403 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    // 3. Extract client-reported version from query params
    const url = new URL(request.url);
    const requestedVersion = url.searchParams.get("version")?.trim() || "";

    // 4. Query shift items strictly scoped by team_id
    const rows = await executeSql`
      SELECT
        id,
        employee_name,
        role,
        user_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day
      FROM shifts
      WHERE team_id = ${sessionUser.teamId}
      ORDER BY id ASC;
    `;

    let currentVersion: string;
    let shiftCount: number;

    // Check if SQL driver returned an aggregate summary or shift row list
    if (
      rows &&
      rows.length === 1 &&
      typeof rows[0]?.shift_count === "number" &&
      typeof rows[0]?.hash === "string"
    ) {
      const summary = rows[0];
      shiftCount = summary.shift_count;
      currentVersion = `rev_${summary.shift_count}_${summary.max_id || 0}_${summary.sum_id || 0}_${summary.hash}`;
    } else {
      const shiftList = Array.isArray(rows) ? (rows as ShiftRevisionInput[]) : [];
      shiftCount = shiftList.length;
      currentVersion = computeShiftsRevision(shiftList);
    }

    // 5. Determine whether client is out-of-date
    const changed = !requestedVersion || requestedVersion !== currentVersion;

    return Response.json({
      workspaceId: sessionUser.teamId,
      version: currentVersion,
      shiftCount,
      changed,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to check shift sync revision:", error);
    return Response.json(
      { error: "Unable to check shift synchronization state." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetShiftSync(request, deps);
}

export async function POST(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetShiftSync(request, deps);
}
