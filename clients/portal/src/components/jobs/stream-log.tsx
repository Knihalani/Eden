"use client";

import * as React from "react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type LogLevel = "info" | "warn" | "error" | "system" | "done";

export interface LogEntry {
  id?: string;
  timestamp?: Date;
  level?: LogLevel;
  message: string;
}

export interface StreamLogProps {
  entries: LogEntry[];
  className?: string;
  autoScroll?: boolean;
}

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getLevelClass(level: LogLevel): string {
  switch (level) {
    case "info":
      return "text-[var(--accent)]";
    case "warn":
      return "text-[var(--warn)]";
    case "error":
      return "text-[var(--error)]";
    case "done":
      return "text-[var(--success)]";
    case "system":
    default:
      return "text-[var(--fg-secondary)]";
  }
}

export const StreamLog = React.forwardRef<HTMLDivElement, StreamLogProps>(
  ({ entries, className, autoScroll = true }, ref) => {
    const internalRef = useRef<HTMLDivElement>(null);

    // Merge forwarded ref with internal ref
    const setRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        internalRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref]
    );

    useEffect(() => {
      if (autoScroll && internalRef.current) {
        internalRef.current.scrollTop = internalRef.current.scrollHeight;
      }
    }, [entries, autoScroll]);

    return (
      <div
        ref={setRef}
        className={cn(
          "bg-[var(--bg-base)] border border-[var(--border)] rounded-lg p-4",
          "font-mono text-xs leading-relaxed overflow-y-auto max-h-[400px]",
          className
        )}
      >
        {entries.map((entry, index) => (
          <div
            key={entry.id || index}
            className="flex gap-3 py-1 border-b border-[var(--border)] last:border-b-0"
          >
            <span className="text-[var(--fg-faint)] flex-shrink-0">
              {entry.timestamp ? formatTimestamp(entry.timestamp) : "--:--:--"}
            </span>
            <span className={cn("flex-shrink-0", getLevelClass(entry.level || "system"))}>
              {entry.level === "info" && ">"}
              {entry.level === "warn" && "!"}
              {entry.level === "error" && "x"}
              {entry.level === "done" && "+"}
              {entry.level === "system" && "~"}
              {!entry.level && ":"}
            </span>
            <span className={getLevelClass(entry.level || "system")}>
              {entry.message}
            </span>
          </div>
        ))}
        {entries.length === 0 && (
          <div className="text-[var(--fg-faint)]">Waiting for output...</div>
        )}
      </div>
    );
  }
);
StreamLog.displayName = "StreamLog";
