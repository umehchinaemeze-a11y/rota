import { verifyPassword } from "../../../../../lib/auth.ts";
import { getSessionUser } from "../../../../../lib/session.ts";
import { isSameOriginRequest } from "../../../../../lib/oauth/safe-redirect.ts";
import type { SqlExecutor } from "../../../../../lib/oauth/transactions.ts";
import {
  findUserWithPasswordById,
  unlinkGoogleIdentity,
} from "../../../../../lib/oauth/users.ts";
import { sql as defaultSql } from "../../../../../lib/db.ts";

export type GoogleUnlinkDependencies = {
  sql?: SqlExecutor;
  getSessionUser?: typeof getSessionUser;
};

export async function handleGoogleUnlink(
  request: Request,
  deps: GoogleUnlinkDependencies = {}
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "JSON request body required." }, { status: 415 });
  }

  try {
    const sessionUser = await (deps.getSessionUser ?? getSessionUser)({
      revalidateWithDb: true,
    });
    if (!sessionUser) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON request body." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return Response.json({ error: "Password is required." }, { status: 400 });
    }

    const typedBody = body as Record<string, unknown>;
    const password = typeof typedBody.password === "string" ? typedBody.password : "";

    if (!password) {
      return Response.json({ error: "Password is required." }, { status: 400 });
    }

    const executeSql = deps.sql ?? defaultSql;
    const currentUser = await findUserWithPasswordById(sessionUser.userId, executeSql);

    if (!currentUser || !currentUser.password_hash || !currentUser.password_salt) {
      return Response.json(
        { error: "Cannot unlink the only sign-in method. Set a password first." },
        { status: 400 }
      );
    }

    if (!verifyPassword(password, currentUser.password_hash, currentUser.password_salt)) {
      return Response.json({ error: "Unable to verify your password." }, { status: 400 });
    }

    const removed = await unlinkGoogleIdentity(sessionUser.userId, executeSql);
    if (!removed) {
      return Response.json(
        { error: "No linked Google account was found." },
        { status: 404 }
      );
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("Google account unlinking failed:", error);
    return Response.json(
      { error: "Unable to unlink Google account." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleGoogleUnlink(request);
}
