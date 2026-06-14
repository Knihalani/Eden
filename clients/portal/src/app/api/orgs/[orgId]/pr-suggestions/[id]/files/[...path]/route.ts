import { NextRequest } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";

/**
 * Next.js proxy for a single file referenced by a PR suggestion.
 *
 * GET /api/orgs/{orgId}/pr-suggestions/{id}/files/{path...}
 *   → FastAPI
 *     GET /orgs/{orgId}/agent/pr-suggestions/{id}/files/{path}
 *
 * The path is a catch-all so file paths with slashes
 * (e.g. ``src/eden/foo.py``) round-trip cleanly.
 */

interface RouteParams {
  params: Promise<{ orgId: string; id: string; path: string[] }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { orgId, id, path } = await params;
  const cookieHeader = request.headers.get("cookie") || "";
  const filePath = Array.isArray(path) ? path.join("/") : String(path);
  try {
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions/${id}/files/${filePath}`,
      { method: "GET", cookieHeader }
    );
  } catch (err) {
    return proxyError(err, "Failed to read suggestion file");
  }
}
