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
import { TraceTimelineView } from "@/components/traces/trace-detail-views";
import type { TimelineStep } from "@/lib/observability/timeline-sync";
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
            // Keep existing preference; only seed new subagents as collapsed.
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
      if (!root || !root.contains(document.activeElement) && document.activeElement !== root) {
        // Allow j/k when focus is inside reader or on a step row
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
      <p className="p-4 text-sm text-[var(--text-muted)]">
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
          <TraceTimelineView
            loading={timelineLoading && timelineSteps.length === 0}
            error={timelineError}
            steps={timelineSteps}
            totalMs={timelineTotalMs}
            markers={timelineMarkers}
            selectedSpanId={selectedSpanId}
            onSpanSelect={(spanId) => onSelectSpan(spanId)}
            variant="strip"
          />
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        <VirtualTranscript items={items} overscan={12} />
      </div>
    </div>
  );
}
