/**
 * Map raw API / thrown errors onto user-safe copy for production UI.
 * Technical details are only returned in development builds.
 */

const GENERIC =
  "Something went wrong. Please try again or refresh the page.";

const PATTERNS: Array<{ test: RegExp; message: string }> = [
  { test: /401|403|not\s*authenticated|authentication\s*required|unauthorized|session\s*expired/i, message: "Session expired. Please sign in again." },
  { test: /404|not\s*found/i, message: "We couldn't find what you're looking for." },
  { test: /429|rate\s*limit|too\s*many\s*requests/i, message: "Too many requests — please wait a moment and try again." },
  { test: /5\d\d|server\s*error|unreachable|timed?\s*out|bad\s*gateway|unexpected\s*error|internal\s*error/i, message: "Eden is having trouble reaching the server. Please try again in a moment." },
];

export function toUserFacingError(
  error: unknown,
  fallback = GENERIC,
): string {
  // Prefer HTTP status when the caller passed an ApiError-shaped object
  // so backend copy like "An unexpected error occurred" still maps to
  // the 5xx banner instead of leaking through in development.
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  if (typeof status === "number" && status >= 500) {
    return "Eden is having trouble reaching the server. Please try again in a moment.";
  }
  if (status === 401 || status === 403) {
    return "Session expired. Please sign in again.";
  }
  if (status === 404) {
    return "We couldn't find what you're looking for.";
  }
  if (status === 422) {
    return "Invalid request — refresh the page and try connecting GitHub again.";
  }
  if (status === 429) {
    return "Too many requests — please wait a moment and try again.";
  }

  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (!raw) return fallback;

  for (const { test, message } of PATTERNS) {
    if (test.test(raw)) return message;
  }

  if (process.env.NODE_ENV === "development") {
    return raw;
  }
  return fallback;
}

/** Shorthand for catch blocks: ``setError(errorFromCaught(err, "…"))``. */
export function errorFromCaught(err: unknown, fallback: string): string {
  return toUserFacingError(err, fallback);
}
