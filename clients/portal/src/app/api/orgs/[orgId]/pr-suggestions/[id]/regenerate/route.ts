import { NextRequest } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";

/**
 * Next.js proxy for the regenerate endpoint.
 *
 * POST /api/orgs/{orgId}/pr-suggestions/{id}/regenerate  → FastAPI
 *      POST /orgs/${orgId}/agent/pr-suggestions/${id}/regenerate
 *
 * Re-runs the LLM (or heuristic) against the current
 * file state. The new suggestion overwrites the
 * existing one in-place.
 */

interface RouteParams {
  params: Promise<{ orgId: string; id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { orgId, id } = await params;
  const cookieHeader = request.headers.get("cookie") || "";
  try {
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions/${id}/regenerate`,
      { method: "POST", cookieHeader }
    );
  } catch (err) {
    return proxyError(err, "Failed to regenerate suggestion");
  }
}
