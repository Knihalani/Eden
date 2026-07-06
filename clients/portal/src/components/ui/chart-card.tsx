"use client";

import * as React from "react";
import {
  ResponsiveContainer,
} from "recharts";
import { Section } from "@/components/ui/section";
import { cn } from "@/lib/utils";

export interface ChartCardProps {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  height?: number;
  className?: string;
  contentClassName?: string;
  /** When true, render the chart even if data is empty (shows fallback message inside). */
  showFallback?: boolean;
  fallback?: React.ReactNode;
  isEmpty?: boolean;
  children: React.ReactElement;
  /**
   * ui-audit 2026-07-06 M9: human-readable description of the chart
   * for screen readers. Recharts SVG output does not expose
   * <title>/aria-label, so a non-sighted user hears nothing. When
   * provided, the chart container is announced as `role="img"`
   * with this label; when omitted, the title is reused (visible
   * heading is better than silence).
   */
  ariaLabel?: string;
}

const DEFAULT_FALLBACK = (
  <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
    No data available for this period
  </div>
);

/**
 * ChartCard — pairs a Section header with a ResponsiveContainer so chart
 * panels share layout/typography without re-implementing the shell. Children
 * must be a single Recharts element (e.g. <LineChart />, <BarChart />).
 *
 * ui-audit 2026-07-06 M9: the inner chart div now exposes role="img"
 * with an aria-label fallback chain (explicit prop → title → generic
 * "Chart") so screen readers announce *something*. The visible
 * <Section title> remains the primary surface for sighted users.
 */
export function ChartCard({
  title,
  description,
  actions,
  height = 260,
  className,
  contentClassName,
  showFallback = true,
  fallback = DEFAULT_FALLBACK,
  isEmpty = false,
  ariaLabel,
  children,
}: ChartCardProps) {
  // The visible heading (Section's <h2>) is the canonical chart label.
  // We mirror it as aria-label on the chart surface so AT users hear
  // something on focus. The visible label is NOT marked aria-hidden
  // because the heading is part of the page structure.
  const chartAriaLabel = ariaLabel ?? title ?? "Chart";
  return (
    <Section
      title={title}
      description={description}
      actions={actions}
      className={className}
      contentClassName={cn("overflow-hidden", contentClassName)}
    >
      <div
        style={{ width: "100%", height }}
        className="relative"
        role="img"
        aria-label={chartAriaLabel}
      >
        {isEmpty && showFallback ? (
          fallback
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        )}
      </div>
    </Section>
  );
}
