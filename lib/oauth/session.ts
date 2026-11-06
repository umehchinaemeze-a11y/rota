import { createSessionToken } from "../auth.ts";
import { getAuthSecret, serializeSessionCookie } from "../session.ts";
import type { AuthUserRecord } from "./users.ts";

export function createUserSessionCookie(
  user: AuthUserRecord,
  secret: string = getAuthSecret()
): string {
  const token = createSessionToken(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    secret
  );

  return serializeSessionCookie(token);
}
