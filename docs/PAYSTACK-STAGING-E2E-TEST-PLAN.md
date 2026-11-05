# Paystack Billing Migration — Staging End-to-End Verification Plan

**Specification Reference**: Specification v2.0.0 (Merchant-Managed Recurring Billing via Reusable Authorizations)
**Target Environment**: Neon Disposable Staging Branch
**Target Hostname**: `ep-quiet-mode-b5gula0k-pooler.c-7.us-east-2.aws.neon.tech`
**Database**: `neondb`
**Production Access Status**: Strictly Prohibited and Hard-Blocked

---

## 1. Safety Invariants & Preflight Gatekeeping

Before running staging end-to-end scenarios, verify that:
1. **Target Guard**: Database connections strictly target the staging Neon branch. Attempting to connect to the production host (`ep-lingering-bread-b5kncjhq-pooler.c-7.us-east-2.aws.neon.tech`) will trigger an immediate fail-closed termination via `scripts/migrate-paystack-billing.mjs`.
2. **Environment Isolation**: `.env.billing-staging.local` is used for staging credentials with placeholders for API secrets:
   ```env
   DATABASE_URL=postgresql://neondb_owner:***@ep-quiet-mode-b5gula0k-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require
   PAYSTACK_SECRET_KEY=sk_test_placeholder_for_staging_only
   PAYSTACK_PUBLIC_KEY=pk_test_placeholder_for_staging_only
   PAYSTACK_AUTH_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
   CRON_SECRET=staging_cron_trigger_secret_key
   ```
3. **Financial Units**: All pricing transactions must validate against approved integer kobo:
   - **Free**: ₦0 (0 kobo, 5 seats)
   - **Starter**: ₦15,000 (1,500,000 kobo, 15 seats)
   - **Pro**: ₦45,000 (4,500,000 kobo, 50 seats)
   - **Enterprise**: ₦150,000 (15,000,000 kobo, 500 seats)
4. **No Real Money / No Live Cards**: Only official Paystack test cards (e.g. `4081 0000 0000 0000`) and test bank channels are permitted.

---

## 2. Test Execution Matrix

| Test Scenario | Module / Endpoint Under Test | Primary Safety Invariant | Expected Outcome |
| :--- | :--- | :--- | :--- |
| **Scenario 1**: Initial Checkout Initialization | `POST /api/billing/paystack/initialize` | Server-side NGN kobo validation & tenant isolation | Generates unique reference `pstk_init_{teamId}_{plan}_{timestamp}`, binds workspace metadata, returns Paystack authorization URL. |
| **Scenario 2**: Authoritative Payment Confirmation | `POST /api/billing/paystack/verify` | Gateway verification, amount/currency matching | Verifies transaction on Paystack gateway. Checks `currency === 'NGN'`, `amount === expectedKobo`, `metadata.workspace_id === session.teamId`. If reusable, encrypts auth code with AES-256-GCM. Activates subscription. |
| **Scenario 3**: Reusable Authorization & Safe Storage | `lib/billing-storage.ts` & `lib/paystack-security.ts` | Zero plaintext authorization codes in DB or logs | `paystack_auth_cipher`, `paystack_auth_iv`, and `paystack_auth_tag` populated in DB. `auto_renew_enabled = TRUE`. Plaintext auth code never logged or leaked. |
| **Scenario 4**: Webhook Ingestion & Deduplication | `POST /api/billing/paystack/webhook` | HMAC-SHA512 constant-time verification & event deduplication | Raw body verified against `x-paystack-signature`. Event recorded in `billing_events`. Duplicate events return HTTP 200 with `duplicate: true`. |
| **Scenario 5**: Out-of-Order Callback / Webhook Arrival | `POST /api/billing/paystack/webhook` vs `/api/billing/paystack/verify` | Race-condition resilience & ledger deduplication | Whichever arrives first activates subscription; the latter is idempotently reconciled via unique transaction reference in `billing_ledger`. |
| **Scenario 6**: Calendar-Month Renewal Cycle | `POST /api/billing/paystack/renew` (`lib/paystack-renewal-engine.ts`) | Renewal lease lock & calendar anchor preservation | Worker acquires PostgreSQL lease (`renewal_lease_token`). Decrypts auth code off-session. Initiates charge with deterministic reference. On success, advances period end to next calendar month preserving `billing_anchor_day`. |
| **Scenario 7**: Network Timeout & Uncertain Outcome Reconciliation | `lib/paystack-renewal-engine.ts` | Zero duplicate external charges after timeouts | If gateway charge request times out, status transitions to `reconciliation_required`. Subsequent cycle verifies gateway transaction by deterministic reference before retrying. |
| **Scenario 8**: Failed Charge, Retries & 7-Day Grace Period | `lib/paystack-renewal-engine.ts` | Grace period schedule (retries ~days 2, 4, 6) | Charge failure sets subscription to `past_due`, increments `retry_count`, sets `next_retry_at = now + 48h`, sets `grace_period_expires_at = now + 7d`. Access remains active during grace. |
| **Scenario 9**: Grace Period Expiration & Auto-Cancel | `lib/paystack-renewal-engine.ts` | Safe cancellation after Day 7 | When `now >= grace_period_expires_at`, subscription transitions to `canceled` and `auto_renew_enabled = FALSE`. Workspace shifts and members remain untouched. |
| **Scenario 10**: Merchant-Managed Cancellation & Scheduled Downgrade | `POST /api/billing/paystack/cancel` | Non-destructive downgrade; zero member deletion | Sets `cancel_at_period_end = TRUE` and `auto_renew_enabled = FALSE`. Stops scheduled charges immediately. Workspace members, shifts, and data remain preserved. |
| **Scenario 11**: Provider Exclusivity & Stripe Isolation | `lib/billing-storage.ts` | Provider boundary enforcement | Stripe workspaces are never processed by Paystack renewal engine. Paystack webhooks never mutate Stripe subscription IDs or customers. |

---

## 3. Step-by-Step Staging Verification Runbook

### Step 1: Pre-Execution Schema Check
Run the database guard dry-run to ensure staging schema is healthy:
```powershell
node scripts/migrate-paystack-billing.mjs
```
*Verification criteria*: Outputs `DRY-RUN / PREVIEW: Migration plan inspection complete. Zero database writes executed.` Confirms presence of columns `payment_provider`, `paystack_customer_code`, `paystack_auth_cipher`, `auto_renew_enabled`, `billing_anchor_day`, `renewal_lease_token`.

### Step 2: Checkout Initialization
1. Authenticate as a staging workspace manager.
2. Send checkout request:
   ```http
   POST /api/billing/paystack/initialize
   Content-Type: application/json

   {
     "targetPlan": "starter",
     "consentRecurring": true
   }
   ```
3. *Expected Response*:
   ```json
   {
     "plan": "starter",
     "seats": 15,
     "amountKobo": 1500000,
     "currency": "NGN",
     "authorizationUrl": "https://checkout.paystack.com/...",
     "reference": "pstk_init_<teamId>_starter_<timestamp>"
   }
   ```

### Step 3: Complete Payment on Paystack Checkout
1. Open the returned authorization URL.
2. Select card payment and use Paystack test card:
   - Card Number: `4081 0000 0000 0000`
   - Exp: `12/30`
   - CVV: `123`
   - PIN: `1234`
   - OTP: `128` (Success)
3. Return to Rota callback: `/api/billing/paystack/verify?reference=<reference>`.

### Step 4: Verification & Database Assertion
Query the staging database to confirm proper encryption and status:
```sql
SELECT team_id, plan_id, seats, status, payment_provider,
       auto_renew_enabled, card_brand, card_last4, billing_anchor_day,
       (paystack_auth_cipher IS NOT NULL) AS has_cipher,
       (paystack_auth_iv IS NOT NULL) AS has_iv,
       (paystack_auth_tag IS NOT NULL) AS has_tag
FROM workspace_subscriptions
WHERE team_id = <teamId>;
```
*Expected Result*:
- `payment_provider`: `'paystack'`
- `status`: `'active'`
- `auto_renew_enabled`: `true` (if reusable)
- `card_brand`: `'visa'`
- `card_last4`: `'0000'`
- `has_cipher`: `true`
- `has_iv`: `true`
- `has_tag`: `true`
- No plaintext authorization code stored anywhere.

### Step 5: Webhook Signature & Idempotency Testing
Send a mock signed webhook simulating Paystack event:
```powershell
# Compute HMAC-SHA512 of payload using PAYSTACK_SECRET_KEY
# Send POST to /api/billing/paystack/webhook with header x-paystack-signature
```
*Verification criteria*:
1. First delivery returns `{ "received": true, "reconciled": true }`.
2. Second delivery with identical payload returns `{ "received": true, "duplicate": true }`.

### Step 6: Renewal Engine Simulation
Trigger a renewal cycle via the protected renewal endpoint:
```http
POST /api/billing/paystack/renew
Authorization: Bearer staging_cron_trigger_secret_key
Content-Type: application/json
```
*Verification criteria*:
1. Renewal lease acquired.
2. Prior check executed against deterministic reference `pstk_renew_<teamId>_<periodEnd>_0`.
3. Period advanced exactly one UTC calendar month preserving `billing_anchor_day`.
4. Ledger entry recorded in `billing_ledger`.

### Step 7: Cancellation & Non-Destructive Downgrade Verification
Execute cancellation request:
```http
POST /api/billing/paystack/cancel
```
*Verification criteria*:
1. Database reflects `cancel_at_period_end = true` and `auto_renew_enabled = false`.
2. All shifts for the workspace remain in `shifts` table.
3. All team memberships in `team_memberships` remain intact.

---

## 4. Rollback and Disaster Recovery Plan

If any critical discrepancy occurs during staging verification:
1. **Disable Auto-Renew**: Execute emergency local disable script:
   ```sql
   UPDATE workspace_subscriptions
   SET auto_renew_enabled = FALSE
   WHERE payment_provider = 'paystack';
   ```
2. **DDL Rollback**: If schema rollback is required on the staging branch, execute the non-destructive rollback script in `scripts/migrate-paystack-billing.mjs`:
   - Preserves all Stripe columns and ledger records.
   - Clears Paystack columns safely.
