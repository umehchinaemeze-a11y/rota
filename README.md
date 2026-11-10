# Rota — Workforce Scheduling & Shift Management

A modern, highly resilient workforce scheduling and shift management platform built with Next.js App Router, backed by Neon Serverless PostgreSQL, secured with native cryptographic session authentication, role-based access control (RBAC), and enterprise-grade billing, sharding, caching, and mobile synchronization.

* **Live Web Application:** [https://rota-lovat-gamma.vercel.app/](https://rota-lovat-gamma.vercel.app/)
* **Repository:** [https://github.com/umehchinaemeze-a11y/rota](https://github.com/umehchinaemeze-a11y/rota)
* **Architecture Guide:** [ARCHITECTURE.md](ARCHITECTURE.md)
* **Application State & Sync Model:** [STATE.md](STATE.md)
* **Security & Threat Model:** [SECURITY.md](SECURITY.md)
* **Database Sharding Architecture:** [SHARDING.md](SHARDING.md)
* **Engineering Decisions Log:** [LEARNING-LOG.md](LEARNING-LOG.md)
* **Technical Documentation:** [TECHNICAL-DOCUMENTATION.md](TECHNICAL-DOCUMENTATION.md)

---

## Key Capabilities & Production Features

### 1. High-Performance Dashboard & Scheduling
* **5 Responsive Workspaces Tabs:** Overview metrics, Shift Calendar Schedule, Infinite Keyset Activity Feed, Team Member Directory, and Cross-Device Settings.
* **Shift Ownership & Management:** Role-based scheduling, edition, assignment, and deletion with instant visual feedback and employee initials avatars.
* **Offline Resilience:** Offline schedule caching with visible `lastUpdated` synchronization timestamp, local storage persistence, and automatic recovery upon reconnection.
* **Optimistic Updates & Atomic Rollback:** Client actions for shift swaps and user settings apply optimistically to UI and DOM, rolling back cleanly if network or server errors occur.

### 2. Multi-Tenant Workspace & Role-Based Access Control (RBAC)
* **Strict Tenant Isolation:** All shifts, memberships, swap requests, settings, and activity logs are strictly partitioned by `team_id`.
* **Anti-Enumeration Protection:** Requests targeting unauthorized workspaces fail closed with generic HTTP 404 or 403 responses without leaking entity existence.
* **Role Hierarchy:**
  * **Owner & Manager / Supervisor:** Full scheduling, member invitation, shift swap approval, and billing administration authority.
  * **Staff (Front Desk, Customer Support, Operations):** Access limited to viewing workspace schedule, claiming own shifts, proposing shift swaps, and personal settings.

### 3. Enterprise Authentication & Session Lifecycle
* **Cryptographic Primitives:** Scrypt password hashing with unique 16-byte cryptographically secure random salts and constant-time verification (`lib/auth.ts`).
* **Short-Lived Access Tokens:** 15-minute stateless HMAC-SHA256 session tokens delivered via secure `HttpOnly`, `SameSite=Lax` cookies.
* **Refresh Token Rotation (RTR):** Server-side refresh sessions with family tracking, single-use token rotation, and automated reuse detection that instantly terminates compromised token families (`lib/refresh-tokens.ts`).
* **Global Sign-Out:** Single-device logout and multi-device `/api/auth/logout-all` session termination.
* **Cryptographic Password Reset:** 1-hour HMAC-SHA256 reset tokens with constant-time verification and strict single-use invalidation (`lib/password-reset.ts`).
* **Sliding-Window Rate Limiting:** Sliding-window rate limiter defending auth (`/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`, `/api/auth/reset-password`) and billing initialization endpoints.

### 4. Distributed Billing & Paystack Integration
* **Sole Active Provider:** Paystack exclusively powers workspace subscriptions (`lib/paystack.ts`, `lib/billing-storage.ts`).
* **Server-Authoritative Pricing:** Integer kobo calculations in NGN, rejecting client-submitted amounts or currencies.
* **Card Authorization Encryption:** Recurring billing authorizations encrypted with AES-256-GCM using unique per-tenant derivation keys.
* **Proration Engine & 7-Day Grace Period:** Fractional mid-cycle upgrades, seat expansion proration, and automatic 7-day grace periods upon renewal failure.
* **Webhook Idempotency:** Cryptographic HMAC-SHA512 webhook signature verification with transaction ledger deduplication.

### 5. Backend Architecture: Pooling, Sharding & Distributed Caching
* **Connection Pooling:** PgBouncer-aware connection pooling configuration with connection timeouts and keep-alive (`lib/db-cluster.ts`).
* **Deterministic Sharding:** Two-node PostgreSQL sharding simulated via deterministic SHA-256 integer hash routing on `team_id` (`shard_0` vs `shard_1`).
* **Read/Write Splitting & RYOW:** Automatic routing of write queries to Primary and reads to Replica, enforcing a 5-second Read-Your-Own-Writes (RYOW) consistency window.
* **Multi-Layer Distributed Cache & Invalidation:** Team roster (`cache:team:{id}:roster`) and schedule range caching (`cache:team:{id}:shifts:{range}`) powered by Redis with automatic eviction hooks on shift mutations (create, update, delete, swap approval, legacy recovery) (`lib/cache.ts`).
* **Redis-Backed Atomic Sliding-Window Rate Limiting:** Enforces distributed rate limits across all app instances using atomic Lua scripts on Redis sorted sets, with transparent headers (`X-RateLimit-*`, `Retry-After`) and automatic resilient failover to memory fallback (`lib/redis.ts`, `lib/rate-limit.ts`).

### 6. Activity Feed with Keyset Cursor Pagination
* **$O(\log N)$ Keyset Pagination:** Compound B-tree index `(team_id, created_at DESC, id DESC)` providing constant-time seek across 10,000+ audit records.
* **Infinite Scrolling:** Smooth infinite scroll controller with request locking, pull-to-refresh reset, and duplicate prevention.

### 7. Push Notifications & FCM Integration
* **Firebase Cloud Messaging (FCM):** FCM v1 / legacy payload builder with deep links and automatic bad-token cleanup loop (`lib/fcm.ts`).
* **Quiet Hours & Timezone Awareness:** Quiet hours suppression logic preventing off-shift notifications (`lib/notifications.ts`).

### 8. Cross-Platform Mobile Application
* **Android Development APK:** Built via Capacitor wrapper (`app-debug.apk`), verified in Android Emulator with deep links and Google OAuth.
* **Expo React Native App:** Parallel Expo implementation in `rota/mobile` with `expo-secure-store` encrypted token storage and deep link routing (`rota://shift/:id`, `rota://invite/:token`).

---

## Automated Test Suite

Rota features an exhaustive automated test suite with **801 tests across 163 suites** running via the Node.js native test runner with **100% pass rate**:

```bash
# Run all 801 unit and integration tests
npm test

# Verify Redis connectivity safely without secret exposure
npm run check:redis
```

### Test Coverage Highlights:
* `tests/shifts.test.mjs` (33 tests): Shift CRUD, role boundaries, tenant isolation.
* `tests/proration.test.mjs` (24 tests): Mathematical billing proration and leap years.
* `tests/auth.test.mjs` (15 tests): Scrypt hashing, constant-time compare, session cookies.
* `tests/refresh-tokens.test.mjs` (16 tests): Token rotation, reuse detection, family invalidation.
* `tests/security-auth.test.mjs` (17 tests): Password reset tokens, single-use check, rate limiting, Zod validation.
* `tests/redis-infrastructure.test.mjs` (27 tests): Redis sliding-window Lua rate limiting, 20-VU concurrency safety, HTTP headers, Redis failure fallback, caching hits/misses, shift mutation cache invalidation, production fail-safe hardening (HTTP 503 for 7 sensitive endpoints when Redis is unavailable, zero credential leakage, separate caching fallback, and diagnostic connectivity verification).
* `tests/paystack-checkout.test.mjs` (31 tests): Paystack transaction initialization, verification, AES-256-GCM.
* `tests/paystack-webhook.test.mjs` (16 tests): HMAC-SHA512 webhook signatures, ledger deduplication.
* `tests/paystack-renewal.test.mjs` (26 tests): Subscription renewals, 7-day grace periods.
* `tests/user-settings.test.mjs` (15 tests): Cross-device settings sync, revision conflict detection.
* `tests/offline-shifts.test.mjs` (12 tests): Offline caching, workspace isolation, logout purging.
* `tests/shift-swaps.test.mjs` (17 tests): Peer shift swap requests, manager approvals, atomic rollbacks.
* `tests/activity-feed.test.mjs` (15 tests): Keyset cursors, infinite scroll deduplication, 10,000-record benchmark.
* `tests/fcm.test.mjs` (6 tests): FCM push notifications, bad token eviction.
* `tests/db-cluster.test.mjs` (7 tests): Connection pooling, deterministic SHA-256 sharding, RYOW consistency.
* `tests/cache.test.mjs` (4 tests): Multi-range schedules, TTL expiration, mutation invalidation.
* `tests/mobile.test.mjs` (7 tests): Mobile SecureStore lifecycle, deep link parsing.

---

## Environment Variables

| Variable | Required | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | Yes | Neon Serverless PostgreSQL connection string (pooler host recommended) |
| `AUTH_SECRET` | Yes | 32+ character secret for signing HMAC-SHA256 session and reset tokens |
| `PAYSTACK_SECRET_KEY` | Yes (Billing) | Paystack secret API key (`sk_test_...` or `sk_live_...`) |
| `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | Yes (Billing) | Paystack public key (`pk_test_...` or `pk_live_...`) |
| `FIREBASE_PROJECT_ID` | Optional | Firebase Cloud Messaging project identifier |
| `FIREBASE_CLIENT_EMAIL` | Optional | Service account email for FCM push notification delivery |
| `FIREBASE_PRIVATE_KEY` | Optional | Private key for Google OAuth2 FCM authorization |
| `REDIS_URL` | Optional | Distributed cache / rate limit Redis cluster URL |

---

## Getting Started

```bash
# Clone the repository
git clone https://github.com/umehchinaemeze-a11y/rota.git
cd rota/web

# Install dependencies
npm install

# Run TypeScript verification
npx tsc --noEmit

# Execute automated tests
npm test

# Run development server
npm run dev

# Build production bundle
npm run build
```
