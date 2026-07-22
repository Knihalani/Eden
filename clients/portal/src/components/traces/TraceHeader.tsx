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
  /** Compact split-panel vs spacious fullscreen band. */
  layout?: "default" | "fullscreen";
  className?: string;
}

export function TraceHeader({
  metrics,
  overflowActions,
  liveSlot,
  modeTabs,
  contextPills,
  closeControl,
  layout = "default",
  className,
}: TraceHeaderProps) {
  const fullscreen = layout === "fullscreen";

  return (
    <div
      className={cn(
        "border-b border-[var(--border-default)] text-xs",
        fullscreen ? "px-space-4 py-space-3" : "px-4 py-2",
        className,
      )}
      data-testid="trace-header"
      data-rows="2"
      data-layout={layout}
    >
      <div
        className={cn(
          "flex flex-wrap items-center",
          fullscreen ? "gap-space-3" : "gap-2",
        )}
      >
        <div
          className={cn(
            "flex flex-wrap items-center",
            fullscreen ? "gap-space-3" : "gap-2",
          )}
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
      <div
        className={cn(
          "flex flex-wrap items-center",
          fullscreen ? "mt-space-3 gap-space-3" : "mt-2 gap-2",
        )}
      >
        {modeTabs}
        {contextPills ? contextPills : null}
      </div>
    </div>
  );
}
