/**
 * Home SSR prefetch + dehydrate helpers.
 *
 * 2026-07-23 rewrite — the previous version prefetched
 * ``/orgs/{id}/observability/traces`` and ``/orgs/{id}/observability/summary``,
 * neither of which Home actually reads. Home's real data comes from
 * ``PortalCatalogSync`` / the page's own ``useOrgQuery`` calls against
 * ``GET /orgs/{id}/portal/agents`` and ``GET /orgs/{id}/portal/traces``
 * (see ``lib/api/portal.ts`` + ``queryKeys.portal.*``). This module now
 * seeds exactly those two shards plus ``/auth/me``, keyed identically
 * to the client queries, so ``HydrationBoundary`` on ``/home`` actually
 * warms the cache the client reads from instead of silently prefetching
 * data nothing subscribes to.
 *
 * Consumed by ``app/(portal)/home/page.tsx`` (server component) via
 * ``dehydrateHome`` — see that file for the Clerk org-resolution +
 * fail-open wiring.
 */

import {
  QueryClient,
  dehydrate,
  type DehydratedState,
} from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { AgentFixture } from "@/lab/fixtures/agents";
import type { IssueFixture } from "@/lab/fixtures/issues";
import type { SessionFixture } from "@/lab/fixtures/sessions";
import type { TraceFixture } from "@/lab/fixtures/traces";

/** Must match ``ME_QUERY_KEY`` in ``hooks/use-me-query.ts`` (client module). */
export const ME_QUERY_KEY = ["auth", "me"] as const;

/** Shape of ``GET /auth/me`` — seeded so Auth/Org skip a cold refetch. */
export type MePrefetchPayload = {
  user_id: string;
  email: string;
  name: string;
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    clerk_org_id?: string | null;
    is_personal?: boolean;
  }>;
  current_org_id: string | null;
};

export type PortalPrefetchAuth = {
  /** Absolute API base for server-to-server (API_INTERNAL_URL). */
  apiBase: string;
  /** Headers including Authorization Bearer when present. */
  headers: Record<string, string>;
  orgId: string;
  /**
   * Full ``/auth/me`` body already fetched by the caller.
   * Seeded under ``ME_QUERY_KEY`` so the client does not immediately
   * re-hit ``/auth/me`` on hydrate (staleTime 60s on useMeQuery).
   */
  me: MePrefetchPayload;
};

/**
 * Prefetch must NOT resolve `null` on !res.ok / network failure.
 * A successful dehydrate of null + client staleTime painted a
 * soft-null as settled empty and exited the install path into KPI
 * theatre during outages. Let the queryFn throw so failed shards
 * are omitted from dehydrate and the client refetches honestly.
 */
async function serverGet<T>(
  auth: PortalPrefetchAuth,
  path: string,
): Promise<T> {
  const res = await fetch(`${auth.apiBase}${path}`, {
    headers: { ...auth.headers, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`prefetch ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Seed shared ``/auth/me`` cache (K1 / Wave-2 TTFB win). */
function seedMeQuery(qc: QueryClient, me: MePrefetchPayload): Promise<void> {
  return qc.prefetchQuery({
    queryKey: [...ME_QUERY_KEY],
    queryFn: () => Promise.resolve(me),
  });
}

/**
 * Prefetch Home's real shards — agents + traces + issues — plus
 * ``/auth/me``, for hydration.
 *
 * Query keys match ``queryKeys.portal.*`` exactly so
 * ``PortalCatalogSync`` and Home's ``useOrgQuery`` calls hydrate from
 * this warm cache on first client render.
 */
export async function dehydrateHome(
  auth: PortalPrefetchAuth,
): Promise<DehydratedState> {
  const qc = new QueryClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const tracesKey = queryKeys.portal.traces(auth.orgId);
  const issuesKey = queryKeys.portal.issues(auth.orgId);
  // Per-shard settle: one failing endpoint must not wipe warm shards.
  await Promise.allSettled([
    seedMeQuery(qc, auth.me),
    qc.prefetchQuery({
      queryKey: [...agentsKey],
      queryFn: () =>
        serverGet<AgentFixture[]>(auth, `/orgs/${auth.orgId}/portal/agents`),
    }),
    qc.prefetchQuery({
      queryKey: [...tracesKey],
      queryFn: () =>
        serverGet<TraceFixture[]>(auth, `/orgs/${auth.orgId}/portal/traces`),
    }),
    qc.prefetchQuery({
      queryKey: [...issuesKey],
      queryFn: () =>
        serverGet<IssueFixture[]>(auth, `/orgs/${auth.orgId}/portal/issues`),
    }),
  ]);
  return dehydrate(qc);
}

/**
 * Prefetch Traces hub shards — agents + traces + sessions — plus
 * ``/auth/me``, for hydration. Matches ``PortalCatalogSync`` and the
 * traces page ``useOrgQuery`` keys exactly.
 */
export async function dehydrateTraces(
  auth: PortalPrefetchAuth,
): Promise<DehydratedState> {
  const qc = new QueryClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const tracesKey = queryKeys.portal.traces(auth.orgId);
  const sessionsKey = queryKeys.portal.sessions(auth.orgId);
  await Promise.allSettled([
    seedMeQuery(qc, auth.me),
    qc.prefetchQuery({
      queryKey: [...agentsKey],
      queryFn: () =>
        serverGet<AgentFixture[]>(auth, `/orgs/${auth.orgId}/portal/agents`),
    }),
    qc.prefetchQuery({
      queryKey: [...tracesKey],
      queryFn: () =>
        serverGet<TraceFixture[]>(auth, `/orgs/${auth.orgId}/portal/traces`),
    }),
    qc.prefetchQuery({
      queryKey: [...sessionsKey],
      queryFn: () =>
        serverGet<SessionFixture[]>(
          auth,
          `/orgs/${auth.orgId}/portal/sessions`,
        ),
    }),
  ]);
  return dehydrate(qc);
}
