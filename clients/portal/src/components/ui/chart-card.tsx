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
  children,
}: ChartCardProps) {
  return (
    <Section
      title={title}
      description={description}
      actions={actions}
      className={className}
      contentClassName={cn("overflow-hidden", contentClassName)}
    >
      <div style={{ width: "100%", height }} className="relative">
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
