"use client";

import { useState } from "react";
import {
  ChevronRight,
  Lightbulb,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { api, type InsightsOverviewResponse } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { SeverityIcon } from "@/components/ui/status-badge";
import { Alert } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

type OverviewData = InsightsOverviewResponse;
type Insight = OverviewData["insights"]["recent"][0];

const MAX_RECENT = 8;

function isOverviewEmpty(data: OverviewData): boolean {
  return data.summary.total_insights === 0 && data.insights.recent.length === 0;
}

/** Thin Insights panel — ≤2 KPIs + recent list via QueryState. */
export function InsightsPanel() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<Insight | null>(null);

  const overviewQuery = useOrgQuery(
    queryKeys.insights.overview(orgId),
    orgId,
    () => api.getInsightsOverview(orgId!),
  );

  async function handleRunDetectors() {
    if (!orgId) return;
    if (overviewQuery.data?.summary?.source === "postgres") {
      toast.error(
        "Detectors run via background loop",
        "This overview reads Postgres. Manual Run Detectors only updates the in-memory demo store.",
      );
      return;
    }
    setRunning(true);
    try {
      const insights = await api.runDetectors(orgId, {});
      const n = insights.length;
      toast.success(
        "Detectors finished",
        n === 0
          ? "No new insights this run."
          : `${n} insight${n === 1 ? "" : "s"} ready below.`,
      );
      await overviewQuery.refetch();
    } catch (err) {
      toast.error(
        "Detectors failed",
        err instanceof Error ? err.message : "Failed to run detectors",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <div data-testid="analytics-insights-panel" data-wave6-analytics="insights-thin">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={() => void handleRunDetectors()}
          loading={running}
          aria-label="Run insight detectors now"
        >
          <Play className="h-4 w-4" />
          Run Detectors
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void overviewQuery.refetch()}
          aria-label="Refresh insights overview"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {overviewQuery.data?.summary?.source === "in_memory" ? (
        <Alert
          variant="warning"
          title="demo/in-memory — production detector loop writes separately"
          description={
            overviewQuery.data.summary.honesty_banner ??
            "This overview is from the process-local InsightsService store."
          }
          className="mb-3"
        />
      ) : null}

      <QueryState
        loading={overviewQuery.isLoading}
        error={overviewQuery.error}
        data={overviewQuery.data}
        onRetry={() => void overviewQuery.refetch()}
        isEmpty={(d) => isOverviewEmpty(d)}
        emptySlot={
          <EmptyState
            icon={Lightbulb}
            title="No insights yet"
            description="Send traces, then run detectors to surface quality patterns."
            size="md"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void handleRunDetectors()}
                  loading={running}
                >
                  <Play className="h-4 w-4" />
                  Run Detectors
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                    Docs
                  </a>
                </Button>
              </div>
            }
          />
        }
        errorTitle="Could not load insights"
      >
        {(data) => (
          <div className="space-y-4">
            {/* Cap: ≤2 glance metrics — flat strip, not card walls */}
            <div
              className="grid max-w-md grid-cols-2 gap-4"
              data-testid="insights-kpi-cap"
            >
              <QuietKpi label="Traces" value={data.summary.total_traces} />
              <QuietKpi label="Insights" value={data.summary.total_insights} />
            </div>

            <div>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                <Sparkles className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                Recent insights
              </h3>
              <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-default)]">
                {data.insights.recent.slice(0, MAX_RECENT).map((insight) => (
                  <li key={insight.insight_id}>
                    <button
                      type="button"
                      onClick={() => setSelected(insight)}
                      className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-[var(--bg-secondary)]"
                    >
                      <SeverityIcon severity={insight.severity} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                          {insight.summary}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                          {insight.detector} ·{" "}
                          {(insight.confidence * 100).toFixed(0)}% conf
                        </p>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </QueryState>

      <Dialog
        open={selected != null}
        onOpenChange={(o) => !o && setSelected(null)}
      >
        {selected ? (
          <DialogContent className="max-w-lg" aria-describedby={undefined}>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <SeverityIcon severity={selected.severity} />
                <DialogTitle>Insight</DialogTitle>
              </div>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-[var(--text-primary)]">{selected.summary}</p>
              <p className="text-xs text-[var(--text-muted)]">
                {selected.detector} · {(selected.confidence * 100).toFixed(0)}% ·{" "}
                {selected.affected_trace_ids.length} traces
              </p>
              {selected.recommended_action ? (
                <p className="rounded-lg bg-[var(--bg-secondary)] p-3 text-sm">
                  {selected.recommended_action}
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelected(null)}
              >
                Close
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function QuietKpi({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--text-primary)]">
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
    </div>
  );
}
