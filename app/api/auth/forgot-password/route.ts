export type ForgotPasswordRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
};

let prodSqlPromise: Promise<any> | null = null;

async function loadProductionSql(): Promise<any> {
  if (!prodSqlPromise) {
    prodSqlPromise = import("@/lib/db").then((m) => m.sql);
  }
  return prodSqlPromise;
}

export async function handleForgotPassword(
  request: Request,
  deps: ForgotPasswordRouteDependencies = {}
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
        { error: "Email is required." },
        { status: 400 }
      );
    }

    const typedBody = body as Record<string, unknown>;
    const email =
      typeof typedBody.email === "string" ? typedBody.email.trim().toLowerCase() : "";

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return Response.json(
        { error: "Please enter a valid email address." },
        { status: 400 }
      );
    }

    const sql = deps.sql ?? (await loadProductionSql());

    // Check account existence without exposing result to client (anti-enumeration)
    await sql`
      SELECT id, email FROM users
      WHERE LOWER(TRIM(email)) = ${email}
      LIMIT 1;
    `;

    // Generic response regardless of whether account exists, preventing email enumeration
    return Response.json(
      {
        success: true,
        message:
          "If an account is associated with this email address, you will receive password reset instructions.",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Forgot password processing error occurred.");
    return Response.json(
      { error: "An unexpected error occurred. Please try again later." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return handleForgotPassword(request);
}
