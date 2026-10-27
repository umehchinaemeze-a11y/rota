import { verifySessionToken, type SessionPayload } from "./auth.ts";

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

export function serializeSessionCookie(
  token: string,
  maxAge: number = SESSION_MAX_AGE_SECONDS
): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
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
    const { cookies } = await import("next/headers");
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
      const { sql } = await import("./db");
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

      let activeTeamId: number | null = null;
      let activeTeamRole: string | null = null;
      try {
        const teamRows = await sql`
          SELECT team_id, role
          FROM team_memberships
          WHERE user_id = ${payload.userId}
          ORDER BY is_default DESC, id ASC
          LIMIT 1;
        `;
        if (teamRows && teamRows.length > 0 && typeof teamRows[0].team_id === "number") {
          activeTeamId = teamRows[0].team_id;
          if (typeof teamRows[0].role === "string" && teamRows[0].role.trim().length > 0) {
            activeTeamRole = teamRows[0].role.trim();
          }
        }
      } catch {
        // If team_memberships table does not exist yet or query fails, activeTeamId remains null
        activeTeamId = null;
        activeTeamRole = null;
      }

      return {
        ...payload,
        email: freshUser.email,
        name: freshUser.name,
        role: activeTeamRole ?? freshUser.role, // Active workspace role if assigned, fallback to global user position
        teamId: activeTeamId,
      };
    }

    return {
      ...payload,
      teamId: payload.teamId ?? null,
    };
  } catch (error: any) {
    if (
      error?.digest === "HANGING_PROMISE_REJECTION" ||
      (typeof error?.digest === "string" && error.digest.startsWith("NEXT_"))
    ) {
      throw error;
    }
    console.error("Failed to read session user:", error);
    return null;
  }
}
