# Rota — Security Architecture & Threat Model

This document outlines the security architecture and eight-threat model analysis of the **Rota** workforce scheduling platform, detailing the defensive controls engineered against each threat vector.

---

## 1. Security Principles

1. **Defense in Depth**: Security controls operate at edge routing, API gateway, domain logic, and database query layers.
2. **Fail-Closed by Default**: Any unauthenticated, unverified, or ambiguous request defaults to rejection.
3. **Zero Trust Multi-Tenancy**: Every database query is explicitly scoped to the verified tenant (`team_id`).
4. **Server-Authoritative State**: Financial, role, and identity values from client inputs are never trusted.

---

## 2. Eight-Threat Model & Defensive Controls

### Threat 1: Broken Authentication & Session Hijacking
* **Threat**: Session token theft via XSS, MITM, or token replay attacks.
* **Defensive Controls**:
  - Stateless HMAC-SHA256 session tokens with short 15-minute TTLs.
  - Refresh Token Rotation (RTR) with family-based theft detection (`lib/refresh-tokens.ts`).
  - Session cookies configured with `HttpOnly`, `SameSite=Lax`, and `Secure` attributes.
  - Global sign-out endpoint (`/api/auth/logout-all`) revoking all active sessions across devices upon password reset or account compromise.

---

### Threat 2: Broken Object Level Authorization (BOLA) & Multi-Tenant Data Leakage
* **Threat**: User in Workspace A attempting to read, update, or delete shifts or audit events belonging to Workspace B.
* **Defensive Controls**:
  - Server-side authorization gatekeeper (`lib/permissions.ts`) verifying `team_id` on every query.
  - Fail-closed anti-enumeration: Unauthorized cross-tenant resource lookups return HTTP 404 rather than 403, preventing attackers from probing for the existence of valid IDs.
  - Workspace-bound offline caching in browser local storage rejecting foreign tenant data.

---

### Threat 3: Sensitive Data Exposure & Cryptographic Failures
* **Threat**: Storage of plaintext passwords or payment tokens, exposure of hashes in API responses, timing attacks.
* **Defensive Controls**:
  - Scrypt password hashing with 16-byte random salts and constant-time buffer comparison (`crypto.timingSafeEqual`) defending against side-channel timing analysis.
  - AES-256-GCM encryption for reusable payment authorizations using unique per-workspace derived keys.
  - Safe profile sanitizers strictly excluding `password_hash`, `password_salt`, and cipher components from all API outputs.

---

### Threat 4: Payment Gateway Manipulation & Amount Tampering
* **Threat**: Malicious client tampering with subscription prices, plan tiers, or currencies during checkout.
* **Defensive Controls**:
  - Server-side pricing enforcement: Paystack initialize strictly computes amounts in integer NGN kobo from internal plan definitions (`lib/paystack.ts`).
  - Client-supplied amounts and currencies are completely ignored and discarded.
  - HMAC-SHA512 webhook signature verification ensuring only genuine Paystack events are processed.
  - Idempotent transaction ledger (`billing_ledger`) preventing double-crediting or duplicate upgrades.

---

### Threat 5: Injection Attacks (SQL Injection & XSS)
* **Threat**: SQL injection via malformed query inputs; stored or reflected XSS via user profile or shift titles.
* **Defensive Controls**:
  - Parameterized tagged-template SQL queries (`sql\`...\``) via `@neondatabase/serverless`, eliminating string concatenation.
  - Strict input validation via Zod schemas (`lib/validation.ts`) stripping disallowed characters.
  - React auto-escaping for all dynamic DOM rendering.

---

### Threat 6: Credential Stuffing & Denial of Service (DoS)
* **Threat**: Automated brute-force attacks on login, registration, password recovery, or billing initialization.
* **Defensive Controls**:
  - Sliding-window rate limiter (`lib/rate-limit.ts`) tracking requests per-IP and per-user.
  - Enforced limits:
    - `/api/auth/login`: 10 requests / minute
    - `/api/auth/register`: 10 requests / minute
    - `/api/auth/forgot-password`: 5 requests / minute
    - `/api/auth/reset-password`: 5 requests / minute
    - `/api/billing/paystack/initialize`: 10 requests / minute
  - Standard HTTP 429 responses with `Retry-After` and `X-RateLimit-*` headers.

---

### Threat 7: Mass Assignment & Unauthorized Role Escalation
* **Threat**: Client passing `role: "Admin"` during self-registration or profile update.
* **Defensive Controls**:
  - Registration route explicitly restricts self-registration to standard staff roles (`Front Desk`, `Customer Support`, `Staff`).
  - Owner and Supervisor roles can only be granted by existing workspace managers through verified database records.
  - Shift updates by non-manager employees force self-assignment (`user_id = sessionUser.id`), preventing reassigning shifts to other employees.

---

### Threat 8: Insecure Direct Object References (IDOR) & Account Enumeration
* **Threat**: Probing endpoints to discover registered customer emails or internal entity identifiers.
* **Defensive Controls**:
  - `/api/auth/forgot-password` returns identical generic HTTP 200 responses whether the submitted email exists in the database or not.
  - Cryptographic password reset tokens use HMAC-SHA256 with 1-hour expiration, stored token ID validation, and strict single-use invalidation upon consumption (`lib/password-reset.ts`).

