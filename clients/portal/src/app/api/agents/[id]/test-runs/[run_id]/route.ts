/** Phase 3 — Proxy GET /api/agents/[id]/test/runs/[run_id]. */

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
  { params }: { params: Promise<{ id: string; run_id: string }> }
) {
  const { id, run_id } = await params;
  const agentId = decodeURIComponent(id);
  const runId = decodeURIComponent(run_id);
  const orgId = request.nextUrl.searchParams.get("org_id");
  if (!orgId) {
    return new Response(
      JSON.stringify({ detail: "Missing required query parameter: org_id" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const extraHeaders = await bearerHeader();
  return forwardToBackend(
    `/orgs/${orgId}/agents/${encodeURIComponent(agentId)}/test/runs/${encodeURIComponent(runId)}`,
    { extraHeaders }
  );
}
