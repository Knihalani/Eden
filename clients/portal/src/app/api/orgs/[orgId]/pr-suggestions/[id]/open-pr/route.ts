import { NextRequest } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * Next.js proxy for the destructive "open PR" action.
 *
 * POST /api/orgs/{orgId}/pr-suggestions/{id}/open-pr → FastAPI
 *      POST /orgs/{orgId}/agent/pr-suggestions/{id}/open-pr
 *
 * The portal calls this when the human clicks the "open PR"
 * button on a suggestion. The action delegates to the
 * backend's :class:`PRProvider` (LocalPRProvider for the
 * dev flow; GitHubPRProvider when wired).
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
    const extraHeaders = await bearerHeader();
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions/${id}/open-pr`,
      { method: "POST", body, cookieHeader, extraHeaders }
    );
  } catch (err) {
    return proxyError(err, "Failed to open PR");
  }
}
