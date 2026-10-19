import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { createSessionToken, verifyPassword } from "@/lib/auth";
import { getAuthSecret, getSessionCookieOptions } from "@/lib/session";

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json(
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
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 }
      );
    }

    let secret: string;
    try {
      secret = getAuthSecret();
    } catch {
      return NextResponse.json(
        { error: "Server authentication configuration error." },
        { status: 500 }
      );
    }

    // Look up user by normalized email in the database
    const rows = await sql`
      SELECT id, email, password_hash, password_salt, name, role
      FROM users
      WHERE LOWER(TRIM(email)) = ${email}
      LIMIT 1;
    `;

    // Generic response for both user not found and password mismatch
    if (!rows || rows.length === 0) {
      return NextResponse.json(
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
      return NextResponse.json(
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

    const response = NextResponse.json(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      { status: 200 }
    );

    // Set HttpOnly, SameSite=Lax, Secure cookie
    response.cookies.set({
      ...getSessionCookieOptions(),
      value: token,
    });

    return response;
  } catch (error) {
    // Avoid logging passwords, hashes, tokens, or secrets
    console.error("Login processing error occurred.");
    return NextResponse.json(
      { error: "An unexpected error occurred during login." },
      { status: 500 }
    );
  }
}
