import { NextResponse } from "next/server";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * Phase 7.2 (C3) — Next.js proxy for the observability SSE stream.
 * Forwards the cookie and Last-Event-ID header to FastAPI and
 * streams the response back to the browser. Mirrors the existing
 * /api/jobs/[id]/stream proxy.
 *
 * Site-wide fix (July 2026): now also forwards the Clerk session JWT
 * as ``Authorization: Bearer`` and the active org id as ``X-Org-Id``
 * — the same pattern as app/api/ai-insights/chat/route.ts. Without
 * the Bearer, FastAPI's ``DefaultDenyAuthMiddleware`` returns 401 on
 * the first byte, ``EventSource`` auto-reconnects, and the Vercel
 * function slot gets thrashed. Without ``X-Org-Id`` the backend's
 * ``extract_org_id`` falls through to the Clerk JWT (which only
 * carries personal claims) and yields ``None`` on every request.
 */

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { orgId } = await params;
  // Server-side route — must use API_INTERNAL_URL (the direct
  // FastAPI URL), not NEXT_PUBLIC_API_URL (the client-side proxy
  // path "/api/proxy"). The latter creates a fetch-from-itself loop
  // since Node's native fetch needs an absolute URL. Same pattern as
  // app/api/ai-insights/sessions/route.ts.
  const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";
  const cookieHeader = request.headers.get("cookie") || "";
  const lastEventId = request.headers.get("last-event-id") || "";

  // Resolve the Clerk session JWT server-side via the shared helper
  // (PT-7) and forward it as a Bearer header. ``bearerHeader()``
  // returns ``{}`` when the caller isn't signed in via Clerk; in that
  // case we leave the Authorization header unset so the legacy Eden
  // cookie path can still serve the request.
  const authHeaders = await bearerHeader();

  // Forward query params (e.g. last_event_id)
  const url = new URL(request.url);
  const qs = url.search;

  try {
    const response = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/observability/sse/stream${qs}`,
      {
        headers: {
          Cookie: cookieHeader,
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          // Spread the Clerk Bearer (when present) — FastAPI's
          // ``DefaultDenyAuthMiddleware`` + ``get_current_user`` accept
          // the request. Without this the SSE returns 401 on the
          // first byte and the client reconnects every few seconds,
          // thrashing the Vercel function slot.
          ...authHeaders,
          // Same X-Org-Id forward the catch-all proxy uses — keeps RLS
          // + quota + rate-limit in sync with the catch-all path. (The
          // path param already resolves the org, but the header keeps
          // every proxy route consistent on the same contract.)
          "X-Org-Id": orgId,
        },
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { detail: "Failed to connect to observability stream" },
        { status: response.status }
      );
    }

    // 15s SSE heartbeat — sends an SSE comment (lines starting with
    // ``:`` are ignored by the EventSource client) so the connection
    // doesn't idle out behind corporate proxies / Vercel function
    // timeouts when the upstream goes quiet. Also lets the upstream
    // detect a dead client quickly (its read() will throw on a
    // closed pipe) and free the backend worker. Without this the
    // stream dies silently after ~30s of upstream silence and the
    // portal reconnects, wasting one SSE handshake per minute of
    // idle. June 2026 cost-pass.
    const HEARTBEAT_MS = 15_000;
    const HEARTBEAT_BYTES = new TextEncoder().encode(": keepalive\n\n");

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        const stopHeartbeat = () => {
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
        };
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(HEARTBEAT_BYTES);
          } catch {
            stopHeartbeat();
          }
        }, HEARTBEAT_MS);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              stopHeartbeat();
              controller.close();
              break;
            }
            controller.enqueue(value);
          }
        } catch {
          stopHeartbeat();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    // Echo the inbound request id (or a fresh UUID) so the user can
    // quote it in a support ticket. Matches the catch-all proxy's
    // 502 envelope shape (lib/proxy.ts:91-112). July 2026 site-wide fix.
    const requestId =
      request.headers.get("x-request-id") ||
      request.headers.get("x-correlation-id") ||
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    return NextResponse.json(
      { detail: "Stream connection failed", request_id: requestId },
      { status: 500 }
    );
  }
}
