# Rota — Workforce Scheduling & Shift Management

A shift scheduling and workforce management web application built with Next.js App Router, backed by Neon Serverless PostgreSQL, and secured with native cryptographic session authentication and role-based access control (RBAC).

* **Live Web Application:** [https://rota-lovat-gamma.vercel.app/](https://rota-lovat-gamma.vercel.app/)
* **Repository:** [https://github.com/umehchinaemeze-a11y/rota](https://github.com/umehchinaemeze-a11y/rota)
* **Technical Documentation:** [TECHNICAL-DOCUMENTATION.md](TECHNICAL-DOCUMENTATION.md)
* **Architecture Diagram:** [docs/architecture.md](docs/architecture.md)

---

## Verified Capabilities & Current Features

* **Shift Scheduling Dashboard:** Weekly calendar view displaying upcoming shifts, daily schedules, role badges, active team members on shift, and total shift counts (`app/page.tsx`).
* **PostgreSQL Persistence:** Persistent shift storage and retrieval backed by Neon Serverless PostgreSQL with parameterized SQL queries.
* **Authentication Implementation:**
  * Credential verification using Scrypt password hashing with unique 16-byte cryptographically secure random salts and constant-time buffer comparison (`lib/auth.ts`).
  * Stateless session tokens signed with HMAC-SHA256 using server-side `AUTH_SECRET` (`lib/auth.ts`).
  * Hardened cookie delivery using `rota_session` with `HttpOnly`, `SameSite=Lax`, and `Secure` flags in production environments (`lib/session.ts`).
* **Server-Side Authorization (RBAC):**
  * Centralized server-side gate (`canManageShiftRecord` in `lib/permissions.ts`) enforcing strict ownership checks against verified database user records.
  * Management roles (`Supervisor`, `Operations`, `Admin`) have authority to schedule, edit, reassign, and delete any shift.
  * Standard roles (`Front Desk`, `Customer Support`, `Frontend Developer`) are locked to their own account identity: they cannot edit shifts assigned to others, cannot reassign shifts, and cannot claim unassigned legacy records (`user_id IS NULL`).
* **Safe Profile Sanitization:** Authentication endpoints return only public profile information (`id`, `email`, `name`, `role`), preventing exposure of password hashes, salts, or signing keys.

---

## API Endpoints

The application implements modular Next.js route handlers under `app/api/`:

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Public | Validates credentials, checks Scrypt hash, and issues `rota_session` cookie |
| `POST` | `/api/auth/logout` | Public | Clears session cookie by setting `maxAge: 0` |
| `GET` | `/api/auth/me` | Public/Cookie | Returns sanitized session user profile or 401 unauthenticated response |
| `GET` | `/api/shifts` | Public | Returns all shifts ordered chronologically (`shift_day ASC, id ASC`) |
| `POST` | `/api/shifts` | Authenticated | Creates a new shift record; validates date and enforces caller role boundaries |
| `GET` | `/api/shifts/[id]` | Public | Retrieves a single shift record by numeric ID |
| `PUT` | `/api/shifts/[id]` | Authenticated | Updates an existing shift; enforces `canManageShiftRecord` ownership check |
| `DELETE` | `/api/shifts/[id]` | Authenticated | Deletes a shift record; enforces `canManageShiftRecord` ownership check |

---

## Technology Stack

Confirmed directly from `package.json`:

* **Web Framework:** Next.js `16.4.0` (App Router, Turbopack)
* **UI Library:** React `19.3.0` & React-DOM `19.3.0`
* **Language:** TypeScript `^5`
* **Styling:** Tailwind CSS `^4` (via `@tailwindcss/turbopack`)
* **Database Client:** `@neondatabase/serverless` `^1.2.0` (Neon Serverless PostgreSQL)
* **Authentication Primitives:** Node.js native `node:crypto` (`scryptSync`, `timingSafeEqual`, `createHmac`, `randomBytes`)
* **Testing:** Node.js Native Test Runner (`node:test`, `node:assert`)
* **Mobile Runtime:** Capacitor `^8.5.3` (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android`)
* **Deployment Platform:** Vercel (Edge Routing & Serverless Functions)

---

## Environment Variables

Configure the following environment variables in `.env.local` for local execution. Never commit real values or secrets to version control.

```text
# Neon Serverless PostgreSQL connection string (pooled connection mode)
DATABASE_URL="postgresql://user:password@host-pooler.region.neon.tech/dbname?sslmode=require"

# Cryptographic secret key used to sign and verify HMAC-SHA256 session tokens
AUTH_SECRET="your-secure-random-cryptographic-secret-key-at-least-32-chars"
```

---

## Local Development & Setup

Instructions for Windows Command Prompt (`cmd.exe`):

1. **Navigate to the web project directory:**
   ```cmd
   cd rota\web
   ```

2. **Install project dependencies:**
   ```cmd
   npm install
   ```

3. **Configure local environment variables:**
   Create a `.env.local` file in `rota\web` containing your placeholder or development credentials:
   ```cmd
   type nul > .env.local
   ```
   Edit `.env.local` in your editor to define `DATABASE_URL` and `AUTH_SECRET`.

4. **Start the development server:**
   ```cmd
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

5. **Build for production:**
   ```cmd
   npm run build
   ```

6. **Start production server locally:**
   ```cmd
   npm run start
   ```

---

## Automated Testing

Rota includes zero-dependency automated unit and security tests executed via Node.js native test runner:

```cmd
npm test
```

*Executes:* `node --experimental-strip-types --test tests/shifts.test.mjs`

### Test Suite Summary (32 Tests Passing across 6 Suites):
1. **Password Hashing & Constant-Time Verification (5 tests):** Validates unique salt generation, matching hash verification, incorrect password rejection, invalid input type handling, and non-hex salt handling.
2. **Session Token Security (8 tests):** Validates HMAC-SHA256 creation, missing `AUTH_SECRET` guard, secret mismatch rejection, tampered payload detection (privilege escalation), tampered signature detection, expiration enforcement, and malformed token handling.
3. **Server-Side Shift Authorization (6 tests):** Validates unauthenticated request denial, owner edit/delete permission, non-owner modification denial, legacy unassigned record (`user_id IS NULL`) protection, manager override authority, and rejection of client header impersonation claims.
4. **Login Input Validation & Sanitization (4 tests):** Validates missing email handling, missing password handling, email whitespace and lowercase normalization, and leak-free profile exposure.
5. **Shift Payload & ID Validation (5 tests):** Validates schema acceptance, date format regex enforcement, invalid calendar date rejection (e.g. February 31), and numeric ID validation.
6. **Schedule State Updates (4 tests):** Validates update idempotency, chronological date sorting, immediate shift deletion, and unique ID additions.

*Note:* These tests verify cryptographic functions, authorization gates, and data validation rules in isolation. They do not claim full end-to-end integration coverage across external cloud networks or formal third-party security certification.

---

## Android Development Build Explanation

An Android mobile wrapper project is configured in `android/` using Capacitor (`com.rota.app`):

* **Architecture:** The mobile app functions as a native Android WebView wrapper around the hosted web application.
* **Server Connection:** In `capacitor.config.ts`, `server.url` is explicitly configured to `https://rota-lovat-gamma.vercel.app/` with `androidScheme: 'https'`.
* **Network Dependency:** Because the Capacitor shell points directly to the hosted production URL, the Android application requires an active internet connection to load and operate. It does not bundle an offline SQLite/Room database or local Node.js runtime.
* **Scope Note:** Native Android interactive authentication and offline background caching are not verified as implemented.

---

## Honest Project Limitations & Unimplemented Scope

In accordance with engineering integrity and project audit requirements, the following capabilities are explicitly documented as **not currently verified or implemented** in the existing codebase:

* **Self-Service Sign-up:** No public account registration page or self-service signup endpoint exists. User accounts must be created administratively via database scripts.
* **Team Invitations:** No team member invitation links, invitation tokens, or email invitation dispatch mechanisms are implemented.
* **Multi-Tenant / Team Isolation:** The database schema consists of a single global `shifts` and `users` table without `teams`, `organizations`, or tenant boundaries. All users share the same workspace calendar.
* **Subscription Plans & Proration:** No subscription tiers, Stripe checkout sessions, webhook handlers, seat limit enforcement, immutable billing ledgers, or proration calculation algorithms/tests exist.
* **Shift Swaps & Approvals:** No peer-to-peer shift trade proposals or supervisor swap approval workflows are implemented.
* **Push Notifications:** No push token registry, background notification worker jobs, notification preferences, quiet hours intervals, or timezone scheduling logic exist.
* **Offline Viewing:** No Service Worker, Cache Storage API, or local IndexedDB shift store is present. The app cannot display shifts when disconnected from the network.
* **200-VU Load Testing:** No automated 200-virtual-user concurrency load tests or benchmark reports have been executed against the Rota API.
* **Real-Time Synchronization:** Shifts update on page load or after explicit user mutation. No WebSockets or Server-Sent Events (SSE) cross-device synchronization exists.
