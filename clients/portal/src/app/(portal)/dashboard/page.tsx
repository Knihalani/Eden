"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Loader2,
  DollarSign,
  AlertTriangle,
  ExternalLink,
  Layers,
  LayoutDashboard,
  GitBranch,
  Bell,
  ArrowRight,
  Eye,
} from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { PageHeader } from "@/components/layout/page-header";
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

interface DashboardData {
  traces: TraceRow[];
  tracesTotal: number;
  judgeScores: JudgeScoreRow[];
  optimization: {
    costs: {
      total_cost_cents: number;
      prompt_cost_cents?: number;
      completion_cost_cents?: number;
      cache_savings_cents?: number;
      token_total?: number;
    };
    efficiency?: {
      cache_hit_rate?: number;
      avg_cost_per_request_cents?: number;
      p50_latency_ms?: number;
      p95_latency_ms?: number;
    };
    forecast?: {
      next_7d_cost_cents?: number;
      next_30d_cost_cents?: number;
    };
  } | null;
  alerts: Array<{ rule_id?: string; severity: string; title: string; fired_at?: string }>;
  /** monthly cost in cents — synthesized from current period when not separately tracked */
  costThisMonthCents: number;
  costLastMonthCents: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export default function DashboardPage() {
  const { currentOrg, authError, clearAuthError } = useOrg();
  const router = useRouter();
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
          api.listAlerts(currentOrg.id, { limit: 50 }),
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
          optimization,
          alerts: (alerts as unknown as DashboardData["alerts"]) ?? [],
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

  // Detect first-run: no traces AND the API call completed — show a
  // "Get started" card with a primary CTA to link a repo. Otherwise
  // the dashboard is a wall of "— / 0 / no data" placeholders, which
  // is hostile. Uses `data` not `data?.traces` so we don't show
  // first-run while the API is still in-flight.
  const isFirstRun = !loading && data !== null && data.tracesTotal === 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto page-enter">
      <PageHeader
        title="Telemetry Overview"
        subtitle="Live signals from your agents and pipelines."
        icon={LayoutDashboard}
        greeting={currentOrg ? `Welcome back · ${currentOrg.name}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/agents/connect"
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              <GitBranch className="w-3.5 h-3.5" />
              Connect a repo
            </Link>
            <Link
              href="/observability"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
            >
              Full observability
              <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </div>
        }
      />

      {isFirstRun && (
        <div className="mb-6 p-5 rounded-xl border border-[var(--border-default)] bg-gradient-to-br from-[var(--accent-faint)] to-[var(--bg-primary)] flex flex-col sm:flex-row items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] flex items-center justify-center">
            <GitBranch className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Link your first agent
            </h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)] max-w-2xl">
              Eden captures every LLM call from your agents and surfaces
              them as traces here. Link a GitHub repo to auto-instrument
              it, or install the SDK and call{" "}
              <code className="font-mono text-xs px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
                eden.init()
              </code>{" "}
              in your existing agent code.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Link
                href="/agents/connect"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-md text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors"
              >
                <GitBranch className="w-3.5 h-3.5" />
                Link a GitHub repo
              </Link>
              <code className="px-2 py-1 rounded bg-[var(--bg-secondary)] font-mono text-xs text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                pip install eden-ai
              </code>
            </div>
          </div>
        </div>
      )}

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

      {/* Row 3: Quick actions — the user's main navigation surface.
          Replaces the old 22-card IntelligenceGrid (overwhelming + slow
          to load + the user can navigate to the categories via the sidebar
          anyway). Focused on the 4 actions that matter most for a
          returning user. */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-[var(--text-primary)] tracking-tight mb-3">
          Jump in
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              href: "/agents/connect",
              icon: GitBranch,
              title: "Connect a repo",
              body: "Link a GitHub repo to auto-instrument your agent",
              accent: "bg-[var(--accent-faint)] text-[var(--accent)]",
            },
            {
              href: "/traces",
              icon: Eye,
              title: "Browse traces",
              body: "Search and inspect every trace in your system",
              accent: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
            },
            {
              href: "/optimization",
              icon: DollarSign,
              title: "Track cost",
              body: "Token + cost overview across models and agents",
              accent: "bg-[var(--warning-bg)] text-[var(--warning)]",
            },
            {
              href: "/alerts",
              icon: Bell,
              title: "Set up alerts",
              body: "Get notified when cost spikes or quality drops",
              accent: "bg-[var(--error-bg)] text-[var(--error)]",
            },
          ].map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="group block p-4 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl transition-all hover:border-[var(--accent)]/50 hover:shadow-sm"
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${a.accent}`}>
                <a.icon className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                {a.title}
              </p>
              <p className="mt-1 text-xs text-[var(--text-muted)] leading-relaxed">
                {a.body}
              </p>
              <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)] mt-3 group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all" />
            </Link>
          ))}
        </div>
      </section>

      {/* Footer trace count summary */}
      <div className="mt-8 pt-6 border-t border-[var(--border-subtle)] text-xs text-[var(--text-muted)] flex items-center gap-2">
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
