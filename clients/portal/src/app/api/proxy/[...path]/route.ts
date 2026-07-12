/**
 * Catch-all proxy: /api/proxy/[...path] → FastAPI at NEXT_PUBLIC_API_URL.
 *
 * The portal's `lib/api.ts` calls `${API_BASE}${endpoint}` where
 * API_BASE is `/api/proxy` (set at build time). Every fetch the
 * portal makes therefore becomes a same-origin POST/GET/etc to a
 * route handler, which then forwards the request to FastAPI and
 * returns the response.
 *
 * Auth forwarding (June 2026 Clerk cutover):
 * - When the caller is signed in via Clerk, ``auth().getToken()``
 *   returns a Clerk session JWT. We attach it as ``Authorization:
 *   Bearer <jwt>`` so FastAPI's ``_resolve_token_payload`` can verify
 *   it against Clerk's JWKS.
 * - The legacy Eden ``authorization`` cookie is forwarded as a
 *   fallback for CLI / SDK / service-to-service callers that hit the
 *   same proxy without a Clerk session.
 */
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { forwardToBackend, proxyError, retryAfterMs, RETRY_AFTER_DEFAULT_MS } from "@/lib/proxy";

/** Must be ≥ proxy ``AbortSignal.timeout(25_000)`` so the platform
 *  does not kill the isolate mid-forward (would surface as 504 and
 *  look like an upstream outage — LP-21). */
export const maxDuration = 30;

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-none-match",
  "x-request-id",
  "x-correlation-id",
  // X-Org-Id is the header FastAPI uses to identify the active
  // org context (see ``get_current_org`` in deps.py). Without
  // forwarding it, the backend falls back to ``extract_org_id``
  // from the Clerk JWT — which often yields ``None`` because the
  // session JWT only carries the user's *personal* claims, not
  // the active org. Result: ``require_org_member`` raises 403
  // on every org-scoped endpoint. June 2026 fix.
  "x-org-id",
];

/** Max body size the proxy will accept before rejecting with 413.
 *  Matches the typical FastAPI ``--limit-max-requests`` / Nginx
 *  ``client_max_body_size`` defaults. 10MB is plenty for traces,
 *  datasets, and the largest eval uploads. Bump via the env var
 *  ``EDEN_PROXY_MAX_BYTES`` if a real workload needs more.
 */
const MAX_BODY_BYTES = Number.parseInt(
  process.env.EDEN_PROXY_MAX_BYTES || "10485760",
  10,
);

async function handle(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const upstreamPath = "/" + path.join("/");
  const search = request.nextUrl.search;

  // Forward only the safe subset of request headers — strip cookies
  // (handled explicitly below) and any other hop-by-hop headers.
  const headers: Record<string, string> = {};
  for (const h of FORWARDED_REQUEST_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }

  // Body transport. Three branches:
  //  - multipart/form-data → read as FormData, pass through verbatim
  //    so the upstream gets the same boundary the browser set.
  //    ``request.text()`` would mangle the binary payload into a
  //    string and strip the boundary, so this MUST branch before
  //    the text() read. (July 2026 fix — previously every multipart
  //    upload — agent code, avatar, reference doc — was rejected
  //    upstream as a malformed body.)
  //  - everything else → read as text and forward as a string
  //    (preserves JSON, raw bytes, etc.).
  let body: string | FormData | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentType = request.headers.get("content-type") || "";
    const declared = request.headers.get("content-length");
    if (declared && Number.parseInt(declared, 10) > MAX_BODY_BYTES) {
      return new NextResponse(
        JSON.stringify({
          detail: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
        }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      try {
        body = await request.formData();
      } catch {
        body = undefined;
      }
    } else {
      try {
        body = await request.text();
      } catch {
        body = undefined;
      }
      if (body && typeof body === "string" && body.length > MAX_BODY_BYTES) {
        return new NextResponse(
          JSON.stringify({
            detail: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
          }),
          { status: 413, headers: { "Content-Type": "application/json" } },
        );
      }
    }
  }

  // Prefer a caller-supplied Authorization header (portal ``fetchApi``
  // attaches the client Clerk JWT). Right after sign-up,
  // ``auth().getToken()`` can still be null while ``window.Clerk``
  // already has a session — preferring the request header avoids the
  // false "Session expired" banner until hard reload.
  let authorization: string | undefined;
  const callerAuth = request.headers.get("authorization");
  if (callerAuth) {
    authorization = callerAuth;
  } else {
    try {
      const { getToken } = await auth();
      const token = await getToken();
      if (token) authorization = `Bearer ${token}`;
    } catch {
      // Clerk not configured / signed out — leave unset for cookie path.
    }
  }

  try {
    // SSE detection (PT-5). When the caller sends
    // ``Accept: text/event-stream`` the JSON-response path can't pipe
    // bytes correctly (it would buffer the stream into memory and
    // close on the first ``event:`` boundary). Hand the stream off
    // directly via a ReadableStream that reads from upstream.body
    // — no buffering, no timeout (PT-10's isStream skip).
    const accept = (headers["accept"] || "").toLowerCase();
    if (accept.includes("text/event-stream")) {
      const FASTAPI_URL =
        process.env.API_INTERNAL_URL || "http://localhost:8000";

      // F36 fix (July 2026). The previous SSE branch waited for
      // the upstream response and then either piped bytes through
      // or 502'd on a non-2xx. That was correct for "happy path",
      // but during a throttle window the upstream returns
      // ``429 Too Many Requests`` BEFORE the stream opens — the
      // client ``EventSource`` would then re-dial immediately and
      // the gateway would 429 every time. The same
      // ``Retry-After`` + 5 s default policy the regular fetch
      // path uses (F31/F32) now also applies to the SSE
      // handshake: wait the cooldown, dial the upstream once more,
      // and only fall through to the streaming pipe if the second
      // attempt is 2xx. Once the body has started flowing we
      // never retry — tearing down a live SSE would corrupt the
      // consumer.
      const dialUpstream = async () => {
        const upstreamHeaders: Record<string, string> = { ...headers };
        if (authorization) upstreamHeaders.authorization = authorization;
        const cookieHeader = request.headers.get("cookie");
        if (cookieHeader) upstreamHeaders.cookie = cookieHeader;
        return fetch(
          `${FASTAPI_URL}${upstreamPath}${search}`,
          {
            method: request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
            headers: upstreamHeaders,
            body: body as BodyInit | null | undefined,
          },
        );
      };

      let upstream = await dialUpstream();
      if (upstream.status === 429) {
        const wait = retryAfterMs(upstream) ?? RETRY_AFTER_DEFAULT_MS;
        await new Promise((r) => setTimeout(r, wait));
        upstream = await dialUpstream();
      }

      if (!upstream.ok || !upstream.body) {
        // Hard failure after the single permitted handshake
        // retry. Surface the upstream status (429, 502, 503,
        // …) verbatim with a small JSON envelope so client-side
        // SSE consumers see a structured error instead of a bare
        // text body. ``EventSource`` will only auto-reconnect on
        // a status we explicitly opt out of by setting
        // ``readyState`` ourselves — the consumer-side reconnect
        // policy is owned by the SSE hook, not the proxy.
        return new Response(
          JSON.stringify({
            detail: "Upstream stream error",
            upstream_status: upstream.status,
          }),
          {
            status: upstream.status || 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          },
        );
      }
      // Pipe upstream.body through unchanged. No buffering, no
      // transform — the SSE protocol is byte-stable and any
      // ``JSON.parse`` here would corrupt multi-byte UTF-8 events.
      const stream = new ReadableStream({
        start(controller) {
          const reader = upstream.body!.getReader();
          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  return;
                }
                controller.enqueue(value);
              }
            } catch {
              controller.close();
            }
          };
          pump();
        },
      });
      return new Response(stream, {
        status: upstream.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }
    return await forwardToBackend(upstreamPath + search, {
      method: request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      body,
      cookieHeader: request.headers.get("cookie") ?? undefined,
      extraHeaders: headers,
      authorization,
      // Echo the inbound request id (or fall through to the
      // crypto.randomUUID() default inside forwardToBackend) so the
      // 502 body always carries a request_id the user can quote in
      // a support ticket. July 2026 site-wide fix.
      requestId:
        request.headers.get("x-request-id") ||
        request.headers.get("x-correlation-id") ||
        undefined,
      stream: false,
    });
  } catch (error) {
    return proxyError(error, `Proxy request to ${upstreamPath} failed`);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;