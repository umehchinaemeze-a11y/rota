# Rota — Database Safety Hardening & Migration Readiness Guide

## 1. Overview & Offline Diagnostic Summary

This document provides the authoritative checklist, security guarantees, command-line interfaces, and execution procedures for all database scripts in the Rota project:
1. **Migration Preflight Inspector** (`scripts/preflight-migration.mjs`) — Strictly Read-Only
2. **Team Isolation Schema Migration** (`scripts/migrate-team-isolation.mjs`) — Structural DDL / Optional Demo Seeding
3. **Default Membership Index Migration** (`scripts/migrate-default-membership-index.mjs`) — Unique Partial Index DDL
4. **Authentication Database Setup & Seed** (`scripts/setup-auth-db.mjs`) — Database Mutation (Demo Only)
5. **Supervisor Credential Reset** (`scripts/reset-chika-demo.mjs`) — Single-User Credential Update

### Shared Fail-Closed Target Guard (`scripts/db-target-guard.mjs`)
Every database script in Rota incorporates the shared, fail-closed safety guard (`scripts/db-target-guard.mjs`). Before any network connection or database client is created, every script verifies:
1. An explicit execution flag (`--run` or `--run-read-only`).
2. An explicit database-name confirmation (`--confirm-target <database-name>`).
3. An explicit exact-hostname confirmation (`--confirm-endpoint <exact-hostname>`).
4. Strict validation that the configured connection URL matches the operator's confirmed target database and hostname.
5. Rejection of unknown, unrecognized, or misspelled CLI flags.

> **CRITICAL SAFETY NOTE**: Hostname and database name equality confirms that the configured connection matches operator intent, but **DOES NOT PROVE** that a branch is disposable, isolated, or free of production traffic. Human verification in the **Neon Console** is strictly required to verify branch isolation before executing any mutation.

---

## 2. Command Classification & Interface Matrix

| Script | Invocation Mode | Command Syntax | Pre-Connection Hostname & DB Check? | Transaction Wrapped? | Database Mutation? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`preflight-migration.mjs`** | **Dry-Run (Default)** | `node scripts/preflight-migration.mjs` | N/A (Exits with notice; 0 queries) | N/A | No |
| **`preflight-migration.mjs`** | **Read-Only Inspection** | `node scripts/preflight-migration.mjs --run-read-only --confirm-target <db> --confirm-endpoint <host>` | **Yes** (Offline URL validation + `current_database()` match) | **Yes** (`BEGIN TRANSACTION READ ONLY;` + `ROLLBACK;`) | **No** (Guarded by AST keyword filter & read-only TX) |
| **`migrate-team-isolation.mjs`** | **Dry-Run (Default)** | `node scripts/migrate-team-isolation.mjs` | N/A (Exits with notice; 0 queries) | N/A | No |
| **`migrate-team-isolation.mjs`** | **Structural Schema DDL (Default Safe Mode)** | `node scripts/migrate-team-isolation.mjs --run --confirm-target <db> --confirm-endpoint <host>` | **Yes** (Validates target before client construction) | **Yes** (`BEGIN;` ... `COMMIT;` with rollback on error) | **Yes** (Creates `teams`, `team_memberships`, `shifts.team_id`, index; zero demo data) |
| **`migrate-team-isolation.mjs`** | **Optional Demo Seeding Mode** | `node scripts/migrate-team-isolation.mjs --run --seed-demo-team --confirm-target <db> --confirm-endpoint <host>` | **Yes** (Validates target before client construction) | **Yes** (`BEGIN;` ... `COMMIT;` with rollback on error) | **Yes** (Applies DDL + seeds "Main Operations" + maps 5 demo users and shifts) |
| **`migrate-default-membership-index.mjs`** | **Index DDL** | `node scripts/migrate-default-membership-index.mjs --run --confirm-target <db> --confirm-endpoint <host>` | **Yes** (Validates target before client construction) | **Yes** (`BEGIN;` ... `COMMIT;` with rollback on error) | **Yes** (Unique partial index on `team_memberships(user_id) WHERE is_default = TRUE`) |
| **`setup-auth-db.mjs`** | **Schema & Seed Mutation (Demo Only)** | `node scripts/setup-auth-db.mjs --run --confirm-target <db> --confirm-endpoint <host>` | **Yes** (Validates target before client construction) | **Yes** (`BEGIN;` ... `COMMIT;` with rollback on error) | **Yes** (Insert-only seed; `ON CONFLICT DO NOTHING`) |
| **`reset-chika-demo.mjs`** | **Single-User Reset** | `node --experimental-strip-types scripts/reset-chika-demo.mjs --run --out-file <path> --confirm-target <db> --confirm-endpoint <host>` | **Yes** (Validates target & path before client construction) | **Yes** (`BEGIN;` ... `COMMIT;` with `FOR UPDATE` lock) | **Yes** (Updates single supervisor user hash/salt) |

---

## 3. Security Guarantees & Safeguards for Real Users

### A. Zero Demo-Account Prerequisite for Schema Migration
* Structural schema migration (`migrate-team-isolation.mjs --run`) is **100% decoupled** from demo accounts.
* It does not require `@rota.local` accounts, does not create fake accounts, and does not query or mutate the `users` table.
* In `scripts/preflight-migration.mjs`, missing demo accounts are reported as an **informational notice**, allowing real-user databases to pass preflight with zero critical blockers.
* Legacy demo fixture seeding is strictly gated behind the explicit opt-in flag `--seed-demo-team`. Without this flag, zero demo records are created.

### B. Preservation of Existing Credentials, Password Hashes, and Active Sessions
* The `users` table is never modified, updated, or deleted during structural migration.
* Existing password hashes (`password_hash`) and unique 16-byte random salts (`password_salt`) are completely preserved.
* Active user session tokens (signed HMAC-SHA256 cookies) remain cryptographically valid.

### C. Strict Two-Factor Confirmation Flags
* `--confirm-target <database-name>` (or `--confirm-database`): Specifies the expected Postgres database name (e.g. `neondb`).
* `--confirm-endpoint <exact-hostname>` (or `--confirm-hostname`, `--confirm-host`): Specifies the exact fully qualified hostname (e.g. `ep-staging-xyz.us-east-2.aws.neon.tech`). Partial prefixes (`ep-staging`), ports (`:5432`), and URL schemes (`https://`) are rejected.

### D. Validation Precedes Client Construction
In all database scripts, target verification is executed in memory against the parsed `DATABASE_URL` before any database client object (`Client` or `neon`) is instantiated or any socket connection is attempted. If a mismatch or malformed URL is detected, the process aborts immediately with exit code 1.

### E. Zero Credential Exposure
* Connection strings, passwords, auth tokens, and full private Neon hostnames are automatically masked in all console outputs, diagnostic reports, and error messages.
* Production hostnames are sanitized using format masking (e.g., `ep-mute***.c-7.us-east-2.aws.neon.tech`).

---

## 4. Existing-User Onboarding & Legacy Shifts Blocker

### A. Post-Migration Existing User Onboarding Flow
1. When an existing real user logs in after the schema migration, `lib/session.ts` revalidates their user ID against `team_memberships`.
2. Because the user has no team membership yet, their session resolves with `teamId: null`.
3. In the UI (`app/page.tsx`), `shiftLoadStatus === "forbidden"` triggers the onboarding banner:
   *"Welcome to Rota, [Name]! Your account is ready, but you aren't part of an active workspace yet. Create your clinic or organization workspace below to start scheduling shifts as the workspace Owner."*
4. The user enters their workspace name and submits `POST /api/teams`.
5. The API atomically:
   - Creates the `teams` row with a collision-resistant unique slug.
   - Inserts a `team_memberships` row assigning the user as `'Owner'` with `is_default = TRUE`.
   - Returns an updated session cookie containing their authoritative `teamId`.
6. The user is now the Owner of their workspace and can create and manage shifts.

### B. Legacy Shifts Architecture Blocker (Quarantined Shifts)
* In a pre-migration database, existing shift records do not have a `team_id` column.
* Structural migration adds `shifts.team_id` as a nullable foreign key (`INTEGER REFERENCES teams(id)`).
* All pre-migration shifts have `team_id = NULL`.
* **Tenant Isolation Guarantee**: Because the scheduling API (`app/api/shifts/route.ts`) enforces `WHERE team_id = ${sessionUser.teamId}`, shifts with `team_id = NULL` are quarantined from all workspace views.
* **Why Automatic Migration-Time Assignment Was Rejected**:
  - Automatically assigning all legacy shifts to the first created workspace or a synthetic workspace would violate tenant isolation boundaries, potentially exposing Clinic A's shifts to Clinic B.
  - Automatically assigning shifts based solely on `user_id` is impossible at migration time because users have not yet created or joined workspaces.
  - Shifts with `user_id IS NULL` (unassigned legacy shifts) have no verifiable organizational owner.

### C. Safe Legacy Shift Recovery Workflow (`/api/shifts/recover`)
To safely bridge legacy shifts into multi-tenant workspaces without violating isolation boundaries, Rota implements an authenticated, tenant-isolated recovery workflow (`lib/shift-recovery.ts` and `app/api/shifts/recover/route.ts`):
1. **User Identity Attribution (`shifts.user_id = sessionUser.userId`)**: An authenticated user may only inspect and recover shifts where `shifts.user_id` strictly matches their own authenticated database `userId`. Recovery based on employee name, email similarity, or guesswork is strictly rejected.
2. **Authorized Workspace Target**: Shifts are assigned exclusively to a workspace where the user has verified membership in `team_memberships`. Unverified target workspaces are rejected with HTTP 403 Forbidden.
3. **Cross-User Protection & Privacy**: A user can never view or claim another user's unassigned shifts. Any request attempting to claim shifts belonging to another user or unowned shifts is rejected with HTTP 403.
4. **Concurrency & Atomicity Protection**: Recovery uses a single PostgreSQL CTE with a `FOR UPDATE` row lock and `WHERE s.team_id IS NULL`:
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
   If two requests attempt to claim the same shifts concurrently, row-level locks serialize execution; the second request sees 0 candidate rows and updates 0 rows, completely preventing double-assignment.
5. **Data Field Preservation**: The query strictly modifies only `team_id`. Shift IDs, dates, roles, employee names, and created_at timestamps remain 100% intact.
6. **Idempotency**: Repeated requests safely return `recoveredCount: 0` without error.

### D. Unassigned Orphan Shift Handling & Required Administrator Workflow (`user_id IS NULL`)
Shifts where `shifts.user_id IS NULL` cannot be claimed through the self-service recovery API because employee names are ambiguous and cannot be relationally verified against an account. To protect customer data:
1. **Fail-Closed Principle**: Orphan shifts remain unassigned (`team_id IS NULL`, `user_id IS NULL`). They are never exposed in user schedules or self-service recovery listings.
2. **Required Administrator Workflow**:
   * **Step 1 — Discovery & Audit**: Query unassigned orphan records:
     ```sql
     SELECT id, employee_name, role, shift_day, created_at
     FROM shifts
     WHERE user_id IS NULL AND team_id IS NULL
     ORDER BY shift_day ASC, id ASC;
     ```
   * **Step 2 — Offline Verification**: Cross-reference each shift's `employee_name` and `shift_day` with verified employment contracts, timecards, or payroll timesheets. Never guess or rely on loose string matching.
   * **Step 3 — User Account Onboarding**: Ensure the employee has registered an account and been added to their authorized workspace (`team_memberships`).
   * **Step 4 — Audited Manual Assignment**: Execute an explicit, logged SQL update setting both `user_id` and `team_id`:
     ```sql
     UPDATE shifts
     SET user_id = <verified_user_id>, team_id = <authorized_team_id>
     WHERE id = <shift_id> AND user_id IS NULL AND team_id IS NULL;
     ```
   * **Step 5 — Archival**: Any orphan shift whose ownership cannot be proven remains archived with `team_id IS NULL` and `user_id IS NULL`.

---

## 5. Pre-Migration Staging Alignment Checklist (Neon Console)

Before requesting operator authorization to run the preflight inspection or schema migration against a live database, complete the following steps in the **Neon Console**:

1. [ ] **Access Neon Console**: Log in to [https://console.neon.tech/](https://console.neon.tech/) and navigate to the Rota database project.
2. [ ] **Verify Production State**: Confirm the primary branch (`main`) is healthy and that no active write traffic or DDL locks exist.
3. [ ] **Create Disposable Staging Branch**:
   - In the Branches tab, click **New Branch**.
   - Set **Branch name**: `staging-migration-test` (or similar descriptive tag).
   - Set **Parent branch**: `main` (ensures staging has an exact point-in-time copy of the schema and shift records).
4. [ ] **Copy Staging Connection Details**:
   - In the Connection Details widget, select branch: `staging-migration-test`.
   - Copy the connection string (note the exact endpoint hostname, e.g. `ep-dryrun-***.us-east-2.aws.neon.tech` and database name `neondb`).
5. [ ] **Configure Local Staging Environment**:
   - Temporarily update `DATABASE_URL` in `rota/web/.env.local` with the staging branch connection string (or export `DATABASE_URL` in your terminal session).
   - Ensure the connection string includes `sslmode=require`.

---

## 6. Execution Workflow (Requires Explicit Operator Authorization)

> **SAFETY MANDATE**: Steps 6A, 6B, and 6C require explicit operator authorization before execution. **NEVER run mutations against production.**

### Step 6A: Read-Only Preflight Inspection (Zero Mutations)
Run the fail-closed read-only preflight inspector against the staging endpoint:

```bash
node scripts/preflight-migration.mjs \
  --run-read-only \
  --confirm-target neondb \
  --confirm-endpoint ep-dryrun-***.us-east-2.aws.neon.tech
```

**Verified Read-Only Checks**:
- Exact database name and endpoint match confirmed values.
- Base tables `users` and `shifts` exist; `teams` and `team_memberships` do not yet exist.
- Demo accounts status is reported (informational on real-user databases; zero critical errors).
- Shift records are counted and categorized (eligible, unassigned, non-demo).
- No conflicting locks or active queries block DDL execution.
- Transaction terminates with `ROLLBACK;` and closes connection.

### Step 6B: Structural Schema Migration (Real-User Safe)
Only after Step 6A exits with status `0` ("PREFLIGHT PASSED"), execute the atomic structural migration against the staging branch:

```bash
node scripts/migrate-team-isolation.mjs \
  --run \
  --confirm-target neondb \
  --confirm-endpoint ep-dryrun-***.us-east-2.aws.neon.tech
```

**Expected Results**:
- `teams` table created with unique slug index.
- `team_memberships` table created with foreign keys `ON DELETE CASCADE`.
- `team_id` column added to `shifts` and index `idx_shifts_team_id` created.
- Zero demo users or demo workspaces created.
- Existing user records and password credentials remain 100% untouched.
- Single transaction commits cleanly.

### Step 6C: Unique Partial Index Migration
Apply the unique partial index guaranteeing at most one default workspace per user:

```bash
node scripts/migrate-default-membership-index.mjs \
  --run \
  --confirm-target neondb \
  --confirm-endpoint ep-dryrun-***.us-east-2.aws.neon.tech
```

---

## 7. Post-Migration Verification & Rollback Procedures

### Post-Migration Verification
1. Rerun the preflight inspector in read-only mode:
   ```bash
   node scripts/preflight-migration.mjs --run-read-only --confirm-target neondb --confirm-endpoint <staging-hostname>
   ```
2. Verify that `teams`, `team_memberships`, `shifts.team_id`, and `idx_shifts_team_id` report as **Present**.

### Safest Rollback Procedure: Delete Disposable Staging Branch
Because the migration is tested on a disposable Neon branch, the cleanest and safest rollback is to simply delete the branch in the Neon Console:
```bash
# In Neon Console or CLI:
neon branches delete staging-migration-test
```
Using disposable Neon branches eliminates any risk of partial rollbacks, schema drift, or production downtime.

### Rollback Risks on Persistent Databases
If manual rollback is run on a persistent database:
```sql
-- DANGEROUS: Destroys all workspace associations and real tenant data
ALTER TABLE shifts DROP COLUMN IF EXISTS team_id;
DROP TABLE IF EXISTS team_memberships;
DROP TABLE IF EXISTS teams;
```
> **HIGH RISK**: Dropping `teams` and `team_memberships` permanently deletes all workspaces and memberships created by real users. Never execute manual drop statements on production without a full point-in-time backup.

---

## 8. Hardening Audit Confirmation

* **Zero Live Connections**: No live database connections were opened during this safety hardening task.
* **Zero SQL Queries Executed**: No real SQL statements, schema modifications, or seed operations were run.
* **100% Mocked & Subprocess Tested**: All safety guards, hostname rejection rules, insert-only seed protections, and rollback triggers are verified with 92 offline unit and integration tests (`tests/team-isolation.test.mjs`) and 44 hardening tests (`tests/database-safety-hardening.test.mjs`, `tests/default-membership-migration.test.mjs`).

