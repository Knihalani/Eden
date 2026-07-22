"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { TranscriptRow } from "@/lib/observability/types";
import { isInternalFrameworkSpan } from "@/lib/observability/elide";
import {
  VirtualTranscript,
  TRANSCRIPT_ROW_ESTIMATE,
} from "@/components/transcript-v2/VirtualTranscript";
import {
  barGeometry,
  fullWindow,
  isFailedOutcome,
  type TimelineStep,
} from "@/lib/observability/timeline-sync";
import { cn } from "@/lib/utils";
import { TranscriptStepRow } from "../TranscriptStepRow";

function filterInternal(rows: TranscriptRow[]): TranscriptRow[] {
  const walk = (rs: TranscriptRow[]): TranscriptRow[] => {
    const out: TranscriptRow[] = [];
    for (const r of rs) {
      if (isInternalFrameworkSpan(r.name)) continue;
      const child = r.children ? walk(r.children) : undefined;
      out.push({ ...r, children: child });
    }
    return out;
  };
  return walk(rows);
}

function flattenVisible(
  rows: TranscriptRow[],
  collapsed: Set<string>,
  depth = 0,
): Array<{ row: TranscriptRow; depth: number }> {
  const out: Array<{ row: TranscriptRow; depth: number }> = [];
  for (const r of rows) {
    out.push({ row: r, depth });
    const kids = r.children ?? [];
    if (kids.length > 0 && !collapsed.has(r.span_id)) {
      out.push(...flattenVisible(kids, collapsed, depth + 1));
    }
  }
  return out;
}

export interface TranscriptCanvasProps {
  rows: TranscriptRow[];
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
  spanSearch?: string;
  ganttStripOpen: boolean;
  onToggleGantt: () => void;
  timelineSteps: TimelineStep[];
  timelineTotalMs: number;
  timelineLoading: boolean;
  timelineError: string | null;
  timelineMarkers?: Array<{ at_ms: number; label: string; severity: string }>;
  failureOutcome?: string | null;
  issuesHref?: string;
  liveWaiting?: boolean;
  readerRef?: React.RefObject<HTMLDivElement | null>;
}

export function TranscriptCanvas({
  rows,
  selectedSpanId,
  onSelectSpan,
  spanSearch = "",
  ganttStripOpen,
  onToggleGantt,
  timelineSteps,
  timelineTotalMs,
  timelineLoading,
  timelineError,
  timelineMarkers = [],
  failureOutcome,
  issuesHref,
  liveWaiting,
  readerRef,
}: TranscriptCanvasProps) {
  const visible = React.useMemo(() => filterInternal(rows), [rows]);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    const init = new Set<string>();
    const walk = (rs: TranscriptRow[]) => {
      for (const r of rs) {
        if (r.is_subagent || (r.children?.length ?? 0) > 0) {
          init.add(r.span_id);
        }
        if (r.children) walk(r.children);
      }
    };
    walk(visible);
    return init;
  });

  React.useEffect(() => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const walk = (rs: TranscriptRow[]) => {
        for (const r of rs) {
          if ((r.is_subagent || (r.children?.length ?? 0) > 0) && !next.has(r.span_id)) {
            if (!prev.has(r.span_id) && prev.size === 0) next.add(r.span_id);
          }
          if (r.children) walk(r.children);
        }
      };
      walk(visible);
      return next;
    });
  }, [visible]);

  const flat = React.useMemo(
    () => flattenVisible(visible, collapsed),
    [visible, collapsed],
  );

  const filtered = React.useMemo(() => {
    const q = spanSearch.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter(
      ({ row }) =>
        row.name.toLowerCase().includes(q) ||
        row.span_id.toLowerCase().includes(q) ||
        (row.event_type ?? "").toLowerCase().includes(q),
    );
  }, [flat, spanSearch]);

  const spanIds = React.useMemo(() => filtered.map((f) => f.row.span_id), [filtered]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const root = readerRef?.current;
      if (!root || (!root.contains(document.activeElement) && document.activeElement !== root)) {
        if (!root?.contains(document.activeElement)) return;
      }
      if (e.key !== "j" && e.key !== "k" && e.key !== "Enter") return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (spanIds.length === 0) return;
      const idx = selectedSpanId ? spanIds.indexOf(selectedSpanId) : -1;
      if (e.key === "j") {
        e.preventDefault();
        const next = spanIds[Math.min(spanIds.length - 1, Math.max(0, idx + 1))]!;
        onSelectSpan(next);
      } else if (e.key === "k") {
        e.preventDefault();
        const next = spanIds[Math.max(0, idx <= 0 ? 0 : idx - 1)]!;
        onSelectSpan(next);
      } else if (e.key === "Enter" && selectedSpanId) {
        e.preventDefault();
        onSelectSpan(selectedSpanId);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [spanIds, selectedSpanId, onSelectSpan, readerRef]);

  React.useEffect(() => {
    if (!selectedSpanId) return;
    const el = document.querySelector(`[data-span-id="${CSS.escape(selectedSpanId)}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedSpanId]);

  if (visible.length === 0) {
    return (
      <p className="p-4 text-sm text-[var(--text-muted)]" data-testid="transcript-canvas">
        {liveWaiting ? "Waiting for live steps…" : "No transcript steps found."}
      </p>
    );
  }

  const items = filtered.map(({ row, depth }) => ({
    key: row.span_id,
    estimate: TRANSCRIPT_ROW_ESTIMATE / 2,
    content: (
      <TranscriptStepRow
        row={row}
        depth={depth}
        selected={selectedSpanId === row.span_id}
        collapsed={collapsed.has(row.span_id)}
        childCount={row.children?.length ?? 0}
        onSelect={() => onSelectSpan(row.span_id)}
        onToggleCollapse={
          (row.children?.length ?? 0) > 0
            ? () =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.span_id)) next.delete(row.span_id);
                  else next.add(row.span_id);
                  return next;
                })
            : undefined
        }
      />
    ),
  }));

  const window = fullWindow(Math.max(timelineTotalMs, 1));

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-space-2"
      data-testid="transcript-canvas"
      data-transcript-reader
      ref={readerRef}
      tabIndex={-1}
    >
      {failureOutcome ? (
        <div
          data-testid="trace-failure-callout"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-[var(--error)]/25 bg-[var(--error)]/5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)]"
        >
          <span>
            Trace outcome{" "}
            <span className="font-mono uppercase text-[var(--error)]">{failureOutcome}</span>.
          </span>
          {issuesHref ? (
            <Link href={issuesHref} className="font-medium text-[var(--accent)] hover:underline">
              View related issues
            </Link>
          ) : null}
        </div>
      ) : null}

      <div
        className="shrink-0 rounded border border-[var(--border-subtle)]"
        data-testid="transcript-gantt-strip"
      >
        <button
          type="button"
          data-testid="transcript-gantt-toggle"
          aria-expanded={ganttStripOpen}
          onClick={onToggleGantt}
          className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-2xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 transition-transform",
              ganttStripOpen && "rotate-90",
            )}
          />
          Timeline overview
          <span className="ml-auto tabular-nums">{timelineSteps.length} spans</span>
        </button>
        {ganttStripOpen ? (
          <div className="space-y-1 px-2 pb-2" data-testid="trace-timeline-strip" data-variant="strip">
            {timelineLoading && timelineSteps.length === 0 ? (
              <p className="py-2 text-2xs text-[var(--text-muted)]">Loading…</p>
            ) : timelineError && timelineSteps.length === 0 ? (
              <p className="py-2 text-2xs text-[var(--warning)]">{timelineError}</p>
            ) : timelineSteps.length === 0 ? (
              <p className="py-2 text-2xs text-[var(--text-muted)]">No steps</p>
            ) : (
              <div className="relative h-7 cursor-default rounded bg-[var(--bg-tertiary)]/40">
                {timelineMarkers.map((m) => (
                  <div
                    key={`${m.at_ms}-${m.label}`}
                    className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--warning)]/60"
                    style={{
                      left: `${Math.min(100, (m.at_ms / Math.max(timelineTotalMs, 1)) * 100)}%`,
                    }}
                    title={m.label}
                  />
                ))}
                {timelineSteps.map((s, i) => {
                  const { leftPct, widthPct } = barGeometry(s, window);
                  const failed = isFailedOutcome(s.outcome);
                  const selected =
                    s.span_id != null &&
                    selectedSpanId != null &&
                    s.span_id === selectedSpanId;
                  return (
                    <button
                      key={`${s.span_id ?? s.name}-${i}`}
                      type="button"
                      disabled={!s.span_id}
                      data-span-id={s.span_id}
                      onClick={() => {
                        if (s.span_id) onSelectSpan(s.span_id);
                      }}
                      className={cn(
                        "absolute top-1 bottom-1 rounded-sm",
                        failed ? "bg-[var(--error)]/85" : "bg-[var(--accent)]/65",
                        selected && "ring-1 ring-[var(--text-primary)] z-[1]",
                      )}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={`${s.name}: ${s.duration_ms.toFixed(0)}ms`}
                    />
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--border-subtle)]">
        <VirtualTranscript items={items} overscan={12} />
      </div>
    </div>
  );
}
