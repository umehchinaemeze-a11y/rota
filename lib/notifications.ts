/**
 * Pure Domain Models, Timezone-Aware Quiet Hours, and Event Notification Engine.
 *
 * Implements:
 * - Notification categories (shift assignments, updates, swaps, decisions)
 * - Timezone-aware quiet hours evaluation
 * - User notification preferences
 * - Idempotency and deduplication
 * - Deep link resolution for shifts and swap events
 * - Device token management and invalidation
 */

export type NotificationCategory =
  | "shift_assigned"
  | "shift_updated"
  | "swap_requested"
  | "swap_approved"
  | "swap_rejected"
  | "swap_cancelled";

export interface QuietHoursConfig {
  enabled: boolean;
  start: string; // "HH:MM" 24h format (e.g. "22:00")
  end: string;   // "HH:MM" 24h format (e.g. "08:00")
  timezone: string; // IANA timezone (e.g. "Africa/Lagos", "America/New_York", "UTC")
}

export interface NotificationCategoriesConfig {
  shift_assigned: boolean;
  shift_updated: boolean;
  swap_requested: boolean;
  swap_approved: boolean;
  swap_rejected: boolean;
  swap_cancelled: boolean;
}

export interface UserNotificationPreferences {
  userId: number;
  teamId: number;
  enabled: boolean;
  categories: NotificationCategoriesConfig;
  quietHours: QuietHoursConfig;
  updatedAt?: string;
}

export type DevicePlatform = "web" | "android" | "ios";

export interface DeviceTokenRecord {
  id?: number;
  userId: number;
  teamId: number;
  platform: DevicePlatform;
  token: string;
  endpoint?: string | null;
  p256dh?: string | null;
  auth?: string | null;
  status: "active" | "invalid";
  createdAt?: string;
  lastSeenAt?: string;
}

export interface NotificationRecord {
  id: number | string;
  teamId: number;
  userId: number;
  category: NotificationCategory;
  title: string;
  body: string;
  deepLink: string;
  idempotencyKey: string;
  read: boolean;
  delivered: boolean;
  suppressedReason?: string | null;
  createdAt: string;
}

export const DEFAULT_NOTIFICATION_CATEGORIES: NotificationCategoriesConfig = {
  shift_assigned: true,
  shift_updated: true,
  swap_requested: true,
  swap_approved: true,
  swap_rejected: true,
  swap_cancelled: true,
};

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: false,
  start: "22:00",
  end: "08:00",
  timezone: "UTC",
};

export function getDefaultNotificationPreferences(
  userId: number,
  teamId: number
): UserNotificationPreferences {
  return {
    userId,
    teamId,
    enabled: true,
    categories: { ...DEFAULT_NOTIFICATION_CATEGORIES },
    quietHours: { ...DEFAULT_QUIET_HOURS },
  };
}

/**
 * Validates a 24-hour time string in "HH:MM" format.
 */
export function isValidTimeString(timeStr: string): boolean {
  if (typeof timeStr !== "string") return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeStr.trim());
  return match !== null;
}

/**
 * Normalizes an IANA timezone identifier, falling back to UTC if invalid.
 */
export function normalizeTimezone(tz?: string | null): string {
  if (!tz || typeof tz !== "string") return "UTC";
  const trimmed = tz.trim();
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return trimmed;
  } catch {
    return "UTC";
  }
}

/**
 * Determines whether the given date/time falls within the configured quiet hours.
 * Supports both daytime quiet hours (e.g. 13:00 to 15:00) and overnight ranges (e.g. 22:00 to 08:00).
 */
export function isWithinQuietHours(
  now: Date,
  timezone: string,
  startStr: string,
  endStr: string
): boolean {
  if (!isValidTimeString(startStr) || !isValidTimeString(endStr)) {
    return false;
  }

  const validTz = normalizeTimezone(timezone);

  // Extract local hour and minute in target timezone using Intl
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: validTz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour");
  const minutePart = parts.find((p) => p.type === "minute");

  if (!hourPart || !minutePart) return false;

  const currentHour = parseInt(hourPart.value, 10);
  const currentMinute = parseInt(minutePart.value, 10);
  const currentMinutes = currentHour * 60 + currentMinute;

  const [startH, startM] = startStr.split(":").map(Number);
  const [endH, endM] = endStr.split(":").map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes === endMinutes) {
    // 24-hour quiet hours
    return true;
  }

  if (startMinutes < endMinutes) {
    // Daytime range (e.g. 13:00 to 15:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  // Overnight range (e.g. 22:00 to 08:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Pure evaluator: Determines whether a notification should be actively delivered
 * based on user preferences, category permissions, and quiet hours.
 */
export function shouldDeliverNotification(
  preferences: UserNotificationPreferences,
  category: NotificationCategory,
  now: Date = new Date()
): { deliver: boolean; reason?: string } {
  if (!preferences.enabled) {
    return { deliver: false, reason: "notifications_disabled_by_user" };
  }

  if (!preferences.categories[category]) {
    return { deliver: false, reason: `category_${category}_disabled` };
  }

  if (
    preferences.quietHours.enabled &&
    isWithinQuietHours(
      now,
      preferences.quietHours.timezone,
      preferences.quietHours.start,
      preferences.quietHours.end
    )
  ) {
    return { deliver: false, reason: "quiet_hours_active" };
  }

  return { deliver: true };
}

/**
 * Builds canonical deep links for Rota screens and entity views.
 */
export function buildNotificationDeepLink(
  category: NotificationCategory,
  entityId: number | string
): string {
  switch (category) {
    case "shift_assigned":
    case "shift_updated":
      return `/?tab=Schedule&shiftId=${encodeURIComponent(entityId)}`;
    case "swap_requested":
    case "swap_approved":
    case "swap_rejected":
    case "swap_cancelled":
      return `/?tab=Schedule&swapId=${encodeURIComponent(entityId)}`;
    default:
      return "/?tab=Schedule";
  }
}

/**
 * Generates an idempotency key to prevent duplicate notifications
 * when operations or webhook retries occur.
 */
export function generateNotificationIdempotencyKey(
  category: NotificationCategory,
  entityId: number | string,
  targetUserId: number,
  revision: string | number = "1"
): string {
  return `notif:${category}:${entityId}:u${targetUserId}:r${revision}`;
}

/**
 * Formats user-facing notification titles and message bodies.
 */
export function formatNotificationContent(
  category: NotificationCategory,
  payload: {
    employeeName?: string;
    shiftDay?: string;
    role?: string;
    requesterName?: string;
    targetName?: string;
    actorName?: string;
    notes?: string;
  }
): { title: string; body: string } {
  switch (category) {
    case "shift_assigned":
      return {
        title: "New Shift Assigned",
        body: payload.shiftDay
          ? `You have been assigned to a ${payload.role || "scheduled"} shift on ${payload.shiftDay}.`
          : `You have been assigned a new shift.`,
      };
    case "shift_updated":
      return {
        title: "Shift Schedule Changed",
        body: payload.shiftDay
          ? `Your shift on ${payload.shiftDay} has been updated.`
          : `Your scheduled shift has been updated.`,
      };
    case "swap_requested":
      return {
        title: "Shift Swap Requested",
        body: payload.requesterName
          ? `${payload.requesterName} requested a shift swap for ${payload.shiftDay || "an upcoming shift"}.`
          : `A new shift swap request requires review.`,
      };
    case "swap_approved":
      return {
        title: "Shift Swap Approved",
        body: payload.actorName
          ? `Your shift swap for ${payload.shiftDay || "the scheduled date"} was approved by ${payload.actorName}.`
          : `Your shift swap request has been approved.`,
      };
    case "swap_rejected":
      return {
        title: "Shift Swap Declined",
        body: payload.notes
          ? `Your shift swap request was declined: "${payload.notes}".`
          : `Your shift swap request was declined by a manager.`,
      };
    case "swap_cancelled":
      return {
        title: "Shift Swap Cancelled",
        body: `A shift swap request was cancelled by the requester.`,
      };
  }
}

/**
 * Migration helper: Idempotently creates notification tables in PostgreSQL.
 */
export async function ensureNotificationsTables(
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS user_notification_preferences (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      notify_shift_assigned BOOLEAN NOT NULL DEFAULT TRUE,
      notify_shift_updated BOOLEAN NOT NULL DEFAULT TRUE,
      notify_swap_requested BOOLEAN NOT NULL DEFAULT TRUE,
      notify_swap_approved BOOLEAN NOT NULL DEFAULT TRUE,
      notify_swap_rejected BOOLEAN NOT NULL DEFAULT TRUE,
      notify_swap_cancelled BOOLEAN NOT NULL DEFAULT TRUE,
      quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      quiet_hours_start VARCHAR(10) NOT NULL DEFAULT '22:00',
      quiet_hours_end VARCHAR(10) NOT NULL DEFAULT '08:00',
      timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE (user_id, team_id)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS user_notification_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      platform VARCHAR(16) NOT NULL,
      token TEXT NOT NULL,
      endpoint TEXT,
      p256dh TEXT,
      auth TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE (user_id, token)
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS notification_records (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category VARCHAR(32) NOT NULL,
      title VARCHAR(128) NOT NULL,
      body TEXT NOT NULL,
      deep_link TEXT NOT NULL,
      idempotency_key VARCHAR(128) NOT NULL UNIQUE,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      delivered BOOLEAN NOT NULL DEFAULT TRUE,
      suppressed_reason VARCHAR(64),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_notifications_user_team
    ON notification_records(user_id, team_id, read, created_at DESC);
  `;
}

