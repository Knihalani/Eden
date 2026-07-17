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
      className="my-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2"
      data-testid="parallel-tool-lane"
      role="group"
      aria-label={`Parallel tools (${lanes.length})`}
    >
      <p className="mb-2 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        Parallel tools · {lanes.length} lanes
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {lanes.map((lane) => {
          const selected = selectedSpanId === lane.span_id;
          const labeled = labels[lane.span_id];
          return (
            <div
              key={lane.span_id}
              className={cn(
                "flex flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors",
                selected
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border-subtle)] hover:border-[var(--border-default)]",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect?.(lane.span_id)}
                className="flex flex-col gap-1 text-left"
              >
                <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--text-primary)]">
                  <Wrench className="h-3 w-3 text-[var(--warning)]" />
                  {lane.tool_name}
                </span>
                <span className="font-mono text-[10px] text-[var(--text-muted)] truncate">
                  {lane.span_id.slice(0, 12)}…
                </span>
                <span
                  className={cn(
                    "text-[10px] uppercase",
                    lane.status === "failure" || lane.status === "error"
                      ? "text-[var(--error)]"
                      : "text-[var(--success)]",
                  )}
                >
                  {lane.status}
                </span>
              </button>
              {orgId && traceId && (
                <span className="mt-1 flex items-center gap-1" data-testid="f21-tool-labels">
                  {labeled === "good" || labeled === "bad" ? (
                    <span className="text-[10px] text-[var(--text-muted)]">
                      labeled {labeled}
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Label ${lane.tool_name} good`}
                        className="rounded px-1 py-0.5 text-[10px] border border-[var(--terminal)] text-[var(--terminal)] disabled:opacity-50"
                        onClick={() => void submitLabel(lane, "good")}
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Label ${lane.tool_name} bad`}
                        className="rounded px-1 py-0.5 text-[10px] border border-[var(--error)] text-[var(--error)] disabled:opacity-50"
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
