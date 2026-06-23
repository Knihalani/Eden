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
  RecentTracesCard,
  type TraceRow,
} from "./_components/recent-traces-card";
import { QuickLinks } from "./_components/quick-links";
import { NoOrgState } from "@/components/ui/no-org-state";

interface DashboardData {
  traces: TraceRow[];
  tracesTotal: number;
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
  /** monthly cost in cents — current period only. `null` until
   *  /orgs/{org}/cost/comparison ships — DO NOT synthesize a
   *  baseline here (June 2026 cleanup — fake deltas destroy trust). */
  costThisMonthCents: number;
  costLastMonthCents: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export default function DashboardPage() {
  const { currentOrg, authError, clearAuthError } = useOrg();
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Use a stable identifier (the org id) for the effect dep so the
  // fetcher doesn't re-fire when Clerk returns a fresh `Organization`
  // object reference on every parent render. Without this guard the
  // dashboard hammered the (occasionally 404ing) optimization /
  // observability / alerts endpoints in a tight loop until 429.
  // June 2026 hardening (companion to the OrgProvider memoization
  // in hooks/use-org.tsx).
  const orgId = currentOrg?.id ?? null;

  useEffect(() => {
    if (!orgId) return;

    let cancelled = false;

    async function load() {
      if (!orgId) return;
      setLoading(true);
      setError(null);
      try {
        // Fetch the four telemetry shards independently so a 404 on
        // one of them doesn't black-hole the others. 404 here means
        // "not found" / "not deployed yet" — NOT a transient error,
        // so we surface a single user-friendly message and DO NOT
        // retry. Re-fetching a 404 is what caused the previous 429
        // lockout.
        const safeJson = async <T,>(p: Promise<T>): Promise<T | null> => {
          try {
            return await p;
          } catch (e) {
            if (!cancelled) {
              const msg = e instanceof Error ? e.message : String(e);
              // 404 / "Not Found" / "Failed to fetch" — leave the
              // field null and keep going. Anything else is real
              // and worth surfacing.
              if (!/404|not\s*found|failed\s*to\s*fetch/i.test(msg)) {
                console.warn("Dashboard shard failed:", msg);
              }
            }
            return null;
          }
        };

        const [tracesRes, optimization, alertsRaw, costComparison] = await Promise.all([
          safeJson(api.listObservabilityTraces(orgId, { limit: 50, days: 7 })),
          safeJson(api.getOptimizationOverview(orgId, 30)),
          safeJson(api.listAlerts(orgId, { limit: 50 })),
          safeJson(api.getCostComparison(orgId).catch(() => null)),
        ]);

        if (cancelled) return;

        // Cat 23 audit (2026-06-21): real last-month baseline now
        // arrives via /orgs/{org}/cost/comparison. We surface it as-is
        // and fall back to `null` (rendered as "—") when Redis has
        // no recorded spend for either month — never a fabricated delta.
        const thisMonth = optimization?.costs?.total_cost_cents ?? 0;
        const lastMonth = costComparison?.previous_month_cents ?? null;

        setData({
          traces: (tracesRes?.traces ?? []) as unknown as TraceRow[],
          tracesTotal: tracesRes?.total ?? tracesRes?.traces?.length ?? 0,
          optimization: optimization ?? null,
          alerts: (alertsRaw?.alerts ?? []) as unknown as DashboardData["alerts"],
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
  }, [orgId]);

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
  // Captured at the top of each render — fine to read the clock here
  // because the result is only used as a filter cutoff (a few-ms
  // drift between renders is irrelevant) and the rule's complaint
  // is about reads that *change control flow* between server and
  // client, which a filter cutoff does not. The eslint-disable
  // documents the intent.
  const { p95, p50 } = useMemo(
    () => {
      // eslint-disable-next-line react-hooks/purity
      const cutoff = Date.now() - 60 * 60 * 1000;
      const recent = (data?.traces ?? []).filter(
        (t) => new Date(t.started_at).getTime() >= cutoff
      );
      return { p95: computeP95(recent), p50: computeP50(recent) };
    },
    [data?.traces]
  );

  const costThisMonth = data?.costThisMonthCents ?? 0;
  const costLastMonth = data?.costLastMonthCents ?? null;
  // No last-month data → no trend arrow. The StatCard subtitle will
  // render "—" rather than a fake dollar comparison.
  const costDeltaPct = costLastMonth !== null && costLastMonth > 0
    ? Math.round(((costThisMonth - costLastMonth) / costLastMonth) * 100)
    : 0;
  const costTrend: "up" | "down" | null =
    costLastMonth === null ? null : costDeltaPct === 0 ? null : costDeltaPct > 0 ? "up" : "down";

  const anomalyCount = data?.alerts?.length ?? 0;

  // Last 24h traces — see comment above on the eslint-disable for
  // the same purity rule (filter cutoff, not control flow).
  const lastDayTraces = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const cutoff = Date.now() - DAY_MS;
    return (data?.traces ?? []).filter((t) => new Date(t.started_at).getTime() >= cutoff);
  }, [data?.traces]);

  // Detect first-run: no traces AND the API call completed — show a
  // "Get started" card with a primary CTA to link a repo. Otherwise
  // the dashboard is a wall of "— / 0 / no data" placeholders, which
  // is hostile. Uses `data` not `data?.traces` so we don't show
  // first-run while the API is still in-flight.
  const isFirstRun = !loading && data !== null && data.tracesTotal === 0;

  // No-org branch: brand-new Clerk signups land here before they've
  // joined or created an org. Without this guard the page sat in
  // its loading skeleton forever because ``useEffect`` short-circuits
  // when ``currentOrg`` is null but ``loading`` stayed true.
  if (!currentOrg && !authError) {
    return (
      <NoOrgState
        feature="The dashboard"
        description="Create or join an organization to start capturing traces, alerts, and cost data for your agents."
      />
    );
  }

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
        {(() => {
          const centsThisMonth = costThisMonth;
          const centsLastMonth = costLastMonth;
          const usd = centsThisMonth / 100;
          const empty = !loading && centsThisMonth === 0;
          const subtitle = empty
            ? "no cost data yet"
            : centsLastMonth === null
            ? "last month: —"
            : `last month: $${(centsLastMonth / 100).toFixed(2)}`;
          return (
            <StatCard
              title="Cost this month"
              value={empty ? "—" : `$${usd.toFixed(2)}`}
              subtitle={subtitle}
              trend={costTrend}
              trendValue={costTrend ? `${Math.abs(costDeltaPct)}%` : "—"}
              trendIsGood="down"
              icon={DollarSign}
              accent="accent"
              loading={loading}
              empty={empty}
              emptyText="No cost data — start routing calls to populate."
              href="/optimization"
            />
          );
        })()}
        {(() => {
          const severityCounts = countBySeverity(data?.alerts ?? []);
          const severityClass = anomalyCount === 0
            ? "bg-[var(--accent-faint)] text-[var(--accent)]"
            : severityCounts.critical
              ? "bg-[var(--error-bg)] text-[var(--error)]"
              : severityCounts.warning
                ? "bg-[var(--warning-bg)] text-[var(--warning-strong)]"
                : "bg-[var(--accent-faint)] text-[var(--accent)]";
          return (
            <StatCard
              title="Anomalies (24h)"
              value={anomalyCount}
              subtitle={
                anomalyCount === 0
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
        })()}
      </div>

      {/* Row 2: recent traces + quick links. (Judge Scores used to
          live as a standalone widget here; demoted to a Quick Link
          in June 2026 cleanup since the eval dashboard is a
          subdomain, not a top-level signal.) */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6">
        <div className="xl:col-span-2">
          <RecentTracesCard loading={loading} traces={lastDayTraces.slice(0, 10)} />
        </div>
        <div className="xl:col-span-1">
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
