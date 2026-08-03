/**
 * Prefetch Home's attention shards — traces + issues.
 * Agents stay off the cold path (client loads them after "Show fleet").
 * ``PortalCatalogSync`` / the page's own ``useOrgQuery`` calls against
 * ``GET /orgs/{id}/portal/traces`` and ``GET /orgs/{id}/portal/issues``
 * (see ``lib/api/portal.ts`` + ``queryKeys.portal.*``). This module seeds
 * those shards keyed identically to the client queries, so
 * ``HydrationBoundary`` on hub pages warms the cache the client reads.
 *
 * ``/auth/me`` is seeded only by layout via ``dehydrateMe`` — page-level
 * dehydrates must not re-embed it (duplicate Flight payload).
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
import { OBSERVE_STALE } from "@/lib/portal-query";
import type { AgentFixture } from "@/lab/fixtures/agents";
import type { IssueFixture } from "@/lab/fixtures/issues";
import type { SessionFixture } from "@/lab/fixtures/sessions";
import type { SignalFixture } from "@/lab/fixtures/signals";
import type { TraceFixture } from "@/lab/fixtures/traces";

/** Match client SHELL_QUERY so hydrated entries stay fresh across soft-nav. */
function makePrefetchClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: OBSERVE_STALE,
      },
    },
  });
}

/**
 * Await prefetches up to ``budgetMs``, then dehydrate whatever settled.
 * Avoids the old all-or-nothing race that discarded warm shards when
 * one endpoint was slow.
 */
async function settleWithin(
  work: Promise<unknown>,
  budgetMs: number | undefined,
): Promise<void> {
  if (budgetMs == null || budgetMs <= 0) {
    await work;
    return;
  }
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      setTimeout(resolve, budgetMs);
    }),
  ]);
}

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
   * Seeded under ``ME_QUERY_KEY`` by layout ``dehydrateMe`` only.
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

/** Seed shared ``/auth/me`` cache (K1 / Wave-2 TTFB win). Layout only. */
function seedMeQuery(qc: QueryClient, me: MePrefetchPayload): Promise<void> {
  return qc.prefetchQuery({
    queryKey: [...ME_QUERY_KEY],
    queryFn: () => Promise.resolve(me),
  });
}

/**
 * Prefetch Home's attention shards — traces + issues.
 * Agents stay off the cold path (client loads them after "Show fleet").
 *
 * Query keys match ``queryKeys.portal.*`` exactly so
 * ``PortalCatalogSync`` and Home's ``useOrgQuery`` calls hydrate from
 * this warm cache on first client render.
 *
 * ``budgetMs`` returns a partial dehydrate of whatever settled in time
 * instead of racing the whole prefetch to ``null``.
 * ``/auth/me`` is owned by layout ``dehydrateMe`` — not re-seeded here.
 */
export async function dehydrateHome(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  const qc = makePrefetchClient();
  const tracesKey = queryKeys.portal.traces(auth.orgId);
  const issuesKey = queryKeys.portal.issues(auth.orgId);
  // Per-shard settle: one failing endpoint must not wipe warm shards.
  await settleWithin(
    Promise.allSettled([
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
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/**
 * Prefetch Traces hub shards — agents + traces + sessions.
 * Matches ``PortalCatalogSync`` and the traces page ``useOrgQuery`` keys.
 * ``/auth/me`` is owned by layout ``dehydrateMe``.
 */
export async function dehydrateTraces(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  const qc = makePrefetchClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const tracesKey = queryKeys.portal.traces(auth.orgId);
  const sessionsKey = queryKeys.portal.sessions(auth.orgId);
  await settleWithin(
    Promise.allSettled([
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
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/** Layout-level ``/auth/me`` only — seeds Auth/Org before PortalBootGate. */
export async function dehydrateMe(
  auth: Pick<PortalPrefetchAuth, "me">,
): Promise<DehydratedState> {
  const qc = makePrefetchClient();
  await seedMeQuery(qc, auth.me);
  return dehydrate(qc);
}

/** Agents hub — agents + traces (inspector runs; no sessions list). */
export async function dehydrateAgents(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const tracesKey = queryKeys.portal.traces(auth.orgId);
  await settleWithin(
    Promise.allSettled([
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
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/** Issues board — agents + issues. */
export async function dehydrateIssues(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const issuesKey = queryKeys.portal.issues(auth.orgId);
  await settleWithin(
    Promise.allSettled([
      qc.prefetchQuery({
        queryKey: [...agentsKey],
        queryFn: () =>
          serverGet<AgentFixture[]>(auth, `/orgs/${auth.orgId}/portal/agents`),
      }),
      qc.prefetchQuery({
        queryKey: [...issuesKey],
        queryFn: () =>
          serverGet<IssueFixture[]>(auth, `/orgs/${auth.orgId}/portal/issues`),
      }),
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/** Signals hub — agents + signals (no alert-rules; page does not read them). */
export async function dehydrateSignals(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const signalsKey = queryKeys.portal.signals(auth.orgId);
  await settleWithin(
    Promise.allSettled([
      qc.prefetchQuery({
        queryKey: [...agentsKey],
        queryFn: () =>
          serverGet<AgentFixture[]>(auth, `/orgs/${auth.orgId}/portal/agents`),
      }),
      qc.prefetchQuery({
        queryKey: [...signalsKey],
        queryFn: () =>
          serverGet<SignalFixture[]>(auth, `/orgs/${auth.orgId}/portal/signals`),
      }),
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}
