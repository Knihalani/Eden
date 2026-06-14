import { NextRequest } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";

/**
 * Next.js proxy for the status-transition endpoint.
 *
 * POST /api/orgs/{orgId}/pr-suggestions/{id}/status  → FastAPI
 *      POST /orgs/{orgId}/agent/pr-suggestions/{id}/status
 *
 * Used by the portal's "mark as merged" / "reject" /
 * "reopen" buttons.
 */

interface RouteParams {
  params: Promise<{ orgId: string; id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { orgId, id } = await params;
  const cookieHeader = request.headers.get("cookie") || "";
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  try {
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions/${id}/status`,
      { method: "POST", body, cookieHeader }
    );
  } catch (err) {
    return proxyError(err, "Failed to update suggestion status");
  }
}
