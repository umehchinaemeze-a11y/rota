import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  saveShiftsToOfflineCache,
  loadShiftsFromOfflineCache,
  clearShiftsOfflineCache,
  SHIFTS_OFFLINE_STORAGE_KEY,
  SHIFTS_OFFLINE_TIMESTAMP_KEY,
} from "../lib/shifts-client.ts";

describe("Offline Shift Caching & Account/Workspace Isolation", () => {
  let mockStorage = {};

  beforeEach(() => {
    mockStorage = {};
    global.window = {
      localStorage: {
        getItem: (key) => (key in mockStorage ? mockStorage[key] : null),
        setItem: (key, value) => {
          mockStorage[key] = String(value);
        },
        removeItem: (key) => {
          delete mockStorage[key];
        },
        clear: () => {
          mockStorage = {};
        },
      },
    };
  });

  afterEach(() => {
    delete global.window;
  });

  const sampleShifts = [
    {
      id: 1,
      day: "MON",
      date: "12",
      name: "Emeka Okafor",
      role: "Front Desk",
      userId: 10,
      teamId: 5,
      start: "09:00",
      end: "17:00",
      color: "bg-emerald-100 text-emerald-800",
      shiftDay: "2026-10-12",
    },
    {
      id: 2,
      day: "TUE",
      date: "13",
      name: "Adaobi Eze",
      role: "Supervisor",
      userId: 11,
      teamId: 5,
      start: "09:00",
      end: "17:00",
      color: "bg-blue-100 text-blue-800",
      shiftDay: "2026-10-13",
    },
  ];

  it("persists schedule shifts bound to authenticated user and workspace", () => {
    const userContext = { userId: 10, email: "emeka@clinic.ng", teamId: 5 };

    saveShiftsToOfflineCache(sampleShifts, userContext);

    assert.ok(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY]);
    assert.ok(mockStorage[SHIFTS_OFFLINE_TIMESTAMP_KEY]);

    const loaded = loadShiftsFromOfflineCache(userContext);
    assert.ok(loaded !== null);
    assert.equal(loaded.shifts.length, 2);
    assert.equal(loaded.shifts[0].id, 1);
    assert.equal(loaded.shifts[0].name, "Emeka Okafor");
    assert.equal(loaded.shifts[1].id, 2);
    assert.ok(loaded.timestamp !== null);
  });

  it("prevents unauthenticated callers from persisting shift data to cache", () => {
    saveShiftsToOfflineCache(sampleShifts, null);
    assert.equal(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY], undefined);

    saveShiftsToOfflineCache(sampleShifts, { userId: 0, email: "anon@none" });
    assert.equal(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY], undefined);
  });

  it("prevents unauthenticated callers from accessing cached shifts (shared device safety)", () => {
    const userContext = { userId: 10, email: "emeka@clinic.ng", teamId: 5 };
    saveShiftsToOfflineCache(sampleShifts, userContext);

    // Visitor without session must receive null
    const unauthLoaded = loadShiftsFromOfflineCache(null);
    assert.equal(unauthLoaded, null);

    const zeroIdLoaded = loadShiftsFromOfflineCache({ userId: 0 });
    assert.equal(zeroIdLoaded, null);
  });

  it("strictly enforces account isolation: User B cannot access User A's cached shifts", () => {
    const userA = { userId: 10, email: "userA@clinic.ng", teamId: 5 };
    const userB = { userId: 99, email: "userB@clinic.ng", teamId: 5 };

    // User A caches shifts
    saveShiftsToOfflineCache(sampleShifts, userA);

    // User B tries to read User A's cached shifts
    const userBLoaded = loadShiftsFromOfflineCache(userB);
    assert.equal(userBLoaded, null, "User B must not be able to read User A's cached shifts");

    // User A can still read their own cached shifts
    const userALoaded = loadShiftsFromOfflineCache(userA);
    assert.ok(userALoaded !== null);
    assert.equal(userALoaded.shifts.length, 2);
  });

  it("strictly enforces workspace isolation: shifts from Workspace 1 are hidden when active in Workspace 2", () => {
    const userWorkspace1 = { userId: 10, email: "emeka@clinic.ng", teamId: 5 };
    const userWorkspace2 = { userId: 10, email: "emeka@clinic.ng", teamId: 88 };

    // Cache shifts while in Workspace 5
    saveShiftsToOfflineCache(sampleShifts, userWorkspace1);

    // Switch active workspace to Workspace 88
    const switchedLoaded = loadShiftsFromOfflineCache(userWorkspace2);
    assert.equal(switchedLoaded, null, "Shifts from Workspace 5 must not leak into Workspace 88");

    // Switching back to Workspace 5 retrieves the data
    const backToWs1 = loadShiftsFromOfflineCache(userWorkspace1);
    assert.ok(backToWs1 !== null);
    assert.equal(backToWs1.shifts.length, 2);
  });

  it("clears cached shift data on logout (clearShiftsOfflineCache with all: true)", () => {
    const userContext = { userId: 10, email: "emeka@clinic.ng", teamId: 5 };
    saveShiftsToOfflineCache(sampleShifts, userContext);
    assert.ok(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY]);

    // Perform logout cache purge
    clearShiftsOfflineCache({ all: true });

    assert.equal(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY], undefined);
    assert.equal(mockStorage[SHIFTS_OFFLINE_TIMESTAMP_KEY], undefined);
    assert.equal(loadShiftsFromOfflineCache(userContext), null);
  });

  it("selectively clears cached shifts matching specific userId or teamId", () => {
    const userContext = { userId: 10, email: "emeka@clinic.ng", teamId: 5 };
    saveShiftsToOfflineCache(sampleShifts, userContext);

    // Clearing for unrelated user leaves cache intact
    clearShiftsOfflineCache({ userId: 999 });
    assert.ok(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY]);

    // Clearing for unrelated team leaves cache intact
    clearShiftsOfflineCache({ teamId: 999 });
    assert.ok(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY]);

    // Clearing for matching teamId purges cache
    clearShiftsOfflineCache({ teamId: 5 });
    assert.equal(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY], undefined);
  });

  it("handles legacy un-enveloped arrays by discarding them to prevent cross-account leak", () => {
    // Simulate legacy storage containing raw array without user envelope
    mockStorage[SHIFTS_OFFLINE_STORAGE_KEY] = JSON.stringify(sampleShifts);

    const userContext = { userId: 10, email: "emeka@clinic.ng", teamId: 5 };
    const loaded = loadShiftsFromOfflineCache(userContext);

    assert.equal(loaded, null);
    // Legacy data should be cleared
    assert.equal(mockStorage[SHIFTS_OFFLINE_STORAGE_KEY], undefined);
  });

  it("handles corrupted or malformed JSON in local storage safely without crashing", () => {
    mockStorage[SHIFTS_OFFLINE_STORAGE_KEY] = "{ corrupt: [json ...";
    mockStorage[SHIFTS_OFFLINE_TIMESTAMP_KEY] = "2026-10-12T10:00:00Z";

    const userContext = { userId: 10, teamId: 5 };
    const loaded = loadShiftsFromOfflineCache(userContext);
    assert.equal(loaded, null);
  });

  it("handles empty arrays or invalid shapes safely", () => {
    const userContext = { userId: 10, teamId: 5 };

    mockStorage[SHIFTS_OFFLINE_STORAGE_KEY] = JSON.stringify({
      userId: 10,
      teamId: 5,
      shifts: [],
    });
    assert.equal(loadShiftsFromOfflineCache(userContext), null);

    mockStorage[SHIFTS_OFFLINE_STORAGE_KEY] = '{"notAnEnvelope": true}';
    assert.equal(loadShiftsFromOfflineCache(userContext), null);
  });

  it("operates safely in server-side environment where window is undefined", () => {
    delete global.window;

    assert.doesNotThrow(() => {
      saveShiftsToOfflineCache(sampleShifts, { userId: 10 });
    });

    assert.doesNotThrow(() => {
      clearShiftsOfflineCache({ all: true });
    });

    assert.equal(loadShiftsFromOfflineCache({ userId: 10 }), null);
  });

  it("supports offline fallback: preserves shifts and timestamp when disconnected", () => {
    const userContext = { userId: 42, email: "doctor@hospital.org", teamId: 101 };
    saveShiftsToOfflineCache(sampleShifts, userContext);

    // Simulating offline status: loadShiftsFromOfflineCache retrieves valid data with timestamp
    const offlineData = loadShiftsFromOfflineCache(userContext);
    assert.ok(offlineData !== null);
    assert.equal(offlineData.shifts.length, 2);
    assert.ok(typeof offlineData.timestamp === "string");
  });
});
