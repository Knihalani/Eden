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
 *
 * Chrome band budget (w3-hierarchy-spec / w4-anti-clutter): ≤2 purpose
 * bands — identity + toolbar. KPI is an optional thin strip and does
 * not count as a third page band (`data-page-bands` stays "1"|"2").
 *
 * When `detail` is set (e.g. driven by `?traceId=`), the `table` slot
 * stays mounted beside the panel. Split row uses xl (≥1280); below that
 * DetailPanelShell renders as a drawer while this list column remains.
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
  const hasKpi = Boolean(kpiStrip);
  const pageBands = toolbar ? "2" : "1";
  return (
    <div
      className={cn("flex flex-col gap-space-4", className)}
      data-has-kpi={hasKpi ? "" : undefined}
      data-page-bands={pageBands}
    >
      {header && (
        <div className="min-w-0 [&_.mb-4]:mb-0 [&_.mb-space-4]:mb-0" data-chrome-band="identity">
          {header}
        </div>
      )}
      {toolbar && (
        <div className="min-w-0" data-chrome-band="toolbar">
          {toolbar}
        </div>
      )}
      {kpiStrip && (
        <div data-chrome-band="kpi">{kpiStrip}</div>
      )}
      <div
        className={cn(
          "flex flex-col gap-0 min-h-0",
          // Laminar ≥1280 split; mid widths use DetailPanelShell drawer.
          hasDetail && "xl:flex-row xl:items-start xl:gap-space-4",
        )}
      >
        <div className={cn("min-w-0 flex-1", hasDetail && "xl:pr-0")}>
          {table}
        </div>
        {detail}
      </div>
      {bulkBar}
    </div>
  );
}
