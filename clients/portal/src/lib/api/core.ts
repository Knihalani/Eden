// API routing. The portal's frontend calls go through the catch-all
// proxy at `/api/proxy/[...path]` (defined in
// `src/app/api/proxy/[...path]/route.ts`), which forwards to FastAPI.
// This keeps the request same-origin so the session cookie is sent
// automatically under SameSite=Lax (Vercel → Northflank is
// cross-origin and would otherwise block the cookie).
//
// Order of precedence:
//   1. NEXT_PUBLIC_API_URL — set at build time. In production this
//      is `/api/proxy`; in dev it can be `http://localhost:8000`
//      to bypass the proxy for live FastAPI debugging.
//   2. `/api/proxy` — the safe default. Works in dev (Next.js dev
//      server proxies to localhost:8000 via the route handler) and
//      in production (Vercel → Northflank via the env-configured
//      upstream).
import {
  retryAfterMs,
  RETRY_AFTER_DEFAULT_MS,
} from "@/lib/proxy";
import { toUserFacingError } from "@/lib/safe-error-message";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "/api/proxy";

/**
 * Typed error thrown by ``fetchApi`` (and every portal-side API
 * wrapper) when the upstream returns a non-2xx response. Carries
 * the HTTP status so callers can branch on it without parsing
 * the message string:
 *
 *   try { await agentsApi.list() }
 *   catch (err) {
 *     if (err instanceof ApiError && err.status === 401) {
 *       // signed out — redirect to /sign-in
 *     } else if (err instanceof ApiError && err.status === 403) {
 *       // forbidden
 *     } else {
 *       throw err;
 *     }
 *   }
 *
 * ``message`` is user-facing (sanitized). ``detail`` preserves the
 * raw upstream ``detail`` string for machine matching (retries,
 * feature-flag detection) so sanitize cannot erase signals like
 * ``User not found``.
 *
 * Extends ``Error`` so existing ``err instanceof Error`` /
 * ``err.message`` checks continue to work.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Raw upstream detail (unsanitized) for machine matching. */
  readonly detail: string;
  /** Optional machine code from structured upstream bodies. */
  readonly code?: string;
  /** Cooldown hint from ``Retry-After`` / body ``retry_after`` (ms). */
  readonly retryAfterMs?: number;
  constructor(
    status: number,
    message: string,
    detail?: string,
    code?: string,
    retryAfterMs?: number,
  ) {
    super(message || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail ?? message;
    if (code) this.code = code;
    if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

// Default timeout. SSE streams pass `stream: true` in options to
// opt out — otherwise the timeout would close a long-lived
// Server-Sent-Events connection.
const DEFAULT_TIMEOUT_MS = 30_000;

// In-flight GET request de-duplication. Multiple React components
// mounting simultaneously used to fire N identical requests; the
// pending-promise map collapses them into one.
const inflight = new Map<string, Promise<unknown>>();

/** Test-only: clear in-flight GET dedup map between vitest cases. */
export function __resetFetchApiInflightForTests(): void {
  inflight.clear();
}

function dedupKey(
  method: string,
  endpoint: string,
  body: unknown,
  // F41: a JSON-mode and a blob/stream-mode (or raw-response-mode)
  // request to the identical GET URL+body must NOT collapse into one
  // shared in-flight promise — they hand back incompatible runtime
  // shapes (parsed JSON vs Blob vs a live, unread Response) to
  // whichever caller didn't originate the fetch. Fold both flags into
  // the key so they get independent dedup slots.
  stream?: boolean,
  raw?: boolean,
): string {
  const modeSuffix = `${stream ? "|stream" : ""}${raw ? "|raw" : ""}`;
  // P17: skip stringify when body is absent (common GET path).
  if (body == null || body === "") {
    return `${method} ${endpoint}${modeSuffix}`;
  }
  if (typeof body === "string") {
    return `${method} ${endpoint} ${body}${modeSuffix}`;
  }
  return `${method} ${endpoint} ${JSON.stringify(body)}${modeSuffix}`;
}

/**
 * Combine an internal (timeout) abort signal with a caller-supplied
 * one so aborting *either* aborts the outgoing fetch. Prefers the
 * native ``AbortSignal.any`` where available; falls back to a manual
 * listener pair otherwise (older Safari/Firefox in our browserslist
 * range predate ``AbortSignal.any``).
 */
function combineSignals(
  internal: AbortSignal,
  caller: AbortSignal | null | undefined,
): AbortSignal {
  if (!caller) return internal;
  const anyFn = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anyFn === "function") {
    return anyFn([internal, caller]);
  }
  const combined = new AbortController();
  if (internal.aborted) {
    combined.abort((internal as { reason?: unknown }).reason);
  } else if (caller.aborted) {
    combined.abort((caller as { reason?: unknown }).reason);
  } else {
    const onInternalAbort = () => {
      combined.abort((internal as { reason?: unknown }).reason);
    };
    const onCallerAbort = () => {
      combined.abort((caller as { reason?: unknown }).reason);
    };
    internal.addEventListener("abort", onInternalAbort, { once: true });
    caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  return combined.signal;
}

interface FetchOptions extends RequestInit {
  credentials?: "include" | "omit";
  /** Disable the 30s default timeout. Used for SSE streams. */
  stream?: boolean;
  /** Skip the in-flight de-duplication. Used for non-idempotent POSTs. */
  noDedup?: boolean;
  /**
   * Return the live, unparsed ``Response`` instead of running the
   * JSON/blob/text body-consumption path. Still runs the shared
   * auth-header-attach + timeout + retry pipeline (honoring
   * ``stream`` to also skip the 30s timeout for long-lived reads).
   * The caller owns body consumption (``res.body.getReader()``,
   * ``res.ok`` checks, etc.) — used for hand-rolled SSE readers and
   * status-code probes that previously bypassed ``fetchApi``
   * entirely via a raw ``fetch()`` call.
   */
  raw?: boolean;
  /**
   * Soft background polls (Inbox badge, etc.): still throw ApiError on
   * 401 after refresh retry, but do **not** broadcast session-expired
   * chrome — a JWT race on a non-critical GET must not kick the user.
   */
  softAuth?: boolean;
}

export async function fetchApi<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const {
    credentials = "include",
    headers,
    body,
    stream,
    noDedup,
    raw,
    softAuth,
    signal: callerSignal,
    ...rest
  } = options;
  const method = (rest.method as string | undefined) ?? "GET";

  // In-flight dedup. Only safe for idempotent methods (GET / HEAD /
  // OPTIONS). POSTs and friends always go through.
  if (!noDedup && (method === "GET" || method === "HEAD" || method === "OPTIONS")) {
    const key = dedupKey(method, endpoint, body, stream, raw);
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
  }

  // One-shot 401 retry. Clerk rotates the session JWT on a
  // background timer; a stale token from a long-lived tab can land
  // a 401 even though the user is still signed in. On a 401 we ask
  // Clerk to force-refresh, retry exactly once, and otherwise
  // surface the original error.
  //
  // Implementation note: ``useAuth()`` is a React hook and CANNOT
  // be called from a non-component context (it throws "Invalid hook
  // call" when the React dispatcher isn't bound). We use the Clerk
  // browser SDK directly via the global ``window.Clerk`` instance
  // that ``<ClerkProvider>`` injects on mount — that's the
  // documented imperative escape hatch for cases like ours where
  // the call site lives inside an async helper outside the React
  // render tree.
  const getClerkBearer = async (
    opts?: { skipCache?: boolean },
  ): Promise<string | null> => {
    try {
      const clerk = (
        window as unknown as {
          Clerk?: {
            session?: {
              touch?: () => Promise<unknown>;
              getToken?: (opts?: { skipCache?: boolean }) => Promise<string | null>;
            };
          };
        }
      ).Clerk;
      if (!clerk?.session?.getToken) return null;
      return (await clerk.session.getToken(opts)) ?? null;
    } catch {
      return null;
    }
  };

  const refreshClerkToken = async (): Promise<boolean> => {
    try {
      const clerk = (
        window as unknown as {
          Clerk?: {
            session?: {
              touch?: () => Promise<unknown>;
              getToken?: (opts?: { skipCache?: boolean }) => Promise<string | null>;
            };
          };
        }
      ).Clerk;
      if (!clerk?.session) return false;
      // ``touch`` forces the session JWT to rotate; ``getToken``
      // reads the fresh value out of the SDK cache. Both are
      // idempotent — calling on an already-fresh session is a
      // no-op (returns immediately).
      await clerk.session.touch?.();
      const fresh = await clerk.session.getToken?.({ skipCache: true });
      return Boolean(fresh);
    } catch {
      return false;
    }
  };

  const promise = (async (): Promise<T> => {
    const doFetch = async (): Promise<Response> => {
      const requestHeaders: HeadersInit = {
        ...(typeof headers === "object" && headers !== null ? headers : {}),
      };
      if (!(body instanceof FormData) && !stream) {
        (requestHeaders as Record<string, string>)["Content-Type"] = "application/json";
      }
      // Attach the client Clerk session JWT when available. Right
      // after sign-up the Next.js ``auth().getToken()`` in the
      // proxy can still be null while ``window.Clerk.session``
      // already has a token — without this header `/auth/me`
      // 401s and the portal shows "Session expired" until reload.
      const existingAuth = (requestHeaders as Record<string, string>)["Authorization"]
        ?? (requestHeaders as Record<string, string>)["authorization"];
      if (!existingAuth) {
        const bearer = await getClerkBearer();
        if (bearer) {
          (requestHeaders as Record<string, string>)["Authorization"] = `Bearer ${bearer}`;
        }
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!stream) {
        timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      }
      // F41: `signal` must win over anything `...rest` might carry
      // (it can't anymore — we destructured it out above — but the
      // combined signal must also still be the LAST key so a future
      // spread never silently reintroduces the bug). A caller-
      // supplied signal (e.g. a Cancel button's AbortController) is
      // combined with the internal timeout controller so aborting
      // either one actually aborts the outgoing fetch.
      const signal = combineSignals(controller.signal, callerSignal);
      try {
        return await fetch(`${API_BASE}${endpoint}`, {
          credentials,
          headers: requestHeaders,
          body,
          ...rest,
          signal,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let response = await doFetch();

    // 401 retry loop — at most one retry after a forced token refresh.
    if (response.status === 401 && !stream) {
      const refreshed = await refreshClerkToken();
      if (refreshed) response = await doFetch();
    }

    // Jul 2026 fix: stream paths ("stream: true") used to skip
    // every retry branch because the original transport (SSE) is
    // long-lived and re-issuing the request would tear the existing
    // stream. But the connect-time handshake is a normal HTTP GET
    // — if the gateway returns 429 BEFORE the stream opens, we are
    // free (and safer) to back off and re-dial. The same
    // Retry-After + 5 s default logic that protects /auth/me below
    // applies here: wait the cooldown, retry the handshake once,
    // surface the error to the SSE / export consumer if it still
    // 429s. We deliberately don't retry once a stream has started
    // emitting bytes (the body-read happens *after* this branch,
    // so the early status is always the handshake status).
    //
    // Also covers the ``api.exportOrgData`` case: that's a one-shot
    // binary stream that never opens anyway, so re-issuing is fine.
    if (stream && response.status === 429) {
      // Stream-handshake 429 (F32 + F36). ``retryAfterMs`` and
      // ``RETRY_AFTER_DEFAULT_MS`` are imported from
      // ``@/lib/proxy`` so the catch-all SSE branch can reuse the
      // same canonical implementation.
      const wait = retryAfterMs(response) ?? RETRY_AFTER_DEFAULT_MS;
      await new Promise((r) => setTimeout(r, wait));
      response = await doFetch();
    }

    // Transient (5xx / network) retry with exponential backoff +
    // jitter. GET / HEAD / OPTIONS only — POSTs and friends aren't
    // retried for safety.
    //
    // Jul 2026 fix: 429s are capped at ONE retry (not the general 2)
    // and we honor the upstream's ``Retry-After`` header. Without
    // the cap, a single ``fetchApi`` call during a throttle window
    // could burn 3 backend roundtrips in a row, and the providers
    // (useAuth / useOrg) that call ``api.getMe`` on every state
    // flip would compound that into hundreds of calls/second until
    // the upstream returned a hard error. With the cap + Retry-After
    // we either wait the upstream's advertised cooldown or sleep a
    // safe 5s default before trying once more — whichever is longer.
    const isIdempotent = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const generalTransient = (s: number) => s >= 500 || s === 0 || s === 408;
    /** Proxy 502/503 from ``forwardToBackend`` when Northflank is
     *  down or circuit-broken — retrying amplifies Vercel isolate
     *  load (LP-21). Detect by ``detail``/``upstream_down`` before
     *  burning more attempts. Covers 502 unreachable/timed-out and
     *  503 upstream-down/circuit-open. */
    const isProxyUpstreamDown = async (res: Response): Promise<boolean> => {
      if (res.status !== 502 && res.status !== 503) return false;
      try {
        const body = (await res.clone().json()) as {
          detail?: unknown;
          upstream_down?: unknown;
        };
        if (body?.upstream_down === true) return true;
        const detail = typeof body?.detail === "string" ? body.detail : "";
        return /Backend (unreachable|timed out|unavailable|circuit open)/i.test(detail);
      } catch {
        return false;
      }
    };
    let attempt = 0;
    const maxAttempts = (status: number) => (status === 429 ? 1 : 2);
    while (
      isIdempotent &&
      !stream &&
      attempt < maxAttempts(response.status) &&
      (response.status === 429 || generalTransient(response.status))
    ) {
      // Skip 5xx retries when the proxy already reported upstream
      // unreachable/timed out — 1 user action must not become
      // 3× Vercel × 3× Northflank (LP-21).
      if (await isProxyUpstreamDown(response)) {
        break;
      }
      attempt += 1;
      let backoff: number;
      if (response.status === 429) {
        // Honour Retry-After when the upstream gives us one; fall
        // back to a safe 5s default so a throttled gateway isn't
        // peppered with retries every few hundred milliseconds.
        const hint = retryAfterMs(response);
        backoff = hint ?? RETRY_AFTER_DEFAULT_MS;
      } else {
        // Full jitter for non-429 transients: random [0, base *
        // 2^attempt) ms. 250ms base → 0–500ms after 1st retry,
        // 0–1000ms after 2nd.
        backoff = Math.floor(Math.random() * 250 * 2 ** attempt);
      }
      await new Promise((r) => setTimeout(r, backoff));
      response = await doFetch();
    }

    // Raw-response mode: hand back the live Response before any
    // body-consumption, once auth/timeout/retry has run. Callers own
    // status checks + body reads (SSE readers, probe status codes).
    if (raw) {
      return response as unknown as T;
    }

    if (!response.ok) {
      const error = await response.json().catch(
        () => ({ detail: `Request failed (${response.status})` }),
      );
      const rawDetail =
        typeof error === "object" && error !== null && "detail" in error
          ? (error as { detail?: unknown }).detail
          : undefined;
      const detailStr =
        typeof rawDetail === "string"
          ? rawDetail
          : typeof rawDetail === "object" && rawDetail !== null
            ? JSON.stringify(rawDetail)
            : `HTTP ${response.status}`;
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : typeof rawDetail === "object" &&
              rawDetail !== null &&
              "code" in rawDetail &&
              typeof (rawDetail as { code?: unknown }).code === "string"
            ? (rawDetail as { code: string }).code
            : undefined;
      const message = toUserFacingError(
        { status: response.status, message: detailStr },
        detailStr || `HTTP ${response.status}`,
      );
      // Keep raw detail/code for machine matching; message is sanitized.
      // After the one-shot Clerk refresh retry above, a lingering 401
      // means the session is gone — notify chrome (banners / re-auth).
      // Soft polls skip this so a background Inbox GET can't flash
      // "Session expired" during a JWT race.
      if (
        response.status === 401 &&
        !softAuth &&
        typeof window !== "undefined"
      ) {
        try {
          window.sessionStorage.setItem("eden:auth:error", "session");
          window.dispatchEvent(
            new CustomEvent("eden:auth:session-expired", {
              detail: { message },
            }),
          );
        } catch {
          /* ignore storage / event failures */
        }
      }
      let retryMs: number | undefined;
      if (response.status === 429) {
        const fromHeader = retryAfterMs(response);
        const fromBody =
          typeof error === "object" &&
          error !== null &&
          "retry_after" in error &&
          typeof (error as { retry_after?: unknown }).retry_after === "number"
            ? Math.max(
                0,
                Math.floor((error as { retry_after: number }).retry_after * 1000),
              )
            : null;
        retryMs = fromHeader ?? fromBody ?? RETRY_AFTER_DEFAULT_MS;
      }
      throw new ApiError(response.status, message, detailStr, code, retryMs);
    }

    // SSE streams stay text; binary ``stream: true`` (e.g. ZIP export)
    // must not go through ``response.text()`` — that corrupts bytes.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return (await response.text()) as unknown as T;
    }
    if (stream) {
      return (await response.blob()) as unknown as T;
    }

    // 204 No Content (and any other empty-body success, e.g. some
    // DELETE routes) has nothing for `response.json()` to parse —
    // calling it anyway throws a SyntaxError even though the request
    // succeeded. Return `undefined` for callers that don't need a body.
    if (response.status === 204) {
      return undefined as unknown as T;
    }
    const rawText = await response.text();
    if (!rawText) {
      return undefined as unknown as T;
    }
    return JSON.parse(rawText) as T;
  })();

  if (!noDedup && (method === "GET" || method === "HEAD" || method === "OPTIONS")) {
    const key = dedupKey(method, endpoint, body, stream, raw);
    inflight.set(key, promise);
    promise.finally(() => {
      // Only delete if we're still the latest in-flight request.
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  }

  return promise;
}

