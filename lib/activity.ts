/**
 * Rota Activity Feed — Domain Logic, Keyset Cursor Pagination, and Event Recording.
 *
 * Requirements:
 * - Server-side cursor-based pagination with deterministic secondary cursor (created_at DESC, id DESC)
 * - Safe handling of identical timestamps without duplicate or skipped records across page boundaries
 * - Workspace isolation enforcement (team_id partition)
 * - Immune to newly inserted records corrupting current paginated feed
 * - High-performance keyset querying over large datasets (10,000+ records)
 */

export type ActivityAction =
  | "shift_created"
  | "shift_updated"
  | "shift_deleted"
  | "swap_requested"
  | "swap_approved"
  | "swap_rejected"
  | "member_invited"
  | "member_joined"
  | "subscription_renewed"
  | "subscription_updated"
  | "settings_updated"
  | "custom";

export interface ActivityEventRecord {
  id: number;
  team_id: number;
  user_id: number | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  description: string;
  metadata: Record<string, unknown> | null;
  created_at: string; // ISO 8601 string
}

export interface ActivityCursorPayload {
  t: string; // ISO 8601 timestamp string
  id: number; // Unique secondary sort key
}

export interface ActivityFeedResponse {
  items: ActivityEventRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
}

export type SqlExecutor = (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Encodes created_at and id into an opaque, URL-safe Base64 cursor.
 */
export function encodeCursor(record: { created_at: string | Date; id: number }): string {
  const t =
    record.created_at instanceof Date
      ? record.created_at.toISOString()
      : new Date(record.created_at).toISOString();
  const payload: ActivityCursorPayload = { t, id: record.id };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decodes and strictly validates a cursor string.
 * Returns null if malformed, invalid JSON, invalid date, or non-integer id.
 */
export function decodeCursor(cursorString: unknown): ActivityCursorPayload | null {
  if (typeof cursorString !== "string" || cursorString.trim().length === 0) {
    return null;
  }

  try {
    const json = Buffer.from(cursorString.trim(), "base64url").toString("utf-8");
    const parsed = JSON.parse(json);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.t !== "string" ||
      isNaN(new Date(parsed.t).getTime()) ||
      typeof parsed.id !== "number" ||
      !Number.isInteger(parsed.id) ||
      parsed.id <= 0
    ) {
      return null;
    }

    return {
      t: new Date(parsed.t).toISOString(),
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

/**
 * Ensures database table and compound index for activity events exist.
 */
export async function ensureActivityTable(sql: SqlExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS activity_events (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_name VARCHAR(120) NOT NULL,
      action VARCHAR(64) NOT NULL,
      entity_type VARCHAR(64) NOT NULL,
      entity_id VARCHAR(64),
      description TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_activity_events_team_created_id
    ON activity_events (team_id, created_at DESC, id DESC);
  `;
}

/**
 * Formats a raw database row into an ActivityEventRecord with safe ISO string dates.
 */
export function normalizeActivityRow(row: any): ActivityEventRecord {
  return {
    id: Number(row.id),
    team_id: Number(row.team_id),
    user_id: row.user_id !== null && row.user_id !== undefined ? Number(row.user_id) : null,
    actor_name: String(row.actor_name || "Team Member"),
    action: String(row.action || "custom"),
    entity_type: String(row.entity_type || "workspace"),
    entity_id: row.entity_id !== null && row.entity_id !== undefined ? String(row.entity_id) : null,
    description: String(row.description || ""),
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : null,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  };
}

/**
 * Records a new activity event in the database for the active workspace.
 */
export async function recordActivityEvent(
  sql: SqlExecutor,
  params: {
    teamId: number;
    userId?: number | null;
    actorName: string;
    action: ActivityAction | string;
    entityType: string;
    entityId?: string | number | null;
    description: string;
    metadata?: Record<string, unknown> | null;
    createdAt?: Date | string;
  }
): Promise<ActivityEventRecord> {
  if (!params.teamId || !Number.isInteger(params.teamId) || params.teamId <= 0) {
    throw new Error("Invalid teamId: teamId must be a positive integer.");
  }
  if (!params.actorName || typeof params.actorName !== "string" || !params.actorName.trim()) {
    throw new Error("Invalid actorName: actorName must be a non-empty string.");
  }
  if (!params.description || typeof params.description !== "string" || !params.description.trim()) {
    throw new Error("Invalid description: description must be a non-empty string.");
  }

  await ensureActivityTable(sql);

  const createdAtIso = params.createdAt
    ? (params.createdAt instanceof Date ? params.createdAt : new Date(params.createdAt)).toISOString()
    : new Date().toISOString();

  const insertedRows = await sql`
    INSERT INTO activity_events (
      team_id, user_id, actor_name, action, entity_type, entity_id, description, metadata, created_at
    )
    VALUES (
      ${params.teamId},
      ${params.userId ?? null},
      ${params.actorName.trim()},
      ${String(params.action || "custom")},
      ${String(params.entityType || "workspace")},
      ${params.entityId !== undefined && params.entityId !== null ? String(params.entityId) : null},
      ${params.description.trim()},
      ${JSON.stringify(params.metadata ?? {})},
      ${createdAtIso}
    )
    RETURNING *;
  `;

  if (!insertedRows || insertedRows.length === 0) {
    throw new Error("Failed to insert activity event.");
  }

  return normalizeActivityRow(insertedRows[0]);
}

/**
 * Retrieves a paginated slice of activity events for a workspace using keyset cursor pagination.
 *
 * Ordering: created_at DESC, id DESC
 * Keyset Condition: (created_at < cursor.t) OR (created_at = cursor.t AND id < cursor.id)
 */
export async function getActivityFeed(
  sql: SqlExecutor,
  options: {
    teamId: number;
    cursor?: string | null;
    limit?: number;
  }
): Promise<ActivityFeedResponse> {
  if (!options.teamId || !Number.isInteger(options.teamId) || options.teamId <= 0) {
    throw new Error("Invalid teamId: teamId must be a positive integer.");
  }

  const pageSize = Math.min(Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const fetchLimit = pageSize + 1; // Fetch 1 extra to deterministically detect if hasMore exists

  await ensureActivityTable(sql);

  let rawRows: any[] = [];

  if (options.cursor) {
    const parsedCursor = decodeCursor(options.cursor);
    if (!parsedCursor) {
      throw new Error("Invalid cursor format. Provide a valid base64url cursor.");
    }

    rawRows = await sql`
      SELECT id, team_id, user_id, actor_name, action, entity_type, entity_id, description, metadata, created_at
      FROM activity_events
      WHERE team_id = ${options.teamId}
        AND (
          created_at < ${parsedCursor.t}
          OR (created_at = ${parsedCursor.t} AND id < ${parsedCursor.id})
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ${fetchLimit};
    `;
  } else {
    rawRows = await sql`
      SELECT id, team_id, user_id, actor_name, action, entity_type, entity_id, description, metadata, created_at
      FROM activity_events
      WHERE team_id = ${options.teamId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${fetchLimit};
    `;
  }

  const hasMore = rawRows.length > pageSize;
  const slicedRows = hasMore ? rawRows.slice(0, pageSize) : rawRows;
  const items = slicedRows.map(normalizeActivityRow);

  const nextCursor =
    hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null;

  return {
    items,
    nextCursor,
    hasMore,
    pageSize,
  };
}

/**
 * Pure in-memory comparator for activity records.
 * Strictly descending: created_at DESC, id DESC.
 */
export function compareActivityRecordsDesc(a: ActivityEventRecord, b: ActivityEventRecord): number {
  const timeA = new Date(a.created_at).getTime();
  const timeB = new Date(b.created_at).getTime();
  if (timeB !== timeA) {
    return timeB - timeA;
  }
  return b.id - a.id;
}

/**
 * Pure in-memory pagination engine over preloaded / simulated datasets.
 * Emulates identical keyset cursor pagination behavior with O(log N) binary search range seek.
 */
export function paginateActivitiesInMemory(
  records: ActivityEventRecord[],
  options: {
    teamId: number;
    cursor?: string | null;
    limit?: number;
  }
): ActivityFeedResponse {
  const pageSize = Math.min(Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

  // Filter strictly by workspace (multi-tenant boundary)
  const workspaceRecords = records.filter((r) => r.team_id === options.teamId);

  let startIndex = 0;

  if (options.cursor) {
    const parsedCursor = decodeCursor(options.cursor);
    if (!parsedCursor) {
      throw new Error("Invalid cursor format. Provide a valid base64url cursor.");
    }

    const cursorTime = new Date(parsedCursor.t).getTime();

    // Keyset range seek via binary search: O(log N)
    let low = 0;
    let high = workspaceRecords.length;

    while (low < high) {
      const mid = (low + high) >> 1;
      const rec = workspaceRecords[mid];
      const recTime = new Date(rec.created_at).getTime();

      // If rec is newer than or equal to cursor, move right
      if (recTime > cursorTime || (recTime === cursorTime && rec.id >= parsedCursor.id)) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    startIndex = low;
  }

  const slice = workspaceRecords.slice(startIndex, startIndex + pageSize + 1);
  const hasMore = slice.length > pageSize;
  const items = hasMore ? slice.slice(0, pageSize) : slice;
  const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null;

  return {
    items,
    nextCursor,
    hasMore,
    pageSize,
  };
}
