import type { SessionPayload } from "../../../../lib/auth.ts";
import {
  type DevicePlatform,
  ensureNotificationsTables,
} from "../../../../lib/notifications.ts";

export type NotificationTokensDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<Required<NotificationTokensDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<NotificationTokensDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("@/lib/db"),
      import("@/lib/session"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleRegisterToken(
  request: Request,
  dependencies?: NotificationTokensDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to register device token." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace found." },
        { status: 403 }
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const platform = (body?.platform || "web").toLowerCase() as DevicePlatform;
    if (!["web", "android", "ios"].includes(platform)) {
      return Response.json(
        { error: "Invalid platform. Must be 'web', 'android', or 'ios'." },
        { status: 400 }
      );
    }

    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length < 5) {
      return Response.json(
        { error: "Valid device token or subscription endpoint string required." },
        { status: 400 }
      );
    }

    const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : null;
    const p256dh = typeof body?.p256dh === "string" ? body.p256dh.trim() : null;
    const auth = typeof body?.auth === "string" ? body.auth.trim() : null;

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    try {
      await ensureNotificationsTables(executeSql);
    } catch {}

    const upserted = await executeSql`
      INSERT INTO user_notification_tokens (
        user_id,
        team_id,
        platform,
        token,
        endpoint,
        p256dh,
        auth,
        status,
        last_seen_at
      ) VALUES (
        ${sessionUser.userId},
        ${sessionUser.teamId},
        ${platform},
        ${token},
        ${endpoint},
        ${p256dh},
        ${auth},
        'active',
        NOW()
      )
      ON CONFLICT (user_id, token) DO UPDATE SET
        team_id = EXCLUDED.team_id,
        platform = EXCLUDED.platform,
        endpoint = EXCLUDED.endpoint,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        status = 'active',
        last_seen_at = NOW()
      RETURNING id, platform, status, last_seen_at;
    `;

    return Response.json(
      {
        success: true,
        message: "Device notification token registered successfully.",
        tokenRecord: upserted[0],
      },
      { status: 201 }
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to register notification token:", error);
    return Response.json(
      { error: "Unable to register device token." },
      { status: 500 }
    );
  }
}

export async function handleDeleteToken(
  request: Request,
  dependencies?: NotificationTokensDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    let token: string | undefined;
    try {
      const body = await request.json();
      if (body && typeof body.token === "string") {
        token = body.token.trim();
      }
    } catch {}

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    try {
      await ensureNotificationsTables(executeSql);
    } catch {}

    if (token) {
      await executeSql`
        DELETE FROM user_notification_tokens
        WHERE user_id = ${sessionUser.userId} AND token = ${token};
      `;
    } else {
      // If token not specified, delete all tokens for this user in this team
      await executeSql`
        DELETE FROM user_notification_tokens
        WHERE user_id = ${sessionUser.userId} AND team_id = ${sessionUser.teamId};
      `;
    }

    return Response.json({
      success: true,
      message: "Device notification token removed.",
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to delete notification token:", error);
    return Response.json(
      { error: "Unable to remove device token." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleRegisterToken(request, deps);
}

export async function DELETE(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleDeleteToken(request, deps);
}

