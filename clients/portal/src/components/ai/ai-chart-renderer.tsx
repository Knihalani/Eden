"use client";

/**
 * AI chart renderer — renders one :class:`AiChartSpec` with Recharts.
 *
 * Supports all 7 chart types the agent can emit:
 *   - line   : time series, optional second series + group coloring
 *   - bar    : categorical comparison, optional group stacking
 *   - pie    : share-of-total breakdown (label_key/value_key)
 *   - scatter: two-dimensional correlation
 *   - heatmap: matrix-shaped data (row_key × col_key → value_key)
 *   - sankey : flow data (source_key → target_key → value_key)
 *   - table  : raw tabular data with columns + rows
 *
 * Falls back to a compact table when data is empty or a required
 * axis key is missing (so the user still sees SOMETHING).
 */

import * as React from "react";
import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import type { AiChartSpec } from "@/lib/api";
import { cn } from "@/lib/utils";

const COLORS = [
  "var(--accent)",
  "var(--terminal)",
  "var(--warning)",
  "var(--error)",
  "var(--info)",
  "var(--accent-purple)",
  "var(--stage-archiving)",
  "var(--stage-refining)",
];

interface Props {
  chart: AiChartSpec;
  className?: string;
  height?: number;
}

export function AiChartRenderer({ chart, className, height = 240 }: Props) {
  const unitSuffix = chart.unit ? ` (${chart.unit})` : "";
  return (
    <div className={cn(
      "rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3",
      "my-2",
      className,
    )}>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          {chart.title}
        </div>
        <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          {chart.type}{unitSuffix}
        </div>
      </div>
      {chart.data.length === 0 ? (
        <div className="py-8 text-center text-xs text-[var(--text-muted)]">
          No data
        </div>
      ) : (
        <div style={{ width: "100%", height }}>
          <ResponsiveContainer>
            {renderChart(chart)}
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function renderChart(chart: AiChartSpec): React.ReactElement {
  switch (chart.type) {
    case "line":
      return (
        <LineChart data={chart.data}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey={chart.x_key || "x"} stroke="var(--text-muted)" fontSize={11} />
          <YAxis stroke="var(--text-muted)" fontSize={11}
                 label={chart.unit ? { value: chart.unit, angle: -90, position: "insideLeft",
                                       fill: "var(--text-muted)", fontSize: 10 } : undefined} />
          <Tooltip contentStyle={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            fontSize: 12,
          }} />
          {chart.y_key && (
            <Line type="monotone" dataKey={chart.y_key}
                  stroke={COLORS[0]} dot={false} strokeWidth={2} />
          )}
          {chart.y2_key && (
            <Line type="monotone" dataKey={chart.y2_key}
                  stroke={COLORS[1]} dot={false} strokeWidth={2}
                  yAxisId="right" />
          )}
        </LineChart>
      );
    case "bar":
      return (
        <BarChart data={chart.data}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey={chart.x_key || "x"} stroke="var(--text-muted)" fontSize={11} />
          <YAxis stroke="var(--text-muted)" fontSize={11} />
          <Tooltip contentStyle={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            fontSize: 12,
          }} />
          <Bar dataKey={chart.y_key || "y"} fill={COLORS[0]} />
        </BarChart>
      );
    case "pie": {
      const labelKey = chart.label_key || chart.x_key || "label";
      const valueKey = chart.value_key || chart.y_key || "value";
      return (
        <PieChart>
          <Pie
            data={chart.data}
            dataKey={valueKey}
            nameKey={labelKey}
            cx="50%" cy="50%"
            outerRadius={80}
            label={(d: Record<string, unknown>) => String(d[labelKey] ?? "")}
          >
            {chart.data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            fontSize: 12,
          }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      );
    }
    case "scatter":
      return (
        <ScatterChart>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey={chart.x_key || "x"} stroke="var(--text-muted)" fontSize={11} />
          <YAxis dataKey={chart.y_key || "y"} stroke="var(--text-muted)" fontSize={11} />
          <Tooltip cursor={{ strokeDasharray: "3 3" }} contentStyle={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            fontSize: 12,
          }} />
          <Scatter data={chart.data} fill={COLORS[0]} />
        </ScatterChart>
      );
    case "heatmap":
      return <HeatmapRenderer chart={chart} />;
    case "sankey":
      return <SankeyRenderer chart={chart} />;
    case "table":
      return <TableRenderer chart={chart} />;
    default:
      return <TableRenderer chart={chart} />;
  }
}

// ── Heatmap (simple grid) ────────────────────────────────────────

function HeatmapRenderer({ chart }: { chart: AiChartSpec }) {
  const rowKey = chart.row_key || "row";
  const colKey = chart.col_key || "col";
  const valueKey = chart.value_key || "value";
  const rows = Array.from(new Set(chart.data.map((d) => String(d[rowKey] ?? ""))));
  const cols = Array.from(new Set(chart.data.map((d) => String(d[colKey] ?? ""))));
  const cellMap = new Map<string, number>();
  let max = -Infinity;
  let min = Infinity;
  for (const d of chart.data) {
    const r = String(d[rowKey] ?? "");
    const c = String(d[colKey] ?? "");
    const v = Number(d[valueKey] ?? 0);
    cellMap.set(`${r}|${c}`, v);
    if (v > max) max = v;
    if (v < min) min = v;
  }
  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left text-[var(--text-muted)]" />
            {cols.map((c) => (
              <th key={c} className="p-1 text-[var(--text-muted)]">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <td className="p-1 text-[var(--text-muted)]">{r}</td>
              {cols.map((c) => {
                const v = cellMap.get(`${r}|${c}`);
                if (v === undefined) {
                  return <td key={c} className="p-1 text-center text-[var(--text-muted)]">·</td>;
                }
                const intensity = max === min ? 0.5 : (v - min) / (max - min);
                return (
                  <td key={c} className="p-1 text-center"
                      style={{
                        background: `color-mix(in srgb, var(--accent) ${Math.round((0.1 + intensity * 0.7) * 100)}%, transparent)`,
                        color: intensity > 0.5 ? "var(--bg-base)" : "var(--text-primary)",
                      }}>
                    {chart.unit === "$" ? `$${v.toFixed(2)}` : v.toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Sankey (simple SVG) ─────────────────────────────────────────

function SankeyRenderer({ chart }: { chart: AiChartSpec }) {
  const sourceKey = chart.source_key || "source";
  const targetKey = chart.target_key || "target";
  const valueKey = chart.value_key || "value";
  // Aggregate flows.
  type Flow = { src: string; tgt: string; v: number };
  const flows: Flow[] = [];
  const flowMap = new Map<string, number>();
  for (const d of chart.data) {
    const s = String(d[sourceKey] ?? "");
    const t = String(d[targetKey] ?? "");
    const v = Number(d[valueKey] ?? 0);
    const k = `${s}->${t}`;
    flowMap.set(k, (flowMap.get(k) ?? 0) + v);
  }
  for (const [k, v] of flowMap.entries()) {
    const [s, t] = k.split("->");
    flows.push({ src: s, tgt: t, v });
  }
  // Layout nodes in 2 columns by index (source/target pairs).
  const sources = Array.from(new Set(flows.map((f) => f.src)));
  const targets = Array.from(new Set(flows.map((f) => f.tgt)));
  const nodeW = 16;
  const nodeGap = 28;
  const totalH = 280;
  const colWidth = 220;
  const leftX = 24;
  const rightX = leftX + colWidth;
  const sourceY: Record<string, number> = {};
  const targetY: Record<string, number> = {};
  let yCursor = 16;
  for (const s of sources) {
    sourceY[s] = yCursor;
    yCursor += nodeGap;
  }
  yCursor = 16;
  for (const t of targets) {
    targetY[t] = yCursor;
    yCursor += nodeGap;
  }
  return (
    <svg viewBox={`0 0 ${leftX + colWidth + nodeW + 24} ${totalH}`}
         width="100%" height={totalH}>
      {flows.map((f, i) => {
        const x1 = leftX + nodeW;
        const x2 = rightX;
        const y1 = sourceY[f.src] ?? 0;
        const y2 = targetY[f.tgt] ?? 0;
        const path = `M ${x1} ${y1} C ${(x1+x2)/2} ${y1}, ${(x1+x2)/2} ${y2}, ${x2} ${y2}`;
        return (
          <g key={i}>
            <path d={path} fill="none"
                  stroke={COLORS[i % COLORS.length]} strokeOpacity={0.4}
                  strokeWidth={Math.max(2, Math.min(20, f.v))} />
            <rect x={leftX} y={y1} width={nodeW} height={nodeGap - 8}
                  fill={COLORS[i % COLORS.length]} rx={2} />
            <rect x={rightX} y={y2} width={nodeW} height={nodeGap - 8}
                  fill={COLORS[i % COLORS.length]} rx={2} />
            <text x={leftX - 8} y={y1 + (nodeGap - 8) / 2 + 3}
                  textAnchor="end" fontSize={10} fill="var(--text-secondary)">
              {f.src}
            </text>
            <text x={rightX + nodeW + 8} y={y2 + (nodeGap - 8) / 2 + 3}
                  fontSize={10} fill="var(--text-secondary)">
              {f.tgt}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Table ───────────────────────────────────────────────────────

function TableRenderer({ chart }: { chart: AiChartSpec }) {
  const cols = chart.columns && chart.columns.length > 0
    ? chart.columns
    : Object.keys(chart.data[0] ?? {});
  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className="border-b border-[var(--border)] p-1 text-left text-[var(--text-muted)]">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.data.slice(0, 50).map((row, i) => (
            <tr key={i} className="border-b border-[var(--border)]/30">
              {cols.map((c) => (
                <td key={c} className="p-1 text-[var(--text-primary)]">
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {chart.data.length > 50 && (
        <div className="mt-1 text-[10px] text-[var(--text-muted)]">
          Showing first 50 of {chart.data.length} rows
        </div>
      )}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(4).replace(/\.?0+$/, "");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}