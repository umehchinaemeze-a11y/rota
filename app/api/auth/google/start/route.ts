import {
  buildGoogleAuthorizationUrl,
  getGoogleConfig,
} from "../../../../../lib/oauth/google.ts";
import { serializeOAuthStateCookie } from "../../../../../lib/oauth/cookies.ts";
import {
  createOAuthStateMaterial,
  insertOAuthTransaction,
} from "../../../../../lib/oauth/transactions.ts";
import { sanitizeRedirectPath } from "../../../../../lib/oauth/safe-redirect.ts";
import { redirectResponse } from "../../../../../lib/oauth/http.ts";

export type GoogleStartDependencies = {
  getConfig?: typeof getGoogleConfig;
  insertTransaction?: typeof insertOAuthTransaction;
};

function redirectToSignInError(request: Request): Response {
  return redirectResponse(
    new URL("/sign-in?error=google_unavailable", request.url)
  );
}

export async function handleGoogleStart(
  request: Request,
  deps: GoogleStartDependencies = {}
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const redirectAfter = sanitizeRedirectPath(url.searchParams.get("redirect"), "/");
    const config = (deps.getConfig ?? getGoogleConfig)();
    const material = createOAuthStateMaterial();

    await (deps.insertTransaction ?? insertOAuthTransaction)({
      state: material.state,
      nonce: material.nonce,
      codeVerifier: material.codeVerifier,
      purpose: "login",
      redirectAfter,
    });

    const authorizationUrl = buildGoogleAuthorizationUrl(config, {
      state: material.state,
      nonce: material.nonce,
      codeChallenge: material.codeChallenge,
    });

    const response = redirectResponse(authorizationUrl);
    response.headers.append(
      "Set-Cookie",
      serializeOAuthStateCookie(material.state, request)
    );
    return response;
  } catch {
    return redirectToSignInError(request);
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleGoogleStart(request);
}
