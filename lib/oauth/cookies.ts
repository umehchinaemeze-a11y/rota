import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_PATH,
  OAUTH_STATE_MAX_AGE_SECONDS,
} from "./transactions.ts";

function isSecureRequest(request?: Request): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://") ||
    request?.headers?.get("x-forwarded-proto") === "https"
  );
}

export function serializeOAuthStateCookie(state: string, request?: Request): string {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  return `${OAUTH_STATE_COOKIE_NAME}=${state}; Path=${OAUTH_STATE_COOKIE_PATH}; Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearOAuthStateCookie(request?: Request): string {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  return `${OAUTH_STATE_COOKIE_NAME}=; Path=${OAUTH_STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export function readOAuthStateCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    if (name === OAUTH_STATE_COOKIE_NAME) {
      return part.slice(separatorIndex + 1).trim();
    }
  }

  return null;
}
