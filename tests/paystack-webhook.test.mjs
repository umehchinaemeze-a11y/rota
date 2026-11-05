import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { handlePaystackWebhook } from "../app/api/billing/paystack/webhook/route.ts";
import { InMemoryBillingStorage } from "../lib/billing-storage.ts";
import { decryptAuthorizationCode } from "../lib/paystack-security.ts";

const VALID_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SECRET_KEY = "sk_test_paystack_webhook_secret_key_12345";

function computeSignature(payloadString, secret = TEST_SECRET_KEY) {
  return crypto.createHmac("sha512", secret).update(payloadString).digest("hex");
}

describe("Paystack Webhook — Phase 4 Signature & Ingestion Validation", () => {
  it("rejects webhook if PAYSTACK_SECRET_KEY is unconfigured", async () => {
    const body = JSON.stringify({ event: "charge.success", data: {} });
    const res = await handlePaystackWebhook(body, "dummy_sig", "", { secretKey: "" });
    assert.equal(res.status, 503);
    assert.match(res.body.message, /PAYSTACK_SECRET_KEY is not configured/);
  });

  it("rejects empty or whitespace-only webhook bodies with HTTP 400", async () => {
    const res = await handlePaystackWebhook("   ", "dummy_sig", TEST_SECRET_KEY);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Request body cannot be empty/);
  });

  it("rejects missing, forged or invalid HMAC-SHA512 signatures with HTTP 400", async () => {
    const body = JSON.stringify({ event: "charge.success", data: {} });

    // Missing signature
    const resMissing = await handlePaystackWebhook(body, null, TEST_SECRET_KEY);
    assert.equal(resMissing.status, 400);
    assert.match(resMissing.body.message, /verification failed/);

    // Forged signature
    const forgedSig = "a".repeat(128);
    const resForged = await handlePaystackWebhook(body, forgedSig, TEST_SECRET_KEY);
    assert.equal(resForged.status, 400);
    assert.match(resForged.body.message, /verification failed/);

    // Wrong secret signature
    const wrongSig = computeSignature(body, "wrong_secret_key");
    const resWrong = await handlePaystackWebhook(body, wrongSig, TEST_SECRET_KEY);
    assert.equal(resWrong.status, 400);
    assert.match(resWrong.body.message, /verification failed/);
  });

  it("rejects malformed non-JSON payloads with HTTP 400 even if signed", async () => {
    const malformedBody = "not a valid json {{{";
    const sig = computeSignature(malformedBody, TEST_SECRET_KEY);
    const res = await handlePaystackWebhook(malformedBody, sig, TEST_SECRET_KEY);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Failed to parse webhook JSON body/);
  });
});

describe("Paystack Webhook — Phase 4 Event Processing & Idempotency", () => {
  const teamId = 42;
  const planId = "pro";

  function createChargeSuccessPayload(reference = "pstk_ref_1001", reusable = true) {
    return {
      event: "charge.success",
      data: {
        id: 99901,
        reference,
        amount: 4500000, // ₦45,000 in kobo
        currency: "NGN",
        status: "success",
        channel: "card",
        customer: {
          customer_code: "CUS_pro_test",
          email: "owner@lagosclinic.ng",
        },
        authorization: {
          authorization_code: "AUTH_webhook_test_code",
          card_type: "mastercard",
          last4: "8888",
          exp_month: "08",
          exp_year: "2029",
          bin: "539983",
          bank: "Guaranty Trust Bank",
          channel: "card",
          reusable,
          country_code: "NG",
        },
        metadata: {
          workspace_id: teamId,
          plan_id: planId,
          seats: 50,
        },
      },
    };
  }

  it("processes charge.success when webhook arrives first and authoritatively activates subscription", async () => {
    const storage = new InMemoryBillingStorage();
    const payload = createChargeSuccessPayload("pstk_webhook_first_01", true);
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    const res = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      encryptionKey: VALID_KEY_HEX,
      currentTime: 1700000000,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.action, "subscription_activated");
    assert.equal(res.body.plan, "pro");
    assert.equal(res.body.autoRenewEnabled, true);

    // Verify storage record
    const sub = await storage.getSubscriptionByTeamId(teamId);
    assert.ok(sub);
    assert.equal(sub.paymentProvider, "paystack");
    assert.equal(sub.planId, "pro");
    assert.equal(sub.seats, 50);
    assert.equal(sub.status, "active");
    assert.equal(sub.autoRenewEnabled, true);
    assert.equal(sub.cardBrand, "mastercard");
    assert.equal(sub.cardLast4, "8888");
    assert.equal(sub.cardExpMonth, 8);
    assert.equal(sub.cardExpYear, 2029);

    // Verify encrypted authorization
    assert.ok(sub.paystackAuthCipher);
    assert.ok(sub.paystackAuthIv);
    assert.ok(sub.paystackAuthTag);
    const decrypted = decryptAuthorizationCode(
      {
        cipherText: sub.paystackAuthCipher,
        iv: sub.paystackAuthIv,
        tag: sub.paystackAuthTag,
      },
      VALID_KEY_HEX
    );
    assert.equal(decrypted, "AUTH_webhook_test_code");
  });

  it("handles duplicate webhook event idempotently without re-processing", async () => {
    const storage = new InMemoryBillingStorage();
    const payload = createChargeSuccessPayload("pstk_duplicate_event_01", true);
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    // First delivery
    const res1 = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      encryptionKey: VALID_KEY_HEX,
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.action, "subscription_activated");

    // Duplicate delivery of same event
    const res2 = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      encryptionKey: VALID_KEY_HEX,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.duplicate, true);
    assert.match(res2.body.message, /already processed/);
  });

  it("reconciles out-of-order arrival when client callback arrived before webhook", async () => {
    const storage = new InMemoryBillingStorage();
    const reference = "pstk_callback_first_01";

    // Simulate callback having already created the ledger entry and activated subscription
    await storage.recordLedgerEntry({
      transactionId: reference,
      teamId,
      eventId: "pstk_callback_verification",
      type: "charge.success",
      amountCents: 4500000,
      currency: "NGN",
      status: "succeeded",
      metadata: { source: "client_callback" },
      createdAt: 1700000000,
    });

    await storage.upsertSubscription({
      teamId,
      paymentProvider: "paystack",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });

    const payload = createChargeSuccessPayload(reference, true);
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    // Webhook arrives second with different eventId prefix
    const res = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.reconciled, true);
    assert.match(res.body.message, /already reconciled via client callback/);
  });

  it("disables auto-renew if webhook authorization is not reusable", async () => {
    const storage = new InMemoryBillingStorage();
    const payload = createChargeSuccessPayload("pstk_non_reusable_01", false); // reusable = false
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    const res = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.autoRenewEnabled, false);

    const sub = await storage.getSubscriptionByTeamId(teamId);
    assert.ok(sub);
    assert.equal(sub.autoRenewEnabled, false);
    assert.equal(sub.paystackAuthCipher, null);
  });

  it("handles charge.failed and schedules retry within 7-day grace period", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId,
        paymentProvider: "paystack",
        planId: "pro",
        seats: 50,
        status: "active",
        autoRenewEnabled: true,
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        retryCount: 0,
        updatedAt: 1700000000,
      },
    ]);

    const failedPayload = {
      event: "charge.failed",
      data: {
        id: 99905,
        reference: "pstk_failed_charge_01",
        amount: 4500000,
        currency: "NGN",
        status: "failed",
        gateway_response: "Insufficient funds",
        metadata: { workspace_id: teamId },
      },
    };

    const rawBody = JSON.stringify(failedPayload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);
    const now = 1702592010;

    const res = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      currentTime: now,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.action, "charge_failure_recorded");

    const sub = await storage.getSubscriptionByTeamId(teamId);
    assert.ok(sub);
    assert.equal(sub.status, "past_due");
    assert.equal(sub.retryCount, 1);
    assert.equal(sub.nextRetryAt, now + 48 * 3600); // 48h retry
    assert.equal(sub.gracePeriodExpiresAt, now + 7 * 86400); // 7-day grace
  });

  it("cancels subscription when charge fails after retry limit exceeded", async () => {
    const now = 1702592010;
    const storage = new InMemoryBillingStorage([
      {
        teamId,
        paymentProvider: "paystack",
        planId: "pro",
        seats: 50,
        status: "past_due",
        autoRenewEnabled: true,
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        retryCount: 3, // Already retried 3 times
        gracePeriodExpiresAt: now + 86400,
        updatedAt: now - 86400,
      },
    ]);

    const failedPayload = {
      event: "charge.failed",
      data: {
        id: 99906,
        reference: "pstk_failed_charge_02",
        amount: 4500000,
        currency: "NGN",
        status: "failed",
        gateway_response: "Card expired",
        metadata: { workspace_id: teamId },
      },
    };

    const rawBody = JSON.stringify(failedPayload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    const res = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      currentTime: now,
    });

    assert.equal(res.status, 200);
    const sub = await storage.getSubscriptionByTeamId(teamId);
    assert.ok(sub);
    assert.equal(sub.status, "canceled");
    assert.equal(sub.autoRenewEnabled, false);
    assert.equal(sub.nextRetryAt, null);
  });

  it("handles subscription.disable and disables auto-renewal", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId,
        paymentProvider: "paystack",
        planId: "pro",
        seats: 50,
        status: "active",
        autoRenewEnabled: true,
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    const disablePayload = {
      event: "subscription.disable",
      data: {
        metadata: { workspace_id: teamId },
      },
    };

    const rawBody = JSON.stringify(disablePayload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    const res = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, { storage });
    assert.equal(res.status, 200);
    assert.equal(res.body.action, "renewal_disabled");

    const sub = await storage.getSubscriptionByTeamId(teamId);
    assert.ok(sub);
    assert.equal(sub.autoRenewEnabled, false);
    assert.equal(sub.status, "active"); // remains active for current period
  });

  it("does not mutate existing Stripe subscriptions when Paystack webhook arrives", async () => {
    const stripeTeamId = 77;
    const storage = new InMemoryBillingStorage([
      {
        teamId: stripeTeamId,
        paymentProvider: "stripe",
        stripeCustomerId: "cus_stripe_123",
        stripeSubscriptionId: "sub_stripe_123",
        planId: "starter",
        seats: 15,
        status: "active",
        autoRenewEnabled: false,
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    const failedPayload = {
      event: "charge.failed",
      data: {
        id: 99907,
        reference: "pstk_alien_ref",
        amount: 1500000,
        currency: "NGN",
        status: "failed",
        metadata: { workspace_id: stripeTeamId },
      },
    };

    const rawBody = JSON.stringify(failedPayload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    const res = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, { storage });
    assert.equal(res.status, 200);

    // Verify Stripe subscription was NOT altered into past_due or canceled
    const stripeSub = await storage.getSubscriptionByTeamId(stripeTeamId);
    assert.ok(stripeSub);
    assert.equal(stripeSub.paymentProvider, "stripe");
    assert.equal(stripeSub.status, "active");
    assert.equal(stripeSub.stripeSubscriptionId, "sub_stripe_123");
  });

  it("handles subscription.not_renew event and disables auto-renewal", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId,
        paymentProvider: "paystack",
        planId: "starter",
        seats: 15,
        status: "active",
        autoRenewEnabled: true,
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    const notRenewPayload = {
      event: "subscription.not_renew",
      data: {
        metadata: { workspace_id: teamId },
      },
    };

    const rawBody = JSON.stringify(notRenewPayload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    const res = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, { storage });
    assert.equal(res.status, 200);
    assert.equal(res.body.action, "renewal_disabled");

    const sub = await storage.getSubscriptionByTeamId(teamId);
    assert.ok(sub);
    assert.equal(sub.autoRenewEnabled, false);
  });

  it("leaves event unrecorded if business logic fails so subsequent Paystack retries can succeed", async () => {
    const faultyStorage = new InMemoryBillingStorage();
    // Simulate a transient database exception during subscription upsert
    faultyStorage.upsertSubscription = async () => {
      throw new Error("Transient connection error during upsert");
    };

    const payload = createChargeSuccessPayload("pstk_retryable_event_01", true);
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);
    const eventId = "pstk_charge.success_pstk_retryable_event_01";

    // First attempt fails due to database exception
    await assert.rejects(
      async () =>
        handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
          storage: faultyStorage,
          encryptionKey: VALID_KEY_HEX,
        }),
      /Transient connection error during upsert/
    );

    // Verify event is NOT marked as processed in storage
    const isRecorded = await faultyStorage.isEventProcessed(eventId);
    assert.equal(isRecorded, false, "Failed event must not be marked as processed");

    // Repair storage (simulating transient glitch recovery)
    faultyStorage.upsertSubscription = InMemoryBillingStorage.prototype.upsertSubscription.bind(faultyStorage);

    // Paystack retry arrives and must succeed without being treated as an ignored duplicate
    const retryRes = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage: faultyStorage,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.action, "subscription_activated");

    // Now event is safely recorded as processed
    assert.equal(await faultyStorage.isEventProcessed(eventId), true);
  });

  it("leaves event un-processed if ledger insertion fails and ensures subsequent retry succeeds", async () => {
    const faultyStorage = new InMemoryBillingStorage();
    // Simulate a transient failure during ledger recording
    faultyStorage.recordLedgerEntry = async () => {
      throw new Error("Simulated transient ledger write failure");
    };

    const payload = createChargeSuccessPayload("pstk_ledger_fail_01", true);
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);
    const eventId = "pstk_charge.success_pstk_ledger_fail_01";

    // Attempt fails during ledger insertion
    await assert.rejects(
      async () =>
        handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
          storage: faultyStorage,
          encryptionKey: VALID_KEY_HEX,
        }),
      /Simulated transient ledger write failure/
    );

    // Event must NOT be marked processed
    assert.equal(await faultyStorage.isEventProcessed(eventId), false);

    // Repair ledger recording
    faultyStorage.recordLedgerEntry = InMemoryBillingStorage.prototype.recordLedgerEntry.bind(faultyStorage);

    // Retry arrives and completes successfully
    const retryRes = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage: faultyStorage,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.action, "subscription_activated");
    assert.equal(await faultyStorage.isEventProcessed(eventId), true);

    const sub = await faultyStorage.getSubscriptionByTeamId(teamId);
    assert.ok(sub);
    assert.equal(sub.planId, "pro");
    assert.equal(sub.status, "active");

    const ledger = await faultyStorage.getLedgerByTeamId(teamId);
    assert.equal(ledger.length, 1);
  });

  it("handles subscription update failure after ledger insertion without duplicate ledger on retry", async () => {
    const faultyStorage = new InMemoryBillingStorage();
    let hasFailedOnce = false;
    const origUpsert = faultyStorage.upsertSubscription.bind(faultyStorage);

    faultyStorage.upsertSubscription = async (sub) => {
      if (!hasFailedOnce) {
        hasFailedOnce = true;
        throw new Error("Simulated transient PostgreSQL lock contention during subscription update");
      }
      return origUpsert(sub);
    };

    const payload = createChargeSuccessPayload("pstk_sub_fail_01", true);
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);
    const eventId = "pstk_charge.success_pstk_sub_fail_01";

    // First attempt fails at subscription upsert
    await assert.rejects(
      async () =>
        handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
          storage: faultyStorage,
          encryptionKey: VALID_KEY_HEX,
        }),
      /Simulated transient PostgreSQL lock contention/
    );

    // Event was NOT marked processed
    assert.equal(await faultyStorage.isEventProcessed(eventId), false);

    // Ledger already received the entry from attempt 1
    const ledgerAfterFail = await faultyStorage.getLedgerByTeamId(teamId);
    assert.equal(ledgerAfterFail.length, 1);

    // Retry arrives
    const retryRes = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage: faultyStorage,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.action, "subscription_activated");

    // Event is now processed
    assert.equal(await faultyStorage.isEventProcessed(eventId), true);

    // Critical Invariant: Ledger still has exactly 1 entry (zero duplicate charge records)
    const ledgerAfterRetry = await faultyStorage.getLedgerByTeamId(teamId);
    assert.equal(ledgerAfterRetry.length, 1);

    // Subscription is active
    const sub = await faultyStorage.getSubscriptionByTeamId(teamId);
    assert.ok(sub);
    assert.equal(sub.status, "active");
  });

  it("guarantees duplicate webhook delivery after successful activation causes zero mutations", async () => {
    const storage = new InMemoryBillingStorage();
    const payload = createChargeSuccessPayload("pstk_dedup_delivery_01", true);
    const rawBody = JSON.stringify(payload);
    const sig = computeSignature(rawBody, TEST_SECRET_KEY);

    // First delivery activates subscription
    const res1 = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      encryptionKey: VALID_KEY_HEX,
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.action, "subscription_activated");

    const ledger1 = await storage.getLedgerByTeamId(teamId);
    assert.equal(ledger1.length, 1);

    // Second delivery (duplicate)
    const res2 = await handlePaystackWebhook(rawBody, sig, TEST_SECRET_KEY, {
      storage,
      encryptionKey: VALID_KEY_HEX,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.duplicate, true);
    assert.equal(res2.body.received, true);

    // Ledger and subscriptions remain strictly unchanged
    const ledger2 = await storage.getLedgerByTeamId(teamId);
    assert.equal(ledger2.length, 1);
  });
});
