"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  DollarSign,
  AlertTriangle,
  Activity,
  BookOpen,
  GitBranch,
  Sparkles,
  Key,
  LayoutGrid,
  Radio,
} from "lucide-react";
import { api, ApiError, wave6Api, onboardingV2Api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { StatCard } from "@/components/ui/stat-card";
import { Button } from "@/components/ui/button";
import { DoctorCommandChip } from "@/components/onboarding/WaitingForFirstEvent";
import { ThroughputCard } from "./_components/throughput-card";
import { LatencyCard } from "./_components/latency-card";
import {
  RecentTracesCard,
  type TraceRow } from "./_components/recent-traces-card";
import { QuickLinks } from "./_components/quick-links";
import { Panel } from "@/components/ui/panel";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import { usePagePerf } from "@/lib/perf";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_WIDGETS = [
  "throughput",
  "latency",
  "cost",
  "anomalies",
  "failures",
  "agentic",
  "traces",
  "links",
] as const;
type WidgetId = (typeof DEFAULT_WIDGETS)[number];

function layoutStorageKey(orgId: string) {
  return `eden.home.layout.${orgId}`;
}

function loadLayout(orgId: string): WidgetId[] {
  try {
    const raw = localStorage.getItem(layoutStorageKey(orgId));
    if (!raw) return [...DEFAULT_WIDGETS];
    const parsed = JSON.parse(raw) as string[];
    const valid = parsed.filter((id): id is WidgetId =>
      (DEFAULT_WIDGETS as readonly string[]).includes(id),
    );
    return valid.length > 0 ? valid : [...DEFAULT_WIDGETS];
  } catch {
    return [...DEFAULT_WIDGETS];
  }
}

/**
 * Soft-fail ONLY undeployed / not-found shards (404) and intentional
 * validation quirks (422). Real outages (5xx) and auth failures
 * (401/403) must throw so `isError` fires and the banner shows —
 * never silent-null "all systems normal" / KPI theatre.
 */
async function shardOr404Null<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 422)) {
      return null;
    }
    throw e;
  }
}

export default function DashboardPage() {
  usePagePerf("/dashboard");
  const {
    currentOrg,
    authError,
    orgSyncing,
    orgSyncTimedOut,
    refreshOrgs,
    loading: orgLoading,
  } = useOrg();
  const { hasPermission } = usePermissions();
  // Gate the primary "Connect a repo" CTA on the actual permission
  // the connect flow enforces (owner/admin only). Without this,
  // non-admins in a multi-tenant org were being sent to a page
  // that immediately told them they needed admin. June 2026 fix.
  const canConnect = hasPermission("integrations:write");
  // API key create/revoke is owner/admin only (settings:edit). Members
  // and viewers must not get a primary "API keys" first-run CTA.
  const canManageKeys = hasPermission("settings:edit");

  const orgId = currentOrg?.id ?? null;
  const [editing, setEditing] = useState(false);
  // null until localStorage layout loads — avoids firing every shard
  // on the first paint when the user hid widgets in a prior session.
  const [visibleWidgets, setVisibleWidgets] = useState<WidgetId[] | null>(null);

  useEffect(() => {
    if (!orgId) {
      setVisibleWidgets(null);
      return;
    }
    setVisibleWidgets(loadLayout(orgId));
  }, [orgId]);

  const widgets = visibleWidgets ?? [...DEFAULT_WIDGETS];
  const layoutReady = visibleWidgets !== null;

  const saveLayout = (next: WidgetId[]) => {
    setVisibleWidgets(next);
    if (orgId) {
      try {
        localStorage.setItem(layoutStorageKey(orgId), JSON.stringify(next));
      } catch {
        /* ignore quota */
      }
    }
  };

  const toggleWidget = (id: WidgetId) => {
    if (widgets.includes(id)) {
      if (widgets.length <= 1) return;
      saveLayout(widgets.filter((w) => w !== id));
    } else {
      saveLayout([...widgets, id]);
    }
  };

  const show = (id: WidgetId) => widgets.includes(id);

  // Telemetry shards gated by visible widgets. Traces stay always-on
  // (drives first-run detection). Layout must be ready so a customized
  // home does not pay for hidden cost/alerts/agentic on every visit.
  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, { limit: 50, days: 7 }),
    orgId,
    () => shardOr404Null(api.listObservabilityTraces(orgId!, { limit: 50, days: 7 })),
    {
      enabled: layoutReady,
      refetchInterval: (q) => {
        if (q.state.error) return false;
        const data = q.state.data;
        if (!data) return false;
        const total = data.total ?? data.traces?.length ?? 0;
        return total === 0 ? FIRST_EVENT_WAIT.pollMs : false;
      },
    },
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
    {
      enabled:
        layoutReady &&
        (show("throughput") || show("latency") || show("failures")),
    },
  );
  const alertsQuery = useOrgQuery(
    queryKeys.alerts.list(orgId, { limit: 50 }),
    orgId,
    () => shardOr404Null(api.listAlerts(orgId!, { limit: 50 })),
    { enabled: layoutReady && !orgSyncing && show("anomalies") },
  );
  // Cat 23 audit (2026-06-21): real last-month baseline arrives via
  // /orgs/{org}/cost/comparison. Surfaced as-is; `null` (rendered as
  // "—") when Redis has no recorded spend yet — never a fabricated
  // delta.
  const costComparisonQuery = useOrgQuery(
    queryKeys.cost.comparison(orgId),
    orgId,
    () => shardOr404Null(api.getCostComparison(orgId!)),
    { enabled: layoutReady && show("cost") },
  );
  const costKpiQuery = useOrgQuery(
    queryKeys.cost.kpi(orgId, 24),
    orgId,
    () => shardOr404Null(wave6Api.costKpi(orgId!, { window_hours: 24 })),
    { enabled: layoutReady && show("cost") },
  );
  const agenticQuery = useOrgQuery(
    queryKeys.dashboard.agentic(orgId),
    orgId,
    () => shardOr404Null(api.agenticMetricsSummary(orgId!, 24)),
    { enabled: layoutReady && show("agentic") },
  );

  // Per-shard loading: Throughput/Latency render as soon as summary
  // settles — never blocked behind alerts / cost / agentic.
  const summaryLoading = summaryQuery.isLoading;
  const latencyLoading =
    summaryQuery.isLoading ||
    (summaryQuery.data == null &&
      !summaryQuery.isError &&
      tracesQuery.isLoading);
  const costLoading =
    costComparisonQuery.isLoading || costKpiQuery.isLoading;
  const alertsLoading = alertsQuery.isLoading;

  // Only non-404/422 failures reach `error` (those soft-resolve to
  // `null` above) — this is the "real outage" signal for the banner.
  const failedShards = [
    { label: "traces", query: tracesQuery },
    { label: "summary", query: summaryQuery },
    { label: "alerts", query: alertsQuery },
    { label: "cost comparison", query: costComparisonQuery },
    { label: "cost KPI", query: costKpiQuery },
    { label: "agentic", query: agenticQuery },
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
  const alerts = alertsQuery.data?.alerts ?? [];
  const alertsSettled =
    alertsQuery.isFetched || alertsQuery.isError || alertsQuery.isSuccess;
  const alertsUnavailable =
    alertsQuery.isError || (alertsSettled && alertsQuery.data == null);
  const costComparison = costComparisonQuery.data ?? null;
  const agentic = agenticQuery.data?.data ?? null;
  const actionCompletion =
    agentic?.metrics?.action_completion?.score ?? null;

  // ── Derived metrics ─────────────────────────────────────────────
  // Throughput from the 24h summary shard — never the 50-trace sample
  // bucketing that used to invent a "Live" 5-minute eps series.
  const summaryWindowHours = summary?.window_hours ?? 24;
  const throughputTotal = summary?.total_traces ?? null;
  const avgEps =
    summary != null && summaryWindowHours > 0
      ? summary.total_traces / (summaryWindowHours * 3600)
      : null;
  const throughputTrend = useMemo((): {
    trend: "up" | "down" | null;
    trendValue: string | undefined;
  } => {
    const prev = summary?.previous?.total_traces;
    if (
      summary == null ||
      prev == null ||
      prev <= 0 ||
      throughputTotal == null
    ) {
      return { trend: null, trendValue: undefined };
    }
    const deltaPct = Math.round(((throughputTotal - prev) / prev) * 100);
    if (deltaPct === 0) return { trend: null, trendValue: undefined };
    return {
      trend: deltaPct > 0 ? "up" : "down",
      trendValue: `${Math.abs(deltaPct)}%`,
    };
  }, [summary, throughputTotal]);

  // Summary shard is window_hours: 24 — fallback trace percentiles
  // use the same 24h window so the latency card label stays honest.
  const { p95, p50 } = useMemo(() => {
    if (summary) {
      return {
        p95: summary.p95_ms,
        p50: summary.p50_ms,
      };
    }
    const cutoff = Date.now() - DAY_MS;
    const recent = traces.filter(
      (t) => new Date(t.started_at).getTime() >= cutoff
    );
    return { p95: computeP95(recent), p50: computeP50(recent) };
  }, [summary, traces]);

  const latencyTrend = useMemo((): {
    trend: "up" | "down" | null;
    trendValue: string | undefined;
  } => {
    const prev = summary?.previous?.p95_ms;
    if (p95 == null || prev == null || prev <= 0) {
      return { trend: null, trendValue: undefined };
    }
    const deltaPct = Math.round(((p95 - prev) / prev) * 100);
    if (deltaPct === 0) return { trend: null, trendValue: undefined };
    return {
      trend: deltaPct > 0 ? "up" : "down",
      trendValue: `${Math.abs(deltaPct)}%`,
    };
  }, [summary, p95]);

  const topFailureModes = summary?.top_failure_modes?.slice(0, 5) ?? [];

  // Cat 23 audit (2026-07): the "current month cost" tile must read
  // the actual monthly rollup (`cost/comparison`), not the 30-day
  // optimization total — those cover different windows and drifted
  // whenever the calendar month didn't align with "last 30 days".
  const costThisMonth = costComparison?.current_month_cents ?? null;
  const costLastMonth = costComparison?.previous_month_cents ?? null;
  const kpiTiles =
    (costKpiQuery.data as { data?: { tiles?: Array<Record<string, unknown>> } } | null)?.data
      ?.tiles ??
    (costKpiQuery.data as { tiles?: Array<Record<string, unknown>> } | null)?.tiles ??
    [];
  const kpiCostTile = kpiTiles.find((t) =>
    String(t.id ?? t.key ?? t.title ?? "").toLowerCase().includes("cost"),
  );
  const kpiDeltaPct =
    typeof kpiCostTile?.delta_pct === "number"
      ? Math.round(kpiCostTile.delta_pct as number)
      : null;
  // Prefer F60 KPI Δ; else month-over-month. Never fabricate a trend.
  const costDeltaPct =
    kpiDeltaPct !== null
      ? kpiDeltaPct
      : costLastMonth !== null && costLastMonth > 0 && costThisMonth !== null
        ? Math.round(((costThisMonth - costLastMonth) / costLastMonth) * 100)
        : 0;
  const costTrend: "up" | "down" | null =
    kpiDeltaPct !== null
      ? kpiDeltaPct === 0
        ? null
        : kpiDeltaPct > 0
          ? "up"
          : "down"
      : costLastMonth === null || costThisMonth === null
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

  // Wait until the query has settled before calling anything "empty".
  // Soft-null (404/422 undeployed) stays on the install path — do NOT
  // treat it as "not first-run" KPI theatre. Hard errors leave install
  // so the outage banner + unavailable cards can show.
  const tracesSettled =
    tracesQuery.isFetched || tracesQuery.isError || tracesQuery.isSuccess;
  const tracesUnavailable = tracesQuery.isError;
  const tracesErrorMessage = tracesQuery.isError
    ? (tracesQuery.error?.message ?? "Could not load traces.")
    : null;

  // Install-forward by default: show the checklist until telemetry proves
  // we have traces. Optimistic true avoids a Connect-primary flash while
  // queries hang on a cold API.
  //
  // Pure derivation (no useState/useEffect) — a prior installPath effect
  // flipped setState on every tracesQuery status churn (5xx retries /
  // soft-null) and triggered "Maximum update depth exceeded".
  const tracesHonestlyEmpty =
    tracesSettled &&
    tracesQuery.data != null &&
    tracesTotal === 0;
  const tracesSoftMissing =
    tracesSettled && !tracesQuery.isError && tracesQuery.data == null;
  const hasTraceTraffic =
    tracesSettled &&
    tracesQuery.data != null &&
    tracesTotal > 0;
  // Hard outage leaves the install path so the telemetry error banner +
  // unavailable cards render once (not the first-run checklist theatre).
  const isFirstRun =
    !hasTraceTraffic &&
    !tracesQuery.isError &&
    (tracesHonestlyEmpty || tracesSoftMissing || !tracesSettled);

  // Soft-wire onboarding v2 ``first_trace_at`` on the install path.
  const firstTraceSignal = useOrgQuery(
    ["onboarding-v2-first-trace", orgId],
    orgId,
    async () => {
      try {
        const res = await onboardingV2Api.getState(orgId!);
        return res.data.first_trace_at ?? null;
      } catch {
        return null;
      }
    },
    {
      enabled: layoutReady && isFirstRun && tracesHonestlyEmpty,
      staleTime: FIRST_EVENT_WAIT.pollMs,
      refetchInterval:
        layoutReady && isFirstRun && tracesHonestlyEmpty
          ? FIRST_EVENT_WAIT.pollMs
          : false,
    },
  );
  const firstTraceAt = firstTraceSignal.data ?? null;

  // Wait for org context before claiming empty product or NoOrgState —
  // otherwise first paint looks like a dead dashboard with no traces.
  if (orgLoading && !currentOrg && !authError) {
    return (
      <div aria-busy="true" aria-label="Loading workspace">
        <LoadingSkeleton variant="stats" lines={5} size="wide" />
      </div>
    );
  }

  // No-org branch: brand-new Clerk signups land here before they've
  // joined or created an org. Without this guard the dashboard sat in
  // its loading skeleton forever because ``useOrgQuery`` short-
  // circuits (disabled) when ``currentOrg`` is null. June 2026 fix.
  // Chrome also redirects orgless users to /settings?tab=org.
  if (!currentOrg && !authError) {
    return (
      <NoOrgState
        feature="The dashboard"
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
        description={
          orgSyncTimedOut
            ? "Workspace sync is taking longer than expected. Refresh to try again — the product tour does not create or sync your organization."
            : orgSyncing
              ? undefined
              : "Create an organization to open the dashboard. The product tour does not create or sync your workspace."
        }
      />
    );
  }

  return (
    <CoreResourcePage
      size="wide"
      className="space-y-4 sm:space-y-5"
      header={
        <PageHeader
          title="Home"
          subtitle={
            isFirstRun
              ? firstTraceAt
                ? FIRST_EVENT_WAIT.descriptionReceived
                : "Waiting for first event — install the SDK or gateway, run doctor, then check for events."
              : "Editable first screen — volume, cost Δ, anomalies, and quick links."
          }
          greeting={currentOrg ? `Welcome back to ${currentOrg.name}.` : undefined}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {isFirstRun ? (
                <>
                  {canManageKeys ? (
                    <Button asChild className="min-h-11">
                      <Link href="/settings?tab=api-keys">
                        <Key className="w-3.5 h-3.5" />
                        API keys
                      </Link>
                    </Button>
                  ) : (
                    <Button asChild className="min-h-11">
                      <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                        <BookOpen className="w-3.5 h-3.5" />
                        Docs
                      </a>
                    </Button>
                  )}
                  {canManageKeys ? (
                    <Button asChild variant="outline" className="min-h-11">
                      <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                        <BookOpen className="w-3.5 h-3.5" />
                        Docs
                      </a>
                    </Button>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)] px-3 py-2">
                      Ask an admin for an API key
                    </span>
                  )}
                  <Button asChild variant="ghost" className="min-h-11">
                    <Link href="/dashboard?onboarding=1">
                      <Sparkles className="w-3.5 h-3.5" />
                      Tour
                    </Link>
                  </Button>
                  {canConnect ? (
                    <Button asChild variant="ghost" className="min-h-11">
                      <Link href="/agents/connect">
                        <GitBranch className="w-3.5 h-3.5" />
                        Connect repo
                      </Link>
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <Button asChild className="min-h-11">
                    <Link href="/traces">
                      <Activity className="w-3.5 h-3.5" />
                      Open Traces
                    </Link>
                  </Button>
                  <Button asChild variant="outline" className="min-h-11">
                    <Link href="/issues">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Issues
                    </Link>
                  </Button>
                  {canConnect ? (
                    <Button asChild variant="ghost" className="min-h-11">
                      <Link href="/agents/connect">
                        <GitBranch className="w-3.5 h-3.5" />
                        Connect repo
                      </Link>
                    </Button>
                  ) : null}
                  <Button
                    variant={editing ? "default" : "ghost"}
                    size="sm"
                    className="min-h-11"
                    onClick={() => setEditing((e) => !e)}
                    aria-pressed={editing}
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                    {editing ? "Done" : "Edit layout"}
                  </Button>
                </>
              )}
            </div>
          }
        />
      }
      table={
        <>
      {editing ? (
        <Panel tone="subtle" padding="sm" className="mb-4 flex flex-wrap gap-2">
          {DEFAULT_WIDGETS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => toggleWidget(id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs capitalize",
                show(id)
                  ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]",
              )}
            >
              {id}
            </button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="text-xs"
            onClick={() => saveLayout([...DEFAULT_WIDGETS])}
          >
            Reset
          </Button>
        </Panel>
      ) : null}
      {error ? (
        <ErrorState
          title="Could not load some telemetry."
          message={error}
          className="mb-4"
          size="sm"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                for (const shard of failedShards) {
                  void shard.query.refetch();
                }
              }}
            >
              Retry
            </Button>
          }
        />
      ) : null}

      {/* Row 1: metrics or first-run checklist (install path; no CTA theatre) */}
      {isFirstRun ? (
        <Panel
          data-testid="dashboard-first-run"
          tone="flat"
          padding="lg"
          className="sm:p-8"
        >
          <div className="max-w-xl space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                  {firstTraceAt
                    ? FIRST_EVENT_WAIT.titleReceived
                    : FIRST_EVENT_WAIT.title}
                </h2>
                {!firstTraceAt ? (
                  <span
                    className="live-append-pulse inline-flex h-2 w-2 rounded-full bg-[var(--accent)]"
                    aria-hidden
                  />
                ) : null}
              </div>
              <p className="text-sm text-[var(--text-muted)]">
                {firstTraceAt
                  ? FIRST_EVENT_WAIT.descriptionReceived
                  : canManageKeys
                    ? "Create an API key, install the SDK or gateway, run doctor, then check for events. Connecting a repo is optional — use the header actions."
                    : "Ask an admin for an API key, install the SDK or gateway, run doctor, then check for events. Connecting a repo requires an admin."}
              </p>
            </div>

            {!firstTraceAt ? (
              <div className="space-y-2" data-testid="dashboard-doctor-commands">
                <p className="text-[11px] uppercase tracking-wide text-[var(--text-faint)] m-0">
                  {FIRST_EVENT_WAIT.doctorHint}
                </p>
                <div className="flex flex-col sm:flex-row flex-wrap gap-2">
                  <DoctorCommandChip command={FIRST_EVENT_WAIT.doctorNpx} />
                  <DoctorCommandChip command={FIRST_EVENT_WAIT.doctorPython} />
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="min-h-11"
                loading={tracesQuery.isFetching}
                onClick={() => {
                  void tracesQuery.refetch();
                  void firstTraceSignal.refetch();
                }}
                aria-label={FIRST_EVENT_WAIT.checkCta}
              >
                <Radio className="h-4 w-4" aria-hidden />
                {FIRST_EVENT_WAIT.checkCta}
              </Button>
              <Button asChild variant="outline" className="min-h-11">
                <Link href="/traces">Open Traces</Link>
              </Button>
            </div>

            <ol className="space-y-1 text-sm list-none">
              <li>
                {canManageKeys ? (
                  <Link
                    href="/settings?tab=api-keys"
                    className="inline-flex items-center gap-2 min-h-[44px] text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-faint)] text-xs font-semibold text-[var(--accent)]">
                      1
                    </span>
                    <span>
                      <span className="font-medium">Create API key</span>
                      <span className="text-[var(--text-muted)]"> — Settings → API keys</span>
                    </span>
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-2 min-h-[44px] text-[var(--text-primary)]">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-faint)] text-xs font-semibold text-[var(--accent)]">
                      1
                    </span>
                    <span>
                      <span className="font-medium">Get an API key</span>
                      <span className="text-[var(--text-muted)]"> — ask an owner or admin</span>
                    </span>
                  </span>
                )}
              </li>
              <li>
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 min-h-[44px] text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-faint)] text-xs font-semibold text-[var(--accent)]">
                    2
                  </span>
                  <span>
                    <span className="font-medium">Install SDK / gateway</span>
                    <span className="text-[var(--text-muted)]"> — docs quickstart</span>
                  </span>
                </a>
              </li>
              <li>
                <a
                  href={DOCS_QUICKSTART_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 min-h-[44px] text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-faint)] text-xs font-semibold text-[var(--accent)]">
                    3
                  </span>
                  <span>
                    <span className="font-medium">Run doctor</span>
                    <span className="text-[var(--text-muted)]">
                      {" "}
                      — {FIRST_EVENT_WAIT.doctorNpx} or {FIRST_EVENT_WAIT.doctorPython}
                    </span>
                  </span>
                </a>
              </li>
              <li>
                <Link
                  href="/traces"
                  className="inline-flex items-center gap-2 min-h-[44px] text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-faint)] text-xs font-semibold text-[var(--accent)]">
                    4
                  </span>
                  <span>
                    <span className="font-medium">Open Traces</span>
                    <span className="text-[var(--text-muted)]"> — confirm first events</span>
                  </span>
                </Link>
              </li>
            </ol>
          </div>
        </Panel>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 mb-4">
        {show("throughput") ? (
          <ThroughputCard
            loading={summaryLoading}
            unavailable={summaryQuery.isError}
            avgEps={avgEps}
            totalTraces={throughputTotal}
            windowHours={summaryWindowHours}
            trend={throughputTrend.trend}
            trendValue={throughputTrend.trendValue}
          />
        ) : null}
        {show("latency") ? (
          <LatencyCard
            loading={latencyLoading}
            // Summary outage + no fallback p95 must not read as calm "no latency data".
            unavailable={summaryQuery.isError && p95 == null}
            p95Ms={p95}
            p50Ms={p50}
            trend={latencyTrend.trend}
            trendValue={latencyTrend.trendValue}
          />
        ) : null}
        {show("cost")
          ? (() => {
          const centsThisMonth = costThisMonth;
          const centsLastMonth = costLastMonth;
          // Hard shard failures with no cents → unavailable (not install-empty theatre).
          const costUnavailable =
            !costLoading &&
            centsThisMonth == null &&
            (costComparisonQuery.isError || costKpiQuery.isError);
          const empty =
            !costLoading &&
            !costUnavailable &&
            (centsThisMonth === null || centsThisMonth === 0);
          const usd = (centsThisMonth ?? 0) / 100;
          const subtitle = costUnavailable
            ? "cost unavailable"
            : empty
            ? "no cost data yet"
            : kpiDeltaPct !== null
            ? "Δ vs prior period"
            : centsLastMonth === null
            ? "last month: —"
            : `last month: $${(centsLastMonth / 100).toFixed(2)}`;
          return (
            <StatCard
              title="Cost this month"
              value={empty || costUnavailable ? "—" : `$${usd.toFixed(2)}`}
              subtitle={subtitle}
              trend={costUnavailable ? null : costTrend}
              trendValue={
                costUnavailable
                  ? undefined
                  : costTrend
                    ? `${Math.abs(costDeltaPct)}%`
                    : "—"
              }
              trendIsGood="down"
              icon={DollarSign}
              accent="accent"
              loading={costLoading}
              empty={empty || costUnavailable}
              emptyText={
                costUnavailable
                  ? "Cost unavailable — could not load spend."
                  : "No cost data — start routing calls to populate."
              }
              href="/optimization"
            />
          );
        })()
          : null}
        {show("anomalies")
          ? (() => {
          const alertsLoadedOk =
            alertsQuery.isSuccess && alertsQuery.data != null;
          const severityCounts = countBySeverity(lastDayAlerts);
          const severityClass = alertsUnavailable
            ? "bg-[var(--warning-bg)] text-[var(--warning-strong)]"
            : anomalyCount === 0
              ? "bg-[var(--accent-faint)] text-[var(--accent)]"
              : severityCounts.critical
                ? "bg-[var(--error-bg)] text-[var(--error)]"
                : severityCounts.warning
                  ? "bg-[var(--warning-bg)] text-[var(--warning-strong)]"
                  : "bg-[var(--accent-faint)] text-[var(--accent)]";
          return (
            <StatCard
              title="Anomalies (24h)"
              value={alertsUnavailable ? "—" : anomalyCount}
              subtitle={
                alertsUnavailable
                  ? "alerts unavailable"
                  : !alertsLoadedOk
                    ? undefined
                    : anomalyCount === 0
                      ? "all systems normal"
                      : `${severityCounts.critical ?? 0} critical · ${severityCounts.warning ?? 0} warning`
              }
              icon={AlertTriangle}
              iconClassName={severityClass}
              loading={alertsLoading}
              href="/alerts"
              empty={alertsUnavailable}
              emptyText="Alerts unavailable — could not load anomaly feed."
            />
          );
        })()
          : null}
        {show("agentic") ? (
          <StatCard
            title="Agentic quality"
            value={
              actionCompletion == null
                ? "—"
                : `${Math.round(actionCompletion * 100)}%`
            }
            subtitle="F64 action completion · 24h"
            icon={Sparkles}
            accent="accent"
            loading={agenticQuery.isLoading}
            empty={!agenticQuery.isLoading && actionCompletion == null}
            emptyText={
              agenticQuery.isError
                ? "Agentic scores unavailable — could not load metrics."
                : "Scores appear after Layer A runs on finalized traces."
            }
            href="/agents?tab=fleet"
          />
        ) : null}
      </div>
      )}

      {!isFirstRun && show("failures") && topFailureModes.length > 0 && (
        <Panel tone="flat" padding="md" className="mb-4 sm:p-5">
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
        </Panel>
      )}

      {/* Row 2: recent traces + quick links — only after traffic exists.
          On the install path the checklist already covers API keys /
          docs / Open Traces; repeating empty Recent Traces + Quick
          links duplicated those CTAs. */}
      {!isFirstRun ? (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6">
          {show("traces") ? (
            <div className="xl:col-span-2">
              <RecentTracesCard
                loading={!tracesSettled || tracesQuery.isLoading}
                traces={lastDayTraces.slice(0, 10)}
                unavailable={tracesUnavailable}
                errorMessage={tracesErrorMessage}
              />
            </div>
          ) : null}
          {show("links") ? (
            <div className={cn(show("traces") ? "xl:col-span-1" : "xl:col-span-3")}>
              <QuickLinks />
            </div>
          ) : null}
        </div>
      ) : null}
        </>
      }
    />
  );
}

// ─── subviews ──────────────────────────────────────────────────────

// ─── helpers ───────────────────────────────────────────────────────

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
