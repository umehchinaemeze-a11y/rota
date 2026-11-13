import { getSessionUser } from "../../../lib/session.ts";
import { isSameOriginRequest } from "../../../lib/oauth/safe-redirect.ts";
import {
  getActivityFeed,
  recordActivityEvent,
  type SqlExecutor,
  type ActivityAction,
} from "../../../lib/activity.ts";

export type ActivityRouteDependencies = {
  sql?: SqlExecutor;
  getSessionUser?: typeof getSessionUser;
};

let prodSqlPromise: Promise<any> | null = null;
async function loadProductionSql(): Promise<any> {
  if (!prodSqlPromise) {
    prodSqlPromise = import("../../../lib/db.ts").then((m) => m.sql);
  }
  return prodSqlPromise;
}

/**
 * GET /api/activity
 *
 * Query parameters:
 * - cursor: string (opaque base64url keyset cursor)
 * - limit: number (items per page, default 20, max 100)
 */
export async function handleGetActivity(
  request: Request,
  deps: ActivityRouteDependencies = {}
): Promise<Response> {
  try {
    const getSessionUserFn = deps.getSessionUser ?? getSessionUser;
    const sessionUser = await getSessionUserFn({ revalidateWithDb: true });

    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to access activity feed." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId) {
      return Response.json(
        { error: "No active workspace associated with session." },
        { status: 403 }
      );
    }

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const rawLimit = url.searchParams.get("limit");
    let limit: number | undefined = undefined;

    if (rawLimit !== null) {
      const parsedLimit = parseInt(rawLimit, 10);
      if (isNaN(parsedLimit) || parsedLimit <= 0) {
        return Response.json(
          { error: "Invalid limit parameter: limit must be a positive integer." },
          { status: 400 }
        );
      }
      limit = parsedLimit;
    }

    const sql = deps.sql ?? (await loadProductionSql());

    try {
      const result = await getActivityFeed(sql, {
        teamId: sessionUser.teamId,
        cursor: cursor || null,
        limit,
      });

      return Response.json(
        {
          success: true,
          ...result,
        },
        { status: 200 }
      );
    } catch (queryErr: any) {
      if (queryErr.message?.includes("Invalid cursor format")) {
        return Response.json(
          { error: "Invalid cursor format provided." },
          { status: 400 }
        );
      }
      throw queryErr;
    }
  } catch (error) {
    console.error("Activity feed retrieval error:", error);
    return Response.json(
      { error: "Failed to retrieve activity feed." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/activity
 *
 * Records a new activity event in the active workspace.
 */
export async function handlePostActivity(
  request: Request,
  deps: ActivityRouteDependencies = {}
): Promise<Response> {
  try {
    const getSessionUserFn = deps.getSessionUser ?? getSessionUser;
    const sessionUser = await getSessionUserFn({ revalidateWithDb: true });

    if (!sessionUser) {
      return Response.json(
        { error: "Authentication required to record activity." },
        { status: 401 }
      );
    }

    if (!sessionUser.teamId) {
      return Response.json(
        { error: "No active workspace associated with session." },
        { status: 403 }
      );
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON request body." },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object") {
      return Response.json(
        { error: "Activity event payload is required." },
        { status: 400 }
      );
    }

    const action = typeof body.action === "string" ? body.action.trim() : "custom";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const entityType = typeof body.entityType === "string" ? body.entityType.trim() : "workspace";
    const entityId = body.entityId ? String(body.entityId) : null;
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : null;

    if (!description) {
      return Response.json(
        { error: "Event description is required." },
        { status: 400 }
      );
    }

    const sql = deps.sql ?? (await loadProductionSql());

    const created = await recordActivityEvent(sql, {
      teamId: sessionUser.teamId,
      userId: sessionUser.userId,
      actorName: sessionUser.name,
      action: action as ActivityAction,
      entityType,
      entityId,
      description,
      metadata,
      createdAt: body.createdAt ? new Date(body.createdAt) : undefined,
    });

    return Response.json(
      {
        success: true,
        event: created,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Activity event creation error:", error);
    return Response.json(
      { error: "Failed to record activity event." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleGetActivity(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  return handlePostActivity(request);
}
