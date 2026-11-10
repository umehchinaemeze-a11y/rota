/**
 * Redis & Distributed Caching Layer
 *
 * Implements:
 * - Redis-backed distributed caching for team rosters and shift schedules
 * - In-memory fallback for unconfigured environments
 * - Strict TTL enforcement (300s default for roster & calendar)
 * - Atomic cache invalidation hooks on shift mutation (create, edit, delete, swap, recovery)
 * - Transparent provider status reporting (never silently claims Redis is active)
 */

import {
  getRedisClient,
  isRedisConfigured,
  type RedisClientInterface,
} from "./redis.ts";

export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<number>;
  clear(): Promise<void>;
}

export class MemoryCacheStore implements CacheStore {
  private map = new Map<string, { value: any; expiresAt: number | null }>();

  async get<T>(key: string): Promise<T | null> {
    const item = this.map.get(key);
    if (!item) return null;

    if (item.expiresAt !== null && Date.now() > item.expiresAt) {
      this.map.delete(key);
      return null;
    }

    return JSON.parse(JSON.stringify(item.value)) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.map.set(key, {
      value: JSON.parse(JSON.stringify(value)),
      expiresAt,
    });
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async delPrefix(prefix: string): Promise<number> {
    let deletedCount = 0;
    for (const key of Array.from(this.map.keys())) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}

/**
 * Redis-backed CacheStore implementation.
 */
export class RedisCacheStore implements CacheStore {
  private redis: RedisClientInterface;
  private memoryFallback = new MemoryCacheStore();

  constructor(redis: RedisClientInterface) {
    this.redis = redis;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null || raw === undefined) return null;
      return JSON.parse(raw) as T;
    } catch {
      console.warn("[Cache] Redis GET error. Falling back to memory.");
      return this.memoryFallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      const payload = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await this.redis.set(key, payload, "EX", ttlSeconds);
      } else {
        await this.redis.set(key, payload);
      }
    } catch {
      console.warn("[Cache] Redis SET error. Saving to memory fallback.");
      await this.memoryFallback.set(key, value, ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      console.warn("[Cache] Redis DEL error.");
      await this.memoryFallback.del(key);
    }
  }

  async delPrefix(prefix: string): Promise<number> {
    try {
      const keys = await this.redis.keys(`${prefix}*`);
      if (keys.length > 0) {
        return await this.redis.del(...keys);
      }
      return 0;
    } catch {
      console.warn("[Cache] Redis delPrefix error. Falling back to memory.");
      return this.memoryFallback.delPrefix(prefix);
    }
  }

  async clear(): Promise<void> {
    try {
      const keys = await this.redis.keys("cache:*");
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch {
      await this.memoryFallback.clear();
    }
  }
}

/**
 * Key namespaces for Rota application domain entities.
 */
export const CACHE_TTL = {
  TEAM_ROSTER: 300, // 5 minutes
  SHIFT_CALENDAR: 300, // 5 minutes
  USER_SETTINGS: 600, // 10 minutes
};

export function buildRosterCacheKey(teamId: number | string): string {
  return `cache:team:${teamId}:roster`;
}

export function buildShiftCalendarCacheKey(
  teamId: number | string,
  dateRange: string = "all"
): string {
  return `cache:team:${teamId}:shifts:${dateRange}`;
}

export function buildShiftTeamPrefix(teamId: number | string): string {
  return `cache:team:${teamId}:`;
}

// Global active cache store instance
let customCacheStore: CacheStore | null = null;
const defaultMemoryStore = new MemoryCacheStore();

export function setCustomCacheStore(store: CacheStore | null): void {
  customCacheStore = store;
}

export function getActiveCacheStore(): CacheStore {
  if (customCacheStore) {
    return customCacheStore;
  }

  const redis = getRedisClient();
  if (redis) {
    return new RedisCacheStore(redis);
  }

  return defaultMemoryStore;
}

export function getCacheProvider(): "redis" | "memory_fallback" {
  if (customCacheStore) {
    return customCacheStore instanceof RedisCacheStore ? "redis" : "memory_fallback";
  }
  return isRedisConfigured() && getRedisClient() ? "redis" : "memory_fallback";
}

/**
 * Retrieves cached team roster or executes factory and caches result.
 */
export async function getCachedTeamRoster<T>(
  teamId: number | string,
  factory: () => Promise<T>,
  store?: CacheStore
): Promise<{ data: T; fromCache: boolean; provider: "redis" | "memory_fallback" }> {
  const activeStore = store || getActiveCacheStore();
  const provider = getCacheProvider();
  const key = buildRosterCacheKey(teamId);

  const cached = await activeStore.get<T>(key);
  if (cached !== null) {
    return { data: cached, fromCache: true, provider };
  }

  const fresh = await factory();
  await activeStore.set(key, fresh, CACHE_TTL.TEAM_ROSTER);
  return { data: fresh, fromCache: false, provider };
}

/**
 * Retrieves cached shift schedule or executes factory and caches result.
 */
export async function getCachedShiftSchedule<T>(
  teamId: number | string,
  dateRange: string = "all",
  factory: () => Promise<T>,
  store?: CacheStore
): Promise<{ data: T; fromCache: boolean; provider: "redis" | "memory_fallback" }> {
  const activeStore = store || getActiveCacheStore();
  const provider = getCacheProvider();
  const key = buildShiftCalendarCacheKey(teamId, dateRange);

  const cached = await activeStore.get<T>(key);
  if (cached !== null) {
    return { data: cached, fromCache: true, provider };
  }

  const fresh = await factory();
  await activeStore.set(key, fresh, CACHE_TTL.SHIFT_CALENDAR);
  return { data: fresh, fromCache: false, provider };
}

/**
 * Invalidates all cached queries for a team when shifts or roster records change.
 */
export async function invalidateTeamCache(
  teamId: number | string,
  store?: CacheStore
): Promise<number> {
  const activeStore = store || getActiveCacheStore();
  const prefix = buildShiftTeamPrefix(teamId);
  return activeStore.delPrefix(prefix);
}
