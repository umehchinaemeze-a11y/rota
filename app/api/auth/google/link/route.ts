import { verifyPassword } from "../../../../../lib/auth.ts";
import { getSessionUser } from "../../../../../lib/session.ts";
import {
  buildGoogleAuthorizationUrl,
  getGoogleConfig,
} from "../../../../../lib/oauth/google.ts";
import { serializeOAuthStateCookie } from "../../../../../lib/oauth/cookies.ts";
import { isSameOriginRequest, sanitizeRedirectPath } from "../../../../../lib/oauth/safe-redirect.ts";
import {
  createOAuthStateMaterial,
  insertOAuthTransaction,
  type SqlExecutor,
} from "../../../../../lib/oauth/transactions.ts";
import { findUserWithPasswordById } from "../../../../../lib/oauth/users.ts";
import { sql as defaultSql } from "../../../../../lib/db.ts";

export type GoogleLinkDependencies = {
  sql?: SqlExecutor;
  getSessionUser?: typeof getSessionUser;
  getConfig?: typeof getGoogleConfig;
  insertTransaction?: typeof insertOAuthTransaction;
};

export async function handleGoogleLink(
  request: Request,
  deps: GoogleLinkDependencies = {}
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
    const redirectAfter = sanitizeRedirectPath(typedBody.redirect, "/");

    if (!password) {
      return Response.json({ error: "Password is required." }, { status: 400 });
    }

    const executeSql = deps.sql ?? defaultSql;
    const currentUser = await findUserWithPasswordById(sessionUser.userId, executeSql);
    if (
      !currentUser ||
      !currentUser.password_hash ||
      !currentUser.password_salt ||
      !verifyPassword(password, currentUser.password_hash, currentUser.password_salt)
    ) {
      return Response.json({ error: "Unable to verify your password." }, { status: 400 });
    }

    const config = (deps.getConfig ?? getGoogleConfig)();
    const material = createOAuthStateMaterial();

    await (deps.insertTransaction ?? insertOAuthTransaction)(
      {
        state: material.state,
        nonce: material.nonce,
        codeVerifier: material.codeVerifier,
        purpose: "link",
        userId: sessionUser.userId,
        redirectAfter,
      },
      executeSql
    );

    const authorizationUrl = buildGoogleAuthorizationUrl(config, {
      state: material.state,
      nonce: material.nonce,
      codeChallenge: material.codeChallenge,
      prompt: "select_account",
    });

    return Response.json(
      { authorizationUrl },
      {
        status: 200,
        headers: {
          "Set-Cookie": serializeOAuthStateCookie(material.state, request),
        },
      }
    );
  } catch (error) {
    console.error("Google account linking start failed:", error);
    return Response.json(
      { error: "Unable to start Google account linking." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleGoogleLink(request);
}
