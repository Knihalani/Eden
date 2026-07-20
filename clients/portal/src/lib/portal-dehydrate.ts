/**
 * P18 — minimal RSC prefetch + dehydrate helpers for dashboard/traces.
 *
 * Server pages can call these to seed React Query cache and wrap
 * client trees in ``HydrationBoundary``. Client query keys must match
 * ``queryKeys.observability.traces`` / ``queryKeys.dashboard.*`` /
 * ``ME_QUERY_KEY`` (``["auth","me"]``).
 */

import {
  QueryClient,
  dehydrate,
  type DehydratedState,
} from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

const DEFAULT_DAYS = 7;
const DEFAULT_TRACE_LIMIT = 50;

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
   * Full ``/auth/me`` body already fetched by the layout.
   * Seeded under ``ME_QUERY_KEY`` so the client does not immediately
   * re-hit ``/auth/me`` on hydrate (staleTime 60s on useMeQuery).
   */
  me: MePrefetchPayload;
};

/**
 * Prefetch must NOT resolve `null` on !res.ok / network failure.
 * A successful dehydrate of null + client staleTime (60s) painted
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

/** Prefetch dashboard home shards (me + traces + summary) for hydration. */
export async function dehydrateDashboardHome(
  auth: PortalPrefetchAuth,
): Promise<DehydratedState> {
  const qc = new QueryClient();
  const tracesKey = queryKeys.observability.traces(auth.orgId, {
    limit: DEFAULT_TRACE_LIMIT,
    days: DEFAULT_DAYS,
  });
  const summaryKey = queryKeys.observability.summary(auth.orgId, {
    window_hours: 24,
    compare_previous: true,
  });
  await Promise.all([
    seedMeQuery(qc, auth.me),
    qc.prefetchQuery({
      queryKey: [...tracesKey],
      queryFn: () =>
        serverGet(
          auth,
          `/orgs/${auth.orgId}/observability/traces?limit=${DEFAULT_TRACE_LIMIT}&days=${DEFAULT_DAYS}`,
        ),
    }),
    qc.prefetchQuery({
      queryKey: [...summaryKey],
      queryFn: () =>
        serverGet(
          auth,
          `/orgs/${auth.orgId}/observability/summary?window_hours=24&compare_previous=true`,
        ),
    }),
  ]);
  return dehydrate(qc);
}

/** Prefetch traces hub list + me for hydration (shared days with dashboard). */
export async function dehydrateTracesHub(
  auth: PortalPrefetchAuth,
  filters?: { realm?: string; outcome?: string; agent_id?: string; limit?: number },
): Promise<DehydratedState> {
  const qc = new QueryClient();
  const limit = filters?.limit ?? DEFAULT_TRACE_LIMIT;
  // Must include ``offset: 0`` so the dehydrate key matches the
  // client traces hub query (``traceFilterParams`` with pageOffset).
  const params: Record<string, unknown> = {
    days: DEFAULT_DAYS,
    limit,
    offset: 0,
  };
  if (filters?.realm) params.realm = filters.realm;
  if (filters?.outcome) params.outcome = filters.outcome;
  if (filters?.agent_id) params.agent_id = filters.agent_id;
  const key = queryKeys.observability.traces(auth.orgId, params);
  const q = new URLSearchParams();
  q.set("days", String(DEFAULT_DAYS));
  q.set("limit", String(limit));
  if (filters?.realm) q.set("realm", filters.realm);
  if (filters?.outcome) q.set("outcome", filters.outcome);
  if (filters?.agent_id) q.set("agent_id", filters.agent_id);
  await Promise.all([
    seedMeQuery(qc, auth.me),
    qc.prefetchQuery({
      queryKey: [...key],
      queryFn: () =>
        serverGet(auth, `/orgs/${auth.orgId}/observability/traces?${q.toString()}`),
    }),
  ]);
  return dehydrate(qc);
}
