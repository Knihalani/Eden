"use client";

/**
 * StreamingMetricsCard — three stat cards showing streaming
 * performance: TTFT, ITL, TPOT.
 *
 * Phase 7.2 (C4): rendered on the dashboard and the observability
 * page. Each card has a sparkline of the last 24h of samples so
 * a regression is visible at a glance.
 *
 * TTFT (Time To First Token): how long the user waited before any
 * output. Lower is better.
 *
 * ITL (Inter-Token Latency): average ms between consecutive tokens.
 * Lower is better.
 *
 * TPOT (Time Per Output Token): total time / number of tokens.
 * Lower is better.
 */

import * as React from "react";

interface StreamingMetrics {
  ttft_ms: number | null;
  itl_ms_avg: number | null;
  tpot_ms: number | null;
}

interface StreamingMetricsCardProps {
  metrics: StreamingMetrics;
  samples24h?: Array<{ hour: string; ttft_ms?: number; itl_ms?: number; tpot_ms?: number }>;
  className?: string;
}

function Sparkline({
  values,
  color = "var(--terminal)",
}: {
  values: number[];
  color?: string;
}) {
  if (values.length < 2) {
    return <div className="h-6 w-20" />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 80;
      const y = 24 - ((v - min) / range) * 24;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg width="80" height="24" className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 10) return value.toFixed(1);
  if (value < 100) return value.toFixed(0);
  if (value < 1000) return Math.round(value).toString();
  return `${(value / 1000).toFixed(1)}s`;
}

export function StreamingMetricsCard({
  metrics,
  samples24h = [],
  className = "",
}: StreamingMetricsCardProps) {
  const ttftSeries = samples24h.map((s) => s.ttft_ms ?? 0).filter((v) => v > 0);
  const itlSeries = samples24h.map((s) => s.itl_ms ?? 0).filter((v) => v > 0);
  const tpotSeries = samples24h.map((s) => s.tpot_ms ?? 0).filter((v) => v > 0);

  return (
    <div className={`grid grid-cols-1 md:grid-cols-3 gap-3 ${className}`}>
      <Stat
        label="TTFT"
        value={formatMs(metrics.ttft_ms)}
        unit="ms"
        sub="Time to first token"
        sparkline={ttftSeries}
        color="var(--terminal)"
      />
      <Stat
        label="ITL"
        value={formatMs(metrics.itl_ms_avg)}
        unit="ms"
        sub="Inter-token latency (avg)"
        sparkline={itlSeries}
        color="var(--accent)"
      />
      <Stat
        label="TPOT"
        value={formatMs(metrics.tpot_ms)}
        unit="ms"
        sub="Time per output token"
        sparkline={tpotSeries}
        color="var(--cat-warning-fg)"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  sub,
  sparkline,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  sub: string;
  sparkline: number[];
  color: string;
}) {
  return (
    <div
      className="rounded-md border p-3 transition-colors"
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border-default)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
          {label}
        </span>
        <Sparkline values={sparkline} color={color} />
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-mono tabular-nums" style={{ color }}>
          {value}
        </span>
        <span className="text-xs text-[var(--text-muted)]">{unit}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">{sub}</div>
    </div>
  );
}
