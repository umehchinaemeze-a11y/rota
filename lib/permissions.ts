export const APP_ROLES = [
  "Owner",
  "Manager",
  "Staff",
  "Supervisor",
  "Operations",
  "Admin",
  "Front Desk",
  "Customer Support",
  "Frontend Developer",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export const MANAGER_ROLES = [
  "Owner",
  "Manager",
  "Supervisor",
  "Operations",
  "Admin",
] as const;

export type ManagerRole = (typeof MANAGER_ROLES)[number];

/**
 * Evaluates whether a given role string possesses management authority.
 * Grants workspace/team-wide shift scheduling and modification privileges.
 */
export function isManagerRole(role: unknown): boolean {
  if (typeof role !== "string") {
    return false;
  }
  return (MANAGER_ROLES as readonly string[]).includes(role);
}

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
  if (isManagerRole(sessionUser.role)) {
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

  if (isManagerRole(currentRole)) {
    return true;
  }

  return normalizedUser === normalizedOwner;
}

export type TeamScopedUserContext = {
  userId: number;
  name?: string;
  role: string;
  teamId?: string | number | null;
};

export type TeamScopedShiftRecord = {
  id?: number;
  user_id?: number | null;
  employee_name?: string | null;
  teamId?: string | number | null;
  team_id?: string | number | null;
};

function normalizeTeamId(teamId: unknown): string | null {
  if (typeof teamId === "number") {
    if (Number.isInteger(teamId) && teamId > 0) {
      return String(teamId);
    }
    return null;
  }
  if (typeof teamId === "string") {
    const trimmed = teamId.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * Strict server-side permission check enforcing tenant/team boundary isolation.
 *
 * Rules:
 * 1. Reject missing, null, malformed, or mismatched team identifiers (returns false).
 * 2. Cross-team access is strictly forbidden regardless of role (Supervisors/Admins cannot access other teams).
 * 3. Within the authorized team:
 *    - Managers (Supervisor, Operations, Admin) have authority over all team shifts.
 *    - Ordinary employees can only edit or delete shifts matching their own authenticated user_id.
 *    - Unassigned shifts (user_id IS NULL) cannot be claimed by ordinary employees.
 */
export function canManageTeamShiftRecord(
  sessionUser: TeamScopedUserContext | undefined | null,
  shiftRecord: TeamScopedShiftRecord | undefined | null
): boolean {
  if (
    !sessionUser ||
    typeof sessionUser.userId !== "number" ||
    sessionUser.userId <= 0 ||
    typeof sessionUser.role !== "string"
  ) {
    return false;
  }

  if (!shiftRecord) {
    return false;
  }

  const userTeam = normalizeTeamId(sessionUser.teamId);
  const rawShiftTeam =
    shiftRecord.teamId !== undefined ? shiftRecord.teamId : shiftRecord.team_id;
  const shiftTeam = normalizeTeamId(rawShiftTeam);

  // Reject missing, null, or malformed team identifiers
  if (!userTeam || !shiftTeam) {
    return false;
  }

  // Cross-team boundary: different teams must NEVER authorize access, regardless of role
  if (userTeam !== shiftTeam) {
    return false;
  }

  // Within the same team, management roles have authority across all team shifts
  if (isManagerRole(sessionUser.role)) {
    return true;
  }

  // Unassigned shifts within the team cannot be claimed by ordinary employees
  if (shiftRecord.user_id === null || shiftRecord.user_id === undefined) {
    return false;
  }

  // Ordinary employees can only manage shifts linked to their exact user_id
  return shiftRecord.user_id === sessionUser.userId;
}
