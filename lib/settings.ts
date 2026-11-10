/**
 * User Settings Domain Model, Serialization, Validation, and Deterministic Conflict Resolution.
 *
 * Implements:
 * - Theme synchronization ("system", "light", "dark")
 * - Language synchronization (BCP 47 & supported language codes)
 * - Timezone & Quiet Hours configuration
 * - Notification category preferences
 * - Monotonic server revision counter & updatedAt conflict detection
 * - Deterministic multi-device resolution
 * - Account and workspace multi-tenant isolation
 */

import {
  type QuietHoursConfig,
  type NotificationCategoriesConfig,
  DEFAULT_NOTIFICATION_CATEGORIES,
  DEFAULT_QUIET_HOURS,
  isValidTimeString,
  normalizeTimezone,
  ensureNotificationsTables,
} from "./notifications.ts";

export type UserTheme = "system" | "light" | "dark";

export const SUPPORTED_THEMES: readonly UserTheme[] = [
  "system",
  "light",
  "dark",
] as const;

export const SUPPORTED_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "yo", name: "Yorùbá" },
  { code: "ig", name: "Igbo" },
  { code: "ha", name: "Hausa" },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export interface UserSettingsNotifications {
  enabled: boolean;
  categories: NotificationCategoriesConfig;
}

export interface UserSettings {
  userId: number;
  teamId: number;
  theme: UserTheme;
  language: string;
  timezone: string;
  quietHours: QuietHoursConfig;
  notifications: UserSettingsNotifications;
  revision: number;
  updatedAt: string;
}

export function isValidTheme(theme: unknown): theme is UserTheme {
  return typeof theme === "string" && SUPPORTED_THEMES.includes(theme as UserTheme);
}

export function normalizeTheme(theme: unknown): UserTheme {
  if (isValidTheme(theme)) return theme;
  return "system";
}

export function isValidLanguage(lang: unknown): boolean {
  if (typeof lang !== "string") return false;
  const trimmed = lang.trim().toLowerCase();
  return /^[a-z]{2,5}(-[a-z0-9]{2,8})?$/.test(trimmed);
}

export function normalizeLanguage(lang: unknown): string {
  if (typeof lang !== "string") return "en";
  const trimmed = lang.trim().toLowerCase();
  if (SUPPORTED_LANGUAGES.some((l) => l.code === trimmed)) {
    return trimmed;
  }
  if (isValidLanguage(trimmed)) {
    return trimmed;
  }
  return "en";
}

export function getDefaultUserSettings(userId: number, teamId: number): UserSettings {
  return {
    userId,
    teamId,
    theme: "system",
    language: "en",
    timezone: "UTC",
    quietHours: { ...DEFAULT_QUIET_HOURS },
    notifications: {
      enabled: true,
      categories: { ...DEFAULT_NOTIFICATION_CATEGORIES },
    },
    revision: 1,
    updatedAt: new Date(0).toISOString(),
  };
}

export interface ConflictResolutionResult {
  hasConflict: boolean;
  resolvedSettings: UserSettings;
  needsRevisionBump: boolean;
  reason?: string;
}

/**
 * Deterministically resolves multi-device settings conflicts using monotonic revision numbers.
 *
 * Rules:
 * 1. If clientExpectedRevision matches server revision (or omitted, or force=true):
 *    - Updates are accepted cleanly.
 *    - Server increments the revision monotonically and sets updatedAt = NOW().
 * 2. If clientExpectedRevision < currentServer.revision:
 *    - A stale overwrite from Device A is detected because Device B already committed a newer revision.
 *    - The conflict is flagged (`hasConflict = true`) and current authoritative server settings are returned.
 */
export function resolveSettingsConflict(
  clientProposed: Partial<UserSettings> & { expectedRevision?: number },
  currentServer: UserSettings,
  options?: { force?: boolean }
): ConflictResolutionResult {
  const expectedRev = clientProposed.expectedRevision;

  // Stale revision conflict guard
  if (
    expectedRev !== undefined &&
    expectedRev < currentServer.revision &&
    !options?.force
  ) {
    return {
      hasConflict: true,
      resolvedSettings: currentServer,
      needsRevisionBump: false,
      reason: `Settings conflict: Stale revision ${expectedRev} received; server is at revision ${currentServer.revision}.`,
    };
  }

  const resolvedTz = clientProposed.timezone
    ? normalizeTimezone(clientProposed.timezone)
    : currentServer.timezone;

  const resolvedQuiet: QuietHoursConfig = clientProposed.quietHours
    ? {
        enabled: Boolean(clientProposed.quietHours.enabled),
        start:
          typeof clientProposed.quietHours.start === "string" &&
          isValidTimeString(clientProposed.quietHours.start)
            ? clientProposed.quietHours.start.trim()
            : currentServer.quietHours.start,
        end:
          typeof clientProposed.quietHours.end === "string" &&
          isValidTimeString(clientProposed.quietHours.end)
            ? clientProposed.quietHours.end.trim()
            : currentServer.quietHours.end,
        timezone: clientProposed.quietHours.timezone
          ? normalizeTimezone(clientProposed.quietHours.timezone)
          : resolvedTz,
      }
    : currentServer.quietHours;

  const resolvedNotifications: UserSettingsNotifications = clientProposed.notifications
    ? {
        enabled:
          clientProposed.notifications.enabled !== undefined
            ? Boolean(clientProposed.notifications.enabled)
            : currentServer.notifications.enabled,
        categories: {
          ...currentServer.notifications.categories,
          ...(clientProposed.notifications.categories || {}),
        },
      }
    : currentServer.notifications;

  const merged: UserSettings = {
    userId: currentServer.userId,
    teamId: currentServer.teamId,
    theme: clientProposed.theme !== undefined
      ? normalizeTheme(clientProposed.theme)
      : currentServer.theme,
    language: clientProposed.language !== undefined
      ? normalizeLanguage(clientProposed.language)
      : currentServer.language,
    timezone: resolvedTz,
    quietHours: resolvedQuiet,
    notifications: resolvedNotifications,
    revision: currentServer.revision + 1,
    updatedAt: new Date().toISOString(),
  };

  return {
    hasConflict: false,
    resolvedSettings: merged,
    needsRevisionBump: true,
  };
}

/**
 * Migration helper: Idempotently creates or extends notification/settings tables in PostgreSQL.
 */
export async function ensureSettingsTables(
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>
): Promise<void> {
  await ensureNotificationsTables(sql);

  try {
    await sql`
      ALTER TABLE user_notification_preferences
      ADD COLUMN IF NOT EXISTS theme VARCHAR(16) NOT NULL DEFAULT 'system';
    `;
  } catch {}

  try {
    await sql`
      ALTER TABLE user_notification_preferences
      ADD COLUMN IF NOT EXISTS language VARCHAR(16) NOT NULL DEFAULT 'en';
    `;
  } catch {}

  try {
    await sql`
      ALTER TABLE user_notification_preferences
      ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
    `;
  } catch {}
}

