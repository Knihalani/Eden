"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ResourcePageShellProps {
  toolbar?: ReactNode;
  kpiStrip?: ReactNode;
  table: ReactNode;
  detail?: ReactNode;
  bulkBar?: ReactNode;
  className?: string;
}

/**
 * U00 ResourcePageShell — master-detail layout without full U18 AppShell.
 */
export function ResourcePageShell({
  toolbar,
  kpiStrip,
  table,
  detail,
  bulkBar,
  className,
}: ResourcePageShellProps) {
  const hasDetail = Boolean(detail);
  return (
    <div className={cn("space-y-4", className)}>
      {toolbar}
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
