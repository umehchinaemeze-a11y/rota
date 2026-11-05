import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyWebhookSignature,
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

import { InMemoryBillingStorage, DatabaseBillingStorage } from "../lib/billing-storage.ts";
import { handleGetBillingStatus } from "../app/api/billing/route.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const TEST_SECRET = "whsec_test_secret_key_1234567890abcdef";

describe("Billing Webhook — Retired Stripe Signature Verification & Route Removal", () => {
  it("strictly disables legacy Stripe webhook signature verification and fails closed", () => {
    const payload = JSON.stringify({ id: "evt_test_1", type: "customer.subscription.created" });
    const header = "t=1700000000,v1=abcdef1234567890";

    const result = verifyWebhookSignature(payload, header, TEST_SECRET, 300, 1700000000);
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes("retired and disabled"));
  });

  it("fails closed for null, empty, or malformed signature headers", () => {
    assert.equal(verifyWebhookSignature("body", null, TEST_SECRET).valid, false);
    assert.equal(verifyWebhookSignature("body", "", TEST_SECRET).valid, false);
    assert.equal(verifyWebhookSignature("body", "malformed_no_equals", TEST_SECRET).valid, false);
  });

  it("verifies legacy Stripe webhook route is completely removed from the application", () => {
    const routePath = path.resolve(currentDir, "../app/api/billing/webhook/route.ts");
    assert.equal(fs.existsSync(routePath), false, "Stripe webhook route must be removed");
  });
});

describe("Billing Webhook — Retired Stripe Lifecycle Event Rejection", () => {
  it("rejects customer.subscription.created and prevents subscription mutation", async () => {
    const storage = new InMemoryBillingStorage();
    const processor = new BillingEventProcessor(undefined, storage);

    const event = {
      id: "evt_sub_create_1",
      type: "customer.subscription.created",
      created: 1700000000,
      data: {
        object: {
          id: "sub_101",
          metadata: { workspace_id: "20" },
          quantity: 25,
          items: { data: [{ plan: { id: "pro_monthly" }, quantity: 25 }] },
        },
      },
    };

    const res = await processor.processEvent(event);
    assert.equal(res.status, "failed");
    assert.ok(res.message.includes("retired and disabled"));

    // Verify storage has no subscription for workspace 20
    const sub = await storage.getSubscriptionByTeamId(20);
    assert.equal(sub, null, "No subscription should be created by retired Stripe event");
  });

  it("rejects checkout.session.completed and prevents subscription/ledger mutation", async () => {
    const storage = new InMemoryBillingStorage();
    const processor = new BillingEventProcessor(undefined, storage);

    const event = {
      id: "evt_cs_completed_1",
      type: "checkout.session.completed",
      created: 1700000000,
      data: {
        object: {
          id: "cs_101",
          payment_status: "paid",
          status: "complete",
          amount_total: 7900,
          currency: "usd",
          subscription: "sub_cs_101",
          metadata: { workspace_id: "25", plan_id: "pro", seats: "50" },
        },
      },
    };

    const res = await processor.processEvent(event);
    assert.equal(res.status, "failed");
    assert.ok(res.message.includes("retired and disabled"));

    // Verify no ledger entry recorded
    const ledger = await storage.getLedgerByTeamId(25);
    assert.equal(ledger.length, 0);
  });

  it("rejects customer.subscription.deleted and prevents state regression", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 30,
        paymentProvider: "paystack",
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);
    const processor = new BillingEventProcessor(undefined, storage);

    const event = {
      id: "evt_sub_delete_1",
      type: "customer.subscription.deleted",
      created: 1700001000,
      data: {
        object: {
          id: "sub_30_legacy",
          metadata: { workspace_id: "30" },
        },
      },
    };

    const res = await processor.processEvent(event);
    assert.equal(res.status, "failed");

    // Subscription remains active
    const sub = await storage.getSubscriptionByTeamId(30);
    assert.equal(sub.status, "active");
  });
});

describe("Stripe Retirement & Route Removal Verification — Zero Stripe Runtime Payment Paths", () => {
  it("verifies Stripe checkout route (POST /api/billing/checkout) is completely removed", async () => {
    const checkoutRoute = path.resolve(currentDir, "../app/api/billing/checkout/route.ts");
    assert.equal(fs.existsSync(checkoutRoute), false, "Stripe checkout route must not exist");
  });

  it("verifies Stripe confirmation route (POST /api/billing/confirm) is completely removed", async () => {
    const confirmRoute = path.resolve(currentDir, "../app/api/billing/confirm/route.ts");
    assert.equal(fs.existsSync(confirmRoute), false, "Stripe confirmation route must not exist");
  });

  it("verifies Stripe webhook route (POST /api/billing/webhook) is completely removed", async () => {
    const webhookRoute = path.resolve(currentDir, "../app/api/billing/webhook/route.ts");
    assert.equal(fs.existsSync(webhookRoute), false, "Stripe webhook route must not exist");
  });

  it("verifies lib/stripe.ts is completely removed from the repository", async () => {
    const stripeLib = path.resolve(currentDir, "../lib/stripe.ts");
    assert.equal(fs.existsSync(stripeLib), false, "lib/stripe.ts must not exist");
  });

  it("verifies Paystack is the exclusive active provider for all new subscriptions and rejects omitted provider", async () => {
    const storage = new InMemoryBillingStorage();

    // 1. Omitted provider on new subscription is rejected
    await assert.rejects(
      async () => {
        await storage.upsertSubscription({
          teamId: 99,
          planId: "starter",
          seats: 15,
          status: "active",
        });
      },
      /requires an explicit paymentProvider: 'paystack'/
    );

    // 2. Explicit Paystack provider succeeds
    const created = await storage.upsertSubscription({
      teamId: 99,
      paymentProvider: "paystack",
      planId: "starter",
      seats: 15,
      status: "active",
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      updatedAt: 1700000000,
    });
    assert.equal(created.paymentProvider, "paystack");
    assert.equal(created.autoRenewEnabled, false);
  });

  it("strictly prohibits Stripe provider from receiving automatic renewals", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 101,
        paymentProvider: "stripe",
        stripeCustomerId: "cus_legacy",
        stripeSubscriptionId: "sub_legacy",
        planId: "pro",
        seats: 50,
        status: "active",
        autoRenewEnabled: true,
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    const sub = await storage.getSubscriptionByTeamId(101);
    assert.equal(sub.paymentProvider, "stripe");
    assert.equal(sub.autoRenewEnabled, false, "Stripe records must never be auto-renewable");
  });

  it("confirms workspace 2 in staging billing storage remains Starter with exactly one payment ledger entry", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 2,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_yzjpjtat1cwgs9s",
        planId: "starter",
        seats: 15,
        status: "active",
        autoRenewEnabled: true,
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    await storage.recordLedgerEntry({
      transactionId: "pstk_init_2_starter_1793622158_4be82bd6",
      teamId: 2,
      eventId: "pstk_verify_pstk_init_2_starter_1793622158_4be82bd6",
      type: "charge.success",
      amountCents: 1500000,
      currency: "NGN",
      status: "succeeded",
      createdAt: 1700000000,
    });

    const sub = await storage.getSubscriptionByTeamId(2);
    assert.ok(sub);
    assert.equal(sub.teamId, 2);
    assert.equal(sub.planId, "starter");
    assert.equal(sub.status, "active");
    assert.equal(sub.paymentProvider, "paystack");

    const ledger = await storage.getLedgerByTeamId(2);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].transactionId, "pstk_init_2_starter_1793622158_4be82bd6");
    assert.equal(ledger[0].status, "succeeded");
  });
});

describe("Billing Storage Interface — Write Rejection & Historical Read Preservation", () => {
  it("rejects creating new Stripe subscriptions in InMemoryBillingStorage", async () => {
    const storage = new InMemoryBillingStorage();
    await assert.rejects(
      async () => {
        await storage.upsertSubscription({
          teamId: 77,
          paymentProvider: "stripe",
          planId: "starter",
          seats: 15,
          status: "active",
          currentPeriodStart: 1700000000,
          currentPeriodEnd: 1702592000,
        });
      },
      /Cannot create or update Stripe subscription.*Stripe provider has been retired/
    );
  });

  it("rejects recording Stripe events in InMemoryBillingStorage", async () => {
    const storage = new InMemoryBillingStorage();
    await assert.rejects(
      async () => {
        await storage.recordEvent({
          eventId: "evt_stripe_new_1",
          eventType: "customer.subscription.created",
          status: "processed",
        });
      },
      /Cannot record Stripe event.*Stripe provider has been retired/
    );
  });

  it("rejects recording Stripe ledger entries in InMemoryBillingStorage", async () => {
    const storage = new InMemoryBillingStorage();
    await assert.rejects(
      async () => {
        await storage.recordLedgerEntry({
          transactionId: "ch_stripe_charge_1",
          teamId: 77,
          type: "checkout_session_completed",
          amountCents: 5000,
          currency: "usd",
          status: "succeeded",
        });
      },
      /Cannot record Stripe ledger entry.*Stripe provider has been retired/
    );
  });

  it("preserves historical Stripe subscriptions as readable and unmutated", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 88,
        paymentProvider: "stripe",
        stripeCustomerId: "cus_hist_88",
        stripeSubscriptionId: "sub_hist_88",
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: 1690000000,
        currentPeriodEnd: 1692592000,
        updatedAt: 1690000000,
      },
    ]);

    const byTeam = await storage.getSubscriptionByTeamId(88);
    assert.ok(byTeam);
    assert.equal(byTeam.paymentProvider, "stripe");
    assert.equal(byTeam.stripeCustomerId, "cus_hist_88");
    assert.equal(byTeam.stripeSubscriptionId, "sub_hist_88");

    const byStripe = await storage.getSubscriptionByStripeId("sub_hist_88");
    assert.ok(byStripe);
    assert.equal(byStripe.teamId, 88);
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
    const storage = new InMemoryBillingStorage([
      {
        teamId: 30,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_sub_30",
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    await storage.recordLedgerEntry({
      transactionId: "pstk_tx_30_1",
      teamId: 30,
      type: "charge.success",
      amountCents: 3500000,
      currency: "NGN",
      status: "succeeded",
      createdAt: 1700000000,
    });

    const processor = new BillingEventProcessor(undefined, storage);

    const res = await handleGetBillingStatus(user, { processor, activeMemberCount: 12 });
    assert.equal(res.status, 200);
    assert.equal(res.body.workspaceId, 30);
    assert.equal(res.body.subscription.planId, "pro");
    assert.equal(res.body.seatLimit, 50);
    assert.equal(res.body.capacity.activeMembers, 12);
    assert.equal(res.body.capacity.availableSeats, 38);
    assert.equal(res.body.capacity.canAddMember, true);
    assert.equal(res.body.ledger.length, 1);
    assert.equal(res.body.ledger[0].amount, 3500000);
  });
});

describe("Seat Limits & Entitlements — Capacity Evaluation & Constraints (Restored Regression)", () => {
  it("evaluates capacity correctly when workspace is below its seat limit", () => {
    const status = evaluateSeatCapacity("ws_1", 3, "starter");
    assert.equal(status.seatLimit, 15);
    assert.equal(status.activeMembers, 3);
    assert.equal(status.availableSeats, 12);
    assert.equal(status.isAtCapacity, false);
    assert.equal(status.isOverLimit, false);
    assert.equal(status.canAddMember, true);
  });

  it("evaluates capacity correctly when workspace has reached its exact seat limit", () => {
    const status = evaluateSeatCapacity("ws_1", 15, "starter");
    assert.equal(status.seatLimit, 15);
    assert.equal(status.activeMembers, 15);
    assert.equal(status.availableSeats, 0);
    assert.equal(status.isAtCapacity, true);
    assert.equal(status.isOverLimit, false);
    assert.equal(status.canAddMember, false);
    assert.ok(status.reason.includes("maximum seat capacity"));
  });

  it("non-destructively flags over-limit when members exceed limit after plan downgrade", () => {
    // 12 members in workspace downgraded to Free tier (5 seats)
    const status = evaluateSeatCapacity("ws_1", 12, "free");
    assert.equal(status.seatLimit, 5);
    assert.equal(status.activeMembers, 12);
    assert.equal(status.availableSeats, 0);
    assert.equal(status.isAtCapacity, true);
    assert.equal(status.isOverLimit, true);
    assert.equal(status.canAddMember, false);
    assert.ok(status.reason.includes("exceeds capacity"));
  });

  it("falls back safely to Free Tier entitlement when billing data or tier is missing or invalid", () => {
    const statusMissing = evaluateSeatCapacity("ws_1", 2, undefined);
    assert.equal(statusMissing.seatLimit, 5);
    assert.equal(statusMissing.tier, "free");

    const statusInvalid = evaluateSeatCapacity("ws_1", 2, "unknown_tier_xyz");
    assert.equal(statusInvalid.seatLimit, 5);
    assert.equal(statusInvalid.tier, "free");
  });

  it("rejects candidate additions for expired invitations", () => {
    const now = 1700000000;
    const request = {
      workspaceId: "ws_1",
      candidateUserId: 10,
      candidateEmail: "new@hospital.ng",
      role: "Staff",
      invitationExpiresAt: now - 3600, // expired 1 hour ago
    };

    const result = validateMemberAddition(
      request,
      2,
      new Set([1, 2]),
      "starter",
      undefined,
      now
    );

    assert.equal(result.success, false);
    assert.equal(result.code, "INVITATION_EXPIRED");
    assert.ok(result.message.includes("expired"));
  });

  it("rejects candidate additions if user is already an active member (duplicate guard)", () => {
    const now = 1700000000;
    const request = {
      workspaceId: "ws_1",
      candidateUserId: 2,
      candidateEmail: "existing@hospital.ng",
      role: "Staff",
      invitationExpiresAt: now + 3600,
    };

    const result = validateMemberAddition(
      request,
      2,
      new Set([1, 2]),
      "starter",
      undefined,
      now
    );

    assert.equal(result.success, false);
    assert.equal(result.code, "DUPLICATE_MEMBERSHIP");
    assert.ok(result.message.includes("already an active member"));
  });
});

describe("Seat Limits & Concurrency — Atomic Seat Claiming & Race Condition Protection (Restored Regression)", () => {
  it("prevents race condition when two concurrent requests attempt to claim the final available seat", async () => {
    // Starter tier (15 seats) with 14 active members -> exactly 1 seat remains
    const manager = new WorkspaceSeatManager([
      {
        workspaceId: "ws_race",
        memberUserIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        tier: "starter",
      },
    ]);

    const req1 = {
      workspaceId: "ws_race",
      candidateUserId: 15,
      candidateEmail: "alice@hospital.ng",
      role: "Staff",
    };

    const req2 = {
      workspaceId: "ws_race",
      candidateUserId: 16,
      candidateEmail: "bob@hospital.ng",
      role: "Staff",
    };

    const [res1, res2] = await Promise.all([
      manager.claimSeatAtomic(req1),
      manager.claimSeatAtomic(req2),
    ]);

    const outcomes = [res1.success, res2.success].sort();
    assert.deepEqual(outcomes, [false, true], "Exactly one concurrent candidate must be granted the seat");

    const capacity = manager.getCapacity("ws_race");
    assert.equal(capacity.activeMembers, 15);
    assert.equal(capacity.isAtCapacity, true);
  });
});
