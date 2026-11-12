"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

interface InvitationData {
  teamId: number;
  teamName: string;
  role: string;
  invitedByName: string;
  email?: string | null;
  expiresAt: number;
}

interface CurrentUser {
  id: number;
  email: string;
  name: string;
  role: string;
}

function InvitationContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const hasToken = typeof token === "string" && token.trim().length > 0;

  const [loading, setLoading] = useState(hasToken);
  const [error, setError] = useState(
    hasToken ? "" : "No invitation token was provided in the link."
  );
  const [invitation, setInvitation] = useState<InvitationData | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [prevToken, setPrevToken] = useState(token);

  // If token changes while component remains mounted, synchronize state cleanly during render
  if (token !== prevToken) {
    setPrevToken(token);
    if (!hasToken) {
      setLoading(false);
      setError("No invitation token was provided in the link.");
      setInvitation(null);
    } else {
      setLoading(true);
      setError("");
      setInvitation(null);
    }
  }

  useEffect(() => {
    if (!hasToken) {
      return;
    }

    let active = true;

    async function loadData() {
      try {
        // 1. Verify invitation token
        const inviteRes = await fetch(
          `/api/teams/invitations?token=${encodeURIComponent(token!)}`
        );
        const inviteData = await inviteRes.json();
        if (!active) return;

        if (!inviteRes.ok || !inviteData.valid) {
          setError(inviteData.error || "This invitation link is invalid or has expired.");
          setLoading(false);
          return;
        }

        setInvitation(inviteData);

        // 2. Check active session
        try {
          const authRes = await fetch("/api/auth/me");
          if (authRes.ok) {
            const authData = await authRes.json();
            if (active && authData.user) {
              setCurrentUser(authData.user);
            }
          }
        } catch {
          // Unauthenticated or network issue
        }
      } catch {
        if (active) {
          setError("Unable to verify invitation. Please check your internet connection.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      active = false;
    };
  }, [hasToken, token]);

  async function handleAccept() {
    if (!token || accepting) return;
    setAccepting(true);
    setError("");

    try {
      const res = await fetch("/api/teams/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to accept invitation.");
        setAccepting(false);
        return;
      }

      setSuccessMessage(data.message || `Successfully joined ${invitation?.teamName}!`);
      setTimeout(() => {
        router.push("/");
      }, 1500);
    } catch {
      setError("Network error while accepting invitation. Please try again.");
      setAccepting(false);
    }
  }

  const returnUrl = token ? `/invite?token=${encodeURIComponent(token)}` : "/";

  return (
    <div className="min-h-screen bg-[#f7f8f5] text-slate-900 flex flex-col font-sans antialiased">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2.5 font-black tracking-tight text-xl text-slate-900 hover:opacity-90 transition"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white text-sm font-bold shadow-xs">
              R
            </span>
            <span>ROTA</span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            {currentUser ? (
              <span className="text-xs text-slate-500 font-medium">
                Signed in as <strong className="text-slate-800">{currentUser.name}</strong>
              </span>
            ) : (
              <Link
                href={`/sign-in?returnTo=${encodeURIComponent(returnUrl)}`}
                className="text-slate-600 hover:text-slate-900 font-medium px-3 py-1.5 rounded-lg transition"
              >
                Sign In
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 space-y-6">
          {loading && (
            <div className="text-center py-10 space-y-3">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" />
              <p className="text-sm text-slate-500 font-medium">Verifying invitation details...</p>
            </div>
          )}

          {!loading && error && (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-100 text-rose-600 text-xl font-bold">
                ✕
              </div>
              <h2 className="text-xl font-bold text-slate-900">Invitation Error</h2>
              <p className="text-sm text-slate-600 leading-relaxed">{error}</p>
              <div className="pt-2">
                <Link
                  href="/"
                  className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-slate-800 transition"
                >
                  Return to Dashboard
                </Link>
              </div>
            </div>
          )}

          {!loading && !error && successMessage && (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 text-xl font-bold">
                ✓
              </div>
              <h2 className="text-xl font-bold text-slate-900">Welcome to the Team!</h2>
              <p className="text-sm text-slate-600">{successMessage}</p>
              <p className="text-xs text-slate-400">Redirecting to your workspace schedule...</p>
            </div>
          )}

          {!loading && !error && !successMessage && invitation && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Workspace Invitation
                </span>
                <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
                  Join {invitation.teamName}
                </h1>
                <p className="text-sm text-slate-600">
                  <strong className="text-slate-800">{invitation.invitedByName}</strong> has invited you to join their scheduling roster.
                </p>
              </div>

              {/* Role badge card */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Target Role:</span>
                  <span className="font-semibold text-slate-900 bg-white border border-slate-200 px-2.5 py-0.5 rounded-md text-xs shadow-2xs">
                    {invitation.role}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Workspace:</span>
                  <span className="font-semibold text-slate-900">{invitation.teamName}</span>
                </div>
                {invitation.email && (
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Invited Email:</span>
                    <span className="text-slate-700 font-mono text-xs">{invitation.email}</span>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              {currentUser ? (
                <div className="space-y-3">
                  <button
                    onClick={handleAccept}
                    disabled={accepting}
                    className="w-full rounded-lg bg-slate-900 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-slate-800 focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 transition disabled:opacity-50"
                  >
                    {accepting ? "Joining Workspace..." : `Accept Invitation & Join ${invitation.teamName}`}
                  </button>
                  <p className="text-center text-xs text-slate-400">
                    You will be added to this workspace with the <strong>{invitation.role}</strong> role.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-center text-slate-500">
                    Sign in or create an account to accept this invitation:
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <Link
                      href={`/sign-in?returnTo=${encodeURIComponent(returnUrl)}`}
                      className="flex items-center justify-center rounded-lg border border-slate-300 bg-white py-2 text-sm font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition"
                    >
                      Sign In
                    </Link>
                    <Link
                      href={`/sign-up?returnTo=${encodeURIComponent(returnUrl)}`}
                      className="flex items-center justify-center rounded-lg bg-slate-900 py-2 text-sm font-semibold text-white shadow-xs hover:bg-slate-800 transition"
                    >
                      Create Account
                    </Link>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-4 text-center text-xs text-slate-400">
        <span>Rota · Workforce Scheduling & Shift Management</span>
      </footer>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#f7f8f5] flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" />
        </div>
      }
    >
      <InvitationContent />
    </Suspense>
  );
}

