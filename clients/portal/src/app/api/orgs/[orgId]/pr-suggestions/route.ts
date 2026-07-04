import { NextRequest } from "next/server";
import { forwardToBackend, proxyError } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * Next.js proxy for the agent PR-suggestion inbox.
 *
 * GET  /api/orgs/{orgId}/pr-suggestions           → FastAPI
 *      GET /orgs/{orgId}/agent/pr-suggestions (inbox)
 * POST /api/orgs/{orgId}/pr-suggestions           → FastAPI
 *      POST /orgs/{orgId}/agent/pr-suggestions (create)
 */

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  const url = new URL(request.url);
  const qs = url.search;
  const cookieHeader = request.headers.get("cookie") || "";
  try {
    const authHeaders = await bearerHeader();
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions${qs}`,
      { method: "GET", cookieHeader, extraHeaders: authHeaders }
    );
  } catch (err) {
    return proxyError(err, "Failed to list PR suggestions");
  }
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
    const authHeaders = await bearerHeader();
    return await forwardToBackend(
      `/orgs/${orgId}/agent/pr-suggestions`,
      { method: "POST", body, cookieHeader, extraHeaders: authHeaders }
    );
  } catch (err) {
    return proxyError(err, "Failed to create PR suggestion");
  }
}
