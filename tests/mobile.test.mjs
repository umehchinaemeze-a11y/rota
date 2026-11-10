import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  setSecureStorageBackend,
  saveAuthTokens,
  getAccessToken,
  getRefreshToken,
  clearAuthTokens,
} from "../../mobile/lib/secure-store.ts";
import { parseDeepLink } from "../../mobile/lib/deep-links.ts";

describe("Mobile Expo SecureStore Token Lifecycle", () => {
  let mockStore = new Map();

  beforeEach(() => {
    mockStore.clear();
    setSecureStorageBackend({
      getItemAsync: async (k) => mockStore.get(k) || null,
      setItemAsync: async (k, v) => {
        mockStore.set(k, v);
      },
      deleteItemAsync: async (k) => {
        mockStore.delete(k);
      },
    });
  });

  it("stores and retrieves access and refresh tokens in encrypted storage", async () => {
    await saveAuthTokens({
      accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-access-token",
      refreshToken: "sess_101.test-refresh-secret-12345",
    });

    const accessToken = await getAccessToken();
    const refreshToken = await getRefreshToken();

    assert.equal(accessToken, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-access-token");
    assert.equal(refreshToken, "sess_101.test-refresh-secret-12345");
  });

  it("purges all tokens on logout", async () => {
    await saveAuthTokens({
      accessToken: "access-token-to-delete",
      refreshToken: "refresh-token-to-delete",
    });

    assert.ok(await getAccessToken());
    assert.ok(await getRefreshToken());

    await clearAuthTokens();

    assert.equal(await getAccessToken(), null);
    assert.equal(await getRefreshToken(), null);
  });
});

describe("Mobile Deep Link & Universal Link Parsing", () => {
  it("parses custom scheme shift links (rota://shift/:id)", () => {
    const parsed = parseDeepLink("rota://shift/456");
    assert.equal(parsed.type, "shift");
    if (parsed.type === "shift") {
      assert.equal(parsed.shiftId, 456);
    }
  });

  it("parses custom scheme invite links (rota://invite/:token)", () => {
    const parsed = parseDeepLink("rota://invite/sec-token-xyz-99");
    assert.equal(parsed.type, "invite");
    if (parsed.type === "invite") {
      assert.equal(parsed.inviteToken, "sec-token-xyz-99");
    }
  });

  it("parses universal web links for invitations", () => {
    const parsed = parseDeepLink("https://rota-lovat-gamma.vercel.app/invite/token-team-join-abc");
    assert.equal(parsed.type, "invite");
    if (parsed.type === "invite") {
      assert.equal(parsed.inviteToken, "token-team-join-abc");
    }
  });

  it("parses universal web links with query parameters for shifts and tabs", () => {
    const shiftLink = parseDeepLink("https://rota-lovat-gamma.vercel.app/?tab=Schedule&shiftId=88");
    assert.equal(shiftLink.type, "shift");
    if (shiftLink.type === "shift") {
      assert.equal(shiftLink.shiftId, 88);
    }

    const tabLink = parseDeepLink("https://rota-lovat-gamma.vercel.app/?tab=Settings");
    assert.equal(tabLink.type, "tab");
    if (tabLink.type === "tab") {
      assert.equal(tabLink.tab, "Settings");
    }
  });

  it("handles unknown or malformed URLs gracefully", () => {
    const malformed = parseDeepLink("not-a-valid-link");
    assert.equal(malformed.type, "unknown");

    const empty = parseDeepLink(null);
    assert.equal(empty.type, "unknown");
  });
});

