import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isValidTheme,
  normalizeTheme,
  isValidLanguage,
  normalizeLanguage,
  getDefaultUserSettings,
  resolveSettingsConflict,
  SUPPORTED_THEMES,
  SUPPORTED_LANGUAGES,
} from "../lib/settings.ts";
import {
  handleGetSettings,
  handleUpdateSettings,
} from "../app/api/settings/route.ts";
import {
  saveSettingsToOfflineCache,
  loadSettingsFromOfflineCache,
  clearSettingsOfflineCache,
  applyThemeToDocument,
  applyLanguageToDocument,
  SETTINGS_OFFLINE_STORAGE_KEY,
} from "../lib/shifts-client.ts";

describe("User Settings — Pure Domain Logic & Validation", () => {
  it("validates supported color themes and rejects invalid values", () => {
    assert.equal(isValidTheme("system"), true);
    assert.equal(isValidTheme("light"), true);
    assert.equal(isValidTheme("dark"), true);

    assert.equal(isValidTheme("neon"), false);
    assert.equal(isValidTheme(""), false);
    assert.equal(isValidTheme(null), false);
    assert.equal(isValidTheme(123), false);

    assert.equal(normalizeTheme("dark"), "dark");
    assert.equal(normalizeTheme("light"), "light");
    assert.equal(normalizeTheme("invalid"), "system");
    assert.equal(normalizeTheme(null), "system");
  });

  it("validates language codes and normalizes supported languages", () => {
    assert.equal(isValidLanguage("en"), true);
    assert.equal(isValidLanguage("es"), true);
    assert.equal(isValidLanguage("fr"), true);
    assert.equal(isValidLanguage("de"), true);
    assert.equal(isValidLanguage("yo"), true);
    assert.equal(isValidLanguage("ig"), true);
    assert.equal(isValidLanguage("ha"), true);
    assert.equal(isValidLanguage("en-US"), true);

    assert.equal(isValidLanguage(""), false);
    assert.equal(isValidLanguage("invalid-too-long-language-string"), false);
    assert.equal(isValidLanguage("12345"), false);
    assert.equal(isValidLanguage(null), false);

    assert.equal(normalizeLanguage("ES"), "es");
    assert.equal(normalizeLanguage("yo"), "yo");
    assert.equal(normalizeLanguage("unknown-xyz"), "en");
    assert.equal(normalizeLanguage(null), "en");
  });

  it("generates correct server-side default settings for new users", () => {
    const defaults = getDefaultUserSettings(42, 10);
    assert.equal(defaults.userId, 42);
    assert.equal(defaults.teamId, 10);
    assert.equal(defaults.theme, "system");
    assert.equal(defaults.language, "en");
    assert.equal(defaults.timezone, "UTC");
    assert.equal(defaults.revision, 1);
    assert.equal(defaults.notifications.enabled, true);
    assert.equal(defaults.notifications.categories.shift_assigned, true);
    assert.equal(defaults.quietHours.enabled, false);
    assert.equal(defaults.quietHours.start, "22:00");
    assert.equal(defaults.quietHours.end, "08:00");
  });

  it("resolves clean updates without conflict and increments revision monotonically", () => {
    const serverCurrent = getDefaultUserSettings(1, 1);
    const clientUpdate = {
      theme: "dark",
      language: "es",
      timezone: "Africa/Lagos",
      expectedRevision: 1,
    };

    const result = resolveSettingsConflict(clientUpdate, serverCurrent);
    assert.equal(result.hasConflict, false);
    assert.equal(result.resolvedSettings.theme, "dark");
    assert.equal(result.resolvedSettings.language, "es");
    assert.equal(result.resolvedSettings.timezone, "Africa/Lagos");
    assert.equal(result.resolvedSettings.revision, 2);
  });

  it("detects conflict when client submits a stale revision from Device A while Device B already updated", () => {
    const serverCurrent = {
      ...getDefaultUserSettings(1, 1),
      revision: 4,
      theme: "light",
      language: "fr",
    };

    // Stale Device A attempting update with expectedRevision 2
    const staleUpdate = {
      theme: "dark",
      expectedRevision: 2,
    };

    const conflict = resolveSettingsConflict(staleUpdate, serverCurrent);
    assert.equal(conflict.hasConflict, true);
    assert.equal(conflict.resolvedSettings.revision, 4);
    assert.equal(conflict.resolvedSettings.theme, "light");
    assert.ok(conflict.reason.includes("Stale revision 2 received"));
  });

  it("allows forced resolution to overwrite server settings when force is requested", () => {
    const serverCurrent = {
      ...getDefaultUserSettings(1, 1),
      revision: 5,
      theme: "light",
    };

    const forceUpdate = {
      theme: "dark",
      expectedRevision: 2,
    };

    const resolved = resolveSettingsConflict(forceUpdate, serverCurrent, { force: true });
    assert.equal(resolved.hasConflict, false);
    assert.equal(resolved.resolvedSettings.theme, "dark");
    assert.equal(resolved.resolvedSettings.revision, 6);
  });
});

describe("User Settings API Routes — GET & PUT /api/settings", () => {
  const dummySession = {
    userId: 101,
    name: "Dr. Chinazom",
    email: "chinazom@example.com",
    role: "Staff",
    teamId: 5,
  };

  it("rejects unauthenticated requests with HTTP 401", async () => {
    const req = new Request("http://localhost/api/settings", { method: "GET" });
    const res = await handleGetSettings(req, {
      getSessionUser: async () => null,
      sql: async () => [],
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error.includes("Authentication required"));
  });

  it("rejects requests without an active workspace with HTTP 403", async () => {
    const req = new Request("http://localhost/api/settings", { method: "GET" });
    const res = await handleGetSettings(req, {
      getSessionUser: async () => ({ ...dummySession, teamId: 0 }),
      sql: async () => [],
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error.includes("Forbidden"));
  });

  it("returns server-side defaults when user has no stored settings row", async () => {
    const req = new Request("http://localhost/api/settings", { method: "GET" });
    const res = await handleGetSettings(req, {
      getSessionUser: async () => dummySession,
      sql: async () => [], // Empty query result
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.settings.userId, 101);
    assert.equal(body.settings.teamId, 5);
    assert.equal(body.settings.theme, "system");
    assert.equal(body.settings.language, "en");
    assert.equal(body.settings.revision, 1);
  });

  it("returns persisted user settings when row exists", async () => {
    const mockRow = {
      theme: "dark",
      language: "es",
      timezone: "America/New_York",
      quiet_hours_enabled: true,
      quiet_hours_start: "23:00",
      quiet_hours_end: "07:00",
      enabled: true,
      notify_shift_assigned: true,
      notify_shift_updated: false,
      notify_swap_requested: true,
      notify_swap_approved: true,
      notify_swap_rejected: true,
      notify_swap_cancelled: false,
      revision: 3,
      updated_at: "2026-11-08T12:00:00.000Z",
    };

    const req = new Request("http://localhost/api/settings", { method: "GET" });
    const res = await handleGetSettings(req, {
      getSessionUser: async () => dummySession,
      sql: async (strings) => {
        if (strings.join("").includes("SELECT")) {
          return [mockRow];
        }
        return [];
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.settings.theme, "dark");
    assert.equal(body.settings.language, "es");
    assert.equal(body.settings.timezone, "America/New_York");
    assert.equal(body.settings.quietHours.enabled, true);
    assert.equal(body.settings.quietHours.start, "23:00");
    assert.equal(body.settings.notifications.categories.shift_updated, false);
    assert.equal(body.settings.revision, 3);
  });

  it("rejects invalid update payloads (invalid theme, invalid quiet hours format)", async () => {
    const invalidThemeReq = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "unsupported-theme" }),
    });

    const res1 = await handleUpdateSettings(invalidThemeReq, {
      getSessionUser: async () => dummySession,
      sql: async () => [],
    });
    assert.equal(res1.status, 400);
    const body1 = await res1.json();
    assert.ok(body1.error.includes("Invalid theme"));

    const invalidQuietReq = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quietHours: { start: "25:00" } }),
    });

    const res2 = await handleUpdateSettings(invalidQuietReq, {
      getSessionUser: async () => dummySession,
      sql: async () => [],
    });
    assert.equal(res2.status, 400);
    const body2 = await res2.json();
    assert.ok(body2.error.includes("Invalid quiet hours start time"));
  });

  it("updates settings successfully and returns incremented revision", async () => {
    let capturedInsertValues = [];

    const updateReq = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        theme: "dark",
        language: "fr",
        timezone: "Europe/London",
        expectedRevision: 1,
      }),
    });

    const res = await handleUpdateSettings(updateReq, {
      getSessionUser: async () => dummySession,
      sql: async (strings, ...values) => {
        const query = strings.join("?");
        if (query.includes("SELECT")) {
          return []; // Starts from default revision 1
        }
        if (query.includes("INSERT INTO user_notification_preferences")) {
          capturedInsertValues = values;
          return [
            {
              theme: "dark",
              language: "fr",
              timezone: "Europe/London",
              quiet_hours_enabled: false,
              quiet_hours_start: "22:00",
              quiet_hours_end: "08:00",
              enabled: true,
              notify_shift_assigned: true,
              notify_shift_updated: true,
              notify_swap_requested: true,
              notify_swap_approved: true,
              notify_swap_rejected: true,
              notify_swap_cancelled: true,
              revision: 2,
              updated_at: new Date().toISOString(),
            },
          ];
        }
        return [];
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.settings.theme, "dark");
    assert.equal(body.settings.language, "fr");
    assert.equal(body.settings.timezone, "Europe/London");
    assert.equal(body.settings.revision, 2);
  });

  it("returns HTTP 409 Conflict when concurrent update detects stale revision", async () => {
    const existingServerRow = {
      theme: "light",
      language: "en",
      timezone: "UTC",
      quiet_hours_enabled: false,
      quiet_hours_start: "22:00",
      quiet_hours_end: "08:00",
      enabled: true,
      notify_shift_assigned: true,
      notify_shift_updated: true,
      notify_swap_requested: true,
      notify_swap_approved: true,
      notify_swap_rejected: true,
      notify_swap_cancelled: true,
      revision: 4, // Server is already at revision 4
      updated_at: new Date().toISOString(),
    };

    const staleReq = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        theme: "dark",
        expectedRevision: 2, // Device A has stale revision 2
      }),
    });

    const res = await handleUpdateSettings(staleReq, {
      getSessionUser: async () => dummySession,
      sql: async (strings) => {
        if (strings.join("").includes("SELECT")) {
          return [existingServerRow];
        }
        return [];
      },
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.conflict, true);
    assert.equal(body.serverSettings.revision, 4);
    assert.ok(body.error.includes("Settings conflict detected"));
  });
});

describe("Cross-Device Settings Synchronization & Multi-Tenant Isolation Simulation", () => {
  it("settings saved on Device A appear on Device B after authentication", async () => {
    let databaseStore = {};

    const mockSql = async (strings, ...values) => {
      const query = strings.join("?");
      if (query.includes("SELECT")) {
        const row = databaseStore[101];
        return row ? [row] : [];
      }
      if (query.includes("INSERT INTO user_notification_preferences")) {
        // Emulate upsert
        const nextRev = (databaseStore[101]?.revision || 1) + 1;
        const saved = {
          theme: values[2],
          language: values[3],
          timezone: values[4],
          quiet_hours_enabled: values[5],
          quiet_hours_start: values[6],
          quiet_hours_end: values[7],
          enabled: values[8],
          notify_shift_assigned: values[9],
          notify_shift_updated: values[10],
          notify_swap_requested: values[11],
          notify_swap_approved: values[12],
          notify_swap_rejected: values[13],
          notify_swap_cancelled: values[14],
          revision: nextRev,
          updated_at: new Date().toISOString(),
        };
        databaseStore[101] = saved;
        return [saved];
      }
      return [];
    };

    // 1. Device A updates settings
    const deviceAReq = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        theme: "dark",
        language: "yo",
        timezone: "Africa/Lagos",
        expectedRevision: 1,
      }),
    });

    const deviceARes = await handleUpdateSettings(deviceAReq, {
      getSessionUser: async () => ({ userId: 101, teamId: 5 }),
      sql: mockSql,
    });
    assert.equal(deviceARes.status, 200);
    const deviceABody = await deviceARes.json();
    assert.equal(deviceABody.settings.theme, "dark");
    assert.equal(deviceABody.settings.language, "yo");
    assert.equal(deviceABody.settings.timezone, "Africa/Lagos");

    // 2. Device B authenticates as same user and loads settings
    const deviceBReq = new Request("http://localhost/api/settings", { method: "GET" });
    const deviceBRes = await handleGetSettings(deviceBReq, {
      getSessionUser: async () => ({ userId: 101, teamId: 5 }),
      sql: mockSql,
    });
    assert.equal(deviceBRes.status, 200);
    const deviceBBody = await deviceBRes.json();
    assert.equal(deviceBBody.settings.theme, "dark");
    assert.equal(deviceBBody.settings.language, "yo");
    assert.equal(deviceBBody.settings.timezone, "Africa/Lagos");
    assert.equal(deviceBBody.settings.revision, 2);
  });

  it("enforces strict user and workspace isolation between accounts on shared devices", () => {
    // Mock global window and localStorage
    const storage = new Map();
    const mockLocalStorage = {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
      clear: () => storage.clear(),
    };

    const originalWindow = global.window;
    const originalDocument = global.document;

    try {
      global.window = {
        localStorage: mockLocalStorage,
        matchMedia: () => ({ matches: false }),
      };

      global.document = {
        documentElement: {
          classList: {
            add: () => {},
            remove: () => {},
          },
          setAttribute: () => {},
          lang: "en",
        },
      };

      const user1Settings = {
        ...getDefaultUserSettings(1, 10),
        theme: "dark",
        language: "es",
        revision: 3,
      };

      // 1. User 1 saves settings to local cache
      saveSettingsToOfflineCache(user1Settings, { userId: 1, email: "user1@example.com", teamId: 10 });

      // 2. User 1 loads their own settings -> successful
      const user1Loaded = loadSettingsFromOfflineCache({ userId: 1, teamId: 10 });
      assert.notEqual(user1Loaded, null);
      assert.equal(user1Loaded.theme, "dark");
      assert.equal(user1Loaded.language, "es");

      // 3. User 2 logs into the same device -> cache must reject and clear previous user's data
      const user2Loaded = loadSettingsFromOfflineCache({ userId: 2, teamId: 10 });
      assert.equal(user2Loaded, null, "User 2 must never access User 1's cached settings");

      // Verify storage was invalidated
      assert.equal(mockLocalStorage.getItem(SETTINGS_OFFLINE_STORAGE_KEY), null);

      // 4. Logout purges all cached settings
      saveSettingsToOfflineCache(user1Settings, { userId: 1, email: "user1@example.com", teamId: 10 });
      clearSettingsOfflineCache();
      assert.equal(mockLocalStorage.getItem(SETTINGS_OFFLINE_STORAGE_KEY), null);
    } finally {
      global.window = originalWindow;
      global.document = originalDocument;
    }
  });

  it("applies theme and language correctly to the DOM documentElement", () => {
    let classes = [];
    let attributes = {};
    let currentLang = "";

    const mockDocument = {
      documentElement: {
        classList: {
          add: (c) => classes.push(c),
          remove: (c) => {
            classes = classes.filter((x) => x !== c);
          },
        },
        setAttribute: (k, v) => {
          attributes[k] = v;
        },
        set lang(val) {
          currentLang = val;
        },
        get lang() {
          return currentLang;
        },
      },
    };

    const originalDocument = global.document;
    const originalWindow = global.window;

    try {
      global.document = mockDocument;
      global.window = {
        matchMedia: () => ({ matches: false }),
      };

      // Test dark theme
      applyThemeToDocument("dark");
      assert.ok(classes.includes("dark"));
      assert.equal(attributes["data-theme"], "dark");

      // Test light theme
      applyThemeToDocument("light");
      assert.ok(!classes.includes("dark"));
      assert.equal(attributes["data-theme"], "light");

      // Test language application
      applyLanguageToDocument("fr");
      assert.equal(mockDocument.documentElement.lang, "fr");

      applyLanguageToDocument("yo");
      assert.equal(mockDocument.documentElement.lang, "yo");
    } finally {
      global.document = originalDocument;
      global.window = originalWindow;
    }
  });
});

