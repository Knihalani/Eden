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
}

export function PlanLimitsDisplay({
  seats_used,
  seats_limit,
  references_used,
  references_limit,
  jobs_used,
  jobs_limit,
  compact = false,
}: PlanLimitsDisplayProps) {
  const limits = [
    { label: "Seats", used: seats_used, limit: seats_limit },
    { label: "References", used: references_used, limit: references_limit },
    { label: "Jobs", used: jobs_used, limit: jobs_limit },
  ];

  if (compact) {
    return (
      <div className="flex items-center gap-4 text-sm">
        {limits.map((item) => {
          const percentage = item.limit > 0 ? Math.min((item.used / item.limit) * 100, 100) : 0;
          const isAtLimit = percentage >= 100;
          return (
            <span
              key={item.label}
              className={cn(
                "font-medium",
                isAtLimit ? "text-[var(--error)]" : "text-[var(--text-secondary)]"
              )}
            >
              {item.used}/{item.limit} {item.label.toLowerCase()}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {limits.map((item) => {
        const percentage = item.limit > 0 ? Math.min((item.used / item.limit) * 100, 100) : 0;
        const isNearLimit = percentage >= 80;
        const isAtLimit = percentage >= 100;

        return (
          <div
            key={item.label}
            className={cn(
              "p-4 rounded-lg border",
              isAtLimit ? "border-[var(--error)] bg-[var(--error-dim)]" : isNearLimit ? "border-[var(--warning)] bg-[var(--warning-bg)]" : "border-[var(--border)] bg-[var(--bg-primary)]"
            )}
          >
            <div className="text-sm text-[var(--text-secondary)] mb-1">{item.label}</div>
            <div className="flex items-baseline gap-1">
              <span className={cn(
                "text-2xl font-bold",
                isAtLimit ? "text-[var(--error)]" : "text-[var(--text-primary)]"
              )}>
                {item.used}
              </span>
              <span className="text-sm text-[var(--text-muted)]">/ {item.limit}</span>
            </div>
            <div className="mt-2 h-1.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full",
                  isAtLimit ? "bg-[var(--error)]" : isNearLimit ? "bg-[var(--warning)]" : "bg-[var(--accent)]"
                )}
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}