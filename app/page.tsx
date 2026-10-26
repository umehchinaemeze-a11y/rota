"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { canManageTeamShiftRecord, isManagerRole, APP_ROLES } from "@/lib/permissions";
import {
  resolveShiftFetchResponse,
  mapApiShift,
  type ApiShift,
  type ScheduleShift,
} from "@/lib/shifts-client";

type AuthUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  teamId?: number | null;
};

type ShiftSwapRequest = {
  id: string;
  shiftId: number;
  shiftDay: string;
  requesterName: string;
  requesterRole: string;
  targetEmployeeName: string;
  reason: string;
  status: "pending" | "approved" | "declined";
  createdAt: string;
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
  const [swapRequests, setSwapRequests] = useState<ShiftSwapRequest[]>([]);
  const [swappingShift, setSwappingShift] = useState<ScheduleShift | null>(null);
  const [swapTarget, setSwapTarget] = useState("");
  const [swapReason, setSwapReason] = useState("");
  const [submittingSwap, setSubmittingSwap] = useState(false);

  // Workspace Settings & Team Invite states
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
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

  // Workspace onboarding states
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");

  // Schedule & team
  const [schedule, setSchedule] = useState<ScheduleShift[]>([]);
  const [team, setTeam] = useState([
    { name: "Amara Okafor", role: "Front Desk", status: "On shift", initials: "AO" },
    { name: "Daniel James", role: "Operations", status: "Upcoming", initials: "DJ" },
    { name: "Sarah Bello", role: "Customer Support", status: "On shift", initials: "SB" },
    { name: "David Musa", role: "Front Desk", status: "Off duty", initials: "DM" },
    { name: "Chika Nwosu", role: "Supervisor", status: "On shift", initials: "CN" },
  ]);

  // Check authenticated session on load
  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          setCurrentUser(data.user);
          return data.user as AuthUser;
        }
      }
      setCurrentUser(null);
      return null;
    } catch {
      setCurrentUser(null);
      return null;
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const loadShifts = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/shifts");
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
      } else if (outcome.status === "unauthenticated") {
        setSchedule([]);
        setShiftLoadStatus("unauthenticated");
        setStatusMessage(outcome.message);
        setError(""); // Do not present 401 as a connection error
      } else if (outcome.status === "forbidden") {
        setSchedule([]);
        setShiftLoadStatus("forbidden");
        setStatusMessage(outcome.message);
        setError(""); // Do not present 403 as a connection error
      } else {
        setSchedule([]);
        setShiftLoadStatus("network_error");
        setError(outcome.message);
        setStatusMessage("");
      }
    } catch {
      const outcome = resolveShiftFetchResponse(0, null, true);
      setSchedule([]);
      setShiftLoadStatus("network_error");
      setError(outcome.status !== "success" ? outcome.message : "Failed to load shifts.");
      setStatusMessage("");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load shifts only after the authentication state is known
  useEffect(() => {
    let active = true;

    async function initialize() {
      await checkSession();
      if (active) {
        await loadShifts();
      }
    }

    void initialize();

    return () => {
      active = false;
    };
  }, [checkSession, loadShifts]);

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
    } catch (err: unknown) {
      setWorkspaceError(
        err instanceof Error ? err.message : "An unexpected error occurred while creating your workspace."
      );
    } finally {
      setCreatingWorkspace(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setCurrentUser(null);
      setNotice("You have signed out successfully.");
      await loadShifts();
    } catch {
      setError("Failed to sign out cleanly.");
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

    setSwappingShift(shift);
    const candidate = team.find((m) => m.name !== shift.name);
    setSwapTarget(candidate ? candidate.name : "");
    setSwapReason("");
  }

  async function handleConfirmSwap(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!swappingShift || !swapTarget || submittingSwap) return;
    setSubmittingSwap(true);

    const isManager = isManagerRole(currentUser?.role);

    if (isManager) {
      try {
        const targetMember = team.find((m) => m.name === swapTarget);
        const response = await fetch(`/api/shifts/${swappingShift.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            employeeName: swapTarget,
            role: targetMember ? targetMember.role : swappingShift.role,
            shiftDay: swappingShift.shiftDay,
          }),
        });

        const updated = await response.json();
        if (!response.ok) {
          throw new Error(updated.error || "Failed to execute shift swap.");
        }

        const mapped = mapApiShift(
          updated,
          schedule.findIndex((s) => s.id === swappingShift.id)
        );
        setSchedule((curr) =>
          curr.map((s) => (s.id === mapped.id ? mapped : s))
        );
        setNotice(
          `Shift swap approved and executed: Shift on ${swappingShift.shiftDay} assigned to ${swapTarget}.`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Swap execution failed.");
      }
    } else {
      const newRequest: ShiftSwapRequest = {
        id: `swap-${Date.now()}`,
        shiftId: swappingShift.id,
        shiftDay: swappingShift.shiftDay,
        requesterName: swappingShift.name,
        requesterRole: swappingShift.role,
        targetEmployeeName: swapTarget,
        reason: swapReason.trim() || "Coverage requested",
        status: "pending",
        createdAt: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      };
      setSwapRequests((curr) => [newRequest, ...curr]);
      setNotice(
        `Swap request submitted for ${swappingShift.name} to swap with ${swapTarget}. Awaiting manager approval.`
      );
    }

    setSwappingShift(null);
    setSubmittingSwap(false);
  }

  async function handleApproveSwap(req: ShiftSwapRequest) {
    try {
      const shift = schedule.find((s) => s.id === req.shiftId);
      if (!shift) throw new Error("Shift record no longer found.");

      const targetMember = team.find((m) => m.name === req.targetEmployeeName);
      const response = await fetch(`/api/shifts/${req.shiftId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeName: req.targetEmployeeName,
          role: targetMember ? targetMember.role : req.requesterRole,
          shiftDay: req.shiftDay,
        }),
      });

      const updated = await response.json();
      if (!response.ok) {
        throw new Error(updated.error || "Failed to approve swap.");
      }

      const mapped = mapApiShift(
        updated,
        schedule.findIndex((s) => s.id === req.shiftId)
      );
      setSchedule((curr) =>
        curr.map((s) => (s.id === mapped.id ? mapped : s))
      );
      setSwapRequests((curr) =>
        curr.map((r) => (r.id === req.id ? { ...r, status: "approved" } : r))
      );
      setNotice(
        `Approved shift swap: ${req.requesterName} → ${req.targetEmployeeName} on ${req.shiftDay}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve swap.");
    }
  }

  function handleDeclineSwap(reqId: string) {
    setSwapRequests((curr) =>
      curr.map((r) => (r.id === reqId ? { ...r, status: "declined" } : r))
    );
    setNotice("Shift swap request was declined.");
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
        {/* Sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white p-6 md:flex">
          <div className="mb-12 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lime-300 text-xl font-black">
              R
            </div>
            <div>
              <p className="text-xl font-bold tracking-tight">
                rota<span className="text-lime-600">.</span>
              </p>
              <p className="text-xs text-slate-500">TEAM SCHEDULING</p>
            </div>
          </div>

          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
            Workspace
          </p>
          <nav className="space-y-2">
            {["Overview", "Schedule", "Team", "Settings"].map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setActiveTab(tab);
                  setError("");
                  setNotice("");
                }}
                className={`w-full rounded-xl px-4 py-3 text-left text-sm font-medium transition ${
                  activeTab === tab
                    ? "bg-lime-200 text-slate-950 font-bold"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {tab === "Overview"
                  ? "◫"
                  : tab === "Schedule"
                  ? "▦"
                  : tab === "Team"
                  ? "♙"
                  : "⚙"}{" "}
                <span className="ml-3">{tab}</span>
              </button>
            ))}
          </nav>

          <div className="mt-auto rounded-2xl bg-slate-900 p-4 text-white">
            <p className="text-sm font-semibold">Verified Authentication</p>
            <p className="mt-2 text-xs leading-5 text-slate-300">
              Session verified strictly from HttpOnly cookies and database roles.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  currentUser ? "bg-lime-400 animate-pulse" : "bg-amber-400"
                }`}
              />
              <span className="text-xs text-slate-300">
                {currentUser
                  ? `Signed in as ${currentUser.name}`
                  : "Signed out (read-only)"}
              </span>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <section className="min-w-0 flex-1">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-5 sm:px-8">
            <div>
              <p className="text-xs font-medium text-slate-500">WORKSPACE / ROTA</p>
              <h1 className="mt-1 text-xl font-bold sm:text-2xl">{activeTab}</h1>
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
                    onClick={handleLogout}
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

            {/* Overview Stats */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Total shifts
                </p>
                <p className="mt-2 text-3xl font-bold">
                  {shiftLoadStatus === "unauthenticated" ? "—" : schedule.length}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {shiftLoadStatus === "unauthenticated"
                    ? "Sign in to view"
                    : "Live database records"}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Team on shift
                </p>
                <p className="mt-2 text-3xl font-bold">
                  {team.filter((m) => m.status === "On shift").length}
                </p>
                <p className="mt-1 text-xs text-emerald-600 font-medium">Currently active</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Assigned members
                </p>
                <p className="mt-2 text-3xl font-bold">{team.length}</p>
                <p className="mt-1 text-xs text-slate-500">Workspace roster</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  Account Status
                </p>
                <p className="mt-2 text-lg font-bold text-slate-900">
                  {currentUser ? currentUser.role : "Signed Out"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {currentUser
                    ? `Authenticated as ${currentUser.name}`
                    : "Sign in required to view shifts"}
                </p>
              </div>
            </div>

            {/* Team tab */}
            {activeTab === "Team" && (
              <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                  <div>
                    <h2 className="text-lg font-bold">Workspace Team Members</h2>
                    <p className="text-sm text-slate-500">
                      Active roster members with designated roles and live shift availability.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowInviteModal(true)}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-slate-800 transition"
                  >
                    + Invite Member
                  </button>
                </div>
                <div className="divide-y divide-slate-100">
                  {team.map((member) => (
                    <div
                      key={member.name}
                      className="flex items-center justify-between py-4"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 font-bold text-slate-700">
                          {member.initials}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">{member.name}</p>
                          <p className="text-xs text-slate-500">{member.role}</p>
                        </div>
                      </div>
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

                  <div className="mt-6 border-t border-slate-100 pt-6 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <input
                        id="notifications-toggle"
                        type="checkbox"
                        checked={notificationsEnabled}
                        onChange={(e) => setNotificationsEnabled(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                      />
                      <label htmlFor="notifications-toggle" className="text-xs font-medium text-slate-700">
                        In-app shift update notifications enabled
                      </label>
                    </div>

                    {currentUser && (
                      <button
                        type="button"
                        onClick={handleLogout}
                        className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 transition"
                      >
                        Sign Out of Session
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Schedule & Overview tab */}
            {activeTab !== "Team" && activeTab !== "Settings" && (
              <>
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
                              {req.requesterName} <span className="font-normal text-slate-500">requested swap with</span> {req.targetEmployeeName}
                            </p>
                            <p className="text-slate-500 mt-0.5">
                              Shift: {req.shiftDay} · Note: &ldquo;{req.reason}&rdquo; · Requested at {req.createdAt}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {req.status === "pending" ? (
                              isManager ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleApproveSwap(req)}
                                    className="rounded-lg bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-700 transition"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeclineSwap(req.id)}
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

                <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-bold">
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
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50 transition"
                  >
                    {activeTab === "Schedule"
                      ? "Back to overview"
                      : "View full schedule"}{" "}
                    →
                  </button>
                </div>

                {loading ? (
                  <p className="mt-5 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                    Loading shifts from database…
                  </p>
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

            <footer className="mt-12 border-t border-slate-200 py-6 text-xs text-slate-400">
              Rota · Team scheduling workspace · Connected to Neon PostgreSQL
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
                  Swap With Team Member
                </label>
                <select
                  id="swap-target"
                  required
                  value={swapTarget}
                  onChange={(e) => setSwapTarget(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                >
                  {team
                    .filter((m) => m.name !== swappingShift.name)
                    .map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name} ({m.role})
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
    </main>
  );
}