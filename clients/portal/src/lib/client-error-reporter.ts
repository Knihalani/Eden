/**
 * Client-error reporter — "Eden runs on Eden".
 *
 * The portal's error boundaries used to only ``console.error``; this
 * module ships those client errors into Eden's own ingest pipeline so
 * portal crashes show up in the product like any customer's app events.
 *
 * Transport: POST to the portal-local ``/api/client-errors`` route
 * (see ``src/app/api/client-errors/route.ts``), which resolves the
 * Clerk session org **server-side** and forwards the event to the
 * FastAPI backend's existing ``POST /orgs/{org_id}/ingest/app``
 * endpoint. The browser never sees an API key and never needs to know
 * the org id — critical because error boundaries (especially
 * ``global-error.tsx``) render without the portal's React providers.
 *
 * Guarantees:
 * - Fire-and-forget: never throws, never blocks render, response is
 *   ignored (``navigator.sendBeacon`` preferred, ``fetch`` with
 *   ``keepalive`` as fallback).
 * - Dedupe: identical errors (same boundary + digest/message + route)
 *   are reported once per page session.
 */

import { PRODUCT_VERSION } from "@/lib/constants";

/** Which error boundary caught the error. */
export type ClientErrorBoundary = "portal" | "marketing" | "global";

/** Portal-local endpoint that forwards into Eden's app-event ingest. */
export const CLIENT_ERRORS_ENDPOINT = "/api/client-errors";

const MESSAGE_MAX = 1_000;
const STACK_MAX = 4_000;
const DEDUPE_MAX = 100;
const SESSION_STORAGE_KEY = "eden:client-error-session";

/** Errors already reported this page session (module lifetime). */
const reported = new Set<string>();

/** Test-only: clear the per-session dedupe set between vitest cases. */
export function __resetClientErrorReporterForTests(): void {
  reported.clear();
}

/** Stable per-tab session id so repeated errors group in Eden. */
function sessionId(): string | undefined {
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // private mode / blocked storage — report without a session id
    return undefined;
  }
}

/**
 * Report a client error to Eden. Safe to call from any error
 * boundary: never throws, silently no-ops on the server, and dedupes
 * repeats of the same error per session.
 */
export function reportClientError(
  boundary: ClientErrorBoundary,
  error: unknown,
): void {
  try {
    if (typeof window === "undefined") return;

    const err = error as (Error & { digest?: string }) | null | undefined;
    const message = (
      (typeof err?.message === "string" && err.message) ||
      (typeof error === "string" && error) ||
      "Unknown client error"
    ).slice(0, MESSAGE_MAX);
    const digest =
      typeof err?.digest === "string" && err.digest ? err.digest : undefined;
    const stack =
      typeof err?.stack === "string" && err.stack
        ? err.stack.slice(0, STACK_MAX)
        : undefined;
    const route = window.location?.pathname || "/";

    // Dedupe identical errors per session. Digest (Next's stable
    // server hash) wins when present; message otherwise.
    const key = `${boundary}|${digest ?? message}|${route}`;
    if (reported.has(key)) return;
    if (reported.size >= DEDUPE_MAX) reported.clear();
    reported.add(key);

    const payload = JSON.stringify({
      message,
      stack,
      digest,
      boundary,
      route,
      userAgent:
        typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      release: PRODUCT_VERSION,
      sessionId: sessionId(),
      ts: new Date().toISOString(),
    });

    // Prefer sendBeacon — queued by the browser, survives navigation
    // away from the crashed page. Same-origin, so cookies (Clerk
    // session) ride along for the server-side org resolution.
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      const ok = navigator.sendBeacon(
        CLIENT_ERRORS_ENDPOINT,
        new Blob([payload], { type: "application/json" }),
      );
      if (ok) return;
    }

    // Fallback: keepalive fetch — fire-and-forget, swallow everything.
    void fetch(CLIENT_ERRORS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Reporting must never break the error UI.
  }
}
