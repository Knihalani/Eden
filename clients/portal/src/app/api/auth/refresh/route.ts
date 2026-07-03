/**
 * POST /api/auth/refresh — force a fresh /auth/me round-trip.
 *
 * The portal's `useAuth` / `useOrg` hooks cache the /auth/me response
 * for the lifetime of the page. A Clerk session refresh that lands a
 * fraction of a second after the first /auth/me (typical for the
 * auto-provision race on a fresh signup) leaves the portal showing
 * stale org/user data until the next full page reload.
 *
 * This route is a thin wrapper around the catch-all proxy: it just
 * forwards to FastAPI's /auth/me so the next client-side `fetchApi`
 * call gets a fresh response. The proxy already attaches the Clerk
 * JWT — nothing portal-specific happens here. 200 returns the full
 * `UserResponse` shape the same as GET /api/auth/me.
 *
 * Why a separate route rather than just re-using GET /api/auth/me:
 * - POST is semantically a "force refresh" — caching layers /
 *   service workers shouldn't try to dedupe a refresh with a normal
 *   read. Some browsers and CDNs key POST vs GET differently.
 * - Future expansion room: a "switch org" or "force re-sync" path
 *   can sit alongside this one without colliding with the read API.
 */
import { forwardToBackend, proxyError } from "@/lib/proxy";
import { bearerHeader } from "@/lib/server/clerk-bearer";

export async function POST(request: Request) {
  try {
    const extraHeaders = await bearerHeader();
    const response = await forwardToBackend("/auth/me", {
      method: "GET",
      // Pass cookies through so the proxy can fall back to the
      // legacy Eden cookie path if the Clerk JWT is missing.
      cookieHeader: request.headers.get("cookie") ?? undefined,
      extraHeaders,
    });
    // Never cache a refresh — see comment on the /api/auth/me route.
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    response.headers.set("Pragma", "no-cache");
    return response;
  } catch (error) {
    return proxyError(error, "Auth refresh failed");
  }
}
