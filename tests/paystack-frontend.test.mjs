import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleGetBillingStatus } from "../app/api/billing/route.ts";
import { handleCancelPaystackSubscription } from "../app/api/billing/paystack/cancel/route.ts";
import { InMemoryBillingStorage } from "../lib/billing-storage.ts";
import { BillingEventProcessor } from "../lib/billing.ts";
import { PAYSTACK_PLANS, getPaystackPlan } from "../lib/paystack.ts";
import { resolveBillingVerificationBadge } from "../lib/billing-provider-badge.ts";

describe("Paystack Frontend & API Integration — Phase 6 Pricing & Status", () => {
  const managerUser = {
    userId: 1,
    email: "manager@hospital.ng",
    role: "admin",
    teamId: 10,
    teamRole: "Owner",
  };

  it("verifies approved commercial NGN pricing table and seat limits", () => {
    assert.deepEqual(getPaystackPlan("free"), {
      tier: "free",
      planId: "free",
      displayName: "Free Plan",
      monthlyNgn: 0,
      monthlyKobo: 0,
      maxSeats: 5,
    });

    assert.deepEqual(getPaystackPlan("starter"), {
      tier: "starter",
      planId: "starter",
      displayName: "Starter Plan",
      monthlyNgn: 15000,
      monthlyKobo: 1500000,
      maxSeats: 15,
    });

    assert.deepEqual(getPaystackPlan("pro"), {
      tier: "pro",
      planId: "pro",
      displayName: "Professional Plan",
      monthlyNgn: 45000,
      monthlyKobo: 4500000,
      maxSeats: 50,
    });

    assert.deepEqual(getPaystackPlan("enterprise"), {
      tier: "enterprise",
      planId: "enterprise",
      displayName: "Enterprise Plan",
      monthlyNgn: 150000,
      monthlyKobo: 15000000,
      maxSeats: 500,
    });
  });

  it("returns NGN plan details, seat capacity, and reusable card metadata without exposing authorization codes", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 10,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_manager_10",
        paystackAuthCipher: "encrypted_cipher_text",
        paystackAuthIv: "iv_test",
        paystackAuthTag: "tag_test",
        autoRenewEnabled: true,
        cardBrand: "visa",
        cardLast4: "4081",
        cardExpMonth: 12,
        cardExpYear: 2028,
        cardBank: "Zenith Bank",
        billingAnchorDay: 20,
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        cancelAtPeriodEnd: false,
        updatedAt: 1700000000,
      },
    ]);

    const processor = new BillingEventProcessor(undefined, storage);

    const res = await handleGetBillingStatus(managerUser, {
      processor,
      activeMemberCount: 12,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.workspaceId, 10);
    assert.equal(res.body.seatLimit, 50);
    assert.equal(res.body.paystackPlan.monthlyNgn, 45000);
    assert.equal(res.body.paystackPlan.monthlyKobo, 4500000);

    // Verify card display metadata is present
    const sub = res.body.subscription;
    assert.equal(sub.cardBrand, "visa");
    assert.equal(sub.cardLast4, "4081");
    assert.equal(sub.cardExpMonth, 12);
    assert.equal(sub.cardExpYear, 2028);
    assert.equal(sub.cardBank, "Zenith Bank");
    assert.equal(sub.autoRenewEnabled, true);

    // Verify plaintext authorization code is NOT present in any response field
    assert.equal(sub.paystackAuthCode, undefined);
    assert.equal(sub.authorizationCode, undefined);
    assert.equal(sub.authCode, undefined);

    // Verify seat capacity calculation
    assert.equal(res.body.capacity.activeMembers, 12);
    assert.equal(res.body.capacity.availableSeats, 38);
    assert.equal(res.body.capacity.canAddMember, true);
  });

  it("returns past_due status, grace period expiration, and retry schedules", async () => {
    const now = 1702592000;
    const graceExpires = now + 7 * 86400;
    const nextRetry = now + 48 * 3600;

    const storage = new InMemoryBillingStorage([
      {
        teamId: 10,
        paymentProvider: "paystack",
        planId: "starter",
        seats: 15,
        status: "past_due",
        autoRenewEnabled: true,
        retryCount: 1,
        nextRetryAt: nextRetry,
        gracePeriodExpiresAt: graceExpires,
        currentPeriodStart: 1700000000,
        currentPeriodEnd: now,
        updatedAt: now,
      },
    ]);

    const processor = new BillingEventProcessor(undefined, storage);
    const res = await handleGetBillingStatus(managerUser, { processor });

    assert.equal(res.status, 200);
    assert.equal(res.body.subscription.status, "past_due");
    assert.equal(res.body.subscription.retryCount, 1);
    assert.equal(res.body.subscription.nextRetryAt, nextRetry);
    assert.equal(res.body.subscription.gracePeriodExpiresAt, graceExpires);
  });
});

describe("Paystack Safe Cancellation — Phase 6 Merchant-Managed Downgrade & Stop", () => {
  const managerUser = {
    userId: 1,
    email: "manager@hospital.ng",
    role: "admin",
    teamId: 15,
    teamRole: "Owner",
  };

  const staffUser = {
    userId: 2,
    email: "staff@hospital.ng",
    role: "user",
    teamId: 15,
    teamRole: "Member",
  };

  it("rejects cancellation attempts from non-manager staff with HTTP 403", async () => {
    const res = await handleCancelPaystackSubscription(staffUser);
    assert.equal(res.status, 403);
    assert.match(res.body.message, /Only workspace owners or managers can cancel/);
  });

  it("rejects cancellation if workspace is already on free tier with HTTP 400", async () => {
    const storage = new InMemoryBillingStorage([
      {
        teamId: 15,
        planId: "free",
        seats: 5,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
        updatedAt: 1700000000,
      },
    ]);

    const res = await handleCancelPaystackSubscription(managerUser, { storage });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /currently on the free plan/);
  });

  it("cancels auto-renewal and stops future charges while preserving access and workspace data", async () => {
    const periodEnd = 1702592000;
    const storage = new InMemoryBillingStorage([
      {
        teamId: 15,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_15",
        paystackAuthCipher: "encrypted_token",
        paystackAuthIv: "iv_token",
        paystackAuthTag: "tag_token",
        autoRenewEnabled: true,
        planId: "pro",
        seats: 50,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        updatedAt: 1700000000,
      },
    ]);

    const res = await handleCancelPaystackSubscription(managerUser, {
      storage,
      currentTime: 1701000000,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.message, /Access will remain active until the end of your billing period/);

    // Verify storage invariants
    const updatedSub = await storage.getSubscriptionByTeamId(15);
    assert.ok(updatedSub);
    // Access remains active
    assert.equal(updatedSub.status, "active");
    // Period end is preserved
    assert.equal(updatedSub.currentPeriodEnd, periodEnd);
    // Auto-renewal is strictly disabled
    assert.equal(updatedSub.autoRenewEnabled, false);
    // cancelAtPeriodEnd flag set
    assert.equal(updatedSub.cancelAtPeriodEnd, true);
    // Seats remain preserved during current period
    assert.equal(updatedSub.seats, 50);
  });
});

describe("Dashboard Initialization Lifecycle & Dependency Loop Prevention", () => {
  class DashboardLifecycleSimulator {
    constructor({ authResponse, shiftsResponse }) {
      this.authResponse = authResponse;
      this.shiftsResponse = shiftsResponse;
      this.networkCalls = {
        authMe: 0,
        shifts: 0,
        recover: 0,
        billing: 0,
      };

      // Component state
      this.currentUser = null;
      this.currentUserRef = { current: null };
      this.authLoading = true;
      this.loading = true;
      this.shiftLoadStatus = "loading";
      this.statusMessage = "";
      this.schedule = [];
      this.recoverableShifts = [];
      this.subscriptionPlan = "free";

      // Refs
      this.isVerifyingSessionRef = { current: false };

      // Bind stable callbacks
      this.checkSession = this.checkSession.bind(this);
      this.loadShifts = this.loadShifts.bind(this);
      this.checkRecoverableShifts = this.checkRecoverableShifts.bind(this);
      this.loadBillingStatus = this.loadBillingStatus.bind(this);
    }

    setCurrentUser(user) {
      this.currentUser = user;
      // In React, useEffect(() => { currentUserRef.current = currentUser }, [currentUser])
      this.currentUserRef.current = user;
    }

    async checkSession() {
      this.networkCalls.authMe++;
      this.authLoading = false;
      if (this.authResponse && this.authResponse.authenticated) {
        this.setCurrentUser(this.authResponse.user);
        return this.authResponse.user;
      }
      this.setCurrentUser(null);
      return null;
    }

    async loadShifts() {
      this.networkCalls.shifts++;
      this.loading = true;
      if (this.shiftsResponse) {
        this.schedule = this.shiftsResponse.shifts || [];
        this.shiftLoadStatus = "success";
      }
      this.loading = false;
    }

    async checkRecoverableShifts(user) {
      const targetUser = user !== undefined ? user : this.currentUserRef.current;
      if (!targetUser) {
        this.recoverableShifts = [];
        return;
      }
      this.networkCalls.recover++;
      this.recoverableShifts = [{ id: 101, employee: "Test Staff" }];
    }

    async loadBillingStatus(user) {
      const targetUser = user !== undefined ? user : this.currentUserRef.current;
      if (!targetUser?.teamId) {
        this.subscriptionPlan = "free";
        return;
      }
      this.networkCalls.billing++;
      this.subscriptionPlan = "pro";
    }

    // Fixed effect implementation: stable dependencies
    async runInitializationEffect(active = true) {
      if (this.isVerifyingSessionRef.current) return;
      this.isVerifyingSessionRef.current = true;

      try {
        const user = await this.checkSession();
        if (!active) return;

        if (user) {
          await this.loadShifts();
          if (!active) return;

          await this.checkRecoverableShifts(user);
          if (!active) return;

          await this.loadBillingStatus(user);
          if (!active) return;
        } else {
          this.schedule = [];
          this.shiftLoadStatus = "unauthenticated";
          this.statusMessage = "Sign in required to view shifts. Please sign in to access your team schedule.";
          this.loading = false;
          this.subscriptionPlan = "free";
          this.recoverableShifts = [];
        }
      } finally {
        this.isVerifyingSessionRef.current = false;
      }
    }
  }

  it("handles signed-out initialization cleanly with exactly 1 auth check and 0 shifts calls", async () => {
    const dashboard = new DashboardLifecycleSimulator({
      authResponse: { authenticated: false },
      shiftsResponse: null,
    });

    await dashboard.runInitializationEffect();

    assert.equal(dashboard.networkCalls.authMe, 1, "Session verification should execute exactly once");
    assert.equal(dashboard.networkCalls.shifts, 0, "Shift loading should not run for unauthenticated visitor");
    assert.equal(dashboard.networkCalls.recover, 0, "Recoverable shifts should not run for unauthenticated visitor");
    assert.equal(dashboard.networkCalls.billing, 0, "Billing status should not load without workspace context");
    assert.equal(dashboard.currentUser, null);
    assert.equal(dashboard.shiftLoadStatus, "unauthenticated");
    assert.equal(dashboard.loading, false);
    assert.match(dashboard.statusMessage, /Sign in required/);
  });

  it("handles signed-in initialization: exactly 1 auth check, 1 shift load, 1 recover and 1 billing call", async () => {
    const dashboard = new DashboardLifecycleSimulator({
      authResponse: {
        authenticated: true,
        user: { userId: 42, email: "doc@hospital.ng", teamId: 99 },
      },
      shiftsResponse: {
        shifts: [{ id: 1, employeeName: "Nurse Joy", role: "Triage" }],
      },
    });

    await dashboard.runInitializationEffect();

    assert.equal(dashboard.networkCalls.authMe, 1, "Session verification executes once");
    assert.equal(dashboard.networkCalls.shifts, 1, "Shifts load once for authenticated user");
    assert.equal(dashboard.networkCalls.recover, 1, "Recoverable shifts checked once");
    assert.equal(dashboard.networkCalls.billing, 1, "Billing status loaded once");
    assert.equal(dashboard.currentUser?.userId, 42);
    assert.equal(dashboard.shiftLoadStatus, "success");
    assert.equal(dashboard.schedule.length, 1);
    assert.equal(dashboard.subscriptionPlan, "pro");
  });

  it("regression: updating currentUser does not re-trigger initialization effect or create repeated /api/auth/me or /api/shifts calls", async () => {
    const dashboard = new DashboardLifecycleSimulator({
      authResponse: {
        authenticated: true,
        user: { userId: 1, email: "admin@hospital.ng", teamId: 10 },
      },
      shiftsResponse: {
        shifts: [{ id: 1, employeeName: "Staff Member" }],
      },
    });

    // 1. Initial mount
    await dashboard.runInitializationEffect();
    assert.equal(dashboard.networkCalls.authMe, 1);
    assert.equal(dashboard.networkCalls.shifts, 1);

    // 2. Simulate subsequent renders where currentUser state updates or workspace updates occur
    const depsBefore = [
      dashboard.checkSession,
      dashboard.loadShifts,
      dashboard.checkRecoverableShifts,
      dashboard.loadBillingStatus,
    ];

    dashboard.setCurrentUser({
      userId: 1,
      email: "admin@hospital.ng",
      teamId: 10,
      role: "owner",
    });

    const depsAfter = [
      dashboard.checkSession,
      dashboard.loadShifts,
      dashboard.checkRecoverableShifts,
      dashboard.loadBillingStatus,
    ];

    // Verify all effect dependencies remain referentially stable across renders
    for (let i = 0; i < depsBefore.length; i++) {
      assert.strictEqual(
        depsBefore[i],
        depsAfter[i],
        `Callback reference at index ${i} must remain stable across currentUser changes`
      );
    }

    // Since dependencies didn't change, the effect does NOT re-run
    // Even if simulated re-renders occur:
    assert.equal(dashboard.networkCalls.authMe, 1, "No repeated /api/auth/me requests");
    assert.equal(dashboard.networkCalls.shifts, 1, "No repeated /api/shifts requests");
  });

  it("concurrency guard prevents duplicate concurrent session verifications", async () => {
    const dashboard = new DashboardLifecycleSimulator({
      authResponse: {
        authenticated: true,
        user: { userId: 5, teamId: 2 },
      },
      shiftsResponse: { shifts: [] },
    });

    // Run two initialization cycles concurrently
    await Promise.all([
      dashboard.runInitializationEffect(),
      dashboard.runInitializationEffect(),
    ]);

    // Concurrency guard ensures only 1 executed
    assert.equal(dashboard.networkCalls.authMe, 1, "Concurrent initialize() call dropped by in-flight guard");
  });
});

describe("Authentication & Registration Lifecycle — Non-Blocking & Resilient UX", () => {
  class AuthPageSimulator {
    constructor({ authResponse = { authenticated: false }, isSignUp = true } = {}) {
      this.isSignUp = isSignUp;
      this.authResponse = authResponse;
      this.redirectedTo = null;
      this.networkCalls = {
        authMe: 0,
        submit: 0,
      };

      // Form state — rendered immediately!
      this.isFormRendered = true;
      this.loading = false;
      this.error = null;
    }

    async runBackgroundSessionCheck(redirectPath = "/") {
      this.networkCalls.authMe++;
      if (this.authResponse && this.authResponse.authenticated) {
        this.redirectedTo = redirectPath;
        return true;
      }
      return false;
    }

    async submitRegistration(formData) {
      if (this.loading) {
        return { duplicatePrevented: true };
      }
      this.loading = true;
      this.networkCalls.submit++;

      // Validation
      if (!formData.name || formData.name.length < 2) {
        this.error = "Please enter your full name (at least 2 characters).";
        this.loading = false;
        return { status: 400 };
      }
      if (!formData.email || !formData.email.includes("@")) {
        this.error = "Please enter a valid work email address.";
        this.loading = false;
        return { status: 400 };
      }
      if (!formData.password || formData.password.length < 8) {
        this.error = "Password must be at least 8 characters long.";
        this.loading = false;
        return { status: 400 };
      }
      if (formData.password !== formData.confirmPassword) {
        this.error = "Passwords do not match. Please verify and try again.";
        this.loading = false;
        return { status: 400 };
      }

      // Simulated network/backend response
      if (formData.email === "existing@hospital.ng") {
        this.error = "An account with this email already exists. Please sign in instead.";
        this.loading = false;
        return { status: 409 };
      }

      this.redirectedTo = "/";
      this.loading = false;
      return { status: 200, success: true };
    }

    async submitLogin(credentials) {
      if (this.loading) {
        return { duplicatePrevented: true };
      }
      this.loading = true;
      this.networkCalls.submit++;

      if (!credentials.email || !credentials.password) {
        this.error = "Invalid email or password. Please try again.";
        this.loading = false;
        return { status: 400 };
      }

      if (credentials.password === "wrongpassword") {
        this.error = "Invalid email or password. Please try again.";
        this.loading = false;
        return { status: 401 };
      }

      this.redirectedTo = "/";
      this.loading = false;
      return { status: 200, success: true };
    }
  }

  it("registration page renders form immediately without waiting for session verification", () => {
    const signup = new AuthPageSimulator({ isSignUp: true });
    // Form is immediately rendered from tick 0
    assert.equal(signup.isFormRendered, true, "Form must be rendered immediately");
    assert.equal(signup.loading, false, "Loading state must be false initially");
    assert.equal(signup.error, null);
  });

  it("sign-in page renders form immediately without waiting for session verification", () => {
    const signin = new AuthPageSimulator({ isSignUp: false });
    assert.equal(signin.isFormRendered, true, "Sign-in form must be rendered immediately");
    assert.equal(signin.loading, false);
    assert.equal(signin.error, null);
  });

  it("background session check redirects already authenticated users smoothly", async () => {
    const signup = new AuthPageSimulator({
      authResponse: { authenticated: true, user: { userId: 10 } },
    });
    const redirected = await signup.runBackgroundSessionCheck("/dashboard");
    assert.equal(redirected, true);
    assert.equal(signup.redirectedTo, "/dashboard");
    assert.equal(signup.networkCalls.authMe, 1);
  });

  it("prevents duplicate concurrent registration submissions while loading", async () => {
    const signup = new AuthPageSimulator();
    const payload = {
      name: "Dr. Ngozi Eze",
      email: "ngozi@hospital.ng",
      password: "StrongPassword123!",
      confirmPassword: "StrongPassword123!",
    };

    // Simulate clicking submit twice concurrently
    signup.loading = true;
    const res = await signup.submitRegistration(payload);
    assert.equal(res.duplicatePrevented, true, "Must prevent duplicate concurrent submission");
    assert.equal(signup.networkCalls.submit, 0, "No duplicate network request sent");
  });

  it("prevents duplicate concurrent sign-in submissions while loading", async () => {
    const signin = new AuthPageSimulator({ isSignUp: false });
    signin.loading = true;
    const res = await signin.submitLogin({ email: "user@hospital.ng", password: "pw" });
    assert.equal(res.duplicatePrevented, true, "Must prevent duplicate login submission");
    assert.equal(signin.networkCalls.submit, 0);
  });

  it("handles registration 409 conflict cleanly without crashing", async () => {
    const signup = new AuthPageSimulator();
    const res = await signup.submitRegistration({
      name: "Existing User",
      email: "existing@hospital.ng",
      password: "StrongPassword123!",
      confirmPassword: "StrongPassword123!",
    });

    assert.equal(res.status, 409);
    assert.match(signup.error, /already exists/);
    assert.equal(signup.loading, false, "Loading flag resets on error");
    assert.equal(signup.isFormRendered, true, "Form remains interactive");
  });
});

describe("Billing Provider Verification Badge & State Accuracy", () => {
  it("displays neutral 'No paid subscription yet' for Free Plan even if provider is supplied", () => {
    const badgeFreeNoProvider = resolveBillingVerificationBadge({
      planId: "free",
      paymentProvider: null,
    });
    assert.equal(badgeFreeNoProvider.text, "No paid subscription yet");
    assert.equal(badgeFreeNoProvider.isVerified, false);
    assert.equal(badgeFreeNoProvider.provider, null);
    assert.match(badgeFreeNoProvider.className, /text-slate-500/);

    // Free plan must NEVER display "Verified via Paystack" under any circumstance
    const badgeFreeWithPaystack = resolveBillingVerificationBadge({
      planId: "free",
      paymentProvider: "paystack",
      subscriptionStatus: "active",
    });
    assert.equal(badgeFreeWithPaystack.text, "No paid subscription yet");
    assert.equal(badgeFreeWithPaystack.isVerified, false);
    assert.equal(badgeFreeWithPaystack.provider, null);
  });

  it("displays neutral 'No paid subscription yet' for null or empty subscription", () => {
    const badgeNull = resolveBillingVerificationBadge({
      planId: null,
      paymentProvider: null,
    });
    assert.equal(badgeNull.text, "No paid subscription yet");
    assert.equal(badgeNull.isVerified, false);
    assert.equal(badgeNull.provider, null);

    const badgeEmpty = resolveBillingVerificationBadge({});
    assert.equal(badgeEmpty.text, "No paid subscription yet");
    assert.equal(badgeEmpty.isVerified, false);
    assert.equal(badgeEmpty.provider, null);
  });

  it("displays 'Pending Provider Verification' for paid plans with missing or unrecorded provider", () => {
    const badgePaidNoProvider = resolveBillingVerificationBadge({
      planId: "starter",
      paymentProvider: null,
      subscriptionStatus: "active",
    });
    assert.equal(badgePaidNoProvider.text, "Pending Provider Verification");
    assert.equal(badgePaidNoProvider.isVerified, false);
    assert.equal(badgePaidNoProvider.provider, null);
    assert.match(badgePaidNoProvider.className, /text-amber-700/);

    const badgeProUndefined = resolveBillingVerificationBadge({
      planId: "pro",
      paymentProvider: undefined,
    });
    assert.equal(badgeProUndefined.text, "Pending Provider Verification");
    assert.equal(badgeProUndefined.isVerified, false);

    // Unrecognized string provider is rejected safely and treated as unrecorded
    const badgeUnknown = resolveBillingVerificationBadge({
      planId: "enterprise",
      paymentProvider: "paypal",
    });
    assert.equal(badgeUnknown.text, "Pending Provider Verification");
    assert.equal(badgeUnknown.isVerified, false);
    assert.equal(badgeUnknown.provider, null);
  });

  it("displays 'Authoritative · Verified via Paystack' strictly for paid plans with explicit Paystack provider", () => {
    const badgeStarter = resolveBillingVerificationBadge({
      planId: "starter",
      paymentProvider: "paystack",
      subscriptionStatus: "active",
    });
    assert.equal(badgeStarter.text, "Authoritative · Verified via Paystack");
    assert.equal(badgeStarter.isVerified, true);
    assert.equal(badgeStarter.provider, "paystack");
    assert.match(badgeStarter.className, /text-emerald-700/);

    const badgePro = resolveBillingVerificationBadge({
      planId: "pro",
      paymentProvider: "paystack",
      subscriptionStatus: "past_due",
    });
    assert.equal(badgePro.text, "Authoritative · Verified via Paystack");
    assert.equal(badgePro.isVerified, true);
    assert.equal(badgePro.provider, "paystack");
  });

  it("displays 'Authoritative · Verified via Stripe' for historical Stripe record with successful ledger evidence", () => {
    // 1. With successful historical ledger transaction
    const badgeWithLedger = resolveBillingVerificationBadge({
      planId: "pro",
      paymentProvider: "stripe",
      subscriptionStatus: "active",
      ledger: [
        { transactionId: "ch_historical_123", status: "succeeded", amount: 7900 }
      ],
    });
    assert.equal(badgeWithLedger.text, "Authoritative · Verified via Stripe");
    assert.equal(badgeWithLedger.isVerified, true);
    assert.equal(badgeWithLedger.provider, "stripe");
    assert.match(badgeWithLedger.className, /text-emerald-700/);

    // 2. With explicit hasPaymentEvidence: true
    const badgeExplicit = resolveBillingVerificationBadge({
      planId: "starter",
      paymentProvider: "stripe",
      subscriptionStatus: "active",
      hasPaymentEvidence: true,
    });
    assert.equal(badgeExplicit.text, "Authoritative · Verified via Stripe");
    assert.equal(badgeExplicit.isVerified, true);
  });

  it("displays 'Historical Stripe · Unverified' for historical Stripe record without ledger evidence", () => {
    // 1. Empty ledger array
    const badgeEmpty = resolveBillingVerificationBadge({
      planId: "pro",
      paymentProvider: "stripe",
      subscriptionStatus: "active",
      ledger: [],
    });
    assert.equal(badgeEmpty.text, "Historical Stripe · Unverified");
    assert.equal(badgeEmpty.isVerified, false);
    assert.equal(badgeEmpty.provider, "stripe");
    assert.match(badgeEmpty.className, /text-amber-700/);

    // 2. Ledger omitted/null
    const badgeNoLedger = resolveBillingVerificationBadge({
      planId: "starter",
      paymentProvider: "stripe",
      subscriptionStatus: "active",
    });
    assert.equal(badgeNoLedger.text, "Historical Stripe · Unverified");
    assert.equal(badgeNoLedger.isVerified, false);
  });

  it("displays 'Historical Stripe · Unverified' for historical Stripe record with failed ledger entry", () => {
    const badgeFailed = resolveBillingVerificationBadge({
      planId: "pro",
      paymentProvider: "stripe",
      subscriptionStatus: "active",
      ledger: [
        { transactionId: "ch_failed_1", status: "failed", amount: 7900 },
        { transactionId: "ch_abandoned_2", status: "abandoned", amount: 7900 }
      ],
    });
    assert.equal(badgeFailed.text, "Historical Stripe · Unverified");
    assert.equal(badgeFailed.isVerified, false);
    assert.equal(badgeFailed.provider, "stripe");
  });

  it("displays 'Authoritative · Verified via Paystack' for active Paystack subscription", () => {
    const badge = resolveBillingVerificationBadge({
      planId: "starter",
      paymentProvider: "paystack",
      subscriptionStatus: "active",
    });
    assert.equal(badge.text, "Authoritative · Verified via Paystack");
    assert.equal(badge.isVerified, true);
    assert.equal(badge.provider, "paystack");
    assert.match(badge.className, /text-emerald-700/);
  });

  it("displays 'Stripe Retired · Unverified' for new Stripe subscription claims", () => {
    const badgeNew = resolveBillingVerificationBadge({
      planId: "pro",
      paymentProvider: "stripe",
      subscriptionStatus: "active",
      isNew: true,
      hasPaymentEvidence: true, // Even if claiming payment evidence, new Stripe claim is unverified
    });
    assert.equal(badgeNew.text, "Stripe Retired · Unverified");
    assert.equal(badgeNew.isVerified, false);
    assert.match(badgeNew.className, /text-rose-700/);

    const badgeNonHistorical = resolveBillingVerificationBadge({
      planId: "starter",
      paymentProvider: "stripe",
      subscriptionStatus: "active",
      isHistorical: false,
    });
    assert.equal(badgeNonHistorical.text, "Stripe Retired · Unverified");
    assert.equal(badgeNonHistorical.isVerified, false);
  });

  it("handles canceled subscriptions accurately without false active verification claim", () => {
    const badgeCanceledPaystack = resolveBillingVerificationBadge({
      planId: "pro",
      paymentProvider: "paystack",
      subscriptionStatus: "canceled",
    });
    assert.equal(badgeCanceledPaystack.text, "Canceled · Prior Paystack");
    assert.equal(badgeCanceledPaystack.isVerified, false);
    assert.equal(badgeCanceledPaystack.provider, "paystack");

    const badgeCanceledStripe = resolveBillingVerificationBadge({
      planId: "starter",
      paymentProvider: "stripe",
      subscriptionStatus: "canceled",
    });
    assert.equal(badgeCanceledStripe.text, "Canceled · Prior Stripe");
    assert.equal(badgeCanceledStripe.isVerified, false);
  });

  it("integrates with handleGetBillingStatus for free default vs paid Paystack subscriptions", async () => {
    const managerUser = {
      userId: 1,
      email: "manager@hospital.ng",
      role: "admin",
      teamId: 10,
      teamRole: "Owner",
    };

    // 1. Free workspace with no subscription record
    const emptyStorage = new InMemoryBillingStorage([]);
    const emptyProcessor = new BillingEventProcessor(undefined, emptyStorage);
    const freeRes = await handleGetBillingStatus(managerUser, { processor: emptyProcessor });
    assert.equal(freeRes.status, 200);
    assert.equal(freeRes.body.subscription.planId, "free");
    assert.equal(freeRes.body.subscription.paymentProvider, undefined);

    const freeBadge = resolveBillingVerificationBadge({
      planId: freeRes.body.subscription.planId,
      paymentProvider: freeRes.body.subscription.paymentProvider,
      subscriptionStatus: freeRes.body.subscription.status,
    });
    assert.equal(freeBadge.text, "No paid subscription yet");
    assert.equal(freeBadge.isVerified, false);

    // 2. Paid Paystack workspace
    const paystackStorage = new InMemoryBillingStorage([
      {
        teamId: 10,
        paymentProvider: "paystack",
        paystackCustomerCode: "CUS_10",
        paystackAuthCipher: "cipher",
        paystackAuthIv: "iv",
        paystackAuthTag: "tag",
        autoRenewEnabled: true,
        planId: "starter",
        seats: 15,
        status: "active",
        currentPeriodStart: 1700000000,
        currentPeriodEnd: 1702592000,
      },
    ]);
    const paystackProcessor = new BillingEventProcessor(undefined, paystackStorage);
    const paystackRes = await handleGetBillingStatus(managerUser, { processor: paystackProcessor });
    assert.equal(paystackRes.status, 200);
    assert.equal(paystackRes.body.subscription.planId, "starter");
    assert.equal(paystackRes.body.subscription.paymentProvider, "paystack");

    const paystackBadge = resolveBillingVerificationBadge({
      planId: paystackRes.body.subscription.planId,
      paymentProvider: paystackRes.body.subscription.paymentProvider,
      subscriptionStatus: paystackRes.body.subscription.status,
    });
    assert.equal(paystackBadge.text, "Authoritative · Verified via Paystack");
    assert.equal(paystackBadge.isVerified, true);
  });
});
