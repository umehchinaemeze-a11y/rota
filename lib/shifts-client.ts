/**
 * Client-side shift data mapping and HTTP response resolution helpers.
 *
 * Provides pure, testable response handling for shift API requests:
 * - 401 Unauthorized: Explains that authentication is required and provides sign-in route.
 * - 403 Forbidden: Explains workspace/team access requirement without leaking internal details.
 * - 2xx Success: Maps shifts to calendar-ready schedule items.
 * - Network/Server failure: Retains clean error message for retry.
 */

export type ApiShift = {
  id: number;
  employee_name: string;
  role: string;
  user_id?: number | null;
  team_id?: number | null;
  shift_day: string;
  created_at?: string;
};

export type ScheduleShift = {
  id: number;
  day: string;
  date: string;
  name: string;
  role: string;
  userId?: number | null;
  teamId?: number | null;
  start: string;
  end: string;
  color: string;
  shiftDay: string;
};

export type ShiftLoadOutcome =
  | {
      status: "unauthenticated";
      message: string;
      requiresSignIn: true;
      signInAction: string;
    }
  | {
      status: "forbidden";
      message: string;
      requiresSignIn: false;
    }
  | {
      status: "network_error";
      message: string;
      requiresSignIn: false;
    }
  | {
      status: "success";
      shifts: ScheduleShift[];
      requiresSignIn: false;
    };

export const shiftColors = [
  "bg-emerald-100 text-emerald-800",
  "bg-blue-100 text-blue-800",
  "bg-violet-100 text-violet-800",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-800",
];

export function formatShiftDate(dateString: string) {
  const date = dateString.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  const localDate = new Date(year, month - 1, day);

  return {
    day: localDate
      .toLocaleDateString("en-US", { weekday: "short" })
      .toUpperCase(),
    date: String(day),
    shiftDay: date,
  };
}

export function mapApiShift(shift: ApiShift, index: number = 0): ScheduleShift {
  const formatted = formatShiftDate(shift.shift_day);

  return {
    id: shift.id,
    ...formatted,
    name: shift.employee_name,
    role: shift.role,
    userId: shift.user_id,
    teamId: shift.team_id ?? null,
    start: "09:00",
    end: "17:00",
    color: shiftColors[index % shiftColors.length],
  };
}

/**
 * Resolves shift API fetch response into typed UI outcomes.
 *
 * @param status HTTP response status code (e.g. 200, 401, 403, 500)
 * @param body Parsed JSON response body or null
 * @param isNetworkError Whether a network-level fetch error occurred
 */
export function resolveShiftFetchResponse(
  status: number,
  body: unknown,
  isNetworkError = false
): ShiftLoadOutcome {
  if (isNetworkError) {
    return {
      status: "network_error",
      message: "Could not load shifts. Check your connection and try again.",
      requiresSignIn: false,
    };
  }

  if (status === 401) {
    return {
      status: "unauthenticated",
      message: "Sign in required to view shifts. Please sign in to access your team schedule.",
      requiresSignIn: true,
      signInAction: "/api/auth/login",
    };
  }

  if (status === 403) {
    return {
      status: "forbidden",
      message:
        "Your account is not currently assigned to an active team or workspace. Contact your organization administrator for access.",
      requiresSignIn: false,
    };
  }

  if (status >= 200 && status < 300) {
    const rawList = Array.isArray(body) ? (body as ApiShift[]) : [];
    return {
      status: "success",
      shifts: rawList.map((item, idx) => mapApiShift(item, idx)),
      requiresSignIn: false,
    };
  }

  const errorMsg =
    body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).error === "string"
      ? ((body as Record<string, unknown>).error as string)
      : "Unable to load shifts from the database.";

  return {
    status: "network_error",
    message: errorMsg,
    requiresSignIn: false,
  };
}

export type ShiftRecoveryOutcome =
  | {
      status: "unauthenticated";
      message: string;
    }
  | {
      status: "forbidden";
      message: string;
    }
  | {
      status: "conflict";
      message: string;
    }
  | {
      status: "error";
      message: string;
    }
  | {
      status: "success";
      recoveredCount: number;
      targetTeamId: number;
      message: string;
    };

/**
 * Resolves legacy shift recovery API response into typed UI outcomes.
 *
 * @param status HTTP response status code (e.g. 200, 400, 401, 403, 409, 500)
 * @param body Parsed JSON response body or null
 */
export function resolveShiftRecoveryResponse(
  status: number,
  body: unknown
): ShiftRecoveryOutcome {
  if (status === 401) {
    return {
      status: "unauthenticated",
      message: "Authentication required. Please sign in to recover shifts.",
    };
  }

  if (status === 403) {
    const errorMsg =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
        ? ((body as Record<string, unknown>).error as string)
        : "Access denied: You are not authorized to assign shifts to this workspace.";
    return {
      status: "forbidden",
      message: errorMsg,
    };
  }

  if (status === 409) {
    return {
      status: "conflict",
      message: "One or more shifts have already been assigned to a workspace.",
    };
  }

  if (status >= 200 && status < 300) {
    const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    return {
      status: "success",
      recoveredCount: typeof data.recoveredCount === "number" ? data.recoveredCount : 0,
      targetTeamId: typeof data.targetTeamId === "number" ? data.targetTeamId : 0,
      message: typeof data.message === "string" ? data.message : "Shifts recovered successfully.",
    };
  }

  const errorMsg =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
      ? ((body as Record<string, unknown>).error as string)
      : "Failed to recover legacy shifts. Please try again.";

  return {
    status: "error",
    message: errorMsg,
  };
}

export const SHIFTS_OFFLINE_STORAGE_KEY = "rota_cached_shifts_v1";
export const SHIFTS_OFFLINE_TIMESTAMP_KEY = "rota_cached_shifts_timestamp_v1";

export interface UserContextIdentifier {
  userId: number;
  email?: string;
  teamId?: number | string | null;
}

export interface OfflineShiftCacheRecord {
  userId: number;
  userEmail?: string;
  teamId: number | string | null;
  shifts: ScheduleShift[];
  timestamp: string;
}

/**
 * Persists an array of schedule shifts to browser local storage for offline resilience,
 * bound strictly to the authenticated user and their active workspace.
 */
export function saveShiftsToOfflineCache(
  shifts: ScheduleShift[],
  userContext?: UserContextIdentifier | null
): void {
  if (typeof window === "undefined" || !window.localStorage) return;

  // Unauthenticated callers must not cache shift data
  if (!userContext || typeof userContext.userId !== "number" || userContext.userId <= 0) {
    return;
  }

  try {
    const record: OfflineShiftCacheRecord = {
      userId: userContext.userId,
      userEmail: userContext.email,
      teamId:
        userContext.teamId !== undefined && userContext.teamId !== null
          ? userContext.teamId
          : null,
      shifts: Array.isArray(shifts) ? shifts : [],
      timestamp: new Date().toISOString(),
    };
    window.localStorage.setItem(SHIFTS_OFFLINE_STORAGE_KEY, JSON.stringify(record));
    window.localStorage.setItem(SHIFTS_OFFLINE_TIMESTAMP_KEY, record.timestamp);
  } catch {
    // Ignore storage quota or disabled storage exceptions
  }
}

/**
 * Retrieves cached schedule shifts from browser local storage when offline or disconnected.
 * Enforces strict account isolation (userId match) and workspace isolation (teamId match).
 * Rejects legacy un-enveloped or cross-account data to prevent shared-device data leakage.
 */
export function loadShiftsFromOfflineCache(
  userContext?: UserContextIdentifier | null
): { shifts: ScheduleShift[]; timestamp: string | null } | null {
  if (typeof window === "undefined" || !window.localStorage) return null;

  // Unauthenticated visitors or logged-out users must never access previous user's shifts
  if (!userContext || typeof userContext.userId !== "number" || userContext.userId <= 0) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(SHIFTS_OFFLINE_STORAGE_KEY);
    const fallbackTimestamp = window.localStorage.getItem(SHIFTS_OFFLINE_TIMESTAMP_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);

    // If cache format is an un-enveloped legacy array, clear it and reject to prevent data leak
    if (Array.isArray(parsed)) {
      clearShiftsOfflineCache();
      return null;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.shifts)) {
      return null;
    }

    // 1. Account Isolation Guard: Reject if cached userId does not match current authenticated user
    if (parsed.userId !== userContext.userId) {
      return null;
    }

    // 2. Workspace Isolation Guard: Reject if cached teamId does not match current workspace
    const cachedTeam =
      parsed.teamId !== null && parsed.teamId !== undefined
        ? String(parsed.teamId)
        : null;
    const currentTeam =
      userContext.teamId !== null && userContext.teamId !== undefined
        ? String(userContext.teamId)
        : null;

    if (cachedTeam !== currentTeam) {
      return null;
    }

    if (parsed.shifts.length === 0) {
      return null;
    }

    return {
      shifts: parsed.shifts as ScheduleShift[],
      timestamp: parsed.timestamp || fallbackTimestamp,
    };
  } catch {
    return null;
  }
}

/**
 * Purges cached shift data from browser local storage.
 * Called on logout, account switching, or workspace switching.
 */
export function clearShiftsOfflineCache(options?: {
  userId?: number;
  teamId?: number | string | null;
  all?: boolean;
}): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (options?.all || (!options?.userId && options?.teamId === undefined)) {
      window.localStorage.removeItem(SHIFTS_OFFLINE_STORAGE_KEY);
      window.localStorage.removeItem(SHIFTS_OFFLINE_TIMESTAMP_KEY);
      return;
    }

    const raw = window.localStorage.getItem(SHIFTS_OFFLINE_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      window.localStorage.removeItem(SHIFTS_OFFLINE_STORAGE_KEY);
      window.localStorage.removeItem(SHIFTS_OFFLINE_TIMESTAMP_KEY);
      return;
    }

    // Invalidate if matches specified user or team
    const matchesUser = options.userId !== undefined && parsed.userId === options.userId;
    const matchesTeam =
      options.teamId !== undefined && String(parsed.teamId) === String(options.teamId);

    if (matchesUser || matchesTeam) {
      window.localStorage.removeItem(SHIFTS_OFFLINE_STORAGE_KEY);
      window.localStorage.removeItem(SHIFTS_OFFLINE_TIMESTAMP_KEY);
    }
  } catch {
    try {
      window.localStorage.removeItem(SHIFTS_OFFLINE_STORAGE_KEY);
      window.localStorage.removeItem(SHIFTS_OFFLINE_TIMESTAMP_KEY);
    } catch {}
  }
}

export {
  computeShiftsRevision,
  resolveShiftSyncResponse,
  type ShiftSyncResponse,
  type ShiftSyncOutcome,
  type ShiftRevisionInput,
} from "./shifts-sync.ts";

export {
  type ShiftSwapRecord,
  type ShiftSwapStatus,
  type CreateSwapRequestInput,
  validateSwapRequest,
  canApproveSwap,
  canCancelSwap,
} from "./shift-swaps.ts";

export const SETTINGS_OFFLINE_STORAGE_KEY = "rota_cached_user_settings_v1";

export interface OfflineSettingsCacheRecord {
  userId: number;
  userEmail?: string;
  teamId: number | string | null;
  settings: import("./settings.ts").UserSettings;
  timestamp: string;
}

/**
 * Persists user settings to browser local storage for offline resilience,
 * strictly bound to the authenticated user and active workspace.
 */
export function saveSettingsToOfflineCache(
  settings: import("./settings.ts").UserSettings,
  userContext?: UserContextIdentifier | null
): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  if (!userContext || typeof userContext.userId !== "number" || userContext.userId <= 0) return;

  try {
    const record: OfflineSettingsCacheRecord = {
      userId: userContext.userId,
      userEmail: userContext.email,
      teamId:
        userContext.teamId !== undefined && userContext.teamId !== null
          ? userContext.teamId
          : null,
      settings,
      timestamp: new Date().toISOString(),
    };
    window.localStorage.setItem(SETTINGS_OFFLINE_STORAGE_KEY, JSON.stringify(record));
  } catch {}
}

/**
 * Loads user settings from browser local storage with strict account and workspace isolation.
 */
export function loadSettingsFromOfflineCache(
  userContext?: UserContextIdentifier | null
): import("./settings.ts").UserSettings | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  if (!userContext || typeof userContext.userId !== "number" || userContext.userId <= 0) return null;

  try {
    const raw = window.localStorage.getItem(SETTINGS_OFFLINE_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    // 1. Account Isolation Guard: Reject if cached userId does not match current authenticated user
    if (parsed.userId !== userContext.userId) {
      clearSettingsOfflineCache();
      return null;
    }

    // 2. Workspace Isolation Guard: Reject if cached teamId does not match current workspace
    const cachedTeam =
      parsed.teamId !== null && parsed.teamId !== undefined
        ? String(parsed.teamId)
        : null;
    const currentTeam =
      userContext.teamId !== null && userContext.teamId !== undefined
        ? String(userContext.teamId)
        : null;

    if (cachedTeam !== currentTeam) {
      return null;
    }

    return parsed.settings || null;
  } catch {
    return null;
  }
}

/**
 * Purges cached settings data from browser local storage on logout or account switch.
 */
export function clearSettingsOfflineCache(options?: {
  userId?: number;
  teamId?: number | string | null;
  all?: boolean;
}): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (options?.all || (!options?.userId && options?.teamId === undefined)) {
      window.localStorage.removeItem(SETTINGS_OFFLINE_STORAGE_KEY);
      return;
    }

    const raw = window.localStorage.getItem(SETTINGS_OFFLINE_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      window.localStorage.removeItem(SETTINGS_OFFLINE_STORAGE_KEY);
      return;
    }

    const matchesUser = options.userId !== undefined && parsed.userId === options.userId;
    const matchesTeam =
      options.teamId !== undefined && String(parsed.teamId) === String(options.teamId);

    if (matchesUser || matchesTeam) {
      window.localStorage.removeItem(SETTINGS_OFFLINE_STORAGE_KEY);
    }
  } catch {
    try {
      window.localStorage.removeItem(SETTINGS_OFFLINE_STORAGE_KEY);
    } catch {}
  }
}

/**
 * Applies the user's selected theme to documentElement classes and attributes.
 */
export function applyThemeToDocument(theme: import("./settings.ts").UserTheme): void {
  if (typeof document === "undefined") return;
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches);

  if (isDark) {
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.classList.remove("dark");
    document.documentElement.setAttribute("data-theme", "light");
  }
}

/**
 * Applies the user's selected language to the document root lang attribute.
 */
export function applyLanguageToDocument(language: string): void {
  if (typeof document === "undefined") return;
  if (language && typeof language === "string") {
    document.documentElement.lang = language;
  }
}

export {
  type UserTheme,
  type UserSettings,
  type UserSettingsNotifications,
  type SupportedLanguageCode,
  SUPPORTED_THEMES,
  SUPPORTED_LANGUAGES,
  isValidTheme,
  normalizeTheme,
  isValidLanguage,
  normalizeLanguage,
  getDefaultUserSettings,
  resolveSettingsConflict,
} from "./settings.ts";

export {
  type NotificationCategory,
  type NotificationRecord,
  type UserNotificationPreferences,
  type QuietHoursConfig,
  type DeviceTokenRecord,
  shouldDeliverNotification,
  isWithinQuietHours,
  buildNotificationDeepLink,
  generateNotificationIdempotencyKey,
  formatNotificationContent,
} from "./notifications.ts";






