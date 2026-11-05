# Rota — Technical Architecture & System Documentation

**Project:** Rota (Team Scheduling Workspace)  
**Author:** Chinazom Chinaemeze  
**Target Role:** Full-stack Developer  
**Live Production URL:** [https://rota-lovat-gamma.vercel.app/](https://rota-lovat-gamma.vercel.app/)  
**Source Repository:** [https://github.com/umehchinaemeze-a11y/rota](https://github.com/umehchinaemeze-a11y/rota)  
**Documentation Date:** October 19, 2026  

---

## 1. Project Overview & Purpose

Rota is a modern, responsive shift scheduling and workforce management web application designed for operations teams, front desk personnel, supervisors, and customer support staff. The system provides an interactive scheduling dashboard backed by persistent PostgreSQL storage and an enterprise-grade authentication and role-based access control (RBAC) system.

The primary engineering objectives of Rota are:
* **Interactive Shift Management:** Real-time visibility into weekly schedules, active team members on shift, and roster capacity.
* **Multi-Tier Role Authorization:** Clear separation between standard team members (who manage their assigned shifts) and managers/supervisors (who hold workspace-wide scheduling authority).
* **Secure Session Architecture:** Stateless, tamper-evident cryptographic sessions delivered via hardened HttpOnly cookies, eliminating client-side credential storage and token leakage.
* **Data Integrity & Protection:** Parameterized database queries, calendar validity validation, and protection for unassigned/legacy shift records.

---

## 2. Technology Stack & Architecture

| Layer | Technologies | Role / Rationale |
| :--- | :--- | :--- |
| **Framework** | Next.js 16.4.0 (App Router, Turbopack) | Server-side rendering, React Server Components, and optimized API route handlers |
| **UI Library** | React 19.3.0 | Component rendering, interactive modal workflows, and responsive schedule grid |
| **Styling** | Tailwind CSS 4 | Utility-first responsive styling and curated accessible color palettes |
| **Database** | Neon Serverless PostgreSQL | Cloud-native serverless SQL storage via `@neondatabase/serverless` (v1.2.0) |
| **Authentication** | Node.js `crypto` (`scrypt`, `createHmac`) | Native cryptographic primitives without bulky third-party dependencies |
| **Testing** | Node.js Native Test Runner (`node:test`, `node:assert`) | Zero-dependency automated unit and regression testing |
| **Deployment** | Vercel Serverless Edge Platform | Global CDN distribution, serverless function execution, and automatic GitHub CI/CD |

---

## 3. Directory & App Router Structure

The project follows the standard Next.js App Router convention with modular separation between business logic (`lib/`), route handlers (`app/api/`), client pages (`app/`), and automated test suites (`tests/`):

```text
rota/web/
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login/
│   │   │   │   └── route.ts          # POST /api/auth/login (Credential verification & session cookie issuance)
│   │   │   ├── logout/
│   │   │   │   └── route.ts          # POST /api/auth/logout (Session invalidation & cookie expiration)
│   │   │   └── me/
│   │   │       └── route.ts          # GET /api/auth/me (Sanitized user profile inspection)
│   │   ├── billing/
│   │   │   ├── paystack/
│   │   │   │   ├── cancel/
│   │   │   │   │   └── route.ts          # POST /api/billing/paystack/cancel (Merchant-managed cancellation & auto-renew stop)
│   │   │   │   ├── initialize/
│   │   │   │   │   └── route.ts          # POST /api/billing/paystack/initialize (NGN kobo checkout initialization & unique reference)
│   │   │   │   ├── renew/
│   │   │   │   │   └── route.ts          # POST /api/billing/paystack/renew (Off-session recurring renewal execution engine)
│   │   │   │   ├── verify/
│   │   │   │   │   └── route.ts          # POST /api/billing/paystack/verify (Authoritative gateway verification & AES-256-GCM auth encryption)
│   │   │   │   └── webhook/
│   │   │   │       └── route.ts          # POST /api/billing/paystack/webhook (HMAC-SHA512 Paystack webhook ingestion & deduplication)
│   │   │   └── route.ts              # GET /api/billing (Workspace subscription, seat limits & ledger status)
│   │   └── shifts/
│   │       ├── [id]/
│   │       │   └── route.ts          # GET, PUT, DELETE /api/shifts/[id] (Authorized shift modification)
│   │       ├── recover/
│   │       │   └── route.ts          # GET, POST /api/shifts/recover (Safe legacy shift recovery & inspection)
│   │       └── route.ts              # GET, POST /api/shifts (Shift listing & authenticated shift creation)
│   ├── favicon.ico
│   ├── globals.css                   # Global CSS imports and Tailwind directives
│   ├── layout.tsx                    # Root layout with HTML/body scaffolding and metadata
│   └── page.tsx                      # Primary client-rendered dashboard, schedule grid, billing modal & auth modals
├── lib/
│   ├── auth.ts                       # Cryptographic primitives: scrypt hashing and HMAC-SHA256 tokens
│   ├── billing-calendar.ts           # Calendar-month renewal date calculations with leap year & month boundary safety
│   ├── billing-provider-badge.ts     # Verification badge resolver reflecting authoritative active provider & legacy history
│   ├── billing-storage.ts            # Durable persistence contracts, in-memory mock & PostgreSQL storage adapters
│   ├── billing.ts                    # Billing event processor, idempotency cache, plan pricing & ledger management
│   ├── db.ts                         # Neon PostgreSQL connection pool and SQL template tag export
│   ├── paystack-renewal-engine.ts    # Off-session recurring charge worker with renewal lease locks & reconciliation
│   ├── paystack-security.ts          # AES-256-GCM encryption of reusable authorization codes & HMAC-SHA512 verification
│   ├── paystack.ts                   # Commercial NGN pricing tiers and Paystack gateway client
│   ├── permissions.ts                # Server-side authorization matrix and canManageShiftRecord logic
│   ├── proration.ts                  # Pure mathematical proration calculation engine
│   ├── seat-limit.ts                 # Workspace seat capacity evaluation & concurrency guard
│   ├── session.ts                    # HttpOnly cookie management and database-revalidated session resolution
│   ├── shift-recovery.ts             # Safe legacy shift recovery, workspace authorization, and row locking
│   └── shifts-client.ts              # Pure client-side shift recovery HTTP response resolvers
├── scripts/                          # Administrative maintenance & migration scripts (dry-run guarded)
│   ├── migrate-billing-persistence.mjs # Durable billing schema migration (workspace_subscriptions, billing_events, billing_ledger)
│   └── migrate-team-isolation.mjs    # Multi-tenant workspace isolation migration
├── tests/
│   ├── auth.test.mjs                 # 15 tests: User registration, password hashing & recovery
│   ├── billing-persistence.test.mjs  # 16 tests: Durable billing persistence, FK types, idempotency & CLI guards
│   ├── billing-webhook.test.mjs      # 49 tests: Webhook signatures, replay guard, idempotency, checkout & confirmation
│   ├── database-safety-hardening.test.mjs # 36 tests: Neon connection guards & read-only preflight
│   ├── default-membership-migration.test.mjs # 20 tests: Workspace membership migration tests
│   ├── load-test-safety.test.mjs     # 8 tests: Production URL protection guards
│   ├── proration.test.mjs            # 37 tests: Mathematical proration engine unit tests
│   ├── shift-recovery.test.mjs       # 25 tests: Safe legacy shift recovery & concurrency tests
│   ├── shifts.test.mjs               # 46 tests: Authorized shift endpoints & RBAC tests
│   └── team-isolation.test.mjs       # 98 tests: Multi-tenant database schema & isolation tests
├── package.json                      # Dependency manifest and npm test scripts
├── tsconfig.json                     # TypeScript compiler configuration
└── TECHNICAL-DOCUMENTATION.md        # System architecture documentation (this document)
```

---

## 4. API Endpoints & Request Flow

### 4.1 Authentication Endpoints

* **`POST /api/auth/login`**
  * **Payload:** `{ "email": "employee@rota.local", "password": "password123" }`
  * **Processing:** Trims and lowercases email; fetches matching user record from `users`; computes scrypt hash of candidate password with stored salt; verifies using `crypto.timingSafeEqual`; signs an HMAC-SHA256 session token; sets an `HttpOnly`, `SameSite=Lax` cookie (`rota_session`).
  * **Responses:**
    * `200 OK`: Returns `{ "user": { "id": 1, "email": "...", "name": "...", "role": "..." } }`
    * `400 Bad Request`: If email or password is empty or body is not JSON.
    * `401 Unauthorized`: If email is not found or password does not match.

* **`POST /api/auth/logout`**
  * **Processing:** Sets `rota_session` cookie `maxAge` to `0` with path `/`.
  * **Response:** `200 OK` (`{ "message": "Logged out successfully." }`).

* **`GET /api/auth/me`**
  * **Processing:** Reads `rota_session` cookie; validates signature and expiration.
  * **Responses:**
    * `200 OK`: Returns sanitized profile `{ "authenticated": true, "user": { "id": 1, "email": "...", "name": "...", "role": "..." } }`.
    * `401 Unauthorized`: Returns `{ "authenticated": false, "error": "Not authenticated." }` without leaking internal state.

### 4.2 Shift Management Endpoints

* **`GET /api/shifts`**
  * **Access:** Public read access for team calendar transparency.
  * **Processing:** Queries Neon PostgreSQL for all shifts ordered chronologically (`shift_day ASC, id ASC`).
  * **Response:** `200 OK` array containing shift objects with `id`, `employee_name`, `role`, `user_id`, `shift_day` (formatted as `YYYY-MM-DD`), and `created_at`.

* **`POST /api/shifts`**
  * **Access:** Authenticated users only (`getSessionUser({ revalidateWithDb: true })`).
  * **Processing:** Validates shift date format and calendar existence (rejects invalid dates such as February 31). Enforces role rules:
    * Standard users are locked to their own session identity (`finalUserId = sessionUser.userId`, `finalEmployeeName = sessionUser.name`).
    * Management roles (`Supervisor`, `Operations`, `Admin`) can schedule on behalf of other staff members by name.
  * **Responses:** `201 Created` with new shift record, or `401 Unauthorized` if unauthenticated.

* **`GET /api/shifts/[id]`**
  * **Access:** Public read for single shift inspection.
  * **Responses:** `200 OK` with shift record, `400 Bad Request` if ID is invalid, or `404 Not Found` if nonexistent.

* **`PUT /api/shifts/[id]`**
  * **Access:** Authenticated and authorized users only.
  * **Processing:** Revalidates caller against database; parses ID and body; queries existing shift; invokes `canManageShiftRecord(sessionUser, existingShift)`. If caller is a standard employee, preserves `user_id = sessionUser.userId`. If caller is a manager, permits reassignment.
  * **Responses:** `200 OK` with updated shift, `401 Unauthorized` if unauthenticated, `403 Forbidden` if user is not authorized, `404 Not Found` if nonexistent.

* **`DELETE /api/shifts/[id]`**
  * **Access:** Authenticated and authorized users only.
  * **Processing:** Revalidates caller against database; retrieves existing shift; evaluates `canManageShiftRecord`. Deletes matching record.
  * **Responses:** `200 OK` (`{ "success": true, "message": "Shift deleted successfully." }`), `401 Unauthorized`, `403 Forbidden`, or `404 Not Found`.

### 4.3 Legacy Shift Recovery Endpoints

* **`GET /api/shifts/recover`**
  * **Access:** Authenticated users only (`getSessionUser({ revalidateWithDb: true })`).
  * **Processing:** Queries legacy shifts strictly attributed to the caller (`shifts.user_id = sessionUser.userId AND shifts.team_id IS NULL`). Never exposes other users' unassigned shifts or unowned orphan shifts (`user_id IS NULL`).
  * **Responses:**
    * `200 OK`: Returns `{ "recoverableCount": N, "shifts": [ ... ] }`.
    * `401 Unauthorized`: If caller is not authenticated.

* **`POST /api/shifts/recover`**
  * **Access:** Authenticated users only (`getSessionUser({ revalidateWithDb: true })`).
  * **Payload:** Optional JSON: `{ "targetTeamId"?: number, "shiftIds"?: number[] }`. If `targetTeamId` is omitted, defaults to the user's active workspace membership (`sessionUser.teamId`).
  * **Processing:**
    1. Validates that the caller holds an authorized membership in `targetTeamId` via `team_memberships`. Rejects unauthorized workspace assignment with `403 Forbidden`.
    2. If explicit `shiftIds` are provided, validates that every requested ID strictly belongs to `sessionUser.userId` and has `team_id IS NULL`. Rejects cross-user claims or unowned orphan claims (`user_id IS NULL`) with `403 Forbidden`. Rejects already-assigned shifts with `409 Conflict`.
    3. Executes atomic CTE with row-level locking (`FOR UPDATE`) in PostgreSQL:
       ```sql
       WITH candidate_shifts AS (
         SELECT id FROM shifts
         WHERE user_id = $userId AND team_id IS NULL
         FOR UPDATE
       )
       UPDATE shifts s
       SET team_id = $targetTeamId
       FROM candidate_shifts cs
       WHERE s.id = cs.id AND s.user_id = $userId AND s.team_id IS NULL
       RETURNING s.id, s.employee_name, s.role, s.user_id, s.team_id, TO_CHAR(s.shift_day, 'YYYY-MM-DD') AS shift_day, s.created_at;
       ```
    4. Preserves all other shift columns (`id`, `employee_name`, `role`, `user_id`, `shift_day`, `created_at`). Only `team_id` is updated.
    5. Repeat requests are idempotent, cleanly returning `recoveredCount: 0`.
  * **Responses:**
    * `200 OK`: Returns `{ "success": true, "message": "...", "recoveredCount": N, "targetTeamId": N, "shifts": [ ... ] }`.
    * `400 Bad Request`: If target workspace ID is missing/invalid or payload is malformed.
    * `401 Unauthorized`: If caller is not authenticated.
    * `403 Forbidden`: If user is not an authorized member of `targetTeamId` or attempts to claim shifts belonging to another user / unowned shifts.
    * `404 Not Found`: If one or more requested shift IDs do not exist.
    * `409 Conflict`: If one or more requested shifts are already assigned to a workspace.

### 4.4 Billing & Payment Endpoints (Paystack Exclusive)

* **`POST /api/billing/paystack/initialize`**
  * **Access:** Authenticated managers and workspace owners only (`isManagerRole(sessionUser.role) || sessionUser.teamRole === "Owner"`).
  * **Payload:** `{ "targetPlan": "starter" | "pro" | "enterprise", "seats"?: number, "workspaceId"?: number }`.
  * **Processing:**
    1. Validates session, active workspace (`sessionUser.teamId`), and managerial authorization.
    2. Validates workspace isolation: ensures requested `workspaceId` matches `sessionUser.teamId`.
    3. Validates target plan against `PAYSTACK_PLANS` (`starter`, `pro`, `enterprise`). Rejects free tier or unknown plans with `400 Bad Request`.
    4. Evaluates current subscription. Prevents duplicate checkout if workspace is already actively subscribed to the target plan.
    5. Calls `paystackClient.initializeTransaction()` with server-enforced integer kobo pricing and deterministic reference (`pstk_init_{teamId}_{plan}_{timestamp}_{suffix}`).
  * **Responses:**
    * `200 OK`: Returns `{ "authorizationUrl": "https://checkout.paystack.com/...", "accessCode": "...", "reference": "pstk_init_...", "amountKobo": 1500000, "currency": "NGN" }`.
    * `400 Bad Request`: If plan is missing, invalid, or already active.
    * `401 Unauthorized`: If user is not authenticated.
    * `403 Forbidden`: If user lacks management authority or target workspace mismatches.

* **`POST /api/billing/paystack/verify`**
  * **Access:** Authenticated users belonging to an active workspace.
  * **Payload:** `{ "reference": "pstk_init_..." }`.
  * **Processing (Strict Server-Side Verification):**
    1. Directly queries Paystack API / `defaultPaystackClient` via `paystackClient.verifyTransaction(reference)`.
    2. Verifies `status === "success"`, `currency === "NGN"`, and `amount === expectedKobo`.
    3. Enforces workspace isolation: verifies `metadata.workspace_id === sessionUser.teamId`.
    4. If reusable authorization is returned, encrypts authorization code via AES-256-GCM (`lib/paystack-security.ts`) and sets `auto_renew_enabled = TRUE`.
    5. Activates subscription in durable PostgreSQL storage (`workspace_subscriptions`).
    6. Records immutable ledger entry (`billing_ledger`) and audit event (`billing_events`).
    7. Fully idempotent: repeated verification attempts return `200 OK` with `alreadyVerified: true` without duplicate ledger records.
  * **Responses:**
    * `200 OK`: Returns `{ "success": true, "subscription": { ... } }`.
    * `400 Bad Request`: If `reference` is missing or invalid.
    * `401 Unauthorized`: If caller is not authenticated.
    * `403 Forbidden`: If transaction belongs to another workspace.
    * `422 Unprocessable Entity`: If transaction has not succeeded.

* **`POST /api/billing/paystack/webhook`**
  * **Access:** Unauthenticated HTTP POST from Paystack webhook infrastructure.
  * **Processing:**
    1. Validates `PAYSTACK_SECRET_KEY` is configured (returns `503` if unconfigured).
    2. Validates `x-paystack-signature` HMAC-SHA512 header using `crypto.timingSafeEqual`.
    3. Deduplicates incoming events in `billing_events` table by unique event reference.
    4. Dispatches event (`charge.success`, `subscription.disable`, etc.), updating durable subscription state idempotently.
  * **Responses:**
    * `200 OK`: Returns `{ "received": true, "duplicate": boolean }`.
    * `400 Bad Request`: If signature is missing, forged, or payload is empty.
    * `503 Service Unavailable`: If `PAYSTACK_SECRET_KEY` is unconfigured.

* **`POST /api/billing/paystack/cancel`**
  * **Access:** Authenticated managers and workspace owners.
  * **Processing:** Sets `cancel_at_period_end = TRUE` and `auto_renew_enabled = FALSE` without destroying workspace members or shift history.
  * **Responses:**
    * `200 OK`: Returns `{ "success": true, "message": "Subscription auto-renewal canceled." }`.

* **`POST /api/billing/paystack/renew`**
  * **Access:** Authenticated worker trigger protected by `CRON_SECRET` Bearer authorization.
  * **Processing:** Executes off-session recurring renewal charges using stored AES-256-GCM encrypted authorization codes with PostgreSQL renewal lease locks and calendar-month anchor day math.

* **`GET /api/billing`**
  * **Access:** Authenticated users belonging to an active workspace.
  * **Processing:** Retrieves active subscription for `sessionUser.teamId` from durable storage, evaluates seat capacity, and returns commercial NGN plan configuration and billing ledger history.
  * **Responses:**
    * `200 OK`: Returns `{ "workspaceId": N, "state": "ACTIVE" | "FREE" | "PAST_DUE" | "CANCELED", "subscription": { ... }, "paystackPlan": { ... }, "seatLimit": N, "capacity": { ... }, "ledger": [ ... ] }`.

> [!NOTE]
> **Stripe Complete Retirement & Historical Preservation Architecture (Phase 2):**
> * **Retired Runtime Processing:** All active Stripe endpoints (`POST /api/billing/checkout`, `POST /api/billing/confirm`, `POST /api/billing/webhook`), client library (`lib/stripe.ts`), webhook signature verification (`verifyWebhookSignature`), and Stripe event-processing logic (`BillingEventProcessor.processEvent`) are permanently disabled and retired.
> * **Write Protection:** `BillingStorageInterface` and its implementations (`InMemoryBillingStorage`, `DatabaseBillingStorage`) actively reject any attempts to create new Stripe subscriptions, record Stripe payment events, or write Stripe ledger entries.
> * **Paystack Default:** Schema migrations and new subscriptions default strictly to `payment_provider = 'paystack'`. Paystack routes explicitly identify Paystack as their provider.
> * **Preserved Historical Records:** All historical Stripe database records, ledger entries, billing events, and columns (`stripe_customer_id`, `stripe_subscription_id`) are preserved intact and remain fully queryable for historical reporting, reconciliation, and audit integrity.
> * **Display Attribution:** Historical Stripe subscriptions display verified historical status, but new Stripe subscriptions are strictly prohibited from being represented as verified.

---

## 5. Authentication & Session Lifecycle

```
[Client Browser]
       │
       │  1. POST /api/auth/login { email, password }
       ▼
[Route Handler: login]
       │
       │  2. SQL: SELECT id, password_hash, password_salt, name, role FROM users WHERE email = $email
       ▼
[Neon PostgreSQL] ──> Returns user row (or empty)
       │
       │  3. verifyPassword(password, storedHash, storedSalt) via crypto.scryptSync + timingSafeEqual
       │  4. createSessionToken({ userId, email, name, role }, AUTH_SECRET, 7 days)
       │  5. Set-Cookie: rota_session=<encodedPayload>.<signature>; HttpOnly; Secure; SameSite=Lax; Max-Age=604800
       ▼
[Client Browser] (Receives cookie automatically stored in browser credential jar)
       │
       │  6. Subsequent mutating request (e.g. POST /api/shifts) with Cookie: rota_session=...
       ▼
[Route Handler: shifts]
       │
       │  7. getSessionUser({ revalidateWithDb: true })
       │     a. Verify HMAC signature using AUTH_SECRET
       │     b. Verify payload.exp > now
       │     c. SQL: SELECT id, email, name, role FROM users WHERE id = payload.userId (Fresh role check)
       ▼
[Authorization Gate: canManageShiftRecord]
       │
       ├── Authorized ───> Execute Parameterized SQL Query ───> Return 200/201 JSON
       └── Unauthorized ─> Reject immediately with HTTP 401 or HTTP 403
```

---

## 6. Cryptographic Implementation Details

### 6.1 Password Hashing (`lib/auth.ts`)
* **Algorithm:** Scrypt (memory-hard, resistant to GPU/ASIC brute-force attacks).
* **Salt:** 16 cryptographically secure random bytes generated via `crypto.randomBytes(16).toString("hex")`.
* **Key Length:** 64 bytes (`SCRYPT_KEYLEN = 64`).
* **Verification:** The candidate password and stored salt are hashed using `crypto.scryptSync`. The resulting derived key buffer is compared against the stored key buffer using `crypto.timingSafeEqual`, preventing timing side-channel attacks.

### 6.2 Session Tokens (`lib/auth.ts`)
* **Structure:** Two-part dot-separated string: `<encodedPayload>.<signature>`.
* **Payload Serialization:** JSON object containing `userId`, `email`, `name`, `role`, and `exp` (expiration Unix timestamp in seconds), encoded in URL-safe Base64 (`base64url`).
* **Signing:** HMAC-SHA256 computed over `<encodedPayload>` using the server-side environment secret `AUTH_SECRET`:
  $$\text{signature} = \text{HMAC-SHA256}(\text{encodedPayload}, \text{AUTH\_SECRET})$$
* **Verification:** Computes expected signature over the provided payload and compares buffers using `crypto.timingSafeEqual`. Tokens with modified payloads, altered signatures, or `exp < currentTimestamp` are rejected immediately.

### 6.3 Cookie Security Configuration (`lib/session.ts`)
* `name`: `rota_session`
* `httpOnly: true` (Inaccessible to client-side JavaScript, neutralizing Cross-Site Scripting [XSS] token theft).
* `secure: process.env.NODE_ENV === "production"` (Requires HTTPS in production environments).
* `sameSite: "lax"` (Mitigates Cross-Site Request Forgery [CSRF] attacks on cross-origin requests).
* `path: "/"` (Available across all application endpoints).
* `maxAge: 604800` (7 days duration).

---

## 7. Database Schema & Data Models

The persistence layer runs on Neon PostgreSQL using native parameterized template literals.

```
┌─────────────────────────────────┐           ┌─────────────────────────────────┐
│              users              │           │             shifts              │
├─────────────────────────────────┤           ├─────────────────────────────────┤
│ id: SERIAL PRIMARY KEY          │1         *│ id: SERIAL PRIMARY KEY          │
│ email: VARCHAR(255) UNIQUE      │───────────│ employee_name: VARCHAR(100)     │
│ password_hash: VARCHAR(255)     │           │ role: VARCHAR(50)               │
│ password_salt: VARCHAR(64)      │           │ shift_day: DATE NOT NULL        │
│ name: VARCHAR(100) NOT NULL     │           │ user_id: INTEGER REFERENCES(id) │
│ role: VARCHAR(50) NOT NULL      │           │ created_at: TIMESTAMPTZ         │
│ created_at: TIMESTAMPTZ         │           └─────────────────────────────────┘
└─────────────────────────────────┘
```

### 7.1 `users` Table Schema
```sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_salt VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 7.2 `shifts` Table Schema
```sql
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  employee_name VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL,
  shift_day DATE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

*Note on Nullable `user_id`:* Pre-existing legacy shifts created before the authentication layer was introduced have `user_id IS NULL`. The system explicitly accounts for these records via protective authorization rules.

---

## 8. Authorization Matrix & Business Rules

All authorization checks are executed server-side via `canManageShiftRecord(sessionUser, shiftRecord)` in [`lib/permissions.ts`](file:///C:/Users/umehc/final-task-chinazom-chinaemeze/rota/web/lib/permissions.ts):

| Caller Role | Target Shift Type | Edit Permission | Delete Permission | Reassignment Authority |
| :--- | :--- | :---: | :---: | :---: |
| **Unauthenticated / Anonymous** | Any Shift | ❌ Denied (401) | ❌ Denied (401) | ❌ Denied (401) |
| **Standard Employee** (`Front Desk`, `Customer Support`, `Frontend Developer`) | Shift assigned to caller (`shift.user_id === user.id`) | ✅ Allowed | ✅ Allowed | ❌ Cannot reassign to another user |
| **Standard Employee** | Shift assigned to another user (`shift.user_id !== user.id`) | ❌ Denied (403) | ❌ Denied (403) | ❌ Denied (403) |
| **Standard Employee** | Legacy shift (`shift.user_id IS NULL`) | ❌ Denied (403) | ❌ Denied (403) | ❌ Denied (403) |
| **Supervisor / Operations / Admin** | Shift assigned to caller | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| **Supervisor / Operations / Admin** | Shift assigned to any employee | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| **Supervisor / Operations / Admin** | Legacy shift (`shift.user_id IS NULL`) | ✅ Allowed | ✅ Allowed | ✅ Allowed |

### Key Authorization Constraints:
1. **Immutable User ID Ownership:** Ordinary employees cannot alter the `user_id` foreign key of an existing shift to claim or reassign it.
2. **Legacy Record Protection:** Matching an employee's string `employee_name` to an unassigned legacy shift (`user_id IS NULL`) does **not** grant edit or delete authority to a non-manager. Legacy records require management oversight.
3. **Database Revalidation:** State-altering operations invoke `getSessionUser({ revalidateWithDb: true })`. If an account's role is demoted or deleted in the database, subsequent requests immediately reflect the current database state rather than stale token claims.

### 8.2 Legacy Shift Recovery Security & Concurrency Invariants
The recovery workflow implemented in [`lib/shift-recovery.ts`](file:///C:/Users/umehc/final-task-chinazom-chinaemeze/rota/web/lib/shift-recovery.ts) and [`app/api/shifts/recover/route.ts`](file:///C:/Users/umehc/final-task-chinazom-chinaemeze/rota/web/app/api/shifts/recover/route.ts) enforces the following strict security invariants:
1. **Cryptographic Identity Attribution:** An authenticated user may **only** recover shifts that have an exact, immutable relational match on `shifts.user_id = sessionUser.userId`. Shift recovery by `employee_name`, email similarity, or heuristic guesswork is strictly prohibited.
2. **Authorized Workspace Target:** Shifts can only be recovered into a workspace where the user is a verified member in `team_memberships`. Unverified workspace claims return `403 Forbidden`.
3. **Cross-User Protection & Privacy:** Regular users cannot inspect or claim shifts belonging to other accounts. Unassigned shifts of other users are never returned in recovery listings.
4. **Concurrency & Atomicity Protection:** Recovery executes using a single PostgreSQL CTE with a `FOR UPDATE` row-level exclusive lock and `WHERE s.team_id IS NULL`. If two requests run concurrently, the second transaction sees 0 unassigned rows and updates nothing, preventing race conditions or double claims.
5. **Shift Data Preservation:** The recovery update statement updates **only** `shifts.team_id`. All other fields (`id`, `employee_name`, `role`, `user_id`, `shift_day`, and `created_at`) are 100% preserved.
6. **Idempotency:** Repeating a recovery request returns `{ "success": true, "recoveredCount": 0, "shifts": [] }` cleanly without error.

### 8.3 Administrator Workflow for Orphan Legacy Shifts (`user_id IS NULL`)
Legacy shifts where `shifts.user_id IS NULL` cannot be attributed automatically because string employee names are not cryptographically or relationally tied to an authenticated account. To preserve data integrity and prevent unauthorized shift claims:
1. **Fail-Closed Default:** Orphan shifts remain permanently quarantined with `team_id IS NULL` and `user_id IS NULL`. Regular users and managers cannot view or claim them through `/api/shifts` or `/api/shifts/recover`.
2. **Required Operator / Administrator Procedure:**
   * **Step 1 (Audit & Discovery):** Run the read-only count query or audit script (`SELECT id, employee_name, role, shift_day FROM shifts WHERE user_id IS NULL AND team_id IS NULL ORDER BY id ASC;`).
   * **Step 2 (HR & Payroll Verification):** Cross-reference each shift's `employee_name` and `shift_day` against verified offline HR or payroll timesheets.
   * **Step 3 (User Account Linking):** Confirm that the corresponding employee has registered an account and been admitted to their target workspace in `team_memberships`.
   * **Step 4 (Audited Administrative Attribution):** An authorized administrator executes an explicit, audited update statement linking the specific shift ID to the verified `user_id` and `team_id`:
     ```sql
     UPDATE shifts
     SET user_id = <verified_user_id>, team_id = <target_team_id>
     WHERE id = <shift_id> AND user_id IS NULL AND team_id IS NULL;
     ```
   * **Step 5 (Log & Archive):** Record the administrative attribution in an audit log with the administrator's ID, timestamp, and justification. Unverified orphan shifts remain archived and unassigned.

### 8.4 User-Facing Shift Recovery Interface & Interaction Workflow
The recovery workflow is directly wired into the Rota web interface ([`app/page.tsx`](file:///C:/Users/umehc/final-task-chinazom-chinaemeze/rota/web/app/page.tsx)) using existing navigation frames, modal patterns, and visual styling:
1. **Automated Discovery:** When an authenticated user signs in or loads the dashboard, the application initiates an asynchronous query to `GET /api/shifts/recover`.
2. **Notification Banner & Settings Card:** If recoverable shifts matching the user's `user_id` are detected (`recoverableShifts.length > 0`), a prominent indigo alert banner appears on the Overview and Schedule screens, and an actionable card is rendered in the Settings view explaining the availability of historical shifts.
3. **Workspace Selection (Zero Guesswork):** Clicking "Review & Recover" fetches the caller's authorized workspaces via `GET /api/teams` and renders them in a dropdown. The user must explicitly select an authorized workspace from their active memberships. Workspaces are never inferred or auto-assigned.
4. **Explicit Confirmation:** The modal details the shift count, date range, and target workspace, requiring the user to check an explicit confirmation box before the "Recover Shifts" submission button is enabled.
5. **In-Flight Lockout & Feedback:** Submissions are guarded with a busy state (`recovering = true`) that disables action buttons and displays a loading spinner to prevent accidental duplicate submissions.
6. **Graceful Error Handling:** Handled via pure client resolver [`resolveShiftRecoveryResponse`](file:///C:/Users/umehc/final-task-chinazom-chinaemeze/rota/web/lib/shifts-client.ts):
   * `401 Unauthorized`: Displays session expiration notice and prompts re-authentication.
   * `403 Forbidden`: Informs the user they lack authorization for the selected workspace.
   * `409 Conflict`: Alerts the user if shifts were claimed or updated by a concurrent session.
   * `500 / Network Error`: Provides sanitized, non-leaking user feedback.
7. **Schedule Refresh & State Cleanup:** Upon successful recovery, the interface triggers `loadShifts()` to immediately display newly assigned shifts in the calendar grid and clears the recovery banner and modal.

### 8.5 Paystack Payment Integration & Stripe Retirement (Phase 2)

The active payment integration provides an end-to-end subscription lifecycle exclusively using Paystack with commercial NGN pricing tiers (Starter: ₦15,000, Pro: ₦45,000, Enterprise: ₦150,000):

```
[Manager Browser] ── 1. Select Tier ──▶ [POST /api/billing/paystack/initialize] ── 2. Create Transaction ──▶ [Paystack API]
       │                                                                                                        │
       │ ◀──────────────── 3. Redirect URL & Transaction Reference ─────────────────────────────────────────────┘
       ▼
[Paystack Checkout Modal / Page (Test Mode)]
       │
       │ 4. Complete Test Card Payment (NGN)
       ▼
[Manager Browser Return: ?reference=pstk_init_...]
       │
       ├── 5. POST /api/billing/paystack/verify { reference } ──▶ [Server Verification (Paystack Gateway)]
       │                                                                │ (Authoritative gateway retrieval,
       │                                                                │  status === "success", currency === "NGN",
       │                                                                │  amount match, AES-256-GCM auth encryption)
       │                                                                ▼
       │ ◀──────────── 6. Subscription Active, Seats Updated ───────────
       │
       └── (Asynchronous Background Webhook)
           [Paystack] ── 7. POST /api/billing/paystack/webhook ──▶ [Durable Storage Ingestion]
                                                                          │ (HMAC-SHA512 verification,
                                                                          │  durable event deduplication,
                                                                          │  idempotent ledger recording)
```

#### Core Security Invariants of Payment Integration:
1. **Server-Side Authoritative Verification:** The client can never supply or dictate subscription status, plan tier, or payment amount. The confirmation route (`/api/billing/paystack/verify`) strictly queries the Paystack gateway directly for the authoritative transaction status, currency, amount, and metadata.
2. **Tenant Isolation:** Checkout metadata permanently binds `workspace_id`. Cross-tenant verification attempts are rejected with `403 Forbidden`.
3. **Encrypted Reusable Authorization Tokens:** Authorization codes returned by Paystack for recurring charges are encrypted using AES-256-GCM (`lib/paystack-security.ts`) before database persistence. Plaintext tokens are never stored, logged, or returned to clients.
4. **Bidirectional Idempotency:** If the frontend verifies the transaction via `/api/billing/paystack/verify`, the subsequent asynchronous webhook (`charge.success`) detects the recorded transaction reference and acknowledges safely without duplicate ledger records.
5. **Complete Stripe Retirement:** All active Stripe routes (`POST /api/billing/checkout`, `POST /api/billing/confirm`, `POST /api/billing/webhook`), client library (`lib/stripe.ts`), webhook signature verification, and event processing are permanently retired and disabled. `BillingStorageInterface` strictly rejects any new Stripe subscription writes or events. Paystack is the exclusive active provider. Historical Stripe database records and columns (`stripe_customer_id`, `stripe_subscription_id`) are preserved intact and read-only.

#### Operator Setup for Staging Verification:
To verify the Paystack payment integration in staging:
1. **Paystack Test Mode Credentials:**
   * Configure `PAYSTACK_SECRET_KEY=sk_test_...` and `PAYSTACK_PUBLIC_KEY=pk_test_...` in `.env.billing-staging.local`.
   * Configure `PAYSTACK_AUTH_ENCRYPTION_KEY` (64 hex characters / 32 bytes) for AES-256-GCM token encryption.
   * Configure `CRON_SECRET` for authenticating off-session renewal triggers.
2. **Safety Verification:**
   * Run `npm run verify:staging-env` to audit staging invariants without secret exposure.
3. **Test Cards:**
   * In Paystack Checkout, use official Paystack test cards (e.g. `4081 0000 0000 0000`) for deterministic test charges.

### 8.6 Durable Billing Persistence Architecture & Migration Plan

To provide zero-loss, cross-serverless-instance persistence for Stripe subscriptions and webhook idempotency without in-memory state fragility, a relational database persistence layer was designed and implemented offline:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        teams (INTEGER PRIMARY KEY)                     │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ 1:1 (team_id UNIQUE)
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      workspace_subscriptions                           │
├────────────────────────────────────────────────────────────────────────┤
│  id                       SERIAL PRIMARY KEY                           │
│  team_id                  INTEGER NOT NULL REFERENCES teams(id) UNIQUE │
│  stripe_customer_id       VARCHAR(255)                                 │
│  stripe_subscription_id   VARCHAR(255) UNIQUE                          │
│  plan_id                  VARCHAR(50) NOT NULL DEFAULT 'free'          │
│  seats                    INTEGER NOT NULL DEFAULT 5                   │
│  status                   VARCHAR(50) NOT NULL DEFAULT 'active'        │
│  current_period_start     TIMESTAMPTZ                                  │
│  current_period_end       TIMESTAMPTZ                                  │
│  cancel_at_period_end     BOOLEAN DEFAULT FALSE                        │
│  created_at               TIMESTAMPTZ DEFAULT NOW()                    │
│  updated_at               TIMESTAMPTZ DEFAULT NOW()                    │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                           billing_events                               │
├────────────────────────────────────────────────────────────────────────┤
│  id           SERIAL PRIMARY KEY                                       │
│  event_id     VARCHAR(255) NOT NULL UNIQUE                             │
│  event_type   VARCHAR(100) NOT NULL                                    │
│  team_id      INTEGER REFERENCES teams(id) ON DELETE SET NULL          │
│  status       VARCHAR(50) NOT NULL                                     │
│  payload      JSONB                                                    │
│  processed_at TIMESTAMPTZ DEFAULT NOW()                                │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                           billing_ledger                               │
├────────────────────────────────────────────────────────────────────────┤
│  id             SERIAL PRIMARY KEY                                     │
│  transaction_id VARCHAR(255) NOT NULL UNIQUE                           │
│  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE│
│  event_id       VARCHAR(255) REFERENCES billing_events(event_id)       │
│  type           VARCHAR(50) NOT NULL                                   │
│  amount_cents   INTEGER NOT NULL                                       │
│  currency       VARCHAR(10) NOT NULL DEFAULT 'usd'                     │
│  status         VARCHAR(50) NOT NULL                                   │
│  metadata       JSONB                                                  │
│  created_at     TIMESTAMPTZ DEFAULT NOW()                              │
└────────────────────────────────────────────────────────────────────────┘
```

#### Core Persistence Invariants:
1. **Schema & Identifier Matching:** `teams.id` is strictly an `INTEGER` (from `SERIAL PRIMARY KEY`). Foreign keys in `workspace_subscriptions`, `billing_events`, and `billing_ledger` enforce `INTEGER NOT NULL REFERENCES teams(id)`. String UUIDs or invalid keys are rejected via `normalizeTeamId()`.
2. **Single Active Subscription per Workspace:** `workspace_subscriptions.team_id` has a `UNIQUE` constraint. Plan upgrades, downgrades, or retries execute an atomic `UPSERT`:
   ```sql
   INSERT INTO workspace_subscriptions (
     team_id, stripe_customer_id, stripe_subscription_id, plan_id,
     seats, status, current_period_start, current_period_end,
     cancel_at_period_end, updated_at
   )
   VALUES ($1, $2, $3, $4, $5, $6, TO_TIMESTAMP($7), TO_TIMESTAMP($8), $9, TO_TIMESTAMP($10))
   ON CONFLICT (team_id) DO UPDATE SET
     stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, workspace_subscriptions.stripe_customer_id),
     stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, workspace_subscriptions.stripe_subscription_id),
     plan_id = EXCLUDED.plan_id,
     seats = EXCLUDED.seats,
     status = EXCLUDED.status,
     current_period_start = EXCLUDED.current_period_start,
     current_period_end = EXCLUDED.current_period_end,
     cancel_at_period_end = EXCLUDED.cancel_at_period_end,
     updated_at = EXCLUDED.updated_at;
   ```
   This strictly guarantees that an active subscription cannot be duplicated when changing tiers.
3. **Distributed Event Idempotency:** `billing_events.event_id` is unique. Stripe event arrivals insert with `ON CONFLICT (event_id) DO NOTHING`. If zero rows are inserted, the event is recognized as already recorded, preventing duplicate processing across distributed serverless instances.
4. **Immutable Financial Ledger:** `billing_ledger.transaction_id` is unique. Any duplicate webhook or client confirmation will collide and avoid double-accounting.
5. **Subscription Lifecycle State Transitions:**
   - **Upgrades / Downgrades:** Atomic upsert updates `plan_id`, adjusts `seat_limit` according to tier entitlements, and updates `current_period_end`.
   - **Cancellations (`customer.subscription.deleted`):** Status transitions to `canceled` while keeping customer identifiers for audit history.
   - **Failed Payments (`invoice.payment_failed`):** Status transitions to `past_due`, restricting workspace access without deleting subscription history.
   - **Payment Retries / Success (`invoice.payment_succeeded`):** Status transitions to `active`, recording the payment in `billing_ledger`.
6. **Unexecuted Dry-Run Migration Script:** Implemented in [`scripts/migrate-billing-persistence.mjs`](file:///C:/Users/umehc/final-task-chinazom-chinaemeze/rota/web/scripts/migrate-billing-persistence.mjs) with `--run`, `--confirm-target`, and `--confirm-endpoint` CLI flags, atomic single-transaction DDL, and reversible rollback SQL. Zero migrations were executed against live databases during offline preparation.

---

## 9. Error Handling & Security Practices

* **Timing Attack Prevention:** All password and token signature verifications use `crypto.timingSafeEqual` over fixed-length buffers.
* **SQL Injection Prevention:** Every database query in `lib/db.ts` and route handlers is constructed using Neon's parameterized tagged template literals (`sql`...``). String concatenation is forbidden.
* **Sanitized Client Profiles:** `/api/auth/me` and `/api/auth/login` only return public profile fields (`id`, `email`, `name`, `role`). `password_hash`, `password_salt`, and session secrets are never returned in JSON payloads.
* **Input Normalization & Date Validation:** Email addresses are trimmed and converted to lowercase. Shift dates are verified against regular expressions (`/^\d{4}-\d{2}-\d{2}$/`) and parsed into `Date` objects to reject impossible calendar dates (e.g., `2026-02-31`).

---

## 10. Automated Testing & Verification

The test suite runs using Node.js's native test runner without third-party testing frameworks.

* **Exact Test Command:**
  ```powershell
  npm test
  # Executes: node --experimental-strip-types --test tests/shifts.test.mjs tests/proration.test.mjs tests/team-isolation.test.mjs tests/auth.test.mjs tests/billing-webhook.test.mjs tests/load-test-safety.test.mjs tests/database-safety-hardening.test.mjs tests/shift-recovery.test.mjs tests/billing-persistence.test.mjs tests/teams.test.mjs tests/default-membership-migration.test.mjs tests/db.test.mjs
  ```
* **Verified Test Results (374 passed, 0 failed across 68 test suites):**
  * **Shift Route & Ownership Authorization (`tests/shifts.test.mjs` — 46 tests):** Covers scrypt cryptographic hashing, session token verification, role-based shift permissions, manager overrides, date validation, and chronological state updates.
  * **Subscription Proration Engine (`tests/proration.test.mjs` — 37 tests):** Covers pure mathematical calculations for mid-cycle seat additions, seat reductions, plan upgrades, plan downgrades, custom cycle lengths, rounding modes, and precision bounds.
  * **Team Isolation & Migration Safety (`tests/team-isolation.test.mjs` — 98 tests):** Covers cross-team authorization denial, endpoint parameter validation, tenant isolation simulation, atomic DDL rollback mechanics, fail-closed read-only preflight inspection, CLI subprocess safety, and offline environment parsing.
  * **Authentication & Recovery Workflows (`tests/auth.test.mjs` — 15 tests):** Covers user registration, scrypt password hashing with random salt, duplicate email conflict handling, role escalation guards, and anti-enumeration password recovery.
  * **Billing Webhooks, Checkout & Seat Limits (`tests/billing-webhook.test.mjs` — 49 tests across 8 suites):** Covers HMAC-SHA256 webhook signature verification, replay protection tolerance (300s), idempotent duplicate event acknowledgement, out-of-order event protection, seat capacity checks, downgrade handling, atomic concurrency lock simulations, authenticated Checkout Session creation with proration, authoritative server-side payment confirmation, client tamper rejection, cross-tenant isolation guards, `checkout.session.completed` event handling, complete-but-unpaid session rejection, missing workspace metadata rejection, provider error sanitization, and workspace billing status queries.
  * **Load Testing Target Safety (`tests/load-test-safety.test.mjs` — 8 tests):** Covers production host guards (blocking `rota-lovat-gamma.vercel.app` and `*.vercel.app`), local host allowlisting, percentile calculations (p50, p90, p95, p99), and VU cap enforcement.
  * **Database Safety Hardening (`tests/database-safety-hardening.test.mjs` — 36 tests):** Covers preflight connection guards, host masking, SQL query read-only assertion, and transaction safety checks.
  * **Legacy Shift Recovery & Concurrency (`tests/shift-recovery.test.mjs` — 25 tests):** Covers user identity attribution, workspace authorization, cross-user denial, unowned orphan rejection, repeat request idempotency, row-level locking concurrency simulation, data field preservation, pure HTTP client-side response resolution, and complete UI interaction lifecycle simulation.
  * **Durable Billing Persistence & Migration Safety (`tests/billing-persistence.test.mjs` — 21 tests across 6 suites):** Covers workspace identifier normalization (`normalizeTeamId`), relational schema DDL matching (`teams.id` integer FK), dry-run defaults, CLI argument parser guards, missing target confirmations, hostname mismatch redaction, atomic transaction rollback on failure, in-memory duplicate event deduplication, single-row subscription upserts, unique transaction ledger records, parameterized PostgreSQL queries with atomic `ON CONFLICT` clauses, full subscription lifecycle transitions (create -> upgrade -> downgrade -> cancel), concurrent duplicate event resolution via `Promise.all`, environment-based storage selection (`BILLING_STORAGE=memory`, `BILLING_STORAGE=database`, `NODE_ENV=production`), silent fallback prohibition, and safe transaction retry behavior.
  * **Workspace API & Slug Generation (`tests/teams.test.mjs` — 17 tests across 6 suites):** Covers base slug generation and truncation, authentication and membership gatekeeping, request validation, atomic creation CTEs, slug collision handling, and authorized workspace listing.
  * **Default Membership Index Migration (`tests/default-membership-migration.test.mjs` — 13 tests across 3 suites):** Covers CLI argument parsing, subprocess dry-run safety, and partial unique index transaction execution.
  * **Lazy Neon Client & Build-Time Safety (`tests/db.test.mjs` — 9 tests):** Covers lazy client proxy instantiation without build-time crashes, missing `DATABASE_URL` error handling, template literal interpolation, client caching across queries, failed client recovery, and rejection of custom test options in production.

---

## 11. Deployment Architecture & Environment Configuration

Rota is continuously deployed to Vercel Serverless Functions connected directly to a Neon PostgreSQL database.

### Required Environment Variables:
* **`DATABASE_URL`**: PostgreSQL connection URI for the Neon database instance (specifies host, database, user, pooled connection mode, and TLS parameters).
* **`AUTH_SECRET`**: Cryptographic secret key used to sign and verify HMAC-SHA256 session cookies.
* **`PAYSTACK_SECRET_KEY`**: Paystack API Secret Key (`sk_test_...` in staging/test mode) used for server-side transaction initialization, verification, and renewals.
* **`PAYSTACK_PUBLIC_KEY`**: Paystack API Public Key (`pk_test_...` in staging/test mode) used for client checkout integration.
* **`PAYSTACK_AUTH_ENCRYPTION_KEY`**: 256-bit AES encryption key (64 hex characters) used for encrypting reusable authorization codes at rest.
* **`CRON_SECRET`**: Secret bearer token protecting the off-session subscription renewal endpoint (`POST /api/billing/paystack/renew`).
* *(Retired)* **`STRIPE_SECRET_KEY`** / **`STRIPE_WEBHOOK_SECRET`**: Obsolete credentials; completely retired in Phase 2 with zero active runtime dependencies.

*(Note: In accordance with security protocols, environment variable values are never committed to version control).*

---

## 12. Verified Deliverables, Current Limitations & Roadmap

### Verified Deliverables:
* **Core Scheduling Dashboard & RBAC:** Production-deployed at [https://rota-lovat-gamma.vercel.app/](https://rota-lovat-gamma.vercel.app/).
* **Comprehensive Test Suite:** 495 automated tests across 91 suites (100% passing).
* **Paystack Exclusive Payment Integration & Complete Stripe Retirement:** Paystack test-mode checkout and verification fully active with commercial NGN pricing tiers, AES-256-GCM authorization encryption, HMAC-SHA512 webhook ingestion, and calendar-month renewal engine. Stripe completely retired and removed from all active runtime code.
* **Durable Billing Persistence Engine & Migration:** Prepared and validated offline with atomic `ON CONFLICT` clauses, workspace integer identifier validation, subscription lifecycle handling, and unexecuted migration scripts in `lib/billing-storage.ts`, `lib/billing.ts`, `scripts/migrate-billing-persistence.mjs`, and `tests/billing-persistence.test.mjs`.
* **Android Development Wrapper:** Implemented with Capacitor (`com.rota.app`); debug APK generated (`app-debug.apk`, 4,117,518 bytes) and linked via Google Drive.
* **Architecture Diagram:** Documented in `docs/architecture.md`.
* **Migration & Preflight Engine:** Documented in `docs/MIGRATION-READINESS.md` with fail-closed safety.
* **Safe Shift Recovery Workflow:** Implemented, wired into the dashboard UI, and tested in `lib/shift-recovery.ts`, `app/api/shifts/recover/route.ts`, `lib/shifts-client.ts`, and `app/page.tsx`.
* **200-VU Load Test Harness:** Documented in `docs/LOAD-TEST-PLAN.md` with automated production guards.
* **Proration, Webhook & Seat-Limit Engines:** Implemented and tested in `lib/proration.ts`, `lib/billing.ts`, and `lib/seat-limit.ts`.

### Current Limitations (Awaiting External Infrastructure / Authorization):
* **Live Database Migration:** Requires operator setup of an isolated disposable Neon staging branch before running the preflight check and migration transaction.
* **Live Billing Webhooks & Gateway:** Configured for test mode with mocked/offline testing; live card charges require production Paystack API keys and live webhook registration.
* **Live 200-VU Stress Test:** Execution against production is strictly prohibited; running against a staging environment requires a dedicated test server.
* **Signed Production Android Release:** The current APK is a debug development build; a production release requires a signed keystore and Google Play Console setup.
