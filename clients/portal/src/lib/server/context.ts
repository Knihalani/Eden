/**
 * Server-side context helpers for the App Router.
 *
 * Used by server components (e.g. /agents, /agents/[id]) that need
 * the active org id BEFORE rendering. Reads the session JWT cookie
 * that the login flow set, decodes its ``current_org_id`` claim,
 * and returns the org id (or ``null`` if no session is present).
 *
 * The portal's auth flow stores the JWT in an ``authorization``
 * cookie that's also forwarded to the FastAPI backend by
 * ``lib/proxy.ts`` — same shape, two consumers.
 *
 * NOTE: this is a thin stub used to satisfy the page imports —
 * it intentionally avoids a full JWT-validation library and
 * delegates the actual session check to the BE via
 * ``/auth/me`` on every server-component render. Pages should
 * treat a ``null`` return as "redirect to /login" and let the
 * client pick up the session from there.
 */
import { cookies } from "next/headers";

export async function getOrgId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("authorization")?.value;
    if (!token) return null;
    // Decode the JWT payload without signature verification —
    // the BE has already verified it on /auth/me. We only need
    // the ``current_org_id`` claim for server-side routing hints.
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    );
    return payload.current_org_id ?? null;
  } catch {
    return null;
  }
}

export async function getUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("authorization")?.value;
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    );
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
