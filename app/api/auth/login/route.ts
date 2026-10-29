import { createSessionToken, verifyPassword } from "../../../../lib/auth.ts";
import { getAuthSecret, serializeSessionCookie } from "../../../../lib/session.ts";

export type LoginRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSecret?: () => string;
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

    // Create session strictly with database-verified identity, ignoring any client role/ID claims
    const token = createSessionToken(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      secret
    );

    return Response.json(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      {
        status: 200,
        headers: {
          "Set-Cookie": serializeSessionCookie(token),
        },
      }
    );
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
