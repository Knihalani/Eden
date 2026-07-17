"use client";

import { cn } from "@/lib/utils";

export interface DriftHistogramProps {
  baseline: number[];
  current: number[];
  className?: string;
}

/** Baseline vs current mini-histogram (U05 drift dimension cards). */
export function DriftHistogram({ baseline, current, className }: DriftHistogramProps) {
  const n = Math.max(baseline.length, current.length);
  if (n === 0) return null;
  const max = Math.max(...baseline, ...current, 1);

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-end gap-px h-12" role="img" aria-label="Baseline vs current histogram">
        {Array.from({ length: n }, (_, i) => {
          const b = baseline[i] ?? 0;
          const c = current[i] ?? 0;
          return (
            <div key={i} className="flex flex-1 flex-col justify-end gap-px h-full">
              <div
                className="w-full rounded-t-sm bg-[var(--accent)]/40"
                style={{ height: `${(b / max) * 100}%`, minHeight: b > 0 ? 2 : 0 }}
                title={`Baseline bin ${i + 1}: ${b}`}
              />
              <div
                className="w-full rounded-t-sm bg-[var(--warning)]/70"
                style={{ height: `${(c / max) * 100}%`, minHeight: c > 0 ? 2 : 0 }}
                title={`Current bin ${i + 1}: ${c}`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>Baseline</span>
        <span>Current (24h)</span>
      </div>
    </div>
  );
}
