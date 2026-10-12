import { NextResponse } from "next/server";
import { sql } from "@/lib/db";


export async function GET() {
  try {
    const shifts = await sql`
  SELECT
    id,
    employee_name,
    role,
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
    const body = await request.json();

    const employeeName =
      typeof body.employeeName === "string" ? body.employeeName.trim() : "";
    const role = typeof body.role === "string" ? body.role.trim() : "";
    const shiftDay = typeof body.shiftDay === "string" ? body.shiftDay : "";

    if (!employeeName || !role || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDay)) {
      return NextResponse.json(
        { error: "Employee name, role, and a valid shift date are required." },
        { status: 400 }
      );
    }

    const parsedDate = new Date(`${shiftDay}T00:00:00.000Z`);

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== shiftDay
    ) {
      return NextResponse.json(
        { error: "The shift date is invalid." },
        { status: 400 }
      );
    }

    const result = await sql`
      INSERT INTO shifts (employee_name, role, shift_day)
      VALUES (${employeeName}, ${role}, ${shiftDay})
      RETURNING id, employee_name, role, shift_day, created_at
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