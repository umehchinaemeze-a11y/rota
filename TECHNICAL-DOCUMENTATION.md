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
│   │   └── shifts/
│   │       ├── [id]/
│   │       │   └── route.ts          # GET, PUT, DELETE /api/shifts/[id] (Authorized shift modification)
│   │       └── route.ts              # GET, POST /api/shifts (Shift listing & authenticated shift creation)
│   ├── favicon.ico
│   ├── globals.css                   # Global CSS imports and Tailwind directives
│   ├── layout.tsx                    # Root layout with HTML/body scaffolding and metadata
│   └── page.tsx                      # Primary client-rendered dashboard, schedule grid, and auth modals
├── lib/
│   ├── auth.ts                       # Cryptographic primitives: scrypt hashing and HMAC-SHA256 tokens
│   ├── db.ts                         # Neon PostgreSQL connection pool and SQL template tag export
│   ├── permissions.ts                # Server-side authorization matrix and canManageShiftRecord logic
│   └── session.ts                    # HttpOnly cookie management and database-revalidated session resolution
├── scripts/                          # Administrative maintenance scripts (untracked, excluded from builds)
├── tests/
│   └── shifts.test.mjs               # 32 automated unit and regression tests
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

---

## 9. Error Handling & Security Practices

* **Timing Attack Prevention:** All password and token signature verifications use `crypto.timingSafeEqual` over fixed-length buffers.
* **SQL Injection Prevention:** Every database query in `lib/db.ts` and route handlers is constructed using Neon's parameterized tagged template literals (`sql`...``). String concatenation is forbidden.
* **Sanitized Client Profiles:** `/api/auth/me` and `/api/auth/login` only return public profile fields (`id`, `email`, `name`, `role`). `password_hash`, `password_salt`, and session secrets are never returned in JSON payloads.
* **Input Normalization & Date Validation:** Email addresses are trimmed and converted to lowercase. Shift dates are verified against regular expressions (`/^\d{4}-\d{2}-\d{2}$/`) and parsed into `Date` objects to reject impossible calendar dates (e.g., `2026-02-31`).

---

## 10. Automated Testing & Verification

The test suite runs using Node.js's native test runner without third-party frameworks.

* **Exact Test Command:**
  ```powershell
  npm test
  # Executes: node --experimental-strip-types --test tests/shifts.test.mjs
  ```
* **Verified Test Results (32 passed, 0 failed):**
  * **Password Hashing & Constant-Time Verification (`lib/auth.ts`):** 5 tests verifying unique salt generation, matching validation, rejection of bad passwords, rejection of invalid types, and malformed hex handling.
  * **Session Token Security (`lib/auth.ts`):** 8 tests verifying HMAC-SHA256 creation, missing `AUTH_SECRET` guard, tampered payload detection, tampered signature detection, expiration rejection, and malformed token handling.
  * **Server-Side Shift Authorization (`lib/permissions.ts`):** 6 tests verifying unauthenticated rejection, owner permission, non-owner denial, legacy `NULL` protection, manager override, and impersonation claim immunity.
  * **Login Input Validation & Safe Profile Exposure:** 4 tests verifying missing email handling, missing password handling, email normalization, and absence of sensitive credential leaks.
  * **Shift Payload & ID Validation:** 5 tests verifying valid payload acceptance, date format enforcement, invalid calendar date rejection, and numeric ID validation.
  * **Schedule State Immediate Updates:** 4 tests verifying update idempotency, chronological order maintenance, immediate deletion, and ID preservation.

---

## 11. Deployment Architecture & Environment Configuration

Rota is continuously deployed to Vercel Serverless Functions connected directly to a Neon PostgreSQL database.

### Required Environment Variables:
* **`DATABASE_URL`**: PostgreSQL connection URI for the Neon database instance (specifies host, database, user, pooled connection mode, and TLS parameters).
* **`AUTH_SECRET`**: Cryptographic secret key used to sign and verify HMAC-SHA256 session cookies.

*(Note: In accordance with security protocols, environment variable values are never committed to version control).*

---

## 12. Known Limitations & Future Roadmap

* **Subscription Proration:** Multi-tier subscription billing and proration algorithms are **not implemented or tested** in the current release. Rota focuses strictly on workforce scheduling and RBAC shift management.
* **Mobile Application Build:** Rota is currently a responsive web application. No standalone Android APK or Capacitor development build has been constructed for this project.
* **Load Testing:** A 200-virtual-user automated stress test benchmark has not yet been executed for Rota.
* **External Integrations:** Real-time push notifications, calendar sync (iCal/Google Calendar), and shift swap request workflows are identified as engineering roadmap items for subsequent releases.
