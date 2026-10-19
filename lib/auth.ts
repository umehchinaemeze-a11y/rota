import crypto from "node:crypto";

export type SessionPayload = {
  userId: number;
  email: string;
  name: string;
  role: string;
  exp: number; // Unix timestamp in seconds
};

const SCRYPT_KEYLEN = 64;

/**
 * Hashes a plaintext password using scrypt with a cryptographically secure salt.
 */
export function hashPassword(password: string): { hash: string; salt: string } {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string.");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

/**
 * Verifies a password against the stored hash and salt using timing-safe comparison.
 */
export function verifyPassword(
  password: string,
  storedHash: string,
  storedSalt: string
): boolean {
  if (
    typeof password !== "string" ||
    typeof storedHash !== "string" ||
    typeof storedSalt !== "string" ||
    !password ||
    !storedHash ||
    !storedSalt
  ) {
    return false;
  }

  try {
    const derivedKey = crypto.scryptSync(password, storedSalt, SCRYPT_KEYLEN);
    const storedKeyBuffer = Buffer.from(storedHash, "hex");

    if (derivedKey.length !== storedKeyBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(derivedKey, storedKeyBuffer);
  } catch {
    return false;
  }
}

/**
 * Creates a signed, tamper-proof session token using HMAC-SHA256.
 */
export function createSessionToken(
  payload: Omit<SessionPayload, "exp">,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 7 // 7 days default
): string {
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("AUTH_SECRET is required to sign session tokens.");
  }

  if (
    !payload ||
    typeof payload.userId !== "number" ||
    !Number.isInteger(payload.userId) ||
    payload.userId <= 0 ||
    typeof payload.email !== "string" ||
    !payload.email.trim() ||
    typeof payload.name !== "string" ||
    !payload.name.trim() ||
    typeof payload.role !== "string" ||
    !payload.role.trim()
  ) {
    throw new Error("Invalid session payload fields.");
  }

  const fullPayload: SessionPayload = {
    userId: payload.userId,
    email: payload.email.trim(),
    name: payload.name.trim(),
    role: payload.role.trim(),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString(
    "base64url"
  );
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies the HMAC-SHA256 signature and expiration of a session token.
 * Returns the payload if valid, or null if tampered, malformed, or expired.
 */
export function verifySessionToken(
  token: string,
  secret: string
): SessionPayload | null {
  if (
    !token ||
    typeof token !== "string" ||
    !secret ||
    typeof secret !== "string" ||
    secret.trim().length === 0
  ) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, providedSignature] = parts;
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(encodedPayload)
      .digest("base64url");

    const expectedBuffer = Buffer.from(expectedSignature, "utf-8");
    const providedBuffer = Buffer.from(providedSignature, "utf-8");

    if (expectedBuffer.length !== providedBuffer.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      return null;
    }

    const payloadJson = Buffer.from(encodedPayload, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson) as Partial<SessionPayload>;

    // Strict payload validation
    if (
      typeof payload.userId !== "number" ||
      !Number.isInteger(payload.userId) ||
      payload.userId <= 0 ||
      typeof payload.email !== "string" ||
      !payload.email.trim() ||
      typeof payload.name !== "string" ||
      !payload.name.trim() ||
      typeof payload.role !== "string" ||
      !payload.role.trim() ||
      typeof payload.exp !== "number" ||
      payload.exp <= 0
    ) {
      return null;
    }

    // Check expiration
    const nowInSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp < nowInSeconds) {
      return null; // Expired session
    }

    return payload as SessionPayload;
  } catch {
    return null;
  }
}
