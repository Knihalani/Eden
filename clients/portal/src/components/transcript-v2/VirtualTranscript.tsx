"use client";

import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

export const TRANSCRIPT_ROW_ESTIMATE = 182;
export const TRANSCRIPT_ROW_ESTIMATE_EXPANDED = 198;

export interface VirtualTranscriptProps {
  items: Array<{
    key: string;
    estimate?: number;
    sticky?: boolean;
    content: ReactNode;
  }>;
  className?: string;
  overscan?: number;
}

export function VirtualTranscript({
  items,
  className,
  overscan = 8,
}: VirtualTranscriptProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => items[i]?.estimate ?? TRANSCRIPT_ROW_ESTIMATE,
    overscan,
  });

  return (
    <div
      ref={parentRef}
      className={cn("h-full min-h-0 overflow-y-auto", className)}
      data-testid="virtual-transcript"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index]!;
          if (item.sticky) {
            return (
              <div
                key={item.key}
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 10,
                  background: "var(--bg-primary)",
                  height: vRow.size,
                }}
              >
                {item.content}
              </div>
            );
          }
          return (
            <div
              key={item.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: vRow.size,
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              {item.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
