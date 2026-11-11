import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  buildGoogleAuthorizationUrl,
  getGoogleConfig,
  isGoogleAuthAvailable,
  validateGoogleIdTokenClaims,
} from "../lib/oauth/google.ts";
import {
  OAUTH_STATE_COOKIE_NAME,
  createOAuthStateMaterial,
  createPkceChallenge,
  hashOAuthState,
  insertOAuthTransaction,
  consumeOAuthTransaction,
} from "../lib/oauth/transactions.ts";
import {
  clearOAuthStateCookie,
  readOAuthStateCookie,
  serializeOAuthStateCookie,
} from "../lib/oauth/cookies.ts";
import {
  isSameOriginRequest,
  sanitizeRedirectPath,
} from "../lib/oauth/safe-redirect.ts";
import {
  createGoogleUserAndIdentity,
  isUniqueViolation,
  linkGoogleIdentity,
} from "../lib/oauth/users.ts";
import { hashPassword, verifySessionToken } from "../lib/auth.ts";
import {
  AUTH_METHOD_FUNCTION_DDL,
  MIGRATION_DDL,
  MIGRATION_STATEMENTS,
  executeGoogleAuthMigration,
} from "../scripts/migrate-google-auth.mjs";
import { handleGoogleStart } from "../app/api/auth/google/start/route.ts";
import { handleGoogleCallback } from "../app/api/auth/google/callback/route.ts";
import { handleGoogleLink } from "../app/api/auth/google/link/route.ts";
import { handleGoogleUnlink } from "../app/api/auth/google/unlink/route.ts";
import { handleLogin } from "../app/api/auth/login/route.ts";

const TEST_SECRET = "test_auth_secret_0123456789abcdef0123456789abcdef";

const testConfig = {
  clientId: "google-client-id.apps.googleusercontent.com",
  clientSecret: "google-client-secret",
  redirectUri: "http://localhost/api/auth/google/callback",
};

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}

function findCookie(cookies, name) {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`)) || "";
}

function makeSql(handler) {
  return async (strings, ...values) => {
    const query = strings.join("?");
    return handler(query, values);
  };
}

function makeCallbackRequest(state = "state-value") {
  return new Request(
    `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
    {
      headers: {
        cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}`,
      },
    }
  );
}

function makeTransaction(overrides = {}) {
  return {
    id: 1,
    nonce: "expected-nonce",
    code_verifier: "expected-verifier",
    purpose: "login",
    user_id: null,
    redirect_after: "/",
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function makeCallbackDeps(sql, overrides = {}) {
  return {
    sql,
    getConfig: () => testConfig,
    consumeTransaction: async () => overrides.transaction ?? makeTransaction(),
    exchangeCode: async (_config, code, verifier) => {
      assert.equal(code, "auth-code");
      assert.equal(verifier, "expected-verifier");
      return "signed-id-token";
    },
    verifyIdToken: async (_token, options) => {
      assert.equal(options.nonce, "expected-nonce");
      return {
        subject: "google-subject-1",
        email: "ava@example.com",
        name: "Ava Stone",
        emailVerified: true,
      };
    },
    getSecret: () => TEST_SECRET,
    ...overrides,
  };
}

describe("Google OAuth configuration and authorization URL", () => {
  it("requires client credentials and a redirect URI", () => {
    assert.throws(() => getGoogleConfig({}), /not configured/);
    assert.throws(
      () => getGoogleConfig({ GOOGLE_CLIENT_ID: "id" }),
      /not configured/
    );
  });

  it("uses GOOGLE_REDIRECT_URI before the app URL fallback", () => {
    const config = getGoogleConfig({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "https://example.com/callback",
      NEXT_PUBLIC_APP_URL: "https://ignored.example.com",
    });

    assert.equal(config.redirectUri, "https://example.com/callback");
  });

  it("resolves VERCEL_PROJECT_PRODUCTION_URL fallback redirect URI when NEXT_PUBLIC_APP_URL is absent", () => {
    const config = getGoogleConfig({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      VERCEL_PROJECT_PRODUCTION_URL: "rota-lovat-gamma.vercel.app",
    });

    assert.equal(config.redirectUri, "https://rota-lovat-gamma.vercel.app/api/auth/google/callback");
  });

  it("resolves canonical production redirect URI when NODE_ENV is production without explicit URL", () => {
    const config = getGoogleConfig({
      NODE_ENV: "production",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });

    assert.equal(config.redirectUri, "https://rota-lovat-gamma.vercel.app/api/auth/google/callback");
  });

  it("detects whether Google auth is available gracefully without throwing", () => {
    assert.equal(isGoogleAuthAvailable({}), false);
    assert.equal(isGoogleAuthAvailable({ GOOGLE_CLIENT_ID: "id" }), false);
    assert.equal(
      isGoogleAuthAvailable({
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REDIRECT_URI: "https://example.com/callback",
      }),
      true
    );
  });

  it("builds an authorization URL with PKCE S256, state, nonce, and openid scopes", () => {
    const url = new URL(
      buildGoogleAuthorizationUrl(testConfig, {
        state: "state-1",
        nonce: "nonce-1",
        codeChallenge: "challenge-1",
      })
    );

    assert.equal(url.origin + url.pathname, GOOGLE_AUTHORIZATION_ENDPOINT);
    assert.equal(url.searchParams.get("client_id"), testConfig.clientId);
    assert.equal(url.searchParams.get("redirect_uri"), testConfig.redirectUri);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "openid email profile");
    assert.equal(url.searchParams.get("state"), "state-1");
    assert.equal(url.searchParams.get("nonce"), "nonce-1");
    assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("prompt"), "select_account");
  });
});

describe("Google ID token claim validation", () => {
  const validClaims = {
    sub: "subject-123",
    nonce: "expected-nonce",
    email: "  Ava@Example.COM  ",
    email_verified: true,
    name: "  Ava   Stone ",
    azp: testConfig.clientId,
  };

  it("returns only normalized identity fields required by Rota", () => {
    const identity = validateGoogleIdTokenClaims(
      validClaims,
      "expected-nonce",
      testConfig.clientId
    );

    assert.deepEqual(identity, {
      subject: "subject-123",
      email: "ava@example.com",
      name: "Ava Stone",
      emailVerified: true,
    });
  });

  it("rejects nonce mismatch, unverified email, and wrong authorized party", () => {
    assert.throws(
      () => validateGoogleIdTokenClaims(validClaims, "other-nonce", testConfig.clientId),
      /nonce mismatch/
    );
    assert.throws(
      () =>
        validateGoogleIdTokenClaims(
          { ...validClaims, email_verified: false },
          "expected-nonce",
          testConfig.clientId
        ),
      /not verified/
    );
    assert.throws(
      () =>
        validateGoogleIdTokenClaims(
          { ...validClaims, azp: "other-client" },
          "expected-nonce",
          testConfig.clientId
        ),
      /authorized party/
    );
  });

  it("rejects invalid subjects and malformed email addresses", () => {
    assert.throws(
      () =>
        validateGoogleIdTokenClaims(
          { ...validClaims, sub: "" },
          "expected-nonce",
          testConfig.clientId
        ),
      /valid subject/
    );
    assert.throws(
      () =>
        validateGoogleIdTokenClaims(
          { ...validClaims, email: "not-an-email" },
          "expected-nonce",
          testConfig.clientId
        ),
      /invalid email/
    );
  });
});

describe("OAuth redirect and cookie safety", () => {
  it("accepts relative redirects and rejects external or ambiguous paths", () => {
    assert.equal(sanitizeRedirectPath("/settings?tab=a#top"), "/settings?tab=a#top");
    assert.equal(sanitizeRedirectPath("https://evil.example"), "/");
    assert.equal(sanitizeRedirectPath("//evil.example"), "/");
    assert.equal(sanitizeRedirectPath("/\\evil.example"), "/");
    assert.equal(sanitizeRedirectPath("javascript:alert(1)"), "/");
    assert.equal(sanitizeRedirectPath(`/${"a".repeat(501)}`), "/");
  });

  it("checks request origin while allowing non-browser requests without Origin", () => {
    const same = new Request("http://localhost/api/auth/google/link", {
      headers: { origin: "http://localhost" },
    });
    const cross = new Request("http://localhost/api/auth/google/link", {
      headers: { origin: "https://evil.example" },
    });
    const noOrigin = new Request("http://localhost/api/auth/google/link");

    assert.equal(isSameOriginRequest(same), true);
    assert.equal(isSameOriginRequest(cross), false);
    assert.equal(isSameOriginRequest(noOrigin), true);
  });

  it("serializes and clears an HttpOnly OAuth state cookie scoped to Google routes", () => {
    const request = new Request("http://localhost/api/auth/google/start");
    const serialized = serializeOAuthStateCookie("state-token", request);

    assert.match(serialized, /^rota_oauth_state=state-token;/);
    assert.match(serialized, /Path=\/api\/auth\/google;/);
    assert.match(serialized, /Max-Age=600;/);
    assert.match(serialized, /HttpOnly/);
    assert.match(serialized, /SameSite=Lax/);
    assert.doesNotMatch(serialized, /Secure/);

    const parsed = readOAuthStateCookie(
      new Request("http://localhost/", {
        headers: { cookie: "other=1; rota_oauth_state=state-token" },
      })
    );
    assert.equal(parsed, "state-token");
    assert.match(clearOAuthStateCookie(request), /Max-Age=0/);
  });
});

describe("OAuth transaction persistence", () => {
  it("creates unique state, nonce, verifier, and a SHA-256 PKCE challenge", () => {
    const first = createOAuthStateMaterial();
    const second = createOAuthStateMaterial();

    assert.notEqual(first.state, second.state);
    assert.notEqual(first.nonce, second.nonce);
    assert.notEqual(first.codeVerifier, second.codeVerifier);
    assert.equal(first.codeChallenge, createPkceChallenge(first.codeVerifier));
    assert.notEqual(first.codeChallenge, first.codeVerifier);
  });

  it("stores only the SHA-256 state hash, never the raw state", async () => {
    let captured;
    const executeSql = makeSql((query, values) => {
      if (query.includes("INSERT INTO oauth_transactions")) {
        captured = { query, values };
      }
      return [];
    });

    await insertOAuthTransaction(
      {
        state: "raw-state",
        nonce: "nonce",
        codeVerifier: "verifier",
        purpose: "login",
        redirectAfter: "/",
      },
      executeSql
    );

    assert.ok(captured.query.includes("INSERT INTO oauth_transactions"));
    assert.equal(captured.values[0], hashOAuthState("raw-state"));
    assert.match(captured.values[0], /^[a-f0-9]{64}$/);
    assert.notEqual(captured.values[0], "raw-state");
    assert.equal(captured.values[3], "login");
  });

  it("consumes a transaction once using an atomic update predicate", async () => {
    let captured;
    const executeSql = makeSql((query, values) => {
      captured = { query, values };
      return [{ id: 1, purpose: "login" }];
    });

    const result = await consumeOAuthTransaction("raw-state", executeSql);
    assert.equal(result.id, 1);
    assert.match(captured.query, /consumed_at = NOW\(\)/);
    assert.match(captured.query, /consumed_at IS NULL/);
    assert.match(captured.query, /expires_at > NOW\(\)/);
    assert.equal(captured.values[0], hashOAuthState("raw-state"));
  });

  it("rejects missing or empty state before querying the database", async () => {
    let called = false;
    const executeSql = async () => {
      called = true;
      return [];
    };

    assert.equal(await consumeOAuthTransaction("", executeSql), null);
    assert.equal(await consumeOAuthTransaction(null, executeSql), null);
    assert.equal(called, false);
  });
});

describe("Google identity persistence helpers", () => {
  it("detects only PostgreSQL unique violations", () => {
    assert.equal(isUniqueViolation({ code: "23505" }), true);
    assert.equal(isUniqueViolation({ code: "23503" }), false);
    assert.equal(isUniqueViolation(null), false);
  });

  it("creates new Google users with null passwords and the Front Desk role", async () => {
    let captured;
    const executeSql = makeSql((query) => {
      captured = query;
      return [{ id: 9, email: "new@example.com", name: "New User", role: "Front Desk" }];
    });

    const user = await createGoogleUserAndIdentity(
      {
        subject: "subject-9",
        email: "new@example.com",
        name: "New User",
        emailVerified: true,
      },
      executeSql
    );

    assert.equal(user.id, 9);
    assert.match(captured, /'Front Desk'/);
    assert.match(captured, /NULL, NULL/);
  });

  it("returns precise link outcomes for linked, already linked, and conflicting identities", async () => {
    const linked = await linkGoogleIdentity(
      1,
      { subject: "s", email: "a@example.com", name: "A", emailVerified: true },
      makeSql(() => [{ subject_user_id: null, user_identity_id: null, inserted_id: 5 }])
    );
    assert.deepEqual(linked, { status: "linked" });

    const already = await linkGoogleIdentity(
      1,
      { subject: "s", email: "a@example.com", name: "A", emailVerified: true },
      makeSql(() => [{ subject_user_id: null, user_identity_id: 3, inserted_id: null }])
    );
    assert.deepEqual(already, { status: "already_linked" });

    const conflict = await linkGoogleIdentity(
      1,
      { subject: "s", email: "a@example.com", name: "A", emailVerified: true },
      makeSql(() => [{ subject_user_id: 2, user_identity_id: null, inserted_id: null }])
    );
    assert.deepEqual(conflict, { status: "linked_to_another_user", userId: 2 });
  });
});

describe("Google auth schema migration", () => {
  it("keeps nullable password fields, identity uniqueness, and deferred auth invariants", () => {
    assert.match(MIGRATION_DDL, /ALTER COLUMN password_hash DROP NOT NULL/);
    assert.match(MIGRATION_DDL, /ALTER COLUMN password_salt DROP NOT NULL/);
    assert.match(MIGRATION_DDL, /UNIQUE \(provider, provider_subject\)/);
    assert.match(MIGRATION_DDL, /UNIQUE \(user_id, provider\)/);
    assert.match(MIGRATION_DDL, /DEFERRABLE INITIALLY DEFERRED/);
    assert.match(AUTH_METHOD_FUNCTION_DDL, /ELSIF TG_OP = 'DELETE'/);
    assert.doesNotMatch(AUTH_METHOD_FUNCTION_DDL, /COALESCE\(NEW\.user_id/);
  });

  it("runs preflight checks and all DDL inside a guarded transaction", async () => {
    const calls = [];
    const client = {
      query: async (query) => {
        calls.push(query);
        if (query.includes("to_regclass")) {
          return { rows: [{ users_table: "users", memberships_table: "team_memberships" }] };
        }
        if (query.includes("invalid_count")) {
          return { rows: [{ invalid_count: 0 }] };
        }
        return { rows: [] };
      },
      end: async () => {},
    };

    const result = await executeGoogleAuthMigration(client);
    assert.equal(result.success, true);
    assert.ok(calls.includes("BEGIN;"));
    for (const statement of MIGRATION_STATEMENTS) {
      assert.ok(calls.includes(statement), "Every migration statement must execute");
    }
    assert.ok(calls.includes("COMMIT;"));
    assert.equal(calls.includes("ROLLBACK;"), false);
  });

  it("aborts before BEGIN when existing users lack password credentials", async () => {
    const calls = [];
    const client = {
      query: async (query) => {
        calls.push(query);
        if (query.includes("to_regclass")) {
          return { rows: [{ users_table: "users", memberships_table: "team_memberships" }] };
        }
        if (query.includes("invalid_count")) {
          return { rows: [{ invalid_count: 2 }] };
        }
        return { rows: [] };
      },
      end: async () => {},
    };

    await assert.rejects(
      () => executeGoogleAuthMigration(client),
      /2 existing user/
    );
    assert.equal(calls.includes("BEGIN;"), false);
  });

  it("rolls back if applying the migration fails", async () => {
    const calls = [];
    const client = {
      query: async (query) => {
        calls.push(query);
        if (query.includes("to_regclass")) {
          return { rows: [{ users_table: "users", memberships_table: "team_memberships" }] };
        }
        if (query.includes("invalid_count")) {
          return { rows: [{ invalid_count: 0 }] };
        }
        if (query === MIGRATION_STATEMENTS[2]) {
          throw new Error("DDL failed");
        }
        return { rows: [] };
      },
      end: async () => {},
    };

    await assert.rejects(() => executeGoogleAuthMigration(client), /DDL failed/);
    assert.ok(calls.includes("ROLLBACK;"));
  });
});

describe("Google start route", () => {
  it("stores a login transaction and redirects to Google with a state cookie", async () => {
    let inserted;
    const request = new Request(
      "http://localhost/api/auth/google/start?redirect=https://evil.example"
    );

    const response = await handleGoogleStart(request, {
      getConfig: () => testConfig,
      insertTransaction: async (params) => {
        inserted = params;
      },
    });

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin + location.pathname, GOOGLE_AUTHORIZATION_ENDPOINT);
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.equal(inserted.purpose, "login");
    assert.equal(inserted.redirectAfter, "/");

    const cookies = getSetCookies(response);
    const stateCookie = findCookie(cookies, OAUTH_STATE_COOKIE_NAME);
    assert.ok(stateCookie.includes(inserted.state));
    assert.match(stateCookie, /HttpOnly/);
  });

  it("fails closed when Google is not configured", async () => {
    const response = await handleGoogleStart(
      new Request("http://localhost/api/auth/google/start"),
      {
        getConfig: () => {
          throw new Error("missing");
        },
        insertTransaction: async () => {},
      }
    );

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "http://localhost/sign-in?error=google_unavailable"
    );
  });
});

describe("Google callback route", () => {
  it("signs in an existing Google identity without creating a duplicate user", async () => {
    let createdUser = false;
    const sql = makeSql((query) => {
      if (query.includes("JOIN user_identities")) {
        return [{ id: 7, email: "ava@example.com", name: "Ava Stone", role: "Front Desk" }];
      }
      if (query.includes("WITH new_user")) {
        createdUser = true;
      }
      if (query.includes("UPDATE user_identities")) {
        return [];
      }
      return [];
    });

    const response = await handleGoogleCallback(
      makeCallbackRequest(),
      makeCallbackDeps(sql)
    );

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "http://localhost/");
    assert.equal(createdUser, false);

    const cookies = getSetCookies(response);
    assert.ok(findCookie(cookies, OAUTH_STATE_COOKIE_NAME).includes("Max-Age=0"));
    const sessionCookie = findCookie(cookies, "rota_session");
    assert.ok(sessionCookie);

    const token = sessionCookie.split(";")[0].slice("rota_session=".length);
    const payload = verifySessionToken(token, TEST_SECRET);
    assert.equal(payload.userId, 7);
    assert.equal(payload.role, "Front Desk");
  });

  it("creates a new Google user with Front Desk role when no identity or email exists", async () => {
    let created = false;
    const sql = makeSql((query) => {
      if (query.includes("JOIN user_identities")) {
        return [];
      }
      if (query.includes("LOWER(TRIM(email))")) {
        return [];
      }
      if (query.includes("WITH new_user")) {
        created = true;
        return [{ id: 12, email: "ava@example.com", name: "Ava Stone", role: "Front Desk" }];
      }
      return [];
    });

    const response = await handleGoogleCallback(
      makeCallbackRequest(),
      makeCallbackDeps(sql)
    );

    assert.equal(created, true);
    assert.equal(response.headers.get("location"), "http://localhost/");
    assert.ok(findCookie(getSetCookies(response), "rota_session"));
  });

  it("requires password sign-in and explicit linking when the email already exists", async () => {
    const sql = makeSql((query) => {
      if (query.includes("JOIN user_identities")) {
        return [];
      }
      if (query.includes("LOWER(TRIM(email))")) {
        return [{ id: 22, email: "ava@example.com", name: "Ava Stone", role: "Staff" }];
      }
      return [];
    });

    const response = await handleGoogleCallback(
      makeCallbackRequest(),
      makeCallbackDeps(sql)
    );

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "http://localhost/sign-in?error=google_link_required"
    );
    assert.equal(
      findCookie(getSetCookies(response), "rota_session"),
      "",
      "No session may be issued without authentication"
    );
  });

  it("links a Google identity only to the user bound to the transaction", async () => {
    let capturedValues;
    const sql = makeSql((query, values) => {
      if (query.includes("WITH existing_subject")) {
        capturedValues = values;
        return [{ subject_user_id: null, user_identity_id: null, inserted_id: 3 }];
      }
      return [];
    });

    const response = await handleGoogleCallback(
      makeCallbackRequest(),
      makeCallbackDeps(sql, {
        transaction: makeTransaction({ purpose: "link", user_id: 42 }),
        getSessionUser: async () => ({ userId: 42, role: "Front Desk" }),
      })
    );

    assert.equal(capturedValues[1], 42);
    assert.equal(capturedValues[2], 42);
    assert.equal(
      response.headers.get("location"),
      "http://localhost/?google=linked"
    );
    assert.equal(findCookie(getSetCookies(response), "rota_session"), "");
  });

  it("rejects linking a Google identity already owned by another user", async () => {
    const sql = makeSql((query) => {
      if (query.includes("WITH existing_subject")) {
        return [{ subject_user_id: 99, user_identity_id: null, inserted_id: null }];
      }
      return [];
    });

    const response = await handleGoogleCallback(
      makeCallbackRequest(),
      makeCallbackDeps(sql, {
        transaction: makeTransaction({ purpose: "link", user_id: 42 }),
        getSessionUser: async () => ({ userId: 42, role: "Front Desk" }),
      })
    );

    assert.equal(
      response.headers.get("location"),
      "http://localhost/?google_error=link_conflict"
    );
  });

  it("clears state and fails closed when the state cookie does not match", async () => {
    let exchanged = false;
    const request = new Request(
      "http://localhost/api/auth/google/callback?code=auth-code&state=returned",
      { headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=cookie` } }
    );

    const response = await handleGoogleCallback(
      request,
      makeCallbackDeps(makeSql(() => []), {
        exchangeCode: async () => {
          exchanged = true;
          return "";
        },
      })
    );

    assert.equal(exchanged, false);
    assert.equal(
      response.headers.get("location"),
      "http://localhost/sign-in?error=google_failed"
    );
    assert.match(
      findCookie(getSetCookies(response), OAUTH_STATE_COOKIE_NAME),
      /Max-Age=0/
    );
  });

  it("treats a Google cancellation as a safe sign-in error", async () => {
    const response = await handleGoogleCallback(
      new Request("http://localhost/api/auth/google/callback?error=access_denied"),
      makeCallbackDeps(makeSql(() => []))
    );

    assert.equal(
      response.headers.get("location"),
      "http://localhost/sign-in?error=google_cancelled"
    );
  });
});

describe("Google link and unlink routes", () => {
  const passwordData = hashPassword("correct-password");

  function makeLinkRequest(body, headers = {}) {
    return new Request("http://localhost/api/auth/google/link", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  function makeUnlinkRequest(body, headers = {}) {
    return new Request("http://localhost/api/auth/google/unlink", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  function makePasswordUser(overrides = {}) {
    return {
      id: 5,
      email: "user@example.com",
      name: "User",
      role: "Front Desk",
      password_hash: passwordData.hash,
      password_salt: passwordData.salt,
      ...overrides,
    };
  }

  it("rejects cross-origin and non-JSON link requests", async () => {
    const crossOrigin = await handleGoogleLink(
      makeLinkRequest({ password: "correct-password" }, { origin: "https://evil.example" }),
      {
        getSessionUser: async () => ({ userId: 5 }),
        sql: makeSql(() => []),
        getConfig: () => testConfig,
      }
    );
    assert.equal(crossOrigin.status, 403);

    const wrongType = await handleGoogleLink(
      new Request("http://localhost/api/auth/google/link", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "text/plain" },
        body: JSON.stringify({ password: "correct-password" }),
      }),
      {
        getSessionUser: async () => ({ userId: 5 }),
        sql: makeSql(() => []),
        getConfig: () => testConfig,
      }
    );
    assert.equal(wrongType.status, 415);
  });

  it("requires an authenticated session and password re-authentication", async () => {
    const unauthenticated = await handleGoogleLink(
      makeLinkRequest({ password: "correct-password" }),
      {
        getSessionUser: async () => null,
        sql: makeSql(() => []),
        getConfig: () => testConfig,
      }
    );
    assert.equal(unauthenticated.status, 401);

    const wrongPassword = await handleGoogleLink(
      makeLinkRequest({ password: "wrong-password" }),
      {
        getSessionUser: async () => ({ userId: 5 }),
        sql: makeSql(() => [makePasswordUser()]),
        getConfig: () => testConfig,
      }
    );
    assert.equal(wrongPassword.status, 400);
    assert.match((await wrongPassword.json()).error, /verify your password/);
  });

  it("starts a link transaction bound to the current user and returns a Google URL", async () => {
    let inserted;
    const response = await handleGoogleLink(
      makeLinkRequest({ password: "correct-password", redirect: "/settings" }),
      {
        getSessionUser: async () => ({ userId: 5 }),
        sql: makeSql(() => [makePasswordUser()]),
        getConfig: () => testConfig,
        insertTransaction: async (params) => {
          inserted = params;
        },
      }
    );

    assert.equal(response.status, 200);
    const data = await response.json();
    const url = new URL(data.authorizationUrl);
    assert.equal(url.origin + url.pathname, GOOGLE_AUTHORIZATION_ENDPOINT);
    assert.equal(inserted.purpose, "link");
    assert.equal(inserted.userId, 5);
    assert.equal(inserted.redirectAfter, "/settings");
    assert.ok(findCookie(getSetCookies(response), OAUTH_STATE_COOKIE_NAME));
  });

  it("prevents unlinking Google when no password exists", async () => {
    const response = await handleGoogleUnlink(
      makeUnlinkRequest({ password: "correct-password" }),
      {
        getSessionUser: async () => ({ userId: 5 }),
        sql: makeSql(() => [
          makePasswordUser({ password_hash: null, password_salt: null }),
        ]),
      }
    );

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /only sign-in method/);
  });

  it("rejects a wrong password before unlinking Google", async () => {
    const response = await handleGoogleUnlink(
      makeUnlinkRequest({ password: "wrong-password" }),
      {
        getSessionUser: async () => ({ userId: 5 }),
        sql: makeSql(() => [makePasswordUser()]),
      }
    );

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /verify your password/);
  });

  it("unlinks only the current user's Google identity after re-authentication", async () => {
    let deleteCalled = false;
    const sql = makeSql((query) => {
      if (query.includes("DELETE FROM user_identities")) {
        deleteCalled = true;
        return [{ id: 3 }];
      }
      return [makePasswordUser()];
    });

    const response = await handleGoogleUnlink(
      makeUnlinkRequest({ password: "correct-password" }),
      {
        getSessionUser: async () => ({ userId: 5 }),
        sql,
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.equal(deleteCalled, true);
  });
});

describe("Password login remains closed for Google-only accounts", () => {
  it("returns a generic invalid-credentials response when the user has no password", async () => {
    const response = await handleLogin(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "google-only@example.com",
          password: "anything",
        }),
      }),
      {
        getSecret: () => TEST_SECRET,
        sql: async () => [
          {
            id: 30,
            email: "google-only@example.com",
            password_hash: null,
            password_salt: null,
            name: "Google Only",
            role: "Front Desk",
          },
        ],
      }
    );

    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Invalid email or password.");
  });
});
