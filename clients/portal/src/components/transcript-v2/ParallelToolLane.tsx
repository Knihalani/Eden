"use client";

import { useCallback, useState } from "react";
import { Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParallelLane } from "./hooks/useParallelGroups";

export interface ParallelToolLaneProps {
  lanes: ParallelLane[];
  selectedSpanId?: string | null;
  onSelect?: (spanId: string) => void;
  orgId?: string;
  traceId?: string;
  agentId?: string;
}

export function ParallelToolLane({
  lanes,
  selectedSpanId,
  onSelect,
  orgId,
  traceId,
  agentId,
}: ParallelToolLaneProps) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submitLabel = useCallback(
    async (lane: ParallelLane, label: "good" | "bad") => {
      if (!orgId || !traceId) return;
      setBusy(true);
      try {
        const { api } = await import("@/lib/api");
        await api.labelToolCall(orgId, lane.span_id, {
          trace_id: traceId,
          tool_name: lane.tool_name,
          label,
          agent_id: agentId,
        });
        setLabels((s) => ({ ...s, [lane.span_id]: label }));
      } catch {
        setLabels((s) => ({ ...s, [lane.span_id]: "error" }));
      } finally {
        setBusy(false);
      }
    },
    [orgId, traceId, agentId],
  );

  return (
    <div
      className="my-space-2 space-y-space-2 border-y border-[var(--border-subtle)] py-space-2"
      data-testid="parallel-tool-lane"
      role="group"
      aria-label={`Parallel tools (${lanes.length})`}
    >
      <p className="font-mono text-2xs uppercase tracking-wide text-[var(--text-muted)]">
        Parallel tools · {lanes.length} lanes
      </p>
      <div className="grid gap-space-2 sm:grid-cols-2 lg:grid-cols-3">
        {lanes.map((lane) => {
          const selected = selectedSpanId === lane.span_id;
          const labeled = labels[lane.span_id];
          return (
            <div
              key={lane.span_id}
              className={cn(
                "flex flex-col gap-space-1 border-l-2 px-space-3 py-space-1 text-left transition-colors",
                selected
                  ? "border-[var(--accent)] bg-[var(--accent)]/5"
                  : "border-[var(--border-subtle)] hover:border-[var(--border-default)]",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect?.(lane.span_id)}
                className="flex flex-col gap-space-1 text-left"
              >
                <span className="inline-flex items-center gap-space-1 text-xs font-medium text-[var(--text-primary)]">
                  <Wrench className="h-3 w-3 text-[var(--warning)]" />
                  {lane.tool_name}
                </span>
                <span className="font-mono text-2xs text-[var(--text-muted)] truncate">
                  {lane.span_id.slice(0, 12)}…
                </span>
                <span
                  className={cn(
                    "font-mono text-2xs uppercase",
                    lane.status === "failure" || lane.status === "error"
                      ? "text-[var(--error)]"
                      : "text-[var(--success)]",
                  )}
                >
                  {lane.status}
                </span>
              </button>
              {orgId && traceId && (
                <span className="mt-space-1 flex items-center gap-space-1" data-testid="f21-tool-labels">
                  {labeled === "good" || labeled === "bad" ? (
                    <span className="text-2xs text-[var(--text-muted)]">
                      labeled {labeled}
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Label ${lane.tool_name} good`}
                        className="inline-flex min-h-6 min-w-6 items-center justify-center rounded px-space-1 py-space-1 text-2xs border border-[var(--terminal)] text-[var(--terminal)] disabled:opacity-50"
                        onClick={() => void submitLabel(lane, "good")}
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Label ${lane.tool_name} bad`}
                        className="inline-flex min-h-6 min-w-6 items-center justify-center rounded px-space-1 py-space-1 text-2xs border border-[var(--error)] text-[var(--error)] disabled:opacity-50"
                        onClick={() => void submitLabel(lane, "bad")}
                      >
                        ✗
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
