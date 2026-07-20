import { bearerHeader } from "@/lib/server/clerk-bearer";
import {
  pipeSseUpstream,
  streamHandshakeFailure,
  streamHandshakeFromUpstream,
} from "@/lib/proxy";

/**
 * N11 — Next.js proxy for session-scoped live SSE
 * (``GET /orgs/{org}/stream/traces/{sessionId}/events``).
 *
 * Dedicated route (not the catch-all ``/api/proxy`` which caps at
 * ``maxDuration = 30``). Mirrors ``api/orgs/.../observability/stream``
 * so long-lived session tails survive quiet periods + keep-alives.
 * Matches backend ``LiveTraceSubscriber`` default ``max_duration_s=300``.
 */
export const maxDuration = 300;

interface RouteParams {
  params: Promise<{ orgId: string; sessionId: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { orgId, sessionId } = await params;
  // Server-side route — must use API_INTERNAL_URL (the direct
  // FastAPI URL), not NEXT_PUBLIC_API_URL (the client-side proxy
  // path "/api/proxy"). The latter creates a fetch-from-itself loop
  // since Node's native fetch needs an absolute URL.
  const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";
  const cookieHeader = request.headers.get("cookie") || "";
  const lastEventId = request.headers.get("last-event-id") || "";
  const authHeaders = await bearerHeader();
  const qs = new URL(request.url).search;

  try {
    const response = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/stream/traces/${sessionId}/events${qs}`,
      {
        headers: {
          Cookie: cookieHeader,
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          ...authHeaders,
          "X-Org-Id": orgId,
        },
        signal: request.signal,
      },
    );

    if (!response.ok) {
      return streamHandshakeFromUpstream({
        request,
        upstream: response,
        fallbackDetail: "Failed to connect to live trace stream",
      });
    }

    return pipeSseUpstream(response, {
      heartbeatMs: 15_000,
      signal: request.signal,
    });
  } catch (error) {
    return streamHandshakeFailure({
      request,
      error,
      fallbackDetail: "Failed to connect to live trace stream",
    });
  }
}
