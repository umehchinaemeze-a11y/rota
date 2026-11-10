import {
  getAuthSecret,
  getSessionUser,
} from "../../../../../lib/session.ts";
import {
  exchangeGoogleAuthorizationCode,
  getGoogleConfig,
  verifyGoogleIdToken,
} from "../../../../../lib/oauth/google.ts";
import {
  clearOAuthStateCookie,
  readOAuthStateCookie,
} from "../../../../../lib/oauth/cookies.ts";
import { sanitizeRedirectPath } from "../../../../../lib/oauth/safe-redirect.ts";
import { redirectResponse } from "../../../../../lib/oauth/http.ts";
import {
  consumeOAuthTransaction,
  type OAuthTransaction,
  type SqlExecutor,
} from "../../../../../lib/oauth/transactions.ts";
import {
  createGoogleUserAndIdentity,
  findGoogleIdentityUser,
  findUserByEmail,
  isUniqueViolation,
  linkGoogleIdentity,
  recordGoogleLogin,
} from "../../../../../lib/oauth/users.ts";
import { createUserSessionCookie } from "../../../../../lib/oauth/session.ts";
import {
  createAuthSession,
  serializeRefreshCookie,
} from "../../../../../lib/refresh-tokens.ts";
import { sql as defaultSql } from "../../../../../lib/db.ts";

export type GoogleCallbackDependencies = {
  sql?: SqlExecutor;
  getSessionUser?: typeof getSessionUser;
  getConfig?: typeof getGoogleConfig;
  exchangeCode?: typeof exchangeGoogleAuthorizationCode;
  verifyIdToken?: typeof verifyGoogleIdToken;
  consumeTransaction?: typeof consumeOAuthTransaction;
  getSecret?: () => string;
};

function redirectWithClearedState(
  request: Request,
  path: string
): Response {
  const response = redirectResponse(new URL(path, request.url));
  response.headers.append("Set-Cookie", clearOAuthStateCookie(request));
  return response;
}

function redirectWithSession(
  request: Request,
  path: string,
  sessionCookie: string,
  refreshCookie?: string
): Response {
  const response = redirectResponse(new URL(path, request.url));
  response.headers.append("Set-Cookie", clearOAuthStateCookie(request));
  response.headers.append("Set-Cookie", sessionCookie);
  if (refreshCookie) {
    response.headers.append("Set-Cookie", refreshCookie);
  }
  return response;
}

function safelyRedirectAfter(tx: OAuthTransaction): string {
  return sanitizeRedirectPath(tx.redirect_after, "/");
}

function withGoogleStatus(path: string, key: string, value: string): string {
  const url = new URL(path, "http://rota.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

async function completeLogin(
  identity: {
    subject: string;
    email: string;
    name: string;
    emailVerified: true;
  },
  tx: OAuthTransaction,
  executeSql: SqlExecutor,
  secret: string,
  request: Request
): Promise<Response> {
  let user = await findGoogleIdentityUser(identity.subject, executeSql);

  if (user) {
    await recordGoogleLogin(identity, executeSql);
  } else {
    const existingUser = await findUserByEmail(identity.email, executeSql);
    if (existingUser) {
      return redirectWithClearedState(request, "/sign-in?error=google_link_required");
    }

    try {
      user = await createGoogleUserAndIdentity(identity, executeSql);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      user = await findGoogleIdentityUser(identity.subject, executeSql);
      if (!user) {
        return redirectWithClearedState(request, "/sign-in?error=google_link_required");
      }
      await recordGoogleLogin(identity, executeSql);
    }
  }

  const userAgent = request.headers.get("user-agent") ?? undefined;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;

  const authSession = await createAuthSession(executeSql, {
    userId: user.id,
    userAgent,
    ipAddress,
  });

  const sessionCookie = createUserSessionCookie(user, secret, authSession.sessionId);
  const refreshCookie = serializeRefreshCookie(authSession.refreshToken, undefined, request);
  return redirectWithSession(request, safelyRedirectAfter(tx), sessionCookie, refreshCookie);
}

async function completeLink(
  identity: {
    subject: string;
    email: string;
    name: string;
    emailVerified: true;
  },
  tx: OAuthTransaction,
  executeSql: SqlExecutor,
  request: Request,
  getSessionUserFn: typeof getSessionUser
): Promise<Response> {
  const sessionUser = await getSessionUserFn({ revalidateWithDb: true });
  if (!sessionUser || !tx.user_id || sessionUser.userId !== tx.user_id) {
    return redirectWithClearedState(request, "/sign-in?error=google_link_failed");
  }

  const result = await linkGoogleIdentity(sessionUser.userId, identity, executeSql);
  if (result.status === "linked_to_another_user") {
    return redirectWithClearedState(request, "/?google_error=link_conflict");
  }

  return redirectWithClearedState(
    request,
    withGoogleStatus(safelyRedirectAfter(tx), "google", "linked")
  );
}

export async function handleGoogleCallback(
  request: Request,
  deps: GoogleCallbackDependencies = {}
): Promise<Response> {
  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return redirectWithClearedState(request, "/sign-in?error=google_cancelled");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = readOAuthStateCookie(request);

  if (!code || !state || !stateCookie || state !== stateCookie) {
    return redirectWithClearedState(request, "/sign-in?error=google_failed");
  }

  try {
    const config = (deps.getConfig ?? getGoogleConfig)();
    const executeSql = deps.sql ?? defaultSql;
    const tx = await (deps.consumeTransaction ?? consumeOAuthTransaction)(
      state,
      executeSql
    );

    if (!tx) {
      return redirectWithClearedState(request, "/sign-in?error=google_failed");
    }

    const idToken = await (deps.exchangeCode ?? exchangeGoogleAuthorizationCode)(
      config,
      code,
      tx.code_verifier
    );

    const identity = await (deps.verifyIdToken ?? verifyGoogleIdToken)(idToken, {
      config,
      nonce: tx.nonce,
    });

    const secret = deps.getSecret ? deps.getSecret() : getAuthSecret();

    if (tx.purpose === "link") {
      return completeLink(
        identity,
        tx,
        executeSql,
        request,
        deps.getSessionUser ?? getSessionUser
      );
    }

    if (tx.purpose === "login") {
      return completeLogin(identity, tx, executeSql, secret, request);
    }

    return redirectWithClearedState(request, "/sign-in?error=google_failed");
  } catch (error) {
    console.error("Google authentication callback failed:", error);
    return redirectWithClearedState(request, "/sign-in?error=google_failed");
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleGoogleCallback(request);
}
