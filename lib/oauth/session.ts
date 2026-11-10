import { createSessionToken } from "../auth.ts";
import { getAuthSecret, serializeSessionCookie } from "../session.ts";
import { ACCESS_TOKEN_TTL_SECONDS } from "../refresh-tokens.ts";
import type { AuthUserRecord } from "./users.ts";

export function createUserSessionCookie(
  user: AuthUserRecord,
  secret: string = getAuthSecret(),
  sessionId?: string
): string {
  const token = createSessionToken(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      ...(sessionId ? { sessionId } : {}),
    },
    secret,
    ACCESS_TOKEN_TTL_SECONDS
  );

  return serializeSessionCookie(token, ACCESS_TOKEN_TTL_SECONDS);
}
