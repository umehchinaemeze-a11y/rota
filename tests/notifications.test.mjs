import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isWithinQuietHours,
  shouldDeliverNotification,
  buildNotificationDeepLink,
  generateNotificationIdempotencyKey,
  formatNotificationContent,
  getDefaultNotificationPreferences,
  isValidTimeString,
  normalizeTimezone,
} from "../lib/notifications.ts";

import {
  dispatchNotification,
  cleanupInvalidToken,
} from "../lib/notifications-dispatch.ts";

import {
  handleGetNotifications,
  handleMarkNotificationsRead,
} from "../app/api/notifications/route.ts";

import {
  handleGetPreferences,
  handleUpdatePreferences,
} from "../app/api/notifications/preferences/route.ts";

import {
  handleRegisterToken,
  handleDeleteToken,
} from "../app/api/notifications/tokens/route.ts";

describe("Notifications — Pure Logic, Quiet Hours & Timezones", () => {
  it("validates 24-hour time strings correctly", () => {
    assert.equal(isValidTimeString("22:00"), true);
    assert.equal(isValidTimeString("08:30"), true);
    assert.equal(isValidTimeString("00:00"), true);
    assert.equal(isValidTimeString("23:59"), true);
    assert.equal(isValidTimeString("24:00"), false);
    assert.equal(isValidTimeString("8:00"), false);
    assert.equal(isValidTimeString("invalid"), false);
  });

  it("normalizes timezones and safely falls back to UTC", () => {
    assert.equal(normalizeTimezone("Africa/Lagos"), "Africa/Lagos");
    assert.equal(normalizeTimezone("UTC"), "UTC");
    assert.equal(normalizeTimezone("Invalid/Zone"), "UTC");
    assert.equal(normalizeTimezone(null), "UTC");
  });

  it("evaluates daytime quiet hours accurately within target timezone", () => {
    // 14:30 UTC
    const dateAt1430 = new Date("2026-11-20T14:30:00.000Z");
    // Quiet hours 14:00 to 16:00 UTC
    assert.equal(
      isWithinQuietHours(dateAt1430, "UTC", "14:00", "16:00"),
      true
    );
    // Quiet hours 15:00 to 17:00 UTC (14:30 is outside)
    assert.equal(
      isWithinQuietHours(dateAt1430, "UTC", "15:00", "17:00"),
      false
    );
  });

  it("evaluates overnight quiet hours spanning midnight across timezones", () => {
    // 23:30 UTC -> In Africa/Lagos (UTC+1), this is 00:30 next day
    const dateAt2330Utc = new Date("2026-11-20T23:30:00.000Z");

    // Overnight range: 22:00 to 08:00
    // In UTC (23:30), falls inside [22:00 - 08:00]
    assert.equal(
      isWithinQuietHours(dateAt2330Utc, "UTC", "22:00", "08:00"),
      true
    );

    // In Africa/Lagos (00:30), falls inside [22:00 - 08:00]
    assert.equal(
      isWithinQuietHours(dateAt2330Utc, "Africa/Lagos", "22:00", "08:00"),
      true
    );

    // Midday (12:00 UTC / 13:00 Lagos) falls outside overnight range
    const middayUtc = new Date("2026-11-20T12:00:00.000Z");
    assert.equal(
      isWithinQuietHours(middayUtc, "Africa/Lagos", "22:00", "08:00"),
      false
    );
  });

  it("generates correct canonical deep links for shifts and swap views", () => {
    assert.equal(
      buildNotificationDeepLink("shift_assigned", 101),
      "/?tab=Schedule&shiftId=101"
    );
    assert.equal(
      buildNotificationDeepLink("shift_updated", 102),
      "/?tab=Schedule&shiftId=102"
    );
    assert.equal(
      buildNotificationDeepLink("swap_requested", 55),
      "/?tab=Schedule&swapId=55"
    );
    assert.equal(
      buildNotificationDeepLink("swap_approved", 55),
      "/?tab=Schedule&swapId=55"
    );
  });

  it("formats user-friendly title and body for all notification categories", () => {
    const assigned = formatNotificationContent("shift_assigned", {
      shiftDay: "2026-11-25",
      role: "ICU Nurse",
    });
    assert.equal(assigned.title, "New Shift Assigned");
    assert.match(assigned.body, /2026-11-25/);
    assert.match(assigned.body, /ICU Nurse/);

    const swapReq = formatNotificationContent("swap_requested", {
      requesterName: "Dr. Admin",
      shiftDay: "2026-11-26",
    });
    assert.equal(swapReq.title, "Shift Swap Requested");
    assert.match(swapReq.body, /Dr\. Admin/);

    const approved = formatNotificationContent("swap_approved", {
      actorName: "Nurse Manager",
      shiftDay: "2026-11-26",
    });
    assert.equal(approved.title, "Shift Swap Approved");
    assert.match(approved.body, /Nurse Manager/);
  });

  it("evaluates preference enforcement and quiet hours suppression", () => {
    const prefs = getDefaultNotificationPreferences(1, 10);

    // Default: enabled
    const check1 = shouldDeliverNotification(prefs, "shift_assigned");
    assert.equal(check1.deliver, true);

    // Global disable
    const disabledPrefs = { ...prefs, enabled: false };
    const check2 = shouldDeliverNotification(disabledPrefs, "shift_assigned");
    assert.equal(check2.deliver, false);
    assert.equal(check2.reason, "notifications_disabled_by_user");

    // Category disable
    const catDisabled = {
      ...prefs,
      categories: { ...prefs.categories, shift_updated: false },
    };
    const check3 = shouldDeliverNotification(catDisabled, "shift_updated");
    assert.equal(check3.deliver, false);
    assert.equal(check3.reason, "category_shift_updated_disabled");

    // Quiet hours active
    const quietPrefs = {
      ...prefs,
      quietHours: {
        enabled: true,
        start: "22:00",
        end: "08:00",
        timezone: "UTC",
      },
    };
    const atMidnight = new Date("2026-11-20T00:30:00.000Z");
    const check4 = shouldDeliverNotification(quietPrefs, "shift_assigned", atMidnight);
    assert.equal(check4.deliver, false);
    assert.equal(check4.reason, "quiet_hours_active");
  });
});

describe("Notification Dispatcher — Deduplication, Token Cleanup & Persistence", () => {
  let inMemoryRecords = [];
  let inMemoryTokens = [];
  let inMemoryPrefs = [];

  function createDispatcherMockSql() {
    return async (strings, ...values) => {
      const q = strings.join("?");

      if (q.includes("SELECT id, delivered, read FROM notification_records")) {
        const key = values[0];
        return inMemoryRecords.filter((r) => r.idempotency_key === key);
      }

      if (q.includes("FROM user_notification_preferences")) {
        const [userId, teamId] = values;
        return inMemoryPrefs.filter((p) => p.user_id === userId && p.team_id === teamId);
      }

      if (q.includes("INSERT INTO notification_records")) {
        const [teamId, userId, category, title, body, deepLink, idempotencyKey, delivered, reason] = values;
        const newRecord = {
          id: inMemoryRecords.length + 1,
          team_id: teamId,
          user_id: userId,
          category,
          title,
          body,
          deep_link: deepLink,
          idempotency_key: idempotencyKey,
          delivered,
          suppressed_reason: reason,
          read: false,
          created_at: new Date().toISOString(),
        };
        inMemoryRecords.push(newRecord);
        return [{ id: newRecord.id }];
      }

      if (q.includes("SELECT id, user_id, team_id, platform, token")) {
        const [userId, teamId] = values;
        return inMemoryTokens.filter(
          (t) => t.user_id === userId && t.team_id === teamId && t.status === "active"
        );
      }

      if (q.includes("DELETE FROM user_notification_tokens")) {
        const tokenVal = values[values.length - 1];
        const initialLen = inMemoryTokens.length;
        inMemoryTokens = inMemoryTokens.filter((t) => t.token !== tokenVal && t.id !== tokenVal);
        const removed = initialLen - inMemoryTokens.length;
        return Array(removed).fill({ id: 1 });
      }

      return [];
    };
  }

  it("dispatches shift_assigned notification and stores database record", async () => {
    inMemoryRecords = [];
    inMemoryTokens = [
      { id: 1, user_id: 10, team_id: 5, platform: "web", token: "endpoint-token-abc", status: "active" },
    ];
    inMemoryPrefs = [];

    const sqlMock = createDispatcherMockSql();

    const res = await dispatchNotification(sqlMock, {
      teamId: 5,
      targetUserId: 10,
      category: "shift_assigned",
      entityId: 201,
      payload: { shiftDay: "2026-11-25", role: "Nurse" },
    });

    assert.equal(res.success, true);
    assert.equal(res.delivered, true);
    assert.equal(inMemoryRecords.length, 1);
    assert.equal(inMemoryRecords[0].category, "shift_assigned");
    assert.equal(inMemoryRecords[0].deep_link, "/?tab=Schedule&shiftId=201");
  });

  it("prevents duplicate notifications via idempotency key protection", async () => {
    const sqlMock = createDispatcherMockSql();

    // Call identical notification again
    const res = await dispatchNotification(sqlMock, {
      teamId: 5,
      targetUserId: 10,
      category: "shift_assigned",
      entityId: 201,
      payload: { shiftDay: "2026-11-25", role: "Nurse" },
    });

    assert.equal(res.success, true);
    assert.equal(res.duplicate, true);
    assert.equal(inMemoryRecords.length, 1, "Must not create a duplicate record in DB");
  });

  it("suppresses delivery during quiet hours and records suppression reason", async () => {
    const sqlMock = createDispatcherMockSql();

    inMemoryPrefs = [
      {
        user_id: 20,
        team_id: 5,
        enabled: true,
        notify_shift_assigned: true,
        notify_shift_updated: true,
        notify_swap_requested: true,
        notify_swap_approved: true,
        notify_swap_rejected: true,
        notify_swap_cancelled: true,
        quiet_hours_enabled: true,
        quiet_hours_start: "22:00",
        quiet_hours_end: "08:00",
        timezone: "UTC",
      },
    ];

    const midnightUtc = new Date("2026-11-20T23:30:00.000Z");

    const res = await dispatchNotification(sqlMock, {
      teamId: 5,
      targetUserId: 20,
      category: "shift_updated",
      entityId: 202,
      now: midnightUtc,
    });

    assert.equal(res.success, true);
    assert.equal(res.delivered, false);
    assert.equal(res.suppressed, true);
    assert.equal(res.reason, "quiet_hours_active");

    const saved = inMemoryRecords.find((r) => r.user_id === 20);
    assert.equal(saved.delivered, false);
    assert.equal(saved.suppressed_reason, "quiet_hours_active");
  });

  it("cleans up invalid / expired device tokens safely upon push failure", async () => {
    inMemoryTokens = [
      { id: 99, user_id: 10, team_id: 5, platform: "web", token: "expired-token-xyz", status: "active" },
    ];

    const sqlMock = createDispatcherMockSql();

    // Mock sender returning badToken
    const mockSender = async (t) => {
      if (t.token === "expired-token-xyz") {
        return { success: false, badToken: true };
      }
      return { success: true };
    };

    const res = await dispatchNotification(sqlMock, {
      teamId: 5,
      targetUserId: 10,
      category: "swap_approved",
      entityId: 999,
      revision: "rev-cleanup",
      mockPushSender: mockSender,
    });

    assert.equal(res.success, true);
    assert.equal(res.tokensCleanedUp, 1);
    assert.equal(inMemoryTokens.length, 0, "Expired token must be cleaned up from database");
  });
});

describe("Notification API Routes — Endpoints & RBAC Workspace Isolation", () => {
  const staffSession = { userId: 10, name: "Nurse Jane", role: "Staff", teamId: 5 };
  const managerSession = { userId: 1, name: "Dr. Admin", role: "Owner", teamId: 5 };

  let inMemoryNotifications = [
    {
      id: 1,
      team_id: 5,
      user_id: 10,
      category: "shift_assigned",
      title: "New Shift Assigned",
      body: "You have a shift on 2026-11-25.",
      deep_link: "/?tab=Schedule&shiftId=101",
      read: false,
      delivered: true,
      created_at: new Date().toISOString(),
    },
    {
      id: 2,
      team_id: 99, // Other workspace
      user_id: 10,
      category: "shift_assigned",
      title: "Other Team Shift",
      body: "Shift in team 99.",
      deep_link: "/?tab=Schedule&shiftId=999",
      read: false,
      delivered: true,
      created_at: new Date().toISOString(),
    },
  ];

  let inMemoryTokens = [];

  function createRouteSqlMock() {
    return async (strings, ...values) => {
      const q = strings.join("?");

      if (q.includes("SELECT") && q.includes("FROM notification_records")) {
        const [userId, teamId] = values;
        return inMemoryNotifications.filter(
          (n) => n.user_id === userId && n.team_id === teamId
        );
      }

      if (q.includes("UPDATE notification_records") && q.includes("SET read = TRUE")) {
        const [notifId, userId, teamId] = values;
        inMemoryNotifications.forEach((n) => {
          if ((!notifId || n.id === notifId) && n.user_id === userId && n.team_id === teamId) {
            n.read = true;
          }
        });
        return [];
      }

      if (q.includes("INSERT INTO user_notification_tokens")) {
        const [userId, teamId, platform, token, endpoint, p256dh, auth] = values;
        const newTok = {
          id: inMemoryTokens.length + 1,
          user_id: userId,
          team_id: teamId,
          platform,
          token,
          endpoint,
          p256dh,
          auth,
          status: "active",
          last_seen_at: new Date().toISOString(),
        };
        inMemoryTokens.push(newTok);
        return [newTok];
      }

      if (q.includes("DELETE FROM user_notification_tokens")) {
        inMemoryTokens = [];
        return [];
      }

      return [];
    };
  }

  it("rejects unauthenticated notification requests with HTTP 401", async () => {
    const req = new Request("http://localhost/api/notifications");
    const res = await handleGetNotifications(req, {
      getSessionUser: async () => null,
      sql: createRouteSqlMock(),
    });
    assert.equal(res.status, 401);
  });

  it("enforces workspace isolation: lists only notifications for current workspace", async () => {
    const req = new Request("http://localhost/api/notifications");
    const res = await handleGetNotifications(req, {
      getSessionUser: async () => staffSession,
      sql: createRouteSqlMock(),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.notifications.length, 1);
    assert.equal(body.notifications[0].team_id, 5);
    assert.equal(body.unreadCount, 1);
  });

  it("marks notifications as read", async () => {
    const req = new Request("http://localhost/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1 }),
    });

    const res = await handleMarkNotificationsRead(req, {
      getSessionUser: async () => staffSession,
      sql: createRouteSqlMock(),
    });

    assert.equal(res.status, 200);
    assert.equal(inMemoryNotifications[0].read, true);
  });

  it("registers and deletes device tokens scoped to user and workspace", async () => {
    inMemoryTokens = [];
    const registerReq = new Request("http://localhost/api/notifications/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "web",
        token: "fcm-registration-token-12345",
        endpoint: "https://fcm.googleapis.com/fcm/send/12345",
      }),
    });

    const regRes = await handleRegisterToken(registerReq, {
      getSessionUser: async () => staffSession,
      sql: createRouteSqlMock(),
    });

    assert.equal(regRes.status, 201);
    assert.equal(inMemoryTokens.length, 1);
    assert.equal(inMemoryTokens[0].platform, "web");

    // Delete token
    const deleteReq = new Request("http://localhost/api/notifications/tokens", {
      method: "DELETE",
    });

    const delRes = await handleDeleteToken(deleteReq, {
      getSessionUser: async () => staffSession,
      sql: createRouteSqlMock(),
    });

    assert.equal(delRes.status, 200);
    assert.equal(inMemoryTokens.length, 0);
  });
});

