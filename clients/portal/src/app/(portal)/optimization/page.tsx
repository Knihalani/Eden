"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowRight, Brain, Loader2, TrendingUp, TrendingDown, Sparkles, Target, BarChart3 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { StatCard } from "@/components/ui/stat-card";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { costApi } from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useQueryTab } from "@/hooks/use-query-tab";

const COST_TABS = ["cost", "budget", "outcomes", "predict", "advisor"] as const;

/* ----------------------- Sub-pages (lazy) ----------------------------- */

const OutcomesPage = dynamic(() => import("./outcomes/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  ) });
const PredictPage = dynamic(() => import("./predict/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  ) });
const BudgetPage = dynamic(() => import("./budget/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  ) });
const AdvisorPage = dynamic(() => import("./model-advisor/page"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  ) });

/* ----------------------- Inline SVG forecast chart -------------------- */

function ForecastChart({
  data }: {
  data: Array<{ date: string; projected_cost: number; ci_low: number; ci_high: number }>;
}) {
  // June 2026 polish: legend, hover tooltip with full date + median +
  // CI band, evenly-spaced x-axis tick labels (was: first/last only),
  // grid lines so the eye can read absolute values without hovering.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No forecast data"
        description="Forecast appears once you have usage history."
        size="md"
      />
    );
  }
  const width = 720;
  const height = 260;
  const padX = 48;
  const padY = 28;
  const xs = data.map((d) => new Date(d.date).getTime());
  const ys = data.flatMap((d) => [d.ci_low, d.ci_high, d.projected_cost]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = Math.max(1e-9, yMax - yMin);
  const xRange = Math.max(1, xMax - xMin);
  const xScale = (t: number) => padX + ((t - xMin) / xRange) * (width - padX * 2);
  const yScale = (v: number) => height - padY - ((v - yMin) / yRange) * (height - padY * 2);

  const linePath = data
    .map((d, i) => {
      const x = xScale(new Date(d.date).getTime());
      const y = yScale(d.projected_cost);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const bandPath = (() => {
    const top = data.map((d, i) => {
      const x = xScale(new Date(d.date).getTime());
      const y = yScale(d.ci_high);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    const bottom = data
      .slice()
      .reverse()
      .map((d) => {
        const x = xScale(new Date(d.date).getTime());
        const y = yScale(d.ci_low);
        return `L ${x.toFixed(1)} ${y.toFixed(1)}`;
      });
    return [...top, ...bottom, "Z"].join(" ");
  })();

  // Horizontal grid lines at 0%, 25%, 50%, 75%, 100% of the y range.
  const gridLines = [0, 0.25, 0.5, 0.75, 1.0].map((frac) => ({
    y: padY + frac * (height - padY * 2),
    value: yMax - frac * yRange }));

  // X-axis tick stride: aim for ~5 ticks; data points may be irregular.
  const xTickCount = Math.min(5, data.length);
  const xTickStride = Math.max(1, Math.floor((data.length - 1) / Math.max(1, xTickCount - 1)));
  const xTicks: number[] = [];
  for (let i = 0; i < data.length; i += xTickStride) xTicks.push(i);
  if (xTicks[xTicks.length - 1] !== data.length - 1) xTicks.push(data.length - 1);

  // Hover handling — translate cursor x into a data index.
  const onSvgMouseMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    const svg = evt.currentTarget;
    const rect = svg.getBoundingClientRect();
    const cursorX = ((evt.clientX - rect.left) / rect.width) * width;
    if (cursorX < padX || cursorX > width - padX) {
      setHoverIdx(null);
      return;
    }
    // Pick the closest point to the cursor.
    let bestIdx = 0;
    let bestDist = Infinity;
    data.forEach((d, i) => {
      const dx = Math.abs(xScale(new Date(d.date).getTime()) - cursorX);
      if (dx < bestDist) {
        bestDist = dx;
        bestIdx = i;
      }
    });
    setHoverIdx(bestIdx);
  };

  const hoverPoint = hoverIdx !== null ? data[hoverIdx] : null;
  const hoverX = hoverPoint ? xScale(new Date(hoverPoint.date).getTime()) : 0;
  const hoverY = hoverPoint ? yScale(hoverPoint.projected_cost) : 0;

  // Tooltip flips to the left if it would overflow the right edge.
  const tooltipW = 168;
  const tooltipH = 64;
  const tooltipFlipLeft = hoverX + tooltipW + 12 > width;
  const tooltipX = tooltipFlipLeft ? hoverX - tooltipW - 12 : hoverX + 12;
  const tooltipY = Math.max(padY, Math.min(height - padY - tooltipH, hoverY - tooltipH / 2));

  return (
    <div>
      {/* Legend */}
      <div className="flex items-center gap-4 mb-2 text-xs text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-0.5 bg-[var(--accent)]" />
          <span>Projected median</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-2.5 rounded-sm"
            style={{ background: "var(--accent)", opacity: 0.18 }}
          />
          <span>95% confidence band</span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-64 w-full cursor-crosshair"
        role="img"
        aria-label="Projected cost forecast"
        onMouseMove={onSvgMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="fcBand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {/* Horizontal grid lines + y-axis labels */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={padX}
              y1={g.y}
              x2={width - padX}
              y2={g.y}
              stroke="var(--border-subtle)"
              strokeDasharray="2 3"
              opacity={0.5}
            />
            <text
              x={padX - 6}
              y={g.y + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--text-muted)"
            >
              {`$${g.value.toFixed(g.value >= 100 ? 0 : 2)}`}
            </text>
          </g>
        ))}
        {/* axes */}
        <line
          x1={padX}
          y1={height - padY}
          x2={width - padX}
          y2={height - padY}
          stroke="var(--border-default)"
        />
        <line
          x1={padX}
          y1={padY}
          x2={padX}
          y2={height - padY}
          stroke="var(--border-default)"
        />
        {/* CI band */}
        <path d={bandPath} fill="url(#fcBand)" stroke="none" />
        {/* projected line */}
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {/* dots */}
        {data.map((d, i) => {
          const x = xScale(new Date(d.date).getTime());
          const y = yScale(d.projected_cost);
          return (
            <circle
              key={d.date}
              cx={x}
              cy={y}
              r={hoverIdx === i ? 4 : 2.5}
              fill="var(--accent)"
            />
          );
        })}
        {/* x-axis date ticks */}
        {xTicks.map((i) => {
          const d = data[i];
          const x = xScale(new Date(d.date).getTime());
          return (
            <text
              key={`xt-${i}`}
              x={x}
              y={height - 8}
              textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
              fontSize={10}
              fill="var(--text-muted)"
            >
              {formatTickDate(d.date)}
            </text>
          );
        })}
        {/* Hover crosshair + tooltip */}
        {hoverPoint && (
          <g>
            <line
              x1={hoverX}
              y1={padY}
              x2={hoverX}
              y2={height - padY}
              stroke="var(--text-muted)"
              strokeDasharray="2 3"
              opacity={0.4}
            />
            <rect
              x={tooltipX}
              y={tooltipY}
              width={tooltipW}
              height={tooltipH}
              fill="var(--bg-primary)"
              stroke="var(--border-default)"
              rx={6}
            />
            <text
              x={tooltipX + 8}
              y={tooltipY + 16}
              fontSize={11}
              fontWeight="600"
              fill="var(--text-primary)"
            >
              {formatTooltipDate(hoverPoint.date)}
            </text>
            <text
              x={tooltipX + 8}
              y={tooltipY + 32}
              fontSize={11}
              fill="var(--text-secondary)"
            >
              {`Median: $${hoverPoint.projected_cost.toFixed(2)}`}
            </text>
            <text
              x={tooltipX + 8}
              y={tooltipY + 48}
              fontSize={10}
              fill="var(--text-muted)"
            >
              {`95% CI: $${hoverPoint.ci_low.toFixed(2)}–$${hoverPoint.ci_high.toFixed(2)}`}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

function formatTickDate(iso: string): string {
  // Trim leading year ("2026-06-14" → "Jun 14")
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso.slice(5);
  }
}

function formatTooltipDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric" });
  } catch {
    return iso;
  }
}

/* ----------------------- Helpers -------------------------------------- */

function formatCurrency(n: number, opts?: { compact?: boolean }) {
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    return `$${n.toFixed(2)}`;
  }
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatNumber(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/* ----------------------- Cost tab ------------------------------------- */

function CostTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [days, setDays] = useState<number>(30);

  const efficiencyQuery = useOrgQuery(
    queryKeys.cost.efficiency(orgId, days),
    orgId,
    () => costApi.efficiency(orgId!, { days }),
  );
  const roiQuery = useOrgQuery(
    queryKeys.cost.roi(orgId, days),
    orgId,
    () => costApi.roi(orgId!, { days }),
  );
  const anomaliesQuery = useOrgQuery(
    queryKeys.cost.anomalies(orgId, days),
    orgId,
    () => costApi.anomalies(orgId!, { days }),
  );
  const forecastQuery = useOrgQuery(
    queryKeys.cost.forecast(orgId),
    orgId,
    () => costApi.forecast(orgId!),
  );

  const efficiency = efficiencyQuery.data ?? null;
  const roi = roiQuery.data ?? null;
  const anomalies = anomaliesQuery.data ?? null;
  const forecast = forecastQuery.data ?? null;
  const loading =
    efficiencyQuery.isLoading || roiQuery.isLoading || anomaliesQuery.isLoading || forecastQuery.isLoading;
  const failedShards = [efficiencyQuery, roiQuery, anomaliesQuery, forecastQuery].filter((q) => q.isError);
  const error = failedShards.length > 0 ? failedShards[0].error?.message ?? "Failed to load cost data" : null;
  const refresh = () => {
    void efficiencyQuery.refetch();
    void roiQuery.refetch();
    void anomaliesQuery.refetch();
    void forecastQuery.refetch();
  };

  if (!currentOrg) {
    return <NoOrgState feature="Cost & usage optimization" />;
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center" role="status" aria-live="polite">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load cost data"
        message={error}
        action={
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
          >
            Retry
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Cross-sell: model advisor */}
      <Link
        href="/optimization/model-advisor"
        className="group flex items-center justify-between gap-3 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-faint)] px-4 py-2.5 text-sm transition-colors hover:border-[var(--accent)]/50"
      >
        <div className="flex items-center gap-3">
          <Brain className="h-4 w-4 text-[var(--accent)]" />
          <div>
            <div className="font-medium text-[var(--text-primary)]">
              Switch to a cheaper or better model?
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              Compare, project, and pick — uses your real usage history.
            </div>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-[var(--accent)] transition-transform group-hover:translate-x-0.5" />
      </Link>

      {/* Day range selector */}
      <div className="flex items-center justify-end">
        <div
          role="group"
          aria-label="Day range"
          className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-0.5"
        >
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              aria-label={`Last ${d} days`}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                days === d
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Efficiency score"
          value={efficiency ? efficiency.efficiency_score.toFixed(2) : "—"}
          subtitle={`${efficiency?.period_days ?? days}-day window`}
          icon={Target}
          accent="accent"
        />
        <StatCard
          title="Total cost"
          value={roi ? formatCurrency(roi.total_cost, { compact: true }) : "—"}
          subtitle={`${days}-day window`}
          icon={TrendingDown}
          accent="warning"
        />
        <StatCard
          title="Total revenue"
          value={roi ? formatCurrency(roi.total_revenue, { compact: true }) : "—"}
          subtitle="Tracked outcomes"
          icon={TrendingUp}
          accent="terminal"
        />
        <StatCard
          title="ROI"
          value={roi ? roi.roi.toFixed(2) : "—"}
          subtitle="Revenue / cost"
          icon={BarChart3}
          accent={(roi?.roi ?? 0) >= 1 ? "accent" : "warning"}
        />
      </div>

      {/* Forecast chart */}
      <Card>
        <CardHeader>
          <CardTitle>Projected cost</CardTitle>
          <CardDescription>
            {forecast
              ? `${forecast.forecast.length}-day horizon · model: ${forecast.model}`
              : "Forecast unavailable"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {forecast ? <ForecastChart data={forecast.forecast} /> : null}
        </CardContent>
      </Card>

      {/* ROI by agent table */}
      <Card>
        <CardHeader>
          <CardTitle>ROI by agent</CardTitle>
          <CardDescription>Cost vs revenue attributed per agent</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <DataTable
            columns={[
              { key: "agent_id", header: "Agent", cell: (a) => <span className="font-mono text-xs text-[var(--text-secondary)]">{a.agent_id}</span>, sortable: true },
              { key: "cost", header: "Cost", align: "right", cell: (a) => formatCurrency(a.cost, { compact: true }), sortable: true },
              { key: "revenue", header: "Revenue", align: "right", cell: (a) => formatCurrency(a.revenue, { compact: true }), sortable: true },
              {
                key: "roi",
                header: "ROI",
                align: "right",
                cell: (a) => (
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                      a.roi >= 2
                        ? "bg-[var(--success-bg)] text-[var(--success)]"
                        : a.roi >= 1
                          ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                          : "bg-[var(--error-bg)] text-[var(--error)]"
                    )}
                  >
                    {a.roi.toFixed(2)}
                  </span>
                ),
                sortable: true },
            ]}
            rows={roi?.per_agent ?? []}
            rowKey={(a) => a.agent_id}
            defaultSort={{ key: "roi", direction: "desc" }}
            emptyIcon={BarChart3}
            emptyTitle="No ROI data"
            emptyDescription="Track outcomes on traces to populate agent ROI."
          />
        </CardContent>
      </Card>

      {/* Anomalies table */}
      <Card>
        <CardHeader>
          <CardTitle>Cost anomalies</CardTitle>
          <CardDescription>
            {anomalies ? `${anomalies.anomalies.length} detected` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <DataTable
            columns={[
              { key: "date", header: "Date", cell: (a) => <span className="text-[var(--text-secondary)]">{a.date}</span>, sortable: true },
              { key: "agent_id", header: "Agent", cell: (a) => <span className="font-mono text-xs text-[var(--text-secondary)]">{a.agent_id}</span> },
              { key: "cost", header: "Cost", align: "right", cell: (a) => formatCurrency(a.cost, { compact: true }), sortable: true },
              { key: "z_score", header: "Z-score", align: "right", cell: (a) => formatNumber(a.z_score), sortable: true },
              {
                key: "severity",
                header: "Severity",
                cell: (a) => (
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                      a.severity === "high" || Math.abs(a.z_score) > 4
                        ? "bg-[var(--error-bg)] text-[var(--error)]"
                        : a.severity === "medium"
                          ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                    )}
                  >
                    {a.severity}
                  </span>
                ) },
            ]}
            rows={anomalies?.anomalies ?? []}
            rowKey={(a, i) => `${a.date}-${a.agent_id}-${i}`}
            defaultSort={{ key: "z_score", direction: "desc" }}
            emptyIcon={Sparkles}
            emptyTitle="No anomalies detected"
            emptyDescription="All costs within expected z-score range."
          />
        </CardContent>
      </Card>
    </div>
  );
}

/* ----------------------- Page ---------------------------------------- */

function OptimizationPageInner() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useQueryTab("tab", COST_TABS, "cost");

  if (!currentOrg) {
    return <NoOrgState feature="Cost & usage optimization" />;
  }

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Optimize"
        title="Cost"
        subtitle="Spend, budgets, outcomes, forecasts, and model advice."
        icon={Sparkles}
        description="Where your tokens go, what caching saves, and how the budget is burning."
      />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as (typeof COST_TABS)[number])}
      >
        <TabsList variant="underline" className="w-full">
          <TabsTrigger value="cost" variant="underline">Cost</TabsTrigger>
          <TabsTrigger value="budget" variant="underline">Budget</TabsTrigger>
          <TabsTrigger value="outcomes" variant="underline">Outcomes</TabsTrigger>
          <TabsTrigger value="predict" variant="underline">Predict</TabsTrigger>
          <TabsTrigger value="advisor" variant="underline">Model Advisor</TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          {tab === "cost" && (
            <TabsContent value="cost" forceMount={tab === "cost" ? true : undefined}>
              <motion.div
                key="cost"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                <CostTab />
              </motion.div>
            </TabsContent>
          )}
          {tab === "budget" && (
            <TabsContent value="budget" forceMount>
              <EmbeddedSurface>
                <BudgetPage />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "outcomes" && (
            <TabsContent value="outcomes" forceMount>
              <EmbeddedSurface>
                <OutcomesPage />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "predict" && (
            <TabsContent value="predict" forceMount>
              <EmbeddedSurface>
                <PredictPage />
              </EmbeddedSurface>
            </TabsContent>
          )}
          {tab === "advisor" && (
            <TabsContent value="advisor" forceMount>
              <EmbeddedSurface>
                <AdvisorPage />
              </EmbeddedSurface>
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>
    </PageContent>
  );
}

export default function OptimizationPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <OptimizationPageInner />
    </Suspense>
  );
}
