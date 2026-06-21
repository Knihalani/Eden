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
import { forwardToBackend, proxyError } from "@/lib/proxy";

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-none-match",
  "x-request-id",
  "x-correlation-id",
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

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    // Cheap pre-check via the Content-Length header when present
    // (catches the obvious case without reading the stream).
    const declared = request.headers.get("content-length");
    if (declared && Number.parseInt(declared, 10) > MAX_BODY_BYTES) {
      return new NextResponse(
        JSON.stringify({
          detail: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
        }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }
    try {
      body = await request.text();
    } catch {
      body = undefined;
    }
    if (body && body.length > MAX_BODY_BYTES) {
      return new NextResponse(
        JSON.stringify({
          detail: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
        }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Resolve the Clerk session token server-side and forward it as a
  // Bearer header. ``getToken()`` returns null when the caller isn't
  // signed in via Clerk; we leave the Authorization header unset in
  // that case so the legacy Eden cookie path can still serve the
  // request (CLI / SDK / API-key callers).
  let authorization: string | undefined;
  try {
    const { getToken } = await auth();
    const token = await getToken();
    if (token) authorization = `Bearer ${token}`;
  } catch {
    // Clerk not configured / signed out — fall through to cookie auth.
  }

  try {
    return await forwardToBackend(upstreamPath + search, {
      method: request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      body,
      cookieHeader: request.headers.get("cookie") ?? undefined,
      extraHeaders: headers,
      authorization,
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