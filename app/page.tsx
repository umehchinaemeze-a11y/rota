"use client";

import { useCallback, useEffect, useState } from "react";
import { canManageShiftRecord } from "@/lib/permissions";

type ApiShift = {
  id: number;
  employee_name: string;
  role: string;
  user_id?: number | null;
  shift_day: string;
  created_at: string;
};

type ScheduleShift = {
  id: number;
  day: string;
  date: string;
  name: string;
  role: string;
  userId?: number | null;
  start: string;
  end: string;
  color: string;
  shiftDay: string;
};

type AuthUser = {
  id: number;
  email: string;
  name: string;
  role: string;
};

const shiftColors = [
  "bg-emerald-100 text-emerald-800",
  "bg-blue-100 text-blue-800",
  "bg-violet-100 text-violet-800",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-800",
];

function formatShiftDate(dateString: string) {
  const date = dateString.slice(0, 10);
  const [year, month, day] = date.split("-").map(Number);
  const localDate = new Date(year, month - 1, day);

  return {
    day: localDate
      .toLocaleDateString("en-US", { weekday: "short" })
      .toUpperCase(),
    date: String(day),
    shiftDay: date,
  };
}

function mapApiShift(shift: ApiShift, index: number): ScheduleShift {
  const formatted = formatShiftDate(shift.shift_day);

  return {
    id: shift.id,
    ...formatted,
    name: shift.employee_name,
    role: shift.role,
    userId: shift.user_id,
    start: "09:00",
    end: "17:00",
    color: shiftColors[index % shiftColors.length],
  };
}

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
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  // Form modal states
  const [showForm, setShowForm] = useState(false);
  const [editingShift, setEditingShift] = useState<ScheduleShift | null>(null);
  const [deletingShift, setDeletingShift] = useState<ScheduleShift | null>(null);

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
      if (!response.ok) throw new Error("Unable to load shifts from the database.");

      const data: ApiShift[] = await response.json();
      setSchedule(data.map(mapApiShift));
    } catch {
      setError("Could not load shifts. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load shifts only after the authentication state is known
  useEffect(() => {
    void checkSession().then(() => {
      void loadShifts();
    });
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

    const hasPermission = canManageShiftRecord(
      { userId: currentUser.id, role: currentUser.role },
      { id: shift.id, user_id: shift.userId, employee_name: shift.name }
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

    const hasPermission = canManageShiftRecord(
      { userId: currentUser.id, role: currentUser.role },
      { id: shift.id, user_id: shift.userId, employee_name: shift.name }
    );

    if (!hasPermission) {
      setError(
        `Permission denied: You are signed in as "${currentUser.name}" (${currentUser.role}). You can only delete shifts assigned to your account. Legacy shifts require manager permissions.`
      );
      return;
    }

    setDeletingShift(shift);
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

  const isManager =
    currentUser?.role === "Supervisor" ||
    currentUser?.role === "Operations" ||
    currentUser?.role === "Admin";

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
            {["Overview", "Schedule", "Team"].map((tab) => (
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
                {tab === "Overview" ? "◫" : tab === "Schedule" ? "▦" : "♙"}{" "}
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
                <p className="mt-2 text-3xl font-bold">{schedule.length}</p>
                <p className="mt-1 text-xs text-slate-500">Live database records</p>
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
                    : "Read-only access"}
                </p>
              </div>
            </div>

            {/* Team tab */}
            {activeTab === "Team" && (
              <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
                <h2 className="text-lg font-bold">Workspace Team Members</h2>
                <p className="text-sm text-slate-500 mb-6">
                  Team members with roles and live shift availability.
                </p>
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

            {/* Schedule & Overview tab */}
            {activeTab !== "Team" && (
              <>
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
                ) : schedule.length === 0 ? (
                  <p className="mt-5 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                    No shifts scheduled yet. Click “+ Add shift” to schedule your first shift.
                  </p>
                ) : (
                  <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {visibleSchedule.map((shift) => {
                      const isPermitted =
                        currentUser !== null &&
                        canManageShiftRecord(
                          { userId: currentUser.id, role: currentUser.role },
                          { id: shift.id, user_id: shift.userId, employee_name: shift.name }
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
                <label className="mb-1 block text-xs font-semibold text-slate-700" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-lime-500"
                />
              </div>

              <button
                type="submit"
                disabled={loggingIn}
                className="w-full rounded-xl bg-slate-900 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
              >
                {loggingIn ? "Verifying credentials…" : "Sign In"}
              </button>
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
              <option>Front Desk</option>
              <option>Operations</option>
              <option>Customer Support</option>
              <option>Supervisor</option>
              <option>Frontend Developer</option>
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
    </main>
  );
}