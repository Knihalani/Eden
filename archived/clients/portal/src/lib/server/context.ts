/**
 * Server-side context helpers for the App Router.
 *
 * Used by server components (e.g. /agents, /agents/[id]) that need
 * the active org id BEFORE rendering.
 *
 * After the June 2026 Clerk cutover the legacy ``authorization``
 * cookie is gone for Clerk-authed callers (Clerk uses the encrypted
 * ``__session`` HTTP-only cookie, which we cannot decode here). We
 * delegate to Clerk's server-side ``auth()`` instead — it returns
 * the active ``orgId`` and ``userId`` derived from the Clerk
 * session cookie. The fallback paths still read the legacy Eden
 * ``authorization`` cookie for the CLI / SDK / service-to-service
 * callers that haven't migrated.
 */
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";

/**
 * Resolve the active org id for the current request.
 *
 * Returns the Clerk org id when the caller is signed in via Clerk
 * (the common path post-cutover). Falls back to the
 * ``current_org_id`` claim on a legacy Eden ``authorization``
 * cookie so SDK / CLI flows keep working until they migrate.
 */
export async function getOrgId(): Promise<string | null> {
  try {
    const { orgId } = await auth();
    if (orgId) return orgId;
  } catch {
    // Clerk not configured / signed out — fall through to legacy path.
  }
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("authorization")?.value;
    if (!token) return null;
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

/**
 * Resolve the active user id for the current request.
 *
 * Clerk path returns the Clerk ``user_2abc...`` string id (the
 * portal then passes it through ``/auth/me`` for UUID translation
 * via the ``clerk_id`` column). Legacy path returns the UUID
 * baked into the Eden ``authorization`` JWT.
 */
export async function getUserId(): Promise<string | null> {
  try {
    const { userId } = await auth();
    if (userId) return userId;
  } catch {
    // Fall through.
  }
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