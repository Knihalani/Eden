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
  const FASTAPI_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
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

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              break;
            }
            controller.enqueue(value);
          }
        } catch {
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
