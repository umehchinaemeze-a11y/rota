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
