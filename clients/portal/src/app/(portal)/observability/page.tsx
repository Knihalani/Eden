"use client";

/**
 * /observability — landing page (June 2026 UI overhaul + B2B research pass).
 *
 * Hub for every "Observe"-group surface. The page is data-light on
 * purpose: it shows live status tiles so the user knows whether
 * anything needs attention, then routes them to the dedicated sub-
 * routes via cards. When `?trace_id=` is present, the right-rail
 * shows trace summary and judge scores via SelectedTraceRail.
 *
 * B2B pattern roles applied:
 *   • Pattern 6.3 (Helicone): 6 categorized KPI tiles with deltas
 *   • Pattern 3.5 (Datadog): Watchdog Insights carousel below tiles
 */
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { Activity, BarChart3, Brain, Compass, History, Network, Sparkles, ArrowRight, TrendingUp, Zap, DollarSign, AlertOctagon, Bot, LineChart, RefreshCw, Radio } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { api, agentsApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SelectedTraceRail } from "./_components/SelectedTraceCard";
interface SubPage {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{
    className?: string;
  }>;
}
const SUBPAGES: SubPage[] = [{
  href: "/observability/mcp",
  title: "MCP SRE",
  description: "MCP server auth failures, toolchain health, and fleet graph",
  icon: Radio
}, {
  href: "/observability/decisions",
  title: "Decisions",
  description: "Trace the choice points in your agent's reasoning",
  icon: Compass
}, {
  href: "/observability/eval",
  title: "Eval",
  description: "Judge scores, comparison, and quality signals",
  icon: BarChart3
}, {
  href: "/observability/memory",
  title: "Memory",
  description: "Episodic + semantic memory attribution and reweaving",
  icon: Brain
}, {
  href: "/observability/query",
  title: "Query",
  description: "Trace Query DSL with EQL syntax over the columnar engine",
  icon: Sparkles
}, {
  href: "/observability/cohorts",
  title: "Columnar Engine",
  description: "Read-only SQL across ClickHouse partitions and rollups",
  icon: Activity
}, {
  href: "/observability/retrieval",
  title: "Retrieval",
  description: "Chunk attribution, gap detection, and reorder signals",
  icon: Network
}, {
  href: "/observability/time-travel",
  title: "Time-Travel",
  description: "Replay traces with point-in-time state restoration",
  icon: History
}];

// Pattern 3.5 (Datadog): Each "insight" is an auto-detected anomaly
// the v2.5 detectors have surfaced. Cards link directly to the most
// relevant /observability surface. We surface up to 6 at a time —
// the rest live in /observability/eval.
interface Insight {
  id: string;
  severity: "high" | "medium" | "low";
  kind: "latency" | "cost" | "eval" | "drift";
  title: string;
  description: string;
  href: string;
}
export default function ObservabilityLanding() {
  const { currentOrg, authError, orgSyncing, orgSyncTimedOut, refreshOrgs } = useOrg();
  // Stable primitive dep — `currentOrg` is a fresh Clerk-wrapped
  // object reference on every parent render; keying queries on
  // `orgId` (a string) instead is what makes the dep "stable" per
  // the Phase 1 fix (previously the effect keyed on `currentOrg`
  // directly).
  const orgId = currentOrg?.id ?? null;

  const summaryQuery = useOrgQuery(
    queryKeys.observability.summary(orgId, { window_hours: 24, compare_previous: true }),
    orgId,
    () => api.getObservabilitySummary(orgId!, { window_hours: 24, compare_previous: true }),
  );
  const agentsQuery = useOrgQuery(
    queryKeys.agents.list(orgId, { limit: 1 }),
    orgId,
    () => agentsApi.list(orgId!, { limit: 1 }),
  );
  // Best-effort supplementary data — a failure here degrades the
  // Watchdog Insights carousel (fewer cards), it never blocks the
  // page or surfaces a top-level error.
  const insightsQuery = useOrgQuery(
    queryKeys.insights.overview(orgId),
    orgId,
    () => api.getInsightsOverview(orgId!),
  );

  const summary = summaryQuery.data;
  const previous = summary?.previous;
  const loading = summaryQuery.isLoading || agentsQuery.isLoading;

  const traces24h = summary?.total_traces ?? 0;
  const traces24hPrev = previous?.total_traces ?? null;
  const p95LatencyMs = summary?.p95_ms ?? 0;
  const p95LatencyPrev = previous?.p95_ms ?? null;
  const costTodayCents = Math.round((summary?.total_cost_usd ?? 0) * 100);
  const costYesterdayCents = previous ? Math.round((previous.total_cost_usd ?? 0) * 100) : null;
  const errorRate = summary?.error_rate ?? 0;
  const errorRatePrev = previous?.error_rate ?? null;
  // Registered-agent total (agentsApi.list().total), not the length
  // of a `limit: 1` page — that used to always read 0 or 1
  // regardless of how many agents actually exist. June 2026 fix.
  const activeAgents = agentsQuery.data?.total ?? 0;
  const evalCoverage = summary?.eval_coverage_pct ?? 0;

  const insights = useMemo<Insight[]>(() => {
    const generated: Insight[] = [];
    for (const mode of summary?.top_failure_modes?.slice(0, 4) ?? []) {
      generated.push({
        id: `failure-${mode.name}`,
        severity: mode.count > 10 ? "high" : "medium",
        kind: "drift",
        title: mode.name,
        description: `${mode.count} failures in the last 24h`,
        href: "/issues",
      });
    }
    const overview = insightsQuery.data ?? null;
    for (const insight of overview?.insights?.recent?.slice(0, 2) ?? []) {
      generated.push({
        id: `insight-${insight.insight_id}`,
        severity:
          insight.severity === "critical" || insight.severity === "high"
            ? "high"
            : "medium",
        kind: "eval",
        title: insight.detector,
        description: insight.summary,
        href: "/insights",
      });
    }
    if (evalCoverage > 0 && evalCoverage < 0.4 && generated.length < 6) {
      generated.push({
        id: "eval-coverage",
        severity: "low",
        kind: "eval",
        title: `Eval coverage ${(evalCoverage * 100).toFixed(0)}% of traces`,
        description: "Wire up a judge via /observability/eval to close this gap.",
        href: "/observability/eval",
      });
    }
    return generated;
  }, [summary, insightsQuery.data, evalCoverage]);

  // Pattern 6.3 (Helicone): compute deltas vs previous period for every KPI
  // tile. Returning null hides the delta badge entirely (instead of
  // showing "—%" which would be noisy during cold-start, or a lie
  // for tiles with no real prior-period source).
  const deltaPct = (now: number, prev: number | null): number | null => {
    if (prev == null || prev <= 0) return null;
    return (now - prev) / prev * 100;
  };
  const deltaTiles = useMemo(() => [{
    key: "traces24h",
    icon: Activity,
    label: "Traces · 24h",
    value: traces24h,
    delta: deltaPct(traces24h, traces24hPrev),
    good: "up" as const,
    format: formatNumber,
    href: "/traces",
    tone: "accent" as const
  }, {
    key: "p95",
    icon: Zap,
    label: "p95 latency",
    value: p95LatencyMs,
    delta: deltaPct(p95LatencyMs, p95LatencyPrev),
    good: "down" as const,
    format: (v: number | string) => `${Math.round(Number(v))}ms`,
    href: "/observability/eval",
    tone: "neutral" as const
  }, {
    key: "cost",
    icon: DollarSign,
    label: "Cost today",
    value: costTodayCents,
    delta: deltaPct(costTodayCents, costYesterdayCents),
    good: "down" as const,
    format: (v: number | string) => `$${(Number(v) / 100).toFixed(2)}`,
    href: "/optimization",
    tone: "neutral" as const
  }, {
    key: "error",
    icon: AlertOctagon,
    label: "Error rate",
    value: errorRate,
    delta: deltaPct(errorRate, errorRatePrev),
    good: "down" as const,
    format: (v: number | string) => `${(Number(v) * 100).toFixed(1)}%`,
    href: "/observability/eval",
    tone: errorRate > 0.1 ? "error" as const : "neutral" as const
  }, {
    key: "agents",
    icon: Bot,
    label: "Active agents",
    value: activeAgents,
    // No real prior-period source for the registered-agent count
    // (agentsApi.list() isn't time-windowed) — showing a delta here
    // used to be a fabricated `count - 1`. Better to hide the badge
    // than lie about it (same call the eval-coverage tile makes).
    delta: null,
    good: "up" as const,
    format: formatNumber,
    href: "/agents",
    tone: "neutral" as const
  }, {
    key: "eval",
    icon: LineChart,
    label: "Eval coverage",
    value: evalCoverage,
    delta: null,
    // no previous-period column for eval coverage
    good: "up" as const,
    format: (v: number | string) => `${(Number(v) * 100).toFixed(0)}%`,
    href: "/observability/eval",
    tone: evalCoverage < 0.4 ? "warning" as const : "accent" as const
  }], [traces24h, traces24hPrev, p95LatencyMs, p95LatencyPrev, costTodayCents, costYesterdayCents, errorRate, errorRatePrev, activeAgents, evalCoverage]);

  // No-org branch: mirrors the dashboard's guard so a brand-new
  // signup doesn't see a wall of zeroed KPI tiles.
  if (!currentOrg && !authError) {
    return (
      <NoOrgState
        feature="Observability"
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
      />
    );
  }

  // Real (non-404) summary failure with no cached data to fall back
  // on — show a retry rather than a hub full of misleading zeros.
  if (summaryQuery.isError && !summaryQuery.data) {
    return (
      <PageContent size="wide">
        <PageHeader
          eyebrow="Observe"
          title="Observability"
          subtitle="Inspect, evaluate, and replay every interaction in your agent stack"
          icon={Activity}
        />
        <ErrorState
          title="Could not load observability data"
          message={summaryQuery.error?.message}
          action={
            <Button onClick={() => void summaryQuery.refetch()} variant="outline" size="default">
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          }
        />
      </PageContent>
    );
  }

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Observe"
        title="Observability"
        subtitle="Inspect, evaluate, and replay every interaction in your agent stack"
        icon={Activity}
      />

      <div className="space-y-6">
        {/* Pattern 4.4 (Honeycomb) — When the URL carries ?trace_id=…,
            the SelectedTraceRail renders as a sticky sidebar on lg+
            viewports. On mobile it stacks above the KPI tiles. */}
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1 min-w-0 space-y-6">
            <section>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {deltaTiles.map(tile => <KpiTile key={tile.key} icon={tile.icon} label={tile.label} value={tile.value} delta={tile.delta} good={tile.good} format={tile.format} href={tile.href} tone={tile.tone} loading={loading} />)}
              </div>
            </section>

            {/* Pattern 3.5 (Datadog) — Watchdog Insights carousel.
                Hides entirely when there are no insights (cold start). */}
            {insights.length > 0 && <InsightsCarousel insights={insights} />}

            {/* Sub-page cards */}
            <section>
              <header className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  Drill into
                </h2>
                <span className="text-xs text-[var(--text-muted)]">
                  {SUBPAGES.length} surfaces
                </span>
              </header>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {SUBPAGES.map(s => <Link key={s.href} href={s.href} className="group">
                    <Card variant="interactive" className={cn("h-full p-5 transition-all duration-150", "hover:border-[var(--accent)]/50")}>
                      <div className="flex items-start justify-between mb-3">
                        <s.icon className="h-6 w-6 text-[var(--accent)]" />
                        <ArrowRight className="h-4 w-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
                      </div>
                      <h3 className="text-base font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                        {s.title}
                      </h3>
                      <p className="mt-1 text-sm text-[var(--text-secondary)] line-clamp-2">
                        {s.description}
                      </p>
                    </Card>
                  </Link>)}
              </div>
            </section>

            <p className="pt-2 text-center text-xs text-[var(--text-muted)]">
              Looking for the trace list? It moved to{" "}
              <Link href="/traces" className="text-[var(--accent)] hover:underline">
                /traces
              </Link>
              .
            </p>
          </div>

          {/* Pattern 4.4 — sticky right rail. SelectedTraceRail returns
              null when no ?trace_id is present, so the layout collapses
              to a single column cleanly. */}
          <SelectedTraceRail />
        </div>
      </div>
    </PageContent>
  );
}

function formatNumber(v: number | string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

/** Single KPI tile with delta badge. Pattern 6.3 (Helicone). */
function KpiTile({
  icon: Icon,
  label,
  value,
  delta,
  good,
  format,
  href,
  tone,
  loading
}: {
  icon: React.ComponentType<{
    className?: string;
  }>;
  label: string;
  value: number | string;
  delta: number | null;
  good: "up" | "down";
  format: (v: number | string) => string;
  href: string;
  tone: "accent" | "warning" | "error" | "neutral";
  loading: boolean;
}) {
  // Hide the tile when the underlying value is zero AND the API isn't
  // still loading — otherwise a brand-new tenant lands on a confusing
  // grid full of "0" and "—%". We still render the tile if delta is
  // computable, so cold-starts with prior-period data surface.
  const isZero = Number(value) === 0 || value == null;
  if (isZero && loading) {
    return <Card padding="md" className="h-full min-h-[112px] flex flex-col justify-center gap-2" aria-busy="true" aria-live="polite">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-3 w-20" />
      </Card>;
  }
  const toneClass = tone === "accent" ? "text-[var(--accent)] bg-[var(--accent-faint)]" : tone === "error" ? "text-[var(--error)] bg-[var(--error-dim)]" : tone === "warning" ? "text-[var(--warning)] bg-[var(--warning-bg)]" : "text-[var(--text-secondary)] bg-[var(--bg-tertiary)]";
  const deltaText = delta == null ? null : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`;
  const deltaIsPositive = delta != null && delta >= 0;
  // "good" direction decides which colour the delta badge uses —
  // lower error rate is good, so a -12% delta gets a green badge.
  const deltaIsGood = delta != null && deltaIsPositive === (good === "up");
  return <Link href={href} className={cn("block bg-[var(--bg-primary)] rounded-xl p-4 border border-[var(--border-default)] h-full", "hover:border-[var(--accent)]/40 transition-colors")}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn("p-1.5 rounded-md shrink-0", toneClass)}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium truncate">
            {label}
          </span>
        </div>
        {deltaText && <span className={cn("text-[10px] font-mono font-medium px-1.5 py-0.5 rounded shrink-0", deltaIsGood ? "text-[var(--terminal)] bg-[var(--terminal-faint)]" : "text-[var(--error)] bg-[var(--error-dim)]")} title={`${deltaText} vs previous period`}>
            {deltaText}
          </span>}
      </div>
      <p className="text-2xl font-bold tracking-tight font-mono text-[var(--text-primary)] tabular-nums">
        {format(value)}
      </p>
    </Link>;
}

/** Pattern 3.5 (Datadog) — Horizontal scrolling card carousel of
 *  auto-detected insights. Native scroll, hidden scrollbar via the
 *  no-scrollbar utility class. Auto-scrolls a tiny amount on mount
 *  for affordance. */
function InsightsCarousel({
  insights
}: {
  insights: Insight[];
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // ponytail: tiny one-shot nudge so the user notices the carousel
  // scrolls. ~6px right then back, fires after the entrance animation.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const t = window.setTimeout(() => {
      el.scrollBy({
        left: 6,
        behavior: "smooth"
      });
      window.setTimeout(() => el.scrollBy({
        left: -6,
        behavior: "smooth"
      }), 220);
    }, 600);
    return () => window.clearTimeout(t);
  }, []);
  return <section>
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[var(--warning)]" />
          Watchdog Insights
        </h2>
        <span className="text-xs text-[var(--text-muted)]">
          {insights.length} auto-detected
        </span>
      </header>
      <div ref={ref} className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory no-scrollbar">
        {insights.map(ins => <InsightCard key={ins.id} insight={ins} />)}
      </div>
    </section>;
}
function InsightCard({
  insight
}: {
  insight: Insight;
}) {
  const sevTone = insight.severity === "high" ? "border-[var(--error)]/30 bg-[var(--error-dim)]/40" : insight.severity === "medium" ? "border-[var(--warning)]/30 bg-[var(--warning-bg)]/40" : "border-[var(--border-default)] bg-[var(--bg-primary)]";
  const sevLabel = insight.severity === "high" ? "High" : insight.severity === "medium" ? "Medium" : "Low";
  const sevColor = insight.severity === "high" ? "text-[var(--error)]" : insight.severity === "medium" ? "text-[var(--warning)]" : "text-[var(--text-muted)]";
  return <div className={cn("snap-start shrink-0 w-72 rounded-xl border p-4 flex flex-col gap-2", sevTone)}>
      <div className="flex items-center justify-between">
        <span className={cn("text-[10px] font-bold uppercase tracking-wider", sevColor)}>
          {sevLabel}
        </span>
        <Link href={insight.href} className="text-[11px] text-[var(--accent)] hover:underline inline-flex items-center gap-1">
          Open <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <p className="text-sm font-semibold text-[var(--text-primary)] leading-snug">
        {insight.title}
      </p>
      <p className="text-xs text-[var(--text-secondary)] line-clamp-2">
        {insight.description}
      </p>
    </div>;
}
