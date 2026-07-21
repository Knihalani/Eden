"use client";

import { useMemo, useState } from "react";
import {
  api,
  wave6Api,
  onboardingV2Api,
  agentIssuesApi,
} from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import {
  DEFAULT_WIDGETS,
  TIME_RANGES,
  type WidgetId,
} from "./home-widgets";
import {
  countBySeverity,
  pctTrend,
  shardOr404Null,
  type TraceRow,
} from "./dashboard-helpers";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Home dashboard data contract (Wave 7 / 11).
 * Layout locked to DEFAULT_WIDGETS — Status → Diagnosis → Action; no re-widget.
 */
export function useHomeDashboard(orgId: string | null, orgSyncing: boolean) {
  const [windowHours, setWindowHours] = useState(24);
  const widgets = DEFAULT_WIDGETS;
  const layoutReady = Boolean(orgId);
  const traceDays = Math.max(1, Math.ceil(windowHours / 24));

  const show = (id: WidgetId) => widgets.includes(id);

  const tracesQuery = useOrgQuery(
    queryKeys.observability.traces(orgId, { limit: 50, days: traceDays }),
    orgId,
    () =>
      shardOr404Null(
        api.listObservabilityTraces(orgId!, { limit: 50, days: traceDays }),
      ),
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

  const summaryQuery = useOrgQuery(
    queryKeys.observability.summary(orgId, {
      window_hours: windowHours,
      compare_previous: true,
    }),
    orgId,
    () =>
      shardOr404Null(
        api.getObservabilitySummary(orgId!, {
          window_hours: windowHours,
          compare_previous: true,
        }),
      ),
    {
      enabled:
        layoutReady &&
        (show("throughput") ||
          show("errors") ||
          show("failures")),
    },
  );

  const alertsQuery = useOrgQuery(
    queryKeys.alerts.list(orgId, { limit: 50 }),
    orgId,
    () => shardOr404Null(api.listAlerts(orgId!, { limit: 50 })),
    {
      enabled: layoutReady && !orgSyncing && show("failures"),
    },
  );

  const costComparisonQuery = useOrgQuery(
    queryKeys.cost.comparison(orgId),
    orgId,
    () => shardOr404Null(api.getCostComparison(orgId!)),
    { enabled: layoutReady && show("cost") },
  );
  const costKpiQuery = useOrgQuery(
    queryKeys.cost.kpi(orgId, windowHours),
    orgId,
    () =>
      shardOr404Null(
        wave6Api.costKpi(orgId!, { window_hours: windowHours }),
      ),
    { enabled: layoutReady && show("cost") },
  );
  const issuesQuery = useOrgQuery(
    queryKeys.issues.list(orgId, { status: "open", limit: 1 }),
    orgId,
    () =>
      shardOr404Null(
        agentIssuesApi.list(orgId!, { status: "open", limit: 1 }),
      ),
    { enabled: layoutReady && (show("issues") || show("failures")) },
  );

  const summaryLoading = summaryQuery.isLoading;
  const costLoading =
    costComparisonQuery.isLoading || costKpiQuery.isLoading;
  const alertsLoading = alertsQuery.isLoading;
  const issuesLoading = issuesQuery.isLoading;

  const failedShards = [
    { label: "traces", query: tracesQuery },
    { label: "summary", query: summaryQuery },
    { label: "alerts", query: alertsQuery },
    { label: "cost comparison", query: costComparisonQuery },
    { label: "cost KPI", query: costKpiQuery },
    { label: "issues", query: issuesQuery },
  ].filter((s) => s.query.isError);
  const error =
    failedShards.length > 0
      ? `Could not load ${failedShards.map((s) => s.label).join(", ")}. ${
          failedShards[0].query.error?.message ?? ""
        }`.trim()
      : null;

  const traces = (tracesQuery.data?.traces ?? []) as unknown as TraceRow[];
  const tracesTotal =
    tracesQuery.data?.total ?? tracesQuery.data?.traces?.length ?? 0;
  const summary = summaryQuery.data ?? null;
  const alerts = alertsQuery.data?.alerts ?? [];
  const alertsSettled =
    alertsQuery.isFetched || alertsQuery.isError || alertsQuery.isSuccess;
  const alertsUnavailable =
    alertsQuery.isError || (alertsSettled && alertsQuery.data == null);
  const costComparison = costComparisonQuery.data ?? null;
  const openIssueCount =
    issuesQuery.data?.data?.count ??
    issuesQuery.data?.data?.issues?.length ??
    null;
  const issuesUnavailable =
    issuesQuery.isError ||
    (issuesQuery.isFetched &&
      !issuesQuery.isError &&
      issuesQuery.data == null);

  const summaryWindowHours = summary?.window_hours ?? windowHours;
  const throughputTotal = summary?.total_traces ?? null;
  const avgEps =
    summary != null && summaryWindowHours > 0
      ? summary.total_traces / (summaryWindowHours * 3600)
      : null;
  const throughputTrend = useMemo(
    () => pctTrend(throughputTotal, summary?.previous?.total_traces),
    [summary, throughputTotal],
  );

  const errorRate = summary?.error_rate ?? null;
  const errorTrend = useMemo(
    () => pctTrend(errorRate, summary?.previous?.error_rate),
    [summary, errorRate],
  );

  const topFailureModes = summary?.top_failure_modes?.slice(0, 5) ?? [];

  const costThisMonth = costComparison?.current_month_cents ?? null;
  const costLastMonth = costComparison?.previous_month_cents ?? null;
  const kpiTiles =
    (
      costKpiQuery.data as {
        data?: { tiles?: Array<Record<string, unknown>> };
      } | null
    )?.data?.tiles ??
    (costKpiQuery.data as { tiles?: Array<Record<string, unknown>> } | null)
      ?.tiles ??
    [];
  const kpiCostTile = kpiTiles.find((t) =>
    String(t.id ?? t.key ?? t.title ?? "")
      .toLowerCase()
      .includes("cost"),
  );
  const kpiDeltaPct =
    typeof kpiCostTile?.delta_pct === "number"
      ? Math.round(kpiCostTile.delta_pct as number)
      : null;
  const costDeltaPct =
    kpiDeltaPct !== null
      ? kpiDeltaPct
      : costLastMonth !== null &&
          costLastMonth > 0 &&
          costThisMonth !== null
        ? Math.round(
            ((costThisMonth - costLastMonth) / costLastMonth) * 100,
          )
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

  const costUnavailable =
    !costLoading &&
    costThisMonth == null &&
    (costComparisonQuery.isError || costKpiQuery.isError);
  const costEmpty =
    !costLoading &&
    !costUnavailable &&
    (costThisMonth === null || costThisMonth === 0);
  const costSubtitle = costUnavailable
    ? "cost unavailable"
    : costEmpty
      ? "no cost data yet"
      : kpiDeltaPct !== null
        ? "Δ vs prior period"
        : costLastMonth === null
          ? "last month: —"
          : `last month: $${(costLastMonth / 100).toFixed(2)}`;

  const windowAlerts = useMemo(() => {
    const cutoff = Date.now() - windowHours * HOUR_MS;
    return alerts.filter((a) => new Date(a.triggered_at).getTime() >= cutoff);
  }, [alerts, windowHours]);
  const anomalyCount = windowAlerts.length;

  const windowTraces = useMemo(() => {
    const cutoff = Date.now() - windowHours * HOUR_MS;
    return traces.filter((t) => new Date(t.started_at).getTime() >= cutoff);
  }, [traces, windowHours]);

  const tracesSettled =
    tracesQuery.isFetched || tracesQuery.isError || tracesQuery.isSuccess;
  const tracesUnavailable = tracesQuery.isError;
  const tracesErrorMessage = tracesQuery.isError
    ? (tracesQuery.error?.message ?? "Could not load traces.")
    : null;

  const tracesHonestlyEmpty =
    tracesSettled && tracesQuery.data != null && tracesTotal === 0;
  const tracesSoftMissing =
    tracesSettled && !tracesQuery.isError && tracesQuery.data == null;
  const hasTraceTraffic =
    tracesSettled && tracesQuery.data != null && tracesTotal > 0;
  const isFirstRun =
    !hasTraceTraffic &&
    !tracesQuery.isError &&
    (tracesHonestlyEmpty || tracesSoftMissing || !tracesSettled);

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

  const severityCounts = countBySeverity(windowAlerts);
  const rangeLabel =
    TIME_RANGES.find((r) => r.hours === windowHours)?.label ??
    `Last ${windowHours}h`;

  return {
    windowHours,
    setWindowHours,
    widgets,
    show,
    tracesQuery,
    summaryQuery,
    alertsQuery,
    costComparisonQuery,
    costKpiQuery,
    issuesQuery,
    firstTraceSignal,
    failedShards,
    error,
    summaryLoading,
    costLoading,
    alertsLoading,
    issuesLoading,
    summaryWindowHours,
    throughputTotal,
    avgEps,
    throughputTrend,
    errorRate,
    errorTrend,
    topFailureModes,
    costUnavailable,
    costEmpty,
    costSubtitle,
    costTrend,
    costDeltaPct,
    costThisMonth,
    anomalyCount,
    windowTraces,
    tracesSettled,
    tracesUnavailable,
    tracesErrorMessage,
    isFirstRun,
    firstTraceAt,
    severityCounts,
    rangeLabel,
    openIssueCount,
    issuesUnavailable,
    alertsUnavailable,
    tracesHonestlyEmpty,
  };
}
