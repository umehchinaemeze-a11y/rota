import crypto from "node:crypto";
import { sql as defaultSql } from "../db.ts";

export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
export const OAUTH_STATE_COOKIE_NAME = "rota_oauth_state";
export const OAUTH_STATE_COOKIE_PATH = "/api/auth/google";

export type OAuthPurpose = "login" | "link";

export type SqlExecutor = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

export type OAuthTransaction = {
  id: number;
  nonce: string;
  code_verifier: string;
  purpose: OAuthPurpose;
  user_id: number | null;
  redirect_after: string | null;
  expires_at: string | Date;
};

export type OAuthStateMaterial = {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
};

export function randomUrlSafeToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function createPkceChallenge(codeVerifier: string): string {
  return crypto.createHash("sha256").update(codeVerifier).digest("base64url");
}

export function createOAuthStateMaterial(): OAuthStateMaterial {
  const state = randomUrlSafeToken(32);
  const nonce = randomUrlSafeToken(32);
  const codeVerifier = randomUrlSafeToken(64);
  return {
    state,
    nonce,
    codeVerifier,
    codeChallenge: createPkceChallenge(codeVerifier),
  };
}

export function hashOAuthState(state: string): string {
  return crypto.createHash("sha256").update(state).digest("hex");
}

export async function insertOAuthTransaction(
  params: {
    state: string;
    nonce: string;
    codeVerifier: string;
    purpose: OAuthPurpose;
    userId?: number | null;
    redirectAfter?: string | null;
    expiresAt?: Date;
  },
  executeSql: SqlExecutor = defaultSql
): Promise<void> {
  const expiresAt =
    params.expiresAt ?? new Date(Date.now() + OAUTH_STATE_MAX_AGE_SECONDS * 1000);

  await executeSql`
    INSERT INTO oauth_transactions (
      state_hash,
      nonce,
      code_verifier,
      purpose,
      user_id,
      redirect_after,
      expires_at
    )
    VALUES (
      ${hashOAuthState(params.state)},
      ${params.nonce},
      ${params.codeVerifier},
      ${params.purpose},
      ${params.userId ?? null},
      ${params.redirectAfter ?? null},
      ${expiresAt}
    );
  `;
}

export async function consumeOAuthTransaction(
  state: unknown,
  executeSql: SqlExecutor = defaultSql
): Promise<OAuthTransaction | null> {
  if (typeof state !== "string" || state.length === 0) {
    return null;
  }

  const rows = await executeSql`
    UPDATE oauth_transactions
    SET consumed_at = NOW()
    WHERE state_hash = ${hashOAuthState(state)}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    RETURNING
      id,
      nonce,
      code_verifier,
      purpose,
      user_id,
      redirect_after,
      expires_at;
  `;

  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as OAuthTransaction) : null;
}

export function isOAuthPurpose(value: unknown): value is OAuthPurpose {
  return value === "login" || value === "link";
}
