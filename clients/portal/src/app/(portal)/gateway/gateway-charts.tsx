"use client";

/**
 * Recharts islands for Gateway — code-split off the KPI strip so first
 * paint does not pull the vendor chart graph (~370KB).
 */

import { useRef, type ReactNode, type RefObject } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { downloadCsv, downloadPng } from "@/lib/export";

const CHART_COLORS = [
  "var(--chart-pie-1)",
  "var(--chart-pie-2)",
  "var(--chart-pie-3)",
  "var(--chart-pie-4)",
  "var(--chart-pie-5)",
  "var(--text-secondary)",
];

/** Purposeful ease-out only — no long continuous chart motion. */
const CHART_MOTION_MS = 180;

const tipStyle = {
  background: "var(--bg)",
  border: "1px solid var(--line)",
  borderRadius: 0,
  fontSize: 12,
};

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) < 0.01 && v !== 0) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function formatTokens(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

export type GatewaySeriesPoint = {
  day: string;
  label: string;
  cost_usd: number | null;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
};

export type GatewayBreakdownRow = {
  key: string;
  cost_usd: number | null;
  events: number;
  tokens: number;
};

function ChartCard({
  title,
  hint,
  children,
  onExportCsv,
  onExportPng,
  chartRef,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  onExportCsv?: () => void;
  onExportPng?: () => void;
  chartRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h2 className="type-ui">{title}</h2>
          {hint ? <p className="type-meta mt-0.5">{hint}</p> : null}
        </div>
        <div className="flex gap-1">
          {onExportCsv ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm !rounded-none"
              onClick={onExportCsv}
            >
              CSV
            </button>
          ) : null}
          {onExportPng ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm !rounded-none"
              onClick={onExportPng}
            >
              PNG
            </button>
          ) : null}
        </div>
      </div>
      <div
        ref={chartRef}
        className="border border-[var(--line)] bg-[var(--bg)] px-2 py-3 sm:px-3"
      >
        {children}
      </div>
    </section>
  );
}

async function exportPng(
  ref: RefObject<HTMLDivElement | null>,
  name: string,
  windowLabel: string,
) {
  if (!ref.current) return;
  const bg =
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#000000";
  await downloadPng(`eden-gateway-${name}-${windowLabel}.png`, ref.current, {
    backgroundColor: bg,
  });
}

export function GatewaySpendChart({
  series,
  windowLabel,
  emptySlot,
}: {
  series: GatewaySeriesPoint[];
  windowLabel: string;
  emptySlot?: ReactNode;
}) {
  const spendChartRef = useRef<HTMLDivElement>(null);
  return (
    <ChartCard
      title="Spend over time"
      hint="Daily cost from the customer ledger"
      chartRef={spendChartRef}
      onExportCsv={() =>
        downloadCsv(`eden-gateway-spend-${windowLabel}.csv`, series)
      }
      onExportPng={() => void exportPng(spendChartRef, "spend", windowLabel)}
    >
      {series.length === 0 ? (
        (emptySlot ?? (
          <p className="type-meta px-2 py-8 text-center">
            No spend in this window yet.
          </p>
        ))
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
              axisLine={{ stroke: "var(--line)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
              width={44}
            />
            <Tooltip
              contentStyle={tipStyle}
              formatter={(v) => formatUsd(Number(v))}
              labelFormatter={(_, payload) =>
                String(payload?.[0]?.payload?.day ?? "")
              }
            />
            <Area
              type="monotone"
              dataKey="cost_usd"
              name="Spend"
              stroke="var(--text)"
              fill="var(--text)"
              fillOpacity={0.12}
              strokeWidth={1.5}
              isAnimationActive
              animationDuration={CHART_MOTION_MS}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export function GatewayBreakdownCharts({
  series,
  byModel,
  windowLabel,
}: {
  series: GatewaySeriesPoint[];
  byModel: GatewayBreakdownRow[];
  windowLabel: string;
}) {
  const tokenChartRef = useRef<HTMLDivElement>(null);
  const modelChartRef = useRef<HTMLDivElement>(null);
  const pieData = byModel
    .filter((r) => r.cost_usd != null && r.cost_usd > 0)
    .slice(0, 8)
    .map((r) => ({
      name: r.key,
      value: r.cost_usd as number,
    }));

  return (
    <>
      <ChartCard
        title="Tokens over time"
        hint="Input vs output from the same ledger"
        chartRef={tokenChartRef}
        onExportCsv={() =>
          downloadCsv(`eden-gateway-tokens-${windowLabel}.csv`, series)
        }
        onExportPng={() => void exportPng(tokenChartRef, "tokens", windowLabel)}
      >
        {series.length === 0 ? (
          <p className="type-meta px-2 py-8 text-center">
            No token series in this window.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={series}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                axisLine={{ stroke: "var(--line)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => formatTokens(Number(v))}
                width={44}
              />
              <Tooltip
                contentStyle={tipStyle}
                formatter={(v) => formatTokens(Number(v))}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="input_tokens"
                name="Input"
                stackId="t"
                fill="var(--text)"
                isAnimationActive
                animationDuration={CHART_MOTION_MS}
                animationEasing="ease-out"
              />
              <Bar
                dataKey="output_tokens"
                name="Output"
                stackId="t"
                fill="var(--text-secondary)"
                isAnimationActive
                animationDuration={CHART_MOTION_MS}
                animationEasing="ease-out"
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard
        title="Spend by model"
        hint="Top models in this window"
        chartRef={modelChartRef}
        onExportCsv={() =>
          downloadCsv(`eden-gateway-models-${windowLabel}.csv`, byModel)
        }
        onExportPng={() => void exportPng(modelChartRef, "models", windowLabel)}
      >
        {pieData.length === 0 ? (
          <p className="type-meta px-2 py-8 text-center">No model spend yet.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius="48%"
                  outerRadius="72%"
                  paddingAngle={2}
                  stroke="var(--bg)"
                  strokeWidth={2}
                  isAnimationActive
                  animationDuration={CHART_MOTION_MS}
                  animationEasing="ease-out"
                >
                  {pieData.map((_, i) => (
                    <Cell
                      key={pieData[i]?.name ?? i}
                      fill={CHART_COLORS[i % CHART_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={tipStyle}
                  formatter={(v) => formatUsd(Number(v))}
                />
                <Legend
                  verticalAlign="bottom"
                  wrapperStyle={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                data={byModel.slice(0, 8)}
                layout="vertical"
                margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
              >
                <CartesianGrid
                  stroke="var(--line)"
                  strokeDasharray="3 3"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                />
                <YAxis
                  type="category"
                  dataKey="key"
                  width={96}
                  tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={tipStyle}
                  formatter={(v) => formatUsd(Number(v))}
                />
                <Bar
                  dataKey="cost_usd"
                  name="Cost"
                  fill="var(--text)"
                  isAnimationActive
                  animationDuration={CHART_MOTION_MS}
                  animationEasing="ease-out"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>
    </>
  );
}
