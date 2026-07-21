"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TraceHeaderMetric {
  key: string;
  node: ReactNode;
}

export interface TraceHeaderProps {
  metrics: TraceHeaderMetric[];
  overflowActions?: ReactNode;
  liveSlot?: ReactNode;
  modeTabs: ReactNode;
  contextPills?: ReactNode;
  closeControl?: ReactNode;
  className?: string;
}

export function TraceHeader({
  metrics,
  overflowActions,
  liveSlot,
  modeTabs,
  contextPills,
  closeControl,
  className,
}: TraceHeaderProps) {
  return (
    <div
      className={cn(
        "border-b border-[var(--border-default)] px-4 py-2 text-xs",
        className,
      )}
      data-testid="trace-header"
      data-rows="2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="trace-header-metrics"
          data-metric-count={metrics.length}
        >
          {metrics.map((m) => (
            <span key={m.key} data-metric={m.key}>
              {m.node}
            </span>
          ))}
        </div>
        {liveSlot}
        {overflowActions}
        {closeControl}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {modeTabs}
        {contextPills ? contextPills : null}
      </div>
    </div>
  );
}
