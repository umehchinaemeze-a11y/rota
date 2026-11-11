import { createSessionToken, verifyPassword } from "../../../../lib/auth.ts";
import { getAuthSecret, serializeSessionCookie } from "../../../../lib/session.ts";
import {
  createAuthSession,
  serializeRefreshCookie,
  ACCESS_TOKEN_TTL_SECONDS,
} from "../../../../lib/refresh-tokens.ts";
import { enforceRateLimit } from "../../../../lib/rate-limit.ts";

export type LoginRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSecret?: () => string;
  skipRateLimit?: boolean;
};

let prodSqlPromise: Promise<any> | null = null;

async function loadProductionSql(): Promise<any> {
  if (!prodSqlPromise) {
    prodSqlPromise = import("../../../../lib/db.ts").then((m) => m.sql);
  }
  return prodSqlPromise;
}

export async function handleLogin(
  request: Request,
  deps: LoginRouteDependencies = {}
): Promise<Response> {
  try {
    if (!deps.skipRateLimit) {
      const { response: rateLimitResp } = await enforceRateLimit(request, {
        action: "login",
        limit: 10,
        windowSeconds: 60,
      });
      if (rateLimitResp) {
        return rateLimitResp;
      }
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object") {
      return Response.json(
        { error: "Email and password are required." },
        { status: 400 }
      );
    }

    const typedBody = body as Record<string, unknown>;
    const email =
      typeof typedBody.email === "string" ? typedBody.email.trim().toLowerCase() : "";
    const password =
      typeof typedBody.password === "string" ? typedBody.password : "";

    if (!email || !password) {
      return Response.json(
        { error: "Email and password are required." },
        { status: 400 }
      );
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

    // Look up user by normalized email in the database
    const rows = await sql`
      SELECT id, email, password_hash, password_salt, name, role
      FROM users
      WHERE LOWER(TRIM(email)) = ${email}
      LIMIT 1;
    `;

    // Generic response for both user not found and password mismatch
    if (!rows || rows.length === 0) {
      return Response.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    const user = rows[0];

    // Users created through Google have no password until one is explicitly set.
    if (!user.password_hash || !user.password_salt) {
      return Response.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    // Constant-time verification against stored scrypt hash and salt
    const isPasswordValid = verifyPassword(
      password,
      user.password_hash,
      user.password_salt
    );

    if (!isPasswordValid) {
      return Response.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    const userAgent = request.headers.get("user-agent") ?? undefined;
    const ipAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;

    const authSession = await createAuthSession(sql, {
      userId: user.id,
      userAgent,
      ipAddress,
    });

    // Resolve user's default workspace membership if one exists
    let activeTeamId: number | null = null;
    let activeTeamRole: string = user.role;
    try {
      const membershipRows = await sql`
        SELECT team_id, role
        FROM team_memberships
        WHERE user_id = ${user.id}
        ORDER BY is_default DESC, id ASC
        LIMIT 1;
      `;
      if (membershipRows && membershipRows.length > 0 && typeof membershipRows[0].team_id === "number") {
        activeTeamId = membershipRows[0].team_id;
        if (typeof membershipRows[0].role === "string" && membershipRows[0].role.trim().length > 0) {
          activeTeamRole = membershipRows[0].role.trim();
        }
      }
    } catch {
      // Allow login to succeed even if team_memberships lookup fails
    }

    // Create session strictly with database-verified identity, ignoring any client role/ID claims
    const token = createSessionToken(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: activeTeamRole,
        teamId: activeTeamId,
        sessionId: authSession.sessionId,
      },
      secret,
      ACCESS_TOKEN_TTL_SECONDS
    );

    const response = Response.json(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: activeTeamRole,
        teamId: activeTeamId,
      },
      {
        status: 200,
      }
    );

    response.headers.append(
      "Set-Cookie",
      serializeSessionCookie(token, ACCESS_TOKEN_TTL_SECONDS, request)
    );
    response.headers.append(
      "Set-Cookie",
      serializeRefreshCookie(authSession.refreshToken, undefined, request)
    );

    return response;
  } catch (error) {
    console.error("Login processing error occurred.");
    return Response.json(
      { error: "An unexpected error occurred during login." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return handleLogin(request);
}
