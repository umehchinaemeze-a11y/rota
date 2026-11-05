import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  encryptAuthorizationCode,
  decryptAuthorizationCode,
  validateEncryptionKey,
  verifyPaystackSignature,
} from "../lib/paystack-security.ts";

import {
  advanceCalendarMonth,
  advanceCalendarMonths,
  resolveAnchorDay,
  isLeapYear,
  daysInMonthUtc,
  isValidAnchorDay,
} from "../lib/billing-calendar.ts";

import {
  MockPaystackClient,
  PaystackClient,
} from "../lib/paystack.ts";

// Standard 64-hex char test key (32 bytes)
const VALID_TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SECOND_VALID_KEY_HEX = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("Paystack Security — AES-256-GCM Authorization Encryption & Decryption", () => {
  it("encrypts and successfully decrypts a Paystack authorization code", () => {
    const authCode = "AUTH_w197nnua42";
    const encrypted = encryptAuthorizationCode(authCode, VALID_TEST_KEY_HEX);

    assert.ok(encrypted.cipherText, "Ciphertext must be generated");
    assert.ok(encrypted.iv, "IV must be generated");
    assert.ok(encrypted.tag, "Authentication tag must be generated");

    const decrypted = decryptAuthorizationCode(encrypted, VALID_TEST_KEY_HEX);
    assert.equal(decrypted, authCode, "Decrypted code must exactly match original plaintext");
  });

  it("generates a fresh, unique 12-byte IV for every encryption call", () => {
    const authCode = "AUTH_reusable_token_999";
    const enc1 = encryptAuthorizationCode(authCode, VALID_TEST_KEY_HEX);
    const enc2 = encryptAuthorizationCode(authCode, VALID_TEST_KEY_HEX);

    // IVs must be completely distinct
    assert.notEqual(enc1.iv, enc2.iv, "Each encryption must use a unique IV");
    // Ciphertexts must also be distinct due to distinct IVs
    assert.notEqual(enc1.cipherText, enc2.cipherText, "Identical plaintext must yield different ciphertexts");

    // Both must decrypt cleanly to the original plaintext
    assert.equal(decryptAuthorizationCode(enc1, VALID_TEST_KEY_HEX), authCode);
    assert.equal(decryptAuthorizationCode(enc2, VALID_TEST_KEY_HEX), authCode);
  });

  it("fails closed when ciphertext is tampered with", () => {
    const authCode = "AUTH_secure_12345";
    const enc = encryptAuthorizationCode(authCode, VALID_TEST_KEY_HEX);

    // Corrupt the ciphertext
    const rawCipher = Buffer.from(enc.cipherText, "base64");
    rawCipher[0] ^= 0xff; // Flip bits
    const tamperedEnc = {
      ...enc,
      cipherText: rawCipher.toString("base64"),
    };

    assert.throws(
      () => decryptAuthorizationCode(tamperedEnc, VALID_TEST_KEY_HEX),
      /authentication tag verification failed|corrupted/
    );
  });

  it("fails closed when authentication tag is tampered with or replaced", () => {
    const authCode = "AUTH_secure_12345";
    const enc = encryptAuthorizationCode(authCode, VALID_TEST_KEY_HEX);

    // Corrupt tag
    const rawTag = Buffer.from(enc.tag, "base64");
    rawTag[0] ^= 0x55;
    const tamperedEnc = {
      ...enc,
      tag: rawTag.toString("base64"),
    };

    assert.throws(
      () => decryptAuthorizationCode(tamperedEnc, VALID_TEST_KEY_HEX),
      /authentication tag verification failed|corrupted/
    );
  });

  it("fails closed when initialization vector (IV) is tampered with", () => {
    const authCode = "AUTH_secure_12345";
    const enc = encryptAuthorizationCode(authCode, VALID_TEST_KEY_HEX);

    // Corrupt IV
    const rawIv = Buffer.from(enc.iv, "base64");
    rawIv[0] ^= 0xaa;
    const tamperedEnc = {
      ...enc,
      iv: rawIv.toString("base64"),
    };

    assert.throws(
      () => decryptAuthorizationCode(tamperedEnc, VALID_TEST_KEY_HEX),
      /authentication tag verification failed|corrupted/
    );
  });

  it("fails closed when decrypted with a different key", () => {
    const authCode = "AUTH_secret_cross_key";
    const enc = encryptAuthorizationCode(authCode, VALID_TEST_KEY_HEX);

    assert.throws(
      () => decryptAuthorizationCode(enc, SECOND_VALID_KEY_HEX),
      /authentication tag verification failed|corrupted/
    );
  });

  it("strictly validates PAYSTACK_AUTH_ENCRYPTION_KEY length and format", () => {
    // Missing key
    assert.throws(() => validateEncryptionKey(""), /PAYSTACK_AUTH_ENCRYPTION_KEY is required/);
    assert.throws(() => validateEncryptionKey(undefined), /PAYSTACK_AUTH_ENCRYPTION_KEY is required/);

    // Too short (63 hex chars instead of 64)
    const tooShort = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde";
    assert.throws(() => validateEncryptionKey(tooShort), /must be exactly 64 hexadecimal characters/);

    // Too long (65 hex chars)
    const tooLong = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0";
    assert.throws(() => validateEncryptionKey(tooLong), /must be exactly 64 hexadecimal characters/);

    // Non-hex characters
    const nonHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg"; // 'g' is non-hex
    assert.throws(() => validateEncryptionKey(nonHex), /must be exactly 64 hexadecimal characters/);

    // Valid 64-hex Buffer output length must be exactly 32 bytes
    const keyBuf = validateEncryptionKey(VALID_TEST_KEY_HEX);
    assert.equal(keyBuf.length, 32);
  });

  it("never leaks plaintext authorization codes in error messages", () => {
    const sensitiveToken = "AUTH_sensitive_leak_probe_secret_token";
    try {
      // Intentionally trigger failure by supplying corrupted key
      encryptAuthorizationCode(sensitiveToken, "invalid_short_key");
      assert.fail("Should have thrown error");
    } catch (err) {
      assert.doesNotMatch(err.message, new RegExp(sensitiveToken));
    }
  });

  it("verifies Paystack webhook signatures using HMAC-SHA512 with constant-time equality", () => {
    const secret = "sk_test_paystack_secret_key_12345";
    const rawBody = JSON.stringify({ event: "charge.success", data: { id: 101, reference: "ref_1" } });

    // Compute valid signature
    const hmac = crypto.createHmac("sha512", secret);
    const validSignature = hmac.update(rawBody).digest("hex");

    assert.equal(verifyPaystackSignature(rawBody, validSignature, secret), true);

    // Forged / wrong signature
    const badSignature = validSignature.slice(0, -4) + "0000";
    assert.equal(verifyPaystackSignature(rawBody, badSignature, secret), false);

    // Wrong secret
    assert.equal(verifyPaystackSignature(rawBody, validSignature, "sk_different_secret"), false);

    // Tampered payload
    const tamperedBody = rawBody + " ";
    assert.equal(verifyPaystackSignature(tamperedBody, validSignature, secret), false);

    // Missing or invalid header format
    assert.equal(verifyPaystackSignature(rawBody, null, secret), false);
    assert.equal(verifyPaystackSignature(rawBody, "", secret), false);
    assert.equal(verifyPaystackSignature(rawBody, "short_sig", secret), false);
  });
});

describe("Calendar-Month Billing — UTC Month Advancement & Anchor Pinning", () => {
  it("pins anchor day 31 across months: Jan 31 -> Feb 28 -> Mar 31 in non-leap year (2027)", () => {
    const anchor = 31;
    const jan31 = new Date(Date.UTC(2027, 0, 31, 14, 30, 0)); // Jan 31, 2027

    // Jan 31 -> Feb 28 (clamped to month-end)
    const feb = advanceCalendarMonth(jan31, anchor);
    assert.equal(feb.getUTCFullYear(), 2027);
    assert.equal(feb.getUTCMonth(), 1); // February (0-indexed)
    assert.equal(feb.getUTCDate(), 28); // 2027 is non-leap
    assert.equal(feb.getUTCHours(), 14);
    assert.equal(feb.getUTCMinutes(), 30);

    // Feb 28 (with anchor 31) -> Mar 31 (anchor restored!)
    const mar = advanceCalendarMonth(feb, anchor);
    assert.equal(mar.getUTCFullYear(), 2027);
    assert.equal(mar.getUTCMonth(), 2); // March
    assert.equal(mar.getUTCDate(), 31, "March must restore the original 31 anchor day!");

    // Mar 31 -> Apr 30 (clamped to 30)
    const apr = advanceCalendarMonth(mar, anchor);
    assert.equal(apr.getUTCFullYear(), 2027);
    assert.equal(apr.getUTCMonth(), 3); // April
    assert.equal(apr.getUTCDate(), 30);

    // Apr 30 (with anchor 31) -> May 31 (anchor restored!)
    const may = advanceCalendarMonth(apr, anchor);
    assert.equal(may.getUTCFullYear(), 2027);
    assert.equal(may.getUTCMonth(), 4); // May
    assert.equal(may.getUTCDate(), 31, "May must restore the original 31 anchor day!");
  });

  it("handles leap years correctly in UTC: Jan 31, 2028 -> Feb 29, 2028 -> Mar 31, 2028", () => {
    const anchor = 31;
    const jan31 = new Date(Date.UTC(2028, 0, 31, 12, 0, 0)); // Leap year 2028

    const feb29 = advanceCalendarMonth(jan31, anchor);
    assert.equal(feb29.getUTCFullYear(), 2028);
    assert.equal(feb29.getUTCMonth(), 1); // February
    assert.equal(feb29.getUTCDate(), 29, "2028 is a leap year; Feb must clamp to 29");

    const mar31 = advanceCalendarMonth(feb29, anchor);
    assert.equal(mar31.getUTCFullYear(), 2028);
    assert.equal(mar31.getUTCMonth(), 2); // March
    assert.equal(mar31.getUTCDate(), 31, "March must restore the original 31 anchor day in leap year");
  });

  it("advances across Gregorian year boundaries: Dec 31, 2026 -> Jan 31, 2027", () => {
    const dec31 = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    const jan31 = advanceCalendarMonth(dec31, 31);

    assert.equal(jan31.getUTCFullYear(), 2027);
    assert.equal(jan31.getUTCMonth(), 0); // January
    assert.equal(jan31.getUTCDate(), 31);
    assert.equal(jan31.getUTCHours(), 23);
    assert.equal(jan31.getUTCMinutes(), 59);
    assert.equal(jan31.getUTCSeconds(), 59);
  });

  it("never behaves like a fixed 30-day period", () => {
    const jan31 = new Date(Date.UTC(2027, 0, 31, 0, 0, 0));
    const calendarNext = advanceCalendarMonth(jan31, 31);

    // Fixed 30 days would add 30 * 86400 * 1000 ms, landing on March 2!
    const fixed30Days = new Date(jan31.getTime() + 30 * 86400 * 1000);
    assert.equal(fixed30Days.getUTCMonth(), 2); // March
    assert.equal(fixed30Days.getUTCDate(), 2);

    // Calendar month advancement must land in February
    assert.equal(calendarNext.getUTCMonth(), 1); // February
    assert.equal(calendarNext.getUTCDate(), 28);
    assert.notEqual(calendarNext.getTime(), fixed30Days.getTime(), "Calendar month must not equal fixed 30 days");
  });

  it("accurately reports leap years under Gregorian rules", () => {
    assert.equal(isLeapYear(2024), true);
    assert.equal(isLeapYear(2028), true);
    assert.equal(isLeapYear(2000), true); // Divisible by 400

    assert.equal(isLeapYear(2026), false);
    assert.equal(isLeapYear(2027), false);
    assert.equal(isLeapYear(1900), false); // Divisible by 100 but not 400
    assert.equal(isLeapYear(2100), false);
  });

  it("validates days in month across all 12 UTC months", () => {
    assert.equal(daysInMonthUtc(2027, 0), 31); // Jan
    assert.equal(daysInMonthUtc(2027, 1), 28); // Feb non-leap
    assert.equal(daysInMonthUtc(2028, 1), 29); // Feb leap
    assert.equal(daysInMonthUtc(2027, 2), 31); // Mar
    assert.equal(daysInMonthUtc(2027, 3), 30); // Apr
    assert.equal(daysInMonthUtc(2027, 4), 31); // May
    assert.equal(daysInMonthUtc(2027, 5), 30); // Jun
    assert.equal(daysInMonthUtc(2027, 6), 31); // Jul
    assert.equal(daysInMonthUtc(2027, 7), 31); // Aug
    assert.equal(daysInMonthUtc(2027, 8), 30); // Sep
    assert.equal(daysInMonthUtc(2027, 9), 31); // Oct
    assert.equal(daysInMonthUtc(2027, 10), 30); // Nov
    assert.equal(daysInMonthUtc(2027, 11), 31); // Dec
  });

  it("validates anchor day range (1-31) and rejects invalid values", () => {
    assert.equal(isValidAnchorDay(1), true);
    assert.equal(isValidAnchorDay(15), true);
    assert.equal(isValidAnchorDay(31), true);

    assert.equal(isValidAnchorDay(0), false);
    assert.equal(isValidAnchorDay(32), false);
    assert.equal(isValidAnchorDay(-5), false);
    assert.equal(isValidAnchorDay(15.5), false);
    assert.equal(isValidAnchorDay("15"), false);
    assert.equal(isValidAnchorDay(null), false);
  });

  it("advances multi-month spans accurately while preserving anchor", () => {
    const jan31 = new Date(Date.UTC(2027, 0, 31, 0, 0, 0));
    // Advance 2 months: Jan 31 -> Mar 31
    const mar31 = advanceCalendarMonths(jan31, 2, 31);
    assert.equal(mar31.getUTCMonth(), 2);
    assert.equal(mar31.getUTCDate(), 31);

    // Advance 3 months: Jan 31 -> Apr 30
    const apr30 = advanceCalendarMonths(jan31, 3, 31);
    assert.equal(apr30.getUTCMonth(), 3);
    assert.equal(apr30.getUTCDate(), 30);
  });
});

describe("Paystack Gateway — Provider Interface & Mock Implementation", () => {
  it("initializes a transaction with integer kobo and returns authorization URL and reference", async () => {
    const mock = new MockPaystackClient();
    const result = await mock.initializeTransaction({
      email: "dr.chika@hospital.ng",
      amountKobo: 4500000, // ₦45,000 in kobo (Pro Tier)
      currency: "NGN",
      reference: "test_ref_001",
      callbackUrl: "https://rota.app/settings?billing=success",
      metadata: {
        workspace_id: 10,
        user_id: 1,
        plan_id: "pro",
        seats: 50,
        consent_recurring: true,
      },
    });

    assert.equal(result.status, true);
    assert.equal(result.data.reference, "test_ref_001");
    assert.ok(result.data.authorization_url.includes("https://checkout.paystack.com/"));
    assert.ok(result.data.access_code);

    // Call history recorded
    assert.equal(mock.initializeCalls.length, 1);
    assert.equal(mock.initializeCalls[0].amountKobo, 4500000);
  });

  it("rejects non-integer kobo or invalid currency on initialize", async () => {
    const mock = new MockPaystackClient();

    // Floating-point kobo rejected
    await assert.rejects(
      async () => {
        await mock.initializeTransaction({
          email: "test@rota.ng",
          amountKobo: 4500.5,
          currency: "NGN",
          reference: "ref_float",
          callbackUrl: "https://rota.app",
          metadata: { workspace_id: 1, user_id: 1, plan_id: "pro", seats: 50 },
        });
      },
      /must be a positive integer in kobo/
    );

    // Unsupported currency rejected
    await assert.rejects(
      async () => {
        await mock.initializeTransaction({
          email: "test@rota.ng",
          amountKobo: 4500000,
          currency: "USD",
          reference: "ref_usd",
          callbackUrl: "https://rota.app",
          metadata: { workspace_id: 1, user_id: 1, plan_id: "pro", seats: 50 },
        });
      },
      /Unsupported currency: USD/
    );
  });

  it("verifies transaction server-side and distinguishes reusable vs non-reusable authorizations", async () => {
    const mock = new MockPaystackClient();

    // 1. Initialized with reusable card (default)
    const init1 = await mock.initializeTransaction({
      email: "alice@clinic.ng",
      amountKobo: 1500000, // ₦15,000 (Starter)
      currency: "NGN",
      reference: "ref_reusable",
      callbackUrl: "https://rota.app",
      metadata: { workspace_id: 20, user_id: 2, plan_id: "starter", seats: 15 },
    });

    const verify1 = await mock.verifyTransaction(init1.data.reference);
    assert.ok(verify1);
    assert.equal(verify1.status, true);
    assert.equal(verify1.data.status, "success");
    assert.equal(verify1.data.amount, 1500000);
    assert.equal(verify1.data.authorization.reusable, true);
    assert.ok(verify1.data.authorization.authorization_code.startsWith("AUTH_"));

    // 2. Simulated non-reusable authorization (e.g. bank transfer or one-time card)
    mock.simulateNonReusableAuthorization = true;
    const init2 = await mock.initializeTransaction({
      email: "bob@clinic.ng",
      amountKobo: 1500000,
      currency: "NGN",
      reference: "ref_non_reusable",
      callbackUrl: "https://rota.app",
      metadata: { workspace_id: 21, user_id: 3, plan_id: "starter", seats: 15 },
    });

    const verify2 = await mock.verifyTransaction(init2.data.reference);
    assert.ok(verify2);
    assert.equal(verify2.data.authorization.reusable, false, "Must detect non-reusable authorization");
  });

  it("returns null when verifying a non-existent reference", async () => {
    const mock = new MockPaystackClient();
    const result = await mock.verifyTransaction("non_existent_ref_999");
    assert.equal(result, null);
  });

  it("simulates off-session recurring authorization charge successfully", async () => {
    const mock = new MockPaystackClient();
    const chargeResult = await mock.chargeAuthorization({
      authorizationCode: "AUTH_valid_token_123",
      email: "manager@hospital.ng",
      amountKobo: 15000000, // ₦150,000 (Enterprise)
      currency: "NGN",
      reference: "renew_team_10_cycle_1",
      metadata: { workspace_id: 10, plan_id: "enterprise", seats: 500, renewal: true },
    });

    assert.equal(chargeResult.status, true);
    assert.equal(chargeResult.data.status, "success");
    assert.equal(chargeResult.data.amount, 15000000);
    assert.equal(chargeResult.data.reference, "renew_team_10_cycle_1");

    // Can be subsequently verified through the same reference
    const verify = await mock.verifyTransaction("renew_team_10_cycle_1");
    assert.ok(verify);
    assert.equal(verify.data.status, "success");
  });

  it("simulates off-session recurring authorization decline (e.g. insufficient funds)", async () => {
    const mock = new MockPaystackClient();
    mock.simulateFailureOnCharge = true;

    const chargeResult = await mock.chargeAuthorization({
      authorizationCode: "AUTH_declined_card",
      email: "manager@hospital.ng",
      amountKobo: 4500000,
      currency: "NGN",
      reference: "renew_fail_1",
      metadata: { workspace_id: 10 },
    });

    assert.equal(chargeResult.status, false);
    assert.equal(chargeResult.data.status, "failed");
    assert.ok(chargeResult.data.gateway_response.includes("Insufficient funds"));
  });

  it("simulates gateway network timeout / uncertain outcome for reconciliation testing", async () => {
    const mock = new MockPaystackClient();
    mock.simulateTimeoutOnCharge = true;

    await assert.rejects(
      async () => {
        await mock.chargeAuthorization({
          authorizationCode: "AUTH_timeout_test",
          email: "test@rota.ng",
          amountKobo: 1500000,
          currency: "NGN",
          reference: "timeout_ref_100",
        });
      },
      /timeout during off-session authorization charge/
    );
  });

  it("safe PaystackClient cleanly falls back to Mock in offline mode without credentials", async () => {
    // When no secretKey is passed and env is not set, PaystackClient uses Mock
    const client = new PaystackClient("");
    const res = await client.initializeTransaction({
      email: "offline@test.ng",
      amountKobo: 1500000,
      currency: "NGN",
      reference: "offline_ref",
      callbackUrl: "https://rota.app",
      metadata: { workspace_id: 1, user_id: 1, plan_id: "starter", seats: 15 },
    });

    assert.equal(res.status, true);
    assert.equal(res.data.reference, "offline_ref");
  });
});
