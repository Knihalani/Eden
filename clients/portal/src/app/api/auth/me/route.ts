
import { forwardToBackend, proxyError } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

/**
 * GET /api/auth/me — return the current user.
 *
 * ``Cache-Control: no-store`` so no intermediate cache (browser
 * back/forward cache, service worker, Vercel edge cache) can serve a
 * stale 404 "User not found" to a freshly-provisioned user. The
 * auth/me response is per-session and changes the moment the
 * backend's auto-provision inserts the user row, so the response
 * must always be re-fetched from origin.
 *
 * PT-7 follow-up (July 2026): forwards the Clerk Bearer alongside the
 * cookie. Clerk-authed users only have ``__session`` (no legacy
 * ``authorization`` cookie) — without Bearer, FastAPI's
 * ``_resolve_token_payload`` falls through to 401 and the dashboard
 * shows "Session expired" for an actually-signed-in user. The bearer
 * header is a no-op when the caller is unauthenticated
 * (``bearerHeader`` returns ``{}``), so legacy flows keep working.
 */
export async function GET(request: Request) {
  try {
    const authHeaders = await bearerHeader();
    const response = await forwardToBackend("/auth/me", {
      method: "GET",
      cookieHeader: request.headers.get("cookie") ?? undefined,
      extraHeaders: authHeaders });
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    response.headers.set("Pragma", "no-cache");
    return response;
  } catch (error) {
    return proxyError(error, "Not authenticated");
  }
}
