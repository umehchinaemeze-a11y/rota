import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  encodeCursor,
  decodeCursor,
  getActivityFeed,
  recordActivityEvent,
  compareActivityRecordsDesc,
  paginateActivitiesInMemory,
} from "../lib/activity.ts";

import {
  ActivityFeedController,
  mergeActivityPages,
  createInitialActivityState,
} from "../lib/activity-client.ts";

import { handleGetActivity, handlePostActivity } from "../app/api/activity/route.ts";
import { assertSafeTargetHost } from "../scripts/load-test-200vu.mjs";

function createMockActivityDb(initialEvents = []) {
  const events = [...initialEvents];
  let nextId = events.length > 0 ? Math.max(...events.map((e) => e.id)) + 1 : 1;

  async function sql(strings, ...values) {
    const raw = strings.join("?");

    if (raw.includes("CREATE TABLE") || raw.includes("CREATE INDEX")) {
      return [];
    }

    if (raw.includes("INSERT INTO activity_events")) {
      const [teamId, userId, actorName, action, entityType, entityId, description, metadataStr, createdAt] = values;
      const parsedMeta = typeof metadataStr === "string" ? JSON.parse(metadataStr) : metadataStr;
      const rec = {
        id: nextId++,
        team_id: Number(teamId),
        user_id: userId !== null && userId !== undefined ? Number(userId) : null,
        actor_name: actorName,
        action,
        entity_type: entityType,
        entity_id: entityId !== null && entityId !== undefined ? String(entityId) : null,
        description,
        metadata: parsedMeta,
        created_at: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
      };
      events.push(rec);
      return [rec];
    }

    if (raw.includes("FROM activity_events") && raw.includes("WHERE team_id =")) {
      const teamId = Number(values[0]);
      let filtered = events.filter((e) => e.team_id === teamId);
      filtered.sort(compareActivityRecordsDesc);

      // Check if cursor condition present
      if (raw.includes("created_at <") || raw.includes("AND id <")) {
        const cursorTime = values[1];
        const cursorId = Number(values[3]);
        const cursorTimeMs = new Date(cursorTime).getTime();

        filtered = filtered.filter((e) => {
          const recTimeMs = new Date(e.created_at).getTime();
          return recTimeMs < cursorTimeMs || (recTimeMs === cursorTimeMs && e.id < cursorId);
        });
      }

      // Limit
      const limitVal = Number(values[values.length - 1]);
      return filtered.slice(0, limitVal);
    }

    return [];
  }

  return { sql, events };
}

describe("Activity Keyset Cursor Encoding and Validation", () => {
  it("encodes and decodes valid cursors with ISO timestamp and integer ID", () => {
    const record = {
      id: 42,
      created_at: "2026-11-08T15:00:00.000Z",
    };
    const cursor = encodeCursor(record);
    assert.ok(typeof cursor === "string" && cursor.length > 0);

    const decoded = decodeCursor(cursor);
    assert.ok(decoded !== null);
    assert.equal(decoded.id, 42);
    assert.equal(decoded.t, "2026-11-08T15:00:00.000Z");
  });

  it("handles Date objects during cursor encoding", () => {
    const date = new Date("2026-10-15T08:30:00.123Z");
    const cursor = encodeCursor({ id: 101, created_at: date });
    const decoded = decodeCursor(cursor);
    assert.ok(decoded !== null);
    assert.equal(decoded.id, 101);
    assert.equal(decoded.t, date.toISOString());
  });

  it("safely rejects malformed, invalid, or forged cursors", () => {
    assert.equal(decodeCursor("not-base64-json!"), null);
    assert.equal(decodeCursor(""), null);
    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor(undefined), null);

    // Valid base64 but invalid JSON schema
    const invalidSchema = Buffer.from(JSON.stringify({ t: "not-a-date", id: "not-int" })).toString("base64url");
    assert.equal(decodeCursor(invalidSchema), null);

    const negativeId = Buffer.from(JSON.stringify({ t: "2026-11-08T12:00:00Z", id: -5 })).toString("base64url");
    assert.equal(decodeCursor(negativeId), null);
  });
});

describe("Server-Side Cursor Pagination & Boundaries", () => {
  const baseTime = new Date("2026-11-08T12:00:00.000Z").getTime();
  const mockEvents = Array.from({ length: 45 }, (_, i) => ({
    id: i + 1,
    team_id: 1,
    user_id: 10,
    actor_name: "Manager",
    action: "shift_created",
    entity_type: "shift",
    entity_id: String(i + 1),
    description: `Created shift #${i + 1}`,
    metadata: {},
    created_at: new Date(baseTime + i * 1000).toISOString(),
  }));

  it("retrieves the first page with correct limit and hasMore indicator", async () => {
    const db = createMockActivityDb(mockEvents);
    const result = await getActivityFeed(db.sql, { teamId: 1, limit: 15 });

    assert.equal(result.items.length, 15);
    assert.equal(result.hasMore, true);
    assert.ok(result.nextCursor);

    // Verify ordering: newest first (highest id/time)
    assert.equal(result.items[0].id, 45);
    assert.equal(result.items[14].id, 31);
  });

  it("retrieves subsequent pages seamlessly using nextCursor across boundaries", async () => {
    const db = createMockActivityDb(mockEvents);

    // Page 1
    const page1 = await getActivityFeed(db.sql, { teamId: 1, limit: 20 });
    assert.equal(page1.items.length, 20);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.items[0].id, 45);
    assert.equal(page1.items[19].id, 26);

    // Page 2
    const page2 = await getActivityFeed(db.sql, { teamId: 1, cursor: page1.nextCursor, limit: 20 });
    assert.equal(page2.items.length, 20);
    assert.equal(page2.hasMore, true);
    assert.equal(page2.items[0].id, 25);
    assert.equal(page2.items[19].id, 6);

    // Page 3 (final partial page: 5 remaining records)
    const page3 = await getActivityFeed(db.sql, { teamId: 1, cursor: page2.nextCursor, limit: 20 });
    assert.equal(page3.items.length, 5);
    assert.equal(page3.hasMore, false);
    assert.equal(page3.nextCursor, null);
    assert.equal(page3.items[0].id, 5);
    assert.equal(page3.items[4].id, 1);
  });

  it("produces zero duplicate records across all traversed page boundaries", async () => {
    const db = createMockActivityDb(mockEvents);
    const allCollected = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const page = await getActivityFeed(db.sql, { teamId: 1, cursor, limit: 10 });
      allCollected.push(...page.items);
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }

    assert.equal(allCollected.length, 45);
    const uniqueIds = new Set(allCollected.map((e) => e.id));
    assert.equal(uniqueIds.size, 45, "Must contain exactly 45 unique activity IDs with zero duplicates");
  });
});

describe("Deterministic Secondary Cursor & Identical Timestamps", () => {
  it("resolves identical timestamps deterministically using secondary ID cursor", async () => {
    const identicalTime = "2026-11-08T14:30:00.000Z";
    // 6 records with the EXACT same timestamp
    const identicalEvents = [
      { id: 1, team_id: 2, actor_name: "A", action: "shift_created", entity_type: "s", entity_id: "1", description: "d1", metadata: {}, created_at: identicalTime },
      { id: 2, team_id: 2, actor_name: "B", action: "shift_created", entity_type: "s", entity_id: "2", description: "d2", metadata: {}, created_at: identicalTime },
      { id: 3, team_id: 2, actor_name: "C", action: "shift_created", entity_type: "s", entity_id: "3", description: "d3", metadata: {}, created_at: identicalTime },
      { id: 4, team_id: 2, actor_name: "D", action: "shift_created", entity_type: "s", entity_id: "4", description: "d4", metadata: {}, created_at: identicalTime },
      { id: 5, team_id: 2, actor_name: "E", action: "shift_created", entity_type: "s", entity_id: "5", description: "d5", metadata: {}, created_at: identicalTime },
      { id: 6, team_id: 2, actor_name: "F", action: "shift_created", entity_type: "s", entity_id: "6", description: "d6", metadata: {}, created_at: identicalTime },
    ];

    const db = createMockActivityDb(identicalEvents);

    // Page 1 (limit 3) -> should get IDs [6, 5, 4]
    const page1 = await getActivityFeed(db.sql, { teamId: 2, limit: 3 });
    assert.equal(page1.items.length, 3);
    assert.deepEqual(page1.items.map((i) => i.id), [6, 5, 4]);

    // Page 2 (limit 3) with cursor -> should get IDs [3, 2, 1]
    const page2 = await getActivityFeed(db.sql, { teamId: 2, cursor: page1.nextCursor, limit: 3 });
    assert.equal(page2.items.length, 3);
    assert.deepEqual(page2.items.map((i) => i.id), [3, 2, 1]);
    assert.equal(page2.hasMore, false);

    // Combined has 6 unique items in strictly descending ID order
    const combined = [...page1.items, ...page2.items];
    assert.deepEqual(combined.map((i) => i.id), [6, 5, 4, 3, 2, 1]);
  });

  it("handles newly inserted records during pagination without corrupting active feed", async () => {
    const db = createMockActivityDb([
      { id: 1, team_id: 1, actor_name: "A", action: "shift_created", entity_type: "s", entity_id: "1", description: "d1", metadata: {}, created_at: "2026-11-08T10:00:00Z" },
      { id: 2, team_id: 1, actor_name: "B", action: "shift_created", entity_type: "s", entity_id: "2", description: "d2", metadata: {}, created_at: "2026-11-08T10:01:00Z" },
      { id: 3, team_id: 1, actor_name: "C", action: "shift_created", entity_type: "s", entity_id: "3", description: "d3", metadata: {}, created_at: "2026-11-08T10:02:00Z" },
      { id: 4, team_id: 1, actor_name: "D", action: "shift_created", entity_type: "s", entity_id: "4", description: "d4", metadata: {}, created_at: "2026-11-08T10:03:00Z" },
    ]);

    // Fetch Page 1 (limit 2) -> returns [4, 3]
    const page1 = await getActivityFeed(db.sql, { teamId: 1, limit: 2 });
    assert.deepEqual(page1.items.map((i) => i.id), [4, 3]);

    // A new shift is scheduled while user is reading page 1!
    await recordActivityEvent(db.sql, {
      teamId: 1,
      actorName: "Supervisor",
      action: "shift_created",
      entityType: "shift",
      entityId: "99",
      description: "Brand new shift",
      createdAt: "2026-11-08T10:04:00Z", // Newer than page 1 items
    });

    // Client continues scrolling and fetches Page 2 using page1 cursor
    const page2 = await getActivityFeed(db.sql, { teamId: 1, cursor: page1.nextCursor, limit: 2 });

    // Page 2 must return [2, 1] without skipping or re-rendering items
    assert.deepEqual(page2.items.map((i) => i.id), [2, 1]);
  });
});

describe("Client State Management, Overlapping Scroll & Duplicate Prevention", () => {
  it("deduplicates merged pages cleanly using mergeActivityPages", () => {
    const page1 = [
      { id: 10, created_at: "2026-11-08T12:00:00Z" },
      { id: 9, created_at: "2026-11-08T11:59:00Z" },
    ];
    // Overlapping page containing item #9 again
    const page2 = [
      { id: 9, created_at: "2026-11-08T11:59:00Z" },
      { id: 8, created_at: "2026-11-08T11:58:00Z" },
    ];

    const merged = mergeActivityPages(page1, page2);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged.map((e) => e.id), [10, 9, 8]);
  });

  it("locks concurrent requests to prevent duplicate network calls during rapid scrolling", async () => {
    let networkCallCount = 0;
    const mockFetch = async () => {
      networkCallCount++;
      // Simulate artificial latency
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          items: [{ id: 1, created_at: "2026-11-08T12:00:00Z" }],
          nextCursor: "cursor-1",
          hasMore: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const controller = new ActivityFeedController({ fetchFn: mockFetch });

    // First load
    await controller.loadFirstPage();
    assert.equal(networkCallCount, 1);

    // Fire 5 rapid overlapping scroll triggers simultaneously
    const triggers = await Promise.all([
      controller.loadNextPage(),
      controller.loadNextPage(),
      controller.loadNextPage(),
      controller.loadNextPage(),
      controller.loadNextPage(),
    ]);

    // Exactly ONE trigger must execute; the other 4 must be blocked
    const executedCount = triggers.filter(Boolean).length;
    assert.equal(executedCount, 1);
    assert.equal(networkCallCount, 2, "Only 1 next-page network call should be dispatched");
  });

  it("resets cursor and state during pull-to-refresh interaction", async () => {
    let requestCount = 0;
    const mockFetch = async (url) => {
      requestCount++;
      const isCursor = url.includes("cursor=");
      return new Response(
        JSON.stringify({
          items: isCursor ? [{ id: 5, created_at: "2026-11-08T10:00:00Z" }] : [{ id: 10, created_at: "2026-11-08T12:00:00Z" }],
          nextCursor: isCursor ? null : "cursor-page-1",
          hasMore: !isCursor,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const controller = new ActivityFeedController({ fetchFn: mockFetch });
    await controller.loadFirstPage();
    assert.equal(controller.getState().events[0].id, 10);
    assert.equal(controller.getState().nextCursor, "cursor-page-1");

    await controller.loadNextPage();
    assert.equal(controller.getState().events.length, 2);

    // Pull-to-refresh
    await controller.refresh();
    const state = controller.getState();
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].id, 10);
    assert.equal(state.hasMore, true);
    assert.equal(state.nextCursor, "cursor-page-1");
  });

  it("handles network failure and supports retry interaction cleanly", async () => {
    let failFirst = true;
    const mockFetch = async () => {
      if (failFirst) {
        failFirst = false;
        return new Response(JSON.stringify({ error: "Service unavailable." }), { status: 503 });
      }
      return new Response(
        JSON.stringify({
          items: [{ id: 1, created_at: "2026-11-08T12:00:00Z" }],
          nextCursor: null,
          hasMore: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const controller = new ActivityFeedController({ fetchFn: mockFetch });
    const success1 = await controller.loadFirstPage();
    assert.equal(success1, false);
    assert.ok(controller.getState().error.includes("Service unavailable"));

    // Retry
    const success2 = await controller.retry();
    assert.equal(success2, true);
    assert.equal(controller.getState().error, null);
    assert.equal(controller.getState().events.length, 1);
  });
});

describe("Multi-Tenant Workspace Isolation and Authorization", () => {
  it("rejects unauthenticated requests with HTTP 401 Unauthorized", async () => {
    const req = new Request("http://localhost/api/activity");
    const res = await handleGetActivity(req, {
      getSessionUser: async () => null,
      sql: async () => [],
    });
    assert.equal(res.status, 401);
  });

  it("rejects users without active team membership with HTTP 403 Forbidden", async () => {
    const req = new Request("http://localhost/api/activity");
    const res = await handleGetActivity(req, {
      getSessionUser: async () => ({
        userId: 1,
        email: "orphan@rota.local",
        name: "Orphan User",
        role: "Front Desk",
        teamId: null, // No workspace
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
      sql: async () => [],
    });
    assert.equal(res.status, 403);
  });

  it("enforces workspace isolation so Team 1 users never see Team 2 activities", async () => {
    const events = [
      { id: 1, team_id: 1, actor_name: "Alice", action: "shift_created", entity_type: "s", entity_id: "1", description: "Team 1 Event", metadata: {}, created_at: "2026-11-08T12:00:00Z" },
      { id: 2, team_id: 2, actor_name: "Bob", action: "shift_created", entity_type: "s", entity_id: "2", description: "Team 2 Secret Event", metadata: {}, created_at: "2026-11-08T12:01:00Z" },
    ];
    const db = createMockActivityDb(events);

    const req = new Request("http://localhost/api/activity");
    const res = await handleGetActivity(req, {
      getSessionUser: async () => ({
        userId: 10,
        email: "alice@team1.local",
        name: "Alice",
        role: "Staff",
        teamId: 1,
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
      sql: db.sql,
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].description, "Team 1 Event");
    assert.equal(data.items[0].team_id, 1);
  });
});

describe("Large Dataset Keyset Pagination (10,000 Records Benchmark)", () => {
  it("traverses 10,000 records page-by-page with zero duplicates, zero gaps, and monotonic ordering", () => {
    const TOTAL_RECORDS = 10000;
    const PAGE_SIZE = 100;
    const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

    // Generate 10,000 records with some duplicate timestamps to test tie-breakers
    const dataset = Array.from({ length: TOTAL_RECORDS }, (_, i) => {
      // Group every 5 records with identical timestamp
      const timeOffsetMs = Math.floor(i / 5) * 1000;
      return {
        id: i + 1,
        team_id: 42,
        user_id: 1,
        actor_name: `Worker ${(i % 50) + 1}`,
        action: "shift_created",
        entity_type: "shift",
        entity_id: String(i + 1),
        description: `Activity #${i + 1}`,
        metadata: { index: i + 1 },
        created_at: new Date(baseTime + timeOffsetMs).toISOString(),
      };
    });

    // Pre-sort dataset descending (created_at DESC, id DESC), exactly matching the database compound index
    dataset.sort(compareActivityRecordsDesc);

    const startTime = performance.now();
    const collected = [];
    let cursor = null;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      pageCount++;
      const result = paginateActivitiesInMemory(dataset, {
        teamId: 42,
        cursor,
        limit: PAGE_SIZE,
      });

      collected.push(...result.items);
      cursor = result.nextCursor;
      hasMore = result.hasMore;
    }

    const durationMs = performance.now() - startTime;

    assert.equal(collected.length, TOTAL_RECORDS, `Must retrieve all ${TOTAL_RECORDS} records`);
    assert.equal(pageCount, TOTAL_RECORDS / PAGE_SIZE, `Must require exactly ${TOTAL_RECORDS / PAGE_SIZE} pages`);

    // Verify uniqueness (zero duplicate IDs)
    const uniqueIds = new Set(collected.map((r) => r.id));
    assert.equal(uniqueIds.size, TOTAL_RECORDS, "Every record ID in the 10,000 traversal must be distinct");

    // Verify strictly monotonic descending order
    for (let i = 0; i < collected.length - 1; i++) {
      const current = collected[i];
      const next = collected[i + 1];
      const currTime = new Date(current.created_at).getTime();
      const nextTime = new Date(next.created_at).getTime();

      const isDescending =
        currTime > nextTime || (currTime === nextTime && current.id > next.id);
      assert.ok(isDescending, `Ordering violation at index ${i}: current #${current.id} vs next #${next.id}`);
    }

    // Benchmark check: 10,000 in-memory keyset traversals must complete in under 500ms
    assert.ok(durationMs < 500, `Keyset traversal must be sub-second (actual: ${durationMs.toFixed(2)}ms)`);
  });
});

describe("200-Virtual-User Capacity Test Script Safety", () => {
  it("strictly prohibits live execution against production domains (*.vercel.app)", () => {
    assert.throws(
      () => assertSafeTargetHost("https://rota-lovat-gamma.vercel.app"),
      /Safety violation/
    );
  });

  it("permits staging and local executions only with safety confirmation", () => {
    assert.equal(assertSafeTargetHost("http://localhost:3000"), "localhost");
    assert.equal(assertSafeTargetHost("http://staging-test.local:8080", "staging-test.local"), "staging-test.local");
  });
});
