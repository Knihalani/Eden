/**
 * Catch-all proxy: /api/proxy/[...path] → FastAPI at NEXT_PUBLIC_API_URL.
 *
 * The portal's `lib/api.ts` calls `${API_BASE}${endpoint}` where
 * API_BASE is `/api/proxy` (set at build time). Every fetch the
 * portal makes therefore becomes a same-origin POST/GET/etc to a
 * route handler, which then forwards the request to FastAPI and
 * returns the response — including the Set-Cookie headers, which
 * the browser would otherwise block under SameSite=Lax on a
 * cross-origin POST (Vercel → Northflank).
 *
 * Specific route handlers (e.g. /api/agents/[id]/upload for
 * multipart file uploads) take precedence over this catch-all due
 * to Next.js's more-specific-path matching.
 */
import { type NextRequest, NextResponse } from "next/server";
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

async function handle(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
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
    try {
      body = await request.text();
    } catch {
      body = undefined;
    }
  }

  try {
    return await forwardToBackend(upstreamPath + search, {
      method: request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      body,
      cookieHeader: request.headers.get("cookie") ?? undefined,
      extraHeaders: headers,
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
