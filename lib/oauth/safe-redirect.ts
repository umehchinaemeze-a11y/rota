const DEFAULT_REDIRECT_PATH = "/";
const MAX_REDIRECT_LENGTH = 500;

/**
 * Accepts only same-origin relative paths. Rejects external URLs,
 * protocol-relative paths, backslashes, control characters, and malformed input.
 */
export function sanitizeRedirectPath(
  input: unknown,
  fallback: string = DEFAULT_REDIRECT_PATH
): string {
  if (typeof input !== "string") {
    return fallback;
  }

  const trimmed = input.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_REDIRECT_LENGTH ||
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    /[\r\n]/.test(trimmed)
  ) {
    return fallback;
  }

  try {
    const url = new URL(trimmed, "http://rota.local");
    if (url.origin !== "http://rota.local") {
      return fallback;
    }
    if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

const CANONICAL_PRODUCTION_ORIGIN = "https://rota-lovat-gamma.vercel.app";

const LOCAL_DEVELOPMENT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost",
  "http://127.0.0.1:3000",
  "http://127.0.0.1",
];

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function getNormalizedOrigin(parsed: URL): string {
  const normalizedHost = normalizeHostname(parsed.hostname);
  return `${parsed.protocol}//${normalizedHost}${parsed.port ? `:${parsed.port}` : ""}`;
}

function isLocalhostOrigin(parsed: URL): boolean {
  const host = normalizeHostname(parsed.hostname);
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
}

function isUntrustedPreviewOrigin(parsed: URL): boolean {
  const host = normalizeHostname(parsed.hostname);
  const isVercelHost = host === "vercel.app" || host.endsWith(".vercel.app");
  if (!isVercelHost) {
    return false;
  }
  return getNormalizedOrigin(parsed) !== CANONICAL_PRODUCTION_ORIGIN;
}

function resolveAllowedOrigins(): Set<string> {
  const origins = new Set<string>();

  // 1. Production canonical origin is always included
  origins.add(CANONICAL_PRODUCTION_ORIGIN);

  // 2. Validate and include explicitly configured NEXT_PUBLIC_APP_URL if provided
  const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (rawAppUrl) {
    try {
      const parsed = new URL(rawAppUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const isLocal = isLocalhostOrigin(parsed);
        const isPreview = isUntrustedPreviewOrigin(parsed);

        // In production, reject localhost and non-canonical vercel.app preview origins
        if (process.env.NODE_ENV === "production") {
          if (!isLocal && !isPreview) {
            origins.add(parsed.origin);
            origins.add(getNormalizedOrigin(parsed));
          }
        } else {
          origins.add(parsed.origin);
          origins.add(getNormalizedOrigin(parsed));
        }
      }
    } catch {
      // Safely ignore malformed configured URL
    }
  }

  // 3. Localhost development/test origins strictly permitted only when NODE_ENV !== "production"
  if (process.env.NODE_ENV !== "production") {
    for (const localOrigin of LOCAL_DEVELOPMENT_ORIGINS) {
      origins.add(localOrigin);
    }
  }

  return origins;
}

/**
 * Validates whether an incoming state-changing request originates from a trusted same-origin source.
 *
 * Rules:
 * 1. Checks Origin header first. If present and valid, checks against trusted allowlist.
 * 2. If Origin is malformed or untrusted, rejects immediately without falling back to Referer.
 * 3. If Origin is absent, falls back to Referer header and validates its origin against allowlist.
 * 4. Fails closed (returns false) if both Origin and Referer are absent or malformed.
 * 5. Does not trust spoofable proxy or client-supplied Host headers.
 */
export function isSameOriginRequest(request: Request): boolean {
  const allowed = resolveAllowedOrigins();

  const isAllowedOrigin = (parsed: URL): boolean => {
    if (allowed.has(parsed.origin)) {
      return true;
    }
    return allowed.has(getNormalizedOrigin(parsed));
  };

  // 1. Primary check: Origin header
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin !== null && rawOrigin !== undefined) {
    const trimmedOrigin = rawOrigin.trim();
    if (!trimmedOrigin) {
      return false;
    }
    try {
      const parsed = new URL(trimmedOrigin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      return isAllowedOrigin(parsed);
    } catch {
      // Malformed Origin: reject immediately, do NOT fall back to Referer
      return false;
    }
  }

  // 2. Fallback check: Referer header (only when Origin is absent)
  const rawReferer = request.headers.get("referer");
  if (rawReferer !== null && rawReferer !== undefined) {
    const trimmedReferer = rawReferer.trim();
    if (!trimmedReferer) {
      return false;
    }
    try {
      const parsed = new URL(trimmedReferer);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      return isAllowedOrigin(parsed);
    } catch {
      // Malformed Referer: reject
      return false;
    }
  }

  // 3. Both Origin and Referer are absent: fail closed
  return false;
}
