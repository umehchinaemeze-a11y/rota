import crypto from "node:crypto";

/**
 * Paystack Security & Encryption Utilities
 *
 * Implements:
 * 1. AES-256-GCM authenticated encryption and decryption for Paystack authorization codes.
 * 2. Strict key validation (exactly 64 hexadecimal characters / 32 bytes).
 * 3. Fresh 12-byte initialization vectors (IV) for every encryption operation.
 * 4. Separate storage for ciphertext, IV, and authentication tag.
 * 5. Constant-time HMAC-SHA512 webhook signature verification.
 * 6. Fail-closed security invariants: never leaks plaintext authorization codes in error messages or logs.
 */

export interface EncryptedAuthorization {
  cipherText: string; // Base64-encoded ciphertext
  iv: string;         // Base64-encoded 12-byte initialization vector
  tag: string;        // Base64-encoded 16-byte GCM authentication tag
}

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const GCM_IV_LENGTH_BYTES = 12;
const GCM_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;

/**
 * Validates and resolves a 64-character hex encryption key into a 32-byte Buffer.
 * Fails closed if the key is missing or malformed.
 */
export function validateEncryptionKey(keyInput?: string | Buffer): Buffer {
  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length !== KEY_LENGTH_BYTES) {
      throw new Error(`Invalid encryption key buffer length: expected ${KEY_LENGTH_BYTES} bytes, got ${keyInput.length}.`);
    }
    return keyInput;
  }

  const rawKey = (typeof keyInput === "string" ? keyInput : process.env.PAYSTACK_AUTH_ENCRYPTION_KEY)?.trim();
  if (!rawKey) {
    throw new Error("PAYSTACK_AUTH_ENCRYPTION_KEY is required but not configured.");
  }

  if (!HEX_64_REGEX.test(rawKey)) {
    throw new Error(
      "Invalid PAYSTACK_AUTH_ENCRYPTION_KEY format: must be exactly 64 hexadecimal characters (32 bytes)."
    );
  }

  return Buffer.from(rawKey, "hex");
}

/**
 * Encrypts a plaintext Paystack authorization code using AES-256-GCM.
 * Generates a fresh, cryptographically random 12-byte IV for every invocation.
 * Fails closed on any invalid input.
 */
export function encryptAuthorizationCode(
  authCode: string,
  keyInput?: string | Buffer
): EncryptedAuthorization {
  if (typeof authCode !== "string" || authCode.trim().length === 0) {
    throw new Error("Authorization code must be a non-empty string.");
  }

  const keyBuffer = validateEncryptionKey(keyInput);
  const iv = crypto.randomBytes(GCM_IV_LENGTH_BYTES);

  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer, iv);
  let cipherText = cipher.update(authCode.trim(), "utf8", "base64");
  cipherText += cipher.final("base64");
  const tag = cipher.getAuthTag();

  return {
    cipherText,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypts an encrypted Paystack authorization code using AES-256-GCM.
 * Validates the authentication tag and fails closed if corrupted, tampered with,
 * or decrypted with an invalid key. Never leaks plaintext in error messages.
 */
export function decryptAuthorizationCode(
  encrypted: EncryptedAuthorization,
  keyInput?: string | Buffer
): string {
  if (!encrypted || typeof encrypted !== "object") {
    throw new Error("Invalid encrypted authorization payload: object required.");
  }

  const { cipherText, iv, tag } = encrypted;
  if (
    typeof cipherText !== "string" || !cipherText ||
    typeof iv !== "string" || !iv ||
    typeof tag !== "string" || !tag
  ) {
    throw new Error("Malformed encrypted authorization: cipherText, iv, and tag are required non-empty strings.");
  }

  const keyBuffer = validateEncryptionKey(keyInput);

  let ivBuffer: Buffer;
  let tagBuffer: Buffer;
  try {
    ivBuffer = Buffer.from(iv, "base64");
    tagBuffer = Buffer.from(tag, "base64");
  } catch {
    throw new Error("Invalid Base64 encoding in encrypted authorization components.");
  }

  if (ivBuffer.length !== GCM_IV_LENGTH_BYTES) {
    throw new Error(`Invalid IV length: expected ${GCM_IV_LENGTH_BYTES} bytes, got ${ivBuffer.length}.`);
  }

  if (tagBuffer.length !== GCM_TAG_LENGTH_BYTES) {
    throw new Error(`Invalid authentication tag length: expected ${GCM_TAG_LENGTH_BYTES} bytes, got ${tagBuffer.length}.`);
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, ivBuffer);
    decipher.setAuthTag(tagBuffer);
    let decrypted = decipher.update(cipherText, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    // Fail closed with a sanitized, generic error that never reveals ciphertext or key details
    throw new Error("Decryption failed: authentication tag verification failed or ciphertext is corrupted.");
  }
}

/**
 * Verifies Paystack webhook authenticity using HMAC-SHA512 with constant-time comparison.
 * Note: Paystack signs the raw request body with PAYSTACK_SECRET_KEY.
 * It does NOT include a timestamp header.
 */
export function verifyPaystackSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secretKey?: string
): boolean {
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return false;
  }

  const secret = (secretKey || process.env.PAYSTACK_SECRET_KEY)?.trim();
  if (!secret) {
    return false;
  }

  const normalizedSig = signatureHeader.trim();
  // SHA-512 hex string must be exactly 128 hexadecimal characters
  if (normalizedSig.length !== 128 || !/^[0-9a-fA-F]{128}$/.test(normalizedSig)) {
    return false;
  }

  const payload = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const hmac = crypto.createHmac("sha512", secret);
  hmac.update(payload);
  const computedHex = hmac.digest("hex");

  try {
    const candidateBuffer = Buffer.from(normalizedSig, "hex");
    const computedBuffer = Buffer.from(computedHex, "hex");

    if (candidateBuffer.length !== computedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(candidateBuffer, computedBuffer);
  } catch {
    return false;
  }
}
