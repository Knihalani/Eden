"use client";

/**
 * Recharts island for the agent Quality tab — code-split off the tab
 * shell (same pattern as gateway-charts.tsx) so /agents first paint
 * does not pull the vendor chart graph.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { QualityTrendPoint } from "@/lib/api/resources";

const CHART_MOTION_MS = 180;

const tipStyle = {
  background: "var(--bg)",
  border: "1px solid var(--line)",
  borderRadius: 0,
  fontSize: 12,
};

function hourLabel(hour: string | null): string {
  if (!hour) return "";
  const d = new Date(hour);
  if (Number.isNaN(d.getTime())) return hour;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}h`;
}

export function AgentQualityTrendChart({
  trend,
}: {
  trend: QualityTrendPoint[];
}) {
  const data = trend.map((p) => ({
    ...p,
    label: hourLabel(p.hour),
  }));

  return (
    <div className="border border-[var(--line)] bg-[var(--bg)] px-2 py-3 sm:px-3">
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
            axisLine={{ stroke: "var(--line)" }}
            tickLine={false}
          />
          <YAxis
            domain={[0, 1]}
            tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => Number(v).toFixed(1)}
            width={36}
          />
          <Tooltip
            contentStyle={tipStyle}
            formatter={(v, name) => {
              const n = Number(v ?? 0);
              if (String(name) === "Fail rate") return `${(n * 100).toFixed(0)}%`;
              return n.toFixed(2);
            }}
            labelFormatter={(_, payload) =>
              String(payload?.[0]?.payload?.hour ?? "")
            }
          />
          <Line
            type="monotone"
            dataKey="avg_score"
            name="Avg score"
            stroke="var(--text)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive
            animationDuration={CHART_MOTION_MS}
            animationEasing="ease-out"
          />
          <Line
            type="monotone"
            dataKey="fail_rate"
            name="Fail rate"
            stroke="var(--error)"
            strokeWidth={1}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive
            animationDuration={CHART_MOTION_MS}
            animationEasing="ease-out"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
