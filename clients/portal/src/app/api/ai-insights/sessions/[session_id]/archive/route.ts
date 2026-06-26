import { NextResponse } from "next/server";

/**
 * Archive an AI Insights chat session.
 *
 * Pass-through proxy. Archives are soft-deletes (sets archived_at
 * server-side) so the conversation can be re-shown later if needed.
 */

// Same server-side URL choice as the sibling sessions routes — see
// app/api/ai-insights/sessions/route.ts for the rationale.
const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";

interface RouteParams {
  params: Promise<{ session_id: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
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
      `${FASTAPI_URL}/orgs/${orgId}/ai-insights/sessions/${session_id}/archive`,
      { method: "POST", headers: { Cookie: cookieHeader } },
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
