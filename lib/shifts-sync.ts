/**
 * Real-Time Shift Change Synchronization & Versioning Module
 *
 * Provides pure, deterministic revision computation and response resolution
 * for lightweight workspace-scoped conditional polling synchronization.
 */

export interface ShiftSyncResponse {
  workspaceId: number;
  version: string;
  shiftCount: number;
  changed: boolean;
  syncedAt: string;
}

export type ShiftSyncOutcome =
  | {
      status: "synced";
      version: string;
      shiftCount: number;
      workspaceId: number;
    }
  | {
      status: "no_change";
      version: string;
      shiftCount: number;
      workspaceId: number;
    }
  | {
      status: "unauthenticated";
      error: string;
    }
  | {
      status: "forbidden";
      error: string;
    }
  | {
      status: "error";
      error: string;
    };

export interface ShiftRevisionInput {
  id: number;
  employee_name?: string;
  name?: string;
  role: string;
  shift_day?: string;
  shiftDay?: string;
  user_id?: number | null;
  userId?: number | null;
}

/**
 * Computes a deterministic revision string from an array of shifts.
 * Runs identically in Node.js and Browser environments with zero external dependencies.
 *
 * Properties:
 * - Deterministic: shifts are sorted by id.
 * - Sensitive to: shift count, shift IDs, assigned user ID, role, shift date, and employee name.
 * - Lightweight: Produces a compact string e.g. "rev_5_12_55_3f2a1b".
 */
export function computeShiftsRevision(shifts: ShiftRevisionInput[]): string {
  if (!Array.isArray(shifts) || shifts.length === 0) {
    return "rev_0_0_0_empty";
  }

  // Sort by id for determinism
  const sorted = [...shifts].sort((a, b) => a.id - b.id);
  let sumId = 0;
  let maxId = 0;
  let strRepr = "";

  for (const s of sorted) {
    const id = Number(s.id) || 0;
    sumId += id;
    if (id > maxId) maxId = id;

    const emp = (s.employee_name || s.name || "").trim().toLowerCase();
    const day = (s.shift_day || s.shiftDay || "").trim();
    const role = (s.role || "").trim().toLowerCase();
    const uid = s.user_id !== undefined && s.user_id !== null
      ? String(s.user_id)
      : s.userId !== undefined && s.userId !== null
        ? String(s.userId)
        : "";

    strRepr += `${id}:${uid}:${role}:${day}:${emp}|`;
  }

  // 32-bit unsigned DJB2 hash
  let hash = 5381;
  for (let i = 0; i < strRepr.length; i++) {
    hash = ((hash << 5) + hash + strRepr.charCodeAt(i)) >>> 0;
  }

  return `rev_${shifts.length}_${maxId}_${sumId}_${hash.toString(16)}`;
}

/**
 * Resolves API response from /api/shifts/sync into strongly typed outcome.
 */
export function resolveShiftSyncResponse(
  status: number,
  body: unknown
): ShiftSyncOutcome {
  if (status === 401) {
    const errorMsg =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
        ? ((body as Record<string, unknown>).error as string)
        : "Authentication required to sync shifts.";
    return {
      status: "unauthenticated",
      error: errorMsg,
    };
  }

  if (status === 403) {
    const errorMsg =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
        ? ((body as Record<string, unknown>).error as string)
        : "Forbidden: No active workspace membership found.";
    return {
      status: "forbidden",
      error: errorMsg,
    };
  }

  if (status >= 200 && status < 300 && body && typeof body === "object") {
    const typed = body as Record<string, unknown>;
    const version = typeof typed.version === "string" ? typed.version : "rev_0_0_0_empty";
    const shiftCount = typeof typed.shiftCount === "number" ? typed.shiftCount : 0;
    const workspaceId = typeof typed.workspaceId === "number" ? typed.workspaceId : 0;
    const changed = Boolean(typed.changed);

    if (changed) {
      return {
        status: "synced",
        version,
        shiftCount,
        workspaceId,
      };
    }

    return {
      status: "no_change",
      version,
      shiftCount,
      workspaceId,
    };
  }

  const errorMsg =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
      ? ((body as Record<string, unknown>).error as string)
      : "Failed to synchronize workspace shifts.";

  return {
    status: "error",
    error: errorMsg,
  };
}

