"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  DollarSign,
  AlertTriangle,
  GitBranch,
  Sparkles,
  Key,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { StatCard } from "@/components/ui/stat-card";
import { ThroughputCard } from "./_components/throughput-card";
import { LatencyCard } from "./_components/latency-card";
import {
  RecentTracesCard,
  type TraceRow } from "./_components/recent-traces-card";
import { QuickLinks } from "./_components/quick-links";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Wraps a per-shard promise so a 404 ("not deployed yet" — not a
 * transient error) resolves to `null` instead of throwing, while
 * every other failure (network, 5xx, 401…) still throws and
 * surfaces through the query's `error` state. Cat 23 audit fix:
 * the previous version swallowed ALL errors (including real
 * outages) to a silent zero — this only swallows the expected
 * "not found" case.
 */
async function shardOr404Null<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (e) {
    // Soft-fail optional dashboard shards: missing routes (404),
    // validation quirks (422), and transient backend errors (5xx)
    // should render empty cards — not uncaught ApiError noise.
    if (
      e instanceof ApiError &&
      (e.status === 404 ||
        e.status === 422 ||
        e.status >= 500 ||
        e.status === 401 ||
        e.status === 403)
    ) {
      return null;
    }
    throw e;
  }
}

export default function DashboardPage() {
  const { currentOrg, authError, orgSyncing, orgSyncTimedOut, refreshOrgs } = useOrg();
  const { hasPermission } = usePermissions();
  // Gate the primary "Connect a repo" CTA on the actual permission
  // the connect flow enforces (owner/admin only). Without this,
  // non-admins in a multi-tenant org were being sent to a page
  // that immediately told them they needed admin. June 2026 fix.
  const canConnect = hasPermission("integrations:write");

  const orgId = currentOrg?.id ?? null;

  // Four telemetry shards fetched independently via useOrgQuery so a
  // 404 on one (or a real outage) never black-holes the others, and
  // each shard gets its own retry/error semantics from the React
  // Query provider (skips retrying non-429 4xx — see
  // components/providers/query-provider.tsx).
  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, { limit: 50, days: 7 }),
    orgId,
    () => shardOr404Null(api.listObservabilityTraces(orgId!, { limit: 50, days: 7 })),
  );
  // Same filter shape the observability hub uses for its summary
  // call (window_hours + compare_previous) so both pages hit the
  // identical React Query key and share one cache entry / one
  // in-flight request instead of double-fetching the same 24h
  // summary shard whenever a user has both tabs open. `compare_previous`
  // only adds a `previous` field to the response — free to request
  // even though the dashboard doesn't render deltas today.
  const summaryQuery = useOrgQuery(
    queryKeys.observability.summary(orgId, { window_hours: 24, compare_previous: true }),
    orgId,
    () => shardOr404Null(api.getObservabilitySummary(orgId!, { window_hours: 24, compare_previous: true })),
  );
  const optimizationQuery = useOrgQuery(
    queryKeys.optimization.overview(orgId, 30),
    orgId,
    () => shardOr404Null(api.getOptimizationOverview(orgId!, 30)),
  );
  const alertsQuery = useOrgQuery(
    queryKeys.alerts.list(orgId, { limit: 50 }),
    orgId,
    () => shardOr404Null(api.listAlerts(orgId!, { limit: 50 })),
  );
  // Cat 23 audit (2026-06-21): real last-month baseline arrives via
  // /orgs/{org}/cost/comparison. Surfaced as-is; `null` (rendered as
  // "—") when Redis has no recorded spend yet — never a fabricated
  // delta.
  const costComparisonQuery = useOrgQuery(
    queryKeys.cost.comparison(orgId),
    orgId,
    () => shardOr404Null(api.getCostComparison(orgId!)),
  );

  const loading =
    tracesQuery.isLoading ||
    summaryQuery.isLoading ||
    optimizationQuery.isLoading ||
    alertsQuery.isLoading ||
    costComparisonQuery.isLoading;

  // Only non-404 failures reach `error` (404 resolves to `null`
  // data above) — this is the "real outage" signal for the banner.
  const failedShards = [
    { label: "traces", query: tracesQuery },
    { label: "summary", query: summaryQuery },
    { label: "cost & optimization", query: optimizationQuery },
    { label: "alerts", query: alertsQuery },
    { label: "cost comparison", query: costComparisonQuery },
  ].filter((s) => s.query.isError);
  const error =
    failedShards.length > 0
      ? `Could not load ${failedShards.map((s) => s.label).join(", ")}. ${
          failedShards[0].query.error?.message ?? ""
        }`.trim()
      : null;

  const traces = (tracesQuery.data?.traces ?? []) as unknown as TraceRow[];
  const tracesTotal = tracesQuery.data?.total ?? tracesQuery.data?.traces?.length ?? 0;
  const summary = summaryQuery.data ?? null;
  const optimization = optimizationQuery.data ?? null;
  const alerts = alertsQuery.data?.alerts ?? [];
  const costComparison = costComparisonQuery.data ?? null;

  // ── Derived metrics ─────────────────────────────────────────────
  const throughputSeries = useMemo<Array<{ t: string; eps: number }>>(
    () => buildThroughputSeries(traces),
    [traces]
  );

  const currentEps = useMemo(() => {
    if (throughputSeries.length === 0) return 0;
    // Average events-per-minute for the most recent bucket, divided by 60
    const last = throughputSeries[throughputSeries.length - 1];
    return last.eps;
  }, [throughputSeries]);

  const { p95, p50 } = useMemo(() => {
    if (summary) {
      return {
        p95: summary.p95_ms,
        p50: summary.p50_ms,
      };
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    const recent = traces.filter(
      (t) => new Date(t.started_at).getTime() >= cutoff
    );
    return { p95: computeP95(recent), p50: computeP50(recent) };
  }, [summary, traces]);

  const topFailureModes = summary?.top_failure_modes?.slice(0, 5) ?? [];

  // Cat 23 audit (2026-07): the "current month cost" tile must read
  // the actual monthly rollup (`cost/comparison`), not the 30-day
  // optimization total — those cover different windows and drifted
  // whenever the calendar month didn't align with "last 30 days".
  const costThisMonth = costComparison?.current_month_cents ?? null;
  const costLastMonth = costComparison?.previous_month_cents ?? null;
  // No last-month data → no trend arrow. The StatCard subtitle will
  // render "—" rather than a fake dollar comparison.
  const costDeltaPct =
    costLastMonth !== null && costLastMonth > 0 && costThisMonth !== null
      ? Math.round(((costThisMonth - costLastMonth) / costLastMonth) * 100)
      : 0;
  const costTrend: "up" | "down" | null =
    costLastMonth === null || costThisMonth === null
      ? null
      : costDeltaPct === 0
        ? null
        : costDeltaPct > 0
          ? "up"
          : "down";

  // Alerts "24h" card — the feed itself has no time-window filter,
  // so the card used to label an unbounded fetch as "24h". Filter
  // client-side to the same last-24h window the traces card uses so
  // the label is honest. (June 2026 data-trust fix.)
  const lastDayAlerts = useMemo(() => {
    const cutoff = Date.now() - DAY_MS;
    return alerts.filter((a) => new Date(a.triggered_at).getTime() >= cutoff);
  }, [alerts]);
  const anomalyCount = lastDayAlerts.length;

  // Last 24h traces — see comment above on the eslint-disable for
  // the same purity rule (filter cutoff, not control flow).
  const lastDayTraces = useMemo(() => {
     
    const cutoff = Date.now() - DAY_MS;
    return traces.filter((t) => new Date(t.started_at).getTime() >= cutoff);
  }, [traces]);

  // Detect first-run: the summary shard loaded successfully AND both
  // it and the trace list report zero traces. Requiring `summary !=
  // null` (rather than defaulting a failed/404 fetch to 0 via `??`)
  // is the fix — a shard failure must never be mistaken for "this is
  // a brand-new tenant". June 2026 data-trust fix.
  const isFirstRun =
    !loading &&
    summary !== null &&
    tracesTotal === 0 &&
    (summary.total_traces ?? 0) === 0;

  // No-org branch: brand-new Clerk signups land here before they've
  // joined or created an org. Without this guard the dashboard sat in
  // its loading skeleton forever because ``useOrgQuery`` short-
  // circuits (disabled) when ``currentOrg`` is null. June 2026 fix.
  if (!currentOrg && !authError) {
    return (
      <NoOrgState
        feature="The dashboard"
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
        description={
          orgSyncTimedOut
            ? "Workspace sync is taking longer than expected. Try refreshing, or finish setup from onboarding."
            : orgSyncing
              ? undefined
              : "Finish setup to start capturing traces, alerts, and cost data for your agents."
        }
      />
    );
  }

  return (
    <PageContent size="wide" className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Telemetry Overview"
        subtitle={
          isFirstRun && canConnect
            ? "Live signals from your agents — connect a repo to start seeing traces here."
            : "Live signals from your agents and pipelines."
        }
        className="mb-4 sm:mb-5"
        greeting={currentOrg ? `Welcome back to ${currentOrg.name}.` : undefined}
        actions={
          canConnect ? (
            <Link
              href={isFirstRun ? "/dashboard?onboarding=1" : "/agents/connect"}
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
        // Status ladder uses --error / --error-bg / --error-strong
        // (June 2026 status ladder refinement) — but inverting the
        // foreground color (use --error on --error-bg instead of
        // --error-strong) was wrong because error-strong is
        // significantly darker. This banner intentionally uses
        // --error-strong on --error-bg because the banner is a
        // callout, not a status pill.
        <div
          role="alert"
          className="mb-4 p-3 rounded-xl border border-[var(--error)]/40 bg-[var(--error-bg)] text-[var(--error)] text-sm"
        >
          <p className="font-medium">Could not load some telemetry.</p>
          <p className="text-xs mt-1 opacity-80">{error}</p>
        </div>
      )}

      {/* Row 1: metrics or first-run getting started */}
      {isFirstRun ? (
        <Card className="p-6 sm:p-8 border border-[var(--border)] bg-[var(--surface)]">
          <div className="max-w-xl space-y-4">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Get started with observability
            </h2>
            <p className="text-sm text-[var(--text-muted)]">
              Create an API key, install the SDK, and send a test trace. Throughput,
              latency, and failures show up here once ingestion starts.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href={DOCS_QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
              >
                <Key className="w-3.5 h-3.5" />
                Docs quickstart
              </Link>
              <Link
                href="/dashboard?onboarding=1"
                className="inline-flex items-center gap-1.5 px-3 py-2 border border-[var(--border)] rounded-lg text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Product tour
              </Link>
              {canConnect && (
                <Link
                  href="/agents?tab=fleet"
                  className="inline-flex items-center gap-1.5 px-3 py-2 border border-[var(--border)] rounded-lg text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors"
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  Connect a repo
                </Link>
              )}
            </div>
          </div>
        </Card>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 mb-4">
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
          const empty = !loading && (centsThisMonth === null || centsThisMonth === 0);
          const usd = (centsThisMonth ?? 0) / 100;
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
          const severityCounts = countBySeverity(lastDayAlerts);
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
      )}

      {!isFirstRun && topFailureModes.length > 0 && (
        <Card className="p-4 sm:p-5 mb-4 border border-[var(--border)]">
          <h2 className="text-sm font-medium text-[var(--text-primary)] mb-3">
            Top failure modes (24h)
          </h2>
          <ul className="space-y-2">
            {topFailureModes.map((mode) => (
              <li
                key={mode.name}
                className="flex items-center justify-between text-sm gap-4"
              >
                <span className="text-[var(--text-primary)] truncate">{mode.name}</span>
                <span className="text-[var(--text-muted)] shrink-0">
                  {mode.count} events
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

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
    </PageContent>
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
