import { neon } from "@neondatabase/serverless";

function defaultNeonFactory(url: string) {
  return neon(url);
}

export type NeonClient = ReturnType<typeof defaultNeonFactory>;

export interface LazyNeonClientOptions {
  getDatabaseUrl?: () => string | undefined;
  neonFactory?: (url: string) => NeonClient;
}

/**
 * Creates a lazily initialized Neon SQL client.
 * The client is instantiated on the first query execution, preventing
 * build-time crashes when DATABASE_URL is not configured during static analysis.
 *
 * Custom options are intended strictly for internal testing and are rejected in production.
 */
export function createLazyNeonClient(options: LazyNeonClientOptions = {}): NeonClient {
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && (options.getDatabaseUrl || options.neonFactory)) {
    throw new Error("Custom database client options are not permitted in production.");
  }

  const getDatabaseUrl = options.getDatabaseUrl ?? (() => process.env.DATABASE_URL);
  const neonFactory = options.neonFactory ?? defaultNeonFactory;

  let cachedClient: NeonClient | null = null;

  function getClient(): NeonClient {
    if (cachedClient) {
      return cachedClient;
    }

    const databaseUrl = getDatabaseUrl();
    if (!databaseUrl || typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
      throw new Error("DATABASE_URL is not configured.");
    }

    cachedClient = neonFactory(databaseUrl.trim());
    return cachedClient;
  }

  return new Proxy((() => {}) as unknown as NeonClient, {
    apply(_target, _thisArg, args) {
      const client = getClient();
      return Reflect.apply(client, client, args);
    },
  });
}

export const sql: NeonClient = createLazyNeonClient();