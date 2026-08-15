import { ApiError } from "@/lib/api/core";
import { isUserNotFoundRace } from "@/hooks/use-me-query";

/** Distinguishes session expiry (force re-auth) from transient server
 *  / degraded-backend failures (Retry only — keep org when known). */
export type AuthErrorKind = "session" | "server";

/**
 * Classify /auth/me failures for chrome: session → Sign in; server →
 * degraded messaging without forcing re-auth when the Clerk session
 * and known org are still valid. Soft infra (e.g. Qdrant Errno 99)
 * can make /health 503 while Postgres-backed /auth/me still works;
 * when /auth/me itself 5xxs, treat as server — not session expiry.
 */
export function classifyOrgLoadError(e: unknown): {
  kind: AuthErrorKind;
  message: string;
  clearOrg: boolean;
} {
  const status = e instanceof ApiError ? e.status : undefined;
  const detail = e instanceof ApiError ? e.detail : "";
  const rawMessage = e instanceof Error ? e.message : "Failed to load orgs";

  if (status === 401 || status === 403) {
    return {
      kind: "session",
      message: "Session expired. Please sign in again.",
      clearOrg: true,
    };
  }
  if (isUserNotFoundRace(e)) {
    return {
      kind: "server",
      message:
        "Setting up your account… If this takes more than a moment, refresh the page.",
      clearOrg: true,
    };
  }
  if (status === 404) {
    return {
      kind: "server",
      message: "We couldn't load your workspace. Please refresh.",
      clearOrg: false,
    };
  }
  if (status === 429) {
    return {
      kind: "server",
      message: "Too many requests — pausing briefly. Reload in a moment.",
      clearOrg: false,
    };
  }
  if (typeof status === "number" && status >= 500) {
    return {
      kind: "server",
      message:
        "Eden is having trouble reaching the server. Please try again in a moment.",
      clearOrg: false,
    };
  }
  if (
    /5\d\d|server\s*error|unreachable|timed?\s*out|bad\s*gateway|unexpected\s*error|internal\s*error/i.test(
      detail || rawMessage,
    )
  ) {
    return {
      kind: "server",
      message:
        "Eden is having trouble reaching the server. Please try again in a moment.",
      clearOrg: false,
    };
  }
  return { kind: "server", message: rawMessage, clearOrg: false };
}
