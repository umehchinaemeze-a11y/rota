import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { canManageShiftRecord } from "@/lib/permissions";
import { getSessionUser } from "@/lib/session";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const numericId = parseInt(id, 10);

    if (Number.isNaN(numericId) || numericId <= 0) {
      return NextResponse.json({ error: "Invalid shift ID." }, { status: 400 });
    }

    const rows = await sql`
      SELECT
        id,
        employee_name,
        role,
        user_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day,
        created_at
      FROM shifts
      WHERE id = ${numericId}
      LIMIT 1;
    `;

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: "Shift not found." }, { status: 404 });
    }

    return NextResponse.json(rows[0]);
  } catch (error) {
    console.error("Failed to fetch shift by ID:", error);
    return NextResponse.json(
      { error: "Unable to fetch shift details." },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    // 1. Authenticate caller and obtain authoritative role from database
    const sessionUser = await getSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return NextResponse.json(
        { error: "Authentication required. Please sign in to edit shifts." },
        { status: 401 }
      );
    }

    // 2. Validate shift ID parameter
    const { id } = await context.params;
    const numericId = parseInt(id, 10);
    if (Number.isNaN(numericId) || numericId <= 0) {
      return NextResponse.json({ error: "Invalid shift ID." }, { status: 400 });
    }

    // 3. Parse and validate JSON request body
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
        { error: "A valid shift date and role are required." },
        { status: 400 }
      );
    }

    const typedBody = body as Record<string, unknown>;
    const role = typeof typedBody.role === "string" ? typedBody.role.trim() : "";
    const shiftDay = typeof typedBody.shiftDay === "string" ? typedBody.shiftDay.trim() : "";

    if (!role || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDay)) {
      return NextResponse.json(
        { error: "Role and a valid shift date (YYYY-MM-DD) are required." },
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

    // 4. Retrieve existing shift from database to verify existence and ownership
    const existing = await sql`
      SELECT id, employee_name, role, user_id
      FROM shifts
      WHERE id = ${numericId}
      LIMIT 1;
    `;

    if (!existing || existing.length === 0) {
      return NextResponse.json({ error: "Shift not found." }, { status: 404 });
    }

    const existingShift = existing[0];

    // 5. Server-side permission check using user_id ownership and database role.
    // Completely ignores all client-supplied headers/body impersonation claims.
    const isAuthorized = canManageShiftRecord(sessionUser, existingShift);
    if (!isAuthorized) {
      return NextResponse.json(
        {
          error:
            "Unauthorized: You can only edit shifts assigned to your account unless you hold a management role. Legacy shifts require manager permissions.",
        },
        { status: 403 }
      );
    }

    const isManager =
      sessionUser.role === "Supervisor" ||
      sessionUser.role === "Operations" ||
      sessionUser.role === "Admin";

    // 6. Ownership preservation:
    // Ordinary employees can only edit shift dates/roles on their own shifts.
    // Managers can also reassign or edit the employee name.
    let updatedEmployeeName = existingShift.employee_name;
    let updatedUserId = existingShift.user_id;

    if (isManager) {
      const inputName =
        typeof typedBody.employeeName === "string"
          ? typedBody.employeeName.trim()
          : "";
      if (inputName) {
        updatedEmployeeName = inputName;
        const userMatch = await sql`
          SELECT id FROM users WHERE LOWER(TRIM(name)) = ${inputName.toLowerCase()} LIMIT 1;
        `;
        if (userMatch && userMatch.length > 0) {
          updatedUserId = userMatch[0].id;
        }
      }
    } else {
      // Ensure the shift remains strictly tied to the authenticated user's ID
      updatedUserId = sessionUser.userId;
      updatedEmployeeName = sessionUser.name;
    }

    // 7. Parameterized database update
    const result = await sql`
      UPDATE shifts
      SET
        employee_name = ${updatedEmployeeName},
        role = ${role},
        shift_day = ${shiftDay},
        user_id = ${updatedUserId}
      WHERE id = ${numericId}
      RETURNING
        id,
        employee_name,
        role,
        user_id,
        TO_CHAR(shift_day, 'YYYY-MM-DD') AS shift_day,
        created_at;
    `;

    return NextResponse.json(result[0], { status: 200 });
  } catch (error) {
    console.error("Failed to update shift:", error);
    return NextResponse.json(
      { error: "Unable to update shift." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    // 1. Authenticate caller and obtain authoritative role from database
    const sessionUser = await getSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return NextResponse.json(
        { error: "Authentication required. Please sign in to delete shifts." },
        { status: 401 }
      );
    }

    // 2. Validate shift ID parameter
    const { id } = await context.params;
    const numericId = parseInt(id, 10);
    if (Number.isNaN(numericId) || numericId <= 0) {
      return NextResponse.json({ error: "Invalid shift ID." }, { status: 400 });
    }

    // 3. Retrieve existing shift from database
    const existing = await sql`
      SELECT id, employee_name, role, user_id
      FROM shifts
      WHERE id = ${numericId}
      LIMIT 1;
    `;

    if (!existing || existing.length === 0) {
      return NextResponse.json({ error: "Shift not found." }, { status: 404 });
    }

    const existingShift = existing[0];

    // 4. Server-side permission check using user_id ownership and database role
    const isAuthorized = canManageShiftRecord(sessionUser, existingShift);
    if (!isAuthorized) {
      return NextResponse.json(
        {
          error:
            "Unauthorized: You can only delete shifts assigned to your account unless you hold a management role. Legacy shifts require manager permissions.",
        },
        { status: 403 }
      );
    }

    // 5. Parameterized database deletion
    await sql`
      DELETE FROM shifts
      WHERE id = ${numericId};
    `;

    return NextResponse.json(
      { success: true, message: "Shift permanently removed.", id: numericId },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failed to delete shift:", error);
    return NextResponse.json(
      { error: "Unable to delete shift." },
      { status: 500 }
    );
  }
}
