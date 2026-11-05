import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runPaystackRenewalCycle } from "../lib/paystack-renewal-engine.ts";
import { MockPaystackClient, PAYSTACK_PLANS } from "../lib/paystack.ts";
import { InMemoryBillingStorage } from "../lib/billing-storage.ts";
import { encryptAuthorizationCode } from "../lib/paystack-security.ts";
import {
  handleRenewalRequest,
  isValidBearerToken,
  GET,
  POST,
} from "../app/api/billing/paystack/renew/route.ts";

const VALID_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Paystack Renewal Engine — Phase 5 Lease Coordination & Concurrency", () => {
  it("acquires lease and prevents concurrent worker from processing the same subscription", async () => {
    const auth = encryptAuthorizationCode("AUTH_valid_token_1", VALID_KEY_HEX);
    const storage = new InMemoryBillingStorage([
      {
        teamId: 10,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_10",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000, // Due
        updatedAt: 1700000000,
      },
    ]);

    const mockClient = new MockPaystackClient();
    const now = 1702592005;

    // Worker 1 starts and acquires lease
    const token1 = "token-worker-1";
    const acquired = await storage.acquireRenewalLease(10, token1, 300, now);
    assert.equal(acquired, true);

    // Direct attempt to acquire another lease while Worker 1 holds active lease must fail
    const token2 = "token-worker-2";
    const acquired2 = await storage.acquireRenewalLease(10, token2, 300, now);
    assert.equal(acquired2, false);

    // Worker 2 attempts renewal cycle while Worker 1 holds active lease
    // The query/findDueRenewals filters out active leases so Worker 2 processes 0 due items
    const resultWorker2 = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: now + 10, // within 300s lease window
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(resultWorker2.processed, 0);
    assert.equal(resultWorker2.succeeded, 0);

    // Verify mock client was never called by Worker 2
    assert.equal(mockClient.chargeCalls.length, 0);

    // Worker 1 finishes and releases lease
    const released = await storage.releaseRenewalLease(10, token1);
    assert.equal(released, true);
  });

  it("recovers expired lease after timeout and allows next worker to acquire it", async () => {
    const auth = encryptAuthorizationCode("AUTH_valid_token_2", VALID_KEY_HEX);
    const now = 1702592000;
    const storage = new InMemoryBillingStorage([
      {
        teamId: 20,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_20",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        renewalLeaseToken: "abandoned-worker-lease",
        renewalLeaseExpiresAt: now - 10, // Expired 10 seconds ago
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: now,
        updatedAt: 1700000000,
      },
    ]);

    const mockClient = new MockPaystackClient();

    // Next worker should reclaim expired lease and successfully process renewal
    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: now,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(result.processed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(mockClient.chargeCalls.length, 1);
  });
});

describe("Paystack Renewal Engine — Phase 5 Merchant-Managed Charging & Reconciliation", () => {
  it("renews subscription, advances calendar month with anchor day, and records ledger entry", async () => {
    const auth = encryptAuthorizationCode("AUTH_recurring_card_code", VALID_KEY_HEX);
    const startEpoch = 1700006400; // 2023-11-15T00:00:00Z
    const endEpoch = 1702598400;   // 2023-12-15T00:00:00Z (Anchor day 15)

    const storage = new InMemoryBillingStorage([
      {
        teamId: 30,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_30",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: startEpoch,
        currentPeriodEnd: endEpoch,
        updatedAt: startEpoch,
      },
    ]);

    const mockClient = new MockPaystackClient();
    const now = endEpoch + 60; // 1 minute after due

    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: now,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);

    // Verify charge payload sent to Paystack
    assert.equal(mockClient.chargeCalls.length, 1);
    const charge = mockClient.chargeCalls[0];
    assert.equal(charge.authorizationCode, "AUTH_recurring_card_code");
    assert.equal(charge.amountKobo, 4500000); // ₦45,000 in integer kobo
    assert.equal(charge.currency, "NGN");
    assert.equal(charge.reference, `pstk_renew_30_${endEpoch}_0`);
    assert.equal(charge.metadata.workspace_id, 30);
    assert.equal(charge.metadata.plan_id, "pro");

    // Verify updated subscription record
    const updatedSub = await storage.getSubscriptionByTeamId(30);
    assert.ok(updatedSub);
    assert.equal(updatedSub.status, "active");
    assert.equal(updatedSub.currentPeriodStart, endEpoch);
    // Period end should advance to 2024-01-15T00:00:00Z preserving anchor day 15
    const expectedEnd = Math.floor(Date.UTC(2024, 0, 15, 0, 0, 0) / 1000);
    assert.equal(updatedSub.currentPeriodEnd, expectedEnd);
    assert.equal(updatedSub.retryCount, 0);
    assert.equal(updatedSub.nextRetryAt, null);
    assert.equal(updatedSub.gracePeriodExpiresAt, null);

    // Verify durable ledger record
    const entries = await storage.getLedgerByTeamId(30);
    const ledger = entries[0];
    assert.ok(ledger);
    assert.equal(ledger.transactionId, `pstk_renew_30_${endEpoch}_0`);
    assert.equal(ledger.amountCents, 4500000);
    assert.equal(ledger.currency, "NGN");
    assert.equal(ledger.status, "succeeded");
  });

  it("reconciles with previously successful gateway transaction and prevents duplicate charge", async () => {
    const auth = encryptAuthorizationCode("AUTH_reconciled_code", VALID_KEY_HEX);
    const endEpoch = 1702598400;
    const deterministicRef = `pstk_renew_35_${endEpoch}_0`;

    const storage = new InMemoryBillingStorage([
      {
        teamId: 35,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_35",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700006400,
        currentPeriodEnd: endEpoch,
        updatedAt: 1700006400,
      },
    ]);

    const mockClient = new MockPaystackClient();
    // Seed gateway with pre-existing successful transaction for this exact reference
    mockClient.seedTransaction({
      id: 88801,
      status: "success",
      reference: deterministicRef,
      amount: 1500000,
      currency: "NGN",
      created_at: new Date().toISOString(),
      customer: { customer_code: "CUS_35", email: "workspace_35@rota.internal" },
    });

    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: endEpoch + 60,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(result.reconciled, 1);
    assert.equal(result.succeeded, 0);
    // Prior-check prevented charging authorization again
    assert.equal(mockClient.chargeCalls.length, 0);

    const sub = await storage.getSubscriptionByTeamId(35);
    assert.equal(sub.status, "active");
    assert.equal(sub.currentPeriodStart, endEpoch);
  });

  it("marks status as reconciliation_required when gateway call times out or encounters error", async () => {
    const auth = encryptAuthorizationCode("AUTH_timeout_code", VALID_KEY_HEX);
    const endEpoch = 1702598400;

    const storage = new InMemoryBillingStorage([
      {
        teamId: 40,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_40",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700006400,
        currentPeriodEnd: endEpoch,
        updatedAt: 1700006400,
      },
    ]);

    const mockClient = new MockPaystackClient();
    // Simulate gateway network socket timeout during charge call
    mockClient.chargeAuthorization = async () => {
      throw new Error("ETIMEDOUT: Paystack API gateway connection timed out.");
    };

    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: endEpoch + 60,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(result.uncertain, 1);
    assert.equal(result.succeeded, 0);
    assert.match(result.details[0].message, /Reconcile before retrying/);

    const sub = await storage.getSubscriptionByTeamId(40);
    assert.equal(sub.status, "reconciliation_required");
    assert.equal(sub.lastReconciliationRef, `pstk_renew_40_${endEpoch}_0`);
  });

  it("picks up and reconciles a subscription in status = 'reconciliation_required'", async () => {
    const auth = encryptAuthorizationCode("AUTH_reconcile_required_code", VALID_KEY_HEX);
    const endEpoch = 1702598400;
    const deterministicRef = `pstk_renew_45_${endEpoch}_0`;

    const storage = new InMemoryBillingStorage([
      {
        teamId: 45,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_45",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        planId: "starter",
        seats: 15,
        status: "reconciliation_required", // Subscription was left in uncertain state
        lastReconciliationRef: deterministicRef,
        currentPeriodStart: 1700006400,
        currentPeriodEnd: endEpoch,
        updatedAt: 1700006400,
      },
    ]);

    const mockClient = new MockPaystackClient();
    // Gateway confirms that the transaction actually succeeded
    mockClient.seedTransaction({
      id: 99912,
      status: "success",
      reference: deterministicRef,
      amount: 1500000,
      currency: "NGN",
      created_at: new Date().toISOString(),
      customer: { customer_code: "CUS_45", email: "workspace_45@rota.internal" },
    });

    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: endEpoch + 3600,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(result.processed, 1);
    assert.equal(result.reconciled, 1);
    assert.equal(result.succeeded, 0);

    const sub = await storage.getSubscriptionByTeamId(45);
    assert.equal(sub.status, "active", "Subscription must be restored to active after successful reconciliation");
    assert.equal(sub.currentPeriodStart, endEpoch);
  });

  it("prevents an expired worker from committing stale updates when lease token is overtaken", async () => {
    const auth = encryptAuthorizationCode("AUTH_fencing_token", VALID_KEY_HEX);
    const endEpoch = 1702598400;

    const storage = new InMemoryBillingStorage([
      {
        teamId: 48,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_48",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700006400,
        currentPeriodEnd: endEpoch,
        updatedAt: 1700006400,
      },
    ]);

    const mockClient = new MockPaystackClient();
    // Intercept chargeAuthorization to simulate another worker overtaking the lease while this worker was waiting
    const originalCharge = mockClient.chargeAuthorization.bind(mockClient);
    mockClient.chargeAuthorization = async (params) => {
      // Overwrite the lease token in storage with a successor worker's token
      const current = await storage.getSubscriptionByTeamId(48);
      await storage.upsertSubscription({
        ...current,
        renewalLeaseToken: "successor-worker-token",
        renewalLeaseExpiresAt: endEpoch + 600,
      });
      return originalCharge(params);
    };

    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: endEpoch + 60,
      encryptionKey: VALID_KEY_HEX,
    });

    // The stale worker's update was fenced out
    assert.equal(result.skipped, 1);
    assert.equal(result.succeeded, 0);
    assert.match(result.details[0].message, /Stale commit prevented/);
  });
});

describe("Paystack Renewal Engine — Phase 5 Grace Period & Retry Interpretation", () => {
  it("schedules first retry at ~day 2 and sets past_due with 7-day grace on initial charge decline", async () => {
    const auth = encryptAuthorizationCode("AUTH_declined_card", VALID_KEY_HEX);
    const endEpoch = 1702598400;
    const now = endEpoch + 10;

    const storage = new InMemoryBillingStorage([
      {
        teamId: 50,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_50",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700006400,
        currentPeriodEnd: endEpoch,
        retryCount: 0,
        updatedAt: 1700006400,
      },
    ]);

    const mockClient = new MockPaystackClient();
    // Decline payment
    mockClient.chargeAuthorization = async (params) => {
      return {
        status: false,
        message: "Charge failed",
        data: {
          status: "failed",
          reference: params.reference,
          amount: params.amountKobo,
          currency: "NGN",
          gateway_response: "Insufficient Funds",
        },
      };
    };

    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: now,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(result.failed, 1);

    const sub = await storage.getSubscriptionByTeamId(50);
    assert.equal(sub.status, "past_due");
    assert.equal(sub.retryCount, 1);
    assert.equal(sub.nextRetryAt, now + 48 * 3600); // 48h (approx day 2)
    assert.equal(sub.gracePeriodExpiresAt, now + 7 * 86400); // 7-day grace
  });

  it("cancels subscription when grace period expires on day 7 after failed retries", async () => {
    const auth = encryptAuthorizationCode("AUTH_exhausted_retries", VALID_KEY_HEX);
    const endEpoch = 1702598400;
    const now = endEpoch + 7 * 86400 + 10; // Day 7 + 10s (grace period expired)

    const storage = new InMemoryBillingStorage([
      {
        teamId: 60,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_60",
        paystackAuthCipher: auth.cipherText,
        paystackAuthIv: auth.iv,
        paystackAuthTag: auth.tag,
        autoRenewEnabled: true,
        billingAnchorDay: 15,
        planId: "starter",
        seats: 15,
        status: "past_due",
        currentPeriodStart: 1700006400,
        currentPeriodEnd: endEpoch,
        retryCount: 3, // Already tried initial + 2 retries
        nextRetryAt: now - 3600, // Due for final retry
        gracePeriodExpiresAt: endEpoch + 7 * 86400, // Grace expired
        updatedAt: now - 86400,
      },
    ]);

    const mockClient = new MockPaystackClient();
    mockClient.chargeAuthorization = async (params) => {
      return {
        status: false,
        message: "Charge failed",
        data: {
          status: "failed",
          reference: params.reference,
          amount: params.amountKobo,
          currency: "NGN",
          gateway_response: "Card Expired",
        },
      };
    };

    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: now,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(result.failed, 1);

    const sub = await storage.getSubscriptionByTeamId(60);
    assert.equal(sub.status, "canceled");
    assert.equal(sub.autoRenewEnabled, false);
    assert.equal(sub.nextRetryAt, null);
  });

  it("strictly enforces provider exclusivity and skips Stripe subscriptions", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 70,
        paymentProvider: "stripe",
        stripeCustomerId: "cus_stripe_isolated",
        stripeSubscriptionId: "sub_stripe_isolated",
        autoRenewEnabled: false,
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700006400,
        currentPeriodEnd: 1702598400, // Due
        updatedAt: 1700006400,
      },
    ]);

    const mockClient = new MockPaystackClient();

    const result = await runPaystackRenewalCycle({
      storage,
      client: mockClient,
      currentTime: 1702598500,
      encryptionKey: VALID_KEY_HEX,
    });

    assert.equal(result.processed, 0); // findDueRenewals filters out paymentProvider !== 'paystack'
    assert.equal(mockClient.chargeCalls.length, 0);
  });
});

describe("Paystack Renewal Route — Vercel Cron GET & POST Scheduler Compatibility", () => {
  describe("isValidBearerToken Security Helper", () => {
    it("accepts valid Bearer token matching expected secret exactly", () => {
      assert.equal(isValidBearerToken("Bearer cron_secret_123", "cron_secret_123"), true);
      assert.equal(isValidBearerToken("bearer cron_secret_123", "cron_secret_123"), true);
      assert.equal(isValidBearerToken("Bearer   cron_secret_123  ", "cron_secret_123"), true);
    });

    it("rejects mismatched, malformed, or empty tokens in constant time", () => {
      assert.equal(isValidBearerToken("Bearer wrong_secret", "cron_secret_123"), false);
      assert.equal(isValidBearerToken("Bearer cron_secret_12", "cron_secret_123"), false);
      assert.equal(isValidBearerToken("Basic user:pass", "cron_secret_123"), false);
      assert.equal(isValidBearerToken("cron_secret_123", "cron_secret_123"), false);
      assert.equal(isValidBearerToken("Bearer ", "cron_secret_123"), false);
      assert.equal(isValidBearerToken("", "cron_secret_123"), false);
      assert.equal(isValidBearerToken(null, "cron_secret_123"), false);
      assert.equal(isValidBearerToken(undefined, "cron_secret_123"), false);
      assert.equal(isValidBearerToken("Bearer some_token", ""), false);
      assert.equal(isValidBearerToken("Bearer some_token", undefined), false);
    });
  });

  describe("Vercel Cron GET Request Support & Authentication", () => {
    it("authenticates GET request via Authorization: Bearer <CRON_SECRET> and executes renewals", async () => {
      const auth = encryptAuthorizationCode("AUTH_cron_due_1", VALID_KEY_HEX);
      const storage = new InMemoryBillingStorage([
        {
          teamId: 101,
          paymentProvider: "paystack",
          paystackCustomerCode: "CUS_101",
          paystackAuthCipher: auth.cipherText,
          paystackAuthIv: auth.iv,
          paystackAuthTag: auth.tag,
          autoRenewEnabled: true,
          billingAnchorDay: 15,
          planId: "starter",
          seats: 15,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000, // Due
          updatedAt: 1700000000,
        },
      ]);
      const mockClient = new MockPaystackClient();

      const req = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "GET",
        headers: {
          authorization: "Bearer test_cron_secret_abc123",
        },
      });

      const res = await handleRenewalRequest(req, {
        cronSecret: "test_cron_secret_abc123",
        storage,
        client: mockClient,
        currentTime: 1702592005,
        encryptionKey: VALID_KEY_HEX,
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.provider, "paystack");
      assert.equal(data.result.processed, 1);
      assert.equal(data.result.succeeded, 1);
      assert.equal(mockClient.chargeCalls.length, 1);

      // Verify period was advanced
      const updated = await storage.getSubscriptionByTeamId(101);
      assert.equal(updated.status, "active");
      assert.equal(updated.currentPeriodStart, 1702592000);
    });

    it("rejects GET request without Authorization header with HTTP 401 and zero renewals executed", async () => {
      const storage = new InMemoryBillingStorage([
        {
          teamId: 102,
          paymentProvider: "paystack",
          paystackCustomerCode: "CUS_102",
          autoRenewEnabled: true,
          planId: "starter",
          seats: 15,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
          updatedAt: 1700000000,
        },
      ]);
      const mockClient = new MockPaystackClient();

      const req = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "GET",
      });

      const res = await handleRenewalRequest(req, {
        cronSecret: "test_cron_secret_abc123",
        storage,
        client: mockClient,
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, "Unauthorized");
      assert.equal(mockClient.chargeCalls.length, 0);
    });

    it("rejects GET request with invalid Bearer token with HTTP 401 and zero renewals executed", async () => {
      const mockClient = new MockPaystackClient();
      const storage = new InMemoryBillingStorage();

      const req = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "GET",
        headers: {
          authorization: "Bearer wrong_token_attempt",
        },
      });

      const res = await handleRenewalRequest(req, {
        cronSecret: "test_cron_secret_abc123",
        storage,
        client: mockClient,
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, "Unauthorized");
      assert.equal(mockClient.chargeCalls.length, 0);
    });

    it("rejects GET request when CRON_SECRET is unconfigured with HTTP 401", async () => {
      const mockClient = new MockPaystackClient();
      const storage = new InMemoryBillingStorage();

      const req = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "GET",
        headers: {
          authorization: "Bearer some_token",
        },
      });

      const res = await handleRenewalRequest(req, {
        cronSecret: "",
        storage,
        client: mockClient,
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, "Unauthorized");
      assert.equal(mockClient.chargeCalls.length, 0);
    });
  });

  describe("POST Compatibility & Authorization", () => {
    it("preserves POST execution when authorized with Authorization: Bearer <CRON_SECRET>", async () => {
      const auth = encryptAuthorizationCode("AUTH_post_due_1", VALID_KEY_HEX);
      const storage = new InMemoryBillingStorage([
        {
          teamId: 103,
          paymentProvider: "paystack",
          paystackCustomerCode: "CUS_103",
          paystackAuthCipher: auth.cipherText,
          paystackAuthIv: auth.iv,
          paystackAuthTag: auth.tag,
          autoRenewEnabled: true,
          billingAnchorDay: 15,
          planId: "starter",
          seats: 15,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
          updatedAt: 1700000000,
        },
      ]);
      const mockClient = new MockPaystackClient();

      const req = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "POST",
        headers: {
          authorization: "Bearer test_cron_secret_abc123",
        },
      });

      const res = await handleRenewalRequest(req, {
        cronSecret: "test_cron_secret_abc123",
        storage,
        client: mockClient,
        currentTime: 1702592005,
        encryptionKey: VALID_KEY_HEX,
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.provider, "paystack");
      assert.equal(data.result.processed, 1);
      assert.equal(data.result.succeeded, 1);
      assert.equal(mockClient.chargeCalls.length, 1);
    });

    it("preserves POST execution when authenticated with manager/owner session", async () => {
      const auth = encryptAuthorizationCode("AUTH_post_mgr_1", VALID_KEY_HEX);
      const storage = new InMemoryBillingStorage([
        {
          teamId: 104,
          paymentProvider: "paystack",
          paystackCustomerCode: "CUS_104",
          paystackAuthCipher: auth.cipherText,
          paystackAuthIv: auth.iv,
          paystackAuthTag: auth.tag,
          autoRenewEnabled: true,
          billingAnchorDay: 15,
          planId: "starter",
          seats: 15,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
          updatedAt: 1700000000,
        },
      ]);
      const mockClient = new MockPaystackClient();

      const req = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "POST",
      });

      const res = await handleRenewalRequest(req, {
        cronSecret: "test_cron_secret_abc123",
        sessionUser: {
          id: 1,
          role: "admin",
          teamRole: "Owner",
          teamId: 104,
        },
        storage,
        client: mockClient,
        currentTime: 1702592005,
        encryptionKey: VALID_KEY_HEX,
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.result.succeeded, 1);
      assert.equal(mockClient.chargeCalls.length, 1);
    });

    it("rejects POST request with invalid Bearer and no manager session with HTTP 401", async () => {
      const mockClient = new MockPaystackClient();
      const storage = new InMemoryBillingStorage();

      const req = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong_bearer",
        },
      });

      const res = await handleRenewalRequest(req, {
        cronSecret: "test_cron_secret_abc123",
        sessionUser: {
          id: 2,
          role: "staff",
          teamRole: "Member",
          teamId: 105,
        },
        storage,
        client: mockClient,
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, "Unauthorized");
      assert.equal(mockClient.chargeCalls.length, 0);
    });
  });

  describe("Security, Payload Sanitization & Execution Invariants", () => {
    it("never exposes secrets, authorization tokens, or encryption keys in responses", async () => {
      const auth = encryptAuthorizationCode("AUTH_super_secret_token", VALID_KEY_HEX);
      const storage = new InMemoryBillingStorage([
        {
          teamId: 106,
          paymentProvider: "paystack",
          paystackCustomerCode: "CUS_106",
          paystackAuthCipher: auth.cipherText,
          paystackAuthIv: auth.iv,
          paystackAuthTag: auth.tag,
          autoRenewEnabled: true,
          billingAnchorDay: 15,
          planId: "starter",
          seats: 15,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
          updatedAt: 1700000000,
        },
      ]);
      const mockClient = new MockPaystackClient();

      const req = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "GET",
        headers: {
          authorization: "Bearer my_super_secret_cron_token_12345",
        },
      });

      const res = await handleRenewalRequest(req, {
        cronSecret: "my_super_secret_cron_token_12345",
        storage,
        client: mockClient,
        currentTime: 1702592005,
        encryptionKey: VALID_KEY_HEX,
      });

      const rawText = await res.text();
      assert.equal(rawText.includes("my_super_secret_cron_token_12345"), false);
      assert.equal(rawText.includes(VALID_KEY_HEX), false);
      assert.equal(rawText.includes("AUTH_super_secret_token"), false);
      assert.equal(rawText.includes(auth.cipherText), false);
    });

    it("default route handlers GET and POST reject unauthenticated requests by default", async () => {
      const reqGet = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "GET",
      });
      const resGet = await GET(reqGet);
      assert.equal(resGet.status, 401);

      const reqPost = new Request("https://rota-lovat-gamma.vercel.app/api/billing/paystack/renew", {
        method: "POST",
      });
      const resPost = await POST(reqPost);
      assert.equal(resPost.status, 401);
    });
  });
});
