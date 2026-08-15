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
 * actually triggers when the backend rejects a session.
 *
 * W3-C: transient transport failures (timeout / ECONNREFUSED / circuit
 * open) map to 502/503 with clear ``detail`` instead of opaque 500.
 * Only genuinely unexpected errors remain 500.
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

/**
 * Upstream headers that carry throttling / quota information and
 * must survive the JSON round-trip through ``NextResponse.json``.
 * ``Retry-After`` drives the client's 429 backoff (see
 * ``retryAfterMs`` above); the ``X-RateLimit-*`` triad lets callers
 * that inspect headers directly (rather than the JSON body) see
 * quota state without an extra round-trip.
 */
export const RATE_LIMIT_HEADERS = [
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
] as const;

/** Auth-failure detail strings FastAPI (and friends) emit as 401. */
export const PROXY_AUTH_FAILURE_RE =
  /not\s*authenticated|session\s*expired|invalid\s*or\s*expired\s*token|token\s*(has\s*)?expired|unauthor(ized|ised)/i;

/** Network / DNS / connection failures → 502 Bad Gateway. */
const PROXY_NETWORK_FAILURE_RE =
  /econnrefused|enotfound|econnreset|fetch failed|network|socket hang up|unreachable|eai_again|ehostunreach/i;

/** Upstream outage / circuit signals → 503 Service Unavailable. */
const PROXY_UPSTREAM_DOWN_RE =
  /circuit\s*open|no\s*healthy\s*upstream|backend\s*unavailable|upstream\s*(unavailable|connect\s*error)/i;

/**
 * Map a thrown proxy/stream error to a statused JSON envelope.
 *
 * - Auth detail strings → 401 (F35: do not collapse real auth into 500)
 * - Timeout / abort → 502 ``Backend timed out``
 * - Network refuse / DNS → 502 ``Backend unreachable``
 * - Circuit / no-healthy-upstream wording → 503
 * - Everything else → 500 with the original message
 *
 * Every envelope carries ``request_id`` + ``X-Request-ID`` so residual
 * 500s are still correlatable (Wave 1 ``proxy-error-taxonomy``).
 */
export function proxyError(
  error: unknown,
  fallback: string,
  requestOrId?: Request | string,
) {
  const requestId =
    typeof requestOrId === "string"
      ? requestOrId
      : proxyRequestId(requestOrId);
  const headers: Record<string, string> = { "X-Request-ID": requestId };
  const message = error instanceof Error ? error.message : fallback;
  if (PROXY_AUTH_FAILURE_RE.test(message)) {
    return NextResponse.json(
      { detail: message, request_id: requestId },
      { status: 401, headers },
    );
  }

  const isAbort =
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|timeout|timed\s*out/i.test(message));
  if (isAbort) {
    return NextResponse.json(
      { detail: "Backend timed out", cause: message, request_id: requestId },
      { status: 502, headers },
    );
  }

  if (PROXY_NETWORK_FAILURE_RE.test(message)) {
    return NextResponse.json(
      { detail: "Backend unreachable", cause: message, request_id: requestId },
      { status: 502, headers },
    );
  }

  if (PROXY_UPSTREAM_DOWN_RE.test(message)) {
    return NextResponse.json(
      { detail: message, request_id: requestId },
      { status: 503, headers },
    );
  }

  return NextResponse.json(
    { detail: message, request_id: requestId },
    { status: 500, headers },
  );
}

/**
 * Resolve a correlatable request id from inbound headers (or mint one).
 * Shared by dedicated SSE stream proxies and ``forwardToBackend``.
 */
export function proxyRequestId(request?: Request): string {
  const fromHeader =
    request?.headers.get("x-request-id") ||
    request?.headers.get("x-correlation-id");
  if (fromHeader) return fromHeader;
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * JSON envelope for dedicated stream-route handshake failures
 * (observability SSE / live trace events). Network-level failures
 * become 502 with a clear detail; known upstream status codes pass
 * through with structured JSON instead of an opaque 500.
 */
export function streamHandshakeFailure(options: {
  request?: Request;
  error?: unknown;
  upstreamStatus?: number;
  upstreamDetail?: string;
  fallbackDetail: string;
}): NextResponse {
  const requestId = proxyRequestId(options.request);
  const headers: Record<string, string> = { "X-Request-ID": requestId };
  const upstreamStatus = options.upstreamStatus;

  if (typeof upstreamStatus === "number" && upstreamStatus > 0) {
    const isTransient = upstreamStatus === 502 || upstreamStatus === 503;
    const detail =
      options.upstreamDetail ||
      (isTransient ? "Backend unavailable" : options.fallbackDetail);
    if (upstreamStatus === 503) {
      headers["Retry-After"] = String(CIRCUIT_RETRY_AFTER_S);
    }
    return NextResponse.json(
      {
        detail,
        upstream_status: upstreamStatus,
        request_id: requestId,
      },
      { status: upstreamStatus, headers },
    );
  }

  const cause =
    options.error instanceof Error ? options.error.message : undefined;
  const mapped = proxyError(
    options.error ?? new Error(options.fallbackDetail),
    options.fallbackDetail,
    options.request,
  );
  // Stream connect failures without an upstream status are transport
  // problems — promote opaque 500 → 502 so clients back off cleanly.
  const status = mapped.status === 500 ? 502 : mapped.status;
  const detail =
    status === 502
      ? cause && /aborted|timeout|timed\s*out/i.test(cause)
        ? "Backend timed out"
        : "Backend unreachable"
      : status === 401 && cause
        ? cause
        : options.fallbackDetail;

  return NextResponse.json(
    {
      detail,
      ...(cause && status === 502 ? { cause } : {}),
      request_id: requestId,
    },
    { status, headers },
  );
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
if (
  process.env.VERCEL_ENV === "production" &&
  !process.env.API_INTERNAL_URL
) {
  // Fatal: silent localhost fallback would black-hole every portal
  // API call in production. Fail at module load so the deploy is
  // obviously broken instead of serving 502s to every user.
  const msg =
    "[portal] FATAL: API_INTERNAL_URL is required when VERCEL_ENV=production";
  console.error(msg);
  throw new Error(msg);
}
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

/**
 * Handshake failure for dedicated SSE proxies and the catch-all
 * ``Accept: text/event-stream`` branch. Preserves FastAPI
 * ``{error, detail, request_id}`` envelopes (Wave 1.5) instead of
 * collapsing them into ``{detail, upstream_status, request_id}``
 * with a freshly minted portal id.
 */
export async function streamHandshakeFromUpstream(options: {
  request?: Request;
  upstream: Response;
  fallbackDetail: string;
}): Promise<Response> {
  const requestId = proxyRequestId(options.request);
  const failureHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Request-ID": requestId,
  };
  const retryAfter = options.upstream.headers.get("Retry-After");
  if (retryAfter) {
    failureHeaders["Retry-After"] = retryAfter;
  } else if (options.upstream.status === 503) {
    failureHeaders["Retry-After"] = String(CIRCUIT_RETRY_AFTER_S);
  }

  let envelope: Record<string, unknown> | null = null;
  try {
    const text = await options.upstream.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        ) {
          envelope = parsed as Record<string, unknown>;
        } else {
          envelope = { detail: text };
        }
      } catch {
        envelope = { detail: text.slice(0, 200) };
      }
    }
  } catch {
    envelope = null;
  }

  if (envelope) {
    if (envelope.request_id == null || envelope.request_id === "") {
      envelope.request_id = requestId;
    } else if (typeof envelope.request_id === "string") {
      failureHeaders["X-Request-ID"] = envelope.request_id;
    }
    return new Response(JSON.stringify(envelope), {
      status: options.upstream.status || 502,
      headers: failureHeaders,
    });
  }

  return streamHandshakeFailure({
    request: options.request,
    upstreamStatus: options.upstream.status || 502,
    fallbackDetail: options.fallbackDetail,
  });
}

/**
 * Pipe an upstream SSE body to the browser with keep-alive comments
 * and abort-aware cleanup. ``cancel`` / ``signal`` abort cancels the
 * upstream reader so FastAPI sees the disconnect instead of leaking
 * a Redis pub/sub worker until maxDuration.
 */
export function pipeSseUpstream(
  upstream: Response,
  options?: { heartbeatMs?: number; signal?: AbortSignal },
): Response {
  const HEARTBEAT_MS = options?.heartbeatMs ?? 15_000;
  const HEARTBEAT_BYTES = new TextEncoder().encode(": keepalive\n\n");
  const clientSignal = options?.signal;

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = upstream.body?.getReader() ?? null;
      if (!reader) {
        controller.close();
        return;
      }

      const onAbort = () => {
        stopHeartbeat();
        void reader?.cancel().catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      if (clientSignal) {
        if (clientSignal.aborted) {
          onAbort();
          return;
        }
        clientSignal.addEventListener("abort", onAbort, { once: true });
      }

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(HEARTBEAT_BYTES);
        } catch {
          onAbort();
        }
      }, HEARTBEAT_MS);

      try {
        while (true) {
          if (clientSignal?.aborted) {
            onAbort();
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            stopHeartbeat();
            controller.close();
            break;
          }
          controller.enqueue(value);
        }
      } catch (err) {
        stopHeartbeat();
        // Mirror ai-insights/chat: emit SSE `event: error` before tearing
        // down so clients are not left stuck in a connected/streaming state.
        const msg =
          err instanceof Error ? err.message : "stream interrupted";
        try {
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ detail: msg })}\n\n`,
            ),
          );
        } catch {
          /* controller already closed by the runtime */
        }
        try {
          controller.error(err);
        } catch {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      } finally {
        if (clientSignal) {
          clientSignal.removeEventListener("abort", onAbort);
        }
      }
    },
    cancel() {
      stopHeartbeat();
      return reader?.cancel().then(() => undefined, () => undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Upstream bodies that mean "the load balancer has zero healthy
 * pods" (Northflank / Envoy / Fly ingress). The proxy used to
 * forward these as opaque 503s; the portal then retried them as
 * generic 5xx and amplified a total outage into a console storm.
 * Match case-insensitively so we normalise every variant.
 */
export const UPSTREAM_DOWN_DETAIL_RE =
  /no\s*healthy\s*upstream|upstream\s*(unavailable|connect\s*error)|backend\s*(circuit\s*open|unreachable|timed?\s*out|unavailable)/i;

/** True when a status + detail pair means "do not retry / amplify". */
export function isUpstreamDownDetail(
  status: number,
  detail: unknown,
): boolean {
  if (status !== 502 && status !== 503) return false;
  const text =
    typeof detail === "string"
      ? detail
      : detail == null
        ? ""
        : JSON.stringify(detail);
  return UPSTREAM_DOWN_DETAIL_RE.test(text);
}

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

/**
 * Coerce ``forwardToBackend`` body values into a fetch-compatible
 * ``BodyInit``. Plain objects/arrays become JSON strings; strings and
 * binary/multipart types pass through unchanged.
 */
function serializeForwardBody(
  body: unknown,
): BodyInit | null | undefined {
  if (body == null) return body as null | undefined;
  if (typeof body === "string") return body;
  if (typeof body !== "object") return String(body);
  if (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof ReadableStream !== "undefined" &&
      body instanceof ReadableStream) ||
    (typeof URLSearchParams !== "undefined" &&
      body instanceof URLSearchParams)
  ) {
    return body as BodyInit;
  }
  return JSON.stringify(body);
}

interface ForwardOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Request body. Strings pass through as-is (catch-all proxy uses
   * ``request.text()``). Plain objects/arrays are JSON.stringified.
   * FormData / Blob / ArrayBuffer / ReadableStream pass through for
   * multipart and streaming callers.
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
  // Use Headers.set() (case-insensitive overwrite). A plain object with
  // both ``Content-Type`` and ``content-type`` made Undici emit
  // ``application/json, application/json``, and FastAPI then treated the
  // JSON body as a string → 422 on routes like github claim.
  const headers = new Headers();
  headers.set("X-Request-ID", requestId);
  if (!isStream && !isForm) {
    headers.set("Content-Type", "application/json");
  }
  if (cookieHeader) headers.set("Cookie", cookieHeader);
  if (authorization) headers.set("Authorization", authorization);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      const lower = k.toLowerCase();
      // Do not let a blank inbound id wipe the stamped request id.
      if (
        (lower === "x-request-id" || lower === "x-correlation-id") &&
        !v
      ) {
        continue;
      }
      headers.set(k, v);
    }
  }
  if (!headers.get("X-Request-ID")) {
    headers.set("X-Request-ID", requestId);
  }
  // Let fetch set multipart boundary — a pre-set Content-Type breaks uploads.
  if (isForm) {
    headers.delete("Content-Type");
  }

  // Serialize the body for fetch. Strings / FormData / Blob /
  // ArrayBuffer / TypedArray / ReadableStream / URLSearchParams
  // pass through. Plain objects and arrays (e.g. PR-suggestion
  // routes that pass ``await request.json()``) are JSON.stringified
  // — Node fetch rejects bare objects as BodyInit and would 5xx.
  // Do NOT stringify strings: the catch-all proxy already reads
  // ``request.text()`` and re-stringifying would wrap JSON in quotes.
  const fetchBody = serializeForwardBody(body);

  // 25s hard timeout for non-streaming requests (PT-10). SSE streams
  // are long-lived by design — the client-side ``EventSource`` /
  // ``AbortController`` in lib/api.ts tears the connection down on
  // unmount, not the server. Forcing a 25s abort here would kill
  // every active trace stream mid-event.
  const fetchInit: RequestInit = {
    method,
    headers,
    body: fetchBody,
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

  // Pass FastAPI ``{error, detail, request_id}`` envelopes through
  // unchanged. Never re-wrap ``internal_error`` into a bare
  // ``{detail: ...}`` that drops ``error`` / ``request_id``.
  // Empty upstream 5xx bodies still get a correlatable envelope.
  if (response.status >= 500 && (parsed === null || parsed === undefined)) {
    parsed = {
      error: "internal_error",
      detail: "Upstream error",
      request_id: requestId,
    };
  }

  // Normalise load-balancer "no healthy upstream" (and friends) into
  // a stable JSON envelope the client can detect without string-
  // matching every vendor's wording. July 2026 — production was
  // returning plain-text ``no healthy upstream`` from the Northflank
  // ingress when /ready failed; the portal retried those 503s as
  // generic 5xx and spammed auth/me + notifications.
  if (
    response.status === 503 &&
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    const detail = (parsed as Record<string, unknown>).detail;
    if (isUpstreamDownDetail(503, detail)) {
      (parsed as Record<string, unknown>).detail = "Backend unavailable";
      (parsed as Record<string, unknown>).upstream_down = true;
    }
  }

  // Echo request_id on pass-through upstream 5xx so support can
  // correlate browser errors with proxy logs (LP-21). Upstream HTTP
  // errors do NOT trip the circuit — only fetch failures do.
  // Prefer the upstream's own request_id when present (FastAPI
  // ``internal_error`` already stamps one).
  if (
    response.status >= 500 &&
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  ) {
    const obj = parsed as Record<string, unknown>;
    if (
      !("request_id" in obj) ||
      obj.request_id == null ||
      obj.request_id === ""
    ) {
      obj.request_id = requestId;
    }
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
  const bodyRequestId =
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).request_id === "string"
      ? ((parsed as Record<string, unknown>).request_id as string)
      : requestId;
  nextResponse.headers.set("X-Request-ID", bodyRequestId);

  // When the LB reports zero healthy pods, advertise a Retry-After
  // so clients back off instead of hammering the dead upstream.
  if (
    response.status === 503 &&
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as Record<string, unknown>).upstream_down === true &&
    !response.headers.get("Retry-After")
  ) {
    nextResponse.headers.set("Retry-After", String(CIRCUIT_RETRY_AFTER_S));
  }

  // Forward throttling / rate-limit headers verbatim (F37 fix). The
  // browser-side ``fetchApi`` (lib/api.ts) reads ``Retry-After`` off
  // the response it gets from *this* proxy route — not the upstream
  // response — to honor the backend's advertised 429 cooldown. Before
  // this fix, ``NextResponse.json`` only carried the status code
  // through; every 429 hint from FastAPI was silently dropped and
  // the client always fell back to the generic 5s default, which
  // both under- and over-shoots the upstream's real cooldown.
  for (const name of RATE_LIMIT_HEADERS) {
    const value = response.headers.get(name);
    if (value) nextResponse.headers.set(name, value);
  }

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
