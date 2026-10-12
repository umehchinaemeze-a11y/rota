"use client";

import { useCallback, useEffect, useState } from "react";

type ApiShift = {
  id: number;
  employee_name: string;
  role: string;
  shift_day: string;
  created_at: string;
};

type ScheduleShift = {
  id: number;
  day: string;
  date: string;
  name: string;
  role: string;
  start: string;
  end: string;
  color: string;
  shiftDay: string;
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
  const [showForm, setShowForm] = useState(false);
  const [employee, setEmployee] = useState("");
  const [role, setRole] = useState("Front Desk");
  const [day, setDay] = useState("2026-10-12");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [schedule, setSchedule] = useState<ScheduleShift[]>([]);

  const [team, setTeam] = useState([
    { name: "Amara Okafor", role: "Front Desk", status: "On shift", initials: "AO" },
    { name: "Daniel James", role: "Operations", status: "Upcoming", initials: "DJ" },
    { name: "Sarah Bello", role: "Customer Support", status: "On shift", initials: "SB" },
    { name: "David Musa", role: "Front Desk", status: "Off duty", initials: "DM" },
  ]);

  const loadShifts = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/shifts");
      if (!response.ok) throw new Error("Unable to load shifts.");

      const data: ApiShift[] = await response.json();
      setSchedule(data.map(mapApiShift));
    } catch {
      setError("Could not load shifts. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadShifts();
  }, [loadShifts]);

  async function addShift(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!employee.trim() || !day || saving) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeName: employee.trim(),
          role,
          shiftDay: day,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to save the shift.");
      }

      const savedShift = mapApiShift(result as ApiShift, schedule.length);

      setSchedule((current) =>
        [...current, savedShift].sort((a, b) =>
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

      setNotice(`Shift saved for ${employee.trim()} on ${day}.`);
      setEmployee("");
      setShowForm(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to save the shift."
      );
    } finally {
      setSaving(false);
    }
  }

  const visibleSchedule =
    activeTab === "Schedule" ? schedule : schedule.slice(0, 5);

  return (
    <main className="min-h-screen bg-[#f7f8f5] text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1440px]">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white p-6 md:flex">
          <div className="mb-12 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lime-300 text-xl font-black">R</div>
            <div>
              <p className="text-xl font-bold tracking-tight">rota<span className="text-lime-600">.</span></p>
              <p className="text-xs text-slate-500">TEAM SCHEDULING</p>
            </div>
          </div>

          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">Workspace</p>
          <nav className="space-y-2">
            {["Overview", "Schedule", "Team"].map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`w-full rounded-xl px-4 py-3 text-left text-sm font-medium transition ${activeTab === tab ? "bg-lime-200 text-slate-950" : "text-slate-600 hover:bg-slate-100"}`}>
                {tab === "Overview" ? "◫" : tab === "Schedule" ? "▦" : "♙"} <span className="ml-3">{tab}</span>
              </button>
            ))}
          </nav>

          <div className="mt-auto rounded-2xl bg-slate-900 p-4 text-white">
            <p className="text-sm font-semibold">A better way to plan.</p>
            <p className="mt-2 text-xs leading-5 text-slate-300">Keep shifts clear, teams aligned, and every week organized.</p>
            <div className="mt-4 h-1.5 rounded-full bg-slate-700"><div className="h-1.5 w-3/4 rounded-full bg-lime-300" /></div>
            <p className="mt-2 text-xs text-slate-400">Workspace preview</p>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-5 sm:px-8">
            <div>
              <p className="text-xs font-medium text-slate-500">WORKSPACE / ROTA</p>
              <h1 className="mt-1 text-xl font-bold sm:text-2xl">{activeTab}</h1>
            </div>
            <button onClick={() => { setShowForm(true); setNotice(""); setError(""); }}
              className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-700">
              + Add shift
            </button>
          </header>

          <div className="p-5 sm:p-8">
            {notice && <div role="status" className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}
            {error && (
              <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {error}
                <button onClick={() => void loadShifts()} className="ml-3 font-semibold underline">Retry</button>
              </div>
            )}

            {activeTab === "Team" ? (
              <div>
                <p className="mb-5 text-slate-500">Manage your team at a glance.</p>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {team.map((member) => (
                    <article key={member.name} className="rounded-2xl border border-slate-200 bg-white p-5">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-lime-100 font-bold">{member.initials}</div>
                        <div><h2 className="font-semibold">{member.name}</h2><p className="text-sm text-slate-500">{member.role}</p></div>
                      </div>
                      <p className="mt-5 text-sm text-slate-600">Status: <span className="font-semibold">{member.status}</span></p>
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <article className="rounded-2xl border border-slate-200 bg-white p-5">
                    <p className="text-sm text-slate-500">Scheduled shifts</p>
                    <p className="mt-3 text-3xl font-bold">{schedule.length}</p>
                    <p className="mt-2 text-xs text-emerald-700">Saved in the database</p>
                  </article>
                  <article className="rounded-2xl border border-slate-200 bg-white p-5">
                    <p className="text-sm text-slate-500">Team members</p>
                    <p className="mt-3 text-3xl font-bold">{team.length}</p>
                    <p className="mt-2 text-xs text-slate-500">In this workspace</p>
                  </article>
                  <article className="rounded-2xl bg-lime-200 p-5">
                    <p className="text-sm text-slate-700">Planning tip</p>
                    <p className="mt-3 text-lg font-bold">Plan ahead.</p>
                    <p className="mt-2 text-sm text-slate-700">Clear shifts help everyone know where they need to be.</p>
                  </article>
                </div>

                <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Your workspace</p>
                    <h2 className="mt-2 text-2xl font-bold">Weekly schedule</h2>
                    <p className="mt-1 text-sm text-slate-500">Shifts retrieved from your database.</p>
                  </div>
                  <button onClick={() => setActiveTab(activeTab === "Schedule" ? "Overview" : "Schedule")}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50">
                    {activeTab === "Schedule" ? "Back to overview" : "View full schedule"} →
                  </button>
                </div>

                {loading ? (
                  <p className="mt-5 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading shifts…</p>
                ) : schedule.length === 0 ? (
                  <p className="mt-5 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">No shifts yet. Select “Add shift” to create your first one.</p>
                ) : (
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {visibleSchedule.map((shift) => (
                      <article key={shift.id} className="rounded-2xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-sm">
                        <div className="flex items-start justify-between">
                          <div><p className="text-xs font-bold tracking-widest text-slate-400">{shift.day}</p><p className="mt-1 text-2xl font-bold">{shift.date}</p></div>
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${shift.color}`}>Scheduled</span>
                        </div>
                        <div className="my-5 h-px bg-slate-100" />
                        <h3 className="font-semibold">{shift.name}</h3>
                        <p className="mt-1 text-sm text-slate-500">{shift.role}</p>
                        <p className="mt-4 text-sm font-semibold">{shift.start} – {shift.end}</p>
                      </article>
                    ))}
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

      {showForm && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-950/40 p-4">
          <form onSubmit={addShift} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-6 flex items-center justify-between">
              <div><h2 className="text-xl font-bold">Add a shift</h2><p className="mt-1 text-sm text-slate-500">Save a shift to your database.</p></div>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-lg px-3 py-2 text-slate-500 hover:bg-slate-100" aria-label="Close">✕</button>
            </div>

            <label className="mb-2 block text-sm font-medium" htmlFor="employee">Team member name</label>
            <input id="employee" required maxLength={100} value={employee} onChange={(e) => setEmployee(e.target.value)} placeholder="e.g. Chika Nwosu" className="mb-4 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-lime-500" />

            <label className="mb-2 block text-sm font-medium" htmlFor="role">Role</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value)} className="mb-4 w-full rounded-xl border border-slate-300 bg-white px-3 py-3">
              <option>Front Desk</option><option>Operations</option><option>Customer Support</option><option>Supervisor</option><option>Frontend Developer</option>
            </select>

            <label className="mb-2 block text-sm font-medium" htmlFor="day">Shift date</label>
            <input id="day" type="date" required value={day} onChange={(e) => setDay(e.target.value)} className="mb-6 w-full rounded-xl border border-slate-300 bg-white px-3 py-3" />

            <button type="submit" disabled={saving} className="w-full rounded-xl bg-slate-900 px-4 py-3 font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60">
              {saving ? "Saving…" : "Save shift"}
            </button>
          </form>
        </div>
      )}
    </main>
  );
}