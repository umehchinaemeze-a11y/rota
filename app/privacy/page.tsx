import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Rota",
  description:
    "Privacy Policy and data processing practices for the Rota team scheduling and workforce management platform.",
};

export default function PrivacyPolicyPage() {
  const lastUpdated = "November 8, 2026";
  const contactEmail = "umehchinaemeze@gmail.com";

  return (
    <div className="min-h-screen bg-[#f7f8f5] text-slate-900 flex flex-col font-sans antialiased">
      {/* Navigation Header */}
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
            <Link
              href="/sign-in"
              className="text-slate-600 hover:text-slate-900 font-medium px-3 py-1.5 rounded-lg transition"
            >
              Sign In
            </Link>
            <Link
              href="/sign-up"
              className="bg-slate-900 text-white hover:bg-slate-800 font-semibold px-3.5 py-1.5 rounded-lg text-xs shadow-xs transition"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 py-10 sm:py-16 px-4 sm:px-6 lg:px-8">
        <article className="max-w-3xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-xs p-6 sm:p-10 lg:p-12 space-y-10 text-slate-700 leading-relaxed text-sm sm:text-base">
          {/* Header section */}
          <div className="border-b border-slate-100 pb-8 space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Legal & Transparency
            </span>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">
              Privacy Policy
            </h1>
            <p className="text-xs text-slate-500">
              Effective Date: {lastUpdated}
            </p>
            <p className="pt-2 text-slate-600 text-sm leading-normal">
              This Privacy Policy explains how <strong>Rota</strong> (&ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;the platform&rdquo;) collects, processes, stores, and protects your information when you access or use our team scheduling and workforce management services.
            </p>
          </div>

          {/* Section 1: Information We Collect */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              1. Information We Collect and Why
            </h2>
            <p>
              Rota collects information necessary to deliver clinical and operational team scheduling, multi-tenant workspace management, and secure account access:
            </p>
            <ul className="list-disc pl-5 space-y-2 text-slate-600">
              <li>
                <strong>Account Credentials & Profile Details:</strong> When registering an account, we collect your full name, email address, assigned platform role (such as Front Desk, Supervisor, Operations, or Admin), and password credentials.
              </li>
              <li>
                <strong>Workspace & Scheduling Data:</strong> Workspace/clinic names, team assignments, shift rosters (including employee names, shift start and end times, assigned roles, and operational shift notes).
              </li>
              <li>
                <strong>Authentication Identifiers:</strong> Authenticated session tokens, timestamps of account creation, and last login events.
              </li>
            </ul>
          </section>

          {/* Section 2: Google Sign-In */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              2. Google Authentication & Account Linking
            </h2>
            <p>
              Rota supports federated sign-in through Google OpenID Connect (OIDC). If you choose to sign in or link your account using Google:
            </p>
            <ul className="list-disc pl-5 space-y-2 text-slate-600">
              <li>
                <strong>Data Received from Google:</strong> We receive and verify your unique Google account subject identifier (<code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">sub</code>), primary email address, email verification status (<code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">email_verified</code>), and display name.
              </li>
              <li>
                <strong>OAuth Scopes:</strong> Rota requests strictly basic identity scopes: <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">openid</code>, <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">email</code>, and <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">profile</code>. We do not request access to Google Drive, Google Calendar, Gmail, contacts, or other Google services.
              </li>
              <li>
                <strong>Identity Linking & Collision Protection:</strong> If you authenticate with Google using an email that matches an existing password-protected Rota account, automatic linking is blocked. You must authenticate with your existing password first before explicitly linking your Google identity from Settings.
              </li>
              <li>
                <strong>Identity Unlinking:</strong> You may unlink your Google identity at any time in Account Settings, provided your account has an established password.
              </li>
            </ul>
          </section>

          {/* Section 3: Password Security and Cookies */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              3. Password Hashing & Session Cookies
            </h2>
            <div className="space-y-2 text-slate-600">
              <p>
                <strong>Cryptographic Password Protection:</strong> User passwords are never stored in plaintext. Passwords are cryptographically transformed using the memory-hard Scrypt key derivation function paired with unique 16-byte random cryptographic salts. Rota staff cannot view or retrieve your password.
              </p>
              <p>
                <strong>Cookie Usage:</strong> Rota uses essential cookies strictly for security and authentication state:
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>
                  <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">rota_session</code>: A signed HMAC-SHA256 cookie that securely maintains your active login session (<code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">HttpOnly</code>, <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">SameSite=Lax</code>, expiring in 7 days, <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">Secure</code> on production).
                </li>
                <li>
                  <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">rota_oauth_state</code>: A short-lived (10-minute) anti-forgery token protecting against Cross-Site Request Forgery (CSRF) during OAuth authentication flows.
                </li>
              </ul>
              <p className="text-xs text-slate-500">
                Rota does not use tracking cookies, third-party advertising cookies, or browser fingerprinting technologies.
              </p>
            </div>
          </section>

          {/* Section 4: Multi-Tenant Workspace & Shift Isolation */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              4. Workspaces, Team Memberships & Shift Data
            </h2>
            <p>
              Rota operates as a multi-tenant platform:
            </p>
            <ul className="list-disc pl-5 space-y-2 text-slate-600">
              <li>
                <strong>Tenant Boundary Isolation:</strong> Each workspace is isolated at the database layer. Shift schedules, swap proposals, and team rosters created within an organization are accessible only to authenticated users admitted to that specific workspace.
              </li>
              <li>
                <strong>Role-Based Access Control (RBAC):</strong> Access to modify schedules, approve shift swaps, or manage team membership is restricted according to assigned workspace roles (Owner, Admin, Supervisor, Staff).
              </li>
            </ul>
          </section>

          {/* Section 5: Paystack Payment Processing */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              5. Paystack Payments & Billing Information
            </h2>
            <div className="space-y-2 text-slate-600">
              <p>
                Paid subscription tiers (Starter, Pro, Enterprise) are billed through our payment processor, <strong>Paystack Payments Limited</strong>.
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong>Payment Card Security:</strong> Rota <strong>never</strong> collects, processes, or stores your full credit or debit card numbers, PINs, or CVV/CVC security codes. Payment card details are entered directly into Paystack&apos;s PCI-DSS compliant checkout frame.
                </li>
                <li>
                  <strong>Masked Card Information:</strong> For display in your Billing dashboard, Rota stores only non-sensitive card metadata returned by the payment gateway: card brand (e.g. Visa, Mastercard), the last 4 digits of the card, expiration month/year, and issuing bank.
                </li>
                <li>
                  <strong>Encrypted Authorization References:</strong> For automated recurring monthly renewals, reusable payment authorization codes are encrypted at rest using AES-256-GCM. Plaintext authorization codes are never logged or stored.
                </li>
                <li>
                  <strong>Billing Records:</strong> We record transaction references, monetary amounts in Nigerian Naira kobo, plan tiers, and invoice dates in an internal billing ledger to maintain subscription status.
                </li>
              </ul>
            </div>
          </section>

          {/* Section 6: Third-Party Service Providers */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              6. Service Providers & Data Disclosures
            </h2>
            <p>
              We disclose information to trusted infrastructure and service providers solely to operate our application:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm border border-slate-200 rounded-lg overflow-hidden">
                <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Service Provider</th>
                    <th className="py-2.5 px-3">Role & Purpose</th>
                    <th className="py-2.5 px-3">Data Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-600">
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">Google LLC</td>
                    <td className="py-2.5 px-3">OAuth 2.0 Identity Provider</td>
                    <td className="py-2.5 px-3">Authorization code exchange, ID token claim verification (email, name, sub).</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">Paystack Payments Limited</td>
                    <td className="py-2.5 px-3">Payment Gateway & Subscription Billing</td>
                    <td className="py-2.5 px-3">Customer email, transaction amounts, workspace reference, and payment tokens.</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">Neon Inc. (AWS us-east-2)</td>
                    <td className="py-2.5 px-3">Serverless PostgreSQL Cloud Database</td>
                    <td className="py-2.5 px-3">Encrypted database storage for user accounts, workspaces, shifts, and billing records.</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">Vercel Inc.</td>
                    <td className="py-2.5 px-3">Cloud Hosting & Edge Network Delivery</td>
                    <td className="py-2.5 px-3">Serverless execution, incoming IP addresses, and standard web request traffic logs.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">
              Rota does not sell, rent, or trade your personal information to third parties, advertising networks, or data brokers.
            </p>
          </section>

          {/* Section 7: Analytics and Telemetry */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              7. Analytics & External Tracking
            </h2>
            <p className="text-slate-600">
              Rota does not integrate third-party marketing analytics (such as Google Analytics, PostHog, Mixpanel, or Meta Pixels). Application typography assets are self-hosted locally on our servers and do not generate requests to external font CDNs. Server-side diagnostic logs are strictly filtered to redact connection strings, passwords, and private tokens.
            </p>
          </section>

          {/* Section 8: Account Deletion and Data Retention */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              8. Account Deletion & Data Retention
            </h2>
            <div className="space-y-2 text-slate-600">
              <p>
                <strong>Account Deletion Requests:</strong> Rota does not currently offer an automated self-service account deletion button in the user settings interface. To request full deletion of your user account, profile details, and associated workspace memberships, please submit an email request to our privacy team at{" "}
                <a
                  href={`mailto:${contactEmail}`}
                  className="font-medium text-slate-900 underline hover:text-slate-700"
                >
                  {contactEmail}
                </a>.
              </p>
              <p>
                <strong>Retention of Financial Records:</strong> When a user account or workspace is closed, historical transaction and audit records stored in our billing ledger (<code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">billing_ledger</code> and <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-800">billing_events</code>) may be retained as necessary to fulfill legal obligations, resolve financial discrepancies, maintain tax records, and enforce our agreements.
              </p>
            </div>
          </section>

          {/* Section 9: Security Practices */}
          <section className="space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              9. Security Safeguards
            </h2>
            <p className="text-slate-600">
              We implement industry-standard technical and operational measures designed to safeguard your information, including TLS encryption for data in transit, AES-256-GCM encryption for stored recurring billing references, Scrypt password hashing with unique random salts, HTTP-only session cookies, and multi-tenant database isolation.
            </p>
            <p className="text-slate-600">
              However, please note that no method of transmission over the Internet or method of electronic storage is completely secure. While we strive to protect your personal data using commercially reasonable practices, we cannot guarantee absolute security.
            </p>
          </section>

          {/* Section 10: Contact Information */}
          <section className="border-t border-slate-100 pt-8 space-y-3">
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              10. Contact Us
            </h2>
            <p className="text-slate-600">
              If you have any questions, concerns, or requests regarding this Privacy Policy or your personal information, please reach out to us:
            </p>
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 text-sm space-y-1">
              <p className="font-semibold text-slate-900">Rota Privacy & Support Team</p>
              <p className="text-slate-600">
                Email:{" "}
                <a
                  href={`mailto:${contactEmail}`}
                  className="text-slate-900 font-medium underline hover:text-slate-700"
                >
                  {contactEmail}
                </a>
              </p>
            </div>
          </section>
        </article>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-6 text-center text-xs text-slate-500">
        <div className="max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p>&copy; 2026 Rota. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <Link href="/" className="hover:text-slate-800 transition">
              Home
            </Link>
            <Link href="/sign-in" className="hover:text-slate-800 transition">
              Sign In
            </Link>
            <Link href="/privacy" className="text-slate-900 font-semibold">
              Privacy Policy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
