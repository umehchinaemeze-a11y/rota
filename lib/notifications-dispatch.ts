/**
 * Server-side Notification Dispatcher and Event Ingestion Helper.
 *
 * Handles:
 * - Event deduplication via unique idempotency keys
 * - User notification preference checking & quiet hours evaluation
 * - Workspace isolation enforcement
 * - Recording notifications to PostgreSQL database
 * - Invalidation and cleanup of bad/expired device tokens
 */

import {
  type NotificationCategory,
  type UserNotificationPreferences,
  type DeviceTokenRecord,
  getDefaultNotificationPreferences,
  shouldDeliverNotification,
  buildNotificationDeepLink,
  generateNotificationIdempotencyKey,
  formatNotificationContent,
  ensureNotificationsTables,
} from "./notifications.ts";
import {
  buildFcmPayload,
  sendFcmNotification,
} from "./fcm.ts";

export interface DispatchNotificationOptions {
  teamId: number;
  targetUserId: number;
  category: NotificationCategory;
  entityId: number | string;
  revision?: string | number;
  payload?: {
    employeeName?: string;
    shiftDay?: string;
    role?: string;
    requesterName?: string;
    targetName?: string;
    actorName?: string;
    notes?: string;
  };
  now?: Date;
  mockPushSender?: (token: DeviceTokenRecord) => Promise<{ success: boolean; badToken?: boolean }>;
}

export interface DispatchResult {
  success: boolean;
  duplicate?: boolean;
  delivered?: boolean;
  suppressed?: boolean;
  reason?: string;
  notificationId?: number;
  tokensAttempted?: number;
  tokensCleanedUp?: number;
}

export async function dispatchNotification(
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>,
  options: DispatchNotificationOptions
): Promise<DispatchResult> {
  const {
    teamId,
    targetUserId,
    category,
    entityId,
    revision = "1",
    payload = {},
    now = new Date(),
    mockPushSender,
  } = options;

  try {
    await ensureNotificationsTables(sql);
  } catch {
    // Tables may already exist
  }

  // 1. Idempotency check: prevent duplicate notifications
  const idempotencyKey = generateNotificationIdempotencyKey(
    category,
    entityId,
    targetUserId,
    revision
  );

  try {
    const existing = await sql`
      SELECT id, delivered, read FROM notification_records
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1;
    `;

    if (existing && existing.length > 0) {
      return {
        success: true,
        duplicate: true,
        delivered: Boolean(existing[0].delivered),
        notificationId: Number(existing[0].id),
      };
    }
  } catch {
    // Safe fallback if table creation in flight
  }

  // 2. Fetch target user's preferences for this team
  let prefs: UserNotificationPreferences = getDefaultNotificationPreferences(
    targetUserId,
    teamId
  );

  try {
    const prefRows = await sql`
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
        timezone
      FROM user_notification_preferences
      WHERE user_id = ${targetUserId} AND team_id = ${teamId}
      LIMIT 1;
    `;

    if (prefRows && prefRows.length > 0) {
      const row = prefRows[0];
      prefs = {
        userId: targetUserId,
        teamId,
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
      };
    }
  } catch {
    // Use default preferences
  }

  // 3. Evaluate delivery eligibility (enabled status, categories, quiet hours)
  const deliveryDecision = shouldDeliverNotification(prefs, category, now);
  const deepLink = buildNotificationDeepLink(category, entityId);
  const { title, body } = formatNotificationContent(category, payload);

  let insertedId: number | undefined;

  try {
    const insertRes = await sql`
      INSERT INTO notification_records (
        team_id,
        user_id,
        category,
        title,
        body,
        deep_link,
        idempotency_key,
        delivered,
        suppressed_reason
      ) VALUES (
        ${teamId},
        ${targetUserId},
        ${category},
        ${title},
        ${body},
        ${deepLink},
        ${idempotencyKey},
        ${deliveryDecision.deliver},
        ${deliveryDecision.deliver ? null : deliveryDecision.reason || "suppressed"}
      )
      RETURNING id;
    `;

    if (insertRes && insertRes.length > 0) {
      insertedId = Number(insertRes[0].id);
    }
  } catch (dbError) {
    console.error("Failed to insert notification record:", dbError);
    return { success: false, reason: "database_insert_error" };
  }

  if (!deliveryDecision.deliver) {
    return {
      success: true,
      delivered: false,
      suppressed: true,
      reason: deliveryDecision.reason,
      notificationId: insertedId,
    };
  }

  // 4. Background device token delivery & invalid token cleanup
  let tokensCleanedUp = 0;
  let tokensAttempted = 0;

  try {
    const activeTokens: DeviceTokenRecord[] = await sql`
      SELECT id, user_id, team_id, platform, token, endpoint, p256dh, auth, status
      FROM user_notification_tokens
      WHERE user_id = ${targetUserId} AND team_id = ${teamId} AND status = 'active';
    `;

    tokensAttempted = activeTokens ? activeTokens.length : 0;

    if (activeTokens && activeTokens.length > 0) {
      for (const t of activeTokens) {
        try {
          let badToken = false;
          if (mockPushSender) {
            const sendRes = await mockPushSender(t);
            badToken = Boolean(sendRes.badToken);
          } else {
            const fcmPayload = buildFcmPayload({
              deviceToken: t,
              category,
              entityId,
              payload,
              now,
            });
            const sendRes = await sendFcmNotification(t, fcmPayload);
            badToken = Boolean(sendRes.badToken);
          }

          if (badToken) {
            // Clean up invalid device token
            await sql`
              DELETE FROM user_notification_tokens
              WHERE id = ${t.id} OR token = ${t.token};
            `;
            tokensCleanedUp++;
          }
        } catch {
          // Individual device error
        }
      }
    }
  } catch (err) {
    console.warn("Device token delivery check encountered error:", err);
  }

  return {
    success: true,
    delivered: true,
    suppressed: false,
    notificationId: insertedId,
    tokensAttempted,
    tokensCleanedUp,
  };
}

/**
 * Removes or marks an invalid device token when a push provider returns 404/410/InvalidRegistration.
 */
export async function cleanupInvalidToken(
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>,
  token: string
): Promise<number> {
  if (!token || typeof token !== "string") return 0;
  try {
    const res = await sql`
      DELETE FROM user_notification_tokens
      WHERE token = ${token.trim()}
      RETURNING id;
    `;
    return res ? res.length : 0;
  } catch {
    return 0;
  }
}

