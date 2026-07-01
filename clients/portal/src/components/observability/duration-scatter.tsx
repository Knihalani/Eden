"use client";

/**
 * DurationScatter — scatter plot of (duration, score) per eval.
 *
 * Renders an SVG scatter plot with one dot per eval run.
 * The X axis is duration (ms), the Y axis is the score
 * (0-1). Hover on a dot shows the eval's id + metadata.
 *
 * Used in the eval dashboard to surface "slow runs are
 * low-scoring" or "score correlates with duration" patterns.
 *
 * The component is purely presentational. The parent
 * fetches the data + passes it in.
 */

import * as _React from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export interface ScatterPoint {
  id: string;
  x: number;  // duration (ms)
  y: number;  // score (0-1)
  label?: string;
  meta?: Record<string, unknown>;
}

export interface DurationScatterProps {
  points: ScatterPoint[];
  className?: string;
  width?: number;
  height?: number;
  x_label?: string;
  y_label?: string;
  // Optional: thresholds for the "good" zone (green band).
  good_zone_y_min?: number;
  good_zone_y_max?: number;
}

export function DurationScatter({
  points,
  className,
  width = 480,
  height = 280,
  x_label = "Duration (ms)",
  y_label = "Score",
  good_zone_y_min,
  good_zone_y_max }: DurationScatterProps) {
  const [hovered, setHovered] = useState<ScatterPoint | null>(null);
  const padding = { top: 20, right: 20, bottom: 32, left: 40 };
  const plot_w = width - padding.left - padding.right;
  const plot_h = height - padding.top - padding.bottom;
  if (points.length === 0) {
    return (
      <div className={cn(
        "rounded border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]",
        className,
      )}>
        No data points to display.
      </div>
    );
  }
  // Auto-scale axes.
  const xs = points.map((p) => p.x);
  const __ys = points.map((p) => p.y);
  const x_min = Math.min(0, ...xs);
  const x_max = Math.max(1, ...xs);
  const y_min = 0;
  const y_max = 1;
  const x_to_px = (x: number) =>
    padding.left + ((x - x_min) / (x_max - x_min)) * plot_w;
  const y_to_px = (y: number) =>
    padding.top + (1 - (y - y_min) / (y_max - y_min)) * plot_h;
  return (
    <div className={cn("rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3", className)}>
      <svg width={width} height={height} role="img" aria-label="Duration vs score scatter">
        {/* Axes */}
        <line x1={padding.left} y1={padding.top}
              x2={padding.left} y2={padding.top + plot_h}
              stroke="var(--border)" />
        <line x1={padding.left} y1={padding.top + plot_h}
              x2={padding.left + plot_w} y2={padding.top + plot_h}
              stroke="var(--border)" />
        {/* Good zone */}
        {good_zone_y_min !== undefined && good_zone_y_max !== undefined && (
          <rect
            x={padding.left}
            y={y_to_px(good_zone_y_max)}
            width={plot_w}
            height={y_to_px(good_zone_y_min) - y_to_px(good_zone_y_max)}
            fill="var(--success)" opacity={0.08}
          />
        )}
        {/* Points */}
        {points.map((p) => (
          <circle
            key={p.id}
            cx={x_to_px(p.x)}
            cy={y_to_px(p.y)}
            r={4}
            fill={p.y >= 0.7 ? "var(--success)" : p.y >= 0.4 ? "var(--warning)" : "var(--error)"}
            opacity={hovered && hovered.id !== p.id ? 0.4 : 1.0}
            onMouseEnter={() => setHovered(p)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: "pointer" }}
          />
        ))}
        {/* X axis labels */}
        {[0, 0.25, 0.5, 0.75, 1.0].map((t) => {
          const x = padding.left + t * plot_w;
          const value = x_min + t * (x_max - x_min);
          return (
            <g key={`x-${t}`}>
              <line x1={x} y1={padding.top + plot_h}
                    x2={x} y2={padding.top + plot_h + 4}
                    stroke="var(--border)" />
              <text x={x} y={padding.top + plot_h + 16}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--text-muted)">
                {value.toFixed(0)}
              </text>
            </g>
          );
        })}
        {/* Y axis labels */}
        {[0, 0.25, 0.5, 0.75, 1.0].map((t) => {
          const y = padding.top + (1 - t) * plot_h;
          return (
            <g key={`y-${t}`}>
              <line x1={padding.left - 4} y1={y}
                    x2={padding.left} y2={y}
                    stroke="var(--border)" />
              <text x={padding.left - 8} y={y + 3}
                    textAnchor="end"
                    fontSize={10}
                    fill="var(--text-muted)">
                {t.toFixed(2)}
              </text>
            </g>
          );
        })}
        {/* Axis labels */}
        <text x={padding.left + plot_w / 2} y={height - 4}
              textAnchor="middle" fontSize={11}
              fill="var(--text-muted)">
          {x_label}
        </text>
        <text transform={`rotate(-90) translate(${-padding.top - plot_h / 2}, 12)`}
              textAnchor="middle" fontSize={11}
              fill="var(--text-muted)">
          {y_label}
        </text>
      </svg>
      {hovered && (
        <div className="mt-2 text-xs text-[var(--text-muted)]">
          {hovered.label ?? hovered.id} —
          {" "}{hovered.x.toFixed(0)}ms,
          {" "}score {hovered.y.toFixed(2)}
        </div>
      )}
    </div>
  );
}
