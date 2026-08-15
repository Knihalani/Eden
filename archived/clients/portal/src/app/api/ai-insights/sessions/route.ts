import { NextResponse } from "next/server";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * List AI Insights chat sessions for the current user / org.
 *
 * Thin pass-through to the FastAPI /sessions endpoint. Mirrors
 * the chat route's auth-forwarding pattern (app/api/ai-insights/
 * chat/route.ts:44-53): resolve the Clerk session JWT server-side
 * and forward as ``Authorization: Bearer <jwt>`` so FastAPI's
 * ``DefaultDenyAuthMiddleware`` + ``_resolve_token_payload``
 * accept the request. The legacy Eden ``authorization`` cookie
 * is forwarded as a fallback for SDK / service-to-service callers.
 *
 * Site-wide fix (July 2026): the previous version forwarded
 * only ``Cookie`` — under Clerk cutover, the Clerk session JWT
 * lives in the Authorization header, not the cookie, so the
 * request 401'd. ``ai-insights: list sessions failed Error: HTTP
 * 401`` showed up in the browser console on every chat-sidebar
 * load.
 */

// API_INTERNAL_URL (not NEXT_PUBLIC_API_URL) — the Next.js route
// runs server-side and needs an absolute URL that Node's native
// fetch can resolve. NEXT_PUBLIC_API_URL is the *client* proxy
// path ("/api/proxy" in production) and would create a fetch-from-
// itself loop here. Matches the pattern in
// app/api/ai-insights/chat/route.ts:27.
const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org_id");
  if (!orgId) {
    return NextResponse.json(
      { detail: "Missing org_id query parameter" },
      { status: 400 },
    );
  }

  // Resolve the Clerk session JWT server-side via the shared helper
  // (PT-7) and forward as a Bearer header. ``bearerHeader()`` returns
  // ``{}`` when the caller isn't signed in via Clerk; in that case
  // the legacy Eden ``authorization`` cookie carries the request.
  const authHeaders = await bearerHeader();
  const cookieHeader = request.headers.get("cookie") || "";

  try {
    const upstream = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/ai-insights/sessions`,
      {
        method: "GET",
        headers: {
          ...authHeaders,
          Cookie: cookieHeader,
        },
      },
    );
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return new Response(text || "Upstream error", {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(upstream.body, {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      { detail: `Upstream unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
