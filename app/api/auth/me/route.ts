import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";

export async function GET(request: Request) {
  const sessionUser = await getSessionUser({ revalidateWithDb: true });

  if (!sessionUser) {
    return NextResponse.json(
      { authenticated: false, error: "Not authenticated." },
      { status: 401 }
    );
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
      },
    },
    { status: 200 }
  );
}
