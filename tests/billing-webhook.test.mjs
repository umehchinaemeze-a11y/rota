import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeWebhookSignature,
  verifyWebhookSignature,
  parseWebhookSignatureHeader,
  BillingEventProcessor,
  PLAN_PRICING,
} from "../lib/billing.ts";

import {
  evaluateSeatCapacity,
  validateMemberAddition,
  resolveSeatLimit,
  WorkspaceSeatManager,
  TIER_ENTITLEMENTS,
} from "../lib/seat-limit.ts";

import { handleBillingWebhook } from "../app/api/billing/webhook/route.ts";
import { handleCreateCheckoutSession } from "../app/api/billing/checkout/route.ts";
import { handleConfirmPayment } from "../app/api/billing/confirm/route.ts";
import { handleGetBillingStatus } from "../app/api/billing/route.ts";
import { MockStripeClient } from "../lib/stripe.ts";

const TEST_SECRET = "whsec_test_secret_key_1234567890abcdef";

describe("Billing Webhook — Signature Verification & Replay Protection", () => {
  it("verifies a valid HMAC-SHA256 signature generated with the correct timestamp and secret", () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ id: "evt_test_1", type: "customer.subscription.created" });
    const sig = computeWebhookSignature(payload, TEST_SECRET, now);
    const header = `t=${now},v1=${sig}`;

    const result = verifyWebhookSignature(payload, header, TEST_SECRET, 300, now);
    assert.equal(result.valid, true);
    assert.equal(result.timestamp, now);
  });

  it("rejects an invalid or forged signature with clear failure reason", () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ id: "evt_test_2", type: "customer.subscription.created" });
    const header = `t=${now},v1=bad_signature_deadbeef1234567890`;

    const result = verifyWebhookSignature(payload, header, TEST_SECRET, 300, now);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("mismatch") || result.reason.includes("Signature"));
  });

  it("rejects an expired webhook signature exceeding the 300-second tolerance window (replay protection)", () => {
    const now = Math.floor(Date.now() / 1000);
    const oldTimestamp = now - 350; // 350 seconds ago (> 300s limit)
    const payload = JSON.stringify({ id: "evt_test_3", type: "customer.subscription.created" });
    const sig = computeWebhookSignature(payload, TEST_SECRET, oldTimestamp);
    const header = `t=${oldTimestamp},v1=${sig}`;

    const result = verifyWebhookSignature(payload, header, TEST_SECRET, 300, now);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("expired"));
  });

  it("rejects future timestamps beyond tolerance window to prevent forward-clock attacks", () => {
    const now = Math.floor(Date.now() / 1000);
    const futureTimestamp = now + 400; // 400 seconds in future
    const payload = JSON.stringify({ id: "evt_test_4", type: "customer.subscription.created" });
    const sig = computeWebhookSignature(payload, TEST_SECRET, futureTimestamp);
    const header = `t=${futureTimestamp},v1=${sig}`;

    const result = verifyWebhookSignature(payload, header, TEST_SECRET, 300, now);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("future"));
  });

  it("rejects null, empty, or malformed signature headers safely", () => {
    assert.equal(verifyWebhookSignature("body", null, TEST_SECRET).valid, false);
    assert.equal(verifyWebhookSignature("body", "", TEST_SECRET).valid, false);
    assert.equal(verifyWebhookSignature("body", "malformed_no_equals", TEST_SECRET).valid, false);
    assert.equal(verifyWebhookSignature("body", "t=123", TEST_SECRET).valid, false); // missing v1
    assert.equal(verifyWebhookSignature("body", "v1=sig", TEST_SECRET).valid, false); // missing t
  });

  it("returns HTTP 503 from route handler when webhook secret is unconfigured", async () => {
    const response = await handleBillingWebhook("body", "t=1,v1=abc", undefined);
    assert.equal(response.status, 503);
    assert.ok(response.body.message.includes("STRIPE_WEBHOOK_SECRET is not configured"));
  });
});

describe("Billing Webhook — Idempotency & Lifecycle Event Handling", () => {
  it("processes subscription.created and establishes workspace seat entitlements", async () => {
    const processor = new BillingEventProcessor();
    const event = {
      id: "evt_sub_create_1",
      type: "customer.subscription.created",
      created: 1700000000,
      data: {
        object: {
          id: "sub_101",
          metadata: { workspace_id: "workspace_ops" },
          quantity: 25,
          items: { data: [{ plan: { id: "pro_monthly" }, quantity: 25 }] },
        },
      },
    };

    const res = await processor.processEvent(event);
    assert.equal(res.status, "processed");
    assert.equal(res.actionTaken, "subscription_created");

    const sub = processor.getSubscription("sub_101");
    assert.ok(sub);
    assert.equal(sub.seats, 25);
    assert.equal(sub.workspaceId, "workspace_ops");
    assert.equal(sub.status, "active");
  });

  it("idempotently ignores duplicate webhook events and returns 200 acknowledgement without side-effects", async () => {
    const processor = new BillingEventProcessor();
    const event = {
      id: "evt_duplicate_test",
      type: "invoice.payment_succeeded",
      created: 1700000100,
      data: {
        object: {
          id: "inv_dup_1",
          amount_paid: 5000,
          currency: "usd",
          metadata: { workspace_id: "workspace_ops" },
        },
      },
    };

    // First delivery
    const firstRes = await processor.processEvent(event);
    assert.equal(firstRes.status, "processed");
    assert.equal(processor.getLedger().length, 1);

    // Second delivery (duplicate event delivery)
    const secondRes = await processor.processEvent(event);
    assert.equal(secondRes.status, "ignored_duplicate");
    assert.ok(secondRes.message.includes("already processed"));

    // Ledger has exactly 1 entry (no duplicate charges or double recording)
    assert.equal(processor.getLedger().length, 1);
  });

  it("discards out-of-order events when incoming event is older than current subscription state", async () => {
    const processor = new BillingEventProcessor([
      {
        subscriptionId: "sub_ooo",
        workspaceId: "ws_1",
        planId: "pro_annual",
        seats: 30,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1730000000,
        updatedAt: 1700050000, // Newer state
      },
    ]);

    // Stale incoming event timestamped before updatedAt
    const staleEvent = {
      id: "evt_stale_update",
      type: "customer.subscription.updated",
      created: 1700010000, // Older event
      data: {
        object: {
          id: "sub_ooo",
          quantity: 10, // Attempting to revert to 10 seats
        },
      },
    };

    const res = await processor.processEvent(staleEvent);
    assert.equal(res.status, "ignored_out_of_order");

    // Subscription retained newer 30 seats, not reverted to 10
    const sub = processor.getSubscription("sub_ooo");
    assert.equal(sub.seats, 30);
  });

  it("records failed invoices and marks subscription past_due", async () => {
    const processor = new BillingEventProcessor([
      {
        subscriptionId: "sub_pastdue_test",
        workspaceId: "ws_pastdue",
        planId: "starter",
        seats: 10,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    const failEvent = {
      id: "evt_fail_1",
      type: "invoice.payment_failed",
      created: 1702592005,
      data: {
        object: {
          id: "inv_failed_101",
          subscription: "sub_pastdue_test",
          amount_due: 1999,
          currency: "usd",
        },
      },
    };

    const res = await processor.processEvent(failEvent);
    assert.equal(res.status, "processed");
    assert.equal(res.actionTaken, "subscription_past_due");

    const sub = processor.getSubscription("sub_pastdue_test");
    assert.equal(sub.status, "past_due");

    const ledger = processor.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].status, "failed");
    assert.equal(ledger[0].amount, 1999);
  });
});

describe("Seat Limits & Entitlements — Capacity Evaluation & Constraints", () => {
  it("evaluates capacity correctly when workspace is below its seat limit", () => {
    const status = evaluateSeatCapacity("ws_test", 3, "free");
    assert.equal(status.seatLimit, 5);
    assert.equal(status.activeMembers, 3);
    assert.equal(status.availableSeats, 2);
    assert.equal(status.isAtCapacity, false);
    assert.equal(status.isOverLimit, false);
    assert.equal(status.canAddMember, true);
  });

  it("evaluates capacity correctly when workspace has reached its exact seat limit", () => {
    const status = evaluateSeatCapacity("ws_test", 5, "free");
    assert.equal(status.seatLimit, 5);
    assert.equal(status.activeMembers, 5);
    assert.equal(status.availableSeats, 0);
    assert.equal(status.isAtCapacity, true);
    assert.equal(status.isOverLimit, false);
    assert.equal(status.canAddMember, false);
    assert.ok(status.reason.includes("maximum seat capacity"));
  });

  it("non-destructively flags over-limit when members exceed limit after plan downgrade", () => {
    // Workspace had 12 members on Starter tier (15 limit), now downgraded to Free tier (5 limit)
    const status = evaluateSeatCapacity("ws_test", 12, "free");
    assert.equal(status.seatLimit, 5);
    assert.equal(status.activeMembers, 12);
    assert.equal(status.availableSeats, 0);
    assert.equal(status.isAtCapacity, true);
    assert.equal(status.isOverLimit, true);
    assert.equal(status.canAddMember, false);
    assert.ok(status.reason.includes("Upgrade plan to add members"));
  });

  it("falls back safely to Free Tier entitlement when billing data or tier is missing or invalid", () => {
    assert.equal(resolveSeatLimit(null), 5);
    assert.equal(resolveSeatLimit(undefined), 5);
    assert.equal(resolveSeatLimit("non_existent_tier"), 5);
    assert.equal(resolveSeatLimit("pro"), 50);
    assert.equal(resolveSeatLimit("enterprise"), 500);
    assert.equal(resolveSeatLimit("free", 22), 22); // custom seats override
  });

  it("rejects candidate additions for expired invitations", () => {
    const now = Math.floor(Date.now() / 1000);
    const request = {
      workspaceId: "ws_inv",
      candidateUserId: 10,
      candidateEmail: "alice@rota.local",
      role: "Staff",
      invitationExpiresAt: now - 3600, // expired 1 hour ago
    };

    const res = validateMemberAddition(request, 2, new Set([1, 2]), "free", undefined, now);
    assert.equal(res.success, false);
    assert.equal(res.code, "INVITATION_EXPIRED");
  });

  it("rejects candidate additions if user is already an active member (duplicate guard)", () => {
    const now = Math.floor(Date.now() / 1000);
    const request = {
      workspaceId: "ws_inv",
      candidateUserId: 2, // already in members
      candidateEmail: "existing@rota.local",
      role: "Staff",
    };

    const res = validateMemberAddition(request, 2, new Set([1, 2]), "free", undefined, now);
    assert.equal(res.success, false);
    assert.equal(res.code, "DUPLICATE_MEMBERSHIP");
    assert.ok(res.message.includes("already an active member"));
  });
});

describe("Seat Limits & Concurrency — Atomic Seat Claiming & Race Condition Protection", () => {
  it("prevents race condition when two concurrent requests attempt to claim the final available seat", async () => {
    // Free tier workspace with limit = 5, already having 4 members (1 seat remaining)
    const manager = new WorkspaceSeatManager([
      {
        workspaceId: "ws_concurrent",
        memberUserIds: [1, 2, 3, 4],
        tier: "free", // limit = 5
      },
    ]);

    const reqAlice = {
      workspaceId: "ws_concurrent",
      candidateUserId: 101,
      candidateEmail: "alice@rota.local",
      role: "Staff",
    };

    const reqBob = {
      workspaceId: "ws_concurrent",
      candidateUserId: 102,
      candidateEmail: "bob@rota.local",
      role: "Staff",
    };

    // Trigger both claims concurrently
    const [resultAlice, resultBob] = await Promise.all([
      manager.claimSeatAtomic(reqAlice),
      manager.claimSeatAtomic(reqBob),
    ]);

    // Exactly ONE request must succeed, and exactly ONE must fail
    const successes = [resultAlice, resultBob].filter((r) => r.success);
    const failures = [resultAlice, resultBob].filter((r) => !r.success);

    assert.equal(successes.length, 1, "Exactly one concurrent claim must succeed");
    assert.equal(failures.length, 1, "The second concurrent claim must be rejected");

    assert.equal(successes[0].code, "SEAT_GRANTED");
    assert.ok(
      failures[0].code === "SEAT_LIMIT_EXCEEDED" || failures[0].code === "CONCURRENT_CONFLICT"
    );

    // Final active member count cannot exceed 5
    const finalCapacity = manager.getCapacity("ws_concurrent");
    assert.equal(finalCapacity.activeMembers, 5);
    assert.equal(finalCapacity.isAtCapacity, true);
    assert.equal(finalCapacity.isOverLimit, false);
  });
});

describe("Payment Integration — Checkout Session Creation (POST /api/billing/checkout)", () => {
  it("rejects unauthenticated requests with HTTP 401 Unauthorized", async () => {
    const res = await handleCreateCheckoutSession({ targetPlan: "starter" }, null);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("rejects users without an active workspace with HTTP 403 Forbidden", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: null, exp: 9999999999 };
    const res = await handleCreateCheckoutSession({ targetPlan: "starter" }, user);
    assert.equal(res.status, 403);
    assert.ok(res.body.message.includes("active workspace"));
  });

  it("rejects non-manager staff employees with HTTP 403 Forbidden", async () => {
    const staffUser = {
      userId: 5,
      email: "staff@rota.local",
      name: "Staff Member",
      role: "Staff",
      teamId: 10,
      exp: 9999999999,
    };
    const res = await handleCreateCheckoutSession({ targetPlan: "starter" }, staffUser);
    assert.equal(res.status, 403);
    assert.ok(res.body.message.includes("Only workspace owners or managers"));
  });

  it("rejects requests targeting a mismatched workspace ID (tenant isolation guard) with HTTP 403 Forbidden", async () => {
    const managerUser = {
      userId: 2,
      email: "owner@rota.local",
      name: "Workspace Owner",
      role: "Owner",
      teamId: 10,
      exp: 9999999999,
    };
    const res = await handleCreateCheckoutSession(
      { workspaceId: 99, targetPlan: "starter" }, // Targeting workspace 99 instead of 10
      managerUser
    );
    assert.equal(res.status, 403);
    assert.ok(res.body.message.includes("Tenant mismatch"));
  });

  it("rejects invalid or missing target plans with HTTP 400 Bad Request", async () => {
    const managerUser = { userId: 2, email: "m@rota.local", name: "Mgr", role: "Manager", teamId: 10, exp: 9999999999 };
    const res = await handleCreateCheckoutSession({ targetPlan: "invalid_plan" }, managerUser);
    assert.equal(res.status, 400);
    assert.ok(res.body.message.includes("Invalid target plan"));
  });

  it("rejects checkout for the free plan with HTTP 400 Bad Request", async () => {
    const managerUser = { userId: 2, email: "m@rota.local", name: "Mgr", role: "Manager", teamId: 10, exp: 9999999999 };
    const res = await handleCreateCheckoutSession({ targetPlan: "free" }, managerUser);
    assert.equal(res.status, 400);
    assert.ok(res.body.message.includes("Cannot checkout free tier"));
  });

  it("creates a checkout session with correct pricing and metadata for new plan", async () => {
    const managerUser = { userId: 2, email: "m@rota.local", name: "Mgr", role: "Owner", teamId: 10, exp: 9999999999 };
    const mockStripe = new MockStripeClient();

    const res = await handleCreateCheckoutSession(
      { targetPlan: "starter" },
      managerUser,
      { stripeClient: mockStripe }
    );

    assert.equal(res.status, 200);
    assert.ok(res.body.sessionId.startsWith("cs_test_"));
    assert.equal(res.body.plan, "starter");
    assert.equal(res.body.seats, 15);
    assert.equal(res.body.amountCents, 2900); // $29.00
    assert.equal(res.body.prorated, false);

    // Verify metadata was attached correctly
    assert.equal(mockStripe.createdCalls.length, 1);
    assert.equal(mockStripe.createdCalls[0].workspaceId, 10);
    assert.equal(mockStripe.createdCalls[0].planId, "starter");
  });

  it("calculates prorated charge when upgrading active plan mid-cycle", async () => {
    const now = 1700000000;
    // Current Starter plan ($29/mo) expiring in 15 days (halfway through 30-day cycle)
    const existingSub = {
      subscriptionId: "sub_upgrade_test",
      workspaceId: "10",
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: now - 15 * 86400,
      currentPeriodEnd: now + 15 * 86400, // 15 days remaining
      updatedAt: now - 15 * 86400,
    };

    const processor = new BillingEventProcessor([existingSub]);
    const mockStripe = new MockStripeClient();
    const managerUser = { userId: 2, email: "m@rota.local", name: "Mgr", role: "Owner", teamId: 10, exp: 9999999999 };

    // Upgrade to Pro ($79/mo)
    // ($79 - $29) * (15/30) = $50 * 0.5 = $25.00 = 2500 cents
    const res = await handleCreateCheckoutSession(
      { targetPlan: "pro" },
      managerUser,
      { stripeClient: mockStripe, processor, currentTime: now }
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.plan, "pro");
    assert.equal(res.body.seats, 50);
    assert.equal(res.body.amountCents, 2500); // Prorated $25.00
    assert.equal(res.body.prorated, true);
    assert.equal(res.body.prorationDetails.daysRemaining, 15);
  });

  it("rejects checkout creation when workspace is already subscribed to target plan", async () => {
    const managerUser = { userId: 2, email: "m@rota.local", name: "Mgr", role: "Owner", teamId: 10, exp: 9999999999 };
    const existingSub = {
      subscriptionId: "sub_already_pro",
      workspaceId: "10",
      planId: "pro",
      seats: 50,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    };
    const processor = new BillingEventProcessor([existingSub]);

    const res = await handleCreateCheckoutSession(
      { targetPlan: "pro" },
      managerUser,
      { processor }
    );

    assert.equal(res.status, 400);
    assert.ok(res.body.message.includes("already subscribed"));
  });

  it("sanitizes payment provider errors during checkout creation with HTTP 500", async () => {
    const managerUser = { userId: 2, email: "m@rota.local", name: "Mgr", role: "Owner", teamId: 10, exp: 9999999999 };
    const throwingStripe = {
      async createCheckoutSession() {
        throw new Error("Stripe secret sk_test_secret_leak_attempt network failed");
      },
      async retrieveCheckoutSession() {
        return null;
      },
    };

    const res = await handleCreateCheckoutSession(
      { targetPlan: "starter" },
      managerUser,
      { stripeClient: throwingStripe }
    );

    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Payment Provider Error");
    assert.equal(res.body.message, "Failed to initiate payment session with provider. Please try again later.");
    assert.equal(res.body.message.includes("sk_test_"), false);
  });
});

describe("Payment Integration — Server-Side Payment Confirmation (POST /api/billing/confirm)", () => {
  it("rejects unauthenticated requests with HTTP 401 Unauthorized", async () => {
    const res = await handleConfirmPayment({ sessionId: "cs_test_123" }, null);
    assert.equal(res.status, 401);
  });

  it("rejects users without an active workspace with HTTP 403 Forbidden", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: null, exp: 9999999999 };
    const res = await handleConfirmPayment({ sessionId: "cs_test_123" }, user);
    assert.equal(res.status, 403);
  });

  it("rejects missing or empty sessionId with HTTP 400 Bad Request", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const res = await handleConfirmPayment({}, user);
    assert.equal(res.status, 400);
    assert.ok(res.body.message.includes("Missing or invalid sessionId"));
  });

  it("returns HTTP 404 Not Found when session does not exist on provider", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const mockStripe = new MockStripeClient(); // Empty mock client

    const res = await handleConfirmPayment(
      { sessionId: "cs_nonexistent" },
      user,
      { stripeClient: mockStripe }
    );

    assert.equal(res.status, 404);
    assert.ok(res.body.message.includes("was not found on the payment provider"));
  });

  it("returns HTTP 502 Bad Gateway with sanitized error when provider retrieval fails", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const throwingStripe = {
      async createCheckoutSession() {
        return null;
      },
      async retrieveCheckoutSession() {
        throw new Error("Stripe network gateway timeout");
      },
    };

    const res = await handleConfirmPayment(
      { sessionId: "cs_timeout" },
      user,
      { stripeClient: throwingStripe }
    );

    assert.equal(res.status, 502);
    assert.equal(res.body.error, "Bad Gateway");
    assert.ok(res.body.message.includes("Unable to verify checkout session"));
  });

  it("rejects unpaid session with HTTP 422 Payment Incomplete (never trust client-reported status)", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const mockStripe = new MockStripeClient([
      {
        id: "cs_unpaid_123",
        object: "checkout.session",
        payment_status: "unpaid", // Unpaid status
        status: "open",
        amount_total: 2900,
        currency: "usd",
        metadata: { workspace_id: "10", user_id: "1", plan_id: "starter", seats: "15" },
        created: 1700000000,
      },
    ]);

    // Client falsely claiming success in body
    const res = await handleConfirmPayment(
      { sessionId: "cs_unpaid_123", status: "paid" },
      user,
      { stripeClient: mockStripe }
    );

    assert.equal(res.status, 422);
    assert.equal(res.body.error, "Payment Incomplete");
    assert.ok(res.body.message.includes("Provider payment_status: 'unpaid'"));
  });

  it("rejects session where payment_status is unpaid even if status is complete", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const mockStripe = new MockStripeClient([
      {
        id: "cs_complete_but_unpaid",
        object: "checkout.session",
        payment_status: "unpaid", // Still unpaid (e.g. pending wire/SEPA)
        status: "complete", // Completed flow
        amount_total: 2900,
        currency: "usd",
        metadata: { workspace_id: "10", user_id: "1", plan_id: "starter", seats: "15" },
        created: 1700000000,
      },
    ]);

    const res = await handleConfirmPayment(
      { sessionId: "cs_complete_but_unpaid" },
      user,
      { stripeClient: mockStripe }
    );

    assert.equal(res.status, 422);
    assert.equal(res.body.error, "Payment Incomplete");
    assert.ok(res.body.message.includes("Provider payment_status: 'unpaid'"));
  });

  it("rejects session when metadata workspace_id belongs to another tenant (cross-tenant isolation guard)", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const mockStripe = new MockStripeClient([
      {
        id: "cs_other_tenant",
        object: "checkout.session",
        payment_status: "paid",
        status: "complete",
        amount_total: 7900,
        currency: "usd",
        metadata: { workspace_id: "99", user_id: "99", plan_id: "pro", seats: "50" }, // Different workspace 99
        created: 1700000000,
      },
    ]);

    const res = await handleConfirmPayment(
      { sessionId: "cs_other_tenant" },
      user,
      { stripeClient: mockStripe }
    );

    assert.equal(res.status, 403);
    assert.ok(res.body.message.includes("Tenant mismatch"));
  });

  it("ignores client-supplied amount, status, or plan parameters and confirms using only authoritative provider data", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const mockStripe = new MockStripeClient([
      {
        id: "cs_tampered_test",
        object: "checkout.session",
        payment_status: "paid",
        status: "complete",
        amount_total: 7900, // Authoritative price $79.00
        currency: "usd",
        metadata: { workspace_id: "10", user_id: "1", plan_id: "pro", seats: "50" },
        created: 1700000000,
      },
    ]);

    const processor = new BillingEventProcessor();

    // Malicious or buggy client attempting to claim Enterprise plan with $0
    const res = await handleConfirmPayment(
      {
        sessionId: "cs_tampered_test",
        amount: 0,
        status: "paid",
        planId: "enterprise",
        seats: 500,
      },
      user,
      { stripeClient: mockStripe, processor }
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    // Subscription correctly set to PRO (50 seats) from Stripe session, NOT Enterprise
    const sub = processor.getSubscriptionByWorkspace(10);
    assert.equal(sub.planId, "pro");
    assert.equal(sub.seats, 50);

    // Ledger records authoritative $79.00 (7900 cents), NOT $0
    const ledger = processor.getLedgerByWorkspace(10);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, 7900);
  });

  it("successfully confirms paid session, activates workspace subscription, and records ledger entry", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const mockStripe = new MockStripeClient([
      {
        id: "cs_success_101",
        object: "checkout.session",
        payment_status: "paid",
        status: "complete",
        amount_total: 2900,
        currency: "usd",
        subscription: "sub_starter_101",
        metadata: { workspace_id: "10", user_id: "1", plan_id: "starter", seats: "15" },
        created: 1700000000,
      },
    ]);

    const processor = new BillingEventProcessor();

    const res = await handleConfirmPayment(
      { sessionId: "cs_success_101" },
      user,
      { stripeClient: mockStripe, processor }
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.subscription.status, "active");
    assert.equal(res.body.subscription.planId, "starter");
    assert.equal(res.body.subscription.seats, 15);

    const ledger = processor.getLedgerByWorkspace(10);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].status, "succeeded");
    assert.equal(ledger[0].amount, 2900);
  });

  it("idempotently acknowledges duplicate confirmation requests without duplicate ledger entries", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 10, exp: 9999999999 };
    const mockStripe = new MockStripeClient([
      {
        id: "cs_idempotent_102",
        object: "checkout.session",
        payment_status: "paid",
        status: "complete",
        amount_total: 2900,
        currency: "usd",
        metadata: { workspace_id: "10", user_id: "1", plan_id: "starter", seats: "15" },
        created: 1700000000,
      },
    ]);

    const processor = new BillingEventProcessor();

    // First confirmation
    const firstRes = await handleConfirmPayment({ sessionId: "cs_idempotent_102" }, user, {
      stripeClient: mockStripe,
      processor,
    });
    assert.equal(firstRes.status, 200);
    assert.equal(firstRes.body.outcome, "processed");

    // Second confirmation (duplicate call)
    const secondRes = await handleConfirmPayment({ sessionId: "cs_idempotent_102" }, user, {
      stripeClient: mockStripe,
      processor,
    });
    assert.equal(secondRes.status, 200);
    assert.equal(secondRes.body.outcome, "ignored_duplicate");

    // Exactly one ledger entry
    assert.equal(processor.getLedgerByWorkspace(10).length, 1);
  });
});

describe("Billing Webhook — Checkout Session Completed Webhook Handling", () => {
  it("processes checkout.session.completed and establishes active subscription and ledger entry", async () => {
    const processor = new BillingEventProcessor();
    const event = {
      id: "evt_cs_completed_1",
      type: "checkout.session.completed",
      created: 1700000000,
      data: {
        object: {
          id: "cs_wh_101",
          payment_status: "paid",
          status: "complete",
          amount_total: 7900,
          currency: "usd",
          subscription: "sub_wh_pro",
          metadata: { workspace_id: "ws_hospital", plan_id: "pro", seats: "50" },
        },
      },
    };

    const res = await processor.processEvent(event);
    assert.equal(res.status, "processed");
    assert.equal(res.actionTaken, "checkout_completed");

    const sub = processor.getSubscription("sub_wh_pro");
    assert.ok(sub);
    assert.equal(sub.status, "active");
    assert.equal(sub.seats, 50);
    assert.equal(sub.workspaceId, "ws_hospital");

    const ledger = processor.getLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, 7900);
    assert.equal(ledger[0].status, "succeeded");
  });

  it("idempotently ignores checkout.session.completed if session was already confirmed via confirmation API", async () => {
    const processor = new BillingEventProcessor();

    // Simulate session confirmed via API first
    const mockStripe = new MockStripeClient([
      {
        id: "cs_already_done",
        object: "checkout.session",
        payment_status: "paid",
        status: "complete",
        amount_total: 2900,
        currency: "usd",
        subscription: "sub_already_done",
        metadata: { workspace_id: "ws_clinic", plan_id: "starter", seats: "15" },
        created: 1700000000,
      },
    ]);

    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: 50, exp: 9999999999 };
    await handleConfirmPayment({ sessionId: "cs_already_done" }, { ...user, teamId: "ws_clinic" }, {
      stripeClient: mockStripe,
      processor,
    });

    // Now incoming webhook arrives for the same session
    const webhookEvent = {
      id: "evt_cs_webhook_delayed",
      type: "checkout.session.completed",
      created: 1700000010,
      data: {
        object: {
          id: "cs_already_done",
          payment_status: "paid",
          status: "complete",
          amount_total: 2900,
          currency: "usd",
          metadata: { workspace_id: "ws_clinic", plan_id: "starter", seats: "15" },
        },
      },
    };

    const res = await processor.processEvent(webhookEvent);
    assert.equal(res.status, "ignored_duplicate");

    // Still exactly 1 ledger entry
    assert.equal(processor.getLedger().length, 1);
  });

  it("discards out-of-order checkout session webhook if existing subscription state is newer", async () => {
    const processor = new BillingEventProcessor([
      {
        subscriptionId: "sub_existing_newer",
        workspaceId: "ws_1",
        planId: "enterprise",
        seats: 500,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1730000000,
        updatedAt: 1700050000, // Newer updatedAt
      },
    ]);

    // Stale checkout webhook created prior to updatedAt
    const staleEvent = {
      id: "evt_stale_cs",
      type: "checkout.session.completed",
      created: 1700010000, // Older timestamp
      data: {
        object: {
          id: "cs_stale_1",
          subscription: "sub_existing_newer",
          payment_status: "paid",
          status: "complete",
          metadata: { workspace_id: "ws_1", plan_id: "starter", seats: "15" },
        },
      },
    };

    const res = await processor.processEvent(staleEvent);
    assert.equal(res.status, "ignored_out_of_order");

    // Subscription remains Enterprise with 500 seats
    const sub = processor.getSubscription("sub_existing_newer");
    assert.equal(sub.planId, "enterprise");
    assert.equal(sub.seats, 500);
  });

  it("fails processing if checkout session in webhook payload has unpaid status", async () => {
    const processor = new BillingEventProcessor();
    const unpaidEvent = {
      id: "evt_unpaid_wh",
      type: "checkout.session.completed",
      created: 1700000000,
      data: {
        object: {
          id: "cs_unpaid_wh",
          payment_status: "unpaid",
          status: "open",
          metadata: { workspace_id: "ws_fail", plan_id: "starter", seats: "15" },
        },
      },
    };

    const res = await processor.processEvent(unpaidEvent);
    assert.equal(res.status, "failed");
    assert.ok(res.message.includes("payment is not complete"));
  });

  it("fails processing if checkout session in webhook payload has status complete but payment_status unpaid", async () => {
    const processor = new BillingEventProcessor();
    const unpaidCompleteEvent = {
      id: "evt_unpaid_complete_wh",
      type: "checkout.session.completed",
      created: 1700000000,
      data: {
        object: {
          id: "cs_unpaid_complete",
          payment_status: "unpaid",
          status: "complete", // Flow complete but funds not captured
          metadata: { workspace_id: "ws_fail_2", plan_id: "starter", seats: "15" },
        },
      },
    };

    const res = await processor.processEvent(unpaidCompleteEvent);
    assert.equal(res.status, "failed");
    assert.ok(res.message.includes("payment is not complete"));
  });

  it("fails processing if checkout session webhook is missing workspace_id in metadata", async () => {
    const processor = new BillingEventProcessor();
    const missingWorkspaceEvent = {
      id: "evt_missing_ws",
      type: "checkout.session.completed",
      created: 1700000000,
      data: {
        object: {
          id: "cs_missing_ws",
          payment_status: "paid",
          status: "complete",
          metadata: {}, // Missing workspace_id
        },
      },
    };

    const res = await processor.processEvent(missingWorkspaceEvent);
    assert.equal(res.status, "failed");
    assert.ok(res.message.includes("missing workspace_id"));
  });

  it("supports subscription.created event alias and establishes entitlements", async () => {
    const processor = new BillingEventProcessor();
    const aliasEvent = {
      id: "evt_sub_alias_1",
      type: "subscription.created", // Generic alias
      created: 1700000000,
      data: {
        object: {
          id: "sub_alias_100",
          metadata: { workspace_id: "ws_alias" },
          quantity: 50,
          items: { data: [{ plan: { id: "pro_plan" }, quantity: 50 }] },
        },
      },
    };

    const res = await processor.processEvent(aliasEvent);
    assert.equal(res.status, "processed");
    assert.equal(res.actionTaken, "subscription_created");

    const sub = processor.getSubscription("sub_alias_100");
    assert.ok(sub);
    assert.equal(sub.workspaceId, "ws_alias");
    assert.equal(sub.seats, 50);
  });
});

describe("Billing Status & Workspace Query (GET /api/billing)", () => {
  it("rejects unauthenticated requests with HTTP 401 Unauthorized", async () => {
    const res = await handleGetBillingStatus(null);
    assert.equal(res.status, 401);
  });

  it("rejects users without an active workspace with HTTP 403 Forbidden", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Owner", teamId: null, exp: 9999999999 };
    const res = await handleGetBillingStatus(user);
    assert.equal(res.status, 403);
  });

  it("returns default free tier status, seat capacity, and empty ledger for workspace without subscription", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Staff", teamId: 20, exp: 9999999999 };
    const processor = new BillingEventProcessor();

    const res = await handleGetBillingStatus(user, { processor, activeMemberCount: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.body.workspaceId, 20);
    assert.equal(res.body.subscription.planId, "free");
    assert.equal(res.body.seatLimit, 5);
    assert.equal(res.body.capacity.activeMembers, 3);
    assert.equal(res.body.capacity.availableSeats, 2);
    assert.equal(res.body.capacity.isAtCapacity, false);
    assert.equal(res.body.ledger.length, 0);
  });

  it("returns active subscription status, custom seat limits, and ledger history for subscribed workspace", async () => {
    const user = { userId: 1, email: "u@rota.local", name: "User", role: "Manager", teamId: 30, exp: 9999999999 };
    const processor = new BillingEventProcessor([
      {
        subscriptionId: "sub_subscribed_ws",
        workspaceId: "30",
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    // Simulate invoice on ledger
    await processor.processEvent({
      id: "evt_inv_30",
      type: "invoice.payment_succeeded",
      created: 1700000000,
      data: {
        object: {
          id: "inv_30_1",
          amount_paid: 7900,
          currency: "usd",
          metadata: { workspace_id: "30" },
        },
      },
    });

    const res = await handleGetBillingStatus(user, { processor, activeMemberCount: 12 });
    assert.equal(res.status, 200);
    assert.equal(res.body.workspaceId, 30);
    assert.equal(res.body.subscription.planId, "pro");
    assert.equal(res.body.seatLimit, 50);
    assert.equal(res.body.capacity.activeMembers, 12);
    assert.equal(res.body.capacity.availableSeats, 38);
    assert.equal(res.body.capacity.canAddMember, true);
    assert.equal(res.body.ledger.length, 1);
    assert.equal(res.body.ledger[0].amount, 7900);
  });
});
