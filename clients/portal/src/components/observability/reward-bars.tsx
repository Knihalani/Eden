"use client";

/**
 * RewardBars — horizontal bar chart for eval scores.
 *
 * Renders one bar per score with the score name + value
 * + a colour-coded status (high = green, mid = yellow,
 * low = red). Used in the eval score tab to show
 * "Refusal rate: 12% ↑" style rows.
 *
 * The component is purely presentational. The parent
 * fetches the scores + passes them in.
 */

import { memo } from "react";
import { cn } from "@/lib/utils";

export interface RewardBarItem {
  name: string;
  value: number;       // 0-1 (or 0-100 if scale="percent")
  scale?: "fraction" | "percent" | "raw";  // default "fraction"
  threshold?: number;   // optional: green if value >= threshold
  description?: string;
}

export interface RewardBarsProps {
  items: RewardBarItem[];
  className?: string;
  // Optional: title for the chart.
  title?: string;
}

export function RewardBars({ items, className, title }: RewardBarsProps) {
  if (items.length === 0) {
    return (
      <div className={cn("rounded border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]", className)}>
        No scores to display.
      </div>
    );
  }
  return (
    <div className={cn("rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3", className)}>
      {title && (
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {title}
        </h3>
      )}
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <RewardBarRow key={item.name} item={item} />
        ))}
      </ul>
    </div>
  );
}

const RewardBarRow = memo(function RewardBarRow({ item }: { item: RewardBarItem }) {
  const scale = item.scale ?? "fraction";
  let pct: number;
  let display: string;
  if (scale === "fraction") {
    pct = Math.max(0, Math.min(1, item.value)) * 100;
    display = item.value.toFixed(2);
  } else if (scale === "percent") {
    pct = Math.max(0, Math.min(100, item.value));
    display = `${item.value.toFixed(1)}%`;
  } else {
    pct = 0;  // raw values don't have a 0-1 scale
    display = item.value.toFixed(2);
  }
  const colour = _colour_for(item.value, item.threshold, scale);
  return (
    <li>
      <div className="mb-0.5 flex items-baseline justify-between text-xs">
        <span className="font-mono text-[var(--text-primary)]">
          {item.name}
        </span>
        <span className="font-mono text-[var(--text-secondary)]">
          {display}
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded bg-[var(--bg-secondary)]">
        {scale !== "raw" && (
          <div
            className="h-full rounded transition-all"
            style={{ width: `${pct}%`, background: colour }}
          />
        )}
      </div>
      {item.description && (
        <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
          {item.description}
        </p>
      )}
    </li>
  );
});

function _colour_for(value: number, threshold: number | undefined, scale: string): string {
  const t = threshold ?? (scale === "percent" ? 90 : 0.9);
  if (value >= t) return "var(--success)";
  if (value >= t * 0.7) return "var(--warning)";
  return "var(--error)";
}
