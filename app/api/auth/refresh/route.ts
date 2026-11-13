import { getAuthSecret, serializeSessionCookie } from "../../../../lib/session.ts";
import { isSameOriginRequest } from "../../../../lib/oauth/safe-redirect.ts";
import {
  REFRESH_COOKIE_NAME,
  rotateAuthSession,
  serializeRefreshCookie,
  clearRefreshCookie,
  ACCESS_TOKEN_TTL_SECONDS,
  type SqlExecutor,
} from "../../../../lib/refresh-tokens.ts";

export type RefreshRouteDependencies = {
  sql?: SqlExecutor;
  getSecret?: () => string;
};

let prodSqlPromise: Promise<any> | null = null;

async function loadProductionSql(): Promise<any> {
  if (!prodSqlPromise) {
    prodSqlPromise = import("../../../../lib/db.ts").then((m) => m.sql);
  }
  return prodSqlPromise;
}

export async function handleRefresh(
  request: Request,
  deps: RefreshRouteDependencies = {}
): Promise<Response> {
  try {
    // Extract refresh token from incoming cookies
    let rawRefreshToken: string | null = null;
    const cookieHeader = request.headers.get("cookie");
    if (cookieHeader) {
      const cookies = cookieHeader.split(";").map((c) => c.trim());
      const prefix = `${REFRESH_COOKIE_NAME}=`;
      const match = cookies.find((c) => c.startsWith(prefix));
      if (match) {
        rawRefreshToken = match.slice(prefix.length);
      }
    }

    if (!rawRefreshToken) {
      const response = Response.json(
        { error: "No refresh token provided." },
        { status: 401 }
      );
      response.headers.append("Set-Cookie", serializeSessionCookie("", 0, request));
      response.headers.append("Set-Cookie", clearRefreshCookie(request));
      return response;
    }

    let secret: string;
    try {
      secret = deps.getSecret ? deps.getSecret() : getAuthSecret();
    } catch {
      return Response.json(
        { error: "Server authentication configuration error." },
        { status: 500 }
      );
    }

    const sql = deps.sql ?? (await loadProductionSql());
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const ipAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;

    const outcome = await rotateAuthSession(sql, rawRefreshToken, secret, {
      userAgent,
      ipAddress,
    });

    if (outcome.status !== "success") {
      const response = Response.json(
        { error: outcome.error, status: outcome.status },
        { status: 401 }
      );
      // Clear both cookies on any rotation rejection (reuse, revoked, expired, invalid)
      response.headers.append("Set-Cookie", serializeSessionCookie("", 0, request));
      response.headers.append("Set-Cookie", clearRefreshCookie(request));
      return response;
    }

    const response = Response.json(
      {
        success: true,
        user: outcome.user,
      },
      { status: 200 }
    );

    // Set short-lived access token cookie (15 min) and new rotated refresh token cookie (7 days)
    response.headers.append(
      "Set-Cookie",
      serializeSessionCookie(outcome.accessToken, ACCESS_TOKEN_TTL_SECONDS, request)
    );
    response.headers.append(
      "Set-Cookie",
      serializeRefreshCookie(outcome.refreshToken, undefined, request)
    );

    return response;
  } catch (error) {
    console.error("Refresh route processing error:", error);
    return Response.json(
      { error: "An unexpected error occurred during token refresh." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  return handleRefresh(request);
}

