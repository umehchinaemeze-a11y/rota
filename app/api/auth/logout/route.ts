import { NextResponse } from "next/server";
import { getSessionCookieOptions } from "@/lib/session";

export async function POST() {
  const response = NextResponse.json(
    { success: true, message: "Logged out successfully." },
    { status: 200 }
  );

  // Clear cookie using identical options with maxAge: 0
  response.cookies.set({
    ...getSessionCookieOptions(0),
    value: "",
  });

  return response;
}
