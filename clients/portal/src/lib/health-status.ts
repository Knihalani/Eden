/**
 * Map backend `/health` JSON into auth-brand-panel UI states.
 *
 * Ops follow-up: prod Qdrant often reports ``error: [Errno 99] Cannot
 * assign requested address`` while Postgres stays connected. That is
 * infra networking, not a portal auth bug — surface ``degraded``, never
 * fake ``healthy``.
 */

export type HealthState = "ok" | "degraded" | "down" | "unknown";

/**
 * Soft degradation: Postgres is up (or body says ``degraded``) so the
 * product can run. Portal ``/api/health`` may rewrite upstream HTTP 503
 * → 200 for UI probes to avoid DevTools console noise on auth pages;
 * ``body.status`` stays ``degraded``.
 */
export function isSoftDegradedHealth(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as { status?: string; postgres?: string };
  const status = record.status?.toLowerCase();
  if (status === "degraded") return true;
  if (status === "unhealthy" || status === "down") return false;
  return record.postgres === "connected";
}

/**
 * Map a backend `/health` response body into one of four UI states.
 * The backend returns `{ status: "healthy" | "degraded" | "unhealthy" }`
 * and may use HTTP 503 for degraded (Postgres up, soft deps down).
 * Parse the body even on non-2xx — do not treat 503 alone as auth failure.
 */
export function mapHealth(body: unknown): HealthState {
  if (!body || typeof body !== "object") return "unknown";
  const record = body as { status?: string; postgres?: string };
  const status = record.status?.toLowerCase();
  if (status === "healthy" || status === "ok") return "ok";
  if (status === "degraded") return "degraded";
  if (status === "unhealthy" || status === "down") return "down";
  // Body without a known status but Postgres still connected → degraded
  // (soft dependency blip), not "unknown"/broken login.
  if (record.postgres === "connected") return "degraded";
  return "unknown";
}

/** Apply HTTP status + JSON body. Prefer body status over HTTP code. */
export function mapHealthResponse(
  httpStatus: number,
  body: unknown,
): HealthState {
  if (body && typeof body === "object") {
    return mapHealth(body);
  }
  if (httpStatus >= 500) return "down";
  if (!httpStatus || httpStatus >= 400) return "unknown";
  return "unknown";
}
