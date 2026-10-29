import { hashPassword, createSessionToken } from "../../../../lib/auth.ts";
import { getAuthSecret, serializeSessionCookie } from "../../../../lib/session.ts";

export type RegisterRouteDependencies = {
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

export async function handleRegister(
  request: Request,
  deps: RegisterRouteDependencies = {}
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
        { error: "Name, email, and password are required." },
        { status: 400 }
      );
    }

    const typedBody = body as Record<string, unknown>;
    const name = typeof typedBody.name === "string" ? typedBody.name.trim() : "";
    const email =
      typeof typedBody.email === "string" ? typedBody.email.trim().toLowerCase() : "";
    const password =
      typeof typedBody.password === "string" ? typedBody.password : "";

    // Validation: name
    if (!name || name.length < 2 || name.length > 100) {
      return Response.json(
        { error: "Full name must be between 2 and 100 characters." },
        { status: 400 }
      );
    }

    // Validation: email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email) || email.length > 255) {
      return Response.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    // Validation: password length & complexity
    if (!password || password.length < 8) {
      return Response.json(
        { error: "Password must be at least 8 characters long." },
        { status: 400 }
      );
    }

    // Role assignment: Default to standard Staff / Front Desk. Never permit client escalation to Admin or Supervisor.
    const requestedRole = typeof typedBody.role === "string" ? typedBody.role.trim() : "";
    const allowedSelfRegisteredRoles = ["Front Desk", "Customer Support", "Staff"];
    const role = allowedSelfRegisteredRoles.includes(requestedRole)
      ? requestedRole
      : "Front Desk";

    // Resolve dependencies
    const sql = deps.sql ?? (await loadProductionSql());
    const secret = deps.getSecret ? deps.getSecret() : getAuthSecret();

    // Check if account already exists
    const existing = await sql`
      SELECT id FROM users
      WHERE LOWER(TRIM(email)) = ${email}
      LIMIT 1;
    `;

    if (existing && existing.length > 0) {
      return Response.json(
        { error: "An account with this email address already exists." },
        { status: 409 }
      );
    }

    // Cryptographic hash with unique 16-byte random salt
    const { hash, salt } = hashPassword(password);

    // Insert user record
    const insertedRows = await sql`
      INSERT INTO users (email, password_hash, password_salt, name, role)
      VALUES (${email}, ${hash}, ${salt}, ${name}, ${role})
      RETURNING id, email, name, role;
    `;

    if (!insertedRows || insertedRows.length === 0) {
      return Response.json(
        { error: "Failed to create user account." },
        { status: 500 }
      );
    }

    const newUser = insertedRows[0];

    // Issue signed session token
    const token = createSessionToken(
      {
        userId: newUser.id,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role,
      },
      secret
    );

    return Response.json(
      {
        success: true,
        message: "Account created successfully.",
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          role: newUser.role,
        },
      },
      {
        status: 201,
        headers: {
          "Set-Cookie": serializeSessionCookie(token),
        },
      }
    );
  } catch (error) {
    console.error("Registration processing error occurred.");
    return Response.json(
      { error: "An unexpected error occurred during registration. Please try again." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return handleRegister(request);
}
