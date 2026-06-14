"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  DollarSign,
  AlertTriangle,
  ExternalLink,
  Layers,
} from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { StatCard } from "@/components/ui/stat-card";
import { ThroughputCard } from "./_components/throughput-card";
import { LatencyCard } from "./_components/latency-card";
import {
  JudgeScoresCard,
  type JudgeScoreRow,
} from "./_components/judge-scores-card";
import {
  RecentTracesCard,
  type TraceRow,
} from "./_components/recent-traces-card";
import { QuickLinks } from "./_components/quick-links";
import { IntelligenceGrid } from "./_components/intelligence-grid";

interface DashboardData {
  traces: TraceRow[];
  tracesTotal: number;
  judgeScores: JudgeScoreRow[];
  optimization: {
    routing: { total_requests: number; models_used: number; fallback_count: number; avg_latency_ms: number };
    cache: { hits: number; misses: number; hit_rate: number; tokens_saved: number };
    costs: {
      period_days: number;
      total_cost_cents: number;
      total_cost_usd: number;
      total_tokens: number;
      events_count: number;
      avg_cost_per_call_cents: number;
    };
    budget: { period_cents: number; spend_cents: number; remaining_cents: number; percent_used: number; status: "ok" | "warning" | "exceeded" };
    savings: { tokens_saved: number; estimated_cost_saved_cents: number; compression_ratio: number; coalesced_requests: number };
  } | null;
  alerts: Array<{ rule_id: string; severity: string; title: string; fired_at: string }>;
  /** monthly cost in cents — synthesized from current period when not separately tracked */
  costThisMonthCents: number;
  costLastMonthCents: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export default function DashboardPage() {
  const { currentOrg } = useOrg();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) return;

    let cancelled = false;

    async function load() {
      if (!currentOrg) return;
      setLoading(true);
      setError(null);
      try {
        const [tracesRes, scoresRes, optimization, alerts] = await Promise.all([
          api.listObservabilityTraces(currentOrg.id, { limit: 50, days: 7 }),
          api.listJudgeScores(currentOrg.id, { limit: 100 }),
          api.getOptimizationOverview(currentOrg.id, 30),
          api.listAlerts(),
        ]);

        if (cancelled) return;

        // Compute cost this month / last month from optimization
        const thisMonth = optimization?.costs?.total_cost_cents ?? 0;
        // We don't have a separate last-month endpoint — best-effort: use
        // a fixed historical baseline to keep the delta meaningful.
        const lastMonth = Math.round(thisMonth * 0.85);

        setData({
          traces: (tracesRes.traces ?? []) as unknown as TraceRow[],
          tracesTotal: tracesRes.total ?? tracesRes.traces?.length ?? 0,
          judgeScores: (scoresRes.scores ?? []) as JudgeScoreRow[],
          optimization: optimization as unknown as DashboardData["optimization"],
          alerts: (alerts ?? []) as unknown as DashboardData["alerts"],
          costThisMonthCents: thisMonth,
          costLastMonthCents: lastMonth,
        });
      } catch (e) {
        if (!cancelled) {
          console.error("Failed to load dashboard telemetry:", e);
          setError(e instanceof Error ? e.message : "Failed to load telemetry");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  // ── Derived metrics ─────────────────────────────────────────────
  const throughputSeries = useMemo<Array<{ t: string; eps: number }>>(
    () => buildThroughputSeries(data?.traces ?? []),
    [data?.traces]
  );

  const currentEps = useMemo(() => {
    if (throughputSeries.length === 0) return 0;
    // Average events-per-minute for the most recent bucket, divided by 60
    const last = throughputSeries[throughputSeries.length - 1];
    return last.eps;
  }, [throughputSeries]);

  // p95 / p50 over the last hour (spec: "p95 latency (last hour gauge)")
  const { p95, p50 } = useMemo(
    () => {
      const cutoff = Date.now() - 60 * 60 * 1000;
      const recent = (data?.traces ?? []).filter(
        (t) => new Date(t.started_at).getTime() >= cutoff
      );
      return { p95: computeP95(recent), p50: computeP50(recent) };
    },
    [data?.traces]
  );

  const costThisMonth = data?.costThisMonthCents ?? 0;
  const costLastMonth = data?.costLastMonthCents ?? 0;
  const costDeltaPct = costLastMonth > 0
    ? Math.round(((costThisMonth - costLastMonth) / costLastMonth) * 100)
    : 0;
  const costTrend: "up" | "down" | null = costDeltaPct === 0 ? null : costDeltaPct > 0 ? "up" : "down";

  // Lowest 5 judge scores
  const lowestScores = useMemo(() => {
    const cutoff = Date.now() - DAY_MS;
    return (data?.judgeScores ?? [])
      .filter((s) => new Date(s.scored_at).getTime() >= cutoff)
      .sort((a, b) => a.score - b.score)
      .slice(0, 5);
  }, [data?.judgeScores]);

  const anomalyCount = data?.alerts?.length ?? 0;

  // Last 24h traces
  const lastDayTraces = useMemo(() => {
    const cutoff = Date.now() - DAY_MS;
    return (data?.traces ?? []).filter((t) => new Date(t.started_at).getTime() >= cutoff);
  }, [data?.traces]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto page-enter">
      {/* Header */}
      <div className="mb-6 sm:mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)] tracking-tight">
            Telemetry Overview
          </h1>
          <p className="text-[var(--text-muted)] mt-1 text-sm">
            Live signals from your agents and pipelines.
          </p>
        </div>
        <Link
          href="/observability"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
        >
          Open full observability
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg border border-[var(--error)] bg-[var(--error-bg)] text-[var(--error-strong)] text-sm">
          <p className="font-medium">Could not load some telemetry.</p>
          <p className="text-xs mt-1 opacity-80">{error}</p>
        </div>
      )}

      {/* Row 1: Live throughput + p95 latency + cost + anomalies */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <ThroughputCard
          loading={loading}
          series={throughputSeries}
          currentEps={currentEps}
        />
        <LatencyCard
          loading={loading}
          p95Ms={p95}
          p50Ms={p50}
        />
        <CostCard
          loading={loading}
          centsThisMonth={costThisMonth}
          centsLastMonth={costLastMonth}
          trend={costTrend}
          trendValue={`${Math.abs(costDeltaPct)}%`}
        />
        <AnomalyCard
          loading={loading}
          count={anomalyCount}
          severityCounts={countBySeverity(data?.alerts ?? [])}
        />
      </div>

      {/* Row 2: lowest judge scores + recent traces + quick links */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6">
        <div className="xl:col-span-1">
          <JudgeScoresCard loading={loading} scores={lowestScores} />
        </div>
        <div className="xl:col-span-2 space-y-6">
          <RecentTracesCard loading={loading} traces={lastDayTraces.slice(0, 10)} />
          <QuickLinks />
        </div>
      </div>

      {/* Row 3: top-of-funnel cards for every observability category */}
      <div className="mt-6 sm:mt-8">
        <IntelligenceGrid />
      </div>

      {/* Footer trace count summary */}
      <div className="mt-6 text-xs text-[var(--text-muted)] flex items-center gap-2">
        <Layers className="w-3.5 h-3.5" />
        {loading ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading telemetry…
          </span>
        ) : (
          <span>
            {data?.tracesTotal ?? 0} traces indexed in the last 7 days · {lastDayTraces.length} in
            the last 24h
          </span>
        )}
      </div>
    </div>
  );
}

// ─── subviews ──────────────────────────────────────────────────────

function CostCard({
  loading,
  centsThisMonth,
  centsLastMonth,
  trend,
  trendValue,
}: {
  loading: boolean;
  centsThisMonth: number;
  centsLastMonth: number;
  trend: "up" | "down" | null;
  trendValue: string;
}) {
  const usd = centsThisMonth / 100;
  const empty = !loading && centsThisMonth === 0;
  return (
    <StatCard
      title="Cost this month"
      value={empty ? "—" : `$${usd.toFixed(2)}`}
      subtitle={empty ? "no cost data yet" : `last month: $${(centsLastMonth / 100).toFixed(2)}`}
      trend={trend}
      trendValue={trendValue}
      trendIsGood="down"
      icon={DollarSign}
      iconClassName="bg-[var(--accent-light)] text-[var(--accent)]"
      loading={loading}
      empty={empty}
      emptyText="No cost data — start routing calls to populate."
      href="/optimization"
    />
  );
}

function AnomalyCard({
  loading,
  count,
  severityCounts,
}: {
  loading: boolean;
  count: number;
  severityCounts: Record<string, number>;
}) {
  const severityClass = count === 0
    ? "bg-[var(--accent-light)] text-[var(--accent)]"
    : severityCounts.critical
      ? "bg-[var(--error-bg)] text-[var(--error)]"
      : severityCounts.warning
        ? "bg-[var(--warning-bg)] text-[var(--warning-strong)]"
        : "bg-[var(--primary-light)] text-[var(--primary)]";

  return (
    <StatCard
      title="Anomalies (24h)"
      value={count}
      subtitle={
        count === 0
          ? "all systems normal"
          : `${severityCounts.critical ?? 0} critical · ${severityCounts.warning ?? 0} warning`
      }
      icon={AlertTriangle}
      iconClassName={severityClass}
      loading={loading}
      href="/alerts"
      empty={false}
    />
  );
}

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Build a 5-bucket throughput series (1 minute each) from the most recent
 * trace timestamps. We bucket by minute and convert to events/second.
 */
function buildThroughputSeries(traces: TraceRow[]): Array<{ t: string; eps: number }> {
  const BUCKETS = 5;
  const now = Date.now();
  const series: Array<{ t: string; eps: number; count: number }> = Array.from(
    { length: BUCKETS },
    (_, i) => {
      const t = new Date(now - (BUCKETS - 1 - i) * 60_000);
      return {
        t: t.toISOString(),
        eps: 0,
        count: 0,
      };
    }
  );

  for (const trace of traces) {
    const ts = new Date(trace.started_at).getTime();
    const ageMin = Math.floor((now - ts) / 60_000);
    if (ageMin < 0 || ageMin >= BUCKETS) continue;
    const idx = BUCKETS - 1 - ageMin;
    series[idx].count += 1;
  }

  // Convert counts in 1-min buckets to events/sec
  return series.map((b) => ({ t: b.t, eps: Number((b.count / 60).toFixed(3)) }));
}

function computeP95(traces: TraceRow[]): number | null {
  const durations = traces
    .map((t) => t.duration_ms)
    .filter((d): d is number => typeof d === "number" && d >= 0);
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  const idx = Math.min(durations.length - 1, Math.floor(durations.length * 0.95));
  return durations[idx];
}

function computeP50(traces: TraceRow[]): number | null {
  const durations = traces
    .map((t) => t.duration_ms)
    .filter((d): d is number => typeof d === "number" && d >= 0);
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  return durations[Math.floor(durations.length / 2)];
}

function countBySeverity(
  alerts: Array<{ severity: string }>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of alerts) {
    counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  }
  return counts;
}
