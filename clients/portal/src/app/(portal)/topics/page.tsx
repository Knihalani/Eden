"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, Info, Sparkles } from "lucide-react";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { topicsApi, type TopicCluster } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { downloadFile } from "@/lib/export";
import { formatRelativeTime } from "@/lib/format";

/**
 * FEAT-182 — cluster name/description/keywords are LLM-generated labels
 * over a real trace cluster, not verified fact. Per the AI-fix-skepticism
 * research and UX mandate in
 * `docs/specs/strategic-review-2026-08/features/14-user-request-mining.md`,
 * AI-derived conclusions should ship with a visible evidence trail rather
 * than presenting the label as authoritative — hence the hint + the
 * "view sample traces" evidence link below, instead of a heavier
 * confidence-score UI the backend doesn't compute today.
 */
const AI_LABEL_HINT =
  "Name, description, and keywords are LLM-generated from the clustered traces below — spot-check the sample traces before acting on this cluster.";

const FACETS = ["task", "sentiment", "issues", "custom"] as const;

const TREND_RANK: Record<string, number> = {
  rising: 0,
  flat: 1,
  falling: 2,
};

function sharePct(t: TopicCluster): string {
  if (t.share_pct == null) return "—";
  return `${(t.share_pct * 100).toFixed(1)}%`;
}

function trendBadge(trend: TopicCluster["trend"]): {
  tone: "ok" | "fail" | "neutral" | "live";
  label: string;
} | null {
  if (trend === "rising") return { tone: "live", label: "↑ rising" };
  if (trend === "falling") return { tone: "fail", label: "↓ falling" };
  if (trend === "flat") return { tone: "neutral", label: "→ flat" };
  return null;
}

function sortByTrend(topics: TopicCluster[]): TopicCluster[] {
  return [...topics].sort((a, b) => {
    const ra = TREND_RANK[a.trend ?? ""] ?? 3;
    const rb = TREND_RANK[b.trend ?? ""] ?? 3;
    if (ra !== rb) return ra - rb;
    return (b.sample_count ?? 0) - (a.sample_count ?? 0);
  });
}

/**
 * `/topics` — user-request-mining / trace clustering (FEAT-90 / FEAT-142).
 *
 * Surfaces the F65 HDBSCAN topic clusters (`topics/service.py` +
 * `observability/patterns_clusterer.py`) — eden's analog to the
 * Langfuse/Arize/Helicone/LangSmith "user request mining" category.
 * Lists clusters with share %, keywords, sample counts, trend badges,
 * and a "Generate" action that re-runs the clusterer.
 */
function TopicsInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { pushToast } = useLabToast();
  const [facet, setFacet] = useState<(typeof FACETS)[number]>("task");
  const [exporting, setExporting] = useState(false);

  const topicsQuery = useOrgQuery(
    queryKeys.portal.topics(orgId, facet),
    orgId,
    () => topicsApi.list(orgId!, facet),
    SHELL_QUERY,
  );

  const generate = useOrgMutation(
    async () => topicsApi.generate(orgId!, facet),
    {
      onSuccess: (res) => {
        pushToast({
          title: "Clustering complete",
          body: `${res.data.topics_synced ?? 0} topics synced`,
          tone: "ok",
        });
        void topicsQuery.refetch();
      },
      onError: (err: Error) => {
        pushToast({ title: "Generation failed", body: err.message, tone: "fail" });
      },
    },
  );

  const topics = sortByTrend(topicsQuery.data?.topics ?? []);

  const exportCsv = async () => {
    if (!orgId || exporting) return;
    setExporting(true);
    try {
      const csv = await topicsApi.exportCsv(orgId, facet);
      const date = new Date().toISOString().slice(0, 10);
      downloadFile(`topics-${orgId}-${facet}-${date}.csv`, csv, "text/csv;charset=utf-8");
      pushToast({ title: "Exported topics as CSV", tone: "ok" });
    } catch (err) {
      pushToast({
        title: "Export failed",
        body: err instanceof Error ? err.message : String(err),
        tone: "fail",
      });
    } finally {
      setExporting(false);
    }
  };

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Topics"
        message="Select a workspace to view topic clusters."
      />
    );
  }

  const meta = (
    <span className="type-meta">
      {topics.length} topic{topics.length === 1 ? "" : "s"} · facet {facet}
    </span>
  );

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Topics"
        meta={meta}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-secondary ds-btn-sm"
              disabled={exporting || topics.length === 0}
              onClick={() => void exportCsv()}
            >
              <Download className="h-4 w-4" />
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={generate.isPending}
              onClick={() => void generate.mutateAsync()}
            >
              <Sparkles className="h-4 w-4" />
              {generate.isPending ? "Clustering…" : "Generate clusters"}
            </button>
          </div>
        }
      />

      <div className="border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="type-meta text-[var(--text-muted)]">Facet</span>
          {FACETS.map((f) => (
            <button
              key={f}
              type="button"
              className={`ds-tab ${facet === f ? "is-active" : ""}`}
              onClick={() => setFacet(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {topicsQuery.isLoading ? (
          <QueryLoadingPanel label="Loading topics…" />
        ) : topicsQuery.isError ? (
          <QueryErrorPanel
            error={topicsQuery.error}
            onRetry={() => void topicsQuery.refetch()}
          />
        ) : topics.length === 0 ? (
          <EmptyState
            title="No topic clusters yet"
            body="Run Generate clusters to run the HDBSCAN clusterer over recent traces and surface recurring request patterns."
          />
        ) : (
          <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {topics.map((t) => {
              const badge = trendBadge(t.trend);
              return (
                <div
                  key={t.id}
                  className="ds-panel flex flex-col gap-2 p-4 transition-colors hover:border-[var(--accent)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <h3 className="type-ui min-w-0 truncate">{t.name}</h3>
                      <span
                        className="inline-flex shrink-0 text-[var(--text-faint)]"
                        role="img"
                        aria-label={AI_LABEL_HINT}
                        title={AI_LABEL_HINT}
                      >
                        <Info className="h-3.5 w-3.5" />
                      </span>
                    </span>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {badge ? (
                        <StatusChip tone={badge.tone}>{badge.label}</StatusChip>
                      ) : null}
                      <StatusChip tone={t.sample_count >= 10 ? "live" : "neutral"}>
                        {t.sample_count} samples
                      </StatusChip>
                    </div>
                  </div>
                  {t.description && (
                    <p className="line-clamp-2 text-sm text-[var(--text-muted)]">
                      {t.description}
                    </p>
                  )}
                  {t.keywords.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {t.keywords.slice(0, 6).map((k) => (
                        <span
                          key={k}
                          className="rounded-full border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--text-muted)]"
                        >
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                  {t.representative_trace_ids.length > 0 && (
                    <Link
                      href={`/traces?id=${encodeURIComponent(t.representative_trace_ids[0])}`}
                      className="type-meta text-[var(--accent)] hover:underline"
                    >
                      Review {t.representative_trace_ids.length} sample trace
                      {t.representative_trace_ids.length === 1 ? "" : "s"} →
                    </Link>
                  )}

                  <div className="mt-auto flex items-center justify-between pt-1">
                    <span className="type-meta text-[var(--text-faint)]">
                      share {sharePct(t)}
                      {t.recent_count != null && t.baseline_count != null
                        ? ` · ${t.recent_count}/${t.baseline_count}`
                        : ""}
                    </span>
                    <span className="type-meta text-[var(--text-faint)]">
                      {t.last_seen ? formatRelativeTime(t.last_seen) : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TopicsPage() {
  return <TopicsInner />;
}
