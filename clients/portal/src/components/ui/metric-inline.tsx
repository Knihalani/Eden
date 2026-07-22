"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface MetricInlineProps {
  label: string;
  value: ReactNode;
  className?: string;
  /** Mono value (rates, ids, currency). */
  mono?: boolean;
}

/**
 * Compact label + value pair for dense agent/dashboard rows (14px body).
 */
export function MetricInline({
  label,
  value,
  className,
  mono = false,
}: MetricInlineProps) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 text-sm text-[var(--text-secondary)]",
        className,
      )}
    >
      <span className="text-[var(--text-muted)]">{label}</span>
      <span
        className={cn(
          "text-[var(--text-primary)]",
          mono && "font-mono tabular-nums",
        )}
      >
        {value}
      </span>
    </span>
  );
}
