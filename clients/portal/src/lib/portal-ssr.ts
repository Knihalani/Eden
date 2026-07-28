/**
 * Shared SSR helpers for portal route dehydrate wrappers.
 * Keeps Clerk bearer + ``/auth/me`` + Eden org resolution in one place.
 *
 * ``resolvePortalPrefetchAuth`` is ``React.cache``'d so layout + page
 * dehydrate in the same request share one ``/auth/me`` round-trip.
 */
import { cache } from "react";
import { bearerHeader } from "@/lib/server/clerk-bearer";
import { getOrgId } from "@/lib/server/context";
import type { MePrefetchPayload, PortalPrefetchAuth } from "@/lib/portal-dehydrate";

const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";

export async function fetchMeServer(
  headers: Record<string, string>,
): Promise<MePrefetchPayload | null> {
  try {
    const res = await fetch(`${FASTAPI_URL}/auth/me`, {
      headers: { ...headers, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as MePrefetchPayload;
  } catch {
    return null;
  }
}

/** Mirror OrgProvider ``applyMeToOrgState`` Eden-uuid resolution. */
export function resolveEdenOrgId(
  me: MePrefetchPayload,
  clerkOrgId: string | null,
): string | null {
  const orgs = me.organizations ?? [];
  if (clerkOrgId) {
    const fromClerk = orgs.find(
      (o) => o.clerk_org_id === clerkOrgId || o.id === clerkOrgId,
    );
    if (fromClerk) return fromClerk.id;
  }
  if (me.current_org_id) {
    const preferred = orgs.find((o) => o.id === me.current_org_id);
    if (preferred) return preferred.id;
  }
  return orgs[0]?.id ?? null;
}

/**
 * Resolve auth + org for dehydrate helpers. Fail-open: ``null`` when
 * session/me/org cannot be resolved (client fetches cold).
 */
export const resolvePortalPrefetchAuth = cache(
  async (): Promise<PortalPrefetchAuth | null> => {
    try {
      const headers = await bearerHeader();
      if (!headers.Authorization) return null;

      const [clerkOrgId, me] = await Promise.all([
        getOrgId(),
        fetchMeServer(headers),
      ]);
      if (!me) return null;

      const orgId = resolveEdenOrgId(me, clerkOrgId);
      if (!orgId) {
        // Still seed ``/auth/me`` even without an org (empty-workspace UX).
        return {
          apiBase: FASTAPI_URL,
          headers,
          orgId: "",
          me,
        };
      }

      return {
        apiBase: FASTAPI_URL,
        headers,
        orgId,
        me,
      };
    } catch {
      return null;
    }
  },
);
