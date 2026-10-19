import { cookies } from "next/headers";
import { sql } from "./db";
import { verifySessionToken, type SessionPayload } from "./auth";

export const SESSION_COOKIE_NAME = "rota_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function getSessionCookieOptions(maxAge: number = SESSION_MAX_AGE_SECONDS) {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error(
      "AUTH_SECRET is not configured in environment variables. Define AUTH_SECRET in .env.local."
    );
  }
  return secret.trim();
}

/**
 * Reads and verifies the active user session strictly from the HttpOnly session cookie.
 * Does not trust any client-supplied headers or body fields.
 * If `revalidateWithDb` is true, queries the database to ensure the user still exists
 * and fetches their latest authoritative role. If user is deleted or missing, returns null.
 */
export async function getSessionUser(options?: {
  revalidateWithDb?: boolean;
}): Promise<SessionPayload | null> {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

    if (!sessionCookie || !sessionCookie.value) {
      return null;
    }

    const secret = getAuthSecret();
    const payload = verifySessionToken(sessionCookie.value, secret);
    if (!payload) {
      return null;
    }

    if (options?.revalidateWithDb) {
      const rows = await sql`
        SELECT id, email, name, role
        FROM users
        WHERE id = ${payload.userId}
        LIMIT 1;
      `;

      if (!rows || rows.length === 0) {
        // User was deleted or removed from database
        return null;
      }

      const freshUser = rows[0];
      return {
        ...payload,
        email: freshUser.email,
        name: freshUser.name,
        role: freshUser.role, // Authoritative current role directly from database
      };
    }

    return payload;
  } catch (error) {
    console.error("Failed to read session user:", error);
    return null;
  }
}
