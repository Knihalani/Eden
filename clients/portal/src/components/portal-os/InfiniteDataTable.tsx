"use client";

import { useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DataTable, type DataTableColumn, type DataTableBulkAction, type DataTableProps } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDensity } from "./DensityProvider";

export interface InfiniteDataTableProps<T> extends Omit<DataTableProps<T>, "pageSize"> {
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  estimatedRowHeight?: number;
  virtualizeThreshold?: number;
}

const DEFAULT_ROW_HEIGHT = 44;
const COMPACT_ROW_HEIGHT = 36;
const DEFAULT_THRESHOLD = 50;

/**
 * U00 / F82 InfiniteDataTable — DataTable + load-more + @tanstack/react-virtual.
 */
export function InfiniteDataTable<T>({
  hasMore,
  onLoadMore,
  loadingMore,
  estimatedRowHeight,
  virtualizeThreshold = DEFAULT_THRESHOLD,
  className,
  rows,
  columns,
  ...props
}: InfiniteDataTableProps<T>) {
  const density = useDensity();
  const rowH =
    estimatedRowHeight ?? (density === "compact" ? COMPACT_ROW_HEIGHT : DEFAULT_ROW_HEIGHT);
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualized = rows.length > virtualizeThreshold;

  const virtualizer = useVirtualizer({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH,
    overscan: 8,
  });

  const virtualItems = virtualized ? virtualizer.getVirtualItems() : [];
  const windowRows = virtualized
    ? virtualItems.map((v) => rows[v.index]!).filter(Boolean)
    : rows;

  const paddingTop =
    virtualized && virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualized && virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;

  // Column key signature for diagnostics / stable identity checks (W12).
  const columnKeySig = useMemo(
    () => columns.map((c) => c.key).join("\0"),
    [columns],
  );

  return (
    <div className={cn("space-y-3", className)} data-density={density} data-column-sig={columnKeySig}>
      <div
        ref={parentRef}
        className={cn(
          virtualized && "max-h-[70vh] overflow-y-auto",
          density === "compact" && "text-sm [&_td]:py-1.5 [&_th]:py-1.5",
        )}
      >
        {virtualized && paddingTop > 0 ? (
          <div aria-hidden style={{ height: paddingTop }} />
        ) : null}
        <DataTable
          {...props}
          columns={columns}
          rows={windowRows}
          // Virtual window already clips rows — disable DataTable paging so
          // scroll length changes do not remount selection/sort state.
          pageSize={virtualized ? Math.max(windowRows.length, 1) : windowRows.length || 50}
        />
        {virtualized && paddingBottom > 0 ? (
          <div aria-hidden style={{ height: paddingBottom }} />
        ) : null}
      </div>
      {hasMore && onLoadMore ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="default"
            onClick={onLoadMore}
            loading={loadingMore}
            disabled={loadingMore}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export type { DataTableColumn, DataTableBulkAction };
