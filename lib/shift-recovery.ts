import type { SessionPayload } from "./auth.ts";

export type RecoverableShift = {
  id: number;
  employee_name: string;
  role: string;
  user_id: number;
  team_id: number | null;
  shift_day: string;
  created_at?: string;
};

export type ShiftRecoveryDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

export type RecoverLegacyShiftsParams = {
  userId: number;
  targetTeamId: number;
  shiftIds?: number[];
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
};

export type ShiftRecoveryResult = {
  success: boolean;
  message: string;
  recoveredCount: number;
  targetTeamId: number;
  shifts: RecoverableShift[];
};

export class ShiftRecoveryError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ShiftRecoveryError";
    this.statusCode = statusCode;
  }
}

/**
 * Validates and normalizes target workspace ID.
 */
export function normalizeTargetTeamId(val: unknown): number | null {
  if (typeof val === "number" && Number.isInteger(val) && val > 0) {
    return val;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * Validates optional shiftIds array.
 */
export function validateShiftIds(val: unknown): { valid: boolean; ids?: number[]; error?: string } {
  if (val === undefined || val === null) {
    return { valid: true, ids: undefined };
  }
  if (!Array.isArray(val)) {
    return { valid: false, error: "shiftIds must be an array of positive integers." };
  }
  if (val.length === 0) {
    return { valid: true, ids: [] };
  }

  const ids: number[] = [];
  for (const item of val) {
    const normalized = normalizeTargetTeamId(item);
    if (normalized === null) {
      return { valid: false, error: "All elements in shiftIds must be positive integers." };
    }
    ids.push(normalized);
  }

  return { valid: true, ids };
}

/**
 * Queries legacy shifts strictly belonging to the authenticated user where team_id IS NULL.
 * Never exposes shifts of other users or orphan shifts (user_id IS NULL).
 */
export async function getRecoverableShiftsForUser(
  userId: number,
  executeSql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>
): Promise<RecoverableShift[]> {
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
    return [];
  }

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
    WHERE user_id = ${userId}
      AND team_id IS NULL
    ORDER BY shift_day ASC, id ASC;
  `;

  return Array.isArray(rows) ? (rows as RecoverableShift[]) : [];
}

/**
 * Verifies that the authenticated user is an authorized member of the target workspace in team_memberships.
 */
export async function verifyWorkspaceMembership(
  userId: number,
  teamId: number,
  executeSql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>
): Promise<{ authorized: boolean; role?: string }> {
  if (
    typeof userId !== "number" ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    typeof teamId !== "number" ||
    !Number.isInteger(teamId) ||
    teamId <= 0
  ) {
    return { authorized: false };
  }

  const rows = await executeSql`
    SELECT id, team_id, role
    FROM team_memberships
    WHERE user_id = ${userId} AND team_id = ${teamId}
    LIMIT 1;
  `;

  if (!rows || rows.length === 0) {
    return { authorized: false };
  }

  return { authorized: true, role: rows[0].role };
}

/**
 * Verifies explicit shift IDs to ensure none belong to other users, are unassigned orphans, or are already assigned.
 */
export async function verifyShiftOwnershipAndEligibility(
  userId: number,
  shiftIds: number[],
  executeSql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>
): Promise<void> {
  if (shiftIds.length === 0) {
    return;
  }

  const rows = await executeSql`
    SELECT id, user_id, team_id
    FROM shifts
    WHERE id = ANY(${shiftIds});
  `;

  const foundShifts = Array.isArray(rows) ? rows : [];
  const foundMap = new Map<number, { id: number; user_id: number | null; team_id: number | null }>();
  for (const s of foundShifts) {
    foundMap.set(s.id, s);
  }

  for (const id of shiftIds) {
    const shift = foundMap.get(id);
    if (!shift) {
      throw new ShiftRecoveryError(`Shift ${id} was not found.`, 404);
    }
    if (shift.user_id === null || shift.user_id === undefined) {
      throw new ShiftRecoveryError(
        `Shift ${id} has no registered owner and cannot be claimed automatically.`,
        403
      );
    }
    if (shift.user_id !== userId) {
      throw new ShiftRecoveryError(
        `Forbidden: Shift ${id} belongs to another account and cannot be claimed.`,
        403
      );
    }
    if (shift.team_id !== null && shift.team_id !== undefined) {
      throw new ShiftRecoveryError(
        `Shift ${id} is already assigned to a workspace.`,
        409
      );
    }
  }
}

/**
 * Recovers legacy shifts for an authenticated user with transactional and row-level concurrency protection.
 *
 * Guarantees:
 * 1. An authenticated user can only recover shifts where shifts.user_id === userId.
 * 2. Recovery only succeeds into a workspace where the user is an authorized member.
 * 3. Never claims or exposes other users' shifts or orphan shifts.
 * 4. Uses row-level lock (FOR UPDATE) and conditional WHERE team_id IS NULL to prevent double-claiming.
 * 5. Preserves all other shift fields (id, employee_name, role, user_id, shift_day, created_at).
 * 6. Repeat requests are idempotent and return recoveredCount: 0 cleanly.
 */
export async function recoverLegacyShifts(
  params: RecoverLegacyShiftsParams
): Promise<ShiftRecoveryResult> {
  const { userId, targetTeamId, shiftIds, sql: executeSql } = params;

  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
    throw new ShiftRecoveryError("Invalid user ID.", 401);
  }

  if (
    typeof targetTeamId !== "number" ||
    !Number.isInteger(targetTeamId) ||
    targetTeamId <= 0
  ) {
    throw new ShiftRecoveryError(
      "A valid target workspace ID is required to recover legacy shifts.",
      400
    );
  }

  // 1. Authorize workspace membership
  const membership = await verifyWorkspaceMembership(userId, targetTeamId, executeSql);
  if (!membership.authorized) {
    throw new ShiftRecoveryError(
      "Access denied: You are not an authorized member of the target workspace.",
      403
    );
  }

  // 2. If specific shift IDs requested, verify ownership and eligibility
  if (shiftIds && shiftIds.length > 0) {
    await verifyShiftOwnershipAndEligibility(userId, shiftIds, executeSql);
  }

  // 3. Atomic recovery query with row-level locking (FOR UPDATE)
  let updatedRows: any[] = [];

  if (shiftIds && shiftIds.length > 0) {
    updatedRows = await executeSql`
      WITH candidate_shifts AS (
        SELECT id
        FROM shifts
        WHERE user_id = ${userId}
          AND team_id IS NULL
          AND id = ANY(${shiftIds})
        FOR UPDATE
      )
      UPDATE shifts s
      SET team_id = ${targetTeamId}
      FROM candidate_shifts cs
      WHERE s.id = cs.id
        AND s.user_id = ${userId}
        AND s.team_id IS NULL
      RETURNING
        s.id,
        s.employee_name,
        s.role,
        s.user_id,
        s.team_id,
        TO_CHAR(s.shift_day, 'YYYY-MM-DD') AS shift_day,
        s.created_at;
    `;
  } else {
    updatedRows = await executeSql`
      WITH candidate_shifts AS (
        SELECT id
        FROM shifts
        WHERE user_id = ${userId}
          AND team_id IS NULL
        FOR UPDATE
      )
      UPDATE shifts s
      SET team_id = ${targetTeamId}
      FROM candidate_shifts cs
      WHERE s.id = cs.id
        AND s.user_id = ${userId}
        AND s.team_id IS NULL
      RETURNING
        s.id,
        s.employee_name,
        s.role,
        s.user_id,
        s.team_id,
        TO_CHAR(s.shift_day, 'YYYY-MM-DD') AS shift_day,
        s.created_at;
    `;
  }

  const shifts: RecoverableShift[] = Array.isArray(updatedRows)
    ? (updatedRows as RecoverableShift[])
    : [];

  if (shifts.length === 0) {
    return {
      success: true,
      message: "No legacy shifts pending recovery.",
      recoveredCount: 0,
      targetTeamId,
      shifts: [],
    };
  }

  return {
    success: true,
    message: `Successfully recovered ${shifts.length} legacy shift(s).`,
    recoveredCount: shifts.length,
    targetTeamId,
    shifts,
  };
}

/**
 * Administrative helper: Counts unowned/orphan legacy shifts (user_id IS NULL AND team_id IS NULL).
 * For administrative auditing only. Never exposed to regular end-users.
 */
export async function countUnassignedOrphanShifts(
  executeSql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>
): Promise<number> {
  const rows = await executeSql`
    SELECT COUNT(*)::int AS count
    FROM shifts
    WHERE user_id IS NULL AND team_id IS NULL;
  `;
  if (rows && rows.length > 0 && typeof rows[0].count === "number") {
    return rows[0].count;
  }
  return 0;
}
