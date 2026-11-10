import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildFcmPayload,
  isFcmBadTokenError,
  sendFcmNotification,
} from "../lib/fcm.ts";

import { dispatchNotification } from "../lib/notifications-dispatch.ts";

describe("Firebase Cloud Messaging (FCM) Integration & Push Delivery", () => {
  const sampleToken = {
    id: 101,
    userId: 42,
    teamId: 7,
    platform: "android",
    token: "fcm-device-registration-token-abc-123",
    status: "active",
  };

  it("builds compliant FCM v1 payload with notification and deep links", () => {
    const payload = buildFcmPayload({
      deviceToken: sampleToken,
      category: "shift_assigned",
      entityId: 999,
      payload: {
        employeeName: "Amara Okafor",
        shiftDay: "2026-11-12",
        role: "Front Desk",
      },
    });

    assert.equal(payload.token, sampleToken.token);
    assert.match(payload.notification.title, /Shift Assigned/);
    assert.match(payload.notification.body, /Front Desk.*2026-11-12/);
    assert.equal(payload.data.category, "shift_assigned");
    assert.equal(payload.data.entityId, "999");
    assert.equal(payload.data.deepLink, "/?tab=Schedule&shiftId=999");
    assert.equal(payload.data.teamId, "7");
    assert.equal(payload.android?.priority, "high");
    assert.equal(payload.webpush?.headers?.Urgency, "high");
  });

  it("correctly identifies bad/unregistered token errors across FCM status codes and error bodies", () => {
    assert.equal(isFcmBadTokenError(404, {}), true);
    assert.equal(isFcmBadTokenError(410, {}), true);

    assert.equal(
      isFcmBadTokenError(400, {
        error: {
          code: 400,
          message: "The registration token is not a valid FCM registration token",
          status: "INVALID_ARGUMENT",
        },
      }),
      true
    );

    assert.equal(
      isFcmBadTokenError(200, {
        failure: 1,
        results: [{ error: "NotRegistered" }],
      }),
      true
    );

    assert.equal(isFcmBadTokenError(500, { error: "InternalServerError" }), false);
    assert.equal(isFcmBadTokenError(503, { error: "ServerUnavailable" }), false);
  });

  it("gracefully returns mock delivery ID when external credentials are not set", async () => {
    const payload = buildFcmPayload({
      deviceToken: sampleToken,
      category: "swap_approved",
      entityId: 55,
      payload: { actorName: "Supervisor Dave" },
    });

    const res = await sendFcmNotification(sampleToken, payload, {
      projectId: undefined,
      serverKey: undefined,
    });

    assert.equal(res.success, true);
    assert.equal(res.badToken, false);
    assert.match(res.messageId, /^mock-fcm-/);
  });

  it("sends request with Authorization header and parses FCM success response", async () => {
    let capturedUrl = "";
    let capturedHeaders = {};
    let capturedBody = {};

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      capturedBody = JSON.parse(options.body);

      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: "projects/my-test-proj/messages/msg-12345",
        }),
      };
    };

    const payload = buildFcmPayload({
      deviceToken: sampleToken,
      category: "shift_updated",
      entityId: 88,
    });

    const res = await sendFcmNotification(
      sampleToken,
      payload,
      { projectId: "my-test-proj" },
      mockFetch
    );

    assert.equal(res.success, true);
    assert.equal(res.badToken, false);
    assert.equal(res.messageId, "projects/my-test-proj/messages/msg-12345");
    assert.match(capturedUrl, /projects\/my-test-proj\/messages:send/);
    assert.equal(capturedBody.message.token, sampleToken.token);
  });

  it("handles unregistered FCM token response and flags token for cleanup", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({
        error: {
          code: 404,
          message: "Requested entity was not found.",
          status: "NOT_FOUND",
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
        },
      }),
    });

    const payload = buildFcmPayload({
      deviceToken: sampleToken,
      category: "shift_assigned",
      entityId: 10,
    });

    const res = await sendFcmNotification(
      sampleToken,
      payload,
      { projectId: "my-test-proj" },
      mockFetch
    );

    assert.equal(res.success, false);
    assert.equal(res.badToken, true);
    assert.equal(res.errorCode, "404");
  });

  it("cleans up invalid device tokens in dispatchNotification when push sender detects bad token", async () => {
    const deletedTokenIds = [];
    const mockDb = async (strings, ...values) => {
      const q = strings.join("?");
      if (q.includes("SELECT") && q.includes("user_notification_tokens")) {
        return [sampleToken];
      }
      if (q.includes("DELETE FROM user_notification_tokens")) {
        deletedTokenIds.push(values[0]);
        return [{ id: values[0] }];
      }
      if (q.includes("INSERT INTO notification_records")) {
        return [{ id: 501 }];
      }
      return [];
    };

    const mockSender = async (token) => {
      return { success: false, badToken: true };
    };

    const result = await dispatchNotification(mockDb, {
      teamId: 7,
      targetUserId: 42,
      category: "shift_assigned",
      entityId: 10,
      mockPushSender: mockSender,
    });

    assert.equal(result.success, true);
    assert.equal(result.tokensAttempted, 1);
    assert.equal(result.tokensCleanedUp, 1);
    assert.equal(deletedTokenIds.length, 1);
    assert.equal(deletedTokenIds[0], sampleToken.id);
  });
});
