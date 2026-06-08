import { NextResponse } from "next/server";

/**
 * List AI Insights chat sessions for the current user / org.
 *
 * This is a thin pass-through to the FastAPI /sessions endpoint —
 * the same cookie-forwarding pattern as the chat route, just a GET.
 */

const FASTAPI_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function GET(request: Request) {
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
      `${FASTAPI_URL}/orgs/${orgId}/ai-insights/sessions`,
      {
        method: "GET",
        headers: { Cookie: cookieHeader },
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
