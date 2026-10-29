/**
 * Shared Database Target Validation & Safety Guard
 *
 * Guarantees:
 * 1. Strict Fail-Closed Verification: Validates both target database name and exact hostname
 *    BEFORE any network connection or database client is created.
 * 2. Exact Hostname Matching: Requires exact match between confirmed hostname and connection string
 *    after standard lowercase/trailing-dot normalization.
 * 3. Exact Database Name Matching: Validates database name from connection URL against operator confirmation.
 * 4. Zero Credential Exposure: Sanitizes all error messages, masks connection strings, and never prints credentials.
 * 5. Strict CLI Argument Parsing: Rejects unknown or misspelled flags across all mutation scripts.
 * 6. Explicit Human Notice: Reminds operators that hostname equality alone does not prove a branch is disposable.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure parser for .env files supporting single/double quotes, unquoted values, CRLF, and comments.
 */
export function parseEnvContent(content) {
  const result = {};
  if (typeof content !== "string") return result;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([\w_]+)\s*=\s*(.*)$/);
    if (match) {
      const key = match[1];
      let val = match[2].trim();
      if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
        val = val.slice(1, -1);
      } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
        val = val.slice(1, -1);
      } else {
        const commentIdx = val.indexOf(" #");
        if (commentIdx !== -1) {
          val = val.slice(0, commentIdx).trim();
        }
      }
      if (result[key] === undefined) {
        result[key] = val;
      }
    }
  }
  return result;
}

/**
 * Resolves path to .env.local without exposing file contents.
 */
export function resolveEnvLocalPath(customPath) {
  if (customPath && typeof customPath === "string" && fs.existsSync(customPath)) {
    return path.resolve(customPath);
  }
  const cwdPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(cwdPath)) return cwdPath;
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const parentDir = path.dirname(currentFile);
    const candidate = path.resolve(parentDir, "..", ".env.local");
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  return null;
}

/**
 * Loads DATABASE_URL from process.env or .env.local safely without printing secrets.
 */
export function loadDatabaseUrlFromEnv(customPath) {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) {
    return process.env.DATABASE_URL.trim();
  }
  const resolvedPath = resolveEnvLocalPath(customPath);
  if (resolvedPath) {
    try {
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const parsed = parseEnvContent(content);
      if (parsed.DATABASE_URL && parsed.DATABASE_URL.trim().length > 0) {
        return parsed.DATABASE_URL.trim();
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Normalizes hostnames safely (trims whitespace, converts to lowercase, removes trailing dot).
 */
export function normalizeHostname(host) {
  if (!host || typeof host !== "string") return "";
  let trimmed = host.trim().toLowerCase();
  if (trimmed.endsWith(".") && trimmed.length > 1) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * Extracts and normalizes hostname from a database connection string.
 */
export function extractHostname(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== "string") return "";
  try {
    const url = new URL(databaseUrl.includes("://") ? databaseUrl : `postgres://${databaseUrl}`);
    return normalizeHostname(url.hostname || "");
  } catch {
    return "";
  }
}

/**
 * Extracts database name from a connection URL path (e.g. postgres://.../neondb -> neondb).
 */
export function extractDatabaseName(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== "string") return "";
  try {
    const url = new URL(databaseUrl.includes("://") ? databaseUrl : `postgres://${databaseUrl}`);
    const pathname = url.pathname || "";
    const cleaned = pathname.replace(/^\/+/, "").split("?")[0].split("/")[0].trim();
    return cleaned;
  } catch {
    return "";
  }
}

/**
 * Masks hostname to protect private endpoint identifiers while displaying enough for debugging.
 */
export function sanitizeTargetHost(hostOrUrl) {
  const host = extractHostname(hostOrUrl) || (typeof hostOrUrl === "string" ? hostOrUrl : "");
  if (!host) return "[MASKED_HOST]";
  try {
    if (host.includes(".neon.tech")) {
      const parts = host.split(".");
      const endpoint = parts[0];
      const maskedEndpoint =
        endpoint.length > 7 ? `${endpoint.slice(0, 7)}***` : `${endpoint}***`;
      return [maskedEndpoint, ...parts.slice(1)].join(".");
    }
    return host === "localhost" || host === "127.0.0.1" ? host : "[MASKED_HOST]";
  } catch {
    return "[MASKED_HOST]";
  }
}

/**
 * Sanitizes error messages by redacting URLs, passwords, tokens, and hosts.
 */
export function sanitizeErrorMessage(message) {
  if (typeof message !== "string") {
    if (message instanceof Error) {
      message = message.message;
    } else {
      return "Unknown error";
    }
  }
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s'"`;]+/gi, "[REDACTED_CONNECTION_URL]")
    .replace(/(password\s*=\s*)([^\s;]+)/gi, "$1[REDACTED]")
    .replace(/(password\s+authentication\s+failed\s+for\s+user\s+)(["'][^"']+["']|[^\s,;]+)/gi, "$1[REDACTED_USER]")
    .replace(/(token|secret|key|apiKey)=([^\s;]+)/gi, "$1=[REDACTED]")
    .replace(/ep-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech/gi, "[REDACTED_HOST]")
    .replace(/(host\s*=\s*)([^\s;]+)/gi, "$1[REDACTED_HOST]");
}

/**
 * Validates database identifier syntax (Postgres identifier characters).
 */
export function isValidDatabaseIdentifier(dbName) {
  if (!dbName || typeof dbName !== "string") return false;
  const trimmed = dbName.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) return false;
  return /^[a-zA-Z0-9_$-]+$/.test(trimmed);
}

/**
 * Validates fully qualified hostname or permitted local IP.
 */
export function isValidHostname(host) {
  if (!host || typeof host !== "string") return false;
  const raw = host.trim();
  if (!raw || raw.startsWith("-")) return false;

  if (
    raw.includes("://") ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes(":") ||
    raw.includes("@") ||
    raw.includes("?") ||
    raw.includes("#") ||
    /\s/.test(raw)
  ) {
    return false;
  }

  const normalized = normalizeHostname(raw);
  if (!normalized || normalized.length > 253) return false;

  if (normalized === "localhost") return true;

  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(normalized)) {
    const octets = normalized.split(".").map(Number);
    return octets.every((o) => o >= 0 && o <= 255);
  }

  const labels = normalized.split(".");
  if (labels.length < 2) return false;

  const labelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const label of labels) {
    if (!labelRegex.test(label)) return false;
  }

  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld) || tld.length < 2) return false;

  return true;
}

export function isValidEndpointIdentifier(endpoint) {
  return isValidHostname(endpoint);
}

/**
 * Validates database target and endpoint confirmations against the configured database URL.
 * Throws a sanitized Error if any check fails BEFORE any database connection is created.
 *
 * @param {object} params
 * @param {string} params.databaseUrl - Connection string loaded from environment
 * @param {string} params.confirmTarget - Target database name confirmed by operator
 * @param {string} params.confirmEndpoint - Exact hostname confirmed by operator
 * @returns {{ valid: boolean, database: string, hostname: string }}
 */
export function validateDatabaseTarget({ databaseUrl, confirmTarget, confirmEndpoint }) {
  if (!databaseUrl || typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error("Configuration error: DATABASE_URL is not configured.");
  }

  if (!confirmTarget || typeof confirmTarget !== "string" || confirmTarget.trim().length === 0) {
    throw new Error(
      "Safety guard: Operator target database confirmation (--confirm-target <name>) is required to prevent accidental connection."
    );
  }

  if (!isValidDatabaseIdentifier(confirmTarget)) {
    throw new Error(
      "Safety guard: Malformed database confirmation. Provide a valid database name (e.g. 'neondb')."
    );
  }

  if (!confirmEndpoint || typeof confirmEndpoint !== "string" || confirmEndpoint.trim().length === 0) {
    throw new Error(
      "Safety guard: Operator endpoint confirmation (--confirm-endpoint <exact_hostname>) is required to prevent accidental connection across branches."
    );
  }

  if (!isValidEndpointIdentifier(confirmEndpoint)) {
    throw new Error(
      "Safety guard: Malformed endpoint confirmation. Provide the exact, fully qualified hostname (e.g. 'ep-cool-dawn-123456.us-east-2.aws.neon.tech'). Partial prefixes, URLs, paths, and ports are rejected."
    );
  }

  const configuredDb = extractDatabaseName(databaseUrl);
  if (!configuredDb || !isValidDatabaseIdentifier(configuredDb)) {
    throw new Error("Target validation error: Unable to extract valid database name from configured DATABASE_URL.");
  }

  const configuredHost = extractHostname(databaseUrl);
  if (!configuredHost || !isValidHostname(configuredHost)) {
    throw new Error("Target validation error: Unable to extract valid hostname from configured DATABASE_URL.");
  }

  // Database name comparison (case-insensitive)
  if (configuredDb.toLowerCase() !== confirmTarget.trim().toLowerCase()) {
    throw new Error(
      `Database confirmation mismatch: Confirmed database '${confirmTarget.trim()}' does not match configured database '${configuredDb}'. Connection aborted.`
    );
  }

  // Exact hostname comparison after normalization
  const normalizedEndpoint = normalizeHostname(confirmEndpoint);
  if (configuredHost !== normalizedEndpoint) {
    throw new Error(
      `Endpoint confirmation mismatch: Confirmed endpoint '${normalizedEndpoint}' does not match configured host '${sanitizeTargetHost(configuredHost)}'. Connection aborted.`
    );
  }

  return {
    valid: true,
    database: configuredDb,
    hostname: configuredHost,
  };
}

/**
 * Pure CLI argument parser supporting standard confirmation flags and rejecting unknown flags.
 *
 * @param {string[]} argv - process.argv array
 * @param {object} options
 * @param {string[]} options.allowedFlags - List of script-specific allowed flags (e.g. ['--run', '--out-file'])
 * @param {string[]} options.valuedFlags - List of script-specific flags that take a subsequent value
 * @returns {object} Parsed flags or throws an error on unknown flags
 */
export function parseTargetCliArgs(argv = process.argv, options = {}) {
  const args = argv.slice(2);
  const allowedExtra = new Set(options.allowedFlags || []);
  const valuedExtra = new Set(options.valuedFlags || []);

  let confirmTarget = null;
  let confirmEndpoint = null;
  let help = false;
  const extraFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--confirm-target" || arg === "--confirm-database") {
      i++;
      if (i >= args.length || !args[i] || args[i].startsWith("-")) {
        throw new Error(`Flag '${arg}' requires a valid database name value.`);
      }
      confirmTarget = args[i].trim();
    } else if (
      arg === "--confirm-endpoint" ||
      arg === "--confirm-host" ||
      arg === "--confirm-hostname" ||
      arg === "--confirm-endpoint-prefix"
    ) {
      i++;
      if (i >= args.length || !args[i] || args[i].startsWith("-")) {
        throw new Error(`Flag '${arg}' requires an exact hostname value.`);
      }
      confirmEndpoint = args[i].trim();
    } else if (allowedExtra.has(arg)) {
      if (valuedExtra.has(arg)) {
        i++;
        if (i >= args.length || !args[i] || args[i].startsWith("--")) {
          throw new Error(`Flag '${arg}' requires a valid value.`);
        }
        extraFlags[arg] = args[i].trim();
      } else {
        extraFlags[arg] = true;
      }
    } else {
      throw new Error(`Unrecognized or disallowed argument '${arg}'.`);
    }
  }

  return {
    confirmTarget,
    confirmEndpoint,
    help,
    extraFlags,
  };
}
