/**
 * GET /api/health — proxy to FastAPI's /health.
 *
 * Same as /api/proxy/health but on a dedicated route so callers
 * (auth-brand-panel, uptime monitors) don't have to
 * remember the /api/proxy prefix. The handler is intentionally
 * tiny — the real work happens in `forwardToBackend`.
 *
 * Returns ``Cache-Control: no-store`` so the auth-card badge always
 * reflects the current backend status, not a stale cache entry.
 *
 * Ops: prod often returns HTTP 503 with ``status: "degraded"`` when
 * Qdrant hits Errno 99 (Cannot assign requested address) while
 * Postgres is connected. Portal UI must surface degraded — do not
 * rewrite this response to fake healthy. Fixing Qdrant is infra.
 *
 * Soft-degraded rewrite: for UI probes (auth brand panel polls this
 * every minute), map upstream 503 + soft body → HTTP 200 with the
 * same JSON. That keeps ``status: "degraded"`` honest while stopping
 * browser console 503 noise on login/signup. Hard failures stay 503.
 */
import { NextResponse } from "next/server";
import { isSoftDegradedHealth } from "@/lib/health-status";
import { forwardToBackend, proxyError } from "@/lib/proxy";

const NO_STORE = "no-store, no-cache, must-revalidate";

export async function GET() {
  try {
    const response = await forwardToBackend("/health", { method: "GET" });
    response.headers.set("Cache-Control", NO_STORE);

    if (response.status === 503) {
      const body = await response.clone().json().catch(() => null);
      if (isSoftDegradedHealth(body)) {
        return NextResponse.json(body, {
          status: 200,
          headers: { "Cache-Control": NO_STORE },
        });
      }
    }

    return response;
  } catch (error) {
    return proxyError(error, "Backend health check failed");
  }
}
