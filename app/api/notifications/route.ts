import type { SessionPayload } from "../../../lib/auth.ts";
import {
  type NotificationRecord,
  ensureNotificationsTables,
} from "../../../lib/notifications.ts";

export type NotificationsRouteDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
};

let prodDepsPromise: Promise<Required<NotificationsRouteDependencies>> | null = null;

async function loadProductionDependencies(): Promise<Required<NotificationsRouteDependencies>> {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("@/lib/db"),
      import("@/lib/session"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleGetNotifications(
  request: Request,
  dependencies?: NotificationsRouteDependencies
): Promise<Response> {
  try {
    const resolveSessionUser =
      dependencies?.getSessionUser ??
      (await loadProductionDependencies()).getSessionUser;

    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to view notifications." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: No active workspace found for this account." },
        { status: 403 }
      );
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    try {
      await ensureNotificationsTables(executeSql);
    } catch {}

    const rows: NotificationRecord[] = await executeSql`
      SELECT
        id,
        team_id,
        user_id,
        category,
        title,
        body,
        deep_link,
        read,
        delivered,
        suppressed_reason,
        created_at
      FROM notification_records
      WHERE user_id = ${sessionUser.userId} AND team_id = ${sessionUser.teamId}
      ORDER BY created_at DESC
      LIMIT 50;
    `;

    const unreadCount = (rows || []).filter((r) => !r.read).length;

    return Response.json({
      notifications: rows || [],
      unreadCount,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to fetch user notifications:", error);
    return Response.json(
      { error: "Unable to retrieve notifications." },
      { status: 500 }
    );
  }
}

export async function handleMarkNotificationsRead(
  request: Request,
  dependencies?: NotificationsRouteDependencies
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

    if (!sessionUser.teamId || sessionUser.teamId <= 0) {
      return Response.json(
        { error: "Forbidden: Workspace access required." },
        { status: 403 }
      );
    }

    let notificationId: number | undefined;
    try {
      const body = await request.json();
      if (body && typeof body.id === "number") {
        notificationId = body.id;
      }
    } catch {
      // Body optional: if omitted, marks all read
    }

    const executeSql =
      dependencies?.sql ??
      (await loadProductionDependencies()).sql;

    try {
      await ensureNotificationsTables(executeSql);
    } catch {}

    if (notificationId) {
      await executeSql`
        UPDATE notification_records
        SET read = TRUE
        WHERE id = ${notificationId}
          AND user_id = ${sessionUser.userId}
          AND team_id = ${sessionUser.teamId};
      `;
    } else {
      await executeSql`
        UPDATE notification_records
        SET read = TRUE
        WHERE user_id = ${sessionUser.userId}
          AND team_id = ${sessionUser.teamId}
          AND read = FALSE;
      `;
    }

    return Response.json({ success: true, message: "Notifications updated." });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      ("digest" in error || String((error as any).message).includes("prerender"))
    ) {
      throw error;
    }
    console.error("Failed to mark notifications read:", error);
    return Response.json(
      { error: "Unable to update notifications." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleGetNotifications(request, deps);
}

export async function POST(request: Request): Promise<Response> {
  const deps = await loadProductionDependencies();
  return handleMarkNotificationsRead(request, deps);
}

