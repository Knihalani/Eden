/** Phase 3 — Proxy GET/POST /api/agents/[id]/sim/runs. */

import { NextRequest } from "next/server";
import { forwardToBackend } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * Dedicated route — orgId comes from ``?org_id=`` because the path
 * has no orgId segment. Returning 400 instead of forwarding a
 * literal ``{orgId}`` placeholder (which 404s upstream).
 */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  const orgId = request.nextUrl.searchParams.get("org_id");
  if (!orgId) {
    return new Response(
      JSON.stringify({ detail: "Missing required query parameter: org_id" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const extraHeaders = await bearerHeader();
  return forwardToBackend(
    `/orgs/${orgId}/agents/${encodeURIComponent(agentId)}/sim/runs`,
    { extraHeaders }
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  const orgId = request.nextUrl.searchParams.get("org_id");
  if (!orgId) {
    return new Response(
      JSON.stringify({ detail: "Missing required query parameter: org_id" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const body = await request.text();
  const extraHeaders = await bearerHeader();
  return forwardToBackend(
    `/orgs/${orgId}/agents/${encodeURIComponent(agentId)}/sim/runs`,
    { method: "POST", body, extraHeaders }
  );
}
