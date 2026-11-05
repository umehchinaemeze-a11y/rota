import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handlePaystackInitialize } from "../app/api/billing/paystack/initialize/route.ts";
import { handlePaystackVerify } from "../app/api/billing/paystack/verify/route.ts";
import { handleGetBillingStatus } from "../app/api/billing/route.ts";
import { MockPaystackClient, PAYSTACK_PLANS } from "../lib/paystack.ts";
import { InMemoryBillingStorage, DatabaseBillingStorage, normalizeQueryClient } from "../lib/billing-storage.ts";
import { decryptAuthorizationCode } from "../lib/paystack-security.ts";

const VALID_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Paystack Checkout — Phase 3 Initialization", () => {
  const managerUser = {
    userId: 1,
    email: "manager@clinic.ng",
    role: "admin",
    teamId: 10,
    teamRole: "Owner",
  };

  it("rejects unauthenticated requests with HTTP 401", async () => {
    const res = await handlePaystackInitialize({ targetPlan: "starter" }, null);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("rejects users without an active workspace with HTTP 403", async () => {
    const res = await handlePaystackInitialize(
      { targetPlan: "starter" },
      { ...managerUser, teamId: null }
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "Forbidden");
  });

  it("rejects unprivileged staff users without management authority with HTTP 403", async () => {
    const staffUser = {
      userId: 2,
      email: "staff@clinic.ng",
      role: "user",
      teamId: 10,
      teamRole: "Member",
    };
    const res = await handlePaystackInitialize({ targetPlan: "starter" }, staffUser);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "Forbidden");
  });

  it("enforces tenant isolation and rejects workspaceId mismatch with HTTP 403", async () => {
    const res = await handlePaystackInitialize(
      { targetPlan: "starter", workspaceId: 999 },
      managerUser
    );
    assert.equal(res.status, 403);
    assert.match(res.body.message, /Tenant mismatch/);
  });

  it("rejects invalid target plan with HTTP 400", async () => {
    const res = await handlePaystackInitialize(
      { targetPlan: "mega_vip_plan" },
      managerUser
    );
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Invalid target plan/);
  });

  it("rejects checkout for default free tier with HTTP 400", async () => {
    const res = await handlePaystackInitialize(
      { targetPlan: "free" },
      managerUser
    );
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Cannot checkout free tier/);
  });

  it("validates server-side NGN integer kobo pricing and returns authorization URL", async () => {
    const mockClient = new MockPaystackClient();
    const storage = new InMemoryBillingStorage();

    const res = await handlePaystackInitialize(
      { targetPlan: "starter" },
      managerUser,
      { client: mockClient, storage }
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.plan, "starter");
    assert.equal(res.body.seats, 15);
    assert.equal(res.body.amountKobo, 1500000); // ₦15,000 in integer kobo
    assert.equal(res.body.currency, "NGN");
    assert.ok(res.body.authorizationUrl);
    assert.ok(res.body.reference.startsWith("pstk_init_10_starter_"));

    // Verify mock client received exact metadata and integer kobo
    assert.equal(mockClient.initializeCalls.length, 1);
    const call = mockClient.initializeCalls[0];
    assert.equal(call.amountKobo, 1500000);
    assert.equal(call.currency, "NGN");
    assert.equal(call.metadata.workspace_id, 10);
    assert.equal(call.metadata.consent_recurring, true);
  });

  it("rejects redundant checkout when already actively subscribed to target plan", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 10,
        paymentProvider: "paystack",
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    const res = await handlePaystackInitialize(
      { targetPlan: "pro" },
      managerUser,
      { storage }
    );

    assert.equal(res.status, 400);
    assert.match(res.body.message, /already subscribed/);
  });
});

describe("Paystack Checkout — Phase 3 Payment Confirmation & Verification", () => {
  const managerUser = {
    userId: 1,
    email: "manager@clinic.ng",
    role: "admin",
    teamId: 10,
    teamRole: "Owner",
  };

  it("rejects missing reference with HTTP 400", async () => {
    const res = await handlePaystackVerify({}, managerUser);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Missing or invalid payment reference/);
  });

  it("returns HTTP 404 when transaction is not found on Paystack", async () => {
    const mockClient = new MockPaystackClient();
    const storage = new InMemoryBillingStorage();

    const res = await handlePaystackVerify(
      { reference: "pstk_nonexistent_ref" },
      managerUser,
      { client: mockClient, storage }
    );

    assert.equal(res.status, 404);
    assert.match(res.body.message, /not found on Paystack gateway/);
  });

  it("rejects non-successful transaction status with HTTP 422", async () => {
    const mockClient = new MockPaystackClient();
    mockClient.seedTransaction({
      id: 111,
      status: "failed",
      reference: "pstk_failed_ref",
      amount: 1500000,
      currency: "NGN",
      created_at: new Date().toISOString(),
      metadata: { workspace_id: 10, plan_id: "starter" },
      customer: { customer_code: "CUS_test_failed", email: managerUser.email },
      authorization: {
        authorization_code: "AUTH_xxx",
        card_type: "visa",
        last4: "1234",
        exp_month: "12",
        exp_year: "2030",
        bin: "408100",
        bank: "Zenith Bank",
        channel: "card",
        signature: "SIG_xxx",
        reusable: true,
        country_code: "NG",
      },
    });

    const res = await handlePaystackVerify(
      { reference: "pstk_failed_ref" },
      managerUser,
      { client: mockClient }
    );

    assert.equal(res.status, 422);
    assert.match(res.body.message, /transaction status is 'failed'/);
  });

  it("rejects currency mismatch with HTTP 422", async () => {
    const mockClient = new MockPaystackClient();
    mockClient.seedTransaction({
      id: 112,
      status: "success",
      reference: "pstk_usd_ref",
      amount: 1500000,
      currency: "USD", // Illegal currency
      created_at: new Date().toISOString(),
      metadata: { workspace_id: 10, plan_id: "starter" },
      customer: { customer_code: "CUS_test_usd", email: managerUser.email },
      authorization: {
        authorization_code: "AUTH_xxx",
        card_type: "visa",
        last4: "1234",
        exp_month: "12",
        exp_year: "2030",
        bin: "408100",
        bank: "Zenith Bank",
        channel: "card",
        signature: "SIG_xxx",
        reusable: true,
        country_code: "NG",
      },
    });

    const res = await handlePaystackVerify(
      { reference: "pstk_usd_ref" },
      managerUser,
      { client: mockClient }
    );

    assert.equal(res.status, 422);
    assert.match(res.body.message, /Unexpected currency/);
  });

  it("enforces tenant isolation and rejects transaction belonging to another workspace", async () => {
    const mockClient = new MockPaystackClient();
    mockClient.seedTransaction({
      id: 113,
      status: "success",
      reference: "pstk_wrong_workspace_ref",
      amount: 1500000,
      currency: "NGN",
      created_at: new Date().toISOString(),
      metadata: { workspace_id: 999, plan_id: "starter" }, // Workspace 999 != 10
      customer: { customer_code: "CUS_test_alien", email: "other@clinic.ng" },
      authorization: {
        authorization_code: "AUTH_xxx",
        card_type: "visa",
        last4: "1234",
        exp_month: "12",
        exp_year: "2030",
        bin: "408100",
        bank: "Zenith Bank",
        channel: "card",
        signature: "SIG_xxx",
        reusable: true,
        country_code: "NG",
      },
    });

    const res = await handlePaystackVerify(
      { reference: "pstk_wrong_workspace_ref" },
      managerUser,
      { client: mockClient }
    );

    assert.equal(res.status, 403);
    assert.match(res.body.message, /Transaction workspace does not match/);
  });

  it("rejects tampered amount that does not match expected plan price", async () => {
    const mockClient = new MockPaystackClient();
    mockClient.seedTransaction({
      id: 114,
      status: "success",
      reference: "pstk_tampered_amount_ref",
      amount: 100, // ₦1 instead of ₦15,000 (1,500,000 kobo)
      currency: "NGN",
      created_at: new Date().toISOString(),
      metadata: { workspace_id: 10, plan_id: "starter" },
      customer: { customer_code: "CUS_test_tampered", email: managerUser.email },
      authorization: {
        authorization_code: "AUTH_xxx",
        card_type: "visa",
        last4: "1234",
        exp_month: "12",
        exp_year: "2030",
        bin: "408100",
        bank: "Zenith Bank",
        channel: "card",
        signature: "SIG_xxx",
        reusable: true,
        country_code: "NG",
      },
    });

    const res = await handlePaystackVerify(
      { reference: "pstk_tampered_amount_ref" },
      managerUser,
      { client: mockClient }
    );

    assert.equal(res.status, 422);
    assert.match(res.body.message, /does not match expected plan price/);
  });

  it("authoritatively activates subscription and encrypts reusable authorization with AES-256-GCM", async () => {
    const mockClient = new MockPaystackClient();
    const storage = new InMemoryBillingStorage();
    const ref = "pstk_valid_pro_activation";

    mockClient.seedTransaction({
      id: 200,
      status: "success",
      reference: ref,
      amount: 4500000, // ₦45,000 Pro in integer kobo
      currency: "NGN",
      created_at: new Date().toISOString(),
      metadata: { workspace_id: 10, plan_id: "pro", seats: 50 },
      customer: { customer_code: "CUS_pro_cust_10", email: managerUser.email },
      authorization: {
        authorization_code: "AUTH_secret_reusable_pro_token",
        card_type: "visa",
        last4: "4081",
        exp_month: "12",
        exp_year: "2030",
        bin: "408100",
        bank: "Access Bank",
        channel: "card",
        signature: "SIG_card_signature",
        reusable: true,
        country_code: "NG",
      },
    });

    const res = await handlePaystackVerify(
      { reference: ref },
      managerUser,
      {
        client: mockClient,
        storage,
        currentTime: 1700000000,
        encryptionKey: VALID_KEY_HEX,
      }
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.subscription.planId, "pro");
    assert.equal(res.body.subscription.seats, 50);
    assert.equal(res.body.subscription.status, "active");
    assert.equal(res.body.subscription.paymentProvider, "paystack");
    assert.equal(res.body.subscription.autoRenewEnabled, true);

    // Verify cipher components are not exposed to client browser
    assert.equal(res.body.subscription.paystackAuthCipher, undefined);

    // Verify stored authorization in storage is encrypted and can be decrypted with key
    const storedSub = await storage.getSubscriptionByTeamId(10);
    assert.ok(storedSub);
    assert.notEqual(storedSub.paystackAuthCipher, "AUTH_secret_reusable_pro_token");

    const decrypted = decryptAuthorizationCode(
      {
        cipherText: storedSub.paystackAuthCipher,
        iv: storedSub.paystackAuthIv,
        tag: storedSub.paystackAuthTag,
      },
      VALID_KEY_HEX
    );
    assert.equal(decrypted, "AUTH_secret_reusable_pro_token");

    // Verify ledger entry
    const ledger = await storage.getLedgerByTeamId(10);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].transactionId, ref);
    assert.equal(ledger[0].amountCents, 4500000);
    assert.equal(ledger[0].status, "succeeded");
  });

  it("handles duplicate verification idempotently without double-crediting ledger", async () => {
    const mockClient = new MockPaystackClient();
    const storage = new InMemoryBillingStorage();
    const ref = "pstk_idempotent_test_ref";

    mockClient.seedTransaction({
      id: 201,
      status: "success",
      reference: ref,
      amount: 1500000,
      currency: "NGN",
      created_at: new Date().toISOString(),
      metadata: { workspace_id: 10, plan_id: "starter" },
      customer: { customer_code: "CUS_idempotent", email: managerUser.email },
      authorization: {
        authorization_code: "AUTH_idempotent_token",
        card_type: "visa",
        last4: "1234",
        exp_month: "12",
        exp_year: "2030",
        bin: "408100",
        bank: "Zenith Bank",
        channel: "card",
        signature: "SIG_xxx",
        reusable: true,
        country_code: "NG",
      },
    });

    const verifyOpts = {
      client: mockClient,
      storage,
      currentTime: 1700000000,
      encryptionKey: VALID_KEY_HEX,
    };

    // First call
    const res1 = await handlePaystackVerify({ reference: ref }, managerUser, verifyOpts);
    assert.equal(res1.status, 200);
    assert.equal(res1.body.success, true);
    assert.equal(res1.body.idempotent, undefined);

    // Second duplicate call
    const res2 = await handlePaystackVerify({ reference: ref }, managerUser, verifyOpts);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.success, true);
    assert.equal(res2.body.idempotent, true);

    // Financial ledger has exactly 1 entry
    const ledger = await storage.getLedgerByTeamId(10);
    assert.equal(ledger.length, 1);
  });

  it("sanitizes subscription object and strictly excludes cipher components from client responses", async () => {
    const mockClient = new MockPaystackClient();
    const storage = new InMemoryBillingStorage();
    const ref = "pstk_sanitize_test_ref";

    mockClient.seedTransaction({
      id: 777,
      status: "success",
      reference: ref,
      amount: 1500000,
      currency: "NGN",
      created_at: new Date().toISOString(),
      metadata: { workspace_id: 10, plan_id: "starter" },
      customer: { customer_code: "CUS_sanitize", email: managerUser.email },
      authorization: {
        authorization_code: "AUTH_secret_code_xyz",
        card_type: "visa",
        last4: "9999",
        exp_month: "12",
        exp_year: "2030",
        bin: "408100",
        bank: "Zenith Bank",
        channel: "card",
        signature: "SIG_xxx",
        reusable: true,
        country_code: "NG",
      },
    });

    const res = await handlePaystackVerify(
      { reference: ref },
      managerUser,
      { client: mockClient, storage, encryptionKey: VALID_KEY_HEX }
    );

    assert.equal(res.status, 200);
    const clientSub = res.body.subscription;
    assert.ok(clientSub);
    assert.equal(clientSub.cardLast4, "9999");
    assert.equal(clientSub.cardBrand, "visa");

    // Strictly verify cipher components and tokens are NEVER present in client response
    assert.equal(clientSub.paystackAuthCipher, undefined);
    assert.equal(clientSub.paystackAuthIv, undefined);
    assert.equal(clientSub.paystackAuthTag, undefined);
    assert.equal(clientSub.renewalLeaseToken, undefined);
  });

  it("strictly fails closed with HTTP 503 in production when PAYSTACK_SECRET_KEY is unconfigured", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevKey = process.env.PAYSTACK_SECRET_KEY;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.PAYSTACK_SECRET_KEY;

      const initRes = await handlePaystackInitialize({ targetPlan: "starter" }, managerUser);
      assert.equal(initRes.status, 503);
      assert.match(initRes.body.message, /PAYSTACK_SECRET_KEY/);

      const verifyRes = await handlePaystackVerify({ reference: "pstk_test" }, managerUser);
      assert.equal(verifyRes.status, 503);
      assert.match(verifyRes.body.message, /PAYSTACK_SECRET_KEY/);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevKey !== undefined) {
        process.env.PAYSTACK_SECRET_KEY = prevKey;
      }
    }
  });

  describe("Regression — Staging Checkout Subscription State Verification & Free Plan Handling", () => {
    it("recognizes a valid Free Plan with explicit state 'FREE' and status 200", async () => {
      const mockProcessor = {
        getSubscriptionByWorkspaceDurable: async () => null,
        getSubscriptionByWorkspace: () => null,
        getLedgerByWorkspaceDurable: async () => [],
        getLedgerByWorkspace: () => [],
      };

      const res = await handleGetBillingStatus(managerUser, { processor: mockProcessor });
      assert.equal(res.status, 200);
      assert.equal(res.body.state, "FREE");
      assert.equal(res.body.subscription.planId, "free");
      assert.equal(res.body.subscription.seats, 5);
      assert.equal(res.body.subscription.status, "active");
      assert.equal(res.body.workspaceId, managerUser.teamId);
    });

    it("returns explicit state 'ACTIVE' and 'PAST_DUE' for paid subscriptions", async () => {
      const activeProcessor = {
        getSubscriptionByWorkspaceDurable: async () => ({
          planId: "starter",
          seats: 15,
          status: "active",
          paymentProvider: "paystack",
        }),
        getLedgerByWorkspaceDurable: async () => [],
      };
      const activeRes = await handleGetBillingStatus(managerUser, { processor: activeProcessor });
      assert.equal(activeRes.status, 200);
      assert.equal(activeRes.body.state, "ACTIVE");

      const pastDueProcessor = {
        getSubscriptionByWorkspaceDurable: async () => ({
          planId: "starter",
          seats: 15,
          status: "past_due",
          paymentProvider: "paystack",
        }),
        getLedgerByWorkspaceDurable: async () => [],
      };
      const pastDueRes = await handleGetBillingStatus(managerUser, { processor: pastDueProcessor });
      assert.equal(pastDueRes.status, 200);
      assert.equal(pastDueRes.body.state, "PAST_DUE");
    });

    it("strictly fails closed with 500 when database fails during billing status verification and never defaults to Free", async () => {
      const failingProcessor = {
        getSubscriptionByWorkspaceDurable: async () => {
          throw new Error("Neon connection failed: socket closed");
        },
        getLedgerByWorkspaceDurable: async () => [],
      };

      const res = await handleGetBillingStatus(managerUser, { processor: failingProcessor });
      assert.equal(res.status, 500);
      assert.equal(res.body.error, "Internal Server Error");
      assert.equal(res.body.message, "Failed to retrieve billing status from persistent storage.");
      assert.equal(res.body.state, undefined);
    });

    it("strictly fails closed with 401 when unauthenticated and 403 when wrong tenant", async () => {
      const unauthRes = await handleGetBillingStatus(null);
      assert.equal(unauthRes.status, 401);
      assert.equal(unauthRes.body.error, "Unauthorized");

      const wrongTenantUser = { ...managerUser, teamId: null };
      const wrongTenantRes = await handleGetBillingStatus(wrongTenantUser);
      assert.equal(wrongTenantRes.status, 403);
      assert.equal(wrongTenantRes.body.error, "Forbidden");
    });

    it("allows missing paid subscription (Free plan) to initiate upgrade with zero payment calls", async () => {
      const mockClient = new MockPaystackClient();
      const storage = new InMemoryBillingStorage(); // team 10 has no subscription in storage (valid Free Plan)

      const res = await handlePaystackInitialize(
        { targetPlan: "starter", workspaceId: managerUser.teamId },
        managerUser,
        { client: mockClient, storage }
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.plan, "starter");
      assert.equal(res.body.seats, 15);
      assert.ok(res.body.authorizationUrl);

      // Verify that initialization created reference but made 0 charge / verification payment calls
      assert.equal(mockClient.initializeCalls.length, 1);
      assert.equal(mockClient.chargeCalls?.length ?? 0, 0);
      assert.equal(mockClient.verifyCalls?.length ?? 0, 0);
    });

    it("server-side re-verifies subscription state and blocks redundant checkout for same active plan", async () => {
      const mockClient = new MockPaystackClient();
      const storage = new InMemoryBillingStorage();
      await storage.upsertSubscription({
        teamId: managerUser.teamId,
        planId: "starter",
        seats: 15,
        status: "active",
        paymentProvider: "paystack",
      });

      const res = await handlePaystackInitialize(
        { targetPlan: "starter", workspaceId: managerUser.teamId },
        managerUser,
        { client: mockClient, storage }
      );

      assert.equal(res.status, 400);
      assert.match(res.body.message, /already subscribed to the Starter/);
      // Assert zero outbound calls to Paystack
      assert.equal(mockClient.initializeCalls.length, 0);
    });

    it("strictly fails closed with 500 when database fails during checkout subscription re-verification with zero Paystack calls", async () => {
      const mockClient = new MockPaystackClient();
      const faultyStorage = {
        getSubscriptionByTeamId: async () => {
          throw new Error("Neon database timeout");
        },
      };

      const res = await handlePaystackInitialize(
        { targetPlan: "starter", workspaceId: managerUser.teamId },
        managerUser,
        { client: mockClient, storage: faultyStorage }
      );

      assert.equal(res.status, 500);
      assert.equal(res.body.error, "Internal Server Error");
      assert.equal(res.body.message, "Failed to verify current subscription state.");
      // Assert ZERO outbound provider calls
      assert.equal(mockClient.initializeCalls.length, 0);
    });

    it("strictly rejects wrong tenant in checkout initialize without leaking other workspace existence and asserts zero provider calls", async () => {
      const mockClient = new MockPaystackClient();
      const storage = new InMemoryBillingStorage();

      const res = await handlePaystackInitialize(
        { targetPlan: "starter", workspaceId: 9999 },
        managerUser,
        { client: mockClient, storage }
      );

      assert.equal(res.status, 403);
      assert.equal(res.body.error, "Forbidden");
      assert.equal(res.body.message, "Tenant mismatch: Cannot initiate checkout for another workspace.");
      // Assert zero outbound provider calls
      assert.equal(mockClient.initializeCalls.length, 0);
    });

    it("DatabaseBillingStorage adapter correctly delegates conventional queries to Neon client.query", async () => {
      let queryCallArgs = null;
      const fakeNeonClient = {
        query: async (sql, params) => {
          queryCallArgs = { sql, params };
          // Simulate Neon returning raw array of rows
          return [];
        },
      };

      const storage = new DatabaseBillingStorage(fakeNeonClient);
      const sub = await storage.getSubscriptionByTeamId(42);

      assert.equal(sub, null); // Valid Free Plan
      assert.ok(queryCallArgs);
      assert.equal(queryCallArgs.params[0], 42);
      assert.match(queryCallArgs.sql, /WHERE team_id = \$1/);
    });
  });

  describe("Paystack Verify — Atomicity & Retry Failure-Safety", () => {
    it("leaves event un-processed if ledger recording fails and allows successful retry", async () => {
      const mockClient = new MockPaystackClient();
      const faultyStorage = new InMemoryBillingStorage();
      const ref = "pstk_verify_fail_ledger_01";
      const eventId = `pstk_verify_${ref}`;

      mockClient.seedTransaction({
        id: 881,
        status: "success",
        reference: ref,
        amount: 1500000,
        currency: "NGN",
        metadata: { workspace_id: 10, plan_id: "starter" },
        customer: { customer_code: "CUS_fl_01", email: "manager@clinic.ng" },
        authorization: {
          authorization_code: "AUTH_valid_01",
          card_type: "visa",
          last4: "4081",
          reusable: true,
        },
      });

      // Break ledger recording
      faultyStorage.recordLedgerEntry = async () => {
        throw new Error("Simulated storage failure during ledger write");
      };

      const verifyOpts = {
        client: mockClient,
        storage: faultyStorage,
        encryptionKey: VALID_KEY_HEX,
      };

      await assert.rejects(
        async () => handlePaystackVerify({ reference: ref }, managerUser, verifyOpts),
        /Simulated storage failure during ledger write/
      );

      // Event must NOT be marked processed
      assert.equal(await faultyStorage.isEventProcessed(eventId), false);

      // Restore ledger recording
      faultyStorage.recordLedgerEntry = InMemoryBillingStorage.prototype.recordLedgerEntry.bind(faultyStorage);

      // Retry verification
      const retryRes = await handlePaystackVerify({ reference: ref }, managerUser, verifyOpts);
      assert.equal(retryRes.status, 200);
      assert.equal(retryRes.body.success, true);
      assert.equal(await faultyStorage.isEventProcessed(eventId), true);

      const sub = await faultyStorage.getSubscriptionByTeamId(10);
      assert.ok(sub);
      assert.equal(sub.planId, "starter");
      assert.equal(sub.status, "active");

      const ledger = await faultyStorage.getLedgerByTeamId(10);
      assert.equal(ledger.length, 1);
    });

    it("handles subscription update failure after ledger insertion without creating duplicate ledger on retry", async () => {
      const mockClient = new MockPaystackClient();
      const faultyStorage = new InMemoryBillingStorage();
      const ref = "pstk_verify_fail_sub_01";
      const eventId = `pstk_verify_${ref}`;

      mockClient.seedTransaction({
        id: 882,
        status: "success",
        reference: ref,
        amount: 1500000,
        currency: "NGN",
        metadata: { workspace_id: 10, plan_id: "starter" },
        customer: { customer_code: "CUS_fs_01", email: "manager@clinic.ng" },
        authorization: {
          authorization_code: "AUTH_valid_02",
          card_type: "visa",
          last4: "4081",
          reusable: true,
        },
      });

      let failOnce = true;
      const origUpsert = faultyStorage.upsertSubscription.bind(faultyStorage);
      faultyStorage.upsertSubscription = async (sub) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("Simulated transient error during subscription upsert");
        }
        return origUpsert(sub);
      };

      const verifyOpts = {
        client: mockClient,
        storage: faultyStorage,
        encryptionKey: VALID_KEY_HEX,
      };

      await assert.rejects(
        async () => handlePaystackVerify({ reference: ref }, managerUser, verifyOpts),
        /Simulated transient error during subscription upsert/
      );

      // Event must NOT be marked processed
      assert.equal(await faultyStorage.isEventProcessed(eventId), false);

      // Ledger has 1 entry from first attempt
      const ledger1 = await faultyStorage.getLedgerByTeamId(10);
      assert.equal(ledger1.length, 1);

      // Retry verification succeeds
      const retryRes = await handlePaystackVerify({ reference: ref }, managerUser, verifyOpts);
      assert.equal(retryRes.status, 200);
      assert.equal(retryRes.body.success, true);
      assert.equal(await faultyStorage.isEventProcessed(eventId), true);

      // Invariant: Ledger still has exactly 1 entry (zero duplicates)
      const ledger2 = await faultyStorage.getLedgerByTeamId(10);
      assert.equal(ledger2.length, 1);

      // Third duplicate call returns idempotent true
      const dupRes = await handlePaystackVerify({ reference: ref }, managerUser, verifyOpts);
      assert.equal(dupRes.status, 200);
      assert.equal(dupRes.body.idempotent, true);
      assert.equal(ledger2.length, 1);
    });
  });
});
