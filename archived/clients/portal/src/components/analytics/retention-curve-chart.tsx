"use client";

/**
 * Retention-curve recharts island (FEAT-139).
 *
 * Kept in its own file so the sessions hub can dynamically import it —
 * same code-split pattern as gateway-charts.tsx / agent-quality-trend.tsx
 * so first paint does not pull the ~370KB recharts vendor chunk.
 */

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CohortRetentionRow } from "@/lib/api/resources";
import { getStorageColorsResolved } from "@/lib/chart-colors";

export type { CohortRetentionRow };

const CHART_MOTION_MS = 180;

const tipStyle = {
  background: "var(--bg)",
  border: "1px solid var(--line)",
  borderRadius: 0,
  fontSize: 12,
};

/** Pure transform — exported for focused unit tests without mounting recharts. */
export function buildRetentionChartData(
  cohorts: CohortRetentionRow[],
): Array<Record<string, number | string>> {
  const weekKeys = new Set<number>();
  for (const c of cohorts) {
    for (const k of Object.keys(c.retention)) {
      const n = Number(k);
      if (Number.isFinite(n)) weekKeys.add(n);
    }
  }
  const weeks = [...weekKeys].sort((a, b) => a - b);
  return weeks.map((w) => {
    const row: Record<string, number | string> = { week: `W${w}` };
    for (const c of cohorts) {
      row[c.cohort] = (c.retention[String(w)] ?? 0) * 100;
    }
    return row;
  });
}

export function RetentionCurveChart({
  cohorts,
}: {
  cohorts: CohortRetentionRow[];
}) {
  const data = buildRetentionChartData(cohorts);
  const colors = getStorageColorsResolved();

  if (cohorts.length === 0 || data.length === 0) {
    return null;
  }

  return (
    <div
      className="border border-[var(--line)] bg-[var(--bg)] px-2 py-3 sm:px-3"
      data-testid="retention-curve-chart"
    >
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
          <XAxis
            dataKey="week"
            tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
            axisLine={{ stroke: "var(--line)" }}
            tickLine={false}
          />
          <YAxis
            domain={[0, 100]}
            unit="%"
            tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            contentStyle={tipStyle}
            formatter={(v) => `${Number(v ?? 0).toFixed(1)}%`}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {cohorts.map((c, i) => (
            <Line
              key={c.cohort}
              type="monotone"
              dataKey={c.cohort}
              name={`${c.cohort} (n=${c.size})`}
              stroke={colors[i % colors.length]}
              strokeWidth={2}
              dot={false}
              isAnimationActive
              animationDuration={CHART_MOTION_MS}
              animationEasing="ease-out"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
