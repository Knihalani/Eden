import { NextResponse } from "next/server";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * Proxy for POST /orgs/{org}/ai-insights/approve — ApprovalCard confirm path.
 */

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

  const authHeaders = await bearerHeader();
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

  try {
    const upstream = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/ai-insights/approve`,
      {
        method: "POST",
        headers: {
          ...authHeaders,
          Cookie: cookieHeader,
          "Content-Type": "application/json",
        },
        body,
      },
    );
    const text = await upstream.text().catch(() => "");
    return new Response(text || JSON.stringify({ detail: "Upstream error" }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      { detail: `Upstream unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
