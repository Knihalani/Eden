/** Phase 3 — Proxy GET/POST /api/agents/[id]/sim/runs. */

import { NextRequest, NextResponse } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * Dedicated route — orgId comes from the ``org_id`` query parameter
 * because the path has no org-id segment. Returns 400 instead of
 * forwarding an unfilled placeholder (which 404s upstream).
 */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const agentId = decodeURIComponent(id);
    const orgId = request.nextUrl.searchParams.get("org_id");
    if (!orgId) {
      return NextResponse.json(
        { detail: "Missing org_id query parameter" },
        { status: 400 },
      );
    }
    const extraHeaders = await bearerHeader();
    return await forwardToBackend(
      `/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/sim/runs`,
      { method: "GET", extraHeaders },
    );
  } catch (err) {
    return proxyError(err, "Failed to list sim runs");
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const agentId = decodeURIComponent(id);
    const orgId = request.nextUrl.searchParams.get("org_id");
    if (!orgId) {
      return NextResponse.json(
        { detail: "Missing org_id query parameter" },
        { status: 400 },
      );
    }
    const body = await request.text();
    const extraHeaders = await bearerHeader();
    return await forwardToBackend(
      `/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/sim/runs`,
      { method: "POST", body, extraHeaders },
    );
  } catch (err) {
    return proxyError(err, "Failed to create sim run");
  }
}
