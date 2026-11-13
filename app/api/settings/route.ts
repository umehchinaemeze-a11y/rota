import type { SessionPayload } from "../../../lib/auth.ts";
import { isSameOriginRequest } from "../../../lib/oauth/safe-redirect.ts";
import {
  type UserSettings,
  getDefaultUserSettings,
  isValidTheme,
  normalizeTheme,
  isValidLanguage,
  normalizeLanguage,
  resolveSettingsConflict,
  ensureSettingsTables,
} from "../../../lib/settings.ts";
import {
  isValidTimeString,
  normalizeTimezone,
} from "../../../lib/notifications.ts";

export type SettingsRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

type ConcreteDependencies = {
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<ConcreteDependencies> | null = null;

async function loadProductionDependencies(): Promise<ConcreteDependencies> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("../../../lib/db.ts"),
      import("../../../lib/session.ts"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleGetSettings(
  request: Request,
  dependencies?: SettingsRouteDependencies
): Promise<Response> {
  try {
    const prodDeps = dependencies?.getSessionUser && dependencies?.sql ? null : await loadProductionDependencies();
    const resolveSessionUser = dependencies?.getSessionUser ?? prodDeps!.getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to retrieve user settings." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace found for this account." },
        { status: 403 }
      );
    }

    const executeSql = dependencies?.sql ?? prodDeps!.sql;

    try {
      await ensureSettingsTables(executeSql);
    } catch {}

    const rows = await executeSql`
      SELECT
        theme,
        language,
        timezone,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        enabled,
        notify_shift_assigned,
        notify_shift_updated,
        notify_swap_requested,
        notify_swap_approved,
        notify_swap_rejected,
        notify_swap_cancelled,
        revision,
        updated_at
      FROM user_notification_preferences
      WHERE user_id = ${sessionUser.userId} AND team_id = ${sessionUser.teamId}
      LIMIT 1;
    `;

    if (!rows || rows.length === 0) {
      const defaults = getDefaultUserSettings(sessionUser.userId, sessionUser.teamId);
      return Response.json({ settings: defaults });
    }

    const row = rows[0];
    const settings: UserSettings = {
      userId: sessionUser.userId,
      teamId: sessionUser.teamId,
      theme: normalizeTheme(row.theme),
      language: normalizeLanguage(row.language),
      timezone: normalizeTimezone(row.timezone),
      quietHours: {
        enabled: Boolean(row.quiet_hours_enabled),
        start: String(row.quiet_hours_start || "22:00"),
        end: String(row.quiet_hours_end || "08:00"),
        timezone: normalizeTimezone(row.timezone),
      },
      notifications: {
        enabled: Boolean(row.enabled),
        categories: {
          shift_assigned: Boolean(row.notify_shift_assigned),
          shift_updated: Boolean(row.notify_shift_updated),
          swap_requested: Boolean(row.notify_swap_requested),
          swap_approved: Boolean(row.notify_swap_approved),
          swap_rejected: Boolean(row.notify_swap_rejected),
          swap_cancelled: Boolean(row.notify_swap_cancelled),
        },
      },
      revision: typeof row.revision === "number" ? row.revision : 1,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    };

    return Response.json({ settings });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to retrieve user settings:", error);
    return Response.json(
      { error: "Unable to retrieve user settings." },
      { status: 500 }
    );
  }
}

export async function handleUpdateSettings(
  request: Request,
  dependencies?: SettingsRouteDependencies
): Promise<Response> {
  try {
    const prodDeps = dependencies?.getSessionUser && dependencies?.sql ? null : await loadProductionDependencies();
    const resolveSessionUser = dependencies?.getSessionUser ?? prodDeps!.getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to update user settings." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace found for this account." },
        { status: 403 }
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON request body." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return Response.json({ error: "Invalid settings payload." }, { status: 400 });
    }

    // Input validation
    if (body.theme !== undefined && !isValidTheme(body.theme)) {
      return Response.json(
        { error: "Invalid theme: must be system, light, or dark." },
        { status: 400 }
      );
    }

    if (body.language !== undefined && !isValidLanguage(body.language)) {
      return Response.json(
        { error: "Invalid language: must be a valid language code." },
        { status: 400 }
      );
    }

    if (body.quietHours) {
      if (
        body.quietHours.start !== undefined &&
        !isValidTimeString(body.quietHours.start)
      ) {
        return Response.json(
          { error: "Invalid quiet hours start time: must be HH:MM in 24-hour format." },
          { status: 400 }
        );
      }
      if (
        body.quietHours.end !== undefined &&
        !isValidTimeString(body.quietHours.end)
      ) {
        return Response.json(
          { error: "Invalid quiet hours end time: must be HH:MM in 24-hour format." },
          { status: 400 }
        );
      }
    }

    const executeSql = dependencies?.sql ?? prodDeps!.sql;

    try {
      await ensureSettingsTables(executeSql);
    } catch {}

    // Fetch existing server record
    const existing = await executeSql`
      SELECT
        theme,
        language,
        timezone,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        enabled,
        notify_shift_assigned,
        notify_shift_updated,
        notify_swap_requested,
        notify_swap_approved,
        notify_swap_rejected,
        notify_swap_cancelled,
        revision,
        updated_at
      FROM user_notification_preferences
      WHERE user_id = ${sessionUser.userId} AND team_id = ${sessionUser.teamId}
      LIMIT 1;
    `;

    const currentServer: UserSettings =
      existing && existing.length > 0
        ? {
            userId: sessionUser.userId,
            teamId: sessionUser.teamId,
            theme: normalizeTheme(existing[0].theme),
            language: normalizeLanguage(existing[0].language),
            timezone: normalizeTimezone(existing[0].timezone),
            quietHours: {
              enabled: Boolean(existing[0].quiet_hours_enabled),
              start: String(existing[0].quiet_hours_start || "22:00"),
              end: String(existing[0].quiet_hours_end || "08:00"),
              timezone: normalizeTimezone(existing[0].timezone),
            },
            notifications: {
              enabled: Boolean(existing[0].enabled),
              categories: {
                shift_assigned: Boolean(existing[0].notify_shift_assigned),
                shift_updated: Boolean(existing[0].notify_shift_updated),
                swap_requested: Boolean(existing[0].notify_swap_requested),
                swap_approved: Boolean(existing[0].notify_swap_approved),
                swap_rejected: Boolean(existing[0].notify_swap_rejected),
                swap_cancelled: Boolean(existing[0].notify_swap_cancelled),
              },
            },
            revision: typeof existing[0].revision === "number" ? existing[0].revision : 1,
            updatedAt: existing[0].updated_at
              ? new Date(existing[0].updated_at).toISOString()
              : new Date().toISOString(),
          }
        : getDefaultUserSettings(sessionUser.userId, sessionUser.teamId);

    // Conflict resolution check
    const resolution = resolveSettingsConflict(body, currentServer, {
      force: Boolean(body.force),
    });

    if (resolution.hasConflict) {
      return Response.json(
        {
          error: "Settings conflict detected: Another device has updated your settings.",
          conflict: true,
          serverSettings: resolution.resolvedSettings,
        },
        { status: 409 }
      );
    }

    const toSave = resolution.resolvedSettings;

    const upserted = await executeSql`
      INSERT INTO user_notification_preferences (
        user_id,
        team_id,
        theme,
        language,
        timezone,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        enabled,
        notify_shift_assigned,
        notify_shift_updated,
        notify_swap_requested,
        notify_swap_approved,
        notify_swap_rejected,
        notify_swap_cancelled,
        revision,
        updated_at
      ) VALUES (
        ${sessionUser.userId},
        ${sessionUser.teamId},
        ${toSave.theme},
        ${toSave.language},
        ${toSave.timezone},
        ${toSave.quietHours.enabled},
        ${toSave.quietHours.start},
        ${toSave.quietHours.end},
        ${toSave.notifications.enabled},
        ${toSave.notifications.categories.shift_assigned},
        ${toSave.notifications.categories.shift_updated},
        ${toSave.notifications.categories.swap_requested},
        ${toSave.notifications.categories.swap_approved},
        ${toSave.notifications.categories.swap_rejected},
        ${toSave.notifications.categories.swap_cancelled},
        ${toSave.revision},
        NOW()
      )
      ON CONFLICT (user_id, team_id) DO UPDATE SET
        theme = EXCLUDED.theme,
        language = EXCLUDED.language,
        timezone = EXCLUDED.timezone,
        quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
        quiet_hours_start = EXCLUDED.quiet_hours_start,
        quiet_hours_end = EXCLUDED.quiet_hours_end,
        enabled = EXCLUDED.enabled,
        notify_shift_assigned = EXCLUDED.notify_shift_assigned,
        notify_shift_updated = EXCLUDED.notify_shift_updated,
        notify_swap_requested = EXCLUDED.notify_swap_requested,
        notify_swap_approved = EXCLUDED.notify_swap_approved,
        notify_swap_rejected = EXCLUDED.notify_swap_rejected,
        notify_swap_cancelled = EXCLUDED.notify_swap_cancelled,
        revision = user_notification_preferences.revision + 1,
        updated_at = NOW()
      RETURNING
        theme,
        language,
        timezone,
        quiet_hours_enabled,
        quiet_hours_start,
        quiet_hours_end,
        enabled,
        notify_shift_assigned,
        notify_shift_updated,
        notify_swap_requested,
        notify_swap_approved,
        notify_swap_rejected,
        notify_swap_cancelled,
        revision,
        updated_at;
    `;

    const savedRow = upserted[0];
    const finalSettings: UserSettings = {
      userId: sessionUser.userId,
      teamId: sessionUser.teamId,
      theme: normalizeTheme(savedRow.theme),
      language: normalizeLanguage(savedRow.language),
      timezone: normalizeTimezone(savedRow.timezone),
      quietHours: {
        enabled: Boolean(savedRow.quiet_hours_enabled),
        start: String(savedRow.quiet_hours_start || "22:00"),
        end: String(savedRow.quiet_hours_end || "08:00"),
        timezone: normalizeTimezone(savedRow.timezone),
      },
      notifications: {
        enabled: Boolean(savedRow.enabled),
        categories: {
          shift_assigned: Boolean(savedRow.notify_shift_assigned),
          shift_updated: Boolean(savedRow.notify_shift_updated),
          swap_requested: Boolean(savedRow.notify_swap_requested),
          swap_approved: Boolean(savedRow.notify_swap_approved),
          swap_rejected: Boolean(savedRow.notify_swap_rejected),
          swap_cancelled: Boolean(savedRow.notify_swap_cancelled),
        },
      },
      revision: typeof savedRow.revision === "number" ? savedRow.revision : toSave.revision,
      updatedAt: savedRow.updated_at
        ? new Date(savedRow.updated_at).toISOString()
        : new Date().toISOString(),
    };

    return Response.json({
      success: true,
      settings: finalSettings,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to update user settings:", error);
    return Response.json(
      { error: "Unable to update user settings." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetSettings(request, deps);
}

export async function PUT(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const deps = await loadProductionDependencies();
  return handleUpdateSettings(request, deps);
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const deps = await loadProductionDependencies();
  return handleUpdateSettings(request, deps);
}

