/**
 * Client-error ingest bridge — "Eden runs on Eden".
 *
 * Receives fire-and-forget error beacons from the portal's error
 * boundaries (see ``src/lib/client-error-reporter.ts``) and forwards
 * them to the FastAPI backend's existing app-event ingest endpoint:
 *
 *     POST {API_INTERNAL_URL}/orgs/{org_id}/ingest/app
 *
 * Why a dedicated route instead of the generic ``/api/proxy``: the
 * ingest path embeds the org id, and error boundaries cannot reliably
 * know it client-side (``global-error.tsx`` renders with no React
 * providers at all). Here the org is resolved **server-side** from the
 * Clerk session (same pattern as the proxy route); signed-out traffic
 * falls back to an optional server-only reporting identity
 * (``EDEN_CLIENT_ERRORS_ORG_ID`` + ``EDEN_CLIENT_ERRORS_API_KEY``) —
 * secrets never reach the browser — and is otherwise dropped.
 *
 * Always answers 204: the beacon sender never reads the response, and
 * a failing reporter must never surface errors of its own.
 */

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

/** Beacon bodies are tiny; anything bigger is dropped, not an error. */
const MAX_BODY_BYTES = 32_768;

/** Upstream ingest timeout — never hold the beacon route open long. */
const UPSTREAM_TIMEOUT_MS = 5_000;

const MESSAGE_MAX = 1_000;
const STACK_MAX = 4_000;

function done(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

function asString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const raw = await request.text();
    if (!raw || raw.length > MAX_BODY_BYTES) return done();

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return done();
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return done();
    }

    const message = asString(body.message, MESSAGE_MAX);
    if (!message) return done();

    // Rebuild the AppEvent server-side — never forward client JSON
    // verbatim into the ingest pipeline.
    const event = {
      name: "portal_client_error",
      ts: new Date().toISOString(),
      source: "browser",
      session_id: asString(body.sessionId, 64),
      properties: {
        message,
        stack: asString(body.stack, STACK_MAX),
        digest: asString(body.digest, 128),
        boundary: asString(body.boundary, 32),
        route: asString(body.route, 512),
        user_agent: asString(body.userAgent, 512),
        release: asString(body.release, 64),
        client_ts: asString(body.ts, 64),
      },
    };

    // Auth resolution, in order:
    // 1. Clerk session — Bearer JWT + session org (mirrors /api/proxy).
    // 2. Server-only env identity for signed-out surfaces (marketing,
    //    global-error before auth) — key stays on the server.
    // 3. Neither → drop silently.
    let orgId: string | undefined;
    let authHeaders: Record<string, string> | undefined;
    try {
      const session = await auth();
      if (session.orgId) {
        const token = await session.getToken();
        if (token) {
          orgId = session.orgId;
          authHeaders = {
            authorization: `Bearer ${token}`,
            "x-org-id": session.orgId,
          };
        }
      }
    } catch {
      // Clerk unavailable (e.g. during an outage that caused the very
      // error being reported) — fall through to the env identity.
    }
    if (!orgId) {
      const envOrgId = process.env.EDEN_CLIENT_ERRORS_ORG_ID;
      const envApiKey = process.env.EDEN_CLIENT_ERRORS_API_KEY;
      if (envOrgId && envApiKey) {
        orgId = envOrgId;
        authHeaders = { "x-org-api-key": envApiKey, "x-org-id": envOrgId };
      }
    }
    if (!orgId || !authHeaders) return done();

    const base = process.env.API_INTERNAL_URL || "http://localhost:8000";
    await fetch(
      `${base}/orgs/${encodeURIComponent(orgId)}/ingest/app`,
      {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ events: [event] }),
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    ).catch(() => {
      // Fire-and-forget: an unreachable backend must not turn the
      // error reporter into an error source.
    });

    return done();
  } catch {
    return done();
  }
}
