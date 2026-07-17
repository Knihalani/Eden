"use client";

import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { useDensity } from "./DensityProvider";

export interface VirtualizedListProps<T> {
  items: T[];
  rowKey: (item: T) => string;
  rowHeight?: number;
  overscan?: number;
  className?: string;
  children: (item: T, index: number) => ReactNode;
}

const DEFAULT_ROW_HEIGHT = 88;
const COMPACT_ROW_HEIGHT = 72;
const VIRTUALIZE_THRESHOLD = 40;

/**
 * F82 — @tanstack/react-virtual list for card-style rows.
 */
export function VirtualizedList<T>({
  items,
  rowKey,
  rowHeight,
  overscan = 6,
  className,
  children,
}: VirtualizedListProps<T>) {
  const density = useDensity();
  const size = rowHeight ?? (density === "compact" ? COMPACT_ROW_HEIGHT : DEFAULT_ROW_HEIGHT);
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualized = items.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => size,
    overscan,
    enabled: virtualized,
  });

  if (!virtualized) {
    return (
      <div className={cn("space-y-2", className)} data-density={density}>
        {items.map((item, index) => (
          <div key={rowKey(item)}>{children(item, index)}</div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className={cn("max-h-[70vh] overflow-y-auto", className)}
      data-density={density}
    >
      <div
        style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
      >
        {virtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index]!;
          return (
            <div
              key={rowKey(item)}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: vRow.size,
                transform: `translateY(${vRow.start}px)`,
              }}
              className="px-0 py-1"
            >
              {children(item, vRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
