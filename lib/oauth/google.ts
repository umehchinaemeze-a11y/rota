import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleAuthorizationParams = {
  state: string;
  nonce: string;
  codeChallenge: string;
  prompt?: string;
};

export type GoogleIdentity = {
  subject: string;
  email: string;
  name: string;
  emailVerified: true;
};

export type GoogleIdTokenPayload = {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  sub?: unknown;
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  iat?: unknown;
  exp?: unknown;
};

let googleJwks: JWTVerifyGetKey | null = null;

function getGoogleJwks(): JWTVerifyGetKey {
  if (!googleJwks) {
    googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_ENDPOINT));
  }
  return googleJwks;
}

function normalizeName(value: unknown, email: string): string {
  const candidate = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const fallback = email.split("@")[0]?.trim() || "Google User";
  const name = candidate || fallback;
  return name.slice(0, 100);
}

export function getGoogleConfig(
  env: Record<string, string | undefined> = process.env
): GoogleConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  const configuredRedirect = env.GOOGLE_REDIRECT_URI?.trim();
  const redirectUri =
    configuredRedirect ||
    (appUrl
      ? `${appUrl}/api/auth/google/callback`
      : env.NODE_ENV !== "production"
        ? "http://localhost:3000/api/auth/google/callback"
        : "");

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google authentication is not configured.");
  }

  return { clientId, clientSecret, redirectUri };
}

export function buildGoogleAuthorizationUrl(
  config: GoogleConfig,
  params: GoogleAuthorizationParams
): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", params.prompt || "select_account");
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode(
  config: GoogleConfig,
  code: string,
  codeVerifier: string
): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Google token exchange failed.");
  }

  const data = (await response.json().catch(() => null)) as
    | { id_token?: unknown; token_type?: unknown }
    | null;

  if (!data || typeof data.id_token !== "string" || data.id_token.length === 0) {
    throw new Error("Google token response did not contain an ID token.");
  }

  if (data.token_type !== undefined && data.token_type !== "Bearer") {
    throw new Error("Google token response used an unexpected token type.");
  }

  return data.id_token;
}

export function validateGoogleIdTokenClaims(
  payload: GoogleIdTokenPayload,
  expectedNonce: string,
  expectedClientId: string
): GoogleIdentity {
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) {
    throw new Error("Google ID token is missing a valid subject.");
  }

  if (payload.nonce !== expectedNonce) {
    throw new Error("Google ID token nonce mismatch.");
  }

  if (payload.azp !== undefined && payload.azp !== expectedClientId) {
    throw new Error("Google ID token authorized party mismatch.");
  }

  if (payload.email_verified !== true) {
    throw new Error("Google account email is not verified.");
  }

  if (typeof payload.email !== "string") {
    throw new Error("Google ID token is missing an email address.");
  }

  const email = payload.email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || email.length > 255 || !emailRegex.test(email)) {
    throw new Error("Google ID token contains an invalid email address.");
  }

  return {
    subject: payload.sub,
    email,
    name: normalizeName(payload.name, email),
    emailVerified: true,
  };
}

export async function verifyGoogleIdToken(
  idToken: string,
  options: {
    config: GoogleConfig;
    nonce: string;
    jwks?: JWTVerifyGetKey;
  }
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, options.jwks ?? getGoogleJwks(), {
    issuer: [...GOOGLE_ISSUERS],
    audience: options.config.clientId,
    algorithms: ["RS256"],
    clockTolerance: 60,
    maxTokenAge: "1h",
  });

  return validateGoogleIdTokenClaims(
    payload as GoogleIdTokenPayload,
    options.nonce,
    options.config.clientId
  );
}
