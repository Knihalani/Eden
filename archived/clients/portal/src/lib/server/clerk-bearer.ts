/**
 * PT-7 fix — server-side Clerk Bearer header resolver.
 *
 * `auth()` from `@clerk/nextjs/server` returns a sync object. To get the
 * session JWT, we need to await `getToken()`. This helper returns the
 * header map (empty when there is no token) so route handlers can
 * spread it into the `extraHeaders` of `forwardToBackend`.
 *
 * Ponytail: keep the helper tiny — it's the smallest useful surface.
 * If the helper ever needs token refresh logic, add it here, not in
 * the 7 call sites.
 *
 * Usage:
 *
 * ```ts
 * const extraHeaders = await bearerHeader();
 * await forwardToBackend("/foo", { extraHeaders });
 * ```
 */
import { auth } from "@clerk/nextjs/server";

/**
 * Returns `{}` when there is no Clerk session (so callers can spread
 * it into headers unconditionally). When the user IS signed in,
 * returns `{ Authorization: "Bearer <jwt>" }` — the FastAPI side
 * prefers the Bearer over the legacy `access_token` cookie (see
 * `eden.api.deps._resolve_token_payload`).
 */
export async function bearerHeader(): Promise<Record<string, string>> {
  try {
    const { getToken } = await auth();
    if (!getToken) return {};
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    // Clerk fail-open: never let the helper itself break a request.
    // The backend will return 401 if no auth header was forwarded;
    // the portal's `setUnauthorizedHandler` shows the sign-in prompt.
    return {};
  }
}
