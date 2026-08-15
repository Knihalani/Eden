"use client";

/**
 * Agent detail — Quality tab.
 *
 * Fetches ``GET /orgs/{org}/agents/{agent_id}/quality/trend`` (N03
 * production eval, gated by ``production_eval_sampling_v1``) and renders
 * a small trend chart. The recharts island is dynamically imported so
 * the /agents bundle stays chart-free until this tab is opened.
 */

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { EmptyState } from "@/lab/lab-ui";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey } from "@/lib/query-keys";
import { productionEvalApi } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";

const AgentQualityTrendChart = dynamic(
  () =>
    import("./agent-quality-trend").then((m) => ({
      default: m.AgentQualityTrendChart,
    })),
  {
    ssr: false,
    loading: () => <QueryLoadingPanel label="Loading chart…" />,
  },
);

const TREND_HOURS = 168;

/** Flag-off / not-rolled-out responses should read as "not available", not as a hard error. */
function isFeatureUnavailable(err: unknown): boolean {
  const status =
    (err as { status?: number; statusCode?: number } | null)?.status ??
    (err as { statusCode?: number } | null)?.statusCode;
  if (status === 403 || status === 404) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /403|404|feature|flag|not found|forbidden/i.test(msg);
}

export function AgentQualityTab({
  orgId,
  agentId,
}: {
  orgId: string | null;
  agentId: string;
}) {
  const trendQuery = useOrgQuery(
    queryKey("agentQualityTrend", orgId, agentId, TREND_HOURS),
    orgId,
    () => productionEvalApi.qualityTrend(orgId!, agentId, TREND_HOURS),
    SHELL_QUERY,
  );

  const trend = useMemo(
    () => trendQuery.data?.data?.trend ?? [],
    [trendQuery.data],
  );

  if (trendQuery.isLoading) {
    return <QueryLoadingPanel label="Loading quality trend…" />;
  }

  if (trendQuery.isError) {
    if (isFeatureUnavailable(trendQuery.error)) {
      return (
        <EmptyState
          title="Quality trend not available"
          body="Production eval sampling (production_eval_sampling_v1) is not enabled for this workspace yet."
          compact
        />
      );
    }
    return (
      <div className="p-5">
        <QueryErrorPanel
          error={trendQuery.error}
          onRetry={() => void trendQuery.refetch()}
        />
      </div>
    );
  }

  if (trend.length === 0) {
    return (
      <EmptyState
        title="No quality scores yet"
        body="Sampled production evals show up here once this agent's runs have been scored in the last 7 days."
        compact
      />
    );
  }

  const latest = trend[trend.length - 1];
  const scored = trend.reduce((s, p) => s + p.n, 0);

  return (
    <div className="space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h3 className="type-ui">Quality trend</h3>
          <p className="type-meta mt-0.5">
            Sampled production eval scores · last 7 days · {scored} scored runs
          </p>
        </div>
        {latest ? (
          <p className="type-meta">
            latest avg{" "}
            <span className="text-[var(--text)]">
              {latest.avg_score.toFixed(2)}
            </span>
            {" · "}
            fail rate{" "}
            <span
              className={
                latest.fail_rate > 0.1 ? "text-[var(--error)]" : "text-[var(--text)]"
              }
            >
              {(latest.fail_rate * 100).toFixed(0)}%
            </span>
          </p>
        ) : null}
      </div>
      <AgentQualityTrendChart trend={trend} />
    </div>
  );
}
