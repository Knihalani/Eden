import { NextResponse } from "next/server";

/**
 * Replay messages for an AI Insights chat session.
 *
 * Pass-through proxy. The portal rehydrates the chat transcript
 * from this endpoint when the user picks a session from the
 * sidebar.
 */

// Same server-side URL choice as app/api/ai-insights/sessions/
// route.ts — NEXT_PUBLIC_API_URL is the client proxy path, which
// Node's fetch can't resolve and would create a loop. Use
// API_INTERNAL_URL (the direct FastAPI URL) for server-to-server.
const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";

interface RouteParams {
  params: Promise<{ session_id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { session_id } = await params;
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org_id");
  if (!orgId) {
    return NextResponse.json(
      { detail: "Missing org_id query parameter" },
      { status: 400 },
    );
  }

  const cookieHeader = request.headers.get("cookie") || "";

  try {
    const upstream = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/ai-insights/sessions/${session_id}/messages`,
      { method: "GET", headers: { Cookie: cookieHeader } },
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
