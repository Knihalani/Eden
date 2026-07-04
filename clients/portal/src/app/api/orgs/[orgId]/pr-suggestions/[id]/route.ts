import { NextRequest } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

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
    const authHeaders = await bearerHeader();
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions/${id}`,
      { method: "GET", cookieHeader, extraHeaders: authHeaders }
    );
  } catch (err) {
    return proxyError(err, "Failed to fetch PR suggestion");
  }
}
