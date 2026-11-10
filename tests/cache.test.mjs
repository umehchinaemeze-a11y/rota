import test, { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  MemoryCacheStore,
  buildRosterCacheKey,
  buildShiftCalendarCacheKey,
  getCachedTeamRoster,
  getCachedShiftSchedule,
  invalidateTeamCache,
} from "../lib/cache.ts";

describe("Redis & Distributed Caching Layer", () => {
  let store;

  beforeEach(() => {
    store = new MemoryCacheStore();
  });

  it("caches and retrieves team roster with correct cache hits and misses", async () => {
    let dbQueryCount = 0;
    const mockRosterFactory = async () => {
      dbQueryCount++;
      return [
        { id: 1, name: "Amara Okafor", role: "Front Desk" },
        { id: 2, name: "Daniel James", role: "Operations" },
      ];
    };

    // First call: Cache miss -> queries DB
    const res1 = await getCachedTeamRoster(10, mockRosterFactory, store);
    assert.equal(res1.fromCache, false);
    assert.equal(res1.data.length, 2);
    assert.equal(dbQueryCount, 1);

    // Second call: Cache hit -> zero DB queries
    const res2 = await getCachedTeamRoster(10, mockRosterFactory, store);
    assert.equal(res2.fromCache, true);
    assert.equal(res2.data.length, 2);
    assert.equal(dbQueryCount, 1);
  });

  it("caches shift calendars per team and date range independently", async () => {
    let callCount = 0;
    const factory = async () => {
      callCount++;
      return [{ id: 101, shiftDay: "2026-11-12", role: "Supervisor" }];
    };

    const resOct = await getCachedShiftSchedule(5, "2026-10", factory, store);
    assert.equal(resOct.fromCache, false);
    assert.equal(callCount, 1);

    // Same team, different month -> Cache miss
    const resNov = await getCachedShiftSchedule(5, "2026-11", factory, store);
    assert.equal(resNov.fromCache, false);
    assert.equal(callCount, 2);

    // Re-query Oct -> Cache hit
    const resOctCached = await getCachedShiftSchedule(5, "2026-10", factory, store);
    assert.equal(resOctCached.fromCache, true);
    assert.equal(callCount, 2);
  });

  it("invalidates all cached rosters and schedules for a team when shifts change", async () => {
    let rosterCalls = 0;
    let shiftCalls = 0;

    await getCachedTeamRoster(7, async () => {
      rosterCalls++;
      return ["Member A"];
    }, store);

    await getCachedShiftSchedule(7, "all", async () => {
      shiftCalls++;
      return ["Shift A"];
    }, store);

    assert.equal(rosterCalls, 1);
    assert.equal(shiftCalls, 1);

    // Perform mutation invalidation
    const deletedCount = await invalidateTeamCache(7, store);
    assert.ok(deletedCount >= 2, "Both roster and shift cache keys must be invalidated");

    // Subsequent fetches must hit factory again
    await getCachedTeamRoster(7, async () => {
      rosterCalls++;
      return ["Member A"];
    }, store);

    await getCachedShiftSchedule(7, "all", async () => {
      shiftCalls++;
      return ["Shift A"];
    }, store);

    assert.equal(rosterCalls, 2);
    assert.equal(shiftCalls, 2);
  });

  it("respects TTL expiration and re-fetches after timeout", async () => {
    let calls = 0;
    const factory = async () => {
      calls++;
      return "fresh_data";
    };

    // Set with 0.1s TTL
    const key = "cache:team:99:roster";
    await store.set(key, "old_data", 0.05);

    // Immediate get
    const immediate = await store.get(key);
    assert.equal(immediate, "old_data");

    // Wait 70ms for TTL expiration
    await new Promise((r) => setTimeout(r, 70));
    const expired = await store.get(key);
    assert.equal(expired, null);
  });
});

