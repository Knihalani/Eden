/** Phase 3 — Proxy POST /api/agents/[id]/upload to FastAPI. */

import { NextRequest, NextResponse } from "next/server";
import { forwardToBackend } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * Dedicated multipart upload route. The catch-all proxy at
 * /api/proxy/[...path] previously routed this through ``request.text()``
 * which mangled the multipart payload. This route reads the
 * multipart body directly and re-wraps it so the FastAPI side sees a
 * well-formed ``multipart/form-data`` body with the file part intact.
 *
 * The orgId is read from the ``org_id`` query parameter because the
 * route lives at /api/agents/[id]/upload — no org-id path segment.
 * Frontend callers already pass it (see ``agentsApi.upload(orgId,
 * agentId, file, ...)`` in lib/api.ts).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  const orgId = request.nextUrl.searchParams.get("org_id");
  if (!orgId) {
    return NextResponse.json(
      { detail: "Missing org_id query parameter" },
      { status: 400 }
    );
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { detail: "Missing 'file' part in multipart body" },
      { status: 400 }
    );
  }
  // Re-wrap the file in a fresh multipart with a known filename.
  const fd = new FormData();
  fd.append("file", file, (file as File).name ?? "agent.tar.gz");
  const [extraHeaders, cookieHeader] = await Promise.all([
    bearerHeader(),
    Promise.resolve(request.headers.get("cookie") ?? undefined),
  ]);
  return forwardToBackend(
    `/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/upload`,
    { method: "POST", body: fd, extraHeaders, cookieHeader }
  );
}
