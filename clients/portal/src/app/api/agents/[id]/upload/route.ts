/** Phase 3 — Proxy POST /api/agents/[id]/upload to FastAPI. */

import { NextRequest, NextResponse } from "next/server";
import { forwardToBackend } from "@/lib/proxy";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { detail: "Missing 'file' part in multipart body" },
      { status: 400 }
    );
  }
  // Re-wrap the file in a fresh multipart with a known filename
  // (the proxy forwards as JSON by default; we need to keep the
  // multipart shape end-to-end).
  const fd = new FormData();
  fd.append("file", file, (file as File).name ?? "agent.tar.gz");
  return forwardToBackend(
    `/orgs/{orgId}/agents/${encodeURIComponent(agentId)}/upload`,
    { method: "POST", body: fd }
  );
}
