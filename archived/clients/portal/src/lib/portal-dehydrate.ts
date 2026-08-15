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
import { queryKey, queryKeys } from "@/lib/query-keys";
import { OBSERVE_STALE } from "@/lib/portal-query";
import type { AgentFixture } from "@/lab/fixtures/agents";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import type { IssueFixture } from "@/lab/fixtures/issues";
import type { SessionFixture } from "@/lab/fixtures/sessions";
import type { SignalFixture } from "@/lab/fixtures/signals";
import type { TraceFixture } from "@/lab/fixtures/traces";
import type { ImproveQueueItem } from "@/lib/api/resources";
import type { GatewayOverview } from "@/lib/api/gateway";
import type { PromptListRow } from "@/lib/api/portal";
import type {
  ApiKeyFixture,
  AuditEventFixture,
  AuditPackFixture,
  MemberFixture,
  WorkspaceFixture,
} from "@/lab/fixtures/settings";
import type {
  DatasetFixture,
  ExperimentFixture,
  PlaygroundFixture,
} from "@/lab/fixtures/evals";
import type { CostDriverFixture } from "@/lab/fixtures/cost";
import type { BudgetPayload, SamplingStatsPayload } from "@/lib/api/budget";

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

/**
 * Prefetch /improve hub shards — agents + plans (first page) + queue.
 *
 * OOM P6: eliminates the 4+ mount-time waterfalls the client page
 * previously triggered.  Plans use ``prefetchInfiniteQuery`` so the
 * hydrated entry matches the ``useInfiniteQuery`` key the client reads
 * (``improvePlansPages``).  The queue envelopes are unwrapped here so
 * the cache stores the same ``ImproveQueueItem[]`` shape the client
 * queryFn returns.
 */
export async function dehydrateImprove(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const plansKey = queryKeys.portal.improvePlansPages(auth.orgId);
  const queueKey = queryKeys.portal.improveQueue(auth.orgId);
  await settleWithin(
    Promise.allSettled([
      qc.prefetchQuery({
        queryKey: [...agentsKey],
        queryFn: () =>
          serverGet<AgentFixture[]>(auth, `/orgs/${auth.orgId}/portal/agents`),
      }),
      // Infinite query: seed first page (offset=0, limit=50) so the client
      // ``useInfiniteQuery`` hydrates immediately and only fetches more on scroll.
      qc.prefetchInfiniteQuery({
        queryKey: [...plansKey],
        queryFn: () =>
          serverGet<ImprovePlanFixture[]>(
            auth,
            `/orgs/${auth.orgId}/portal/improve/plans?limit=50&offset=0`,
          ),
        initialPageParam: 0,
      }),
      qc.prefetchQuery({
        queryKey: [...queueKey],
        queryFn: async () => {
          const envelope = await serverGet<{
            data?: { items?: ImproveQueueItem[] };
          }>(auth, `/orgs/${auth.orgId}/improve/queue`);
          return envelope.data?.items ?? [];
        },
      }),
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/**
 * Gateway hub — warm the default 24-hour overview so the chart paints
 * without a client waterfall.  The query key includes the ``hours``
 * param so this hydration only warms the default window; non-default
 * windows still fetch fresh (correct behaviour).
 */
export async function dehydrateGateway(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const overviewKey = queryKeys.gateway.overview(auth.orgId, 24);
  await settleWithin(
    Promise.allSettled([
      qc.prefetchQuery({
        queryKey: [...overviewKey],
        queryFn: () =>
          serverGet<GatewayOverview>(
            auth,
            `/orgs/${auth.orgId}/gateway/overview?window_hours=24`,
          ),
      }),
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/**
 * Prompts hub — warm the prompt list so the sidebar renders immediately.
 * ``detail`` and ``pins`` depend on the selected prompt URL param so
 * they are intentionally omitted from server prefetch.
 * API unwraps the envelope: ``{ data: { prompts: PromptListRow[] } }``.
 */
export async function dehydratePrompts(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const listKey = queryKeys.promptsV2.list(auth.orgId);
  await settleWithin(
    Promise.allSettled([
      qc.prefetchQuery({
        queryKey: [...listKey],
        queryFn: async () => {
          const env = await serverGet<{
            status: string;
            data: { prompts: PromptListRow[]; count: number };
          }>(auth, `/orgs/${auth.orgId}/prompts`);
          return env.data?.prompts ?? [];
        },
      }),
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/**
 * Settings hub — warm workspace + keys + members + audit log shards.
 * All five queries fire on mount (no conditional rendering gate).
 */
export async function dehydrateSettings(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const workspaceKey = queryKeys.portal.workspace(auth.orgId);
  const keysKey = queryKeys.portal.keys(auth.orgId);
  const membersKey = queryKeys.portal.members(auth.orgId);
  const auditEventsKey = queryKeys.portal.auditEvents(auth.orgId);
  const auditPacksKey = queryKeys.portal.auditPacks(auth.orgId);
  await settleWithin(
    Promise.allSettled([
      qc.prefetchQuery({
        queryKey: [...workspaceKey],
        queryFn: () =>
          serverGet<WorkspaceFixture>(
            auth,
            `/orgs/${auth.orgId}/portal/workspace`,
          ),
      }),
      qc.prefetchQuery({
        queryKey: [...keysKey],
        queryFn: () =>
          serverGet<ApiKeyFixture[]>(auth, `/orgs/${auth.orgId}/portal/keys`),
      }),
      qc.prefetchQuery({
        queryKey: [...membersKey],
        queryFn: () =>
          serverGet<MemberFixture[]>(
            auth,
            `/orgs/${auth.orgId}/portal/members`,
          ),
      }),
      qc.prefetchQuery({
        queryKey: [...auditEventsKey],
        queryFn: () =>
          serverGet<AuditEventFixture[]>(
            auth,
            `/orgs/${auth.orgId}/portal/audit/events`,
          ),
      }),
      qc.prefetchQuery({
        queryKey: [...auditPacksKey],
        queryFn: () =>
          serverGet<AuditPackFixture[]>(
            auth,
            `/orgs/${auth.orgId}/portal/audit/packs`,
          ),
      }),
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/**
 * Evals hub — warm agents + datasets + playgrounds + experiments.
 * All four queries fire on mount; agents come free from PortalCatalogSync.
 */
export async function dehydrateEvals(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const datasetsKey = queryKeys.portal.evalDatasets(auth.orgId);
  const playgroundsKey = queryKeys.portal.evalPlaygrounds(auth.orgId);
  const experimentsKey = queryKeys.portal.evalExperiments(auth.orgId);
  await settleWithin(
    Promise.allSettled([
      qc.prefetchQuery({
        queryKey: [...agentsKey],
        queryFn: () =>
          serverGet<AgentFixture[]>(auth, `/orgs/${auth.orgId}/portal/agents`),
      }),
      qc.prefetchQuery({
        queryKey: [...datasetsKey],
        queryFn: () =>
          serverGet<DatasetFixture[]>(
            auth,
            `/orgs/${auth.orgId}/portal/evals/datasets`,
          ),
      }),
      qc.prefetchQuery({
        queryKey: [...playgroundsKey],
        queryFn: () =>
          serverGet<PlaygroundFixture[]>(
            auth,
            `/orgs/${auth.orgId}/portal/evals/playgrounds`,
          ),
      }),
      qc.prefetchQuery({
        queryKey: [...experimentsKey],
        queryFn: () =>
          serverGet<ExperimentFixture[]>(
            auth,
            `/orgs/${auth.orgId}/portal/evals/experiments`,
          ),
      }),
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}

/**
 * Cost hub — warm agents + cost drivers + budget + traces + sampling stats.
 * Budget uses the non-portal ``["cost", orgId, "budget"]`` key that matches
 * the ``BUDGET_QUERY_KEY`` constant in the cost page client.
 */
export async function dehydrateCost(
  auth: PortalPrefetchAuth,
  budgetMs?: number,
): Promise<DehydratedState> {
  if (!auth.orgId) return dehydrateMe(auth);
  const qc = makePrefetchClient();
  const agentsKey = queryKeys.portal.agents(auth.orgId);
  const driversKey = queryKeys.portal.costDrivers(auth.orgId);
  const budgetKey = queryKey("cost", auth.orgId, "budget");
  const tracesKey = queryKeys.portal.traces(auth.orgId);
  const samplingStatsKey = queryKeys.portal.samplingStats(auth.orgId);
  await settleWithin(
    Promise.allSettled([
      qc.prefetchQuery({
        queryKey: [...agentsKey],
        queryFn: () =>
          serverGet<AgentFixture[]>(auth, `/orgs/${auth.orgId}/portal/agents`),
      }),
      qc.prefetchQuery({
        queryKey: [...driversKey],
        queryFn: () =>
          serverGet<CostDriverFixture[]>(
            auth,
            `/orgs/${auth.orgId}/portal/cost/drivers`,
          ),
      }),
      qc.prefetchQuery({
        queryKey: [...budgetKey],
        queryFn: () =>
          serverGet<BudgetPayload>(auth, `/orgs/${auth.orgId}/budget`),
      }),
      qc.prefetchQuery({
        queryKey: [...tracesKey],
        queryFn: () =>
          serverGet<TraceFixture[]>(auth, `/orgs/${auth.orgId}/portal/traces`),
      }),
      qc.prefetchQuery({
        queryKey: [...samplingStatsKey],
        queryFn: () =>
          serverGet<SamplingStatsPayload>(
            auth,
            `/orgs/${auth.orgId}/billing/sampling-stats`,
          ),
      }),
    ]),
    budgetMs,
  );
  return dehydrate(qc);
}
