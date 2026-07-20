"use client";

import Link from "next/link";
import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { api, type InsightsOverviewResponse } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { StatCard } from "@/components/ui/stat-card";
import { SeverityIcon } from "@/components/ui/status-badge";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Lightbulb, Activity, BarChart3, Database, Layers, ChevronRight, Loader2, Sparkles, Play } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Panel } from "@/components/ui/panel";
import { Alert } from "@/components/ui/alert";
import { LoadingSkeleton } from "@/components/ui/skeleton";

type OverviewData = InsightsOverviewResponse;
type Tab = "overview" | "insights" | "closed-loop";

/** True when overview would render zeroed StatCards / empty recent — prefer onboarding EmptyState. */
function isOverviewEmpty(data: OverviewData): boolean {
  return data.summary.total_insights === 0 && data.insights.recent.length === 0;
}

// §3.2 — Closed-loop correlation report (Insights → KB → env quality).
interface CorrelationWeekBucket {
  week_start: string;
  insights_written: number;
  kb_writes: number;
  jobs_in_post_window: number;
  gold_tier_in_post_window: number;
  gold_tier_rate: number | null;
}
interface CorrelationReport {
  organization_id: string | null;
  lookback_days: number;
  weeks: CorrelationWeekBucket[];
  aggregate_post_jobs: number;
  aggregate_post_gold: number;
  aggregate_post_rate: number | null;
  target_slo: number;
  target_slo_met: boolean;
  generated_at: string;
}
export default function InsightsPage() {
  const {
    currentOrg
  } = useOrg();
  const embedded = useEmbeddedSurface();
  const toast = useToast();
  const orgId = currentOrg?.id ?? null;
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [runningDetectors, setRunningDetectors] = useState(false);
  const [selectedInsight, setSelectedInsight] = useState<OverviewData["insights"]["recent"][0] | null>(null);
  const overviewQuery = useOrgQuery(
    queryKeys.insights.overview(orgId),
    orgId,
    () => api.getInsightsOverview(orgId!),
  );
  const overview = overviewQuery.data ?? null;
  const loading = overviewQuery.isLoading;
  const isError = overviewQuery.isError;
  const error = overviewQuery.error?.message ?? "Could not load insights overview.";
  const loadOverview = () => overviewQuery.refetch();
  async function handleRunDetectors() {
    if (!currentOrg) return;
    // Overview prefers Postgres (detector_loop). Manual run only mutates
    // the in-memory store — refuse when the UI is bound to PG so we don't
    // toast a fake success that never appears in the overview.
    if (overview?.summary?.source === "postgres") {
      toast.error(
        "Detectors run via background loop",
        "This overview reads Postgres. Manual Run Detectors only updates the in-memory demo store.",
      );
      return;
    }
    setRunningDetectors(true);
    try {
      const insights = await api.runDetectors(currentOrg.id, {});
      const n = insights.length;
      toast.success(
        "Detectors finished",
        n === 0
          ? "No new insights this run."
          : `${n} insight${n === 1 ? "" : "s"} ready below.`,
      );
      await loadOverview();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to run detectors";
      toast.error("Detectors failed", msg);
    } finally {
      setRunningDetectors(false);
    }
  }
  if (!currentOrg) {
    return <NoOrgState icon={Lightbulb} feature="Insights" description="Insights are org-scoped. Select or create an organization with traces to inspect." />;
  }
  return <PageContent size="wide">
      {!embedded ? (
        <PageHeader
          eyebrow="Analyze"
          title="Insights"
          subtitle="Pattern detection and closed-loop improvement signals"
          icon={Lightbulb}
          actions={
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/analytics?tab=topics">Topic clusters</Link>
              </Button>
              <Button variant="default" size="sm" onClick={handleRunDetectors} loading={runningDetectors} aria-label="Run insight detectors now">
                <Play className="w-4 h-4" />
                Run Detectors
              </Button>
              <Button variant="ghost" size="sm" onClick={loadOverview} aria-label="Refresh insights overview">
                <Activity className="w-4 h-4" />
                Refresh
              </Button>
            </div>
          }
        />
      ) : (
        <div className="mb-space-3 flex flex-wrap items-center gap-2">
          <Button variant="default" size="sm" onClick={handleRunDetectors} loading={runningDetectors} aria-label="Run insight detectors now">
            <Play className="w-4 h-4" />
            Run Detectors
          </Button>
          <Button variant="ghost" size="sm" onClick={loadOverview} aria-label="Refresh insights overview">
            <Activity className="w-4 h-4" />
            Refresh
          </Button>
        </div>
      )}

      {overview?.summary?.source === "in_memory" && (
        <Alert
          variant="warning"
          title="demo/in-memory — production detector loop writes separately"
          description={
            overview.summary.honesty_banner ??
            "This overview is from the process-local InsightsService store, not the Postgres table the detector loop persists to."
          }
        />
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
        <TabsList
          variant={embedded ? "pills" : "underline"}
          aria-label="Insights sections"
          className={
            embedded
              ? "h-auto w-full justify-start gap-1 overflow-x-auto"
              : "h-auto w-full justify-start"
          }
        >
          {(["overview", "insights", "closed-loop"] as Tab[]).map((tab) => (
            <TabsTrigger key={tab} value={tab} variant={embedded ? "pills" : "underline"}>
              {tab === "closed-loop" ? "Closed-loop" : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Content — prefer ErrorState over false empty on load failure */}
      {loading && !overview ? (
        <LoadingSkeleton variant="stats" lines={4} />
      ) : isError && !overview ? (
          <ErrorState
            size="lg"
            title="Could not load insights"
            message={error}
            action={
              <Button variant="outline" onClick={loadOverview}>
                Try again
              </Button>
            }
          />
        ) : overview ? <>
          <div key={activeTab}>
            {activeTab === "overview" && (
              isOverviewEmpty(overview) ? (
                <InsightsEmptyOnboarding
                  runningDetectors={runningDetectors}
                  onRunDetectors={handleRunDetectors}
                />
              ) : (
                <OverviewTab
                  data={overview}
                  onOpenInsight={(insight) => {
                    setActiveTab("insights");
                    setSelectedInsight(insight);
                  }}
                />
              )
            )}
            {activeTab === "insights" && <InsightsTab data={overview.insights} onSelectInsight={setSelectedInsight} />}
            {activeTab === "closed-loop" && <ClosedLoopTab />}
          </div>
        </> : (
          <InsightsEmptyOnboarding
            runningDetectors={runningDetectors}
            onRunDetectors={handleRunDetectors}
          />
        )}

      {/* Insight Detail Modal — Radix Dialog (focus trap + ESC + ARIA) */}
      <Dialog open={selectedInsight !== null} onOpenChange={open => !open && setSelectedInsight(null)}>
        {selectedInsight && <InsightDetailModal insight={selectedInsight} onClose={() => setSelectedInsight(null)} />}
      </Dialog>
    </PageContent>;
}

// ──────────────────────────────────────────────────────────────────────────
// Empty / onboarding (replaces zeroed OverviewTab theater)
// ──────────────────────────────────────────────────────────────────────────

function InsightsEmptyOnboarding({
  runningDetectors,
  onRunDetectors,
}: {
  runningDetectors: boolean;
  onRunDetectors: () => void;
}) {
  return (
    <EmptyState
      title="No insights yet"
      description="No insights yet. They appear after detectors run over your traces. Run Detectors to scan now — about a minute on a fresh dataset."
      size="lg"
      variant="terminal"
      terminal={
        <div className="rounded-lg overflow-hidden border border-[var(--border-default)] bg-[var(--bg-base)] text-left">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
            <span className="w-2 h-2 rounded-full bg-[var(--traffic-close)]" />
            <span className="w-2 h-2 rounded-full bg-[var(--traffic-minimize)]" />
            <span className="w-2 h-2 rounded-full bg-[var(--traffic-zoom)]" />
            <span className="ml-2 text-2xs font-mono text-[var(--text-muted)] tracking-wider">
              insight.preview
            </span>
            <span className="ml-auto inline-flex items-center gap-1 text-2xs font-mono uppercase tracking-[0.18em] text-[var(--terminal)]">
              <span className="w-1 h-1 rounded-full bg-[var(--terminal)]" />
              preview
            </span>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold px-2 py-1 rounded-full bg-[var(--error-bg)] text-[var(--error)]">CRITICAL</span>
              <span className="text-xs font-mono text-[var(--text-muted)]">latency_regression · conf 0.91</span>
            </div>
            <p className="text-sm text-[var(--text-primary)]">
              p95 latency on <span className="font-mono text-[var(--accent)]">tool.search</span> jumped 4.2× in the last 6h across 31 traces.
            </p>
            <div className="text-xs text-[var(--text-muted)] font-mono">
              open_dataset → <span className="text-[var(--terminal)]">/datasets/latency-regression-2026-07-07</span>
            </div>
          </div>
        </div>
      }
      action={
        <Button variant="default" onClick={onRunDetectors} loading={runningDetectors} aria-label="Run insight detectors">
          <Play className="w-4 h-4" />
          Run Detectors
        </Button>
      }
    />
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Overview Tab
// ──────────────────────────────────────────────────────────────────────────

function OverviewTab({
  data,
  onOpenInsight,
}: {
  data: OverviewData;
  onOpenInsight: (insight: OverviewData["insights"]["recent"][0]) => void;
}) {
  const {
    summary,
    traces,
    insights,
  } = data;
  const cards = [{
    label: "Total Traces",
    value: summary.total_traces,
    icon: Layers
  }, {
    label: "Insights Found",
    value: summary.total_insights,
    icon: Sparkles
  }];
  return <div className="space-y-space-6" data-testid="insights-chart-hierarchy">
      {/* Thin KPI strip — overview density (≤2 primary glance metrics) */}
      <div className="grid grid-cols-2 gap-space-3 max-w-xl">
        {cards.map(card => (
          <StatCard
            key={card.label}
            title={card.label}
            value={card.value}
            icon={card.icon}
            accent={card.label === "Total Traces" ? "accent" : "warning"}
          />
        ))}
      </div>

      {/* Primary chart — severity distribution full width */}
      <Panel tone="flat" padding="lg" aria-label="Insights by severity">
        <h3 className="mb-space-4 flex items-center gap-space-2 text-sm font-semibold text-[var(--text-primary)]">
          <BarChart3 className="h-4 w-4 text-[var(--accent)]" />
          Insights by severity
          <span className="ml-auto text-2xs font-normal uppercase tracking-wide text-[var(--text-muted)]">Primary</span>
        </h3>
        <div className="space-y-space-3">
          {["critical", "high", "medium", "low", "info"].map((severity) => {
            const count = insights.by_severity[severity] || 0;
            const total = summary.total_insights || 1;
            const pct = (count / total) * 100;
            const color =
              severity === "critical"
                ? "bg-[var(--error)]"
                : severity === "high"
                  ? "bg-[var(--warning)]"
                  : severity === "medium"
                    ? "bg-[var(--warning)]"
                    : severity === "low"
                      ? "bg-[var(--accent-faint)]"
                      : "bg-[var(--text-muted)]";
            return (
              <div key={severity}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="capitalize text-[var(--text-secondary)]">{severity}</span>
                  <span className="font-medium text-[var(--text-primary)]">{count}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                  <div
                    className={cn("h-full rounded-full transition-all duration-500", color)}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Secondary metrics */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel tone="flat" padding="md" aria-label="Traces by realm">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <Layers className="h-4 w-4 text-[var(--accent)]" />
            Traces by realm
          </h3>
          <div className="space-y-2">
            {Object.entries(traces.by_realm).map(([realm, count]) => {
              const total = summary.total_traces || 1;
              const pct = (count / total) * 100;
              return (
                <div key={realm}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="capitalize text-[var(--text-secondary)]">{realm}</span>
                    <span className="font-medium text-[var(--text-primary)]">{count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {Object.keys(traces.by_realm).length === 0 && (
              <EmptyState
                icon={Activity}
                title="No traces ingested yet"
                description="No traces in this window. Send traffic via the SDK or gateway, then refresh."
                size="sm"
              />
            )}
          </div>
        </Panel>

        <div className="space-y-2" aria-label="Recent insights">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <Sparkles className="h-4 w-4 text-[var(--accent)]" />
            Recent insights
          </h3>
          {insights.recent.length > 0 ? (
            <div className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-default)]">
              {insights.recent.slice(0, 5).map((insight) => (
                <button
                  key={insight.insight_id}
                  type="button"
                  onClick={() => onOpenInsight(insight)}
                  className="flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-[var(--bg-secondary)]"
                >
                  <SeverityIcon severity={insight.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {insight.summary}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-1 text-2xs text-[var(--text-muted)]">
                        {insight.detector}
                      </span>
                      <span className="text-2xs text-[var(--text-muted)]">
                        {(insight.confidence * 100).toFixed(0)}% conf
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Sparkles}
              title="No insights yet"
              description="No insights yet. Run detectors to scan patterns and quality trends in your outputs."
              size="md"
            />
          )}
        </div>
      </div>
    </div>;
}

// ──────────────────────────────────────────────────────────────────────────
// Insights Tab
// ──────────────────────────────────────────────────────────────────────────

function InsightsTab({
  data,
  onSelectInsight
}: {
  data: OverviewData["insights"];
  onSelectInsight: (insight: OverviewData["insights"]["recent"][0]) => void;
}) {
  const [filterSeverity, setFilterSeverity] = useState<string>("");
  const [filterDetector, setFilterDetector] = useState<string>("");
  const detectors = Object.keys(data.by_detector);
  const severities = ["critical", "high", "medium", "low", "info"];
  return <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select value={filterSeverity} onChange={e => setFilterSeverity(e.target.value)} className="px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]">
          <option value="">All Severities</option>
          {severities.map(s => <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>)}
        </select>
        <select value={filterDetector} onChange={e => setFilterDetector(e.target.value)} className="px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]">
          <option value="">All Detectors</option>
          {detectors.map(d => <option key={d} value={d}>
              {d}
            </option>)}
        </select>
      </div>

      {/* Insights List */}
      <div className="space-y-3">
        {data.recent.filter(i => {
        if (filterSeverity && i.severity !== filterSeverity) return false;
        if (filterDetector && i.detector !== filterDetector) return false;
        return true;
      }).map(insight => <button key={insight.insight_id} onClick={() => onSelectInsight(insight)} className="w-full text-left bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 hover:border-[var(--accent)]/30 transition-colors">
              <div className="flex items-start gap-3">
                <SeverityIcon severity={insight.severity} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{insight.summary}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <span className="text-xs px-2 py-1 rounded-full bg-[var(--accent-faint)] text-[var(--accent)]">
                      {insight.detector}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {(insight.confidence * 100).toFixed(0)}% confidence
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {insight.affected_trace_ids.length} affected
                    </span>
                    {insight.auto_created_dataset && <span className="text-xs px-2 py-1 rounded-full bg-[var(--terminal-faint)] text-[var(--terminal)]">
                        Dataset: {insight.auto_created_dataset}
                      </span>}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0 mt-1" />
              </div>
            </button>)}
        {data.recent.length === 0 && <EmptyState icon={Sparkles} title="No insights detected yet" description="No detector results yet. Run detectors to scan quality patterns in your outputs." size="lg" />}
      </div>
    </div>;
}

// ──────────────────────────────────────────────────────────────────────────



function InsightDetailModal({
  insight,
  onClose
}: {
  insight: OverviewData["insights"]["recent"][0];
  onClose: () => void;
}) {
  // P6: Radix DialogContent handles focus trap, ESC, body-scroll
  // lock, and aria-labelledby for the close button. The hand-rolled
  // motion.div overlay wasn't keyboard-navigable and didn't lock
  // the page scroll — opening a detail modal let the underlying
  // list scroll behind it, which was disorienting.
  return <DialogContent className="max-w-lg" aria-describedby={undefined}>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <SeverityIcon severity={insight.severity} />
          <DialogTitle>Insight Detail</DialogTitle>
        </div>
      </DialogHeader>
      <div className="space-y-4">
        <p className="text-sm text-[var(--text-primary)]">{insight.summary}</p>
        <div className="flex flex-wrap gap-2">
          <span className="text-xs px-2 py-1 rounded-full bg-[var(--accent-faint)] text-[var(--accent)]">
            {insight.detector}
          </span>
          <span className="text-xs px-2 py-1 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
            {(insight.confidence * 100).toFixed(0)}% confidence
          </span>
          <span className="text-xs px-2 py-1 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
            {insight.affected_trace_ids.length} traces
          </span>
        </div>
        {insight.recommended_action && <div className="bg-[var(--accent-faint)]/50 rounded-lg p-3">
            <p className="text-xs font-medium text-[var(--accent)] mb-1">Recommended Action</p>
            <p className="text-sm text-[var(--text-primary)]">{insight.recommended_action}</p>
          </div>}
        {insight.auto_created_dataset && <div className="flex items-center gap-2 text-sm text-[var(--terminal)]">
            <Database className="w-4 h-4" />
            Auto-created dataset: {insight.auto_created_dataset}
          </div>}
        {Object.keys(insight.pattern).length > 0 && <div>
            <p className="text-xs font-medium text-[var(--text-muted)] mb-2">Pattern</p>
            <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto">
              {JSON.stringify(insight.pattern, null, 2)}
            </pre>
          </div>}
        {/* Radix DialogContent renders its own close button via
            DialogPrimitive.Close (top-right). Keeping onClose wired
            here so callers can use it for explicit dismissal. */}
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close insight detail">
          Close
        </Button>
      </div>
    </DialogContent>;
}

function ClosedLoopTab() {
  const {
    currentOrg
  } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [days, setDays] = useState(30);
  const correlationQuery = useOrgQuery(
    queryKeys.insights.correlation(orgId, days),
    orgId,
    () => api.get<CorrelationReport>(`/orgs/${orgId}/insights/correlation?days=${days}`),
  );
  const report = correlationQuery.data ?? null;
  const loading = correlationQuery.isLoading;
  const isError = correlationQuery.isError;
  const errorMessage =
    correlationQuery.error instanceof Error
      ? correlationQuery.error.message
      : "Could not load the correlation report.";
  if (loading) {
    return <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
      </div>;
  }
  if (isError) {
    return (
      <ErrorState
        size="lg"
        title="Could not load correlation data"
        message={`${errorMessage} For pending closed-loop actions, visit /improve.`}
        action={
          <Button variant="outline" size="sm" onClick={() => void correlationQuery.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!report) {
    return (
      <EmptyState
        size="lg"
        title="No correlation data yet"
        description="No correlation report yet. After insights drive KB entries, this view shows post-rate vs gold-tier job outcomes."
      />
    );
  }
  const ratePct = report.aggregate_post_rate ? (report.aggregate_post_rate * 100).toFixed(1) : "—";
  const targetPct = (report.target_slo * 100).toFixed(0);
  return <div className="space-y-space-6">
      {/* Primary closed-loop KPI band */}
      <Panel tone="flat" padding="lg">
        <div className="mb-space-4 flex items-start justify-between gap-space-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Closed-loop measurement
            </h3>
            <p className="mt-space-1 text-xs text-[var(--text-muted)]">
              Did insight-driven KB entries correlate with gold-tier jobs in the post-write window?
            </p>
          </div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Lookback window"
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
          </select>
        </div>
        <div className="grid grid-cols-1 gap-space-4 sm:grid-cols-3">
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wide text-[var(--text-muted)]">
              Aggregate gold rate
            </div>
            <div className="text-3xl font-bold text-[var(--text-primary)]">{ratePct}%</div>
            <div className="mt-1 text-xs text-[var(--text-muted)]">target ≥ {targetPct}%</div>
          </div>
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wide text-[var(--text-muted)]">
              SLO target met
            </div>
            <div
              className={cn(
                "text-3xl font-bold",
                report.target_slo_met ? "text-[var(--terminal)]" : "text-[var(--warning)]",
              )}
            >
              {report.target_slo_met ? "✓ YES" : "✗ NO"}
            </div>
          </div>
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wide text-[var(--text-muted)]">
              Jobs in window
            </div>
            <div className="text-3xl font-bold text-[var(--text-primary)]">
              {report.aggregate_post_jobs}
            </div>
            <div className="mt-1 text-xs text-[var(--text-muted)]">
              {report.aggregate_post_gold} gold
            </div>
          </div>
        </div>
      </Panel>

      {/* Secondary table — analysis density */}
      <div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
        <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Per-week breakdown</h3>
          <span className="text-2xs text-[var(--text-muted)]">
            generated {new Date(report.generated_at).toLocaleString()}
          </span>
        </div>
        {report.weeks.length === 0 ? (
          <EmptyState
            size="sm"
            title="No insights written in this window"
            description={`No insights written in the ${days}-day window.`}
            className="px-space-6"
          />
        ) : <DataTable columns={[{
        key: "week_start",
        header: "Week",
        sortable: true,
        cell: w => <span className="font-mono text-xs">{w.week_start}</span>
      }, {
        key: "insights_written",
        header: "Insights",
        sortable: true,
        align: "right",
        cell: w => w.insights_written
      }, {
        key: "kb_writes",
        header: "KB writes",
        sortable: true,
        align: "right",
        cell: w => w.kb_writes
      }, {
        key: "jobs_in_post_window",
        header: "Jobs (post)",
        sortable: true,
        align: "right",
        cell: w => w.jobs_in_post_window
      }, {
        key: "gold_tier_in_post_window",
        header: "Gold-tier",
        sortable: true,
        align: "right",
        cell: w => w.gold_tier_in_post_window
      }, {
        key: "gold_tier_rate",
        header: "Gold rate",
        sortable: true,
        align: "right",
        cell: w => <span className="font-medium">{w.gold_tier_rate ? `${(w.gold_tier_rate * 100).toFixed(1)}%` : "—"}</span>
      }]} rows={report.weeks} rowKey={w => w.week_start} defaultSort={{
        key: "week_start",
        direction: "desc"
      }} emptyTitle="No insights written in this window" emptyDescription="Adjust the days filter or wait for more activity." pageSize={25} />}
      </div>
    </div>;
}