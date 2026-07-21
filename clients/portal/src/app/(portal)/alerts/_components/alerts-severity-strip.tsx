"use client";

import { cn } from "@/lib/utils";
import { getSeverityConfig, type SeverityFilter } from "./alert-config";

export function AlertsSeverityStrip({
  severityCounts,
  severityFilter,
  onSeverityChange,
}: {
  severityCounts: Record<string, number>;
  severityFilter: SeverityFilter;
  onSeverityChange: (next: SeverityFilter) => void;
}) {
  return (
          <div
            className="flex flex-wrap items-center gap-space-1"
            data-testid="alerts-severity-strip"
            aria-label="Severity counts"
          >
            {(["critical", "high", "warning", "info"] as const).map((sev) => {
              const cfg = getSeverityConfig(sev);
              const count = severityCounts[sev] ?? 0;
              const active = severityFilter === sev;
              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => {
                    onSeverityChange(active ? "all" : sev);
                  }}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-space-1.5 px-space-2 text-xs font-medium transition-colors",
                    active
                      ? cn(cfg.color, "border-b-2 border-current")
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                  )}
                  aria-pressed={active}
                >
                  <span className={cn("font-semibold tabular-nums", active ? undefined : cfg.color)}>
                    {count}
                  </span>
                  {cfg.label}
                </button>
              );
            })}
          </div>
  );
}
