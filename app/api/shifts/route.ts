import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export async function GET() {
  try {
    const shifts = await sql`
      SELECT
        id,
        employee_name,
        role,
        user_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day,
        created_at
      FROM shifts
      ORDER BY shift_day ASC, id ASC
    `;

    return NextResponse.json(shifts);
  } catch (error) {
    console.error("Failed to fetch shifts:", error);
    return NextResponse.json(
      { error: "Unable to fetch shifts." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    // 1. Authenticate session and fetch authoritative role from database
    const sessionUser = await getSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return NextResponse.json(
        { error: "Authentication required. Please sign in to create shifts." },
        { status: 401 }
      );
    }

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
        { error: "Shift date is required." },
        { status: 400 }
      );
    }

    const typedBody = body as Record<string, unknown>;
    const shiftDay =
      typeof typedBody.shiftDay === "string" ? typedBody.shiftDay.trim() : "";

    // 2. Validate shift date format and calendar validity
    if (!shiftDay || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDay)) {
      return NextResponse.json(
        { error: "A valid shift date (YYYY-MM-DD) is required." },
        { status: 400 }
      );
    }

    const parsedDate = new Date(`${shiftDay}T00:00:00.000Z`);
    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== shiftDay
    ) {
      return NextResponse.json(
        { error: "The provided shift date is invalid." },
        { status: 400 }
      );
    }

    // 3. Ownership and role rules:
    // Ignore all client-supplied identity/role headers or impersonation fields.
    const isManager =
      sessionUser.role === "Supervisor" ||
      sessionUser.role === "Operations" ||
      sessionUser.role === "Admin";

    let finalEmployeeName = sessionUser.name;
    let finalRole = sessionUser.role;
    let finalUserId = sessionUser.userId;

    if (isManager) {
      // Managers may schedule for another employee if provided in the body
      const inputName =
        typeof typedBody.employeeName === "string"
          ? typedBody.employeeName.trim()
          : "";
      const inputRole =
        typeof typedBody.role === "string" ? typedBody.role.trim() : "";

      if (inputName) {
        finalEmployeeName = inputName;
        // Check if the scheduled employee exists in users table to link user_id
        const userMatch = await sql`
          SELECT id, role
          FROM users
          WHERE LOWER(TRIM(name)) = ${inputName.toLowerCase()}
          LIMIT 1;
        `;
        if (userMatch && userMatch.length > 0) {
          finalUserId = userMatch[0].id;
          finalRole = inputRole || userMatch[0].role;
        } else {
          finalRole = inputRole || "Staff";
          finalUserId = sessionUser.userId; // Assigned under manager's authority
        }
      } else if (inputRole) {
        finalRole = inputRole;
      }
    }

    // 4. Parameterized insert into database
    const result = await sql`
      INSERT INTO shifts (employee_name, role, shift_day, user_id)
      VALUES (${finalEmployeeName}, ${finalRole}, ${shiftDay}, ${finalUserId})
      RETURNING
        id,
        employee_name,
        role,
        user_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day,
        created_at;
    `;

    return NextResponse.json(result[0], { status: 201 });
  } catch (error) {
    console.error("Failed to create shift:", error);
    return NextResponse.json(
      { error: "Unable to create shift." },
      { status: 500 }
    );
  }
}