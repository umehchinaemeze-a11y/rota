import crypto from "node:crypto";
import {
  getRedisClient,
  isRedisConfigured,
  type RedisClientInterface,
} from "./redis.ts";

/**
 * Redis-Backed Sliding-Window Rate Limiter
 *
 * Enforces atomic sliding-window rate limiting across application instances:
 * - Login (/api/auth/login)
 * - Registration (/api/auth/register)
 * - Forgot Password (/api/auth/forgot-password)
 * - Reset Password (/api/auth/reset-password)
 * - Invitations Creation & Acceptance (/api/teams/invitations)
 * - Paystack Payment Initialize (/api/billing/paystack/initialize)
 *
 * Guarantees:
 * 1. Distributed synchronization: State is shared across instances in Redis.
 * 2. Atomic Lua execution: Eliminates race conditions between checking quota and incrementing.
 * 3. Safe fallback: If Redis is unavailable or unconfigured, falls back to local memory limiting with explicit logging.
 * 4. Transparent telemetry: HTTP headers report exact limits, remaining quota, reset time, and active storage engine.
 */

export interface RateLimitOptions {
  action: string;
  limit: number;
  windowSeconds: number;
  identifier?: string;
  redisClient?: RedisClientInterface | null;
  failClosedOnRedisError?: boolean;
  isProduction?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  currentCount: number;
  storage: "redis" | "memory_fallback" | "unavailable";
  serviceUnavailable?: boolean;
}

/**
 * Sensitive endpoints that must enforce distributed rate limiting in production.
 * If Redis is unavailable or unconfigured when NODE_ENV=production, requests to
 * these endpoints fail closed with HTTP 503 rather than silently using per-instance memory.
 */
export const PROTECTED_SENSITIVE_ACTIONS = new Set<string>([
  "login",
  "register",
  "forgot-password",
  "reset-password",
  "create-invitation",
  "accept-invitation",
  "billing-initialize",
]);

export function isSensitiveProtectedAction(action: string): boolean {
  return PROTECTED_SENSITIVE_ACTIONS.has(action);
}

/**
 * Controlled HTTP 503 response for protected endpoints when distributed rate limiting
 * cannot be enforced in production. Never leaks connection details, URLs, or credentials.
 */
export function createServiceUnavailableResponse(retryAfterSeconds = 30): Response {
  return Response.json(
    {
      error: "Service Unavailable",
      message:
        "Rate limiting service is temporarily unavailable. Please try again shortly.",
    },
    {
      status: 503,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Storage": "unavailable",
      },
    }
  );
}

// In-memory sliding-window backup store: Map<Key, Array<timestampMs>>
const fallbackMemoryStore = new Map<string, number[]>();

/**
 * Resets rate limit counters (used in automated tests).
 */
export function resetRateLimits(
  keyPrefix?: string,
  client?: RedisClientInterface | null
): Promise<void> | void {
  // Clear in-memory fallback synchronously
  if (!keyPrefix) {
    fallbackMemoryStore.clear();
  } else {
    for (const key of fallbackMemoryStore.keys()) {
      if (key.startsWith(keyPrefix)) {
        fallbackMemoryStore.delete(key);
      }
    }
  }

  // Clear Redis if connected
  const redis = client !== undefined ? client : getRedisClient();
  if (redis) {
    return (async () => {
      try {
        const pattern = keyPrefix ? `${keyPrefix}*` : "ratelimit:*";
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } catch {
        // Ignore cleanup error in test
      }
    })();
  }
}

/**
 * Resolves the client IP address from standard reverse-proxy headers.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp && realIp.trim()) {
    return realIp.trim();
  }

  return "127.0.0.1";
}

// Lua script for atomic sliding-window rate limiting in Redis
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local windowSec = tonumber(ARGV[4])
local member = ARGV[5]

local threshold = now - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', threshold)
local currentCount = redis.call('ZCARD', key)

if currentCount >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestTime = now
  if oldest and #oldest >= 2 then
    oldestTime = tonumber(oldest[2])
  end
  local resetMs = math.max(1000, (oldestTime + windowMs) - now)
  local resetSec = math.ceil(resetMs / 1000)
  return { 0, currentCount, resetSec }
end

redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, windowSec + 1)

local newCount = currentCount + 1
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestTime = now
if oldest and #oldest >= 2 then
  oldestTime = tonumber(oldest[2])
end
local resetMs = math.max(1000, (oldestTime + windowMs) - now)
local resetSec = math.ceil(resetMs / 1000)

return { 1, newCount, resetSec }
`;

/**
 * Internal helper: executes sliding window in memory fallback.
 */
function checkRateLimitMemory(
  key: string,
  limit: number,
  windowSeconds: number,
  nowMs: number
): RateLimitResult {
  const windowMs = windowSeconds * 1000;
  const threshold = nowMs - windowMs;

  let timestamps = fallbackMemoryStore.get(key) || [];
  timestamps = timestamps.filter((t) => t > threshold);

  if (timestamps.length >= limit) {
    const oldest = timestamps[0] || nowMs;
    const resetSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    fallbackMemoryStore.set(key, timestamps);

    return {
      allowed: false,
      limit,
      remaining: 0,
      resetSeconds,
      currentCount: timestamps.length,
      storage: "memory_fallback",
    };
  }

  timestamps.push(nowMs);
  fallbackMemoryStore.set(key, timestamps);

  const remaining = Math.max(0, limit - timestamps.length);
  const oldest = timestamps[0];
  const resetSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));

  return {
    allowed: true,
    limit,
    remaining,
    resetSeconds,
    currentCount: timestamps.length,
    storage: "memory_fallback",
  };
}

function makeThenable(
  res: RateLimitResult,
  promise?: Promise<RateLimitResult>
): RateLimitResult & Promise<RateLimitResult> {
  const targetPromise = promise || Promise.resolve(res);
  return {
    ...res,
    then(
      onfulfilled?: ((value: RateLimitResult) => any) | null,
      onrejected?: ((reason: any) => any) | null
    ) {
      return targetPromise.then(onfulfilled, onrejected);
    },
    catch(onrejected?: ((reason: any) => any) | null) {
      return targetPromise.catch(onrejected);
    },
    finally(onfinally?: (() => void) | null) {
      return targetPromise.finally(onfinally);
    },
    [Symbol.toStringTag]: "Promise",
  } as RateLimitResult & Promise<RateLimitResult>;
}

/**
 * Checks and records rate limit quota using Redis sorted sets (or in-memory fallback).
 * Supports both:
 * - checkRateLimit(key, limit, windowSeconds, nowMs?, options?)
 * - checkRateLimit(options: RateLimitOptions)
 */
export function checkRateLimit(
  keyOrOptions: string | RateLimitOptions,
  limitArg?: number,
  windowSecondsArg?: number,
  nowMsArg?: number,
  optionsArg?: {
    redisClient?: RedisClientInterface | null;
    failClosedOnRedisError?: boolean;
    isProduction?: boolean;
    action?: string;
  }
): Promise<RateLimitResult> | (RateLimitResult & Promise<RateLimitResult>) {
  let key: string;
  let limit: number;
  let windowSeconds: number;
  let nowMs: number;
  let options = optionsArg;

  if (typeof keyOrOptions === "object" && keyOrOptions !== null) {
    const opts = keyOrOptions as RateLimitOptions;
    key = opts.identifier
      ? `ratelimit:${opts.action}:${opts.identifier}`
      : `ratelimit:${opts.action}`;
    limit = opts.limit;
    windowSeconds = opts.windowSeconds;
    nowMs = typeof limitArg === "number" ? limitArg : Date.now();
    options = {
      redisClient: opts.redisClient,
      failClosedOnRedisError: opts.failClosedOnRedisError,
      isProduction: opts.isProduction,
      action: opts.action,
    };
  } else {
    key = String(keyOrOptions);
    limit = limitArg ?? 10;
    windowSeconds = windowSecondsArg ?? 60;
    nowMs = nowMsArg ?? Date.now();
  }
  const client = options?.redisClient !== undefined ? options.redisClient : getRedisClient();
  const isProd =
    options?.isProduction !== undefined
      ? options.isProduction
      : process.env.NODE_ENV === "production";

  const isSensitive = Boolean(
    options?.failClosedOnRedisError ||
      (options?.action && isSensitiveProtectedAction(options.action))
  );

  const shouldFailClosed = isProd && isSensitive;

  if (shouldFailClosed && !client) {
    const unavailableResult: RateLimitResult = {
      allowed: false,
      limit,
      remaining: 0,
      resetSeconds: 30,
      currentCount: limit,
      storage: "unavailable",
      serviceUnavailable: true,
    };
    return makeThenable(unavailableResult);
  }

  if (client) {
    const memResult = checkRateLimitMemory(key, limit, windowSeconds, nowMs);
    const asyncExecution = (async () => {
      try {
        const windowMs = windowSeconds * 1000;
        const member = `${nowMs}_${crypto.randomBytes(8).toString("hex")}`;

        const res = await client.eval(
          SLIDING_WINDOW_LUA,
          1,
          key,
          nowMs,
          windowMs,
          limit,
          windowSeconds,
          member
        );

        const allowed = res[0] === 1;
        const currentCount = Number(res[1]);
        const resetSeconds = Math.max(1, Number(res[2]));
        const remaining = allowed ? Math.max(0, limit - currentCount) : 0;

        return {
          allowed,
          limit,
          remaining,
          resetSeconds,
          currentCount,
          storage: "redis" as const,
          serviceUnavailable: false,
        };
      } catch {
        console.warn("[RateLimit] Redis operation failed.");

        if (shouldFailClosed) {
          return {
            allowed: false,
            limit,
            remaining: 0,
            resetSeconds: 30,
            currentCount: limit,
            storage: "unavailable" as const,
            serviceUnavailable: true,
          };
        }

        return memResult;
      }
    })();

    return makeThenable(memResult, asyncExecution);
  }

  // Fallback to in-memory limiter when Redis is unconfigured
  const memResult = checkRateLimitMemory(key, limit, windowSeconds, nowMs);
  return makeThenable(memResult);
}

/**
 * Builds standard rate-limiting headers for HTTP responses.
 */
export function buildRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetSeconds),
    "X-RateLimit-Storage": result.storage,
  };

  if (!result.allowed) {
    headers["Retry-After"] = String(result.resetSeconds);
  }

  return headers;
}

/**
 * Route helper / guard:
 * Inspects incoming request, applies sliding-window rate limit,
 * and returns a 429 Response if throttled, or null if allowed.
 */
export async function enforceRateLimit(
  request: Request,
  options: RateLimitOptions,
  nowMs: number = Date.now()
): Promise<{ response: Response | null; result: RateLimitResult }> {
  const isProd =
    options.isProduction !== undefined
      ? options.isProduction
      : process.env.NODE_ENV === "production";

  const isSensitive = options.failClosedOnRedisError || isSensitiveProtectedAction(options.action);
  const shouldFailClosed = isProd && isSensitive;

  const client = options.redisClient !== undefined ? options.redisClient : getRedisClient();

  if (shouldFailClosed && (!client || !isRedisConfigured())) {
    console.error(
      `[RateLimit] Critical: Distributed rate limiting unavailable in production for protected action "${options.action}". Failing closed with HTTP 503.`
    );
    const result: RateLimitResult = {
      allowed: false,
      limit: options.limit,
      remaining: 0,
      resetSeconds: 30,
      currentCount: options.limit,
      storage: "unavailable",
      serviceUnavailable: true,
    };
    return {
      response: createServiceUnavailableResponse(30),
      result,
    };
  }

  const ip = getClientIp(request);
  const id = options.identifier ? `:${options.identifier}` : `:${ip}`;
  const key = `ratelimit:${options.action}${id}`;

  const result = await checkRateLimit(
    key,
    options.limit,
    options.windowSeconds,
    nowMs,
    {
      redisClient: options.redisClient,
      failClosedOnRedisError: shouldFailClosed,
      isProduction: isProd,
      action: options.action,
    }
  );

  if (result.serviceUnavailable || (!result.allowed && result.storage === "unavailable")) {
    return {
      response: createServiceUnavailableResponse(result.resetSeconds || 30),
      result,
    };
  }

  if (!result.allowed) {
    const headers = buildRateLimitHeaders(result);
    return {
      response: Response.json(
        {
          error: "Too many requests. Please try again later.",
          retryAfter: result.resetSeconds,
        },
        { status: 429, headers }
      ),
      result,
    };
  }

  return { response: null, result };
}
