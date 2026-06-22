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

const FASTAPI_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
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
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
