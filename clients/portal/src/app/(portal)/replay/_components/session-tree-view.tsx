"use client";

import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TracePickerItem, TraceSession } from "./replay-types";

export function SessionTreeView({
  sessions,
  pickerItems,
  selectedTraceId,
  activeSessionIndex,
  onSelect,
}: {
  sessions: TraceSession[];
  pickerItems: TracePickerItem[];
  selectedTraceId: string;
  activeSessionIndex: number;
  onSelect: (traceId: string) => void;
}) {
  return (
    <div className="mb-6 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-[var(--accent)]" />
          Sessions
        </h3>
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">
          {sessions.length} sessions · {pickerItems.length} traces · 30m gap
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
        {sessions.map((session, sIdx) => {
          const isActive = sIdx === activeSessionIndex;
          return (
            <div
              key={session.session_id}
              className={cn(
                "shrink-0 rounded-lg border p-2.5 min-w-[180px] max-w-[220px]",
                isActive
                  ? "border-[var(--accent)] bg-[var(--accent-light)]/40"
                  : "border-[var(--border-default)] bg-[var(--bg-secondary)]",
              )}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span
                  className={cn(
                    "text-[10px] uppercase tracking-wider font-semibold",
                    isActive
                      ? "text-[var(--accent)]"
                      : "text-[var(--text-muted)]",
                  )}
                >
                  Session {sIdx + 1}
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {session.trace_ids.length} traces
                </span>
              </div>
              <div className="space-y-1">
                {session.trace_ids.map((tid, tIdx) => {
                  const item = pickerItems.find((p) => p.job_id === tid);
                  const label =
                    item?.first_user_message?.slice(0, 32) ||
                    `${tid.slice(0, 8)}…`;
                  const isSel = tid === selectedTraceId;
                  return (
                    <button
                      key={tid}
                      onClick={() => onSelect(tid)}
                      className={cn(
                        "w-full text-left px-2 py-1 rounded text-[11px] flex items-center gap-1.5 transition-colors",
                        isSel
                          ? "bg-[var(--accent)] text-[var(--bg-base)] font-semibold"
                          : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border-default)] hover:text-[var(--text-primary)]",
                      )}
                      title={item?.first_user_message ?? tid}
                    >
                      <span className="font-mono opacity-70 shrink-0">
                        {tIdx + 1}
                      </span>
                      <span className="truncate">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
