/**
 * Map raw API / thrown errors onto user-safe copy for production UI.
 * Technical details are only returned in development builds.
 */

import {
  IMPROVE_FEATURE_DISABLED_MESSAGE,
  REPO_NOT_CONNECTED_MESSAGE,
} from "@/lib/improve-feature";

const GENERIC =
  "Something went wrong. Please try again or refresh the page.";

/** Pull a short human hint from FastAPI validation ``detail`` JSON. */
function summarizeValidationDetail(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { detail?: unknown }).detail)
        ? ((parsed as { detail: unknown[] }).detail)
        : null;
    if (!items || items.length === 0) return null;
    const parts: string[] = [];
    for (const item of items.slice(0, 3)) {
      if (!item || typeof item !== "object") continue;
      const loc = (item as { loc?: unknown }).loc;
      const msg = (item as { msg?: unknown }).msg;
      const field =
        Array.isArray(loc) && loc.length > 0
          ? String(loc[loc.length - 1])
          : null;
      if (field && typeof msg === "string" && msg) {
        parts.push(`${field}: ${msg}`);
      } else if (typeof msg === "string" && msg) {
        parts.push(msg);
      }
    }
    return parts.length > 0 ? parts.join("; ") : null;
  } catch {
    // Non-JSON detail (plain string from our HTTPException path).
    if (raw.length > 0 && raw.length < 160 && !raw.startsWith("[")) {
      return raw;
    }
    return null;
  }
}

const PATTERNS: Array<{ test: RegExp; message: string }> = [
  { test: /401|403|not\s*authenticated|authentication\s*required|unauthorized|session\s*expired/i, message: "Session expired. Please sign in again." },
  { test: /404|not\s*found/i, message: "We couldn't find what you're looking for." },
  { test: /429|rate\s*limit|too\s*many\s*requests/i, message: "Too many requests — please wait a moment and try again." },
  { test: /no\s*healthy\s*upstream|backend\s*(unavailable|unreachable|timed?\s*out|circuit\s*open)|5\d\d|server\s*error|unreachable|timed?\s*out|bad\s*gateway|unexpected\s*error|internal\s*error/i, message: "Eden is having trouble reaching the server. Please try again in a moment." },
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

  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : typeof error === "string"
          ? error
          : "";

  // Feature kill-switches and repo-connection gaps often return 503 with
  // an explicit reason — do not collapse those into the generic server banner.
  if (
    /improvement_agent_v1/i.test(raw) ||
    /disabled for this org/i.test(raw)
  ) {
    return IMPROVE_FEATURE_DISABLED_MESSAGE;
  }
  if (
    /repo_not_connected/i.test(raw) ||
    /Connect GitHub App/i.test(raw)
  ) {
    return REPO_NOT_CONNECTED_MESSAGE;
  }
  if (
    /github_permissions_missing/i.test(raw) ||
    /Contents:\s*Read and write/i.test(raw) ||
    /Resource not accessible by integration/i.test(raw)
  ) {
    return "GitHub App needs Contents: Read and write (and Pull requests: Read and write). Update the App permissions, Accept on the installation, then retry.";
  }

  // Prefer actionable temporary-unavailable copy from the API over the
  // generic "trouble reaching the server" banner (Assistant / keys /
  // traces often return a clear Retry-After detail on 503). Also map
  // proxy circuit-open / upstream-down strings the tour and chrome see.
  if (typeof status === "number" && status === 503) {
    if (/backend circuit open/i.test(raw)) {
      return "Eden’s API is temporarily overloaded. Please try again in a moment.";
    }
    if (
      /temporarily unavailable|please retry|Could not load|not yet available|Backend unavailable|upstream/i.test(
        raw,
      )
    ) {
      const cleaned = raw.replace(/^Error:\s*/i, "").trim();
      if (cleaned.length > 0 && cleaned.length < 180) {
        return cleaned;
      }
    }
  }

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
    // 422 is FastAPI/Pydantic validation — not GitHub-specific.
    // Only map to reconnect copy when the raw detail mentions GitHub/repo.
    if (
      /github|repo_not_connected|Connect GitHub/i.test(raw)
    ) {
      return "Invalid request — refresh the page and try connecting GitHub again.";
    }
    // Prefer a short field-level hint when FastAPI returns the usual
    // ``[{loc, msg, ...}]`` detail array (stringified by fetchApi).
    const fieldHint = summarizeValidationDetail(raw);
    if (fieldHint) {
      return `Invalid request — ${fieldHint}`;
    }
    return "Invalid request — check the form and try again.";
  }
  if (status === 429) {
    return "Too many requests — please wait a moment and try again.";
  }

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
