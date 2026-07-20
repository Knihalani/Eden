"use client";

/**
 * LatencyHistogram — bucketed histogram of trace durations.
 *
 * Phase 7.2 (C4): renders p50/p95/p99 markers over a logarithmic
 * bucketed histogram. Buckets are computed client-side from a flat
 * list of duration_ms values (no server round trip needed for the
 * bucketing math).
 *
 * Theme: dark terminal — bar fill is the terminal phosphor green
 * for the bucket count, percentile markers are blue accent.
 */

import * as React from "react";

interface LatencyHistogramProps {
  durations: number[];
  height?: number;
  className?: string;
  title?: string;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length))
  );
  return sorted[idx];
}

export function LatencyHistogram({
  durations,
  height = 160,
  className = "",
  title }: LatencyHistogramProps) {
  const sorted = React.useMemo(
    () => durations.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b),
    [durations]
  );

  const { buckets, maxCount, p50, p95, p99, minMs, maxMs } = React.useMemo(() => {
    if (!sorted.length) {
      return {
        buckets: [] as Array<{ x: string; lo: number; hi: number; count: number }>,
        maxCount: 0,
        p50: 0, p95: 0, p99: 0,
        minMs: 0, maxMs: 0 };
    }
    const p50v = percentile(sorted, 50);
    const p95v = percentile(sorted, 95);
    const p99v = percentile(sorted, 99);
    // Log-scale bucketing: 30 buckets between min and max.
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    const logLo = Math.log10(lo);
    const logHi = Math.log10(hi);
    const logSpan = logHi - logLo;
    // Degenerate range (all equal): avoid /0 → NaN bar heights and markers.
    if (!Number.isFinite(logSpan) || logSpan <= 0) {
      return {
        buckets: [
          {
            x: `${Math.round(lo)}ms`,
            lo,
            hi: lo,
            count: sorted.length,
          },
        ],
        maxCount: sorted.length,
        p50: p50v,
        p95: p95v,
        p99: p99v,
        minMs: lo,
        maxMs: hi,
      };
    }
    const nBuckets = 30;
    const width = logSpan / nBuckets;
    const counts = new Array(nBuckets).fill(0);
    for (const v of sorted) {
      const idx = Math.min(
        nBuckets - 1,
        Math.floor((Math.log10(v) - logLo) / width)
      );
      counts[idx]++;
    }
    const buckets = counts.map((count, i) => {
      const bLo = Math.pow(10, logLo + i * width);
      const bHi = Math.pow(10, logLo + (i + 1) * width);
      return {
        x: `${Math.round(bLo)}-${Math.round(bHi)}ms`,
        lo: bLo,
        hi: bHi,
        count };
    });
    return {
      buckets,
      maxCount: Math.max(...counts, 1),
      p50: p50v,
      p95: p95v,
      p99: p99v,
      minMs: lo,
      maxMs: hi };
  }, [sorted]);

  if (!sorted.length) {
    return (
      <div className={className} style={{ height }}>
        <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
          No traces yet
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      {title && (
        <div className="mb-2 flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>{title}</span>
          <span>
            n={sorted.length.toLocaleString()} • {Math.round(minMs)}ms – {Math.round(maxMs)}ms
          </span>
        </div>
      )}
      <div
        className="relative flex items-end gap-[1px]"
        style={{ height }}
      >
        {buckets.map((b, i) => {
          const heightPct = (b.count / maxCount) * 100;
          return (
            <div
              key={b.x ?? i}
              className="flex-1 rounded-t-sm bg-[var(--terminal)]/60 hover:bg-[var(--terminal)] transition-[height,background-color] duration-300"
              style={{ height: `${heightPct}%` }}
              title={`${b.x}: ${b.count} traces`}
            />
          );
        })}
        {/* p50 / p95 / p99 markers */}
        {p50 > 0 && (
          <PercentileMarker
            value={p50}
            label="p50"
            color="var(--terminal)"
            maxMs={maxMs}
            minMs={minMs}
            height={height}
          />
        )}
        {p95 > 0 && (
          <PercentileMarker
            value={p95}
            label="p95"
            color="var(--accent)"
            maxMs={maxMs}
            minMs={minMs}
            height={height}
          />
        )}
        {p99 > 0 && (
          <PercentileMarker
            value={p99}
            label="p99"
            color="var(--error)"
            maxMs={maxMs}
            minMs={minMs}
            height={height}
          />
        )}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>0</span>
        <span className="text-[var(--terminal)]">p50: {Math.round(p50)}ms</span>
        <span className="text-[var(--accent)]">p95: {Math.round(p95)}ms</span>
        <span className="text-[var(--error)]">p99: {Math.round(p99)}ms</span>
        <span>{Math.round(maxMs)}ms+</span>
      </div>
    </div>
  );
}

function PercentileMarker({
  value,
  label,
  color,
  maxMs,
  minMs,
  height: _height }: {
  value: number;
  label: string;
  color: string;
  maxMs: number;
  minMs: number;
  height: number;
}) {
  // Position on log scale; center when min===max (avoids NaN %).
  const lo = Math.log10(minMs);
  const hi = Math.log10(maxMs);
  const span = hi - lo;
  const pct =
    !Number.isFinite(span) || span <= 0
      ? 50
      : ((Math.log10(value) - lo) / span) * 100;
  return (
    <div
      className="absolute top-0 bottom-0 pointer-events-none"
      style={{
        left: `${Math.max(0, Math.min(100, pct))}%`,
        width: "2px",
        background: color,
        opacity: 0.6 }}
      title={`${label}: ${Math.round(value)}ms`}
    >
      <span
        className="absolute -top-3 -translate-x-1/2 text-[10px] font-mono"
        style={{ color, whiteSpace: "nowrap" }}
      >
        {label}
      </span>
    </div>
  );
}
