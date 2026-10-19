export const APP_ROLES = [
  "Front Desk",
  "Operations",
  "Customer Support",
  "Supervisor",
  "Frontend Developer",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export type ShiftRecordIdentifier = {
  id?: number;
  user_id?: number | null;
  employee_name?: string | null;
};

export type AuthenticatedUserContext = {
  userId: number;
  name?: string;
  role: string;
};

/**
 * Strict server-side permission check using immutable user_id ownership and current database roles.
 *
 * Rules:
 * 1. An empty or invalid session user is unauthorized (returns false).
 * 2. Managers (Supervisor, Operations, Admin) have authority across all shifts, including legacy shifts.
 * 3. Legacy shifts (user_id IS NULL) CANNOT be claimed or modified by ordinary employees, even if names match.
 * 4. Standard team members can only edit or delete shifts where shiftRecord.user_id === sessionUser.userId.
 */
export function canManageShiftRecord(
  sessionUser: AuthenticatedUserContext | undefined | null,
  shiftRecord: ShiftRecordIdentifier | undefined | null
): boolean {
  if (!sessionUser || typeof sessionUser.userId !== "number" || sessionUser.userId <= 0) {
    return false;
  }

  // Management roles have workspace-wide authority over all shifts, including legacy records
  if (
    sessionUser.role === "Supervisor" ||
    sessionUser.role === "Operations" ||
    sessionUser.role === "Admin"
  ) {
    return true;
  }

  // Legacy shifts (user_id IS NULL) cannot be claimed by ordinary users based on name matching
  if (!shiftRecord || shiftRecord.user_id === null || shiftRecord.user_id === undefined) {
    return false;
  }

  // Standard employees can only manage shifts linked to their exact user_id
  return shiftRecord.user_id === sessionUser.userId;
}

/**
 * Legacy/UI helper evaluating name and role strings for display badges.
 */
export function canManageShift(
  currentUser: string | undefined | null,
  currentRole: string | undefined | null,
  shiftEmployeeName: string | undefined | null
): boolean {
  if (!currentUser || typeof currentUser !== "string" || !currentUser.trim()) {
    return false;
  }

  if (!shiftEmployeeName || typeof shiftEmployeeName !== "string" || !shiftEmployeeName.trim()) {
    return false;
  }

  const normalizedUser = currentUser.trim().toLowerCase();
  const normalizedOwner = shiftEmployeeName.trim().toLowerCase();

  if (
    currentRole === "Supervisor" ||
    currentRole === "Admin" ||
    currentRole === "Operations"
  ) {
    return true;
  }

  return normalizedUser === normalizedOwner;
}
