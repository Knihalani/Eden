"use client";

/**
 * use-observability-data — TanStack Query hooks for the observability
 * surface. Extracted from observability/page.tsx (June 2026) so that
 * the new /traces route, the landing, and the per-sub-route pages can
 * all share the same fetch + cache logic.
 *
 * Cache strategy: traces list has a 30s staleTime (the user is
 * likely to re-render with new filters); the per-trace detail
 * (tree, timeline, heatmap, compare) is 60s since the trace is
 * immutable once completed.
 */

import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";

const DETAIL_STALE_TIME = 60_000; // 60s — trace detail is immutable
const LIST_STALE_TIME = 30_000;   // 30s — list re-fetches on filter change anyway

export function useObservabilityTraces(
  orgId: string | undefined,
  filter: { realm?: string; outcome?: string; agent_id?: string; limit?: number } = {}
) {
  return useApiQuery(
    ["observability", "traces", orgId, filter],
    () => {
      if (!orgId) throw new Error("orgId required");
      return api.listObservabilityTraces(orgId, {
        ...(filter.realm ? { realm: filter.realm } : {}),
        ...(filter.outcome ? { outcome: filter.outcome } : {}),
        ...(filter.agent_id ? { agent_id: filter.agent_id } : {}),
        limit: filter.limit ?? 50,
      });
    },
    { enabled: Boolean(orgId), staleTime: LIST_STALE_TIME }
  );
}

export function useTraceTree(orgId: string | undefined, traceId: string | null | undefined) {
  return useApiQuery(
    ["observability", "tree", orgId, traceId],
    () => {
      if (!orgId || !traceId) throw new Error("orgId + traceId required");
      return api.getTraceTree(orgId, traceId);
    },
    { enabled: Boolean(orgId && traceId), staleTime: DETAIL_STALE_TIME }
  );
}

export function useTraceTimeline(orgId: string | undefined, traceId: string | null | undefined) {
  return useApiQuery(
    ["observability", "timeline", orgId, traceId],
    () => {
      if (!orgId || !traceId) throw new Error("orgId + traceId required");
      return api.getTraceTimeline(orgId, traceId);
    },
    { enabled: Boolean(orgId && traceId), staleTime: DETAIL_STALE_TIME }
  );
}

export function useHeatmap(
  orgId: string | undefined,
  metric: string,
  options: { days?: number } = {}
) {
  return useApiQuery(
    ["observability", "heatmap", orgId, metric, options],
    () => {
      if (!orgId) throw new Error("orgId required");
      return api.getObservabilityHeatmap(orgId, metric, { days: options.days ?? 7 });
    },
    { enabled: Boolean(orgId), staleTime: DETAIL_STALE_TIME }
  );
}
