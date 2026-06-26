import { NextResponse } from "next/server";

/**
 * Next.js proxy for the FastAPI AI Insights chat endpoint.
 *
 * The portal's browser can't POST directly to FastAPI and consume an
 * SSE response in one go (the auth cookie is set as SameSite=Lax and
 * the portal runs on a different port in dev). This route forwards
 * the Clerk session JWT as ``Authorization: Bearer`` (FastAPI's
 * ``_resolve_token_payload`` verifies Clerk JWTs from the Bearer
 * header; the legacy Eden ``authorization`` cookie is forwarded as
 * a fallback for SDK / service-to-service callers) and streams the
 * SSE body back byte-for-byte.
 *
 * Note: do NOT buffer the body — the user sees the first token within
 * a few hundred ms, and we want tool_call / text_delta events to land
 * in the UI as soon as the backend emits them.
 */

import { auth } from "@clerk/nextjs/server";

// Server-side only — must NEVER be NEXT_PUBLIC_* (which is bundled
// into the browser and is a relative path `/api/proxy` in production,
// which Node's fetch cannot resolve to an absolute URL).
// In Vercel prod: API_INTERNAL_URL=https://eden-api--<id>.northflank.app
// In dev: falls back to localhost:8000.
const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org_id");
  if (!orgId) {
    return NextResponse.json(
      { detail: "Missing org_id query parameter" },
      { status: 400 },
    );
  }

  // Resolve the Clerk session JWT server-side and forward it as a
  // Bearer header. ``auth().getToken()`` returns null when the
  // caller isn't signed in via Clerk; we fall back to the legacy
  // Eden ``authorization`` cookie in that case so SDK / CLI callers
  // can still reach the endpoint via the portal proxy.
  let authorization: string | undefined;
  try {
    const { getToken } = await auth();
    const token = await getToken();
    if (token) authorization = `Bearer ${token}`;
  } catch {
    // Clerk not configured / signed out — fall through to cookie auth.
  }

  const cookieHeader = request.headers.get("cookie") || "";
  let body: string;
  try {
    body = await request.text();
  } catch {
    return NextResponse.json(
      { detail: "Failed to read request body" },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/ai-insights/chat`,
      {
        method: "POST",
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          Cookie: cookieHeader,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body,
      },
    );
  } catch (err) {
    return NextResponse.json(
      { detail: `Upstream unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    // FastAPI may have returned a JSON error envelope — try to forward it.
    const text = await upstream.text().catch(() => "");
    return new Response(text || JSON.stringify({ detail: "Upstream error" }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 30s SSE heartbeat. Chat tokens usually arrive within ms of each
  // other, but a long-running model "thinking" phase can have 10s+
  // gaps — without a heartbeat, corporate proxies / Vercel function
  // timeouts would silently kill the stream mid-response and the
  // portal would reconnect, losing context. June 2026 cost-pass.
  const HEARTBEAT_MS = 30_000;
  const HEARTBEAT_BYTES = new TextEncoder().encode(": keepalive\n\n");

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
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
      } catch (err) {
        stopHeartbeat();
        // ponytail: controller.error(err) — closes the stream AND signals
        // an error to the reader. The previous controller.close() left
        // the client in a stuck "Streaming…" state because no `done`
        // event was emitted. Emitting an explicit SSE `event: error`
        // frame first so the client UI can show a toast and recover.
        const msg = (err as Error)?.message || "stream interrupted";
        try {
          controller.enqueue(
            new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ detail: msg })}\n\n`),
          );
        } catch {
          /* controller already closed by the runtime */
        }
        controller.error(err);
      }
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
