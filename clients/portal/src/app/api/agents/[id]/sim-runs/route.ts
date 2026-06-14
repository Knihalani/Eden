/** Phase 3 — Proxy GET/POST /api/agents/[id]/sim/runs. */

import { NextRequest, NextResponse } from "next/server";
import { forwardToBackend } from "@/lib/proxy";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  return forwardToBackend(
    `/orgs/{orgId}/agents/${encodeURIComponent(agentId)}/sim/runs`
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  const body = await request.text();
  return forwardToBackend(
    `/orgs/{orgId}/agents/${encodeURIComponent(agentId)}/sim/runs`,
    { method: "POST", body }
  );
}
