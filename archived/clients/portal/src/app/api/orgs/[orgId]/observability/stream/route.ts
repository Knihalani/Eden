import { bearerHeader } from "@/lib/server/clerk-bearer";
import {
  pipeSseUpstream,
  streamHandshakeFailure,
  streamHandshakeFromUpstream,
} from "@/lib/proxy";

/**
 * Phase 7.2 (C3) — Next.js proxy for the observability SSE stream.
 * Forwards the cookie and Last-Event-ID header to FastAPI and
 * streams the response back to the browser. Mirrors the existing
 * /api/jobs/[id]/stream proxy.
 *
 * Site-wide fix (July 2026): now also forwards the Clerk session JWT
 * as ``Authorization: Bearer`` and the active org id as ``X-Org-Id``
 * — the same pattern as app/api/ai-insights/chat/route.ts. Without
 * the Bearer, FastAPI's ``DefaultDenyAuthMiddleware`` returns 401 on
 * the first byte, ``EventSource`` auto-reconnects, and the Vercel
 * function slot gets thrashed. Without ``X-Org-Id`` the backend's
 * ``extract_org_id`` falls through to the Clerk JWT (which only
 * carries personal claims) and yields ``None`` on every request.
 *
 * Dedicated route (not the catch-all ``/api/proxy`` which caps at
 * ``maxDuration = 30``). Raise fluid timeout so long-lived SSE can
 * sit open through quiet periods + keep-alives without the platform
 * killing the function mid-stream.
 *
 * Policy: keep at 300 to match backend
 * ``observability_stream._STREAM_MAX_DURATION_S`` so FastAPI emits
 * ``stream_duration_exceeded`` before Vercel hard-kills this proxy.
 */
export const maxDuration = 300;

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { orgId } = await params;
  // Server-side route — must use API_INTERNAL_URL (the direct
  // FastAPI URL), not NEXT_PUBLIC_API_URL (the client-side proxy
  // path "/api/proxy"). The latter creates a fetch-from-itself loop
  // since Node's native fetch needs an absolute URL. Same pattern as
  // app/api/ai-insights/sessions/route.ts.
  const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";
  const cookieHeader = request.headers.get("cookie") || "";
  const lastEventId = request.headers.get("last-event-id") || "";

  // Resolve the Clerk session JWT server-side via the shared helper
  // (PT-7) and forward it as a Bearer header. ``bearerHeader()``
  // returns ``{}`` when the caller isn't signed in via Clerk; in that
  // case we leave the Authorization header unset so the legacy Eden
  // cookie path can still serve the request.
  const authHeaders = await bearerHeader();

  // Forward query params (e.g. last_event_id)
  const url = new URL(request.url);
  const qs = url.search;

  try {
    const response = await fetch(
      `${FASTAPI_URL}/orgs/${orgId}/observability/sse/stream${qs}`,
      {
        headers: {
          Cookie: cookieHeader,
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          // Spread the Clerk Bearer (when present) — FastAPI's
          // ``DefaultDenyAuthMiddleware`` + ``get_current_user`` accept
          // the request. Without this the SSE returns 401 on the
          // first byte and the client reconnects every few seconds,
          // thrashing the Vercel function slot.
          ...authHeaders,
          // Same X-Org-Id forward the catch-all proxy uses — keeps RLS
          // + quota + rate-limit in sync with the catch-all path. (The
          // path param already resolves the org, but the header keeps
          // every proxy route consistent on the same contract.)
          "X-Org-Id": orgId,
        },
        // Client disconnect aborts the upstream dial / body so Redis
        // pub/sub workers are not held until maxDuration.
        signal: request.signal,
      },
    );

    if (!response.ok) {
      return streamHandshakeFromUpstream({
        request,
        upstream: response,
        fallbackDetail: "Failed to connect to observability stream",
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
      fallbackDetail: "Failed to connect to observability stream",
    });
  }
}
