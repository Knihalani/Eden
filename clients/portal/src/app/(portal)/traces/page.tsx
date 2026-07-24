import { HydrationBoundary } from "@tanstack/react-query";
import { bearerHeader } from "@/lib/server/clerk-bearer";
import { getOrgId } from "@/lib/server/context";
import { dehydrateTraces, type MePrefetchPayload } from "@/lib/portal-dehydrate";
import TracesClient from "./traces-client";

const FASTAPI_URL = process.env.API_INTERNAL_URL || "http://localhost:8000";

async function fetchMeServer(
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

function resolveOrgId(
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

async function resolveTracesDehydratedState() {
  try {
    const headers = await bearerHeader();
    if (!headers.Authorization) return null;

    const [clerkOrgId, me] = await Promise.all([
      getOrgId(),
      fetchMeServer(headers),
    ]);
    if (!me) return null;

    const orgId = resolveOrgId(me, clerkOrgId);
    if (!orgId) return null;

    return await dehydrateTraces({
      apiBase: FASTAPI_URL,
      headers,
      orgId,
      me,
    });
  } catch {
    return null;
  }
}

/**
 * SSR wrapper for ``/traces`` — warms agents + traces + sessions so the
 * hub list paints from cache instead of three cold client GETs.
 */
export default async function TracesPage() {
  const dehydratedState = await resolveTracesDehydratedState();
  if (!dehydratedState) {
    return <TracesClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <TracesClient />
    </HydrationBoundary>
  );
}
