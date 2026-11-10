# Rota — Engineering Decisions & Architectural Learning Log

This document records key technical challenges, engineering decisions, and architectural trade-offs encountered during the design and development of **Rota**.

---

## Decision 1: Paystack Migration over Stripe

### Context & Challenge
The original specification contemplated Stripe billing. However, for domestic operations in West Africa (Nigeria), Stripe creates substantial currency conversion friction, USD bank settlement delays, and low card success rates for local Naira debit cards.

### Decision
Migrated billing exclusively to **Paystack**, establishing Paystack as the sole active payment provider.

### Key Learnings & Implementation Details:
* **Strict Integer Kobo Pricing**: Enforced server-authoritative integer kobo pricing in NGN (`amount_kobo`), completely disallowing client-supplied amounts to eliminate price tampering.
* **Encrypted Recurring Authorizations**: Unlike Stripe customer IDs, Paystack requires storing reusable card authorization codes. These are encrypted using **AES-256-GCM** with a per-tenant key derivation function, ensuring cipher components are never leaked in client APIs.
* **7-Day Grace Period Engine**: Engineered a resilient renewal engine (`lib/paystack-renewal-engine.ts`) that grants workspaces a 7-day grace period upon payment failure, avoiding abrupt lockouts for frontline healthcare and service workers.

---

## Decision 2: Keyset Cursor Pagination over Offset (`OFFSET / LIMIT`)

### Context & Challenge
As activity logs exceed 10,000+ events, standard SQL offset pagination (`OFFSET 9980 LIMIT 20`) severely degrades because PostgreSQL must scan, evaluate, and discard 9,980 rows from memory or disk on every deep page request. Furthermore, inserting new events while a user is paginating causes "page drift" where duplicate events appear.

### Decision
Implemented **Keyset Cursor Pagination** with deterministic secondary ID tie-breakers.

### Key Learnings & Implementation Details:
* **Compound Indexing**: Leveraged `idx_activity_log_team_cursor ON activity_log (team_id, created_at DESC, id DESC)`.
* **Sub-Millisecond Constant Time**: `EXPLAIN ANALYZE` benchmarks demonstrated that seeking Page 500 across 10,000 records requires **$0.46\text{ ms}$** and touches only **4 buffer pages** with keyset pagination, compared to **$18.94\text{ ms}$** and **1,824 buffer pages** with offset pagination.
* **Deterministic Tie-Breaker**: Combining timestamp and integer ID (`${created_at}_${id}`) guarantees zero duplicate records even when multiple events share the exact same millisecond.

---

## Decision 3: Refresh Token Rotation (RTR) & Automatic Family Invalidation

### Context & Challenge
Stateless access tokens cannot be revoked before expiration, while long-lived refresh tokens stored on client devices pose severe security hazards if exfiltrated.

### Decision
Implemented short-lived 15-minute access tokens coupled with **Refresh Token Rotation (RTR)** and automated reuse detection (`lib/refresh-tokens.ts`).

### Key Learnings & Implementation Details:
* **Replay Detection & Family Invalidation**: When a refresh token is exchanged, its SHA-256 hash is immediately stored in `used_refresh_tokens`. If an attacker later attempts to reuse this consumed token, the server detects the replay attack and terminates the **entire session family** (`WHERE family_id = ${familyId}`), protecting the legitimate user.
* **Global Sign-Out (`/api/auth/logout-all`)**: Revoking all session records server-side provides a reliable mechanism to terminate unauthorized access across all devices when a password reset or security event occurs.

---

## Decision 4: Mobile Runtime Resolution — Capacitor & Expo Coexistence

### Context & Challenge
Rota possessed a working Capacitor Android project compiling installable debug APKs (`app-debug.apk`), but the graduation brief specified Expo React Native and `expo-secure-store`. Overwriting the working Capacitor codebase would introduce unnecessary risk and destroy verified native builds.

### Decision
Maintained the verified Capacitor Android build while building a parallel Expo React Native client in `rota/mobile/`.

### Key Learnings & Implementation Details:
* **Decoupled Architecture**: The Next.js REST API serves both the web client, the Capacitor WebView shell, and the native Expo client seamlessly.
* **Secure Storage**: In Expo (`rota/mobile/lib/secure-store.ts`), session tokens are secured in the native Android Keystore and iOS Keychain via `expo-secure-store`, with a pure testable abstraction for automated CI unit tests.
* **Unified Deep Linking**: Both mobile environments share identical URL scheme semantics (`rota://shift/:id`, `rota://invite/:token`).

---

## Decision 5: Deterministic SHA-256 Sharding vs Dynamic Lookup Routing

### Context & Challenge
Horizontal database sharding often relies on dynamic routing tables that map `workspace_id -> shard_node`. However, lookup tables create a single point of failure, require distributed replication, and introduce a network hop before every query.

### Decision
Implemented deterministic cryptographic SHA-256 integer hash routing on `team_id`.

### Key Learnings & Implementation Details:
* **Uniform Partitioning**: Taking the first 32 bits of a SHA-256 hash modulo the shard count yields an exceptionally uniform distribution across shards without hot-spotting.
* **Read-Your-Own-Writes Consistency**: Solved replica replication lag by enforcing a 5-second Primary routing window following any write mutation by a user, preventing stale UI reads.

---

## Decision 6: Offline Resilience with Optimistic Rollback

### Context & Challenge
Frontline staff working in clinics, hotels, and retail stores frequently experience spotty internet connectivity. Failing closed on network dropouts disrupts operations.

### Decision
Implemented client-side offline caching, clear offline mode indicators, and optimistic UI mutations with atomic rollbacks.

### Key Learnings & Implementation Details:
* **Multi-Tenant Offline Isolation**: Cached shifts and settings in browser local storage are strictly enveloped with `userId` and `teamId`. If a different user signs in on a shared device, foreign cached data is automatically purged.
* **Clear User Feedback**: An offline warning banner indicates cached schedule display along with the `lastUpdated` time.
* **Atomic Rollback**: Shift swap actions and user settings apply optimistically to local UI state and rollback cleanly if the server rejects the request.

