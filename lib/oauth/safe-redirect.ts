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

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
