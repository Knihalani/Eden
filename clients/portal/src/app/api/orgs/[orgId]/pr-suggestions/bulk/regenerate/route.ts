import { NextRequest } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * Next.js proxy for the bulk-regenerate endpoint.
 *
 * POST /api/orgs/{orgId}/pr-suggestions/bulk/regenerate  → FastAPI
 *      POST /orgs/${orgId}/agent/pr-suggestions/bulk/regenerate
 *
 * Body: ``{"suggestion_ids": ["prsug_xxx", "prsug_yyy", ...]}``
 * Response: ``{"regenerated": [...], "skipped": [...], "requested": N}``
 */

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  const cookieHeader = request.headers.get("cookie") || "";
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  try {
    const extraHeaders = await bearerHeader();
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions/bulk/regenerate`,
      { method: "POST", body, cookieHeader, extraHeaders }
    );
  } catch (err) {
    return proxyError(err, "Failed to bulk-regenerate suggestions");
  }
}
