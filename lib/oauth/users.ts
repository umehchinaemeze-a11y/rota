import type { GoogleIdentity } from "./google.ts";
import type { SqlExecutor } from "./transactions.ts";

export type AuthUserRecord = {
  id: number;
  email: string;
  name: string;
  role: string;
};

export type LinkIdentityResult =
  | { status: "linked" }
  | { status: "already_linked" }
  | { status: "linked_to_another_user"; userId: number };

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export async function findGoogleIdentityUser(
  subject: string,
  executeSql: SqlExecutor
): Promise<AuthUserRecord | null> {
  const rows = await executeSql`
    SELECT u.id, u.email, u.name, u.role
    FROM users u
    JOIN user_identities i ON i.user_id = u.id
    WHERE i.provider = 'google'
      AND i.provider_subject = ${subject}
    LIMIT 1;
  `;

  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as AuthUserRecord) : null;
}

export async function findUserByEmail(
  email: string,
  executeSql: SqlExecutor
): Promise<AuthUserRecord | null> {
  const rows = await executeSql`
    SELECT id, email, name, role
    FROM users
    WHERE LOWER(TRIM(email)) = ${email}
    LIMIT 1;
  `;

  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as AuthUserRecord) : null;
}

export async function findUserWithPasswordById(
  userId: number,
  executeSql: SqlExecutor
): Promise<(AuthUserRecord & { password_hash: string | null; password_salt: string | null }) | null> {
  const rows = await executeSql`
    SELECT id, email, name, role, password_hash, password_salt
    FROM users
    WHERE id = ${userId}
    LIMIT 1;
  `;

  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

export async function hasGoogleIdentity(
  userId: number,
  executeSql: SqlExecutor
): Promise<boolean> {
  const rows = await executeSql`
    SELECT id
    FROM user_identities
    WHERE user_id = ${userId}
      AND provider = 'google'
    LIMIT 1;
  `;

  return Array.isArray(rows) && rows.length > 0;
}

export async function createGoogleUserAndIdentity(
  identity: GoogleIdentity,
  executeSql: SqlExecutor
): Promise<AuthUserRecord> {
  const rows = await executeSql`
    WITH new_user AS (
      INSERT INTO users (email, password_hash, password_salt, name, role)
      VALUES (${identity.email}, NULL, NULL, ${identity.name}, 'Front Desk')
      RETURNING id, email, name, role
    ),
    new_identity AS (
      INSERT INTO user_identities (
        user_id,
        provider,
        provider_subject,
        provider_email,
        email_verified,
        last_login_at
      )
      SELECT id, 'google', ${identity.subject}, ${identity.email}, TRUE, NOW()
      FROM new_user
      RETURNING user_id
    )
    SELECT u.id, u.email, u.name, u.role
    FROM new_user u
    JOIN new_identity i ON i.user_id = u.id;
  `;

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Google user creation did not return a user.");
  }

  return rows[0] as AuthUserRecord;
}

export async function recordGoogleLogin(
  identity: GoogleIdentity,
  executeSql: SqlExecutor
): Promise<void> {
  await executeSql`
    UPDATE user_identities
    SET last_login_at = NOW(),
        provider_email = ${identity.email},
        email_verified = TRUE
    WHERE provider = 'google'
      AND provider_subject = ${identity.subject};
  `;
}

export async function linkGoogleIdentity(
  userId: number,
  identity: GoogleIdentity,
  executeSql: SqlExecutor
): Promise<LinkIdentityResult> {
  const rows = await executeSql`
    WITH existing_subject AS (
      SELECT user_id
      FROM user_identities
      WHERE provider = 'google'
        AND provider_subject = ${identity.subject}
      LIMIT 1
    ),
    existing_user AS (
      SELECT id
      FROM user_identities
      WHERE user_id = ${userId}
        AND provider = 'google'
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO user_identities (
        user_id,
        provider,
        provider_subject,
        provider_email,
        email_verified,
        last_login_at
      )
      SELECT ${userId}, 'google', ${identity.subject}, ${identity.email}, TRUE, NOW()
      WHERE NOT EXISTS (SELECT 1 FROM existing_subject)
        AND NOT EXISTS (SELECT 1 FROM existing_user)
      RETURNING id
    )
    SELECT
      (SELECT user_id FROM existing_subject) AS subject_user_id,
      (SELECT id FROM existing_user) AS user_identity_id,
      (SELECT id FROM inserted) AS inserted_id;
  `;

  const result = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!result) {
    throw new Error("Google identity linking did not return a result.");
  }

  if (result.inserted_id !== null && result.inserted_id !== undefined) {
    return { status: "linked" };
  }

  if (result.user_identity_id !== null && result.user_identity_id !== undefined) {
    return { status: "already_linked" };
  }

  if (result.subject_user_id !== null && result.subject_user_id !== undefined) {
    if (Number(result.subject_user_id) === userId) {
      return { status: "already_linked" };
    }
    return { status: "linked_to_another_user", userId: Number(result.subject_user_id) };
  }

  throw new Error("Google identity could not be linked.");
}

export async function unlinkGoogleIdentity(
  userId: number,
  executeSql: SqlExecutor
): Promise<boolean> {
  const rows = await executeSql`
    DELETE FROM user_identities
    WHERE user_id = ${userId}
      AND provider = 'google'
    RETURNING id;
  `;

  return Array.isArray(rows) && rows.length > 0;
}
