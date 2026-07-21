"use client";

import { cn } from "@/lib/utils";
import { TIME_RANGES } from "./home-widgets";

/**
 * Quiet sticky time-range context for Home (Wave 6.7).
 * Secondary fill input — not a decorative card.
 */
export function TimeRangeControl({
  windowHours,
  onChange,
  className,
}: {
  windowHours: number;
  onChange: (hours: number) => void;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-space-2 text-xs text-[var(--text-muted)]",
        className,
      )}
    >
      <span className="hidden sm:inline">Window</span>
      <span className="sr-only">Time range</span>
      <select
        value={windowHours}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Time range"
        data-testid="dashboard-time-range"
        className={cn(
          "h-8 min-h-8 rounded-md border border-[var(--border-subtle)]",
          "bg-[var(--bg-secondary)] px-space-2 text-xs text-[var(--text-secondary)]",
          "focus:outline-none focus:ring-2 focus:ring-[var(--terminal)]",
        )}
      >
        {TIME_RANGES.map((r) => (
          <option key={r.hours} value={r.hours}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}
