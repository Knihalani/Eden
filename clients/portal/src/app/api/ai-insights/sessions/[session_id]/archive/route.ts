import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

/**
 * Archive an AI Insights chat session.
 *
 * Pass-through proxy. Archives are soft-deletes (sets archived_at
 * server-side) so the conversation can be re-shown later if needed.
 *
 * Site-wide fix (July 2026): also forward the Clerk session JWT
 * as ``Authorization: Bearer`` so FastAPI accepts the request.
 * Without it, the archive endpoint 401s under the Clerk cutover.
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

  let authorization: string | undefined;
  try {
    const { getToken } = await auth();
    const token = await getToken();
    if (token) authorization = `Bearer ${token}`;
  } catch {
    // Clerk fail-open per lib/server/clerk-bearer.ts:39
  }
  const cookieHeader = request.headers.get("cookie") || "";

  try {
    const upstream = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/ai-insights/sessions/${session_id}/archive`,
      {
        method: "POST",
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
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
