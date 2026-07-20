"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ResourcePageShellProps {
  /** Page identity (typically PageHeader). Kept outside toolbar so
   *  title margin and filter-row spacing do not double-stack. */
  header?: ReactNode;
  /** Filters / search / primary actions row under the header. */
  toolbar?: ReactNode;
  kpiStrip?: ReactNode;
  table: ReactNode;
  detail?: ReactNode;
  bulkBar?: ReactNode;
  className?: string;
}

/**
 * U00 ResourcePageShell — master-detail layout without full U18 AppShell.
 * Slot order: header → toolbar → kpi → table|detail → bulkBar.
 * Vertical rhythm is owned here; PageHeader should use its default
 * margin (or `mb-0` via className) and not rely on outer space-y.
 */
export function ResourcePageShell({
  header,
  toolbar,
  kpiStrip,
  table,
  detail,
  bulkBar,
  className,
}: ResourcePageShellProps) {
  const hasDetail = Boolean(detail);
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {header && <div className="min-w-0 [&_.mb-4]:mb-0">{header}</div>}
      {toolbar && <div className="min-w-0">{toolbar}</div>}
      {kpiStrip}
      <div
        className={cn(
          "flex flex-col gap-0 min-h-0",
          hasDetail && "lg:flex-row lg:items-start",
        )}
      >
        <div className={cn("min-w-0 flex-1", hasDetail && "lg:pr-0")}>
          {table}
        </div>
        {detail}
      </div>
      {bulkBar}
    </div>
  );
}
