import {
  getSessionCookieOptions,
  getSessionUser,
  getAuthSecret,
  serializeSessionCookie,
} from "../../../../lib/session.ts";
import { verifySessionToken } from "../../../../lib/auth.ts";
import {
  REFRESH_COOKIE_NAME,
  getRefreshCookieOptions,
  clearRefreshCookie,
  parseRefreshToken,
  revokeCurrentSession,
  revokeAllUserSessions,
  type SqlExecutor,
} from "../../../../lib/refresh-tokens.ts";

export type LogoutRouteDependencies = {
  sql?: SqlExecutor;
  getSessionUser?: typeof getSessionUser;
  getSecret?: () => string;
};

let prodSqlPromise: Promise<any> | null = null;

async function loadProductionSql(): Promise<any> {
  if (!prodSqlPromise) {
    prodSqlPromise = import("../../../../lib/db.ts").then((m) => m.sql);
  }
  return prodSqlPromise;
}

export async function handleLogout(
  request: Request,
  deps: LogoutRouteDependencies = {}
): Promise<Response> {
  try {
    const url = new URL(request.url);
    let allDevices = url.searchParams.get("all") === "true";

    // Try reading JSON body if available
    if (!allDevices && request.method === "POST") {
      try {
        const body = await request.clone().json();
        if (body && typeof body === "object") {
          if ((body as any).all === true || (body as any).allDevices === true) {
            allDevices = true;
          }
        }
      } catch {
        // Request body might be empty or non-JSON; continue
      }
    }

    const sql = deps.sql ?? (await loadProductionSql());

    if (allDevices) {
      const getSessionUserFn = deps.getSessionUser ?? getSessionUser;
      const sessionUser = await getSessionUserFn({ revalidateWithDb: true });

      if (sessionUser?.userId) {
        await revokeAllUserSessions(sql, sessionUser.userId, "logout_all");
      }

      const response = Response.json(
        { success: true, message: "Logged out from all devices successfully." },
        { status: 200 }
      );
      response.headers.append("Set-Cookie", serializeSessionCookie("", 0, request));
      response.headers.append("Set-Cookie", clearRefreshCookie(request));
      return response;
    }

    // Single-device logout: extract sessionId from session or refresh cookie
    let sessionId: string | null = null;
    const cookieHeader = request.headers.get("cookie");

    if (cookieHeader) {
      const cookies = cookieHeader.split(";").map((c) => c.trim());

      // 1. Check rota_session cookie
      const sessionCookie = cookies.find((c) => c.startsWith("rota_session="));
      if (sessionCookie) {
        const token = sessionCookie.slice("rota_session=".length);
        try {
          const secret = deps.getSecret ? deps.getSecret() : getAuthSecret();
          const payload = verifySessionToken(token, secret);
          if (payload?.sessionId) {
            sessionId = payload.sessionId;
          }
        } catch {
          // Ignore token parsing failure
        }
      }

      // 2. Check rota_refresh cookie if sessionId not yet resolved
      if (!sessionId) {
        const refreshCookie = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
        if (refreshCookie) {
          const refreshToken = refreshCookie.slice(`${REFRESH_COOKIE_NAME}=`.length);
          const parsed = parseRefreshToken(refreshToken);
          if (parsed?.sessionId) {
            sessionId = parsed.sessionId;
          }
        }
      }
    }

    if (sessionId) {
      await revokeCurrentSession(sql, sessionId, "user_logout");
    }

    const response = Response.json(
      { success: true, message: "Logged out successfully." },
      { status: 200 }
    );
    response.headers.append("Set-Cookie", serializeSessionCookie("", 0, request));
    response.headers.append("Set-Cookie", clearRefreshCookie(request));
    return response;
  } catch (error) {
    console.error("Logout handler error:", error);
    const response = Response.json(
      { success: true, message: "Logged out successfully." },
      { status: 200 }
    );
    response.headers.append("Set-Cookie", serializeSessionCookie("", 0, request));
    response.headers.append("Set-Cookie", clearRefreshCookie(request));
    return response;
  }
}

export async function POST(request: Request) {
  return handleLogout(request);
}

