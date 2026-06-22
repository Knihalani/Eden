/**
 * GET /api/health — proxy to FastAPI's /health.
 *
 * Same as /api/proxy/health but on a dedicated route so callers
 * (auth-brand-panel, status pages, uptime monitors) don't have to
 * remember the /api/proxy prefix. The handler is intentionally
 * tiny — the real work happens in `forwardToBackend`.
 *
 * Returns ``Cache-Control: no-store`` so the auth-card badge always
 * reflects the current backend status, not a stale cache entry.
 */
import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function GET() {
  try {
    const response = await forwardToBackend("/health", { method: "GET" });
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return response;
  } catch (error) {
    return proxyError(error, "Backend health check failed");
  }
}
