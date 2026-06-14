import { NextRequest } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";

/**
 * Next.js proxy for a single PR suggestion.
 *
 * GET /api/orgs/{orgId}/pr-suggestions/{id}        → FastAPI
 *     GET /orgs/{orgId}/agent/pr-suggestions/{id}  (detail view)
 */

interface RouteParams {
  params: Promise<{ orgId: string; id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { orgId, id } = await params;
  const cookieHeader = request.headers.get("cookie") || "";
  try {
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions/${id}`,
      { method: "GET", cookieHeader }
    );
  } catch (err) {
    return proxyError(err, "Failed to fetch PR suggestion");
  }
}
