import { NextResponse } from "next/server";

/**
 * Phase 7.2 (C3) — Next.js proxy for the observability SSE stream.
 * Forwards the cookie and Last-Event-ID header to FastAPI and
 * streams the response back to the browser. Mirrors the existing
 * /api/jobs/[id]/stream proxy.
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

  // Forward query params (e.g. last_event_id)
  const url = new URL(request.url);
  const qs = url.search;

  try {
    const response = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/observability/stream${qs}`,
      {
        headers: {
          Cookie: cookieHeader,
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
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
    return NextResponse.json(
      { detail: "Stream connection failed" },
      { status: 500 }
    );
  }
}
