
import { forwardToBackend, proxyError } from "@/lib/proxy";

/**
 * GET /api/auth/me — return the current user.
 *
 * ``Cache-Control: no-store`` so no intermediate cache (browser
 * back/forward cache, service worker, Vercel edge cache) can serve a
 * stale 404 "User not found" to a freshly-provisioned user. The
 * auth/me response is per-session and changes the moment the
 * backend's auto-provision inserts the user row, so the response
 * must always be re-fetched from origin.
 */
export async function GET(request: Request) {
  try {
    const response = await forwardToBackend("/auth/me", {
      method: "GET",
      cookieHeader: request.headers.get("cookie") ?? undefined });
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    response.headers.set("Pragma", "no-cache");
    return response;
  } catch (error) {
    return proxyError(error, "Not authenticated");
  }
}
