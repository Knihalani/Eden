import { HydrationBoundary } from "@tanstack/react-query";
import { bearerHeader } from "@/lib/server/clerk-bearer";
import { getOrgId } from "@/lib/server/context";
import { dehydrateHome, type MePrefetchPayload } from "@/lib/portal-dehydrate";
import HomeClient from "./home-client";

// Server-side route — must use API_INTERNAL_URL (the direct FastAPI
// URL), never NEXT_PUBLIC_API_URL / the same-origin proxy. Same
// pattern as the other server-to-server routes (see
// ``app/api/proxy/[...path]/route.ts``).
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

/**
 * Mirror ``OrgProvider``'s ``applyMeToOrgState`` org resolution
 * (``hooks/use-org.tsx``) so the org id we prefetch with is the same
 * Eden org UUID the client will land on — Clerk's active org id
 * (``clerkOrgId``) is NOT the Eden org id, it's matched against
 * ``me.organizations[].clerk_org_id`` first, falling back to
 * ``me.current_org_id``, falling back to the first org.
 */
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

/**
 * Resolve the SSR-dehydrated state for ``/home``, or ``null`` when
 * hydration isn't possible (no session, Clerk hiccup, upstream down,
 * org not resolved yet). Kept JSX-free and fully try/catch-wrapped —
 * error-boundary lint (``react-hooks/error-boundaries``) forbids
 * constructing JSX inside a try/catch, so all fallible work happens
 * here and ``HomePage`` below only branches on the plain return value.
 */
async function resolveHomeDehydratedState() {
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

    return await dehydrateHome({
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
 * SSR wrapper for ``/home`` — prefetches ``/auth/me`` + the two
 * shards Home actually renders (``portal/agents``, ``portal/traces``)
 * server-side and hydrates them into the client's React Query cache
 * via ``HydrationBoundary``, so first paint doesn't wait on three
 * cold client GETs behind Clerk's client-side session bootstrap.
 *
 * Entirely best-effort / fail-open: whenever
 * ``resolveHomeDehydratedState`` can't produce a snapshot, this falls
 * back to rendering ``<HomeClient />`` with no hydrated state, which
 * is exactly the pre-existing behavior — the client queries just run
 * cold, same as today. This route is gated by ``auth.protect()`` in
 * ``proxy.ts`` for the known portal prefixes, so a signed-in session
 * is expected here, but we never assume it.
 */
export default async function HomePage() {
  const dehydratedState = await resolveHomeDehydratedState();
  if (!dehydratedState) {
    return <HomeClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <HomeClient />
    </HydrationBoundary>
  );
}
