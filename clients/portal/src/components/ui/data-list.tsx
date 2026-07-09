"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * DataList — flat horizontal rows separated by hairline dividers.
 * Use for settings panels, key/value displays, configuration summaries
 * where every row is the same shape. Pairs with Panel tone="flat"
 * for the outer container or stands alone on a page surface.
 *
 * Differentiates from Card by being a list, not a tile — rows are
 * full-width with no internal padding noise.
 */
export interface DataListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** "tight" = py-2.5, "regular" = py-3.5, "loose" = py-4.5. */
  density?: "tight" | "regular" | "loose";
}

const DENSITY: Record<NonNullable<DataListProps["density"]>, string> = {
  tight: "py-2.5",
  regular: "py-3.5",
  loose: "py-4.5",
};

// The outer DataList applies density to each row it forwards to; the
// container itself is just a stack of rows, so density is ignored at
// this level (consumers pass density via DataRow).
const DataList = React.forwardRef<HTMLDivElement, DataListProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="list"
      className={cn("divide-y divide-[var(--border-subtle)]", className)}
      {...props}
    />
  )
);
DataList.displayName = "DataList";

export interface DataRowProps extends Omit<DataListProps, "density"> { density?: "tight" | "regular" | "loose"; }
const DataRow = React.forwardRef<HTMLDivElement, DataRowProps>(
  ({ className, density = "regular", ...props }, ref) => (
    <div
      ref={ref}
      role="listitem"
      className={cn(
        "flex items-start gap-6",
        DENSITY[density],
        className
      )}
      {...props}
    />
  )
);
DataRow.displayName = "DataRow";

interface DataCellProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Layout width — e.g. "w-32" for label column. */
  width?: string;
}

const DataLabel = React.forwardRef<HTMLDivElement, DataCellProps>(
  ({ className, width, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "shrink-0 text-[11px] font-mono font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]",
        width || "w-32",
        className
      )}
      {...props}
    />
  )
);
DataLabel.displayName = "DataLabel";

const DataValue = React.forwardRef<HTMLDivElement, DataCellProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex-1 min-w-0 text-sm text-[var(--text-primary)]", className)}
      {...props}
    />
  )
);
DataValue.displayName = "DataValue";

export { DataList, DataRow, DataLabel, DataValue };
