"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles, AlertTriangle, TrendingDown, Wallet, BarChart3 } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { ChartCard } from "@/components/ui/chart-card";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AXIS_TICK_PROPS,
  CHART_COLORS,
  TOOLTIP_STYLE,
  fetchWithFallback,
  formatChartDate,
  formatCompact,
  formatCurrency,
  formatLatency,
  formatPercent,
  formatTokens,
  makeSyntheticBudget,
  makeSyntheticCacheByDay,
  makeSyntheticCostByModel,
  makeSyntheticCostOverTime,
  makeSyntheticCostPerTrace,
  makeSyntheticSavingsByDay,
} from "../_lib/chart-utils";

/* ------------------------- Synthetic badge ----------------------------- */

function SyntheticBadge({ reason }: { reason?: string }) {
  return (
    <span
      title={reason}
      className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]"
    >
      <Sparkles className="h-3 w-3" /> Synthetic
    </span>
  );
}

/* ------------------------- Top-line KPI strip -------------------------- */

interface KpiCardProps {
  label: string;
  value: string;
  sublabel?: string;
  trend?: string;
  trendDir?: "up" | "down" | "neutral";
  icon: typeof Wallet;
  iconColor: string;
}

function KpiCard({ label, value, sublabel, trend, trendDir, icon: Icon, iconColor }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm transition-all duration-200 hover:shadow-md">
      <div className="mb-2 flex items-start justify-between">
        <div className={cn("rounded-lg p-2", iconColor)}>
          <Icon className="h-4 w-4" />
        </div>
        {trend && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              trendDir === "up" && "text-[var(--success)] bg-[var(--success-bg)]",
              trendDir === "down" && "text-[var(--error)] bg-[var(--error-bg)]",
              trendDir === "neutral" && "text-[var(--text-muted)] bg-[var(--bg-tertiary)]"
            )}
          >
            {trend}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">{value}</p>
      <p className="text-xs font-medium text-[var(--text-secondary)]">{label}</p>
      {sublabel && <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">{sublabel}</p>}
    </div>
  );
}

/* ------------------------- Donut: cost by model ------------------------- */

function CostByModelDonut({
  data,
}: {
  data: Array<{ model: string; cost_usd: number; tokens: number; requests: number }>;
}) {
  const total = data.reduce((s, d) => s + d.cost_usd, 0);
  const chartData = data.map((d) => ({ name: d.model, value: d.cost_usd }));

  return (
    <ChartCard
      title="Cost by model"
      description="Current period, all-time breakdown"
      height={300}
      isEmpty={chartData.length === 0}
    >
      <PieChart>
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value: number, name: string) => [
            `${formatCurrency(value)} (${formatPercent((value / Math.max(1, total)) * 100, 1)})`,
            name,
          ]}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: "var(--text-muted)", paddingTop: 8 }}
        />
        <Pie
          data={chartData}
          innerRadius={60}
          outerRadius={100}
          paddingAngle={2}
          dataKey="value"
          nameKey="name"
          stroke="var(--surface)"
        >
          {chartData.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS.series[i % CHART_COLORS.series.length]} />
          ))}
        </Pie>
        <text
          x="50%"
          y="46%"
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontSize: 11, fill: "var(--text-muted)" }}
        >
          Total
        </text>
        <text
          x="50%"
          y="54%"
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontSize: 18, fontWeight: 700, fill: "var(--text-primary)" }}
        >
          {formatCurrency(total, { compact: true })}
        </text>
      </PieChart>
    </ChartCard>
  );
}

/* ---------------- Stacked area: cost by model over time ----------------- */

function CostByModelStackedArea({
  data,
  models,
}: {
  data: Array<Record<string, number | string>>;
  models: string[];
}) {
  return (
    <ChartCard
      title="Cost by model over time"
      description="Stacked daily spend per upstream model"
      height={300}
      isEmpty={data.length === 0}
    >
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatChartDate}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={{ stroke: "var(--border-subtle)" }}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(v) => formatCurrency(v, { compact: true })}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(label) => formatChartDate(String(label))}
          formatter={(value: number) => [formatCurrency(value), undefined]}
        />
        {models.length > 0 && (
          <Legend
            iconType="circle"
            wrapperStyle={{ fontSize: 11, color: "var(--text-muted)", paddingTop: 8 }}
          />
        )}
        {models.map((model, i) => (
          <Area
            key={model}
            type="monotone"
            dataKey={model}
            stackId="1"
            stroke={CHART_COLORS.series[i % CHART_COLORS.series.length]}
            fill={CHART_COLORS.series[i % CHART_COLORS.series.length]}
            fillOpacity={0.45}
            strokeWidth={1.5}
          />
        ))}
      </AreaChart>
    </ChartCard>
  );
}

/* ------------------- Area: cache hits vs misses over time -------------- */

function CacheSavingsChart({
  data,
}: {
  data: Array<{
    date: string;
    cache_hits: number;
    cache_misses: number;
    tokens_saved: number;
    cost_saved_usd: number;
  }>;
}) {
  return (
    <ChartCard
      title="Cache savings over time"
      description="Daily cache hits vs misses (request count)"
      height={300}
      isEmpty={data.length === 0}
    >
      <AreaChart data={data}>
        <defs>
          <linearGradient id="cacheHitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.6} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="cacheMissGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--warning)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--warning)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatChartDate}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={{ stroke: "var(--border-subtle)" }}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(label) => formatChartDate(String(label))}
          formatter={(value: number, name: string) => [
            `${value.toLocaleString()}`,
            name === "cache_hits" ? "Hits" : "Misses",
          ]}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: "var(--text-muted)", paddingTop: 8 }}
        />
        <Area
          type="monotone"
          dataKey="cache_hits"
          stroke="var(--accent)"
          strokeWidth={2}
          fill="url(#cacheHitGrad)"
        />
        <Area
          type="monotone"
          dataKey="cache_misses"
          stroke="var(--warning)"
          strokeWidth={2}
          fill="url(#cacheMissGrad)"
        />
      </AreaChart>
    </ChartCard>
  );
}

/* -------------------------- Budget gauge ------------------------------- */

function BudgetGauge({
  budget,
}: {
  budget: {
    budget_usd: number;
    spent_usd: number;
    burn_pct: number;
    days_into_period: number;
    days_remaining: number;
    projected_eom_cost_usd: number;
    on_track: boolean;
  };
}) {
  // Map burn_pct (0-100+) onto a 0-180° arc.
  const clamped = Math.max(0, Math.min(100, budget.burn_pct));
  const angle = (clamped / 100) * 180;
  // Convert angle to x/y on a half-circle of radius 70.
  const r = 70;
  const cx = 100;
  const cy = 90;
  const rad = ((180 - angle) * Math.PI) / 180;
  const x = cx + r * Math.cos(rad);
  const y = cy - r * Math.sin(rad);

  return (
    <ChartCard
      title="Budget burn-down"
      description="Current period"
      height={300}
      isEmpty={false}
    >
      <div className="flex h-full flex-col">
        <div className="relative flex-1">
          <svg viewBox="0 0 200 110" className="h-full w-full" aria-label="Budget gauge">
            {/* track */}
            <path
              d="M 30 90 A 70 70 0 0 1 170 90"
              fill="none"
              stroke="var(--bg-tertiary)"
              strokeWidth="14"
              strokeLinecap="round"
            />
            {/* value */}
            <path
              d="M 30 90 A 70 70 0 0 1 170 90"
              fill="none"
              stroke={budget.on_track ? "var(--accent)" : "var(--error)"}
              strokeWidth="14"
              strokeLinecap="round"
              strokeDasharray={`${(clamped / 100) * 220} 220`}
            />
            {/* needle dot */}
            <circle cx={x} cy={y} r="5" fill="var(--text-primary)" />
            <text
              x="100"
              y="78"
              textAnchor="middle"
              style={{ fontSize: 22, fontWeight: 700, fill: "var(--text-primary)" }}
            >
              {formatPercent(budget.burn_pct, 0)}
            </text>
            <text
              x="100"
              y="96"
              textAnchor="middle"
              style={{ fontSize: 10, fill: "var(--text-muted)" }}
            >
              of {formatCurrency(budget.budget_usd, { compact: true })}
            </text>
          </svg>
        </div>
        <div className="grid grid-cols-3 gap-2 border-t border-[var(--border-subtle)] pt-3 text-center">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Spent</p>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {formatCurrency(budget.spent_usd, { compact: true })}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
              Projected EoM
            </p>
            <p
              className={cn(
                "text-sm font-semibold",
                budget.on_track ? "text-[var(--success)]" : "text-[var(--error)]"
              )}
            >
              {formatCurrency(budget.projected_eom_cost_usd, { compact: true })}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
              Days left
            </p>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {budget.days_remaining}
            </p>
          </div>
        </div>
      </div>
    </ChartCard>
  );
}

/* ---------------------- Cost-per-trace scatter ------------------------- */

function CostPerTraceScatter({
  data,
}: {
  data: Array<{
    trace_id: string;
    cost_usd: number;
    tokens: number;
    latency_ms: number;
    model: string;
  }>;
}) {
  return (
    <ChartCard
      title="Cost per trace"
      description="Each dot is a single trace; x = latency, y = cost, size = tokens"
      height={300}
      isEmpty={data.length === 0}
    >
      <ScatterChart margin={{ top: 10, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
        <XAxis
          type="number"
          dataKey="latency_ms"
          name="Latency"
          tickFormatter={(v) => formatLatency(v)}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={{ stroke: "var(--border-subtle)" }}
        />
        <YAxis
          type="number"
          dataKey="cost_usd"
          name="Cost"
          tickFormatter={(v) => formatCurrency(v, { compact: true })}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={false}
        />
        <ZAxis type="number" dataKey="tokens" range={[30, 240]} name="Tokens" />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ strokeDasharray: "3 3" }}
          formatter={(value: number, name: string) => {
            if (name === "Cost") return [formatCurrency(value), name];
            if (name === "Latency") return [formatLatency(value), name];
            if (name === "Tokens") return [formatTokens(value), name];
            return [value, name];
          }}
        />
        <Scatter data={data} fill="var(--accent)" fillOpacity={0.55} />
      </ScatterChart>
    </ChartCard>
  );
}

/* --------------------- Savings: baseline vs actual -------------------- */

function SavingsLineChart({
  data,
}: {
  data: Array<{ date: string; baseline_cost_usd: number; actual_cost_usd: number }>;
}) {
  const totalSavings = data.reduce(
    (s, d) => s + Math.max(0, d.baseline_cost_usd - d.actual_cost_usd),
    0
  );
  return (
    <ChartCard
      title="Cache + routing savings"
      description={`Baseline (no optimizations) vs actual · total saved ${formatCurrency(
        totalSavings,
        { compact: true }
      )}`}
      height={300}
      isEmpty={data.length === 0}
    >
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatChartDate}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={{ stroke: "var(--border-subtle)" }}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(v) => formatCurrency(v, { compact: true })}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(label) => formatChartDate(String(label))}
          formatter={(value: number) => [formatCurrency(value), undefined]}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: "var(--text-muted)", paddingTop: 8 }}
        />
        <Line
          type="monotone"
          dataKey="baseline_cost_usd"
          name="Baseline"
          stroke="var(--warning)"
          strokeWidth={2}
          dot={false}
          strokeDasharray="4 4"
        />
        <Line
          type="monotone"
          dataKey="actual_cost_usd"
          name="Actual"
          stroke="var(--accent)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartCard>
  );
}

/* ----------------------------- Page ---------------------------------- */

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
] as const;

export default function OptimizationPage() {
  const { currentOrg } = useOrg();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [isSynthetic, setIsSynthetic] = useState(false);

  const [costByModel, setCostByModel] = useState<
    Array<{ model: string; cost_usd: number; tokens: number; requests: number }>
  >([]);
  const [cacheByDay, setCacheByDay] = useState<
    Array<{
      date: string;
      cache_hits: number;
      cache_misses: number;
      tokens_saved: number;
      cost_saved_usd: number;
    }>
  >([]);
  const [savingsByDay, setSavingsByDay] = useState<
    Array<{ date: string; baseline_cost_usd: number; actual_cost_usd: number }>
  >([]);
  const [budget, setBudget] = useState<{
    budget_usd: number;
    spent_usd: number;
    burn_pct: number;
    days_into_period: number;
    days_remaining: number;
    projected_eom_cost_usd: number;
    on_track: boolean;
  } | null>(null);
  const [costPerTrace, setCostPerTrace] = useState<
    Array<{
      trace_id: string;
      cost_usd: number;
      tokens: number;
      latency_ms: number;
      model: string;
    }>
  >([]);
  const [stackedCost, setStackedCost] = useState<Array<Record<string, number | string>>>([]);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    const orgId = currentOrg.id;
    const seedOpts = { orgId, days };

    // Defer the loading-state update so it isn't called synchronously
    // within the effect body (avoids cascading-render lint warning).
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
    });
    Promise.all([
      fetchWithFallback({
        fetcher: () => api.getOptimizationCosts(orgId, days),
        fallback: () => ({
          by_day: makeSyntheticCostOverTime(seedOpts),
          by_model: makeSyntheticCostByModel(seedOpts),
        }),
      }),
      fetchWithFallback({
        fetcher: () => api.getOptimizationCache(orgId, days),
        fallback: () => ({ by_day: makeSyntheticCacheByDay(seedOpts) }),
      }),
      fetchWithFallback({
        fetcher: () => api.getOptimizationSavings(orgId, days),
        fallback: () => ({ by_day: makeSyntheticSavingsByDay(seedOpts), total_savings_usd: 0 }),
      }),
      fetchWithFallback({
        fetcher: () => api.getOptimizationBudget(orgId),
        fallback: () => makeSyntheticBudget(orgId),
      }),
      fetchWithFallback({
        fetcher: () => api.getOptimizationCostPerTrace(orgId, days),
        fallback: () => ({ points: makeSyntheticCostPerTrace(seedOpts) }),
      }),
    ]).then(([costs, cache, savings, bud, cpt]) => {
      if (cancelled) return;
      const costsData = costs.data as {
        by_day: Array<{ date: string; cost_usd: number }>;
        by_model: Array<{ model: string; cost_usd: number; tokens: number; requests: number }>;
      } | null;
      const cacheData = cache.data as {
        by_day: Array<{
          date: string;
          cache_hits: number;
          cache_misses: number;
          tokens_saved: number;
          cost_saved_usd: number;
        }>;
      } | null;
      const savingsData = savings.data as {
        by_day: Array<{ date: string; baseline_cost_usd: number; actual_cost_usd: number }>;
        total_savings_usd: number;
      } | null;
      const budData = bud.data as typeof budget;
      const cptData = cpt.data as {
        points: Array<{
          trace_id: string;
          cost_usd: number;
          tokens: number;
          latency_ms: number;
          model: string;
        }>;
      } | null;

      setCostByModel(costsData?.by_model ?? []);
      // Build stacked area: if the backend returns only per-day totals, fall
      // back to a synthetic per-day per-model series. Otherwise emit one
      // column per model with that day's slice of cost.
      const modelList = costsData?.by_model ?? [];
      setStackedCost(
        buildStackedCost(
          costsData?.by_day ?? [],
          modelList,
          costs.isSynthetic || !costsData?.by_day?.length
        )
      );
      setCacheByDay(cacheData?.by_day ?? []);
      setSavingsByDay(savingsData?.by_day ?? []);
      setBudget(budData ?? null);
      setCostPerTrace(cptData?.points ?? []);
      setIsSynthetic(
        costs.isSynthetic || cache.isSynthetic || savings.isSynthetic || cpt.isSynthetic
      );
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentOrg, days]);

  // Cost by model totals for the KPI strip
  const totals = useMemo(() => {
    const totalCost = costByModel.reduce((s, d) => s + d.cost_usd, 0);
    const totalRequests = costByModel.reduce((s, d) => s + d.requests, 0);
    const totalTokens = costByModel.reduce((s, d) => s + d.tokens, 0);
    const totalCacheHits = cacheByDay.reduce((s, d) => s + d.cache_hits, 0);
    const totalCacheMisses = cacheByDay.reduce((s, d) => s + d.cache_misses, 0);
    const hitRate =
      totalCacheHits + totalCacheMisses > 0
        ? (totalCacheHits / (totalCacheHits + totalCacheMisses)) * 100
        : 0;
    const totalSaved = cacheByDay.reduce((s, d) => s + d.cost_saved_usd, 0);
    return { totalCost, totalRequests, totalTokens, hitRate, totalSaved, totalCacheHits, totalCacheMisses };
  }, [costByModel, cacheByDay]);

  if (!currentOrg) {
    return (
      <div className="p-8 text-center text-sm text-[var(--text-muted)]">
        Select an organization to view optimization data.
      </div>
    );
  }

  return (
    <div className="page-enter mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)] sm:text-3xl">
            Cost & usage optimization
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Where your tokens go, what caching saves, and how the budget is burning.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSynthetic && <SyntheticBadge reason="Backend /optimization/* routes not yet implemented" />}
          <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5 shadow-sm">
            {DAY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDays(opt.value)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                  days === opt.value
                    ? "bg-[var(--accent)] text-white shadow-sm"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Total spend"
          value={formatCurrency(totals.totalCost, { compact: true })}
          sublabel={`${days} day window`}
          icon={Wallet}
          iconColor="bg-[var(--accent-light)] text-[var(--accent)]"
        />
        <KpiCard
          label="Cache hit rate"
          value={formatPercent(totals.hitRate, 1)}
          sublabel={`${formatCompact(totals.hitRate > 0 ? totals.totalCacheHits : 0)} hits / ${formatCompact(
            totals.totalCacheMisses
          )} misses`}
          icon={Sparkles}
          iconColor="bg-[var(--primary-light)] text-[var(--primary)]"
        />
        <KpiCard
          label="Tokens processed"
          value={formatTokens(totals.totalTokens)}
          sublabel={`${formatCompact(totals.totalRequests)} requests`}
          icon={BarChart3}
          iconColor="bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        />
        <KpiCard
          label="Cache savings"
          value={formatCurrency(totals.totalSaved, { compact: true })}
          sublabel="From prompt + semantic cache"
          icon={TrendingDown}
          iconColor="bg-[var(--success-bg)] text-[var(--success-strong)]"
        />
      </div>

      {/* Row 1: cost-by-model donut + stacked area */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {loading ? (
          <ChartSkeleton />
        ) : (
          <CostByModelDonut data={costByModel} />
        )}
        {loading ? (
          <ChartSkeleton />
        ) : (
          <CostByModelStackedArea data={stackedCost} models={costByModel.map((c) => c.model)} />
        )}
      </div>

      {/* Row 2: cache savings + budget gauge */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {loading ? (
          <ChartSkeleton wide />
        ) : (
          <div className="lg:col-span-2">
            <CacheSavingsChart data={cacheByDay} />
          </div>
        )}
        {loading || !budget ? (
          <ChartSkeleton />
        ) : (
          <BudgetGauge budget={budget} />
        )}
      </div>

      {/* Row 3: cost per trace + savings line */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {loading ? (
          <ChartSkeleton />
        ) : (
          <CostPerTraceScatter data={costPerTrace} />
        )}
        {loading ? (
          <ChartSkeleton />
        ) : (
          <SavingsLineChart data={savingsByDay} />
        )}
      </div>

      {isSynthetic && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-3 text-xs text-[var(--text-muted)]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--warning)]" />
          <p>
            Showing synthetic data because the server does not yet implement{" "}
            <code className="font-mono text-[var(--text-secondary)]">/orgs/&#123;id&#125;/optimization/*</code>{" "}
            routes. Replace{" "}
            <code className="font-mono text-[var(--text-secondary)]">
              fetchWithFallback(&#123; fetcher, fallback &#125;)
            </code>{" "}
            with the real API call once the backend ships.
          </p>
        </div>
      )}
    </div>
  );
}

/* ----------------------- Internal helpers ---------------------------- */

interface StackedRow {
  date: string;
  [model: string]: number | string;
}

function buildStackedCost(
  byDay: Array<{ date: string; cost_usd: number }>,
  byModel: Array<{ model: string; cost_usd: number }>,
  forceSynthetic: boolean
): StackedRow[] {
  if (byDay.length === 0 || byModel.length === 0) return [];
  const modelNames = byModel.map((m) => m.model);
  const modelShares = byModel.map((m) =>
    m.cost_usd / Math.max(1e-9, byModel.reduce((s, x) => s + x.cost_usd, 0))
  );

  // Hash the date so the per-day allocation varies deterministically.
  const dateSeed = (d: string) => {
    let h = 0;
    for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const jitter = (d: string, i: number) => {
    const x = Math.sin(dateSeed(d) * 9301 + i * 49297) * 233280;
    return x - Math.floor(x);
  };

  return byDay.map((row) => {
    const out: StackedRow = { date: row.date };
    // If we're in synthetic mode, generate per-day per-model by allocating
    // each day's total across models with a stable jitter so the chart
    // looks like real data. If real data, distribute the day's total
    // proportionally to each model's overall share.
    modelNames.forEach((m, i) => {
      const share = forceSynthetic
        ? // 0.4 to 1.6 of the model's overall share
          modelShares[i] * (0.4 + jitter(row.date, i) * 1.2)
        : modelShares[i];
      out[m] = Math.max(0, Math.round(row.cost_usd * share * 100) / 100);
    });
    return out;
  });
}

function ChartSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div
      className={cn(
        "flex h-[300px] items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)]",
        wide && "lg:col-span-2"
      )}
    >
      <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}
