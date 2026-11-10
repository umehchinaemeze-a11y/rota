"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { canManageTeamShiftRecord, isManagerRole, APP_ROLES } from "@/lib/permissions";
import {
  resolveShiftFetchResponse,
  resolveShiftRecoveryResponse,
  mapApiShift,
  type ApiShift,
  type ScheduleShift,
  type ShiftRecoveryOutcome,
  type ShiftSwapRecord,
  type NotificationRecord,
  type UserNotificationPreferences,
  type UserSettings,
  type UserTheme,
  SUPPORTED_THEMES,
  SUPPORTED_LANGUAGES,
  saveSettingsToOfflineCache,
  loadSettingsFromOfflineCache,
  saveShiftsToOfflineCache,
  loadShiftsFromOfflineCache,
  clearSettingsOfflineCache,
  clearShiftsOfflineCache,
  applyThemeToDocument,
  applyLanguageToDocument,
} from "@/lib/shifts-client";
import type { RecoverableShift } from "@/lib/shift-recovery";
import {
  resolveBillingVerificationBadge,
  type PaymentProvider,
} from "@/lib/billing-provider-badge";
import {
  type ActivityEventRecord,
  mergeActivityPages,
} from "@/lib/activity-client";
import GoogleAccountSettings from "./google-account-settings";

type AuthUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  teamId?: number | null;
  hasPassword?: boolean;
  googleLinked?: boolean;
};

type UserWorkspace = {
  id: number;
  name: string;
  slug?: string;
  role: string;
  is_default?: boolean;
};

function getInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default function Home() {
  const [activeTab, setActiveTab] = useState("Overview");

  // Authentication states
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const currentUserRef = useRef<AuthUser | null>(null);
  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);
  const [authLoading, setAuthLoading] = useState(true);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  // Form modal states
  const [showForm, setShowForm] = useState(false);
  const [editingShift, setEditingShift] = useState<ScheduleShift | null>(null);
  const [deletingShift, setDeletingShift] = useState<ScheduleShift | null>(null);

  // Shift Swap states
  const [swapRequests, setSwapRequests] = useState<ShiftSwapRecord[]>([]);
  const [swappingShift, setSwappingShift] = useState<ScheduleShift | null>(null);
  const [swapTargetShiftId, setSwapTargetShiftId] = useState<number | null>(null);
  const [swapReason, setSwapReason] = useState("");
  const [submittingSwap, setSubmittingSwap] = useState(false);
  const [actioningSwapId, setActioningSwapId] = useState<number | null>(null);

  // Notification states
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [userNotifications, setUserNotifications] = useState<NotificationRecord[]>([]);
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState(0);
  const [showNotificationsPanel, setShowNotificationsPanel] = useState(false);
  const [notificationPreferences, setNotificationPreferences] = useState<UserNotificationPreferences | null>(null);
  const [savingPreferences, setSavingPreferences] = useState(false);

  // User Settings Synchronization states
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsConflict, setSettingsConflict] = useState<UserSettings | null>(null);

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("Front Desk");
  const [inviting, setInviting] = useState(false);

  // Form fields
  const [employee, setEmployee] = useState("");
  const [role, setRole] = useState("Front Desk");
  const [day, setDay] = useState("2026-10-12");

  // Feedback states
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [shiftLoadStatus, setShiftLoadStatus] = useState<
    "loading" | "success" | "unauthenticated" | "forbidden" | "network_error"
  >("loading");
  const [statusMessage, setStatusMessage] = useState("");
  const [isOfflineSchedule, setIsOfflineSchedule] = useState<boolean>(false);
  const [offlineTimestamp, setOfflineTimestamp] = useState<string | null>(null);

  // Workspace onboarding states
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");

  // Legacy Shift Recovery states
  const [recoverableShifts, setRecoverableShifts] = useState<RecoverableShift[]>([]);
  const [checkingRecovery, setCheckingRecovery] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoveryWorkspaces, setRecoveryWorkspaces] = useState<UserWorkspace[]>([]);
  const [selectedTargetTeamId, setSelectedTargetTeamId] = useState<number | "">("");
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoverySuccess, setRecoverySuccess] = useState("");

  // Workspace Subscription & Billing states
  const [subscriptionPlan, setSubscriptionPlan] = useState<string>("free");
  const [subscriptionSeats, setSubscriptionSeats] = useState<number>(5);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>("active");
  const [paymentProvider, setPaymentProvider] = useState<PaymentProvider>(null);

  // Activity Feed states
  const [activityEvents, setActivityEvents] = useState<ActivityEventRecord[]>([]);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [activityHasMore, setActivityHasMore] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityLoadingMore, setActivityLoadingMore] = useState(false);
  const [activityRefreshing, setActivityRefreshing] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const activityFetchingRef = useRef(false);
  const activitySentinelRef = useRef<HTMLDivElement | null>(null);
  const [autoRenewEnabled, setAutoRenewEnabled] = useState<boolean>(false);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState<boolean>(false);
  const [cardMetadata, setCardMetadata] = useState<{ brand?: string | null; last4?: string | null; bank?: string | null } | null>(null);
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<number | null>(null);
  const [gracePeriodExpiresAt, setGracePeriodExpiresAt] = useState<number | null>(null);
  const [billingLedger, setBillingLedger] = useState<any[]>([]);
  const [showBillingModal, setShowBillingModal] = useState<boolean>(false);
  const [upgradingPlan, setUpgradingPlan] = useState<boolean>(false);
  const [billingError, setBillingError] = useState<string>("");

  // Schedule & team
  const [schedule, setSchedule] = useState<ScheduleShift[]>([]);
  const [team, setTeam] = useState([
    { name: "Amara Okafor", role: "Front Desk", status: "On shift", initials: "AO" },
    { name: "Daniel James", role: "Operations", status: "Upcoming", initials: "DJ" },
    { name: "Sarah Bello", role: "Customer Support", status: "On shift", initials: "SB" },
    { name: "David Musa", role: "Front Desk", status: "Off duty", initials: "DM" },
    { name: "Chika Nwosu", role: "Supervisor", status: "On shift", initials: "CN" },
  ]);

  // Check authenticated session on load with bounded timeout
  const checkSession = useCallback(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetch("/api/auth/me", { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          setCurrentUser(data.user);
          return data.user as AuthUser;
        }
      }

      // If access token expired (401), attempt silent token refresh
      if (res.status === 401) {
        try {
          const refreshRes = await fetch("/api/auth/refresh", {
            method: "POST",
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            if (refreshData.success && refreshData.user) {
              setCurrentUser(refreshData.user);
              return refreshData.user as AuthUser;
            }
          }
        } catch {
          // Token refresh failed or revoked
        }
      }

      setCurrentUser(null);
      return null;
    } catch {
      setCurrentUser(null);
      return null;
    } finally {
      clearTimeout(timeoutId);
      setAuthLoading(false);
    }
  }, []);

  const loadShifts = useCallback(async () => {
    setLoading(true);
    setError("");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch("/api/shifts", { signal: controller.signal });
      clearTimeout(timeoutId);
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Response may not contain JSON
      }

      const outcome = resolveShiftFetchResponse(response.status, body);

      if (outcome.status === "success") {
        setSchedule(outcome.shifts);
        setShiftLoadStatus("success");
        setStatusMessage("");
        setError("");
        setIsOfflineSchedule(false);
        setOfflineTimestamp(null);
        if (currentUserRef.current) {
          saveShiftsToOfflineCache(outcome.shifts, {
            userId: currentUserRef.current.id,
            email: currentUserRef.current.email,
            teamId: currentUserRef.current.teamId,
          });
        }
      } else if (outcome.status === "unauthenticated") {
        setSchedule([]);
        setShiftLoadStatus("unauthenticated");
        setStatusMessage(outcome.message);
        setError(""); // Do not present 401 as a connection error
        setIsOfflineSchedule(false);
        setOfflineTimestamp(null);
      } else if (outcome.status === "forbidden") {
        setSchedule([]);
        setShiftLoadStatus("forbidden");
        setStatusMessage(outcome.message);
        setError(""); // Do not present 403 as a connection error
        setIsOfflineSchedule(false);
        setOfflineTimestamp(null);
      } else {
        const userCtx = currentUserRef.current
          ? {
              userId: currentUserRef.current.id,
              email: currentUserRef.current.email,
              teamId: currentUserRef.current.teamId,
            }
          : null;
        const cached = loadShiftsFromOfflineCache(userCtx);
        if (cached && cached.shifts && cached.shifts.length > 0) {
          setSchedule(cached.shifts);
          setShiftLoadStatus("success");
          setIsOfflineSchedule(true);
          setOfflineTimestamp(cached.timestamp);
          setStatusMessage("");
          setError("");
        } else {
          setSchedule([]);
          setShiftLoadStatus("network_error");
          setError(outcome.message);
          setStatusMessage("");
          setIsOfflineSchedule(false);
          setOfflineTimestamp(null);
        }
      }
    } catch {
      const userCtx = currentUserRef.current
        ? {
            userId: currentUserRef.current.id,
            email: currentUserRef.current.email,
            teamId: currentUserRef.current.teamId,
          }
        : null;
      const cached = loadShiftsFromOfflineCache(userCtx);
      if (cached && cached.shifts && cached.shifts.length > 0) {
        setSchedule(cached.shifts);
        setShiftLoadStatus("success");
        setIsOfflineSchedule(true);
        setOfflineTimestamp(cached.timestamp);
        setStatusMessage("");
        setError("");
      } else {
        const outcome = resolveShiftFetchResponse(0, null, true);
        setSchedule([]);
        setShiftLoadStatus("network_error");
        setError(outcome.status !== "success" ? outcome.message : "Failed to load shifts.");
        setStatusMessage("");
        setIsOfflineSchedule(false);
        setOfflineTimestamp(null);
      }
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }, []);

  const loadSwapRequests = useCallback(async () => {
    try {
      const res = await fetch("/api/shifts/swaps");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setSwapRequests(data);
        }
      }
    } catch {
      // Swaps loading error should not break dashboard
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.notifications)) {
          setUserNotifications(data.notifications);
          setUnreadNotificationsCount(data.unreadCount || 0);
        }
      }
    } catch {
      // Background notifications error
    }
  }, []);

  const loadUserSettings = useCallback(async (user?: AuthUser | null) => {
    const targetUser = user !== undefined ? user : currentUserRef.current;
    if (!targetUser || !targetUser.id) return;

    const userContext = {
      userId: targetUser.id,
      email: targetUser.email,
      teamId: targetUser.teamId,
    };

    // 1. Instant local offline cache lookup
    const cached = loadSettingsFromOfflineCache(userContext);
    if (cached) {
      setUserSettings(cached);
      applyThemeToDocument(cached.theme);
      applyLanguageToDocument(cached.language);
      setNotificationsEnabled(cached.notifications.enabled);
      setNotificationPreferences({
        userId: cached.userId,
        teamId: cached.teamId,
        enabled: cached.notifications.enabled,
        categories: cached.notifications.categories,
        quietHours: cached.quietHours,
        updatedAt: cached.updatedAt,
      });
    }

    // 2. Authoritative server query
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setUserSettings(data.settings);
          saveSettingsToOfflineCache(data.settings, userContext);
          applyThemeToDocument(data.settings.theme);
          applyLanguageToDocument(data.settings.language);
          setNotificationsEnabled(data.settings.notifications.enabled);
          setNotificationPreferences({
            userId: data.settings.userId,
            teamId: data.settings.teamId,
            enabled: data.settings.notifications.enabled,
            categories: data.settings.notifications.categories,
            quietHours: data.settings.quietHours,
            updatedAt: data.settings.updatedAt,
          });
          setSettingsConflict(null);
        }
      }
    } catch {
      // Offline fallback: cached settings remain active
    }
  }, []);

  const loadNotificationPreferences = useCallback(async (user?: AuthUser | null) => {
    await loadUserSettings(user);
  }, [loadUserSettings]);

  // Check legacy shifts available for recovery
  const checkRecoverableShifts = useCallback(
    async (user?: AuthUser | null) => {
      const targetUser = user !== undefined ? user : currentUserRef.current;
      if (!targetUser) {
        setRecoverableShifts([]);
        return;
      }

      setCheckingRecovery(true);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      try {
        const res = await fetch("/api/shifts/recover", { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.status === 401) {
          setRecoverableShifts([]);
          return;
        }
        if (res.ok) {
          const data = await res.json();
          setRecoverableShifts(Array.isArray(data.shifts) ? data.shifts : []);
        } else {
          setRecoverableShifts([]);
        }
      } catch {
        setRecoverableShifts([]);
      } finally {
        clearTimeout(timeoutId);
        setCheckingRecovery(false);
      }
    },
    []
  );

  const loadBillingStatus = useCallback(async (user?: AuthUser | null) => {
    const targetUser = user !== undefined ? user : currentUserRef.current;
    if (!targetUser?.teamId) {
      setSubscriptionPlan("free");
      setSubscriptionSeats(5);
      setSubscriptionStatus("active");
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetch("/api/billing", { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        const sub = data.subscription;
        if (sub) {
          setSubscriptionPlan(sub.planId || "free");
          setSubscriptionSeats(sub.seats || 5);
          setSubscriptionStatus(sub.status || "active");
          if (sub.paymentProvider === "paystack" || sub.paymentProvider === "stripe") {
            setPaymentProvider(sub.paymentProvider);
          } else {
            setPaymentProvider(null);
          }
          setAutoRenewEnabled(!!sub.autoRenewEnabled);
          setCancelAtPeriodEnd(!!sub.cancelAtPeriodEnd);
          if (sub.cardLast4) {
            setCardMetadata({
              brand: sub.cardBrand,
              last4: sub.cardLast4,
              bank: sub.cardBank,
            });
          } else {
            setCardMetadata(null);
          }
          setCurrentPeriodEnd(sub.currentPeriodEnd || null);
          setGracePeriodExpiresAt(sub.gracePeriodExpiresAt || null);
        }
        if (Array.isArray(data.ledger)) {
          setBillingLedger(data.ledger);
        }
      } else {
        if (res.status === 401) {
          setBillingError("Authentication required: please sign in to view billing.");
        } else if (res.status === 403) {
          setBillingError("Access denied: only workspace owners or managers can access billing.");
        } else {
          setBillingError("Unable to verify workspace subscription state from server.");
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setBillingError("Billing verification timed out. Please check your network connection.");
      } else {
        setBillingError("Network error: failed to verify subscription state.");
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  const handleUpgradePlan = async (targetPlan: string) => {
    setUpgradingPlan(true);
    setBillingError("");

    try {
      const res = await fetch("/api/billing/paystack/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: currentUser?.teamId,
          targetPlan,
          callbackUrl: typeof window !== "undefined" ? window.location.origin + window.location.pathname : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          setBillingError(data.message || "Authentication required to initiate checkout.");
        } else if (res.status === 403) {
          setBillingError(data.message || "Access denied: only workspace owners or managers can initiate checkout.");
        } else if (res.status === 502) {
          setBillingError(data.message || "Payment gateway unavailable. Please try again shortly.");
        } else {
          setBillingError(data.message || "Failed to verify current subscription state.");
        }
        return;
      }

      // If a real external Paystack checkout URL is returned (e.g. on staging with live Paystack), redirect customer
      if (
        data.authorizationUrl &&
        typeof data.authorizationUrl === "string" &&
        data.authorizationUrl.startsWith("http") &&
        !data.authorizationUrl.includes("mock") &&
        !data.authorizationUrl.includes("localhost")
      ) {
        window.location.href = data.authorizationUrl;
        return;
      }

      if (data.reference) {
        // In local offline / mock test mode, immediately verify and confirm payment server-side
        const verifyRes = await fetch("/api/billing/paystack/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: data.reference }),
        });

        const verifyData = await verifyRes.json();
        if (verifyRes.ok && verifyData.success) {
          setSubscriptionPlan(verifyData.subscription?.planId || targetPlan);
          setSubscriptionSeats(verifyData.subscription?.seats || data.seats || 15);
          setSubscriptionStatus(verifyData.subscription?.status || "active");
          setPaymentProvider(verifyData.subscription?.paymentProvider || "paystack");
          setAutoRenewEnabled(!!verifyData.subscription?.autoRenewEnabled);
          setShowBillingModal(false);
          setNotice(
            `Workspace subscription successfully upgraded to ${targetPlan.toUpperCase()} tier (${
              verifyData.subscription?.seats || data.seats
            } seats).`
          );
          await loadBillingStatus();
        } else {
          setBillingError(verifyData.message || "Payment verification failed.");
        }
      }
    } catch (err: any) {
      setBillingError(err?.message || "Failed to connect to billing service.");
    } finally {
      setUpgradingPlan(false);
    }
  };

  const handleCancelSubscription = async () => {
    setUpgradingPlan(true);
    setBillingError("");

    try {
      const res = await fetch("/api/billing/paystack/cancel", {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setCancelAtPeriodEnd(true);
        setAutoRenewEnabled(false);
        setNotice(
          "Subscription auto-renewal canceled. Your team access and schedule remain intact until the end of your billing cycle."
        );
        await loadBillingStatus();
      } else {
        setBillingError(data.message || "Failed to cancel subscription.");
      }
    } catch (err: any) {
      setBillingError(err?.message || "Failed to cancel subscription.");
    } finally {
      setUpgradingPlan(false);
    }
  };

  const loadActivityFirstPage = useCallback(async (isRefresh = false) => {
    if (activityFetchingRef.current) return;
    activityFetchingRef.current = true;

    if (isRefresh) {
      setActivityRefreshing(true);
    } else {
      setActivityLoading(true);
    }
    setActivityError(null);

    try {
      const res = await fetch("/api/activity?limit=20");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setActivityEvents(data.items || []);
      setActivityCursor(data.nextCursor || null);
      setActivityHasMore(Boolean(data.hasMore));
    } catch (err: any) {
      setActivityError(err.message || "Failed to load activity feed.");
    } finally {
      activityFetchingRef.current = false;
      setActivityLoading(false);
      setActivityRefreshing(false);
    }
  }, []);

  const loadActivityNextPage = useCallback(async () => {
    if (
      activityFetchingRef.current ||
      !activityHasMore ||
      !activityCursor ||
      activityLoading ||
      activityLoadingMore ||
      activityRefreshing
    ) {
      return;
    }
    activityFetchingRef.current = true;
    setActivityLoadingMore(true);
    setActivityError(null);

    try {
      const res = await fetch(`/api/activity?limit=20&cursor=${encodeURIComponent(activityCursor)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setActivityEvents((prev) => mergeActivityPages(prev, data.items || []));
      setActivityCursor(data.nextCursor || null);
      setActivityHasMore(Boolean(data.hasMore));
    } catch (err: any) {
      setActivityError(err.message || "Failed to load older activities.");
    } finally {
      activityFetchingRef.current = false;
      setActivityLoadingMore(false);
    }
  }, [activityCursor, activityHasMore, activityLoading, activityLoadingMore, activityRefreshing]);

  // Load first page when Activity tab becomes active
  useEffect(() => {
    if (activeTab === "Activity" && activityEvents.length === 0 && !activityLoading) {
      loadActivityFirstPage(false);
    }
  }, [activeTab, activityEvents.length, activityLoading, loadActivityFirstPage]);

  // IntersectionObserver for infinite scrolling sentinel
  useEffect(() => {
    if (activeTab !== "Activity" || !activityHasMore || activityLoadingMore || activityLoading) {
      return;
    }
    const sentinel = activitySentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadActivityNextPage();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeTab, activityHasMore, activityLoadingMore, activityLoading, loadActivityNextPage]);

  // Load shifts and verify authentication on load
  useEffect(() => {
    let active = true;

    async function initialize() {
      try {
        const user = await checkSession();
        if (!active) return;

        if (user) {
          await loadShifts();
          if (!active) return;

          // Non-blocking parallel execution for independent workspace features
          await Promise.allSettled([
            checkRecoverableShifts(user),
            loadBillingStatus(user),
            loadSwapRequests(),
            loadNotifications(),
            loadUserSettings(user),
          ]);
          if (!active) return;

          // Check if returning from checkout with reference (Paystack) or deep link
          if (typeof window !== "undefined") {
            const params = new URLSearchParams(window.location.search);
            const tabParam = params.get("tab");
            if (tabParam && ["Overview", "Schedule", "Activity", "Team", "Settings"].includes(tabParam)) {
              setActiveTab(tabParam);
            }
            const pstkRef = params.get("reference") || params.get("trxref");
            const pstkStatus = params.get("status");
            const googleStatus = params.get("google");
            const googleError = params.get("google_error");

            if (googleStatus === "linked") {
              setNotice("Google account linked successfully.");
            } else if (googleError === "link_conflict") {
              setNotice("That Google account is already linked to another Rota user.");
            }

            if (pstkStatus === "cancelled" || pstkStatus === "failed") {
              setNotice("Paystack payment checkout was cancelled or failed. No charges were made.");
            } else if (pstkRef) {
              try {
                const verifyRes = await fetch("/api/billing/paystack/verify", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reference: pstkRef }),
                });
                const verifyData = await verifyRes.json();
                if (verifyRes.ok && verifyData.success && active) {
                  setNotice("Payment verified! Your workspace subscription has been updated.");
                  await loadBillingStatus(user);
                }
              } catch {
                // Ignore transient query param error
              }
            }
          }
        } else {
          // Unauthenticated: set unauthenticated state safely
          setSchedule([]);
          setShiftLoadStatus("unauthenticated");
          setStatusMessage("Sign in required to view shifts. Please sign in to access your team schedule.");
          setLoading(false);
          setSubscriptionPlan("free");
          setSubscriptionSeats(5);
          setSubscriptionStatus("active");
          setPaymentProvider(null);
          setRecoverableShifts([]);
          setUserSettings(null);
          setSettingsConflict(null);
          clearSettingsOfflineCache();
          applyThemeToDocument("system");
          applyLanguageToDocument("en");
        }
      } catch {
        if (active) {
          setShiftLoadStatus("network_error");
          setError("Failed to initialize workspace data.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void initialize();

    return () => {
      active = false;
    };
  }, [checkSession, loadShifts, checkRecoverableShifts, loadBillingStatus, loadSwapRequests, loadNotifications, loadUserSettings]);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!loginEmail.trim() || !loginPassword || loggingIn) return;

    setLoggingIn(true);
    setLoginError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Login failed. Check your credentials.");
      }

      setCurrentUser(data);
      setShowLoginModal(false);
      setLoginEmail("");
      setLoginPassword("");
      setNotice(`Signed in securely as ${data.name} (${data.role}).`);
      await loadShifts();
      await checkRecoverableShifts(data);
      await loadBillingStatus(data);
      await loadSwapRequests();
      await loadNotifications();
      await loadUserSettings(data);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newWorkspaceName.trim();
    if (!trimmed || creatingWorkspace) return;

    if (trimmed.length < 2) {
      setWorkspaceError("Workspace name must be at least 2 characters.");
      return;
    }

    setCreatingWorkspace(true);
    setWorkspaceError("");
    setError("");

    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || "Failed to create workspace. Please try again.");
      }

      setNotice(`Workspace "${data.team.name}" created! You are now the workspace Owner.`);
      setNewWorkspaceName("");
      const user = await checkSession();
      if (user) {
        setCurrentUser(user);
      }
      await loadShifts();
      if (user) {
        await checkRecoverableShifts(user);
        await loadBillingStatus(user);
        await loadSwapRequests();
        await loadNotifications();
        await loadUserSettings(user);
      }
    } catch (err: unknown) {
      setWorkspaceError(
        err instanceof Error ? err.message : "An unexpected error occurred while creating your workspace."
      );
    } finally {
      setCreatingWorkspace(false);
    }
  }

  async function handleLogout(allDevices = false) {
    try {
      await fetch(allDevices ? "/api/auth/logout?all=true" : "/api/auth/logout", {
        method: "POST",
      });
      setCurrentUser(null);
      setSwapRequests([]);
      setUserNotifications([]);
      setUnreadNotificationsCount(0);
      setNotificationPreferences(null);
      setUserSettings(null);
      setSettingsConflict(null);
      clearSettingsOfflineCache();
      clearShiftsOfflineCache();
      setIsOfflineSchedule(false);
      setOfflineTimestamp(null);
      applyThemeToDocument("system");
      applyLanguageToDocument("en");
      setRecoverableShifts([]);
      setSubscriptionPlan("free");
      setSubscriptionSeats(5);
      setNotice(
        allDevices
          ? "You have been signed out from all devices."
          : "You have signed out successfully."
      );
      await loadShifts();
    } catch {
      setError("Failed to sign out cleanly.");
    }
  }

  async function handleOpenRecoveryModal() {
    if (!currentUser) {
      setShowLoginModal(true);
      setNotice("Please sign in to recover legacy shifts.");
      return;
    }

    setRecoveryError("");
    setRecoverySuccess("");
    setRecoveryConfirmed(false);
    setShowRecoveryModal(true);

    try {
      const res = await fetch("/api/teams");
      if (res.status === 401) {
        setShowRecoveryModal(false);
        setCurrentUser(null);
        setShowLoginModal(true);
        setNotice("Your session expired. Please sign in again.");
        return;
      }
      if (res.ok) {
        const data = await res.json();
        const teamsList: UserWorkspace[] = Array.isArray(data.teams) ? data.teams : [];
        setRecoveryWorkspaces(teamsList);
        if (currentUser.teamId && teamsList.some((t) => t.id === currentUser.teamId)) {
          setSelectedTargetTeamId(currentUser.teamId);
        } else if (teamsList.length === 1) {
          setSelectedTargetTeamId(teamsList[0].id);
        } else {
          setSelectedTargetTeamId("");
        }
      } else if (currentUser.teamId) {
        setRecoveryWorkspaces([
          { id: currentUser.teamId, name: `Workspace #${currentUser.teamId}`, role: currentUser.role },
        ]);
        setSelectedTargetTeamId(currentUser.teamId);
      }
    } catch {
      if (currentUser?.teamId) {
        setRecoveryWorkspaces([
          { id: currentUser.teamId, name: `Workspace #${currentUser.teamId}`, role: currentUser.role },
        ]);
        setSelectedTargetTeamId(currentUser.teamId);
      }
    }
  }

  async function handleSubmitRecovery(e: React.FormEvent) {
    e.preventDefault();
    if (recovering) return;

    if (!selectedTargetTeamId || typeof selectedTargetTeamId !== "number") {
      setRecoveryError("Please select a workspace you are authorized to access.");
      return;
    }

    if (!recoveryConfirmed) {
      setRecoveryError("Please check the confirmation box before submitting recovery.");
      return;
    }

    setRecovering(true);
    setRecoveryError("");
    setRecoverySuccess("");

    try {
      const res = await fetch("/api/shifts/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetTeamId: selectedTargetTeamId,
        }),
      });

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON response
      }

      const outcome = resolveShiftRecoveryResponse(res.status, body);

      if (outcome.status === "unauthenticated") {
        setShowRecoveryModal(false);
        setCurrentUser(null);
        setShowLoginModal(true);
        setNotice("Your session expired. Please sign in again to recover shifts.");
        return;
      }

      if (outcome.status === "forbidden") {
        setRecoveryError(outcome.message);
        return;
      }

      if (outcome.status === "conflict" || outcome.status === "error") {
        setRecoveryError(outcome.message);
        return;
      }

      const count = outcome.recoveredCount > 0 ? outcome.recoveredCount : recoverableShifts.length;
      const targetName =
        recoveryWorkspaces.find((w) => w.id === selectedTargetTeamId)?.name ||
        `Workspace #${selectedTargetTeamId}`;

      setRecoverySuccess(
        count > 0
          ? `Successfully recovered ${count} legacy shift${count === 1 ? "" : "s"} into ${targetName}!`
          : "All legacy shifts have already been recovered."
      );
      setNotice(`Successfully recovered ${count} legacy shift(s) into ${targetName}.`);

      // Refresh shifts and update recovery state
      await loadShifts();
      await checkRecoverableShifts();

      setTimeout(() => {
        setShowRecoveryModal(false);
        setRecoverySuccess("");
      }, 1200);
    } catch {
      setRecoveryError("A network error occurred while recovering shifts. Please try again.");
    } finally {
      setRecovering(false);
    }
  }

  function handleOpenAdd() {
    if (!currentUser) {
      setShowLoginModal(true);
      setNotice("Please sign in to schedule shifts.");
      return;
    }

    setEditingShift(null);
    setEmployee(currentUser.name);
    setRole(currentUser.role);
    setDay("2026-10-12");
    setNotice("");
    setError("");
    setShowForm(true);
  }

  function handleStartEdit(shift: ScheduleShift) {
    setNotice("");
    setError("");

    if (!currentUser) {
      setShowLoginModal(true);
      setNotice("Please sign in to edit shifts.");
      return;
    }

    const hasPermission = canManageTeamShiftRecord(
      {
        userId: currentUser.id,
        role: currentUser.role,
        teamId: currentUser.teamId ?? null,
      },
      {
        id: shift.id,
        user_id: shift.userId,
        employee_name: shift.name,
        teamId: shift.teamId ?? null,
      }
    );

    if (!hasPermission) {
      setError(
        `Permission denied: You are signed in as "${currentUser.name}" (${currentUser.role}). You can only edit shifts assigned to your account. Legacy shifts require manager permissions.`
      );
      return;
    }

    setEditingShift(shift);
    setEmployee(shift.name);
    setRole(shift.role);
    setDay(shift.shiftDay);
    setShowForm(true);
  }

  function handleStartDelete(shift: ScheduleShift) {
    setNotice("");
    setError("");

    if (!currentUser) {
      setShowLoginModal(true);
      setNotice("Please sign in to delete shifts.");
      return;
    }

    const hasPermission = canManageTeamShiftRecord(
      {
        userId: currentUser.id,
        role: currentUser.role,
        teamId: currentUser.teamId ?? null,
      },
      {
        id: shift.id,
        user_id: shift.userId,
        employee_name: shift.name,
        teamId: shift.teamId ?? null,
      }
    );

    if (!hasPermission) {
      setError(
        `Permission denied: You are signed in as "${currentUser.name}" (${currentUser.role}). You can only delete shifts assigned to your account. Legacy shifts require manager permissions.`
      );
      return;
    }

    setDeletingShift(shift);
  }

  function handleStartSwap(shift: ScheduleShift) {
    setNotice("");
    setError("");

    if (!currentUser) {
      setShowLoginModal(true);
      setNotice("Please sign in to request a shift swap.");
      return;
    }

    const isManager = isManagerRole(currentUser?.role);
    if (!isManager && shift.userId !== currentUser?.id) {
      setError(
        `Permission denied: You are signed in as "${currentUser.name}". You can only request swaps for shifts assigned to your account.`
      );
      return;
    }

    setSwappingShift(shift);

    // Find candidate shifts assigned to other team members in this workspace
    const candidates = schedule.filter(
      (s) =>
        s.id !== shift.id &&
        (shift.userId ? s.userId !== shift.userId : s.name !== shift.name)
    );
    setSwapTargetShiftId(candidates.length > 0 ? candidates[0].id : null);
    setSwapReason("");
  }

  async function handleConfirmSwap(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!swappingShift || !swapTargetShiftId || submittingSwap) return;
    setSubmittingSwap(true);
    setError("");

    try {
      const response = await fetch("/api/shifts/swaps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceShiftId: swappingShift.id,
          targetShiftId: swapTargetShiftId,
          reason: swapReason.trim() || undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to submit shift swap request.");
      }

      setNotice(
        "Shift swap request submitted successfully! Awaiting manager approval."
      );
      setSwappingShift(null);
      setSwapTargetShiftId(null);
      setSwapReason("");
      await loadSwapRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swap request submission failed.");
    } finally {
      setSubmittingSwap(false);
    }
  }

  async function handleApproveSwap(swapId: number) {
    if (actioningSwapId !== null) return;
    setActioningSwapId(swapId);
    setError("");

    // Optimistic Update: snapshot previous state for rollback
    const previousSchedule = [...schedule];
    const previousSwapRequests = [...swapRequests];

    const targetSwap = swapRequests.find((r) => r.id === swapId);
    if (targetSwap) {
      setSwapRequests((prev) =>
        prev.map((r) => (r.id === swapId ? { ...r, status: "approved" as const } : r))
      );

      if (targetSwap.source_shift_id && targetSwap.target_shift_id) {
        const sIdx = schedule.findIndex((s) => s.id === targetSwap.source_shift_id);
        const tIdx = schedule.findIndex((s) => s.id === targetSwap.target_shift_id);
        if (sIdx !== -1 && tIdx !== -1) {
          const updated = [...schedule];
          const tempUser = { name: updated[sIdx].name, role: updated[sIdx].role, userId: updated[sIdx].userId };
          updated[sIdx] = {
            ...updated[sIdx],
            name: updated[tIdx].name,
            role: updated[tIdx].role,
            userId: updated[tIdx].userId,
          };
          updated[tIdx] = {
            ...updated[tIdx],
            name: tempUser.name,
            role: tempUser.role,
            userId: tempUser.userId,
          };
          setSchedule(updated);
        }
      }
    }

    try {
      const response = await fetch(`/api/shifts/swaps/${swapId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: "Approved by manager" }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to approve shift swap.");
      }

      setNotice("Shift swap approved! Both shifts have been updated atomically.");
      await loadShifts();
      await loadSwapRequests();
    } catch (err) {
      // Rollback to prior snapshot
      setSchedule(previousSchedule);
      setSwapRequests(previousSwapRequests);
      setError(err instanceof Error ? err.message : "Could not approve shift swap. Changes reverted.");
    } finally {
      setActioningSwapId(null);
    }
  }

  async function handleRejectSwap(swapId: number, isCancel = false) {
    if (actioningSwapId !== null) return;
    setActioningSwapId(swapId);
    setError("");

    // Optimistic Update: snapshot previous state for rollback
    const previousSwapRequests = [...swapRequests];
    setSwapRequests((prev) =>
      prev.map((r) =>
        r.id === swapId
          ? { ...r, status: isCancel ? ("cancelled" as const) : ("rejected" as const) }
          : r
      )
    );

    try {
      const response = await fetch(`/api/shifts/swaps/${swapId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: isCancel ? "Cancelled by employee" : "Declined by manager",
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.error ||
            (isCancel ? "Failed to cancel swap request." : "Failed to decline swap request.")
        );
      }

      setNotice(isCancel ? "Shift swap request cancelled." : "Shift swap request declined.");
      await loadSwapRequests();
    } catch (err) {
      // Rollback on failure
      setSwapRequests(previousSwapRequests);
      setError(err instanceof Error ? err.message : "Action failed. Reverted changes.");
    } finally {
      setActioningSwapId(null);
    }
  }

  async function handleSaveUserSettings(
    overrideSettings?: Partial<UserSettings>,
    force = false
  ) {
    if (!userSettings || savingSettings) return;
    setSavingSettings(true);
    setError("");

    // Optimistic Update: snapshot previous settings for rollback
    const previousSettings = { ...userSettings };
    const optimistic = {
      ...userSettings,
      ...(overrideSettings || {}),
    };
    setUserSettings(optimistic as UserSettings);
    if (optimistic.theme) applyThemeToDocument(optimistic.theme);
    if (optimistic.language) applyLanguageToDocument(optimistic.language);

    const payload = {
      ...optimistic,
      expectedRevision: userSettings.revision,
      force,
    };

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.status === 409 && data.conflict) {
        // Rollback
        setUserSettings(previousSettings);
        applyThemeToDocument(previousSettings.theme);
        applyLanguageToDocument(previousSettings.language);
        setSettingsConflict(data.serverSettings);
        setError("Settings conflict detected: Another device updated your settings.");
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || "Failed to save settings.");
      }

      const saved = data.settings;
      setUserSettings(saved);
      setSettingsConflict(null);
      if (currentUserRef.current) {
        saveSettingsToOfflineCache(saved, {
          userId: currentUserRef.current.id,
          email: currentUserRef.current.email,
          teamId: currentUserRef.current.teamId,
        });
      }
      applyThemeToDocument(saved.theme);
      applyLanguageToDocument(saved.language);
      setNotificationsEnabled(saved.notifications.enabled);
      setNotificationPreferences({
        userId: saved.userId,
        teamId: saved.teamId,
        enabled: saved.notifications.enabled,
        categories: saved.notifications.categories,
        quietHours: saved.quietHours,
        updatedAt: saved.updatedAt,
      });
      setNotice(`Settings synchronized across your devices (Revision #${saved.revision}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update settings.");
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleReloadServerSettings() {
    if (settingsConflict) {
      setUserSettings(settingsConflict);
      if (currentUserRef.current) {
        saveSettingsToOfflineCache(settingsConflict, {
          userId: currentUserRef.current.id,
          email: currentUserRef.current.email,
          teamId: currentUserRef.current.teamId,
        });
      }
      applyThemeToDocument(settingsConflict.theme);
      applyLanguageToDocument(settingsConflict.language);
      setNotificationsEnabled(settingsConflict.notifications.enabled);
      setNotificationPreferences({
        userId: settingsConflict.userId,
        teamId: settingsConflict.teamId,
        enabled: settingsConflict.notifications.enabled,
        categories: settingsConflict.notifications.categories,
        quietHours: settingsConflict.quietHours,
        updatedAt: settingsConflict.updatedAt,
      });
      setSettingsConflict(null);
      setNotice(`Reloaded latest settings from server (Revision #${settingsConflict.revision}).`);
    } else {
      await loadUserSettings();
    }
  }

  async function handleOverwriteServerSettings() {
    if (!userSettings) return;
    await handleSaveUserSettings(userSettings, true);
  }

  async function handleSaveNotificationPreferences() {
    if (userSettings) {
      await handleSaveUserSettings();
      return;
    }

    if (!notificationPreferences || savingPreferences) return;
    setSavingPreferences(true);
    setError("");

    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notificationPreferences),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save preferences.");
      }

      setNotice("Notification preferences and quiet hours saved.");
      setNotificationPreferences(data.preferences);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update notification preferences.");
    } finally {
      setSavingPreferences(false);
    }
  }

  async function handleNotificationClick(notif: NotificationRecord) {
    setShowNotificationsPanel(false);
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: notif.id }),
      });
      setUserNotifications((curr) =>
        curr.map((n) => (n.id === notif.id ? { ...n, read: true } : n))
      );
      setUnreadNotificationsCount((prev) => Math.max(0, prev - 1));
    } catch {
      // Ignore
    }

    if (notif.deepLink) {
      if (typeof window !== "undefined") {
        window.location.href = notif.deepLink;
      }
    }
  }

  async function handleMarkAllNotificationsRead() {
    try {
      await fetch("/api/notifications", { method: "POST" });
      setUserNotifications((curr) => curr.map((n) => ({ ...n, read: true })));
      setUnreadNotificationsCount(0);
      setNotice("All notifications marked as read.");
    } catch {
      setError("Failed to mark notifications read.");
    }
  }

  function handleInviteMember(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!inviteName.trim() || inviting) return;
    setInviting(true);

    const trimmed = inviteName.trim();
    if (team.some((m) => m.name.toLowerCase() === trimmed.toLowerCase())) {
      setError(`Team member "${trimmed}" is already on this workspace roster.`);
      setInviting(false);
      return;
    }

    setTeam((curr) => [
      ...curr,
      {
        name: trimmed,
        role: inviteRole,
        status: "Upcoming",
        initials: getInitials(trimmed),
      },
    ]);

    setNotice(
      `Invitation sent to ${trimmed} (${inviteRole}). Member added to workspace roster.`
    );
    setShowInviteModal(false);
    setInviteName("");
    setInviting(false);
  }

  async function handleSaveShift(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!currentUser) {
      setShowLoginModal(true);
      return;
    }

    if (!employee.trim() || !day || saving) return;

    setSaving(true);
    setError("");
    setNotice("");

    const isEditing = editingShift !== null;
    const url = isEditing ? `/api/shifts/${editingShift.id}` : "/api/shifts";
    const method = isEditing ? "PUT" : "POST";

    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeName: employee.trim(),
          role,
          shiftDay: day,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || `Unable to ${isEditing ? "update" : "create"} shift.`);
      }

      if (isEditing) {
        const updatedShift = mapApiShift(result as ApiShift, schedule.findIndex((s) => s.id === editingShift.id));

        setSchedule((current) =>
          current
            .map((s) => (s.id === updatedShift.id ? updatedShift : s))
            .sort((a, b) => a.shiftDay.localeCompare(b.shiftDay) || a.id - b.id)
        );

        setNotice(`Shift updated successfully for ${employee.trim()} on ${day}.`);
      } else {
        const newShift = mapApiShift(result as ApiShift, schedule.length);

        setSchedule((current) =>
          [...current, newShift].sort((a, b) =>
            a.shiftDay.localeCompare(b.shiftDay) || a.id - b.id
          )
        );

        setTeam((current) =>
          current.some((member) => member.name === employee.trim())
            ? current
            : [
                ...current,
                {
                  name: employee.trim(),
                  role,
                  status: "Upcoming",
                  initials: getInitials(employee),
                },
              ]
        );

        setNotice(`Shift created successfully for ${employee.trim()} on ${day}.`);
      }

      setShowForm(false);
      setEditingShift(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save shift.");
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deletingShift || deleting) return;

    if (!currentUser) {
      setShowLoginModal(true);
      return;
    }

    setDeleting(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/shifts/${deletingShift.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to delete shift.");
      }

      // Update state only after successful API confirmation
      setSchedule((current) =>
        current.filter((s) => s.id !== deletingShift.id)
      );

      setNotice(
        `Shift for ${deletingShift.name} on ${deletingShift.shiftDay} has been permanently removed.`
      );
      setDeletingShift(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete shift.");
    } finally {
      setDeleting(false);
    }
  }

  const visibleSchedule =
    activeTab === "Schedule" ? schedule : schedule.slice(0, 6);

  const isManager = isManagerRole(currentUser?.role);

  return (
    <main className="min-h-screen bg-[#f7f8f5] text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1440px]">
        {/* Desktop Sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white p-6 md:flex">
          <div className="mb-10 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lime-300 text-xl font-black text-slate-950 shadow-2xs">
              R
            </div>
            <div>
              <p className="text-xl font-bold tracking-tight text-slate-950">
                rota<span className="text-lime-600">.</span>
              </p>
              <p className="text-[11px] font-semibold tracking-wider text-slate-400">TEAM SCHEDULING</p>
            </div>
          </div>

          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
            Workspace
          </p>
          <nav className="space-y-1.5">
            {[
              { name: "Overview", icon: "◫" },
              { name: "Schedule", icon: "▦" },
              { name: "Activity", icon: "📋" },
              { name: "Team", icon: "♙" },
              { name: "Settings", icon: "⚙" },
            ].map((tab) => (
              <button
                key={tab.name}
                onClick={() => {
                  setActiveTab(tab.name);
                  setError("");
                  setNotice("");
                }}
                className={`w-full rounded-xl px-4 py-3 text-left text-sm font-medium transition flex items-center justify-between ${
                  activeTab === tab.name
                    ? "bg-lime-200 text-slate-950 font-bold shadow-2xs"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                <span className="flex items-center gap-3">
                  <span className="text-base select-none">{tab.icon}</span>
                  <span>{tab.name}</span>
                </span>
                {tab.name === "Schedule" && schedule.length > 0 && (
                  <span className="rounded-full bg-slate-900/10 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                    {schedule.length}
                  </span>
                )}
                {tab.name === "Team" && team.length > 0 && (
                  <span className="rounded-full bg-slate-900/10 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                    {team.length}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="mt-auto rounded-2xl bg-slate-900 p-4 text-white shadow-sm">
            <p className="text-sm font-semibold">A better way to plan.</p>
            <p className="mt-1.5 text-xs leading-5 text-slate-300">
              Keep shifts clear, teams aligned, and every week organized.
            </p>
            <div className="mt-3.5 h-1.5 rounded-full bg-slate-800">
              <div
                className={`h-1.5 rounded-full transition-all duration-500 ${
                  currentUser ? "w-full bg-lime-300" : "w-1/3 bg-amber-400"
                }`}
              />
            </div>
            <div className="mt-2.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 rounded-full ${
                    currentUser ? "bg-lime-400 animate-pulse" : "bg-amber-400"
                  }`}
                />
                <span className="text-[11px] text-slate-300 truncate max-w-[120px]">
                  {currentUser ? currentUser.name : "Signed out"}
                </span>
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {currentUser ? currentUser.role : "Read-only"}
              </span>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <section className="min-w-0 flex-1 flex flex-col">
          {/* Mobile Top Brand Bar */}
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3 md:hidden">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-lime-300 text-base font-black text-slate-950 shadow-2xs">
                R
              </div>
              <span className="text-lg font-bold tracking-tight text-slate-950">
                rota<span className="text-lime-600">.</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              {currentUser ? (
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                    {getInitials(currentUser.name)}
                  </div>
                  <button
                    onClick={() => handleLogout(false)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowLoginModal(true)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-800"
                >
                  Sign in
                </button>
              )}
            </div>
          </div>

          {/* Mobile Tab Navigation Strip */}
          <div className="flex overflow-x-auto border-b border-slate-200 bg-white px-4 py-2 md:hidden gap-1.5">
            {[
              { name: "Overview", icon: "◫" },
              { name: "Schedule", icon: "▦" },
              { name: "Activity", icon: "📋" },
              { name: "Team", icon: "♙" },
              { name: "Settings", icon: "⚙" },
            ].map((tab) => (
              <button
                key={tab.name}
                onClick={() => {
                  setActiveTab(tab.name);
                  setError("");
                  setNotice("");
                }}
                className={`shrink-0 rounded-xl px-3.5 py-2 text-xs font-medium transition flex items-center gap-1.5 ${
                  activeTab === tab.name
                    ? "bg-lime-200 text-slate-950 font-bold shadow-2xs"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                <span>{tab.icon}</span>
                <span>{tab.name}</span>
              </button>
            ))}
          </div>

          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-5 sm:px-8">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                WORKSPACE / ROTA
              </p>
              <h1 className="mt-1 text-xl font-bold sm:text-2xl text-slate-900">{activeTab}</h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Authenticated user status or sign-in trigger */}
              {authLoading ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  Checking session…
                </div>
              ) : currentUser ? (
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                    {getInitials(currentUser.name)}
                  </div>
                  <div>
                    <p className="font-bold text-slate-900">{currentUser.name}</p>
                    <p className="text-[10px] font-semibold text-lime-700">
                      {currentUser.role}
                    </p>
                  </div>
                  <button
                    onClick={() => handleLogout(false)}
                    className="ml-2 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowLoginModal(true)}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-800 transition hover:bg-slate-50 shadow-sm"
                >
                  🔐 Sign in
                </button>
              )}

              {currentUser && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowNotificationsPanel(!showNotificationsPanel)}
                    className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition shadow-xs"
                    aria-label="View notifications"
                  >
                    <span className="text-base select-none">🔔</span>
                    {unreadNotificationsCount > 0 && (
                      <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-600 text-[9px] font-bold text-white animate-pulse">
                        {unreadNotificationsCount > 9 ? "9+" : unreadNotificationsCount}
                      </span>
                    )}
                  </button>

                  {/* Notifications Popover Dropdown */}
                  {showNotificationsPanel && (
                    <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl z-50">
                      <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-slate-900">Notifications</span>
                          {unreadNotificationsCount > 0 && (
                            <span className="rounded-full bg-lime-100 px-2 py-0.5 text-[10px] font-bold text-lime-800">
                              {unreadNotificationsCount} new
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {unreadNotificationsCount > 0 && (
                            <button
                              type="button"
                              onClick={handleMarkAllNotificationsRead}
                              className="text-[11px] text-slate-500 hover:text-slate-900 underline"
                            >
                              Mark read
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setShowNotificationsPanel(false)}
                            className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
                            aria-label="Close"
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      <div className="mt-2 max-h-72 overflow-y-auto space-y-2">
                        {userNotifications.length > 0 ? (
                          userNotifications.map((n) => (
                            <div
                              key={n.id}
                              onClick={() => handleNotificationClick(n)}
                              className={`cursor-pointer rounded-xl p-3 text-xs transition border ${
                                n.read
                                  ? "border-slate-100 bg-white hover:bg-slate-50"
                                  : "border-lime-200 bg-lime-50/70 hover:bg-lime-50"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <p className="font-bold text-slate-900">{n.title}</p>
                                <span className="text-[10px] text-slate-400 shrink-0">
                                  {n.createdAt ? new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ""}
                                </span>
                              </div>
                              <p className="mt-1 text-slate-600">{n.body}</p>
                            </div>
                          ))
                        ) : (
                          <p className="py-6 text-center text-xs text-slate-400">
                            No notifications yet for this workspace.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={handleOpenAdd}
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
              >
                + Add shift
              </button>
            </div>
          </header>

          <div className="p-5 sm:p-8">
            {/* Feedback Notices */}
            {notice && (
              <div className="mb-6 flex items-center justify-between rounded-2xl border border-lime-200 bg-lime-50 p-4 text-sm text-lime-900">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-lime-700">✓</span>
                  <span>{notice}</span>
                </div>
                <button
                  onClick={() => setNotice("")}
                  className="text-xs font-bold text-lime-700 hover:text-lime-900 ml-4"
                >
                  Dismiss
                </button>
              </div>
            )}

            {error && (
              <div className="mb-6 flex items-center justify-between rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-rose-700">⚠</span>
                  <span>{error}</span>
                </div>
                <button
                  onClick={() => setError("")}
                  className="text-xs font-bold text-rose-700 hover:text-rose-900 ml-4"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Legacy Shift Recovery Banner */}
            {currentUser && recoverableShifts.length > 0 && (
              <div className="mb-6 rounded-2xl border border-indigo-200 bg-gradient-to-r from-indigo-50/90 via-sky-50/70 to-indigo-50/90 p-5 shadow-xs">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-lg text-white shadow-xs">
                      📦
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-indigo-950">
                          Legacy Shifts Pending Recovery
                        </h3>
                        <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-bold text-indigo-800">
                          {recoverableShifts.length} {recoverableShifts.length === 1 ? "shift" : "shifts"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-indigo-900/80 leading-relaxed max-w-2xl">
                        You have {recoverableShifts.length} historical shift{recoverableShifts.length === 1 ? "" : "s"} linked to your account from before team isolation was established. Recover them to bring them into your active team schedule.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleOpenRecoveryModal}
                    className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-xs transition hover:bg-indigo-500"
                  >
                    Recover Shifts →
                  </button>
                </div>
              </div>
            )}

            {/* Overview Stats */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <article className="rounded-2xl border border-slate-200 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-xs">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Total shifts
                </p>
                <p className="mt-2 text-3xl font-extrabold text-slate-900 tracking-tight">
                  {shiftLoadStatus === "unauthenticated" ? "—" : schedule.length}
                </p>
                <p className="mt-1 text-xs text-slate-500 font-medium">
                  {shiftLoadStatus === "unauthenticated"
                    ? "Sign in to view"
                    : "Live database records"}
                </p>
              </article>

              <article className="rounded-2xl border border-slate-200 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-xs">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Team on shift
                </p>
                <p className="mt-2 text-3xl font-extrabold text-slate-900 tracking-tight">
                  {team.filter((m) => m.status === "On shift").length}
                </p>
                <p className="mt-1 text-xs text-emerald-600 font-medium">Currently active</p>
              </article>

              <article className="rounded-2xl border border-slate-200 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-xs">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Assigned members
                </p>
                <p className="mt-2 text-3xl font-extrabold text-slate-900 tracking-tight">{team.length}</p>
                <p className="mt-1 text-xs text-slate-500 font-medium">Workspace roster</p>
              </article>

              <article className="rounded-2xl border border-slate-200 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-xs">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Account Status
                </p>
                <p className="mt-2 text-xl font-bold text-slate-900 truncate">
                  {authLoading ? (
                    <span className="text-slate-400 font-normal text-sm">Checking…</span>
                  ) : currentUser ? (
                    currentUser.role
                  ) : (
                    "Signed Out"
                  )}
                </p>
                <p className="mt-1 text-xs text-slate-500 truncate font-medium">
                  {authLoading ? (
                    "Verifying session status…"
                  ) : currentUser ? (
                    `Authenticated as ${currentUser.name}`
                  ) : (
                    "Sign in required to view shifts"
                  )}
                </p>
              </article>
            </div>

            {/* Team tab */}
            {activeTab === "Team" && (
              <div className="mt-8 space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Your workspace</p>
                    <h2 className="mt-1 text-2xl font-bold text-slate-900">Workspace Team Members</h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Active roster members with designated roles and live shift availability.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowInviteModal(true)}
                    className="rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-slate-800 transition flex items-center gap-1.5"
                  >
                    <span>+</span>
                    <span>Invite Member</span>
                  </button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {team.map((member) => (
                    <article
                      key={member.name}
                      className="rounded-2xl border border-slate-200 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-sm flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center gap-3.5">
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-lime-100 font-bold text-slate-800 text-sm shrink-0">
                            {member.initials}
                          </div>
                          <div>
                            <h3 className="font-semibold text-slate-900">{member.name}</h3>
                            <p className="text-xs text-slate-500 mt-0.5">{member.role}</p>
                          </div>
                        </div>
                        <div className="my-4 h-px bg-slate-100" />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-400 font-medium">Availability</span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            member.status === "On shift"
                              ? "bg-emerald-100 text-emerald-800"
                              : member.status === "Upcoming"
                              ? "bg-blue-100 text-blue-800"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {member.status}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}

            {/* Settings tab */}
            {activeTab === "Settings" && (
              <div className="mt-8 space-y-6">
                <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xs">
                  <h2 className="text-lg font-bold text-slate-900 mb-1">
                    Workspace & User Settings
                  </h2>
                  <p className="text-sm text-slate-500 mb-6">
                    Manage your account details, workspace role permissions, and session preferences.
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-5">
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
                        Authenticated Profile
                      </p>
                      {currentUser ? (
                        <div className="space-y-2 text-sm">
                          <p>
                            <span className="text-slate-500">Name:</span>{" "}
                            <strong className="text-slate-900">{currentUser.name}</strong>
                          </p>
                          <p>
                            <span className="text-slate-500">Email:</span>{" "}
                            <strong className="text-slate-900">{currentUser.email}</strong>
                          </p>
                          <p>
                            <span className="text-slate-500">Assigned Role:</span>{" "}
                            <span className="rounded-md bg-lime-100 px-2 py-0.5 text-xs font-bold text-lime-800">
                              {currentUser.role}
                            </span>
                          </p>
                          <p>
                            <span className="text-slate-500">User ID:</span>{" "}
                            <code className="text-xs bg-slate-200 px-1.5 py-0.5 rounded font-mono">
                              #{currentUser.id}
                            </code>
                          </p>
                        </div>
                      ) : (
                        <p className="text-xs text-slate-500">
                          Not signed in. Sign in to view and manage your profile settings.
                        </p>
                      )}
                    </div>

                    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-5">
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
                        Workspace Security & Multi-Tenancy
                      </p>
                      <div className="space-y-2 text-sm text-slate-700">
                        <p>
                          <span className="text-slate-500">Workspace:</span>{" "}
                          <strong>Operations Rota</strong>
                        </p>
                        <p>
                          <span className="text-slate-500">Tenant ID:</span>{" "}
                          <span className="font-mono text-xs">
                            {currentUser?.teamId ?? "team-alpha (default)"}
                          </span>
                        </p>
                        <p>
                          <span className="text-slate-500">Session Security:</span>{" "}
                          <span className="text-xs font-semibold text-emerald-700">
                            HMAC-SHA256 Encrypted HttpOnly
                          </span>
                        </p>
                        <p>
                          <span className="text-slate-500">Database Role Revalidation:</span>{" "}
                          <span className="text-xs text-slate-600">Active per request</span>
                        </p>
                      </div>
                    </div>
                  </div>

                  {currentUser && (
                    <div className="mt-6">
                      <GoogleAccountSettings
                        googleLinked={Boolean(currentUser.googleLinked)}
                        hasPassword={Boolean(currentUser.hasPassword)}
                        onStatusChange={async () => {
                          await checkSession();
                        }}
                      />
                    </div>
                  )}

                  <div className="mt-6 border-t border-slate-100 pt-6">
                    <h3 className="text-sm font-bold text-slate-900 mb-3">
                      Role-Based Access Permissions
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      <div className="flex items-center gap-2 text-slate-700">
                        <span className="text-emerald-600 font-bold">✓</span>
                        View workspace shift calendar
                      </div>
                      <div className="flex items-center gap-2 text-slate-700">
                        <span className="text-emerald-600 font-bold">✓</span>
                        Schedule shifts assigned to own account
                      </div>
                      <div className="flex items-center gap-2 text-slate-700">
                        <span className="text-emerald-600 font-bold">✓</span>
                        Request shift swaps with colleagues
                      </div>
                      <div className="flex items-center gap-2 text-slate-700">
                        {isManager ? (
                          <>
                            <span className="text-emerald-600 font-bold">✓</span>
                            <span>Manage and reassign all team shifts (Manager authorized)</span>
                          </>
                        ) : (
                          <>
                            <span className="text-slate-400 font-bold">✕</span>
                            <span className="text-slate-400">Manage colleague shifts (Manager role required)</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 border-t border-slate-100 pt-6">
                    <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">
                          Workspace Subscription &amp; Billing
                        </h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Manage workspace seat capacity and billing tiers powered by Paystack test-mode integration.
                        </p>
                      </div>
                      {currentUser && isManager && (
                        <button
                          type="button"
                          onClick={() => {
                            setBillingError("");
                            setShowBillingModal(true);
                            loadBillingStatus();
                          }}
                          className="rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition shadow-xs"
                        >
                          Change Plan
                        </button>
                      )}
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                      <div className="flex items-center justify-between">
                        <span>Current Tier:</span>
                        <span className="font-bold uppercase tracking-wider text-slate-900 bg-white border border-slate-200 px-2.5 py-0.5 rounded-md">
                          {subscriptionPlan} Plan
                        </span>
                      </div>
                      <div className="mt-2.5 flex items-center justify-between">
                        <span>Seat Capacity:</span>
                        <span className="font-semibold text-slate-800">
                          {team.length} / {subscriptionSeats} seats allocated
                        </span>
                      </div>
                      <div className="mt-2.5 text-[11px] text-slate-500 border-t border-slate-200 pt-2 flex items-center justify-between">
                        <span>Payment Gateway:</span>
                        <span className="font-medium text-slate-700">
                          Paystack Test Mode (Configured)
                        </span>
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between">
                        <span>Server-Side Payment Verification:</span>
                        {(() => {
                          const badge = resolveBillingVerificationBadge({
                            planId: subscriptionPlan,
                            paymentProvider,
                            subscriptionStatus,
                            ledger: billingLedger,
                          });
                          return (
                            <span className={badge.className}>
                              {badge.text}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 border-t border-slate-100 pt-6">
                    <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">
                          Legacy Shift Recovery & Data Integrity
                        </h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Pre-migration shifts without team assignment are securely quarantined until recovered into an authorized workspace.
                        </p>
                      </div>
                      {currentUser && recoverableShifts.length > 0 ? (
                        <button
                          type="button"
                          onClick={handleOpenRecoveryModal}
                          className="rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition shadow-xs"
                        >
                          Recover {recoverableShifts.length} Shift{recoverableShifts.length === 1 ? "" : "s"}
                        </button>
                      ) : (
                        <span className="rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                          ✓ Fully Recovered
                        </span>
                      )}
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                      <div className="flex items-center justify-between">
                        <span>Your unassigned legacy shifts:</span>
                        <span className="font-bold font-mono text-slate-900">
                          {currentUser ? `${recoverableShifts.length} pending` : "Sign in to check"}
                        </span>
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500 border-t border-slate-200 pt-2">
                        Note: Unowned orphan shifts (where no user account was linked) remain archived in the database and require verified administrator review.
                      </div>
                    </div>
                  </div>

                  {/* Settings Conflict Banner */}
                  {settingsConflict && (
                    <div className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950 shadow-xs">
                      <div className="flex items-start gap-3">
                        <span className="text-xl">⚠️</span>
                        <div className="flex-1">
                          <h4 className="text-sm font-bold">Settings Conflict Detected</h4>
                          <p className="mt-1 text-xs text-amber-800">
                            Another device has modified your settings (Server Revision #{settingsConflict.revision} vs Local Revision #{userSettings?.revision ?? 1}). Choose how you want to resolve this conflict:
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={handleReloadServerSettings}
                              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 transition"
                            >
                              Reload Server Settings (Rev #{settingsConflict.revision})
                            </button>
                            <button
                              type="button"
                              onClick={handleOverwriteServerSettings}
                              disabled={savingSettings}
                              className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 transition"
                            >
                              {savingSettings ? "Saving…" : "Overwrite with Local Changes (Force)"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Appearance & Regional Preferences */}
                  <div className="mt-6 border-t border-slate-100 pt-6">
                    <div className="rounded-xl border border-slate-200 bg-white p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-sm font-bold text-slate-900">
                            Appearance &amp; Regional Settings
                          </h3>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Customize your interface theme, preferred display language, and active timezone.
                          </p>
                        </div>
                        {currentUser && (
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-mono text-slate-500 bg-slate-100 px-2 py-1 rounded-md">
                              Revision #{userSettings?.revision ?? 1}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleSaveUserSettings()}
                              disabled={savingSettings}
                              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition shadow-xs"
                            >
                              {savingSettings ? "Saving…" : "Save Settings"}
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                        {/* Theme */}
                        <div>
                          <label className="block font-semibold text-slate-800 mb-1.5">
                            Color Theme
                          </label>
                          <div className="grid grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
                            {(["system", "light", "dark"] as const).map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => {
                                  if (userSettings) {
                                    const next = { ...userSettings, theme: t };
                                    setUserSettings(next);
                                    applyThemeToDocument(t);
                                  }
                                }}
                                className={`rounded-lg py-1.5 text-center font-medium capitalize transition ${
                                  (userSettings?.theme || "system") === t
                                    ? "bg-white text-slate-900 font-bold shadow-2xs"
                                    : "text-slate-600 hover:text-slate-900"
                                }`}
                              >
                                {t === "system" ? "💻 Auto" : t === "light" ? "☀️ Light" : "🌙 Dark"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Language */}
                        <div>
                          <label htmlFor="settings-language" className="block font-semibold text-slate-800 mb-1.5">
                            Display Language
                          </label>
                          <select
                            id="settings-language"
                            value={userSettings?.language || "en"}
                            onChange={(e) => {
                              const lang = e.target.value;
                              if (userSettings) {
                                setUserSettings({ ...userSettings, language: lang });
                                applyLanguageToDocument(lang);
                              }
                            }}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 focus:border-slate-900"
                          >
                            {SUPPORTED_LANGUAGES.map((l) => (
                              <option key={l.code} value={l.code}>
                                {l.name} ({l.code})
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Timezone */}
                        <div>
                          <label htmlFor="settings-timezone" className="block font-semibold text-slate-800 mb-1.5">
                            Workspace Timezone
                          </label>
                          <select
                            id="settings-timezone"
                            value={userSettings?.timezone || "UTC"}
                            onChange={(e) => {
                              const tz = e.target.value;
                              if (userSettings) {
                                setUserSettings({
                                  ...userSettings,
                                  timezone: tz,
                                  quietHours: { ...userSettings.quietHours, timezone: tz },
                                });
                              }
                            }}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 focus:border-slate-900"
                          >
                            {[
                              "UTC",
                              "Africa/Lagos",
                              "Europe/London",
                              "America/New_York",
                              "America/Chicago",
                              "America/Denver",
                              "America/Los_Angeles",
                              "Asia/Tokyo",
                              "Asia/Dubai",
                              "Australia/Sydney",
                            ].map((tz) => (
                              <option key={tz} value={tz}>
                                {tz}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Notification Preferences & Quiet Hours */}
                  <div className="mt-6 border-t border-slate-100 pt-6">
                    <div className="rounded-xl border border-slate-200 bg-white p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-sm font-bold text-slate-900">
                            Notification Preferences &amp; Quiet Hours
                          </h3>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Customize alerts for shift assignments, updates, swaps, and mute notifications during quiet hours.
                          </p>
                        </div>
                        {currentUser && (
                          <button
                            type="button"
                            onClick={() => handleSaveUserSettings()}
                            disabled={savingSettings}
                            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition shadow-xs"
                          >
                            {savingSettings ? "Saving…" : "Save All Settings"}
                          </button>
                        )}
                      </div>

                      <div className="space-y-4 text-xs">
                        {/* Master Toggle */}
                        <div className="flex items-center gap-3">
                          <input
                            id="notifications-toggle"
                            type="checkbox"
                            checked={userSettings?.notifications?.enabled ?? notificationsEnabled}
                            onChange={(e) => {
                              const next = e.target.checked;
                              setNotificationsEnabled(next);
                              if (userSettings) {
                                setUserSettings({
                                  ...userSettings,
                                  notifications: { ...userSettings.notifications, enabled: next },
                                });
                              }
                              if (notificationPreferences) {
                                setNotificationPreferences({ ...notificationPreferences, enabled: next });
                              }
                            }}
                            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                          />
                          <label htmlFor="notifications-toggle" className="font-semibold text-slate-800">
                            Enable In-App &amp; Web Push Notifications
                          </label>
                        </div>

                        {/* Category Toggles */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pl-7 border-l-2 border-slate-100">
                          <label className="flex items-center gap-2 text-slate-700">
                            <input
                              type="checkbox"
                              checked={userSettings?.notifications?.categories?.shift_assigned ?? notificationPreferences?.categories?.shift_assigned ?? true}
                              onChange={(e) => {
                                const next = e.target.checked;
                                if (userSettings) {
                                  setUserSettings({
                                    ...userSettings,
                                    notifications: {
                                      ...userSettings.notifications,
                                      categories: { ...userSettings.notifications.categories, shift_assigned: next },
                                    },
                                  });
                                }
                                if (notificationPreferences) {
                                  setNotificationPreferences({
                                    ...notificationPreferences,
                                    categories: { ...notificationPreferences.categories, shift_assigned: next },
                                  });
                                }
                              }}
                              className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
                            />
                            New shift assignments
                          </label>

                          <label className="flex items-center gap-2 text-slate-700">
                            <input
                              type="checkbox"
                              checked={userSettings?.notifications?.categories?.shift_updated ?? notificationPreferences?.categories?.shift_updated ?? true}
                              onChange={(e) => {
                                const next = e.target.checked;
                                if (userSettings) {
                                  setUserSettings({
                                    ...userSettings,
                                    notifications: {
                                      ...userSettings.notifications,
                                      categories: { ...userSettings.notifications.categories, shift_updated: next },
                                    },
                                  });
                                }
                                if (notificationPreferences) {
                                  setNotificationPreferences({
                                    ...notificationPreferences,
                                    categories: { ...notificationPreferences.categories, shift_updated: next },
                                  });
                                }
                              }}
                              className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
                            />
                            Shift schedule updates
                          </label>

                          <label className="flex items-center gap-2 text-slate-700">
                            <input
                              type="checkbox"
                              checked={userSettings?.notifications?.categories?.swap_requested ?? notificationPreferences?.categories?.swap_requested ?? true}
                              onChange={(e) => {
                                const next = e.target.checked;
                                if (userSettings) {
                                  setUserSettings({
                                    ...userSettings,
                                    notifications: {
                                      ...userSettings.notifications,
                                      categories: { ...userSettings.notifications.categories, swap_requested: next },
                                    },
                                  });
                                }
                                if (notificationPreferences) {
                                  setNotificationPreferences({
                                    ...notificationPreferences,
                                    categories: { ...notificationPreferences.categories, swap_requested: next },
                                  });
                                }
                              }}
                              className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
                            />
                            Shift swap requests
                          </label>

                          <label className="flex items-center gap-2 text-slate-700">
                            <input
                              type="checkbox"
                              checked={userSettings?.notifications?.categories?.swap_approved ?? notificationPreferences?.categories?.swap_approved ?? true}
                              onChange={(e) => {
                                const next = e.target.checked;
                                if (userSettings) {
                                  setUserSettings({
                                    ...userSettings,
                                    notifications: {
                                      ...userSettings.notifications,
                                      categories: { ...userSettings.notifications.categories, swap_approved: next },
                                    },
                                  });
                                }
                                if (notificationPreferences) {
                                  setNotificationPreferences({
                                    ...notificationPreferences,
                                    categories: { ...notificationPreferences.categories, swap_approved: next },
                                  });
                                }
                              }}
                              className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
                            />
                            Swap approvals &amp; decisions
                          </label>
                        </div>

                        {/* Quiet Hours */}
                        <div className="pt-3 border-t border-slate-100 space-y-3">
                          <label className="flex items-center gap-2 font-semibold text-slate-800">
                            <input
                              type="checkbox"
                              checked={userSettings?.quietHours?.enabled ?? notificationPreferences?.quietHours?.enabled ?? false}
                              onChange={(e) => {
                                const next = e.target.checked;
                                if (userSettings) {
                                  setUserSettings({
                                    ...userSettings,
                                    quietHours: { ...userSettings.quietHours, enabled: next },
                                  });
                                }
                                if (notificationPreferences) {
                                  setNotificationPreferences({
                                    ...notificationPreferences,
                                    quietHours: { ...notificationPreferences.quietHours, enabled: next },
                                  });
                                }
                              }}
                              className="h-4 w-4 rounded border-slate-300 text-slate-900"
                            />
                            Quiet Hours (Mute delivery during rest hours)
                          </label>

                          {(userSettings?.quietHours?.enabled ?? notificationPreferences?.quietHours?.enabled) && (
                            <div className="flex flex-wrap items-center gap-4 pl-6 text-slate-600">
                              <div className="flex items-center gap-2">
                                <span>From:</span>
                                <input
                                  type="time"
                                  value={userSettings?.quietHours?.start || notificationPreferences?.quietHours?.start || "22:00"}
                                  onChange={(e) => {
                                    const next = e.target.value;
                                    if (userSettings) {
                                      setUserSettings({
                                        ...userSettings,
                                        quietHours: { ...userSettings.quietHours, start: next },
                                      });
                                    }
                                    if (notificationPreferences) {
                                      setNotificationPreferences({
                                        ...notificationPreferences,
                                        quietHours: { ...notificationPreferences.quietHours, start: next },
                                      });
                                    }
                                  }}
                                  className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <span>To:</span>
                                <input
                                  type="time"
                                  value={userSettings?.quietHours?.end || notificationPreferences?.quietHours?.end || "08:00"}
                                  onChange={(e) => {
                                    const next = e.target.value;
                                    if (userSettings) {
                                      setUserSettings({
                                        ...userSettings,
                                        quietHours: { ...userSettings.quietHours, end: next },
                                      });
                                    }
                                    if (notificationPreferences) {
                                      setNotificationPreferences({
                                        ...notificationPreferences,
                                        quietHours: { ...notificationPreferences.quietHours, end: next },
                                      });
                                    }
                                  }}
                                  className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <span>Timezone:</span>
                                <span className="font-mono text-slate-800 bg-slate-100 px-2 py-0.5 rounded">
                                  {userSettings?.quietHours?.timezone || notificationPreferences?.quietHours?.timezone || "UTC"}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                    <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
                      {currentUser && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleLogout(false)}
                            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
                          >
                            Sign Out (This Device)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleLogout(true)}
                            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 transition"
                          >
                            Sign Out of All Devices
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

            {/* Activity tab */}
            {activeTab === "Activity" && (
              <div className="mt-8 space-y-6">
                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
                  <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-100">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">Workspace Activity Feed</h2>
                      <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
                        Real-time audit timeline of scheduling events, shift swaps, and team changes.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => loadActivityFirstPage(true)}
                      disabled={activityLoading || activityRefreshing}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition disabled:opacity-50"
                    >
                      <span className={activityRefreshing ? "animate-spin" : ""}>↻</span>
                      {activityRefreshing ? "Refreshing…" : "Refresh Feed"}
                    </button>
                  </div>

                  {/* Error State with Retry Button */}
                  {activityError && (
                    <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800 flex items-center justify-between gap-3">
                      <div>
                        <p className="font-bold">Error loading activity feed</p>
                        <p className="mt-0.5 text-rose-600">{activityError}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          activityEvents.length === 0
                            ? loadActivityFirstPage(false)
                            : loadActivityNextPage()
                        }
                        className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800 transition"
                      >
                        ↺ Retry
                      </button>
                    </div>
                  )}

                  {/* Initial Loading Skeleton State */}
                  {activityLoading && (
                    <div className="mt-6 space-y-4 animate-pulse" aria-label="Loading activity feed">
                      {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="flex items-start gap-4 rounded-xl border border-slate-100 p-4">
                          <div className="h-10 w-10 rounded-full bg-slate-200 shrink-0"></div>
                          <div className="flex-1 space-y-2">
                            <div className="h-4 w-1/3 bg-slate-200 rounded"></div>
                            <div className="h-3.5 w-3/4 bg-slate-100 rounded"></div>
                            <div className="h-3 w-1/4 bg-slate-100 rounded"></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Empty State */}
                  {!activityLoading && activityEvents.length === 0 && !activityError && (
                    <div className="mt-8 text-center py-12 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-6">
                      <div className="text-3xl select-none mb-2">📋</div>
                      <h3 className="text-sm font-bold text-slate-800">No activity recorded yet</h3>
                      <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
                        When shifts are created, modified, or swapped, audit events will appear here in chronological order.
                      </p>
                      <button
                        type="button"
                        onClick={() => loadActivityFirstPage(true)}
                        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        ↻ Check for updates
                      </button>
                    </div>
                  )}

                  {/* Activity Events List */}
                  {!activityLoading && activityEvents.length > 0 && (
                    <div className="mt-6 space-y-3">
                      {activityEvents.map((evt) => {
                        const isShift = evt.action.startsWith("shift_");
                        const isSwap = evt.action.startsWith("swap_");
                        const isDelete = evt.action === "shift_deleted" || evt.action === "swap_rejected";
                        const isApproved = evt.action === "swap_approved";
                        const icon = isDelete ? "🗑️" : isApproved ? "✓" : isSwap ? "🔄" : isShift ? "📅" : "📋";
                        const badgeColor = isDelete
                          ? "bg-rose-50 text-rose-700 border-rose-200"
                          : isApproved
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : isSwap
                          ? "bg-amber-50 text-amber-700 border-amber-200"
                          : "bg-blue-50 text-blue-700 border-blue-200";

                        return (
                          <div
                            key={evt.id}
                            className="flex items-start justify-between gap-4 rounded-xl border border-slate-100 bg-white p-4 shadow-2xs hover:border-slate-200 transition"
                          >
                            <div className="flex items-start gap-3.5">
                              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-sm shrink-0 select-none">
                                {icon}
                              </div>
                              <div>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-bold text-xs text-slate-900">{evt.actor_name}</span>
                                  <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badgeColor}`}>
                                    {evt.action.replace("_", " ")}
                                  </span>
                                </div>
                                <p className="text-xs text-slate-700 mt-1 leading-relaxed">{evt.description}</p>
                                <p className="text-[11px] text-slate-400 mt-1">
                                  {new Date(evt.created_at).toLocaleString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                  })}
                                </p>
                              </div>
                            </div>
                            {evt.entity_id && (
                              <span className="shrink-0 text-[10px] font-mono text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-200/60">
                                #{evt.entity_id}
                              </span>
                            )}
                          </div>
                        );
                      })}

                      {/* Infinite Scroll Sentinel and Load More Footer */}
                      <div ref={activitySentinelRef} className="pt-4 flex flex-col items-center justify-center">
                        {activityLoadingMore && (
                          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 py-3">
                            <span className="animate-spin text-sm">↻</span> Loading older activities…
                          </div>
                        )}

                        {!activityLoadingMore && activityHasMore && (
                          <button
                            type="button"
                            onClick={loadActivityNextPage}
                            className="rounded-xl border border-slate-300 bg-white px-5 py-2 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition"
                          >
                            Load More Activities ↓
                          </button>
                        )}

                        {!activityHasMore && activityEvents.length > 0 && (
                          <p className="text-xs text-slate-400 py-2">
                            ✓ You have reached the end of the activity history.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Schedule & Overview tab */}
            {activeTab !== "Team" && activeTab !== "Settings" && activeTab !== "Activity" && (
              <>
                {/* Offline Resilience Warning Banner */}
                {isOfflineSchedule && (
                  <div className="mt-8 rounded-2xl border border-amber-300 bg-amber-50/90 p-4.5 shadow-xs">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-3 w-3 relative shrink-0">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
                        </span>
                        <div>
                          <p className="text-xs font-bold uppercase tracking-wider text-amber-950">Offline Resilience Active</p>
                          <p className="text-xs font-medium text-amber-800 mt-0.5">
                            Displaying cached schedule from local storage. Schedule edits will synchronize automatically when your connection is restored.
                          </p>
                        </div>
                      </div>
                      {offlineTimestamp && (
                        <div className="rounded-xl border border-amber-200/80 bg-white/80 px-3 py-1.5 text-xs font-semibold text-amber-900 shadow-2xs">
                          Last updated:{" "}
                          <span className="font-mono text-amber-950">
                            {new Date(offlineTimestamp).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Pending Shift Swap Requests */}
                {swapRequests.length > 0 && (
                  <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50/80 p-5 shadow-xs">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-base select-none">🔄</span>
                        <h3 className="text-sm font-bold text-amber-950">
                          Shift Coverage & Swap Requests ({swapRequests.filter((r) => r.status === "pending").length} Pending)
                        </h3>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {swapRequests.map((req) => (
                        <div
                          key={req.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200/70 bg-white p-3.5 text-xs text-slate-800 shadow-2xs"
                        >
                          <div>
                            <p className="font-semibold text-slate-900">
                              {req.requester_name || `Employee #${req.requester_user_id}`}{" "}
                              <span className="font-normal text-slate-500">requested swap with</span>{" "}
                              {req.target_employee_name || `Employee #${req.target_user_id}`}
                            </p>
                            <p className="text-slate-500 mt-0.5">
                              Shift: {req.source_shift_day || `Shift #${req.source_shift_id}`}{" "}
                              {req.reason ? `· Note: “${req.reason}”` : ""} · Requested at{" "}
                              {req.created_at ? new Date(req.created_at).toLocaleString() : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {req.status === "pending" ? (
                              isManager ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleApproveSwap(req.id)}
                                    className="rounded-lg bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-700 transition"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRejectSwap(req.id)}
                                    className="rounded-lg border border-slate-300 bg-white px-3 py-1 font-semibold text-slate-700 hover:bg-slate-100 transition"
                                  >
                                    Decline
                                  </button>
                                </>
                              ) : (
                                <span className="rounded-md bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                                  Pending Manager Approval
                                </span>
                              )
                            ) : req.status === "approved" ? (
                              <span className="rounded-md bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                                ✓ Approved
                              </span>
                            ) : (
                              <span className="rounded-md bg-rose-100 px-2.5 py-1 text-[11px] font-semibold text-rose-800">
                                ✕ Declined
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Your workspace</p>
                    <h2 className="mt-1 text-2xl font-bold text-slate-900">
                      {activeTab === "Schedule"
                        ? "Full Shift Schedule"
                        : "Upcoming Scheduled Shifts"}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Shifts retrieved from Neon PostgreSQL. Edit or delete shifts assigned to you.
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      setActiveTab(activeTab === "Schedule" ? "Overview" : "Schedule")
                    }
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 transition shadow-2xs"
                  >
                    {activeTab === "Schedule"
                      ? "Back to overview"
                      : "View full schedule"}{" "}
                    →
                  </button>
                </div>

                {loading ? (
                  <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 animate-pulse" aria-label="Loading shifts">
                    {[1, 2, 3].map((skeletonIdx) => (
                      <div
                        key={skeletonIdx}
                        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-3"
                      >
                        <div className="flex items-center justify-between">
                          <div className="h-4 w-28 bg-slate-200 rounded-md"></div>
                          <div className="h-5 w-16 bg-slate-100 rounded-full"></div>
                        </div>
                        <div className="h-3.5 w-36 bg-slate-100 rounded-md"></div>
                        <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                          <div className="h-3 w-20 bg-slate-100 rounded-md"></div>
                          <div className="h-6 w-14 bg-slate-100 rounded-lg"></div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : shiftLoadStatus === "unauthenticated" ? (
                  <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-xl">
                      🔐
                    </div>
                    <h3 className="mt-3 text-base font-bold text-slate-900">
                      Sign In Required
                    </h3>
                    <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                      {statusMessage ||
                        "Sign in required to view shifts. Please sign in to access your team schedule."}
                    </p>
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => setShowLoginModal(true)}
                        className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-slate-700"
                      >
                        🔐 Sign In
                      </button>
                      <Link
                        href="/sign-up"
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50"
                      >
                        Create Account
                      </Link>
                    </div>
                  </div>
                ) : shiftLoadStatus === "forbidden" ? (
                  <div className="mt-5 rounded-3xl border border-amber-200 bg-gradient-to-b from-amber-50/70 to-white p-8 sm:p-10 shadow-sm text-center">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-2xl text-amber-900 shadow-inner">
                      🏢
                    </div>
                    <h3 className="mt-4 text-xl font-bold tracking-tight text-slate-900">
                      Welcome to Rota{currentUser ? `, ${currentUser.name}` : ""}!
                    </h3>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">
                      Your account is ready, but you aren&apos;t part of an active workspace yet. Create your clinic or organization workspace below to start scheduling shifts as the workspace Owner.
                    </p>

                    {workspaceError && (
                      <div className="mx-auto mt-4 max-w-md rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 text-left">
                        {workspaceError}
                      </div>
                    )}

                    <form
                      onSubmit={handleCreateWorkspace}
                      className="mx-auto mt-6 flex max-w-md flex-col gap-3 sm:flex-row"
                    >
                      <input
                        type="text"
                        value={newWorkspaceName}
                        onChange={(e) => {
                          setNewWorkspaceName(e.target.value);
                          if (workspaceError) setWorkspaceError("");
                        }}
                        placeholder="e.g. City General Clinic, Starlight Medical"
                        disabled={creatingWorkspace}
                        maxLength={100}
                        required
                        className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:bg-slate-100"
                      />
                      <button
                        type="submit"
                        disabled={creatingWorkspace || !newWorkspaceName.trim()}
                        className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {creatingWorkspace ? (
                          <>
                            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                            Creating...
                          </>
                        ) : (
                          "Create Workspace"
                        )}
                      </button>
                    </form>

                    <p className="mx-auto mt-4 max-w-md text-xs text-slate-500">
                      Joining an existing team instead? Ask your organization administrator to invite{" "}
                      <span className="font-semibold text-slate-700">{currentUser?.email || "your email"}</span>.
                    </p>
                  </div>
                ) : shiftLoadStatus === "network_error" ? (
                  <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center shadow-sm">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-100 text-xl text-rose-800">
                      ⚠
                    </div>
                    <h3 className="mt-3 text-base font-bold text-rose-900">
                      Unable to Load Shifts
                    </h3>
                    <p className="mx-auto mt-1 max-w-md text-sm text-rose-700">
                      {error || "Could not load shifts. Check your connection and try again."}
                    </p>
                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => void loadShifts()}
                        className="rounded-xl border border-rose-300 bg-white px-4 py-2 text-xs font-semibold text-rose-800 hover:bg-rose-100 transition"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                ) : schedule.length === 0 ? (
                  <p className="mt-5 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                    No shifts scheduled yet. Click “+ Add shift” to schedule your first shift.
                  </p>
                ) : (
                  <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {visibleSchedule.map((shift) => {
                      const isPermitted =
                        currentUser !== null &&
                        canManageTeamShiftRecord(
                          {
                            userId: currentUser.id,
                            role: currentUser.role,
                            teamId: currentUser.teamId ?? null,
                          },
                          {
                            id: shift.id,
                            user_id: shift.userId,
                            employee_name: shift.name,
                            teamId: shift.teamId ?? null,
                          }
                        );

                      const isLegacy = shift.userId === null || shift.userId === undefined;

                      return (
                        <article
                          key={shift.id}
                          className="rounded-2xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-sm flex flex-col justify-between"
                        >
                          <div>
                            <div className="flex items-start justify-between">
                              <div>
                                <p className="text-xs font-bold tracking-widest text-slate-400">
                                  {shift.day}
                                </p>
                                <p className="mt-1 text-2xl font-bold">{shift.date}</p>
                              </div>
                              <div className="flex flex-col items-end gap-1">
                                <span
                                  className={`rounded-full px-3 py-1 text-xs font-semibold ${shift.color}`}
                                >
                                  Scheduled
                                </span>
                                {isLegacy && (
                                  <span className="text-[10px] font-medium text-slate-400">
                                    Legacy record
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="my-4 h-px bg-slate-100" />
                            <div className="flex items-center justify-between">
                              <h3 className="font-semibold text-slate-900">{shift.name}</h3>
                              {isPermitted && (
                                <span className="rounded-md bg-lime-100 px-2 py-0.5 text-[10px] font-bold text-lime-800 uppercase tracking-wide">
                                  {isManager && shift.userId !== currentUser?.id
                                    ? "Manager access"
                                    : "Your shift"}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-sm text-slate-500">{shift.role}</p>
                          </div>

                          <div className="mt-5 border-t border-slate-100 pt-3 flex items-center justify-between">
                            <p className="text-xs font-semibold text-slate-600">
                              {shift.start} – {shift.end}
                            </p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleStartSwap(shift)}
                                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                                aria-label={`Request swap for shift on ${shift.date}`}
                              >
                                Swap
                              </button>
                              <button
                                type="button"
                                onClick={() => handleStartEdit(shift)}
                                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                                aria-label={`Edit shift for ${shift.name}`}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleStartDelete(shift)}
                                className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-100"
                                aria-label={`Delete shift for ${shift.name}`}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            <footer className="mt-12 border-t border-slate-200 py-6 text-xs text-slate-400 flex flex-col sm:flex-row items-center justify-between gap-2">
              <span>Rota · Team scheduling workspace · Connected to Neon PostgreSQL</span>
              <Link
                href="/privacy"
                className="text-slate-500 hover:text-slate-800 underline transition"
              >
                Privacy Policy
              </Link>
            </footer>
          </div>
        </section>
      </div>

      {/* Sign In Modal */}
      {showLoginModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">Sign In to Rota</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Authentication verified via secure HttpOnly session cookies.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowLoginModal(false)}
                className="rounded-lg px-3 py-2 text-slate-500 hover:bg-slate-100"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {loginError && (
              <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                {loginError}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700" htmlFor="email">
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="e.g. employee@rota.local"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-lime-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-700" htmlFor="password">
                    Password
                  </label>
                  <Link
                    href="/forgot-password"
                    onClick={() => setShowLoginModal(false)}
                    className="text-xs font-medium text-slate-500 hover:text-slate-900 hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <input
                    id="password"
                    type={showLoginPassword ? "text" : "password"}
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 pr-10 text-sm outline-none focus:border-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword(!showLoginPassword)}
                    aria-label={showLoginPassword ? "Hide password" : "Show password"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 text-xs font-semibold"
                  >
                    {showLoginPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loggingIn}
                className="w-full rounded-xl bg-slate-900 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
              >
                {loggingIn ? "Verifying credentials…" : "Sign In"}
              </button>

              <div className="pt-2 text-center text-xs text-slate-500 space-y-1">
                <div>
                  Don&apos;t have an account?{" "}
                  <Link
                    href="/sign-up"
                    onClick={() => setShowLoginModal(false)}
                    className="font-semibold text-slate-900 hover:underline"
                  >
                    Sign up
                  </Link>
                </div>
                <div>
                  <Link
                    href="/sign-in"
                    onClick={() => setShowLoginModal(false)}
                    className="text-slate-400 hover:text-slate-600 hover:underline"
                  >
                    Open dedicated sign-in page →
                  </Link>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add / Edit Shift Modal Form */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <form
            onSubmit={handleSaveShift}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">
                  {editingShift ? "Edit shift" : "Add a shift"}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {editingShift
                    ? `Update shift #${editingShift.id} in the database.`
                    : "Save a new shift to your database."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingShift(null);
                }}
                className="rounded-lg px-3 py-2 text-slate-500 hover:bg-slate-100"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <label className="mb-2 block text-sm font-medium" htmlFor="employee">
              Team member name
            </label>
            <input
              id="employee"
              required
              disabled={!isManager}
              maxLength={100}
              value={employee}
              onChange={(e) => setEmployee(e.target.value)}
              placeholder="e.g. Chika Nwosu"
              className="mb-4 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-lime-500 disabled:bg-slate-100 disabled:text-slate-500"
            />

            <label className="mb-2 block text-sm font-medium" htmlFor="role">
              Role
            </label>
            <select
              id="role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="mb-4 w-full rounded-xl border border-slate-300 bg-white px-3 py-3"
            >
              {APP_ROLES.map((appRole) => (
                <option key={appRole} value={appRole}>
                  {appRole}
                </option>
              ))}
              {!(APP_ROLES as readonly string[]).includes(role) && role && (
                <option value={role}>{role}</option>
              )}
            </select>

            <label className="mb-2 block text-sm font-medium" htmlFor="day">
              Shift date
            </label>
            <input
              id="day"
              type="date"
              required
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="mb-6 w-full rounded-xl border border-slate-300 bg-white px-3 py-3"
            />

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  setEditingShift(null);
                }}
                className="w-1/3 rounded-xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="w-2/3 rounded-xl bg-slate-900 px-4 py-3 font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving
                  ? "Saving…"
                  : editingShift
                  ? "Update shift"
                  : "Save shift"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingShift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 text-rose-600 font-bold">
                ⚠
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-900">Delete Shift</h2>
                <p className="text-xs text-slate-500">Confirmation required</p>
              </div>
            </div>

            <p className="text-sm leading-6 text-slate-600 mb-6">
              Are you sure you want to permanently delete the shift for{" "}
              <strong>{deletingShift.name}</strong> ({deletingShift.role}) on{" "}
              <strong>{deletingShift.shiftDay}</strong>? This action cannot be undone.
            </p>

            <div className="flex gap-3">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeletingShift(null)}
                className="w-1/2 rounded-xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-100 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleConfirmDelete}
                className="w-1/2 rounded-xl bg-rose-600 px-4 py-3 font-semibold text-white hover:bg-rose-700 disabled:opacity-60 transition"
              >
                {deleting ? "Deleting…" : "Confirm delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shift Swap Request Modal */}
      {swappingShift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Request Shift Swap</h2>
                <p className="text-xs text-slate-500">
                  Transfer or exchange coverage with a team member
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSwappingShift(null)}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3.5 mb-4 text-xs space-y-1">
              <p>
                <span className="text-slate-500">Current Shift:</span>{" "}
                <strong>{swappingShift.name}</strong> ({swappingShift.role})
              </p>
              <p>
                <span className="text-slate-500">Date:</span>{" "}
                <strong>{swappingShift.day}, {swappingShift.date}</strong>
              </p>
              <p>
                <span className="text-slate-500">Hours:</span>{" "}
                <strong>{swappingShift.start} – {swappingShift.end}</strong>
              </p>
            </div>

            <form onSubmit={handleConfirmSwap} className="space-y-4">
              <div>
                <label
                  htmlFor="swap-target"
                  className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1"
                >
                  Swap With Eligible Shift
                </label>
                <select
                  id="swap-target"
                  required
                  value={swapTargetShiftId ?? ""}
                  onChange={(e) => setSwapTargetShiftId(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                >
                  {schedule
                    .filter(
                      (s) =>
                        s.id !== swappingShift.id &&
                        (swappingShift.userId ? s.userId !== swappingShift.userId : s.name !== swappingShift.name)
                    )
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.role}) — {s.day}, {s.date} ({s.start} - {s.end})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="swap-reason"
                  className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1"
                >
                  Reason / Notes (Optional)
                </label>
                <input
                  id="swap-reason"
                  type="text"
                  value={swapReason}
                  onChange={(e) => setSwapReason(e.target.value)}
                  placeholder="e.g. Coverage requested, schedule conflict"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setSwappingShift(null)}
                  className="w-1/3 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingSwap}
                  className="w-2/3 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-60 transition"
                >
                  {submittingSwap
                    ? "Submitting…"
                    : isManager
                    ? "Approve & Execute Swap"
                    : "Submit Swap Request"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invite Team Member Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Invite Team Member</h2>
                <p className="text-xs text-slate-500">
                  Add an employee to the workspace roster
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowInviteModal(false)}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleInviteMember} className="space-y-4">
              <div>
                <label
                  htmlFor="invite-name"
                  className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1"
                >
                  Employee Name
                </label>
                <input
                  id="invite-name"
                  type="text"
                  required
                  autoFocus
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="e.g. Emeka Okafor"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                />
              </div>

              <div>
                <label
                  htmlFor="invite-role"
                  className="block text-xs font-semibold uppercase tracking-wider text-slate-600 mb-1"
                >
                  Position / Role
                </label>
                <select
                  id="invite-role"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                >
                  <option value="Front Desk">Front Desk</option>
                  <option value="Customer Support">Customer Support</option>
                  <option value="Operations">Operations</option>
                  <option value="Supervisor">Supervisor</option>
                </select>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="w-1/3 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviting}
                  className="w-2/3 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-60 transition"
                >
                  {inviting ? "Adding…" : "Send Invite"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Legacy Shift Recovery Modal */}
      {showRecoveryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl sm:p-8 max-h-[90vh] overflow-y-auto">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700 text-lg shadow-xs">
                  📦
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-900">Recover Legacy Shifts</h2>
                  <p className="text-xs text-slate-500">
                    Assign your historical shifts into an authorized workspace
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!recovering) {
                    setShowRecoveryModal(false);
                    setRecoveryError("");
                    setRecoverySuccess("");
                  }
                }}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-50"
                disabled={recovering}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* Loading state */}
            {checkingRecovery ? (
              <div className="p-8 text-center text-sm text-slate-500">
                <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent mr-2 align-middle" />
                Checking for recoverable shifts…
              </div>
            ) : recoverableShifts.length === 0 ? (
              /* Empty state */
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 text-base mb-2">
                  ✓
                </div>
                <h3 className="text-sm font-bold text-slate-900">No Legacy Shifts Pending</h3>
                <p className="mt-1 text-xs text-slate-500">
                  All historical shifts linked to your account are assigned to active workspaces.
                </p>
                <button
                  type="button"
                  onClick={() => setShowRecoveryModal(false)}
                  className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition"
                >
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmitRecovery} className="space-y-5">
                {recoveryError && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 flex items-start gap-2">
                    <span className="font-bold text-rose-600">⚠</span>
                    <span>{recoveryError}</span>
                  </div>
                )}

                {recoverySuccess && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 flex items-start gap-2">
                    <span className="font-bold text-emerald-600">✓</span>
                    <span>{recoverySuccess}</span>
                  </div>
                )}

                {/* Shifts Preview */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      Shifts to Recover ({recoverableShifts.length})
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Verified owner: {currentUser?.name}
                    </span>
                  </div>
                  <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/50 p-2 divide-y divide-slate-100">
                    {recoverableShifts.map((shift) => (
                      <div
                        key={shift.id}
                        className="py-1.5 first:pt-0 flex items-center justify-between text-xs text-slate-700 px-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-slate-900">
                            {shift.shift_day}
                          </span>
                          <span className="rounded-md bg-slate-200/80 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                            {shift.role}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-400 font-mono">
                          Shift #{shift.id}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Shift IDs, dates, roles, and employee names are completely preserved.
                  </p>
                </div>

                {/* Destination Workspace Selection */}
                <div>
                  <label
                    htmlFor="target-workspace-select"
                    className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1"
                  >
                    Select Destination Workspace *
                  </label>
                  {recoveryWorkspaces.length === 0 ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
                      <p className="font-bold mb-1">No Authorized Workspaces Found</p>
                      <p className="mb-3">
                        You must be a member of at least one workspace to recover legacy shifts.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setShowRecoveryModal(false);
                          setActiveTab("Overview");
                        }}
                        className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 transition"
                      >
                        Create Workspace First
                      </button>
                    </div>
                  ) : (
                    <select
                      id="target-workspace-select"
                      value={selectedTargetTeamId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedTargetTeamId(val ? Number(val) : "");
                        if (recoveryError) setRecoveryError("");
                      }}
                      disabled={recovering}
                      required
                      className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900 shadow-2xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:bg-slate-100"
                    >
                      <option value="">-- Choose an authorized workspace --</option>
                      {recoveryWorkspaces.map((ws) => (
                        <option key={ws.id} value={ws.id}>
                          {ws.name} ({ws.role}) · Workspace #{ws.id}
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500">
                    Only workspaces where you have verified membership can be selected.
                  </p>
                </div>

                {/* Confirmation Checkbox */}
                {recoveryWorkspaces.length > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                    <label className="flex items-start gap-2.5 cursor-pointer text-xs text-slate-700 select-none">
                      <input
                        id="recovery-confirm-check"
                        type="checkbox"
                        checked={recoveryConfirmed}
                        onChange={(e) => {
                          setRecoveryConfirmed(e.target.checked);
                          if (recoveryError) setRecoveryError("");
                        }}
                        disabled={recovering}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>
                        I confirm that I want to assign these <strong>{recoverableShifts.length}</strong> legacy shift(s) to{" "}
                        <strong>
                          {recoveryWorkspaces.find((w) => w.id === selectedTargetTeamId)?.name || "the selected workspace"}
                        </strong>.
                      </span>
                    </label>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowRecoveryModal(false);
                      setRecoveryError("");
                      setRecoverySuccess("");
                    }}
                    disabled={recovering}
                    className="w-1/3 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={recovering || !selectedTargetTeamId || !recoveryConfirmed || recoveryWorkspaces.length === 0}
                    className="w-2/3 inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {recovering ? (
                      <>
                        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Recovering shifts…
                      </>
                    ) : (
                      `Confirm & Recover (${recoverableShifts.length})`
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
      {/* Workspace Plan Upgrade Modal */}
      {showBillingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Workspace Subscription Plans</h2>
                <p className="text-xs text-slate-500">
                  Select a subscription tier to expand your workspace capacity.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowBillingModal(false);
                  setBillingError("");
                }}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* Active Subscription & Grace Period Alerts */}
            {subscriptionStatus === "past_due" && (
              <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2">
                <span className="text-base leading-none">⚠️</span>
                <div>
                  <p className="font-semibold">Renewal Payment Past Due</p>
                  <p className="text-amber-800 mt-0.5">
                    Your last renewal charge failed. Your team is currently in a 7-day grace period
                    {gracePeriodExpiresAt ? ` (expires on ${new Date(gracePeriodExpiresAt * 1000).toLocaleDateString()})` : ""}.
                    Select a plan below to refresh your card and keep your workspace active.
                  </p>
                </div>
              </div>
            )}

            {cancelAtPeriodEnd && (
              <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
                <p className="font-semibold">Auto-Renewal Canceled</p>
                <p className="text-blue-800 mt-0.5">
                  Your subscription will not renew automatically. You have full access to your plan until
                  {currentPeriodEnd ? ` ${new Date(currentPeriodEnd * 1000).toLocaleDateString()}` : " the end of your billing cycle"}.
                </p>
              </div>
            )}

            {/* Current Subscription & Payment Method Summary */}
            {subscriptionPlan !== "free" && (
              <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-700 space-y-1.5">
                <div className="flex items-center justify-between font-semibold text-slate-900">
                  <span>Current Subscription</span>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase ${
                    subscriptionStatus === "active" ? "bg-emerald-100 text-emerald-800" :
                    subscriptionStatus === "past_due" ? "bg-amber-100 text-amber-800" :
                    "bg-slate-200 text-slate-700"
                  }`}>
                    {subscriptionStatus}
                  </span>
                </div>
                {cardMetadata?.last4 && (
                  <p className="text-slate-600">
                    💳 Payment Card: <span className="font-medium text-slate-800">{cardMetadata.brand ? cardMetadata.brand.toUpperCase() : "Card"} ending in {cardMetadata.last4}</span>
                    {cardMetadata.bank ? ` (${cardMetadata.bank})` : ""}
                  </p>
                )}
                {currentPeriodEnd && (
                  <p className="text-slate-600">
                    🗓️ Next Billing Date: <span className="font-medium text-slate-800">{new Date(currentPeriodEnd * 1000).toLocaleDateString()}</span>
                  </p>
                )}
                {!cancelAtPeriodEnd && subscriptionStatus === "active" && (
                  <div className="pt-1 flex justify-end">
                    <button
                      type="button"
                      disabled={upgradingPlan}
                      onClick={handleCancelSubscription}
                      className="text-[11px] font-semibold text-rose-600 hover:text-rose-700 underline disabled:opacity-50"
                    >
                      Cancel Auto-Renewal
                    </button>
                  </div>
                )}
              </div>
            )}

            {billingError && (
              <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                {billingError}
              </div>
            )}

            <div className="space-y-3 mb-4">
              {/* Starter Plan Card (₦15,000 / 15 seats) */}
              <div
                className={`rounded-xl border p-4 transition ${
                  subscriptionPlan === "starter"
                    ? "border-emerald-500 bg-emerald-50/40"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-slate-900">Starter Tier</h3>
                    <p className="text-xs text-slate-500">For small clinics and growing healthcare teams</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-slate-900">₦15,000<span className="text-xs text-slate-500 font-normal">/mo</span></p>
                    <span className="inline-block text-[11px] font-semibold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded">
                      Up to 15 seats
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={upgradingPlan || subscriptionPlan === "starter"}
                  onClick={() => handleUpgradePlan("starter")}
                  className="mt-3 w-full rounded-xl bg-slate-900 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition"
                >
                  {subscriptionPlan === "starter" ? "Current Plan" : "Upgrade to Starter (₦15,000/mo)"}
                </button>
              </div>

              {/* Pro Plan Card (₦45,000 / 50 seats) */}
              <div
                className={`rounded-xl border p-4 transition ${
                  subscriptionPlan === "pro"
                    ? "border-emerald-500 bg-emerald-50/40"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-slate-900">Professional Tier</h3>
                    <p className="text-xs text-slate-500">For multi-department medical centers & clinics</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-slate-900">₦45,000<span className="text-xs text-slate-500 font-normal">/mo</span></p>
                    <span className="inline-block text-[11px] font-semibold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded">
                      Up to 50 seats
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={upgradingPlan || subscriptionPlan === "pro"}
                  onClick={() => handleUpgradePlan("pro")}
                  className="mt-3 w-full rounded-xl bg-slate-900 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition"
                >
                  {subscriptionPlan === "pro" ? "Current Plan" : "Upgrade to Professional (₦45,000/mo)"}
                </button>
              </div>

              {/* Enterprise Plan Card (₦150,000 / 500 seats) */}
              <div
                className={`rounded-xl border p-4 transition ${
                  subscriptionPlan === "enterprise"
                    ? "border-emerald-500 bg-emerald-50/40"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-slate-900">Enterprise Tier</h3>
                    <p className="text-xs text-slate-500">For regional hospital networks & hospital groups</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-slate-900">₦150,000<span className="text-xs text-slate-500 font-normal">/mo</span></p>
                    <span className="inline-block text-[11px] font-semibold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded">
                      Up to 500 seats
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={upgradingPlan || subscriptionPlan === "enterprise"}
                  onClick={() => handleUpgradePlan("enterprise")}
                  className="mt-3 w-full rounded-xl bg-slate-900 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition"
                >
                  {subscriptionPlan === "enterprise" ? "Current Plan" : "Upgrade to Enterprise (₦150,000/mo)"}
                </button>
              </div>
            </div>

            {/* Invariant & Data Preservation Guarantees */}
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 mb-4 text-[11px] text-slate-500 space-y-1">
              <p className="font-medium text-slate-700">🔒 Security & Policy Guarantees:</p>
              <p>• Billed monthly in Nigerian Naira (NGN) via Paystack encrypted checkout.</p>
              <p>• Data Preservation: Changing plans never deletes workspace members, roles, or shifts.</p>
              <p>• Cancel anytime to stop future renewals while maintaining access until period end.</p>
            </div>

            <div className="border-t border-slate-100 pt-3 flex justify-between items-center text-xs text-slate-400">
              <span>Paystack Secured · Reusable Authorization</span>
              <button
                type="button"
                onClick={() => {
                  setShowBillingModal(false);
                  setBillingError("");
                }}
                className="font-medium text-slate-600 hover:text-slate-900"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}