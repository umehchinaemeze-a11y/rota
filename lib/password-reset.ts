import crypto from "node:crypto";
import { hashPassword } from "./auth.ts";
import { revokeAllUserSessions, type SqlExecutor } from "./refresh-tokens.ts";

export interface PasswordResetPayload {
  userId: number;
  email: string;
  tokenId: string;
  exp: number; // Unix timestamp in seconds
  type: "password_reset";
}

export interface PasswordResetVerificationResult {
  valid: boolean;
  error?: string;
  payload?: PasswordResetPayload;
}

// In-memory single-use registry for fast lookup & fallback when DB table is not yet migrated
const usedTokenRegistry = new Set<string>();

/**
 * Resets the in-memory token registry (for test suites).
 */
export function resetTokenRegistry(): void {
  usedTokenRegistry.clear();
}

/**
 * Creates a cryptographically signed password reset token.
 * Default expiration is 1 hour (3600 seconds).
 */
export function createPasswordResetToken(
  userId: number,
  email: string,
  secret: string,
  ttlSeconds = 3600
): { token: string; tokenId: string; expiresAt: number } {
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("AUTH_SECRET is required to sign password reset tokens.");
  }

  const tokenId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

  const payload: PasswordResetPayload = {
    userId,
    email: email.trim().toLowerCase(),
    tokenId,
    exp: expiresAt,
    type: "password_reset",
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  const token = `${encodedPayload}.${signature}`;

  return { token, tokenId, expiresAt };
}

/**
 * Ensures password_reset_tokens table exists in the database.
 */
export async function ensurePasswordResetTable(sql: SqlExecutor): Promise<void> {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
  } catch (err) {
    // Non-fatal if table creation fails in mock or constrained DB
  }
}

/**
 * Checks whether a token ID has already been consumed (single-use enforcement).
 */
export async function isResetTokenUsed(
  tokenId: string,
  sql?: SqlExecutor
): Promise<boolean> {
  if (usedTokenRegistry.has(tokenId)) {
    return true;
  }

  if (sql) {
    try {
      const rows = await sql`
        SELECT token_id FROM password_reset_tokens
        WHERE token_id = ${tokenId}
        LIMIT 1;
      `;
      if (rows && rows.length > 0) {
        usedTokenRegistry.add(tokenId);
        return true;
      }
    } catch {
      // Fall back to memory check
    }
  }

  return false;
}

/**
 * Marks a reset token as consumed so it cannot be used a second time.
 */
export async function markResetTokenUsed(
  tokenId: string,
  userId: number,
  sql?: SqlExecutor
): Promise<void> {
  usedTokenRegistry.add(tokenId);

  if (sql) {
    try {
      await ensurePasswordResetTable(sql);
      await sql`
        INSERT INTO password_reset_tokens (token_id, user_id, used_at)
        VALUES (${tokenId}, ${userId}, NOW())
        ON CONFLICT (token_id) DO NOTHING;
      `;
    } catch {
      // Ignore if table unavailable
    }
  }
}

/**
 * Verifies a password reset token:
 * 1. Validates structure and HMAC-SHA256 signature in constant time.
 * 2. Checks token expiration (1 hour max).
 * 3. Enforces single-use by ensuring token hasn't already been consumed.
 */
export async function verifyPasswordResetToken(
  token: string,
  secret: string,
  sql?: SqlExecutor
): Promise<PasswordResetVerificationResult> {
  if (!token || typeof token !== "string" || !secret || typeof secret !== "string") {
    return { valid: false, error: "Invalid token or secret." };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, error: "Malformed token format." };
  }

  const [encodedPayload, providedSignature] = parts;
  if (!encodedPayload || !providedSignature) {
    return { valid: false, error: "Malformed token format." };
  }

  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(encodedPayload)
      .digest("base64url");

    const expectedBuffer = Buffer.from(expectedSignature, "utf-8");
    const providedBuffer = Buffer.from(providedSignature, "utf-8");

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      return { valid: false, error: "Invalid token signature." };
    }

    const payloadJson = Buffer.from(encodedPayload, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson) as Partial<PasswordResetPayload>;

    if (
      typeof payload.userId !== "number" ||
      !Number.isInteger(payload.userId) ||
      payload.userId <= 0 ||
      typeof payload.email !== "string" ||
      typeof payload.tokenId !== "string" ||
      payload.type !== "password_reset" ||
      typeof payload.exp !== "number"
    ) {
      return { valid: false, error: "Invalid token payload structure." };
    }

    // Expiration check
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return { valid: false, error: "Password reset token has expired." };
    }

    // Single-use enforcement
    const alreadyUsed = await isResetTokenUsed(payload.tokenId, sql);
    if (alreadyUsed) {
      return { valid: false, error: "Password reset token has already been used." };
    }

    return { valid: true, payload: payload as PasswordResetPayload };
  } catch {
    return { valid: false, error: "Token verification failed." };
  }
}

/**
 * Resets user password in database, consumes the reset token,
 * and terminates all existing sessions for security.
 */
export async function executePasswordReset(
  sql: SqlExecutor,
  tokenId: string,
  userId: number,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { hash, salt } = hashPassword(newPassword);

    // Update password in database
    const updateResult = await sql`
      UPDATE users
      SET password_hash = ${hash},
          password_salt = ${salt},
          updated_at = NOW()
      WHERE id = ${userId}
      RETURNING id, email;
    `;

    if (!updateResult || updateResult.length === 0) {
      return { success: false, error: "User account not found." };
    }

    // Mark token consumed (single-use)
    await markResetTokenUsed(tokenId, userId, sql);

    // Invalidate all active sessions for this user across all devices
    await revokeAllUserSessions(sql, userId, "password_reset");

    return { success: true };
  } catch (error) {
    console.error("Failed to execute password reset:", error);
    return { success: false, error: "Database error during password reset." };
  }
}

