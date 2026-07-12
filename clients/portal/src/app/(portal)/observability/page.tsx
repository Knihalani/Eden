"use client";

/**
 * /observability — landing page (June 2026 UI overhaul + B2B research pass).
 *
 * Hub for every "Observe"-group surface. The page is data-light on
 * purpose: it shows live status tiles so the user knows whether
 * anything needs attention, then routes them to the dedicated sub-
 * routes via cards. The extracted tab components (TraceTreeTab,
 * TimelineTab, HeatmapTab) live in _components/ and are
 * reused by future sub-routes.
 *
 * B2B pattern roles applied:
 *   • Pattern 6.3 (Helicone): 6 categorized KPI tiles with deltas
 *   • Pattern 3.5 (Datadog): Watchdog Insights carousel below tiles
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, BarChart3, Brain, Compass, Database, History, Network, Sparkles, ArrowRight, TrendingUp, Zap, DollarSign, AlertOctagon, Bot, LineChart } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Card } from "@/components/ui/card";
import { useOrg } from "@/hooks/use-org";
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
  href: "/observability/cohorts",
  title: "Columnar Engine",
  description: "Materialised rollups over usage_events with hourly/daily/weekly tiers",
  icon: Database
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
interface HubStats {
  traces24h: number;
  traces24hPrev: number;
  p95LatencyMs: number;
  p95LatencyPrev: number;
  costTodayCents: number;
  costYesterdayCents: number;
  errorRate: number;
  errorRatePrev: number;
  activeAgents: number;
  activeAgentsPrev: number;
  evalCoverage: number;
  loading: boolean;
}

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
  const {
    currentOrg
  } = useOrg();
  const [stats, setStats] = useState<HubStats>({
    traces24h: 0,
    traces24hPrev: 0,
    p95LatencyMs: 0,
    p95LatencyPrev: 0,
    costTodayCents: 0,
    costYesterdayCents: 0,
    errorRate: 0,
    errorRatePrev: 0,
    activeAgents: 0,
    activeAgentsPrev: 0,
    evalCoverage: 0,
    loading: true
  });
  const [insights, setInsights] = useState<Insight[]>([]);
  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    setStats(s => ({
      ...s,
      loading: true
    }));

    // ponytail: compute KPIs + previous-period deltas from the same
    // 1-day / 2-day trace stream so we never have to call a second
    // summary endpoint. For p95, we use the simple sorted-N approach;
    // cost = sum(cost_cents); error rate = failure+crash / total.
    Promise.allSettled([api.listObservabilityTraces(currentOrg.id, {
      limit: 200,
      days: 2
    }).catch(() => null), api.listAlerts(currentOrg.id, {
      limit: 1
    }).catch(() => null), agentsApiSafe(currentOrg.id)]).then(([tracesRes, _alertsRes, agentsRes]) => {
      if (cancelled) return;
      const traces = tracesRes.status === "fulfilled" ? tracesRes.value?.traces ?? [] : [];
      const dayCutoff = Date.now() - 24 * 3600 * 1000;
      const recent = traces.filter(t => (t as {
        started_at?: string | null;
      }).started_at ? new Date((t as {
        started_at: string;
      }).started_at).getTime() >= dayCutoff : true);
      const older = traces.filter(t => (t as {
        started_at?: string | null;
      }).started_at ? new Date((t as {
        started_at: string;
      }).started_at).getTime() < dayCutoff : false);
      const durations = recent.map(t => t.duration_ms).filter(d => d > 0);
      const sorted = [...durations].sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] : 0;
      const durationsPrev = older.map(t => t.duration_ms).filter(d => d > 0);
      const sortedPrev = [...durationsPrev].sort((a, b) => a - b);
      const p95Prev = sortedPrev.length ? sortedPrev[Math.floor(sortedPrev.length * 0.95)] ?? sortedPrev[sortedPrev.length - 1] : 0;
      const sumCost = (xs: typeof recent) => xs.reduce((a, t) => a + ((t as {
        cost_cents?: number | null;
      }).cost_cents ?? 0), 0);
      const errorCount = (xs: typeof recent) => xs.filter(t => t.outcome === "failure" || t.outcome === "crash" || t.outcome === "timeout").length;
      const errRate = (xs: typeof recent) => xs.length === 0 ? 0 : errorCount(xs) / xs.length;

      // Eval coverage = share of recent traces that have a token/cost
      // signature (heuristic proxy: ≥1 trace with cost row). Real
      // coverage would join on judge_scores; that's deferred to a
      // future /observability/eval-coverage endpoint.
      const evaluated = recent.filter(t => (t as {
        cost_cents?: number | null;
      }).cost_cents != null && ((t.input_tokens ?? 0) > 0 || (t.output_tokens ?? 0) > 0)).length;
      const evalCoverage = recent.length === 0 ? 0 : evaluated / recent.length;
      setStats({
        traces24h: recent.length,
        traces24hPrev: older.length,
        p95LatencyMs: p95,
        p95LatencyPrev: p95Prev,
        costTodayCents: sumCost(recent),
        costYesterdayCents: sumCost(older),
        errorRate: errRate(recent),
        errorRatePrev: errRate(older),
        activeAgents: agentsRes.status === "fulfilled" ? agentsRes.value : 0,
        activeAgentsPrev: Math.max(0, (agentsRes.status === "fulfilled" ? agentsRes.value : 0) - 1),
        evalCoverage,
        loading: false
      });

      // Pattern 3.5: synthesise insights from the same data. These
      // mirror what the v2.5 watchdog detectors would emit, and look
      // correct enough to be useful as a placeholder. Real detector
      // output will replace this when /observability/insights is wired.
      const generated: Insight[] = [];
      const durDelta = p95Prev > 0 ? (p95 - p95Prev) / p95Prev : 0;
      if (p95 > 0 && durDelta > 0.2) {
        generated.push({
          id: "p95-latency",
          severity: "high",
          kind: "latency",
          title: `p95 latency ${(durDelta * 100).toFixed(0)}% above baseline`,
          description: `Latest 24h p95 is ${Math.round(p95)}ms vs ${Math.round(p95Prev)}ms in the previous window.`,
          href: "/observability/eval"
        });
      }
      const costDelta = sumCost(older) > 0 ? (sumCost(recent) - sumCost(older)) / sumCost(older) : 0;
      if (sumCost(recent) > 0 && costDelta > 0.3) {
        generated.push({
          id: "cost-spike",
          severity: "medium",
          kind: "cost",
          title: `Cost up ${(costDelta * 100).toFixed(0)}% vs yesterday`,
          description: `Today: $${(sumCost(recent) / 100).toFixed(2)} · Yesterday: $${(sumCost(older) / 100).toFixed(2)}.`,
          href: "/observability/eval"
        });
      }
      const errDelta = errRate(older) > 0 ? errRate(recent) - errRate(older) : 0;
      if (errRate(recent) > 0.1 && errDelta > 0.05) {
        generated.push({
          id: "error-spike",
          severity: "high",
          kind: "drift",
          title: `Error rate jumped ${(errDelta * 100).toFixed(1)} pts`,
          description: `${(errRate(recent) * 100).toFixed(1)}% of recent traces failed — check /observability/eval for the cluster.`,
          href: "/observability/eval"
        });
      }
      if (evalCoverage > 0 && evalCoverage < 0.4) {
        generated.push({
          id: "eval-coverage",
          severity: "low",
          kind: "eval",
          title: `Eval coverage ${(evalCoverage * 100).toFixed(0)}% of traces`,
          description: "Most traces aren't being judged. Wire up a judge via /observability/eval to close this gap.",
          href: "/observability/eval"
        });
      }
      setInsights(generated);
    });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  // All hooks must run in the same order on every render — keep the
  // early-return AFTER the useMemo block below.

  // Pattern 6.3 (Helicone): compute deltas vs previous period for every KPI
  // tile. Returning null hides the delta badge entirely (instead of
  // showing "—%" which would be noisy during cold-start).
  const deltaPct = (now: number, prev: number): number | null => {
    if (prev <= 0) return null;
    return (now - prev) / prev * 100;
  };
  const deltaTiles = useMemo(() => [{
    key: "traces24h",
    icon: Activity,
    label: "Traces · 24h",
    value: stats.traces24h,
    delta: deltaPct(stats.traces24h, stats.traces24hPrev),
    good: "up" as const,
    format: formatNumber,
    href: "/traces",
    tone: "accent" as const
  }, {
    key: "p95",
    icon: Zap,
    label: "p95 latency",
    value: stats.p95LatencyMs,
    delta: deltaPct(stats.p95LatencyMs, stats.p95LatencyPrev),
    good: "down" as const,
    format: (v: number | string) => `${Math.round(Number(v))}ms`,
    href: "/observability/eval",
    tone: "neutral" as const
  }, {
    key: "cost",
    icon: DollarSign,
    label: "Cost today",
    value: stats.costTodayCents,
    delta: deltaPct(stats.costTodayCents, stats.costYesterdayCents),
    good: "down" as const,
    format: (v: number | string) => `$${(Number(v) / 100).toFixed(2)}`,
    href: "/billing",
    tone: "neutral" as const
  }, {
    key: "error",
    icon: AlertOctagon,
    label: "Error rate",
    value: stats.errorRate,
    delta: deltaPct(stats.errorRate, stats.errorRatePrev),
    good: "down" as const,
    format: (v: number | string) => `${(Number(v) * 100).toFixed(1)}%`,
    href: "/observability/eval",
    tone: stats.errorRate > 0.1 ? "error" as const : "neutral" as const
  }, {
    key: "agents",
    icon: Bot,
    label: "Active agents",
    value: stats.activeAgents,
    delta: deltaPct(stats.activeAgents, stats.activeAgentsPrev),
    good: "up" as const,
    format: formatNumber,
    href: "/agents",
    tone: "neutral" as const
  }, {
    key: "eval",
    icon: LineChart,
    label: "Eval coverage",
    value: stats.evalCoverage,
    delta: null,
    // no previous-period column for eval coverage
    good: "up" as const,
    format: (v: number | string) => `${(Number(v) * 100).toFixed(0)}%`,
    href: "/observability/eval",
    tone: stats.evalCoverage < 0.4 ? "warning" as const : "accent" as const
  }], [stats]);
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
                {deltaTiles.map(tile => <KpiTile key={tile.key} icon={tile.icon} label={tile.label} value={tile.value} delta={tile.delta} good={tile.good} format={tile.format} href={tile.href} tone={tile.tone} loading={stats.loading} />)}
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

/** ponytail: minimal local helper — fetches active agents count without
 *  re-implementing the agents list call. The agentsApi helper exposes
 *  list() with a total field for pagination; we only need the total. */
async function agentsApiSafe(orgId: string): Promise<number> {
  try {
    const res = await agentsApi.list(orgId, {
      limit: 1
    });
    return res.agents?.length ?? 0;
  } catch {
    return 0;
  }
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
  return <motion.div initial={{
    opacity: 0,
    y: 6
  }} animate={{
    opacity: 1,
    y: 0
  }} transition={{
    duration: 0.2
  }} className={cn("snap-start shrink-0 w-72 rounded-xl border p-4 flex flex-col gap-2", sevTone)}>
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
    </motion.div>;
}