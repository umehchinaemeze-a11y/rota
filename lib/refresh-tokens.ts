import crypto from "node:crypto";
import { createSessionToken, type SessionPayload } from "./auth.ts";
import { getAuthSecret } from "./session.ts";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes (short-lived access token)
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (long-lived refresh token)
export const REFRESH_COOKIE_NAME = "rota_refresh";

export type SqlExecutor = (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;

export type AuthSessionRecord = {
  id: number;
  session_id: string;
  user_id: number;
  team_id: number | null;
  token_hash: string;
  family_id: string;
  revoked: boolean;
  revoked_reason: string | null;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  expires_at: string | Date;
};

export type RefreshResult =
  | {
      status: "success";
      sessionId: string;
      accessToken: string;
      refreshToken: string;
      user: {
        id: number;
        email: string;
        name: string;
        role: string;
        teamId: number | null;
      };
    }
  | {
      status: "reuse_detected";
      error: string;
      familyId?: string;
    }
  | {
      status: "revoked";
      error: string;
    }
  | {
      status: "expired";
      error: string;
    }
  | {
      status: "invalid";
      error: string;
    };

/**
 * Computes the SHA-256 hash of a refresh token secret.
 * Raw refresh token secrets are never stored in the database.
 */
export function hashRefreshToken(secret: string): string {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Secret must be a non-empty string.");
  }
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/**
 * Generates a cryptographically secure URL-safe base64 token.
 */
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Serializes a refresh token as `<sessionId>.<secret>`.
 */
export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

/**
 * Parses and validates the format of a refresh token string.
 */
export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  if (typeof token !== "string" || !token.includes(".")) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [sessionId, secret] = parts;
  if (!sessionId || !secret || sessionId.trim().length === 0 || secret.trim().length === 0) {
    return null;
  }
  return { sessionId: sessionId.trim(), secret: secret.trim() };
}

/**
 * Cookie options for the HttpOnly refresh token.
 */
export function getRefreshCookieOptions(
  maxAge: number = REFRESH_TOKEN_TTL_SECONDS,
  req?: Request
) {
  const isSecure =
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://") ||
    req?.headers?.get("x-forwarded-proto") === "https";

  return {
    name: REFRESH_COOKIE_NAME,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/**
 * Serializes the refresh token cookie header.
 */
export function serializeRefreshCookie(
  token: string,
  maxAge: number = REFRESH_TOKEN_TTL_SECONDS,
  req?: Request
): string {
  const isSecure =
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://") ||
    req?.headers?.get("x-forwarded-proto") === "https";
  const secure = isSecure ? "; Secure" : "";
  return `${REFRESH_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * Generates a Set-Cookie header string to clear the refresh token cookie.
 */
export function clearRefreshCookie(req?: Request): string {
  return serializeRefreshCookie("", 0, req);
}

/**
 * Ensures database tables for auth sessions and used refresh tokens exist.
 */
export async function ensureAuthSessionsTables(sql: SqlExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      token_hash VARCHAR(128) NOT NULL,
      family_id VARCHAR(64) NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      revoked_reason VARCHAR(64),
      user_agent TEXT,
      ip_address VARCHAR(45),
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_session_id ON auth_sessions(session_id);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_family_id ON auth_sessions(family_id);
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS used_refresh_tokens (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      family_id VARCHAR(64) NOT NULL,
      token_hash VARCHAR(128) NOT NULL,
      rotated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_used_tokens_hash ON used_refresh_tokens(token_hash);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_used_tokens_family ON used_refresh_tokens(family_id);
  `;
}

/**
 * Creates and persists a new authenticated session and issues a refresh token.
 */
export async function createAuthSession(
  sql: SqlExecutor,
  params: {
    userId: number;
    teamId?: number | null;
    userAgent?: string;
    ipAddress?: string;
  }
): Promise<{
  sessionId: string;
  familyId: string;
  refreshToken: string;
  expiresAt: Date;
}> {
  const sessionId = generateSecureToken(24);
  const familyId = generateSecureToken(24);
  const secret = generateSecureToken(32);
  const tokenHash = hashRefreshToken(secret);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

  try {
    await ensureAuthSessionsTables(sql);
    await sql`
      INSERT INTO auth_sessions (
        session_id, user_id, team_id, token_hash, family_id, user_agent, ip_address, expires_at
      )
      VALUES (
        ${sessionId},
        ${params.userId},
        ${params.teamId ?? null},
        ${tokenHash},
        ${familyId},
        ${params.userAgent ?? null},
        ${params.ipAddress ?? null},
        ${expiresAt.toISOString()}
      );
    `;
  } catch (err) {
    console.warn("Failed to persist auth session to database:", err);
  }

  return {
    sessionId,
    familyId,
    refreshToken: formatRefreshToken(sessionId, secret),
    expiresAt,
  };
}

/**
 * Rotates an active refresh token:
 * - Detects reuse of previously rotated tokens -> invalidates entire family
 * - Verifies expiration and revocation
 * - Generates a new cryptographically secure secret
 * - Inserts previous token into used_refresh_tokens
 * - Updates auth_sessions atomically
 * - Issues a new short-lived access token and rotated refresh token
 */
export async function rotateAuthSession(
  sql: SqlExecutor,
  rawRefreshToken: string,
  secretKey: string,
  meta?: { userAgent?: string; ipAddress?: string }
): Promise<RefreshResult> {
  const parsed = parseRefreshToken(rawRefreshToken);
  if (!parsed) {
    return { status: "invalid", error: "Malformed refresh token." };
  }

  const { sessionId, secret } = parsed;
  const incomingHash = hashRefreshToken(secret);

  try {
    await ensureAuthSessionsTables(sql);

    // 1. Automatic Reuse Detection: Check if token has already been rotated
    let usedRows: any[] = [];
    try {
      usedRows = await sql`
        SELECT session_id, family_id
        FROM used_refresh_tokens
        WHERE token_hash = ${incomingHash}
        LIMIT 1;
      `;
    } catch {
      usedRows = [];
    }

    if (usedRows && usedRows.length > 0) {
      const familyId = usedRows[0].family_id;
      // Invalidate the ENTIRE family of tokens immediately to defend against token theft
      await sql`
        UPDATE auth_sessions
        SET revoked = TRUE, revoked_reason = 'reuse_detected', updated_at = NOW()
        WHERE family_id = ${familyId};
      `;
      return {
        status: "reuse_detected",
        error: "Refresh token reuse detected. Entire session family terminated.",
        familyId,
      };
    }

    // 2. Fetch active session record and user details
    const sessionRows = await sql`
      SELECT s.*, u.id as user_id, u.email, u.name, u.role as default_role
      FROM auth_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.session_id = ${sessionId}
      LIMIT 1;
    `;

    if (!sessionRows || sessionRows.length === 0) {
      return { status: "invalid", error: "Session not found." };
    }

    const session = sessionRows[0];

    // 3. Verify session is not revoked
    if (session.revoked) {
      return {
        status: "revoked",
        error: `Session has been revoked (${session.revoked_reason || "revoked"}).`,
      };
    }

    // 4. Verify session is not expired
    const expiresAtMs = new Date(session.expires_at).getTime();
    if (expiresAtMs <= Date.now()) {
      await sql`
        UPDATE auth_sessions
        SET revoked = TRUE, revoked_reason = 'expired', updated_at = NOW()
        WHERE session_id = ${sessionId};
      `;
      return { status: "expired", error: "Refresh token has expired." };
    }

    // 5. Constant-time verification of token hash
    const expectedHashBuffer = Buffer.from(session.token_hash, "hex");
    const incomingHashBuffer = Buffer.from(incomingHash, "hex");
    if (
      expectedHashBuffer.length !== incomingHashBuffer.length ||
      !crypto.timingSafeEqual(expectedHashBuffer, incomingHashBuffer)
    ) {
      return { status: "invalid", error: "Invalid refresh token." };
    }

    // 6. Generate new secret for token rotation
    const newSecret = generateSecureToken(32);
    const newHash = hashRefreshToken(newSecret);
    const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    // 7. Record current hash in used_refresh_tokens
    await sql`
      INSERT INTO used_refresh_tokens (session_id, family_id, token_hash)
      VALUES (${sessionId}, ${session.family_id}, ${incomingHash});
    `;

    // 8. Atomically update session with new token hash
    const updateRows = await sql`
      UPDATE auth_sessions
      SET token_hash = ${newHash},
          updated_at = NOW(),
          expires_at = ${newExpiresAt.toISOString()},
          user_agent = COALESCE(${meta?.userAgent ?? null}, user_agent),
          ip_address = COALESCE(${meta?.ipAddress ?? null}, ip_address)
      WHERE session_id = ${sessionId}
        AND token_hash = ${session.token_hash}
        AND revoked = FALSE
      RETURNING *;
    `;

    if (!updateRows || updateRows.length === 0) {
      return { status: "invalid", error: "Concurrent refresh detected or session modified." };
    }

    // 9. Fetch active workspace role if team_id is assigned
    let activeRole = session.default_role;
    let teamId = session.team_id;
    try {
      const membershipRows = await sql`
        SELECT team_id, role
        FROM team_memberships
        WHERE user_id = ${session.user_id}
        ORDER BY is_default DESC, id ASC
        LIMIT 1;
      `;
      if (membershipRows && membershipRows.length > 0) {
        teamId = membershipRows[0].team_id;
        if (membershipRows[0].role) {
          activeRole = membershipRows[0].role;
        }
      }
    } catch {
      // Fallback to existing session values
    }

    const newRefreshToken = formatRefreshToken(sessionId, newSecret);
    const accessToken = createSessionToken(
      {
        userId: session.user_id,
        email: session.email,
        name: session.name,
        role: activeRole,
        teamId,
        sessionId,
      },
      secretKey,
      ACCESS_TOKEN_TTL_SECONDS
    );

    return {
      status: "success",
      sessionId,
      accessToken,
      refreshToken: newRefreshToken,
      user: {
        id: session.user_id,
        email: session.email,
        name: session.name,
        role: activeRole,
        teamId,
      },
    };
  } catch (error) {
    console.error("Error during session rotation:", error);
    return { status: "invalid", error: "Internal session rotation error." };
  }
}

/**
 * Revokes the specific current session on the server.
 */
export async function revokeCurrentSession(
  sql: SqlExecutor,
  sessionId: string,
  reason = "user_logout"
): Promise<boolean> {
  try {
    await ensureAuthSessionsTables(sql);
    const rows = await sql`
      UPDATE auth_sessions
      SET revoked = TRUE, revoked_reason = ${reason}, updated_at = NOW()
      WHERE session_id = ${sessionId}
      RETURNING id;
    `;
    return Boolean(rows && rows.length > 0);
  } catch (err) {
    console.warn("Failed to revoke session:", err);
    return false;
  }
}

/**
 * Revokes all sessions belonging to a specific user (Logout from all devices).
 */
export async function revokeAllUserSessions(
  sql: SqlExecutor,
  userId: number,
  reason = "logout_all"
): Promise<number> {
  try {
    await ensureAuthSessionsTables(sql);
    const rows = await sql`
      UPDATE auth_sessions
      SET revoked = TRUE, revoked_reason = ${reason}, updated_at = NOW()
      WHERE user_id = ${userId} AND revoked = FALSE
      RETURNING id;
    `;
    return rows ? rows.length : 0;
  } catch (err) {
    console.warn("Failed to revoke all user sessions:", err);
    return 0;
  }
}

/**
 * Checks if a session has been revoked or expired on the server.
 */
export async function isSessionRevoked(
  sql: SqlExecutor,
  sessionId: string
): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT revoked, expires_at
      FROM auth_sessions
      WHERE session_id = ${sessionId}
      LIMIT 1;
    `;
    if (!rows || rows.length === 0) {
      return true; // Not found -> consider invalid
    }
    const session = rows[0];
    if (session.revoked) return true;
    if (new Date(session.expires_at).getTime() <= Date.now()) return true;
    return false;
  } catch {
    // If table doesn't exist yet, return false to avoid breaking unmigrated environments
    return false;
  }
}

