import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";

/**
 * Normalizes raw REDIS_URL strings:
 * - Strips wrapper quotes or cli prefixes (e.g. `redis-cli --tls -u ...`)
 * - Converts redis:// to rediss:// when --tls is present or when host is upstash.io
 */
export function normalizeRedisUrl(raw?: string | null): string {
  if (!raw) return "";
  let val = raw.trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1).trim();
  }
  const hasTls = val.includes("--tls");
  const match = val.match(/rediss?:\/\/[^\s'"]+/);
  if (match) {
    let url = match[0];
    if ((hasTls || url.includes(".upstash.io")) && url.startsWith("redis://")) {
      url = url.replace(/^redis:\/\//, "rediss://");
    }
    return url;
  }
  return val;
}

let envLocalLoaded = false;

/**
 * Loads .env.local into process.env if REDIS_URL is not already set.
 */
function tryLoadEnvLocal(): void {
  if (envLocalLoaded) return;
  envLocalLoaded = true;

  if (process.env.REDIS_URL && process.env.REDIS_URL.trim().length > 0) {
    process.env.REDIS_URL = normalizeRedisUrl(process.env.REDIS_URL);
    return;
  }
  const candidatePaths = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "rota", "web", ".env.local"),
  ];
  for (const envPath of candidatePaths) {
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ envPath)) {
        const content = fs.readFileSync(/*turbopackIgnore: true*/ envPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
          if (match) {
            const key = match[1];
            let val = match[2].trim();
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1);
            }
            if (key === "REDIS_URL") {
              val = normalizeRedisUrl(val);
            }
            if (process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        }
        if (process.env.REDIS_URL && process.env.REDIS_URL.trim().length > 0) {
          process.env.REDIS_URL = normalizeRedisUrl(process.env.REDIS_URL);
          return;
        }
      }
    } catch {
      // Non-fatal if .env.local is inaccessible
    }
  }
}

/**
 * Universal Redis Client Interface for Rota
 */
export interface RedisClientInterface {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: "EX", ttl?: number): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  eval(script: string, numkeys: number, ...keysAndArgs: (string | number)[]): Promise<any>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number, withScores?: boolean): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<void>;
  isConnected(): boolean;
}

export interface RedisStatus {
  configured: boolean;
  connected: boolean;
  provider: "redis" | "memory_fallback";
  url?: string;
  error?: string | null;
}

/**
 * In-memory Mock Redis implementation for tests and local environments without a live Redis server.
 * Implements real Redis semantics:
 * - String keys with TTLs
 * - Sorted sets (ZADD, ZREMRANGEBYSCORE, ZCARD, ZRANGE)
 * - Lua sliding-window rate limit execution
 * - Pattern-based key scanning
 * - Explicit failure injection for testing resilience
 */
export class MockRedisClient implements RedisClientInterface {
  private strings = new Map<string, { value: string; expiresAt: number | null }>();
  // Sorted sets: key -> Array of { score: number, member: string }
  private sortedSets = new Map<string, { entries: { score: number; member: string }[]; expiresAt: number | null }>();
  private simulateFailure = false;
  private connected = true;

  setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  private checkFailure(): void {
    if (this.simulateFailure) {
      throw new Error("Redis connection refused or command timeout (simulated).");
    }
  }

  isConnected(): boolean {
    return this.connected && !this.simulateFailure;
  }

  async ping(): Promise<string> {
    this.checkFailure();
    return "PONG";
  }

  async get(key: string): Promise<string | null> {
    this.checkFailure();
    const item = this.strings.get(key);
    if (!item) return null;
    if (item.expiresAt !== null && Date.now() > item.expiresAt) {
      this.strings.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, mode?: "EX", ttl?: number): Promise<string | null> {
    this.checkFailure();
    const expiresAt = mode === "EX" && typeof ttl === "number" && ttl > 0
      ? Date.now() + ttl * 1000
      : null;
    this.strings.set(key, { value, expiresAt });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.checkFailure();
    let count = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) count++;
      if (this.sortedSets.delete(key)) count++;
    }
    return count;
  }

  async keys(pattern: string): Promise<string[]> {
    this.checkFailure();
    const now = Date.now();
    const matched = new Set<string>();

    const regexPattern = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
    );

    for (const [key, item] of this.strings.entries()) {
      if (item.expiresAt !== null && now > item.expiresAt) {
        this.strings.delete(key);
        continue;
      }
      if (regexPattern.test(key)) {
        matched.add(key);
      }
    }

    for (const [key, item] of this.sortedSets.entries()) {
      if (item.expiresAt !== null && now > item.expiresAt) {
        this.sortedSets.delete(key);
        continue;
      }
      if (regexPattern.test(key)) {
        matched.add(key);
      }
    }

    return Array.from(matched);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.checkFailure();
    let setObj = this.sortedSets.get(key);
    if (!setObj) {
      setObj = { entries: [], expiresAt: null };
      this.sortedSets.set(key, setObj);
    }
    const idx = setObj.entries.findIndex((e) => e.member === member);
    let added = 0;
    if (idx !== -1) {
      setObj.entries[idx].score = score;
    } else {
      setObj.entries.push({ score, member });
      added = 1;
    }
    setObj.entries.sort((a, b) => a.score - b.score);
    return added;
  }

  async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<number> {
    this.checkFailure();
    const setObj = this.sortedSets.get(key);
    if (!setObj) return 0;

    const minNum = min === "-inf" ? -Infinity : typeof min === "number" ? min : parseFloat(min);
    const maxNum = max === "+inf" ? Infinity : typeof max === "number" ? max : parseFloat(max);

    const initialLength = setObj.entries.length;
    setObj.entries = setObj.entries.filter((e) => e.score < minNum || e.score > maxNum);
    return initialLength - setObj.entries.length;
  }

  async zcard(key: string): Promise<number> {
    this.checkFailure();
    const setObj = this.sortedSets.get(key);
    if (!setObj) return 0;
    if (setObj.expiresAt !== null && Date.now() > setObj.expiresAt) {
      this.sortedSets.delete(key);
      return 0;
    }
    return setObj.entries.length;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores = false
  ): Promise<string[]> {
    this.checkFailure();
    const setObj = this.sortedSets.get(key);
    if (!setObj) return [];
    if (setObj.expiresAt !== null && Date.now() > setObj.expiresAt) {
      this.sortedSets.delete(key);
      return [];
    }

    const len = setObj.entries.length;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? Math.max(0, len + stop) : stop;

    const slice = setObj.entries.slice(s, e + 1);
    if (!withScores) {
      return slice.map((item) => item.member);
    }
    const result: string[] = [];
    for (const item of slice) {
      result.push(item.member, String(item.score));
    }
    return result;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.checkFailure();
    const expiresAt = Date.now() + seconds * 1000;
    let found = false;
    const strItem = this.strings.get(key);
    if (strItem) {
      strItem.expiresAt = expiresAt;
      found = true;
    }
    const setObj = this.sortedSets.get(key);
    if (setObj) {
      setObj.expiresAt = expiresAt;
      found = true;
    }
    return found ? 1 : 0;
  }

  async eval(
    script: string,
    numkeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<any> {
    this.checkFailure();
    const key = String(keysAndArgs[0]);
    const now = Number(keysAndArgs[numkeys]);
    const windowMs = Number(keysAndArgs[numkeys + 1]);
    const limit = Number(keysAndArgs[numkeys + 2]);
    const windowSec = Number(keysAndArgs[numkeys + 3]);
    const member = String(keysAndArgs[numkeys + 4]);

    // Atomic sliding window execution (synchronous within single tick)
    let setObj = this.sortedSets.get(key);
    if (!setObj) {
      setObj = { entries: [], expiresAt: null };
      this.sortedSets.set(key, setObj);
    }

    const threshold = now - windowMs;
    setObj.entries = setObj.entries.filter((e) => e.score > threshold);
    const count = setObj.entries.length;

    if (count >= limit) {
      const oldestScore = count > 0 ? setObj.entries[0].score : now;
      const resetMs = Math.max(1000, oldestScore + windowMs - now);
      const resetSec = Math.ceil(resetMs / 1000);
      return [0, count, resetSec];
    }

    setObj.entries.push({ score: now, member });
    setObj.entries.sort((a, b) => a.score - b.score);
    setObj.expiresAt = Date.now() + (windowSec + 1) * 1000;

    const newCount = count + 1;
    const oldestScore = setObj.entries[0].score;
    const resetMs = Math.max(1000, oldestScore + windowMs - now);
    const resetSec = Math.ceil(resetMs / 1000);

    return [1, newCount, resetSec];
  }

  async quit(): Promise<void> {
    this.connected = false;
    this.strings.clear();
    this.sortedSets.clear();
  }
}

/**
 * Standard Native TCP/TLS RESP Redis Client
 * Connects to Redis servers without requiring external npm dependencies.
 */
export class NativeRedisClient implements RedisClientInterface {
  private socket: net.Socket | null = null;
  private url: string;
  private connected = false;
  private responseQueue: { resolve: (val: any) => void; reject: (err: any) => void }[] = [];
  private buffer = "";

  constructor(url: string) {
    this.url = normalizeRedisUrl(url);
  }

  private async connect(): Promise<net.Socket> {
    if (this.socket && this.connected) {
      return this.socket;
    }

    return new Promise((resolve, reject) => {
      try {
        const parsed = new URL(this.url);
        const isTls = parsed.protocol === "rediss:";
        const host = parsed.hostname || "127.0.0.1";
        const port = parseInt(parsed.port || "6379", 10);
        const username = parsed.username ? decodeURIComponent(parsed.username) : "";
        const password = parsed.password ? decodeURIComponent(parsed.password) : "";

        const options = { host, port, servername: host, timeout: 5000 };

        const onConnect = async (sock: net.Socket) => {
          this.connected = true;
          this.socket = sock;

          sock.on("data", (data) => this.handleData(data));
          sock.on("error", (err) => {
            this.connected = false;
            while (this.responseQueue.length > 0) {
              const req = this.responseQueue.shift();
              req?.reject(err);
            }
          });
          sock.on("close", () => {
            this.connected = false;
            this.socket = null;
          });

          // Authenticate if password is in URL (supports standard Redis & Upstash Redis credentials)
          if (password) {
            try {
              if (username && username !== "default") {
                await this.executeRaw(["AUTH", username, password]);
              } else {
                await this.executeRaw(["AUTH", password]);
              }
            } catch (authErr) {
              if (username) {
                try {
                  await this.executeRaw(["AUTH", username, password]);
                } catch {
                  return reject(authErr);
                }
              } else {
                return reject(authErr);
              }
            }
          }

          resolve(sock);
        };

        const handleTimeout = (sock: net.Socket) => {
          sock.destroy(new Error("Connection timed out (timeout 5000ms)"));
        };

        if (isTls) {
          const tlsSocket = tls.connect(options, () => onConnect(tlsSocket));
          tlsSocket.on("timeout", () => handleTimeout(tlsSocket));
          tlsSocket.on("error", (err) => reject(err));
        } else {
          const netSocket = net.createConnection(options, () => onConnect(netSocket));
          netSocket.on("timeout", () => handleTimeout(netSocket));
          netSocket.on("error", (err) => reject(err));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString("utf-8");
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const parsed = this.parseResp(this.buffer);
      if (!parsed) break;

      this.buffer = this.buffer.slice(parsed.bytesConsumed);
      const req = this.responseQueue.shift();
      if (req) {
        if (parsed.isError) {
          req.reject(new Error(parsed.value));
        } else {
          req.resolve(parsed.value);
        }
      }
    }
  }

  private parseResp(buf: string): { value: any; bytesConsumed: number; isError?: boolean } | null {
    if (buf.length === 0) return null;
    const prefix = buf[0];
    const crlfIndex = buf.indexOf("\r\n");
    if (crlfIndex === -1) return null;

    if (prefix === "+") {
      // Simple string
      return {
        value: buf.slice(1, crlfIndex),
        bytesConsumed: crlfIndex + 2,
      };
    }

    if (prefix === "-") {
      // Error
      return {
        value: buf.slice(1, crlfIndex),
        bytesConsumed: crlfIndex + 2,
        isError: true,
      };
    }

    if (prefix === ":") {
      // Integer
      return {
        value: parseInt(buf.slice(1, crlfIndex), 10),
        bytesConsumed: crlfIndex + 2,
      };
    }

    if (prefix === "$") {
      // Bulk string
      const len = parseInt(buf.slice(1, crlfIndex), 10);
      if (len === -1) {
        return { value: null, bytesConsumed: crlfIndex + 2 };
      }
      const dataStart = crlfIndex + 2;
      const dataEnd = dataStart + len;
      if (buf.length < dataEnd + 2) return null; // Incomplete

      const value = buf.slice(dataStart, dataEnd);
      return { value, bytesConsumed: dataEnd + 2 };
    }

    if (prefix === "*") {
      // Array
      const numElements = parseInt(buf.slice(1, crlfIndex), 10);
      if (numElements === -1) {
        return { value: null, bytesConsumed: crlfIndex + 2 };
      }

      let offset = crlfIndex + 2;
      const elements: any[] = [];
      for (let i = 0; i < numElements; i++) {
        const remaining = buf.slice(offset);
        const el = this.parseResp(remaining);
        if (!el) return null; // Incomplete
        elements.push(el.value);
        offset += el.bytesConsumed;
      }
      return { value: elements, bytesConsumed: offset };
    }

    return null;
  }

  private serializeCommand(args: (string | number)[]): string {
    let out = `*${args.length}\r\n`;
    for (const arg of args) {
      const str = String(arg);
      out += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
    }
    return out;
  }

  private async executeRaw(args: (string | number)[]): Promise<any> {
    const sock = await this.connect();
    return new Promise((resolve, reject) => {
      this.responseQueue.push({ resolve, reject });
      const payload = this.serializeCommand(args);
      sock.write(payload);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async ping(): Promise<string> {
    return this.executeRaw(["PING"]);
  }

  async get(key: string): Promise<string | null> {
    return this.executeRaw(["GET", key]);
  }

  async set(key: string, value: string, mode?: "EX", ttl?: number): Promise<string | null> {
    if (mode === "EX" && ttl) {
      return this.executeRaw(["SET", key, value, "EX", String(ttl)]);
    }
    return this.executeRaw(["SET", key, value]);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.executeRaw(["DEL", ...keys]);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.executeRaw(["KEYS", pattern]);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.executeRaw(["ZADD", key, String(score), member]);
  }

  async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<number> {
    return this.executeRaw(["ZREMRANGEBYSCORE", key, String(min), String(max)]);
  }

  async zcard(key: string): Promise<number> {
    return this.executeRaw(["ZCARD", key]);
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores = false
  ): Promise<string[]> {
    if (withScores) {
      return this.executeRaw(["ZRANGE", key, String(start), String(stop), "WITHSCORES"]);
    }
    return this.executeRaw(["ZRANGE", key, String(start), String(stop)]);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.executeRaw(["EXPIRE", key, String(seconds)]);
  }

  async eval(
    script: string,
    numkeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<any> {
    return this.executeRaw(["EVAL", script, String(numkeys), ...keysAndArgs]);
  }

  async quit(): Promise<void> {
    if (this.socket) {
      try {
        await this.executeRaw(["QUIT"]);
      } catch {}
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }
}

// Global active client reference
let customClient: RedisClientInterface | null = null;
let activeNativeClient: NativeRedisClient | null = null;

export function setCustomRedisClient(client: RedisClientInterface | null): void {
  customClient = client;
}

export function isRedisConfigured(): boolean {
  tryLoadEnvLocal();
  return Boolean(
    customClient ||
    (process.env.REDIS_URL && process.env.REDIS_URL.trim().length > 0)
  );
}

export function getRedisClient(): RedisClientInterface | null {
  if (customClient) {
    return customClient;
  }

  tryLoadEnvLocal();

  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    if (activeNativeClient) {
      activeNativeClient = null;
    }
    return null;
  }

  if (!activeNativeClient) {
    activeNativeClient = new NativeRedisClient(redisUrl);
  }

  return activeNativeClient;
}

/**
 * Sanitizes a Redis connection string by replacing passwords/credentials with asterisks.
 * Safely strips tokens without exposing secrets in logs or diagnostics.
 */
export function sanitizeRedisUrl(url?: string): string | undefined {
  if (!url || typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "localhost";
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//***:***@${host}${port}`;
  } catch {
    return "[redacted-url]";
  }
}

export function getRedisStatus(): RedisStatus {
  const configured = isRedisConfigured();
  const client = getRedisClient();
  const connected = Boolean(client && client.isConnected());

  return {
    configured,
    connected,
    provider: configured && connected ? "redis" : "memory_fallback",
    url: sanitizeRedisUrl(process.env.REDIS_URL),
  };
}

export interface RedisConnectivityReport {
  configured: boolean;
  reachable: boolean;
  usable: boolean;
  latencyMs?: number;
  statusText: "Connected" | "Unreachable" | "Degraded" | "Not Configured";
  error?: string | null;
}

/**
 * Diagnostic tool: Verifies real Redis connectivity using configured REDIS_URL.
 * Tests:
 * 1. Ping response (PONG)
 * 2. Key write/read/delete probe
 *
 * Guarantees:
 * - Never returns or prints passwords, URLs, tokens, or credentials.
 * - Categorizes errors into sanitized diagnostic summaries.
 * - Operates independently from MockRedisClient.
 */
export async function checkRedisConnectivity(
  target?: string | RedisClientInterface
): Promise<RedisConnectivityReport> {
  // If a mock or custom client is explicitly provided for testing:
  if (target && typeof target === "object" && "ping" in target) {
    const start = Date.now();
    try {
      const pong = await target.ping();
      if (pong !== "PONG") {
        return {
          configured: true,
          reachable: false,
          usable: false,
          statusText: "Unreachable",
          error: "Server did not respond with PONG.",
        };
      }
      const probeKey = `diagnostic:probe:${Date.now()}`;
      await target.set(probeKey, "ok", "EX", 10);
      const val = await target.get(probeKey);
      await target.del(probeKey);
      if (val !== "ok") {
        return {
          configured: true,
          reachable: true,
          usable: false,
          statusText: "Degraded",
          error: "Probe read/write verification failed.",
        };
      }
      return {
        configured: true,
        reachable: true,
        usable: true,
        latencyMs: Date.now() - start,
        statusText: "Connected",
        error: null,
      };
    } catch {
      return {
        configured: true,
        reachable: false,
        usable: false,
        statusText: "Unreachable",
        error: "Connection refused or command timeout",
      };
    }
  }

  tryLoadEnvLocal();

  const rawUrl = typeof target === "string" ? target : process.env.REDIS_URL?.trim();
  if (!rawUrl) {
    return {
      configured: false,
      reachable: false,
      usable: false,
      statusText: "Not Configured",
      error: "REDIS_URL environment variable is not configured.",
    };
  }

  const startTime = Date.now();
  let client: NativeRedisClient | null = null;
  try {
    client = new NativeRedisClient(rawUrl);
    const pingResponse = await client.ping();
    if (pingResponse !== "PONG") {
      try { await client.quit(); } catch {}
      return {
        configured: true,
        reachable: false,
        usable: false,
        statusText: "Unreachable",
        error: "Server did not respond with PONG.",
      };
    }

    // Verify Usability (probe key write/read/delete)
    const probeKey = `diagnostic:probe:${Date.now()}`;
    await client.set(probeKey, "ok", "EX", 10);
    const probeVal = await client.get(probeKey);
    await client.del(probeKey);
    try { await client.quit(); } catch {}

    if (probeVal !== "ok") {
      return {
        configured: true,
        reachable: true,
        usable: false,
        statusText: "Degraded",
        error: "Probe read/write verification failed.",
      };
    }

    const latencyMs = Date.now() - startTime;
    return {
      configured: true,
      reachable: true,
      usable: true,
      latencyMs,
      statusText: "Connected",
      error: null,
    };
  } catch (err: any) {
    if (client) {
      try { await client.quit(); } catch {}
    }

    let sanitized = "Connection attempt failed";
    const msg = String(err?.message || "");
    if (msg.includes("ECONNREFUSED")) {
      sanitized = "Connection refused by target server";
    } else if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
      sanitized = "Connection timed out";
    } else if (msg.includes("ENOTFOUND")) {
      sanitized = "Host not found / DNS resolution failed";
    } else if (msg.includes("AUTH") || msg.includes("WRONGPASS") || msg.includes("NOAUTH")) {
      sanitized = "Authentication failed (invalid credentials)";
    } else if (msg.includes("Invalid URL")) {
      sanitized = "Invalid REDIS_URL format";
    }

    return {
      configured: true,
      reachable: false,
      usable: false,
      statusText: "Unreachable",
      error: sanitized,
    };
  }
}
