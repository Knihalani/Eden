import { NextResponse } from "next/server";

/**
 * Standard error response for proxy route handlers. Preserves a 401 from
 * the backend (so the client's ``setUnauthorizedHandler`` can react)
 * instead of collapsing every failure to a generic 500.
 *
 * F35 fix (July 2026): the previous implementation only matched the
 * exact string ``"Not authenticated"`` — a string-match the upstream
 * never produces on its own. The actual FastAPI 401 detail strings
 * we see in production are ``"Not authenticated"``, ``"Invalid or
 * expired token"``, ``"Token has expired"``, ``"Session expired"``,
 * etc. Match those (case-insensitive) so the portal's sign-in prompt
 * actually triggers when the backend rejects a session. The fallback
 * remains a 500 for genuinely unexpected errors.
 */
/**
 * Retry-After header parser. Returns the suggested wait in
 * milliseconds, or ``null`` when the header is absent or
 * unparseable. Supports both delta-seconds (``Retry-After: 5``)
 * and the RFC 7231 HTTP-date form
 * (``Retry-After: Wed, 21 Oct 2015 07:28:00 GMT``).
 *
 * Caps the value at 60s so a misconfigured upstream can't pin a
 * Next.js worker on a 6-hour sleep. Returns 0 (immediate) for
 * ``Retry-After: 0`` so callers can use the value directly in a
 * ``setTimeout`` without special-casing.
 */
export function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) {
    return Math.min(asNum * 1000, 60_000);
  }
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    return Math.min(Math.max(asDate - Date.now(), 0), 60_000);
  }
  return null;
}

/** Default cooldown when ``Retry-After`` is absent on a 429.
 *  Conservative — a throttled upstream won't want to be
 *  re-pinged within hundreds of milliseconds. */
export const RETRY_AFTER_DEFAULT_MS = 5_000;

export function proxyError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const isAuthFailure =
    /not\s*authenticated|session\s*expired|invalid\s*or\s*expired\s*token|token\s*(has\s*)?expired|unauthor(ized|ised)/i.test(
      message,
    );
  const status = isAuthFailure ? 401 : 500;
  return NextResponse.json({ detail: message }, { status });
}

// Server-side resolution of the FastAPI upstream. The catch-all proxy
// at /api/proxy/[...path] uses this to forward requests.
//
// Node's native fetch needs an absolute URL — it does NOT accept
// relative paths like `/api/proxy`. So we must NOT fall back to the
// client-safe NEXT_PUBLIC_API_URL (which is `/api/proxy` in production
// to keep the request same-origin). Order of precedence:
//   1. API_INTERNAL_URL — preferred, never exposed to the client.
//   2. localhost:8000 — dev default; matches FastAPI's default port.
// We explicitly drop NEXT_PUBLIC_API_URL from the lookup because it
// would crash server-side fetches when set to `/api/proxy`.
const API_BASE =
  process.env.API_INTERNAL_URL || "http://localhost:8000";

/**
 * In-memory circuit breaker for upstream fetch failures (LP-21).
 *
 * After ``CIRCUIT_FAILURE_THRESHOLD`` consecutive network/timeout
 * failures, short-circuit with 503 + Retry-After for
 * ``CIRCUIT_COOLDOWN_MS``. State is per Vercel isolate — cold starts
 * reset the counters (documented trade-off; Redis would be shared
 * but adds latency on every proxy hop).
 */
export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MS = 45_000;
export const CIRCUIT_RETRY_AFTER_S = 45;

let consecutiveFetchFailures = 0;
let circuitOpenUntilMs = 0;

/** Test-only: reset circuit breaker state between vitest cases. */
export function __resetProxyCircuitBreakerForTests(): void {
  consecutiveFetchFailures = 0;
  circuitOpenUntilMs = 0;
}

function circuitIsOpen(now = Date.now()): boolean {
  return now < circuitOpenUntilMs;
}

function recordFetchFailure(now = Date.now()): void {
  consecutiveFetchFailures += 1;
  if (consecutiveFetchFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitOpenUntilMs = now + CIRCUIT_COOLDOWN_MS;
  }
}

function recordFetchSuccess(): void {
  consecutiveFetchFailures = 0;
  circuitOpenUntilMs = 0;
}

interface ForwardOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Pre-serialized request body. The catch-all route reads the raw
   * text from ``request.text()`` and passes a string through;
   * leaving the type loose so FormData callers (avatar/reference/
   * agent-upload) compile even though the runtime path doesn't
   * serialize multipart bodies today.
   */
  body?: unknown;
  cookieHeader?: string;
  extraHeaders?: Record<string, string>;
  /** Pre-built ``Authorization`` header value (e.g. ``Bearer <jwt>``). */
  authorization?: string;
  /**
   * Caller-supplied request id (the ``X-Request-ID`` header value
   * from the inbound request, if any). Echoed into the 502 body
   * when the upstream is unreachable so support can correlate the
   * user's bug report with a server-side log entry. Falls back to
   * ``crypto.randomUUID()`` if the caller doesn't supply one. July
   * 2026 site-wide fix.
   */
  requestId?: string;
  /**
   * Set to ``true`` for SSE / long-lived streamed responses. Skips
   * the 25s AbortSignal timeout (PT-10) so the upstream can keep the
   * connection open for minutes. The client-side ``EventSource``
   * tears the connection down on unmount, not the server.
   */
  stream?: boolean;
}

/**
 * Forward a request to FastAPI and return a NextResponse that carries over
 * the backend's Set-Cookie headers. Use this in auth proxy routes — the
 * shared `api.ts` client discards response headers, which would drop the
 * session cookie and leave the browser unauthenticated after login.
 */
export async function forwardToBackend(
  path: string,
  options: ForwardOptions = {}
): Promise<NextResponse> {
  const {
    method = "POST",
    body,
    cookieHeader,
    extraHeaders,
    authorization,
    requestId: requestIdIn,
    stream,
  } = options;
  // Echo the inbound ``X-Request-ID`` (or a freshly-generated UUID)
  // into the 502 body so support can correlate "user saw this error"
  // with a server-side log entry. Generated here (not at import time)
  // so every failed call gets a distinct id.
  const requestId =
    requestIdIn ||
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  // Circuit open → 503 without hitting upstream (LP-21).
  if (circuitIsOpen()) {
    const retryAfterS = Math.max(
      1,
      Math.ceil((circuitOpenUntilMs - Date.now()) / 1000),
    );
    return NextResponse.json(
      {
        detail: "Backend circuit open",
        upstream: API_BASE,
        path,
        request_id: requestId,
        retry_after_s: retryAfterS,
      },
      {
        status: 503,
        headers: {
          "Retry-After": String(retryAfterS),
          "X-Request-ID": requestId,
        },
      },
    );
  }

  // Body-type guard (PT-6). Multipart (FormData) bodies need
  // ``Content-Type: multipart/form-data; boundary=...`` derived
  // automatically by WHATWG fetch — pre-setting ``application/json``
  // here would refuse the upload at the upstream with a 415.
  // Streamed bodies (``ReadableStream``) have no Content-Type to
  // pre-set. JSON gets the default. Caller-supplied ``extraHeaders``
  // still win (override semantics preserved).
  const isStream = stream === true;
  const isForm = body instanceof FormData;
  const headers: Record<string, string> = {};
  if (!isStream && !isForm) {
    headers["Content-Type"] = "application/json";
  }
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  if (authorization) headers["Authorization"] = authorization;
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      // Allow caller to override Content-Type for non-JSON bodies.
      headers[k] = v;
    }
  }

  // 25s hard timeout for non-streaming requests (PT-10). SSE streams
  // are long-lived by design — the client-side ``EventSource`` /
  // ``AbortController`` in lib/api.ts tears the connection down on
  // unmount, not the server. Forcing a 25s abort here would kill
  // every active trace stream mid-event.
  const fetchInit: RequestInit = {
    method,
    headers,
    // ``body`` arrives from the catch-all route handler as either a
    // raw string (already JSON, from request.text()) or undefined.
    // Stringifying again would wrap the JSON string in extra quotes
    // ("\"{\"email\":...}\"") and FastAPI would reject it as a string
    // where an object is expected. Pass through as-is. (Multipart
    // bodies still don't survive the text() read upstream; that's a
    // separate gap.)
    body: body as BodyInit | null | undefined,
  };
  if (!isStream) {
    fetchInit.signal = AbortSignal.timeout(25_000);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, fetchInit);
  } catch (error) {
    // Network-level failure: DNS resolution, connection refused, TLS
    // handshake, timeout, or pod restart. Surface as 502 Bad Gateway
    // (the standard code for "upstream is down") with a clear
    // ``detail`` so the portal can show "Backend unreachable" instead
    // of a generic 500. Counts toward the circuit breaker (LP-21).
    recordFetchFailure();
    const message =
      error instanceof Error ? error.message : "Unknown fetch error";
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" || /aborted|timeout/i.test(message));
    return NextResponse.json(
      {
        detail: isAbort
          ? "Backend timed out"
          : "Backend unreachable",
        upstream: API_BASE,
        path,
        cause: message,
        request_id: requestId,
      },
      {
        status: 502,
        headers: { "X-Request-ID": requestId },
      },
    );
  }

  recordFetchSuccess();

  // Read the body once — clone before reading so the body is also available
  // for forwarding set-cookie logic.
  const responseBody = await response.text();
  let parsed: unknown = null;
  if (responseBody) {
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      parsed = { detail: responseBody };
    }
  }

  // Echo request_id on pass-through upstream 5xx so support can
  // correlate browser errors with proxy logs (LP-21). Upstream HTTP
  // errors do NOT trip the circuit — only fetch failures do.
  if (
    response.status >= 500 &&
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    !("request_id" in (parsed as Record<string, unknown>))
  ) {
    (parsed as Record<string, unknown>).request_id = requestId;
  }

  const nextResponse = NextResponse.json(parsed ?? {}, {
    status: response.status,
  });

  // Safe-by-default cache headers. Every proxy response is
  // auth-scoped — caching it on a shared edge / CDN would risk
  // serving user A's data to user B. ``Vary: Cookie, Authorization``
  // tells intermediates to key their cache on the auth headers, and
  // ``Cache-Control: private, no-store`` tells them not to store it
  // at all (browsers will still cache briefly for back/forward nav
  // via the per-user history stack, which is what we want).
  // June 2026 cost-pass — without this, a misconfigured upstream
  // ``Cache-Control: public, max-age=300`` would silently leak.
  nextResponse.headers.set("Vary", "Cookie, Authorization");
  nextResponse.headers.set("Cache-Control", "private, no-store");
  nextResponse.headers.set("X-Request-ID", requestId);

  // Forward every Set-Cookie header from FastAPI. Next.js's
  // NextResponse.cookies is the supported path — using `headers.append`
  // directly would emit duplicate Set-Cookie headers with the same name.
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const [pair, ...attrs] = cookie.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    nextResponse.cookies.set({
      name,
      value,
      httpOnly: attrs.some((a) => a.toLowerCase() === "httponly"),
      secure: attrs.some((a) => a.toLowerCase() === "secure"),
      sameSite: (attrs.find((a) => a.toLowerCase().startsWith("samesite="))?.split("=")[1] ?? "lax") as "lax" | "strict" | "none",
      path: attrs.find((a) => a.toLowerCase().startsWith("path="))?.split("=")[1] ?? "/",
      maxAge: Number(attrs.find((a) => a.toLowerCase().startsWith("max-age="))?.split("=")[1] ?? "0") || undefined,
    });
  }

  return nextResponse;
}
