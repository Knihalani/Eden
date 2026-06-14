/** Phase 3 — Proxy GET /api/agents/[id]/sim/runs/[run_id]. */

import { NextRequest, NextResponse } from "next/server";
import { forwardToBackend } from "@/lib/proxy";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; run_id: string }> }
) {
  const { id, run_id } = await params;
  const agentId = decodeURIComponent(id);
  const runId = decodeURIComponent(run_id);
  return forwardToBackend(
    `/orgs/{orgId}/agents/${encodeURIComponent(agentId)}/sim/runs/${encodeURIComponent(runId)}`
  );
}
