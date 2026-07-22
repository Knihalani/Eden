"use client";

import { Suspense, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock,
  Coins,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { useQueryTab } from "@/hooks/use-query-tab";
import { cn } from "@/lib/utils";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import {
  formatCompact,
  formatLatency,
  formatPercent,
  formatTokens,
} from "../_lib/chart-utils";
import { InsightsPanel } from "./_components/insights-panel";
import { TopicsPanel } from "./_components/topics-panel";
import { ToolsPanel } from "./_components/tools-panel";
import { UsersPanel } from "./_components/users-panel";

import { ANALYTICS_TABS, type AnalyticsTab } from "@/lib/analytics-url";

function TabLoading() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

// Recharts stays out of the analytics route shell until overview mounts.
const OverviewCharts = dynamic(
  () => import("./_components/overview-charts"),
  { ssr: false, loading: () => <OverviewChartsSkeleton /> },
);

interface KpiProps {
  label: string;
  value: string;
  sublabel?: string;
  icon: typeof Coins;
  trend?: string;
  trendDir?: "up" | "down" | "neutral";
}

/** Quiet KPI — no Card wall / icon chip soup. */
function Kpi({ label, value, sublabel, icon: Icon, trend, trendDir }: KpiProps) {
  return (
    <div aria-label={`${label}: ${value}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <Icon className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden />
        {trend ? (
          <span
            className={cn(
              "flex items-center gap-1 text-2xs font-medium tabular-nums",
              trendDir === "up" && "text-[var(--terminal)]",
              trendDir === "down" && "text-[var(--error)]",
              trendDir === "neutral" && "text-[var(--text-muted)]",
            )}
          >
            {trendDir === "up" ? (
              <ArrowUpRight className="h-3 w-3" aria-hidden />
            ) : trendDir === "down" ? (
              <ArrowDownRight className="h-3 w-3" aria-hidden />
            ) : null}
            {trend}
          </span>
        ) : null}
      </div>
      <p className="text-2xl font-semibold tracking-tight tabular-nums text-[var(--text-primary)]">
        {value}
      </p>
      <p className="text-xs text-[var(--text-secondary)]">{label}</p>
      {sublabel ? (
        <p className="mt-0.5 text-2xs text-[var(--text-muted)]">{sublabel}</p>
      ) : null}
    </div>
  );
}

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
] as const;

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<TabLoading />}>
      <AnalyticsPageInner />
    </Suspense>
  );
}

function AnalyticsPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [days, setDays] = useState<number>(30);
  const [tab, setTab] = useQueryTab("tab", ANALYTICS_TABS, "overview");

  const tokenQuery = useOrgQuery(
    queryKeys.analytics.tokenUsage(orgId, days),
    orgId,
    () => api.getTokenUsage(orgId!, days),
    { enabled: tab === "overview" },
  );
  const latencyQuery = useOrgQuery(
    queryKeys.analytics.latency(orgId, days),
    orgId,
    () => api.getLatencyPercentiles(orgId!, days),
    { enabled: tab === "overview" },
  );
  const throughputQuery = useOrgQuery(
    queryKeys.analytics.throughput(orgId, days),
    orgId,
    () => api.getThroughputByHour(orgId!, days),
    { enabled: tab === "overview" },
  );
  const topAgentsQuery = useOrgQuery(
    queryKeys.analytics.topAgents(orgId, days),
    orgId,
    () => api.getTopAgentsByCost(orgId!, days),
    { enabled: tab === "overview" },
  );

  const tokenByDay = tokenQuery.data?.by_day ?? [];
  const latencyByDay = latencyQuery.data?.by_day ?? [];
  const throughput = throughputQuery.data?.by_hour ?? [];
  const topAgents = topAgentsQuery.data?.agents ?? [];
  const loading =
    tokenQuery.isLoading ||
    latencyQuery.isLoading ||
    throughputQuery.isLoading ||
    topAgentsQuery.isLoading;
  const failedShards = [
    tokenQuery,
    latencyQuery,
    throughputQuery,
    topAgentsQuery,
  ].filter((q) => q.isError);
  const errorMessage =
    failedShards.length > 0
      ? `Could not load ${["token usage", "latency", "throughput", "top agents"]
          .filter(
            (_, i) =>
              [tokenQuery, latencyQuery, throughputQuery, topAgentsQuery][i]
                .isError,
          )
          .join(", ")}. ${failedShards[0].error?.message ?? "Failed to load analytics"}`.trim()
      : null;
  const refresh = () => {
    void tokenQuery.refetch();
    void latencyQuery.refetch();
    void throughputQuery.refetch();
    void topAgentsQuery.refetch();
  };

  const totals = useMemo(() => {
    const totalIn = tokenByDay.reduce((s, d) => s + d.input_tokens, 0);
    const totalOut = tokenByDay.reduce((s, d) => s + d.output_tokens, 0);
    const latP95 =
      latencyByDay.length > 0
        ? latencyByDay.reduce((s, d) => s + d.p95_ms, 0) / latencyByDay.length
        : 0;
    const latP99 =
      latencyByDay.length > 0
        ? latencyByDay.reduce((s, d) => s + d.p99_ms, 0) / latencyByDay.length
        : 0;
    const tpTotal = throughput.reduce((s, d) => s + d.requests, 0);
    return { totalIn, totalOut, latP95, latP99, tpTotal };
  }, [tokenByDay, latencyByDay, throughput]);

  const isEmptyOverview =
    !loading &&
    !errorMessage &&
    totals.totalIn === 0 &&
    totals.totalOut === 0 &&
    totals.latP95 === 0 &&
    totals.latP99 === 0 &&
    totals.tpTotal === 0;

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Analytics"
        icon={BarChart3}
        description="Select an organization to view analytics"
      />
    );
  }

  return (
    <PageContent size="wide">
      <div
        data-phase-later-analytics="live"
        className="contents"
      >
        <ResourcePageShell
          header={
            <PageHeader
              title="Analytics"
              subtitle="Usage, cost, latency, and quality over time."
              actions={
                tab === "overview" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      role="group"
                      aria-label="Date range"
                      className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1"
                    >
                      {DAY_OPTIONS.map((opt) => (
                        <Button
                          key={opt.value}
                          type="button"
                          variant={days === opt.value ? "default" : "ghost"}
                          size="sm"
                          onClick={() => setDays(opt.value)}
                          aria-pressed={days === opt.value}
                          aria-label={`Last ${opt.label}`}
                        >
                          {opt.label}
                        </Button>
                      ))}
                    </div>
                    <Button
                      onClick={refresh}
                      variant="ghost"
                      size="sm"
                      disabled={loading}
                      aria-label="Refresh analytics"
                    >
                      <RefreshCw
                        className={cn("h-3.5 w-3.5", loading && "animate-spin")}
                      />
                      Refresh
                    </Button>
                  </div>
                ) : undefined
              }
            />
          }
          toolbar={
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as AnalyticsTab)}
            >
              <TabsList
                variant="underline"
                aria-label="Analytics sections"
                className="h-auto w-full justify-start gap-1 bg-transparent"
              >
                {ANALYTICS_TABS.map((t) => (
                  <TabsTrigger
                    key={t}
                    variant="underline"
                    value={t}
                    className="capitalize"
                  >
                    {t}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          }
          table={
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as AnalyticsTab)}
            >

          {/* Progressive thin panels — not full-app embeds */}
          <TabsContent value="insights" className="mt-2">
            {tab === "insights" ? <InsightsPanel /> : null}
          </TabsContent>
          <TabsContent value="topics" className="mt-2">
            {tab === "topics" ? <TopicsPanel /> : null}
          </TabsContent>
          <TabsContent value="tools" className="mt-2">
            {tab === "tools" ? <ToolsPanel /> : null}
          </TabsContent>
          <TabsContent value="users" className="mt-2">
            {tab === "users" ? <UsersPanel /> : null}
          </TabsContent>

          <TabsContent value="overview" className="mt-2">
            {errorMessage ? (
              <ErrorState
                title="Could not load analytics"
                message={errorMessage}
                action={
                  <Button onClick={refresh} variant="outline" size="default">
                    <RefreshCw className="h-4 w-4" />
                    Try again
                  </Button>
                }
              />
            ) : isEmptyOverview ? (
              <EmptyState
                icon={BarChart3}
                title="No analytics yet"
                description="Send traces to see token usage, latency, and request volume. KPIs stay empty until ingestion starts — this is not a load failure."
                size="lg"
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button asChild variant="outline" size="default">
                      <a
                        href={DOCS_QUICKSTART_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Docs quickstart
                      </a>
                    </Button>
                    <Button asChild variant="ghost" size="default">
                      <Link href="/traces">Open Traces</Link>
                    </Button>
                  </div>
                }
              />
            ) : (
              <>
                <div
                  className="grid grid-cols-2 gap-4 lg:grid-cols-4"
                  data-testid="analytics-kpi-strip"
                >
                  <Kpi
                    label="Total tokens"
                    value={formatTokens(totals.totalIn + totals.totalOut)}
                    sublabel={`${formatPercent(
                      totals.totalIn /
                        Math.max(1, totals.totalIn + totals.totalOut),
                      0,
                    )} input`}
                    icon={Coins}
                  />
                  <Kpi
                    label="p95 latency"
                    value={formatLatency(totals.latP95)}
                    sublabel="Average over period"
                    icon={Clock}
                  />
                  <Kpi
                    label="p99 latency"
                    value={formatLatency(totals.latP99)}
                    sublabel="Tail latency"
                    icon={Zap}
                  />
                  <Kpi
                    label="Total requests"
                    value={formatCompact(totals.tpTotal)}
                    sublabel="From hourly throughput"
                    icon={BarChart3}
                  />
                </div>

                {loading ? (
                  <OverviewChartsSkeleton />
                ) : (
                  <div className="mt-4">
                    <OverviewCharts
                      tokenByDay={tokenByDay}
                      latencyByDay={latencyByDay}
                      throughput={throughput}
                      topAgents={topAgents}
                    />
                  </div>
                )}
              </>
            )}
          </TabsContent>
            </Tabs>
          }
        />
      </div>
    </PageContent>
  );
}

function ChartSkeleton() {
  return (
    <div
      className="space-y-3 rounded-xl bg-[var(--bg-secondary)] p-4"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-3 w-48" />
      <div className="flex h-[200px] items-end gap-2 pt-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton
            key={i}
            className="flex-1"
            style={{ height: `${30 + ((i * 13) % 70)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function OverviewChartsSkeleton() {
  return (
    <div className="mt-4 space-y-4" data-testid="analytics-chart-hierarchy">
      <ChartSkeleton />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
      <ChartSkeleton />
    </div>
  );
}
