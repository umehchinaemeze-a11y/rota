/**
 * Shift Swaps with Manager Approval Module
 *
 * Provides domain logic, validation, and authorization helpers for shift swap requests.
 *
 * Rules:
 * 1. Employees can only request swaps for shifts assigned to them (or managers on behalf).
 * 2. Both shifts must belong to the exact same workspace (strict tenant boundary).
 * 3. Shifts in the past cannot be swapped.
 * 4. Only managers (Owner, Admin, Supervisor, Manager, Operations) can approve or reject requests.
 * 5. Requesters can cancel their own pending requests.
 * 6. Approved swaps atomically exchange employee assignments on both shifts.
 * 7. Conflicting / duplicate pending requests on the same shift are rejected.
 */

import { isManagerRole } from "./permissions.ts";
import type { SessionPayload } from "./auth.ts";

export type ShiftSwapStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface ShiftSwapRecord {
  id: number;
  team_id: number;
  requester_user_id: number;
  requester_name?: string;
  target_user_id: number;
  target_employee_name?: string;
  source_shift_id: number;
  source_shift_day?: string;
  source_role?: string;
  target_shift_id: number;
  target_shift_day?: string;
  target_role?: string;
  status: ShiftSwapStatus;
  reason?: string | null;
  decided_by?: number | null;
  decided_by_name?: string | null;
  decision_notes?: string | null;
  created_at: string;
  decided_at?: string | null;
}

export interface ShiftEntity {
  id: number;
  employee_name: string;
  role: string;
  user_id?: number | null;
  team_id?: number | null;
  shift_day: string;
  created_at?: string;
}

export interface CreateSwapRequestInput {
  sourceShiftId: number;
  targetShiftId: number;
  reason?: string;
}

export interface SwapValidationResult {
  valid: boolean;
  error?: string;
  code?: "INVALID_INPUT" | "UNAUTHORIZED" | "CROSS_WORKSPACE" | "SELF_SWAP" | "PAST_SHIFT" | "UNASSIGNED_TARGET";
}

/**
 * Validates a proposed shift swap request against business, tenant, and ownership rules.
 */
export function validateSwapRequest(
  input: { sourceShiftId?: unknown; targetShiftId?: unknown; reason?: unknown },
  sessionUser: SessionPayload,
  sourceShift: ShiftEntity | null | undefined,
  targetShift: ShiftEntity | null | undefined,
  currentDateStr = new Date().toISOString().slice(0, 10)
): SwapValidationResult {
  const sourceId = Number(input.sourceShiftId);
  const targetId = Number(input.targetShiftId);

  if (!Number.isInteger(sourceId) || sourceId <= 0 || !Number.isInteger(targetId) || targetId <= 0) {
    return {
      valid: false,
      error: "Both source shift and target replacement shift IDs are required.",
      code: "INVALID_INPUT",
    };
  }

  if (sourceId === targetId) {
    return {
      valid: false,
      error: "Cannot swap a shift with itself.",
      code: "SELF_SWAP",
    };
  }

  if (!sourceShift) {
    return {
      valid: false,
      error: "Source shift not found in your workspace.",
      code: "INVALID_INPUT",
    };
  }

  if (!targetShift) {
    return {
      valid: false,
      error: "Target shift not found in your workspace.",
      code: "INVALID_INPUT",
    };
  }

  // 1. Strict Tenant Boundary Isolation: Both shifts must belong to caller's team
  const userTeam = Number(sessionUser.teamId);
  const sourceTeam = Number(sourceShift.team_id);
  const targetTeam = Number(targetShift.team_id);

  if (sourceTeam !== userTeam || targetTeam !== userTeam) {
    return {
      valid: false,
      error: "Both shifts must belong to your active workspace.",
      code: "CROSS_WORKSPACE",
    };
  }

  // 2. Ownership Rule: Non-managers can only request swaps for shifts assigned to their user ID
  const isManager = isManagerRole(sessionUser.role);
  if (!isManager && Number(sourceShift.user_id) !== Number(sessionUser.userId)) {
    return {
      valid: false,
      error: "You can only request swaps for shifts assigned to you.",
      code: "UNAUTHORIZED",
    };
  }

  // 3. Target shift must be assigned to an active team member
  if (!targetShift.user_id || targetShift.user_id <= 0) {
    return {
      valid: false,
      error: "Target shift is not assigned to an active team member.",
      code: "UNASSIGNED_TARGET",
    };
  }

  // 4. Cannot swap with your own other shift (that is a reschedule, not a swap with another employee)
  if (Number(sourceShift.user_id) === Number(targetShift.user_id)) {
    return {
      valid: false,
      error: "Cannot swap shifts with yourself. Select a colleague's shift to swap with.",
      code: "SELF_SWAP",
    };
  }

  // 5. Calendar Rule: Cannot swap past shifts
  const sourceDay = String(sourceShift.shift_day).slice(0, 10);
  const targetDay = String(targetShift.shift_day).slice(0, 10);

  if (sourceDay < currentDateStr || targetDay < currentDateStr) {
    return {
      valid: false,
      error: "Cannot request swaps for past shifts.",
      code: "PAST_SHIFT",
    };
  }

  return { valid: true };
}

/**
 * Checks if caller is authorized to approve or reject a shift swap.
 */
export function canApproveSwap(sessionUser: SessionPayload, swap: { team_id: number }): boolean {
  if (!sessionUser || !sessionUser.teamId || Number(sessionUser.teamId) !== Number(swap.team_id)) {
    return false;
  }
  return isManagerRole(sessionUser.role);
}

/**
 * Checks if caller is authorized to cancel a pending swap.
 */
export function canCancelSwap(sessionUser: SessionPayload, swap: { team_id: number; requester_user_id: number }): boolean {
  if (!sessionUser || !sessionUser.teamId || Number(sessionUser.teamId) !== Number(swap.team_id)) {
    return false;
  }
  return isManagerRole(sessionUser.role) || Number(sessionUser.userId) === Number(swap.requester_user_id);
}

/**
 * Ensures shift_swaps table and performance indexes exist.
 */
export async function ensureShiftSwapsTable(sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS shift_swaps (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      requester_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      target_shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      reason TEXT,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decision_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_shift_swaps_team_id ON shift_swaps(team_id);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_shift_swaps_status ON shift_swaps(team_id, status);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_shift_swaps_requester ON shift_swaps(requester_user_id);
  `;
}

