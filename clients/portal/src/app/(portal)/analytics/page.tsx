"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock,
  Coins,
  Zap,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartCard } from "@/components/ui/chart-card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AXIS_TICK_PROPS,
  CHART_COLORS,
  TOOLTIP_STYLE,
  formatChartDate,
  formatCompact,
  formatHour,
  formatLatency,
  formatPercent,
  formatTokens,
} from "../_lib/chart-utils";

/* ------------------------- Synthetic badge ----------------------------- */

// (Removed in Phase B.1: backend /analytics/* sub-routes are now
// implemented (Phase A.1). The portal calls the real API directly
// and renders real data — no synthetic fallback needed. The badge
// import below is kept for legacy callers but is no longer used.)

/* ------------------------- KPI strip ---------------------------------- */

interface KpiProps {
  label: string;
  value: string;
  sublabel?: string;
  icon: typeof Coins;
  iconColor: string;
  trend?: string;
  trendDir?: "up" | "down" | "neutral";
}

function Kpi({ label, value, sublabel, icon: Icon, iconColor, trend, trendDir }: KpiProps) {
  return (
    <div
      className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 shadow-sm transition-all duration-200 hover:shadow-md"
      aria-label={`${label}: ${value}`}
    >
      <div className="mb-2 flex items-start justify-between">
        <div className={cn("rounded-lg p-2", iconColor)}>
          <Icon className="h-4 w-4" aria-hidden />
        </div>
        {trend && (
          <span
            className={cn(
              "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium",
              trendDir === "up" && "text-[var(--terminal)] bg-[var(--terminal-faint)]",
              trendDir === "down" && "text-[var(--error)] bg-[var(--error-dim)]",
              trendDir === "neutral" && "text-[var(--text-muted)] bg-[var(--bg-tertiary)]"
            )}
          >
            {trendDir === "up" ? (
              <ArrowUpRight className="h-3 w-3" aria-hidden />
            ) : trendDir === "down" ? (
              <ArrowDownRight className="h-3 w-3" aria-hidden />
            ) : null}
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

/* --------------------- Input vs output tokens ------------------------- */

function TokenUsageChart({
  data,
}: {
  data: Array<{ date: string; input_tokens: number; output_tokens: number }>;
}) {
  return (
    <ChartCard
      title="Token usage trends"
      description="Input vs output tokens by day, last 30 days"
      height={300}
      isEmpty={data.length === 0}
    >
      <MultiLineChart
        data={data}
        series={[
          { key: "input_tokens", label: "Input", color: CHART_COLORS.primary },
          { key: "output_tokens", label: "Output", color: CHART_COLORS.accent },
        ]}
        valueFormatter={(v) => formatTokens(v)}
        labelFormatter={formatChartDate}
      />
    </ChartCard>
  );
}

/* Reusable multi-line chart so token usage + others share styling. */

interface SeriesSpec {
  key: string;
  label: string;
  color: string;
  fillOpacity?: number;
  dashed?: boolean;
}

function MultiLineChart({
  data,
  series,
  valueFormatter,
  labelFormatter,
}: {
  data: Array<Record<string, number | string>>;
  series: SeriesSpec[];
  valueFormatter: (v: number) => string;
  labelFormatter: (v: string) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={labelFormatter}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={{ stroke: "var(--border-subtle)" }}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={valueFormatter}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(label) => labelFormatter(String(label))}
          formatter={(value: number) => [valueFormatter(value), undefined]}
        />
        {series.length > 1 && (
          <Legend
            iconType="circle"
            wrapperStyle={{ fontSize: 11, color: "var(--text-muted)", paddingTop: 8 }}
          />
        )}
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: s.color }}
            strokeDasharray={s.dashed ? "4 4" : undefined}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* -------------------- Latency p50/p95/p99 over time ------------------- */

function LatencyChart({
  data,
}: {
  data: Array<{ date: string; p50_ms: number; p95_ms: number; p99_ms: number }>;
}) {
  return (
    <ChartCard
      title="Latency percentiles"
      description="p50, p95, p99 over time"
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
          tickFormatter={(v) => formatLatency(v)}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(label) => formatChartDate(String(label))}
          formatter={(value: number) => [formatLatency(value), undefined]}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: "var(--text-muted)", paddingTop: 8 }}
        />
        <Line
          type="monotone"
          dataKey="p50_ms"
          name="p50"
          stroke="var(--accent)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="p95_ms"
          name="p95"
          stroke="var(--warning)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="p99_ms"
          name="p99"
          stroke="var(--error)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartCard>
  );
}

/* ------------------- Throughput heatmap (bar variant) ----------------- */

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ThroughputHeatmap({
  data,
}: {
  data: Array<{ hour: number; weekday: number; requests: number }>;
}) {
  // Pivot to one row per weekday with 24 hour columns. Build a Map once so
  // cell lookup is O(1) per slot instead of an O(N) Array.find inside the
  // 7×24 grid render (previous version did 28k comparisons on a 168-row
  // dataset).
  const rows = useMemo(() => {
    const index = new Map<string, number>();
    for (const d of data) index.set(`${d.weekday}:${d.hour}`, d.requests);
    const out: Array<Record<string, number | string>> = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const row: Record<string, number | string> = { weekday: WEEKDAY_LABELS[weekday] };
      for (let hour = 0; hour < 24; hour++) {
        row[`h${hour}`] = index.get(`${weekday}:${hour}`) ?? 0;
      }
      out.push(row);
    }
    return out;
  }, [data]);

  const max = useMemo(
    () => Math.max(1, ...data.map((d) => d.requests)),
    [data]
  );

  return (
    <ChartCard
      title="Throughput by hour of day"
      description="Request volume · darker accent = more traffic"
      height={300}
      isEmpty={data.length === 0}
    >
      <div className="flex h-full flex-col">
        <div className="flex-1 overflow-x-auto">
          <DataTable
            columns={[
              {
                key: "weekday",
                header: "Day",
                cell: (r) => <span className="font-medium text-[var(--text-muted)]">{String(r.weekday)}</span>,
              },
              ...Array.from({ length: 24 }).map<DataTableColumn<Record<string, number | string>>>((_, h) => ({
                key: `h${h}`,
                header: h % 3 === 0 ? formatHour(h).replace(/(am|pm)/, "") : "",
                align: "center",
                headerClassName: "font-normal text-[var(--text-muted)]",
                cell: (r) => {
                  const v = (r[`h${h}`] as number) ?? 0;
                  // Theme-aligned: cells use the accent color with varying
                  // alpha. We build a per-intensity color so the lowest
                  // values are still visible against the dark surface.
                  const intensity = 0.08 + (v / max) * 0.85;
                  return (
                    <div
                      className="h-5 min-w-[18px] rounded-sm transition-all hover:ring-1 hover:ring-[var(--accent)]"
                      style={{ backgroundColor: `var(--accent)`, opacity: intensity }}
                      title={`${r.weekday} ${formatHour(h)} · ${v} req`}
                      aria-label={`${r.weekday} ${formatHour(h)}: ${v} requests`}
                    />
                  );
                },
              })),
            ]}
            rows={rows}
            rowKey={(r) => String(r.weekday)}
            pageSize={10}
          />
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-[var(--text-muted)]">
          <span>Low</span>
          <div className="flex h-2 w-32 overflow-hidden rounded">
            {Array.from({ length: 16 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 bg-[var(--accent)]"
                style={{ opacity: 0.08 + (i / 15) * 0.85 }}
              />
            ))}
          </div>
          <span>High</span>
        </div>
      </div>
    </ChartCard>
  );
}

/* ------------------------- Top agents by cost ------------------------- */

function TopAgentsChart({
  data,
}: {
  data: Array<{
    agent: string;
    cost_usd: number;
    requests: number;
    avg_latency_ms: number;
  }>;
}) {
  return (
    <ChartCard
      title="Top agents by cost"
      description="All-time cumulative across tracked agents"
      height={300}
      isEmpty={data.length === 0}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(v) => formatCompact(v)}
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="agent"
          tick={AXIS_TICK_PROPS}
          tickLine={false}
          axisLine={false}
          width={90}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          // Recharts passes the full item as 3rd arg; payload may be undefined.
          formatter={(value, _name, item) => {
            const payload = (item as { payload?: { requests?: number; avg_latency_ms?: number } })
              ?.payload;
            return [
              <span key="cost">
                <strong>${Number(value).toFixed(2)}</strong>
                <span className="ml-2 text-[var(--text-muted)]">
                  {formatCompact(payload?.requests ?? 0)} req ·{" "}
                  {formatLatency(payload?.avg_latency_ms ?? 0)}
                </span>
              </span>,
              "Cost",
            ];
          }}
        />
        <Bar dataKey="cost_usd" radius={[0, 4, 4, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS.series[i % CHART_COLORS.series.length]} />
          ))}
        </Bar>
      </BarChart>
    </ChartCard>
  );
}

/* ----------------------------- Page ---------------------------------- */

const DAY_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
] as const;

export default function AnalyticsPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);

  const [tokenByDay, setTokenByDay] = useState<
    Array<{ date: string; input_tokens: number; output_tokens: number }>
  >([]);
  const [latencyByDay, setLatencyByDay] = useState<
    Array<{ date: string; p50_ms: number; p95_ms: number; p99_ms: number }>
  >([]);
  const [throughput, setThroughput] = useState<
    Array<{ hour: number; weekday: number; requests: number }>
  >([]);
  const [topAgents, setTopAgents] = useState<
    Array<{ agent: string; cost_usd: number; requests: number; avg_latency_ms: number }>
  >([]);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    const orgId = currentOrg.id;
    // Defer the loading-state update so it isn't called synchronously
    // within the effect body (avoids cascading-render lint warning).
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
    });
    // Phase B.1: removed fetchWithFallback + makeSynthetic* — the
    // /analytics/* sub-routes (Phase A.1) return real data now.
    Promise.all([
      api.getTokenUsage(orgId, days),
      api.getLatencyPercentiles(orgId, days),
      api.getThroughputByHour(orgId, days),
      api.getTopAgentsByCost(orgId, days),
    ]).then(([tokens, lat, tp, ag]) => {
      if (cancelled) return;
      setTokenByDay(tokens?.by_day ?? []);
      setLatencyByDay(lat?.by_day ?? []);
      setThroughput(tp?.by_hour ?? []);
      setTopAgents(ag?.agents ?? []);
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      // On error, surface as empty data so the user sees the real
      // empty state (with the existing empty-state UI) rather than
      // a broken chart. Notify the user via toast.
      const message = e instanceof Error ? e.message : "Failed to load analytics";
      setTokenByDay([]);
      setLatencyByDay([]);
      setThroughput([]);
      setTopAgents([]);
      setLoading(false);
      toast.error("Couldn't load analytics", message);
    });
    return () => {
      cancelled = true;
    };
  }, [currentOrg, days, toast]);

  const totals = useMemo(() => {
    const totalIn = tokenByDay.reduce((s, d) => s + d.input_tokens, 0);
    const totalOut = tokenByDay.reduce((s, d) => s + d.output_tokens, 0);
    const req = tokenByDay.reduce((s, d) => s + d.input_tokens + d.output_tokens, 0);
    const latP95 =
      latencyByDay.length > 0
        ? latencyByDay.reduce((s, d) => s + d.p95_ms, 0) / latencyByDay.length
        : 0;
    const latP99 =
      latencyByDay.length > 0
        ? latencyByDay.reduce((s, d) => s + d.p99_ms, 0) / latencyByDay.length
        : 0;
    const tpTotal = throughput.reduce((s, d) => s + d.requests, 0);
    return {
      totalIn,
      totalOut,
      req,
      latP95,
      latP99,
      tpTotal,
    };
  }, [tokenByDay, latencyByDay, throughput]);

  if (!currentOrg) {
    return <NoOrgState feature="Analytics" icon={BarChart3} description="Select an organization to view analytics" />;
  }

  return (
    <div className="page-enter mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader
        eyebrow="Observe"
        title="Analytics"
        subtitle="Token throughput, latency, traffic patterns, and per-agent cost."
        icon={BarChart3}
        actions={
          <div
            role="group"
            aria-label="Date range"
            className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-0.5 shadow-sm"
          >
            {DAY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDays(opt.value)}
                aria-pressed={days === opt.value}
                aria-label={`Last ${opt.label}`}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                  days === opt.value
                    ? "bg-[var(--accent)] text-[var(--bg-base)] shadow-sm"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Total tokens"
          value={formatTokens(totals.totalIn + totals.totalOut)}
          sublabel={`${formatPercent(
            totals.totalIn / Math.max(1, totals.totalIn + totals.totalOut),
            0
          )} input`}
          icon={Coins}
          iconColor="bg-[var(--accent-faint)] text-[var(--accent)]"
        />
        <Kpi
          label="p95 latency"
          value={formatLatency(totals.latP95)}
          sublabel="Average over period"
          icon={Clock}
          iconColor="bg-[var(--warning-bg)] text-[var(--warning)]"
        />
        <Kpi
          label="p99 latency"
          value={formatLatency(totals.latP99)}
          sublabel="Tail latency"
          icon={Zap}
          iconColor="bg-[var(--error-dim)] text-[var(--error)]"
        />
        <Kpi
          label="Total requests"
          value={formatCompact(totals.req)}
          sublabel="Tokens in + out"
          icon={BarChart3}
          iconColor="bg-[var(--terminal-faint)] text-[var(--terminal)]"
        />
      </div>

      {/* Row 1: token usage + latency */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {loading ? (
          <>
            <ChartSkeleton />
            <ChartSkeleton />
          </>
        ) : (
          <>
            <TokenUsageChart data={tokenByDay} />
            <LatencyChart data={latencyByDay} />
          </>
        )}
      </div>

      {/* Row 2: throughput heatmap + top agents */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {loading ? (
          <>
            <ChartSkeleton />
            <ChartSkeleton />
          </>
        ) : (
          <>
            <ThroughputHeatmap data={throughput} />
            <TopAgentsChart data={topAgents} />
          </>
        )}
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div
      className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-5 space-y-3"
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
