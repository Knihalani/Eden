"use client";

import { useMemo } from "react";
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
import {
  AXIS_TICK_PROPS,
  CHART_COLORS,
  TOOLTIP_STYLE,
  formatChartDate,
  formatCompact,
  formatHour,
  formatLatency,
  formatTokens,
} from "../../_lib/chart-utils";

/* --------------------- Input vs output tokens ------------------------- */

export function TokenUsageChart({
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

export function MultiLineChart({
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
  // ui-audit 2026-07-06 M9: announce the chart to AT users.
  const seriesLabels = series.map((s) => s.label).join(", ");
  const ariaLabel = seriesLabels
    ? `Trend chart with: ${seriesLabels}`
    : "Trend chart";
  return (
    <div role="img" aria-label={ariaLabel}>
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
          formatter={(value) => [valueFormatter(Number(value ?? 0)), undefined]}
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
    </div>
  );
}

/* -------------------- Latency p50/p95/p99 over time ------------------- */

export function LatencyChart({
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
      <ResponsiveContainer width="100%" height="100%">
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
            formatter={(value) => [formatLatency(Number(value ?? 0)), undefined]}
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
      </ResponsiveContainer>
    </ChartCard>
  );
}

/* ------------------- Throughput heatmap (bar variant) ----------------- */

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ThroughputHeatmap({
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

export function TopAgentsChart({
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
      <ResponsiveContainer width="100%" height="100%">
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
      </ResponsiveContainer>
    </ChartCard>
  );
}

export interface OverviewChartsProps {
  tokenByDay: Array<{ date: string; input_tokens: number; output_tokens: number }>;
  latencyByDay: Array<{ date: string; p50_ms: number; p95_ms: number; p99_ms: number }>;
  throughput: Array<{ hour: number; weekday: number; requests: number }>;
  topAgents: Array<{
    agent: string;
    cost_usd: number;
    requests: number;
    avg_latency_ms: number;
  }>;
}

export default function OverviewCharts({
  tokenByDay,
  latencyByDay,
  throughput,
  topAgents,
}: OverviewChartsProps) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TokenUsageChart data={tokenByDay} />
        <LatencyChart data={latencyByDay} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ThroughputHeatmap data={throughput} />
        <TopAgentsChart data={topAgents} />
      </div>
    </>
  );
}

