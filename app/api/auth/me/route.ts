import { NextResponse } from "next/server";
import { getSessionUser } from "../../../../lib/session.ts";

export async function GET(request: Request) {
  try {
    const sessionUser = await getSessionUser({ revalidateWithDb: true });

    if (!sessionUser) {
      return NextResponse.json(
        { authenticated: false, error: "Not authenticated." },
        { status: 401 }
      );
    }

    const { sql } = await import("../../../../lib/db.ts");
    let hasPassword = false;
    let googleLinked = false;

    const passwordRows = await sql`
      SELECT (password_hash IS NOT NULL AND password_salt IS NOT NULL) AS has_password
      FROM users
      WHERE id = ${sessionUser.userId}
      LIMIT 1;
    `;
    hasPassword = passwordRows?.[0]?.has_password === true;

    try {
      const identityRows = await sql`
        SELECT id
        FROM user_identities
        WHERE user_id = ${sessionUser.userId}
          AND provider = 'google'
        LIMIT 1;
      `;
      googleLinked = Array.isArray(identityRows) && identityRows.length > 0;
    } catch {
      googleLinked = false;
    }

    // Return only safe profile fields. Never return password hashes, salts, secrets, or tokens.
    return NextResponse.json(
      {
        authenticated: true,
        user: {
          id: sessionUser.userId,
          email: sessionUser.email,
          name: sessionUser.name,
          role: sessionUser.role,
          teamId: sessionUser.teamId ?? null,
          hasPassword,
          googleLinked,
        },
      },
      { status: 200 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { authenticated: false, error: "Failed to verify session." },
      { status: 500 }
    );
  }
}
