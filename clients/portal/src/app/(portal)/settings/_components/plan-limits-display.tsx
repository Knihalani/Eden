"use client";

import { cn } from "@/lib/utils";

interface PlanLimitsDisplayProps {
  seats_used: number;
  seats_limit: number;
  references_used: number;
  references_limit: number;
  jobs_used: number;
  jobs_limit: number;
  compact?: boolean;
  className?: string;
}

export function PlanLimitsDisplay({
  seats_used,
  seats_limit,
  references_used,
  references_limit,
  jobs_used,
  jobs_limit,
  compact = false,
  className,
}: PlanLimitsDisplayProps) {
  const limits = [
    { label: "Seats", used: seats_used, limit: seats_limit },
    { label: "References", used: references_used, limit: references_limit },
    { label: "Jobs", used: jobs_used, limit: jobs_limit },
  ];

  if (compact) {
    return (
      <div
        data-ws5-plan-limits="compact"
        className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-sm", className)}
      >
        {limits.map((item) => {
          const percentage =
            item.limit > 0 ? Math.min((item.used / item.limit) * 100, 100) : 0;
          const isAtLimit = item.limit > 0 && percentage >= 100;
          return (
            <span
              key={item.label}
              className={cn(
                "font-medium tabular-nums",
                isAtLimit ? "text-[var(--error)]" : "text-[var(--text-secondary)]",
              )}
            >
              {item.used}/{item.limit > 0 ? item.limit : "—"} {item.label.toLowerCase()}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div data-ws5-plan-limits className={cn("space-y-space-4", className)}>
      {limits.map((item) => {
        const percentage =
          item.limit > 0 ? Math.min((item.used / item.limit) * 100, 100) : 0;
        const isNearLimit = item.limit > 0 && percentage >= 80;
        const isAtLimit = item.limit > 0 && percentage >= 100;
        const displayLimit =
          item.limit > 0 ? item.limit.toLocaleString() : "—";

        return (
          <div key={item.label}>
            <div className="mb-1 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {item.label}
              </span>
              <span
                className={cn(
                  "text-sm tabular-nums",
                  isAtLimit
                    ? "text-[var(--error)]"
                    : "text-[var(--text-secondary)]",
                )}
              >
                {item.used.toLocaleString()}
                {item.limit > 0 ? ` / ${displayLimit}` : ""}
              </span>
            </div>
            {item.limit > 0 ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-muted)]">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    isAtLimit
                      ? "bg-[var(--error)]"
                      : isNearLimit
                        ? "bg-[var(--warning)]"
                        : "bg-[var(--accent)]",
                  )}
                  style={{ width: `${percentage}%` }}
                />
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">No quota on this plan</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
