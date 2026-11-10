import type { SessionPayload } from "../../../../lib/auth.ts";
import {
  type UserNotificationPreferences,
  getDefaultNotificationPreferences,
  isValidTimeString,
  normalizeTimezone,
  ensureNotificationsTables,
} from "../../../../lib/notifications.ts";

export type NotificationPreferencesDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<Required<NotificationPreferencesDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<NotificationPreferencesDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("@/lib/db"),
      import("@/lib/session"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleGetPreferences(
  request: Request,
  dependencies?: NotificationPreferencesDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace found." },
        { status: 403 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    try {
      await ensureNotificationsTables(executeSql);
    } catch {}

    const rows = await executeSql`
      SELECT
        enabled,
        notify_shift_assigned,
        notify_shift_updated,
        notify_swap_requested,
        notify_swap_approved,
        notify_swap_rejected,
        notify_swap_cancelled,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        timezone,
        updated_at
      FROM user_notification_preferences
      WHERE user_id = ${sessionUser.userId} AND team_id = ${sessionUser.teamId}
      LIMIT 1;
    `;

    if (!rows || rows.length === 0) {
      const defaults = getDefaultNotificationPreferences(sessionUser.userId, sessionUser.teamId);
      return Response.json(defaults);
    }

    const row = rows[0];
    const prefs: UserNotificationPreferences = {
      userId: sessionUser.userId,
      teamId: sessionUser.teamId,
      enabled: Boolean(row.enabled),
      categories: {
        shift_assigned: Boolean(row.notify_shift_assigned),
        shift_updated: Boolean(row.notify_shift_updated),
        swap_requested: Boolean(row.notify_swap_requested),
        swap_approved: Boolean(row.notify_swap_approved),
        swap_rejected: Boolean(row.notify_swap_rejected),
        swap_cancelled: Boolean(row.notify_swap_cancelled),
      },
      quietHours: {
        enabled: Boolean(row.quiet_hours_enabled),
        start: String(row.quiet_hours_start || "22:00"),
        end: String(row.quiet_hours_end || "08:00"),
        timezone: String(row.timezone || "UTC"),
      },
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    };

    return Response.json(prefs);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to fetch notification preferences:", error);
    return Response.json(
      { error: "Unable to retrieve notification preferences." },
      { status: 500 }
    );
  }
}

export async function handleUpdatePreferences(
  request: Request,
  dependencies?: NotificationPreferencesDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace found." },
        { status: 403 }
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return Response.json({ error: "Invalid preferences payload." }, { status: 400 });
    }

    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;
    const cats = body.categories || {};
    const notifyShiftAssigned = cats.shift_assigned !== undefined ? Boolean(cats.shift_assigned) : true;
    const notifyShiftUpdated = cats.shift_updated !== undefined ? Boolean(cats.shift_updated) : true;
    const notifySwapRequested = cats.swap_requested !== undefined ? Boolean(cats.swap_requested) : true;
    const notifySwapApproved = cats.swap_approved !== undefined ? Boolean(cats.swap_approved) : true;
    const notifySwapRejected = cats.swap_rejected !== undefined ? Boolean(cats.swap_rejected) : true;
    const notifySwapCancelled = cats.swap_cancelled !== undefined ? Boolean(cats.swap_cancelled) : true;

    const quiet = body.quietHours || {};
    const quietHoursEnabled = Boolean(quiet.enabled);
    const quietHoursStart = typeof quiet.start === "string" && isValidTimeString(quiet.start)
      ? quiet.start.trim()
      : "22:00";
    const quietHoursEnd = typeof quiet.end === "string" && isValidTimeString(quiet.end)
      ? quiet.end.trim()
      : "08:00";
    const tz = normalizeTimezone(quiet.timezone);

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    try {
      await ensureNotificationsTables(executeSql);
    } catch {}

    const upserted = await executeSql`
      INSERT INTO user_notification_preferences (
        user_id,
        team_id,
        enabled,
        notify_shift_assigned,
        notify_shift_updated,
        notify_swap_requested,
        notify_swap_approved,
        notify_swap_rejected,
        notify_swap_cancelled,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        timezone,
        updated_at
      ) VALUES (
        ${sessionUser.userId},
        ${sessionUser.teamId},
        ${enabled},
        ${notifyShiftAssigned},
        ${notifyShiftUpdated},
        ${notifySwapRequested},
        ${notifySwapApproved},
        ${notifySwapRejected},
        ${notifySwapCancelled},
        ${quietHoursEnabled},
        ${quietHoursStart},
        ${quietHoursEnd},
        ${tz},
        NOW()
      )
      ON CONFLICT (user_id, team_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        notify_shift_assigned = EXCLUDED.notify_shift_assigned,
        notify_shift_updated = EXCLUDED.notify_shift_updated,
        notify_swap_requested = EXCLUDED.notify_swap_requested,
        notify_swap_approved = EXCLUDED.notify_swap_approved,
        notify_swap_rejected = EXCLUDED.notify_swap_rejected,
        notify_swap_cancelled = EXCLUDED.notify_swap_cancelled,
        quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
        quiet_hours_start = EXCLUDED.quiet_hours_start,
        quiet_hours_end = EXCLUDED.quiet_hours_end,
        timezone = EXCLUDED.timezone,
        updated_at = NOW()
      RETURNING *;
    `;

    return Response.json({
      success: true,
      preferences: {
        userId: sessionUser.userId,
        teamId: sessionUser.teamId,
        enabled,
        categories: {
          shift_assigned: notifyShiftAssigned,
          shift_updated: notifyShiftUpdated,
          swap_requested: notifySwapRequested,
          swap_approved: notifySwapApproved,
          swap_rejected: notifySwapRejected,
          swap_cancelled: notifySwapCancelled,
        },
        quietHours: {
          enabled: quietHoursEnabled,
          start: quietHoursStart,
          end: quietHoursEnd,
          timezone: tz,
        },
        updatedAt: new Date().toISOString(),
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
    console.error("Failed to update notification preferences:", error);
    return Response.json(
      { error: "Unable to update notification preferences." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetPreferences(request, deps);
}

export async function PUT(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleUpdatePreferences(request, deps);
}

export async function POST(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleUpdatePreferences(request, deps);
}

