"use client";

import { useState } from "react";

type GoogleAccountSettingsProps = {
  googleLinked: boolean;
  hasPassword: boolean;
  onStatusChange?: () => void | Promise<void>;
};

export default function GoogleAccountSettings({
  googleLinked,
  hasPassword,
  onStatusChange,
}: GoogleAccountSettingsProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleLink(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setSuccess("");

    if (!password) {
      setError("Enter your current password to link Google.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/auth/google/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, redirect: "/" }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || typeof data?.authorizationUrl !== "string") {
        setError(data?.error || "Unable to start Google linking.");
        return;
      }

      window.location.assign(data.authorizationUrl);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlink(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setSuccess("");

    if (!password) {
      setError("Enter your current password to unlink Google.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/auth/google/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setError(data?.error || "Unable to unlink Google.");
        return;
      }

      setPassword("");
      setSuccess("Google account unlinked. Password sign-in remains active.");
      await onStatusChange?.();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-5">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
        Google Account
      </p>

      <div className="space-y-2 text-sm text-slate-700">
        <p>
          <span className="text-slate-500">Status:</span>{" "}
          <strong className={googleLinked ? "text-emerald-700" : "text-slate-700"}>
            {googleLinked ? "Linked" : "Not linked"}
          </strong>
        </p>
        <p className="text-xs text-slate-500">
          {googleLinked
            ? "You can sign in with Google or your password."
            : "Link Google to sign in with one click. Your password remains active."}
        </p>
      </div>

      {googleLinked && !hasPassword ? (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Google is your only sign-in method. Set a password before unlinking it.
        </p>
      ) : (
        <form
          onSubmit={googleLinked ? handleUnlink : handleLink}
          className="mt-4 space-y-3"
        >
          <label
            htmlFor="google-account-password"
            className="block text-xs font-semibold uppercase tracking-wider text-slate-600"
          >
            Confirm Password
          </label>
          <input
            id="google-account-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10 transition disabled:opacity-60"
            placeholder="Current password"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900/30 transition disabled:opacity-50"
          >
            {busy
              ? "Please wait..."
              : googleLinked
                ? "Unlink Google"
                : "Link Google"}
          </button>
        </form>
      )}

      {error && (
        <p className="mt-3 text-xs font-medium text-rose-700" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="mt-3 text-xs font-medium text-emerald-700" role="status">
          {success}
        </p>
      )}
    </div>
  );
}
