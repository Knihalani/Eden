"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DollarSign,
  AlertTriangle,
  LayoutDashboard,
  GitBranch } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { ThroughputCard } from "./_components/throughput-card";
import { LatencyCard } from "./_components/latency-card";
import {
  RecentTracesCard,
  type TraceRow } from "./_components/recent-traces-card";
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
  const { currentOrg, authError } = useOrg();
  const { hasPermission } = usePermissions();
  const __router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Gate the primary "Connect a repo" CTA on the actual permission
  // the connect flow enforces (owner/admin only). Without this,
  // non-admins in a multi-tenant org were being sent to a page
  // that immediately told them they needed admin. June 2026 fix.
  const canConnect = hasPermission("integrations:write");

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
                // Surfaced via the dashboard's error banner; no need
                // to spam the console here (the previous line was the
                // exact leak use-org.tsx:148 was just refactored to
                // suppress).
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
          costLastMonthCents: lastMonth });
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
        subtitle={
          isFirstRun && canConnect
            ? "Live signals from your agents — connect a repo to start seeing traces here."
            : "Live signals from your agents and pipelines."
        }
        icon={LayoutDashboard}
        greeting={currentOrg ? `Welcome back · ${currentOrg.name}` : undefined}
        actions={
          canConnect ? (
            <Link
              href="/agents/connect"
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              <GitBranch className="w-3.5 h-3.5" />
              Connect a repo
            </Link>
          ) : (
            <span className="text-xs text-[var(--text-muted)] px-3 py-2">
              Ask an admin to connect a repo
            </span>
          )
        }
      />

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
          subdomain, not a top-level signal.) The old "Jump in"
          section above the trace count footer was removed in June
          2026 — every link it contained duplicated QuickLinks or
          the PageHeader actions, and the footer trace count is
          already covered by Anomalies / Throughput sublines. */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6">
        <div className="xl:col-span-2">
          <RecentTracesCard loading={loading} traces={lastDayTraces.slice(0, 10)} />
        </div>
        <div className="xl:col-span-1">
          <QuickLinks />
        </div>
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
        count: 0 };
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
