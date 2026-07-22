"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ResourcePageShellProps {
  /** Page identity (typically PageHeader). */
  header?: ReactNode;
  /** Filters / View · Filter · Display · Search · Overflow · time. */
  toolbar?: ReactNode;
  /** Master list / table — stays mounted when detail is open. */
  table: ReactNode;
  /**
   * Detail column (≥1280). Below xl, DetailPanelShell should render as Sheet;
   * pass `detail` only when selection is open on desktop split.
   */
  detail?: ReactNode;
  className?: string;
}

/**
 * Lean Observe master–detail shell (≥1280 split).
 * Band budget: identity + toolbar (≤2). Not portal-os.
 */
export function ResourcePageShell({
  header,
  toolbar,
  table,
  detail,
  className,
}: ResourcePageShellProps) {
  const hasDetail = Boolean(detail);
  const pageBands = toolbar ? "2" : "1";

  return (
    <div
      className={cn("flex flex-col gap-space-4", className)}
      data-page-bands={pageBands}
      data-testid="resource-page-shell"
    >
      {header ? (
        <div className="min-w-0" data-chrome-band="identity">
          {header}
        </div>
      ) : null}
      {toolbar ? (
        <div className="min-w-0" data-chrome-band="toolbar">
          {toolbar}
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-col gap-0",
          hasDetail && "xl:flex-row xl:items-start xl:gap-space-4",
        )}
      >
        <div
          className={cn("min-w-0 flex-1", hasDetail && "xl:max-w-[55%]")}
          data-slot="master"
        >
          {table}
        </div>
        {detail ? (
          <div className="min-w-0 xl:flex-1 xl:max-w-[60%]" data-slot="detail">
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}
