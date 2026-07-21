"use client";

import { useMemo, useRef, useState, type PointerEvent as REPointerEvent } from "react";
import { ChevronRight, Loader2, Minus, Plus, Search, X } from "lucide-react";
import { ErrorState } from "@/components/ui/error-state";
import { cn } from "@/lib/utils";
import { filterSpanTreeKeepingAncestors } from "@/lib/observability/build-transcript-rows";
import type { TranscriptRow } from "@/lib/observability/types";
import {
  barGeometry,
  brushToWindow,
  fullWindow,
  isFailedOutcome,
  stepsOverlapWindow,
  zoomWindow,
  type TimelineStep,
  type TimeWindow,
} from "@/lib/observability/timeline-sync";

function formatTreeTokens(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function formatTreeCostUsd(usd: number | null | undefined): string | null {
  if (usd == null) return null;
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Inline latency · tokens · $ — duration always; tokens/$ only when present. */
export function SpanTreeMetrics({ node }: { node: TranscriptRow }) {
  const tokens =
    node.input_tokens != null || node.output_tokens != null
      ? `${formatTreeTokens(node.input_tokens ?? 0) ?? "0"}→${formatTreeTokens(node.output_tokens ?? 0) ?? "0"}`
      : null;
  const cost = formatTreeCostUsd(node.cost_usd ?? null);

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-[var(--text-muted)]">
      <span>{node.duration_ms.toFixed(0)}ms</span>
      {tokens ? <span className="text-[var(--text-muted)]/80">{tokens}</span> : null}
      {cost ? <span className="text-[var(--text-muted)]/80">{cost}</span> : null}
    </span>
  );
}

export function SpanTreeNode({
  node,
  depth,
  selectedSpanId,
  onSpanSelect,
  forceOpen,
}: {
  node: TranscriptRow;
  depth: number;
  selectedSpanId?: string | null;
  onSpanSelect?: (spanId: string) => void;
  /** When searching, expand every remaining ancestor path. */
  forceOpen?: boolean;
}) {
  const kids = node.children ?? [];
  const [open, setOpen] = useState(depth < 2);
  const expanded = forceOpen || open;
  const failed = isFailedOutcome(node.outcome);
  const selected = selectedSpanId != null && selectedSpanId === node.span_id;

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--bg-secondary)]",
          selected && "bg-[var(--bg-secondary)] ring-1 ring-[var(--border)]",
        )}
        style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
      >
        {kids.length > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="inline-block w-3 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => onSpanSelect?.(node.span_id)}
          aria-current={selected ? "true" : undefined}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              failed ? "bg-[var(--error)]" : "bg-[var(--terminal)]/70",
            )}
            title={node.outcome ?? "ok"}
          />
          <span className="min-w-0 truncate text-[var(--text-secondary)]" title={node.name}>
            {node.name}
          </span>
          <SpanTreeMetrics node={node} />
          <span className="shrink-0 text-[var(--text-muted)]/70">
            {node.span_id.slice(0, 8)}
          </span>
        </button>
      </div>
      {expanded && kids.length > 0 ? (
        <ul>
          {kids.map((child) => (
            <SpanTreeNode
              key={child.span_id}
              node={child}
              depth={depth + 1}
              selectedSpanId={selectedSpanId}
              onSpanSelect={onSpanSelect}
              forceOpen={forceOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TraceTreeView({
  roots,
  selectedSpanId,
  onSpanSelect,
}: {
  roots: TranscriptRow[];
  selectedSpanId?: string | null;
  onSpanSelect?: (spanId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => filterSpanTreeKeepingAncestors(roots, query),
    [roots, query],
  );
  const searching = query.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-col" data-testid="trace-span-tree">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter spans…"
          aria-label="Filter span tree"
          data-testid="trace-tree-search"
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        {searching ? (
          <span className="shrink-0 text-2xs text-[var(--text-muted)]">
            {filtered.length === 0 ? "No matches" : "Path kept"}
          </span>
        ) : null}
      </div>
      {filtered.length === 0 ? (
        <p className="p-4 text-sm text-[var(--text-muted)]">
          {searching ? "No spans match this filter." : "No spans in tree."}
        </p>
      ) : (
        <ul className="space-y-0.5 p-2 font-mono text-2xs">
          {filtered.map((node) => (
            <SpanTreeNode
              key={node.span_id}
              node={node}
              depth={0}
              selectedSpanId={selectedSpanId}
              onSpanSelect={onSpanSelect}
              forceOpen={searching}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TimelineZoomControls({
  window,
  totalMs,
  selectedCenterMs,
  onWindowChange,
  brushed,
}: {
  window: TimeWindow;
  totalMs: number;
  selectedCenterMs?: number;
  onWindowChange: (w: TimeWindow) => void;
  brushed: boolean;
}) {
  const isFull =
    window.startMs <= 0 && window.endMs >= Math.max(totalMs, 1) - 0.001;

  return (
    <div className="flex items-center gap-1" data-testid="timeline-zoom-controls">
      <button
        type="button"
        aria-label="Zoom in"
        data-testid="timeline-zoom-in"
        className="rounded border border-[var(--border-subtle)] p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        onClick={() =>
          onWindowChange(zoomWindow(window, totalMs, "in", selectedCenterMs))
        }
      >
        <Plus className="h-3 w-3" />
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        data-testid="timeline-zoom-out"
        className="rounded border border-[var(--border-subtle)] p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        onClick={() =>
          onWindowChange(zoomWindow(window, totalMs, "out", selectedCenterMs))
        }
      >
        <Minus className="h-3 w-3" />
      </button>
      {!isFull || brushed ? (
        <button
          type="button"
          aria-label="Reset time range"
          data-testid="timeline-zoom-reset"
          className="inline-flex items-center gap-0.5 rounded border border-[var(--border-subtle)] px-1 py-0.5 text-2xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => onWindowChange(fullWindow(totalMs))}
        >
          <X className="h-2.5 w-2.5" />
          Reset
        </button>
      ) : null}
    </div>
  );
}

function useTimelineBrush({
  totalMs,
  window,
  onWindowChange,
}: {
  totalMs: number;
  window: TimeWindow;
  onWindowChange: (w: TimeWindow) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number | null>(null);
  const [draft, setDraft] = useState<{ leftPct: number; widthPct: number } | null>(
    null,
  );

  const msAtClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return window.startMs;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
    return window.startMs + pct * (window.endMs - window.startMs);
  };

  const onPointerDown = (e: REPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartX.current = e.clientX;
    setDraft({ leftPct: 0, widthPct: 0 });
  };

  const onPointerMove = (e: REPointerEvent<HTMLDivElement>) => {
    if (dragStartX.current == null || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const a = Math.max(0, Math.min(1, (dragStartX.current - rect.left) / rect.width));
    const b = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const left = Math.min(a, b) * 100;
    const width = Math.abs(b - a) * 100;
    setDraft({ leftPct: left, widthPct: Math.max(width, 0.5) });
  };

  const onPointerUp = (e: REPointerEvent<HTMLDivElement>) => {
    if (dragStartX.current == null) return;
    const startMs = msAtClientX(dragStartX.current);
    const endMs = msAtClientX(e.clientX);
    dragStartX.current = null;
    setDraft(null);
    if (Math.abs(endMs - startMs) < Math.max(1, (window.endMs - window.startMs) * 0.02)) {
      return;
    }
    onWindowChange(brushToWindow(startMs, endMs, totalMs));
  };

  return { trackRef, draft, onPointerDown, onPointerMove, onPointerUp };
}

export function TraceTimelineView({
  loading,
  error,
  steps,
  totalMs,
  markers,
  selectedSpanId,
  onSpanSelect,
  variant = "full",
}: {
  loading: boolean;
  error: string | null;
  steps: TimelineStep[];
  totalMs: number;
  markers: Array<{ at_ms: number; label: string; severity: string }>;
  selectedSpanId?: string | null;
  onSpanSelect?: (spanId: string) => void;
  /** `strip` = thin overview for transcript mode; `full` = labeled Gantt. */
  variant?: "full" | "strip";
}) {
  const total = Math.max(totalMs, 1);
  const [viewWindow, setViewWindow] = useState<TimeWindow>(() => fullWindow(total));
  const [brushed, setBrushed] = useState(false);

  const setWindow = (w: TimeWindow) => {
    setViewWindow(w);
    const isFull = w.startMs <= 0 && w.endMs >= total - 0.001;
    setBrushed(!isFull);
  };

  // Keep window in sync when totalMs changes (new trace).
  const windowForTotal = useMemo(() => {
    if (viewWindow.endMs > total || viewWindow.startMs > total) {
      return fullWindow(total);
    }
    return viewWindow;
  }, [total, viewWindow]);

  const selectedCenterMs = useMemo(() => {
    const sel = steps.find((s) => s.span_id && s.span_id === selectedSpanId);
    if (!sel) return undefined;
    return (sel.start_ms + sel.end_ms) / 2;
  }, [steps, selectedSpanId]);

  const visible = useMemo(
    () => stepsOverlapWindow(steps, windowForTotal),
    [steps, windowForTotal],
  );

  const brush = useTimelineBrush({
    totalMs: total,
    window: windowForTotal,
    onWindowChange: setWindow,
  });

  if (loading) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        <p className="text-xs text-[var(--text-muted)]">Loading timeline…</p>
      </div>
    );
  }

  if (error && steps.length === 0) {
    return <ErrorState title="Could not load timeline" message={error} />;
  }

  if (steps.length === 0) {
    return (
      <p className="p-4 text-sm text-[var(--text-muted)]">No timeline steps for this trace.</p>
    );
  }

  if (variant === "strip") {
    return (
      <div
        className="space-y-1 px-1 py-1"
        data-testid="trace-timeline-strip"
        data-variant="strip"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-2xs text-[var(--text-muted)]">
            Gantt · {visible.length}/{steps.length}
            {brushed ? " · filtered" : ""}
          </p>
          <TimelineZoomControls
            window={windowForTotal}
            totalMs={total}
            selectedCenterMs={selectedCenterMs}
            onWindowChange={setWindow}
            brushed={brushed}
          />
        </div>
        <div
          ref={brush.trackRef}
          className="relative h-7 cursor-crosshair rounded bg-[var(--bg-secondary)]"
          data-testid="timeline-brush-track"
          onPointerDown={brush.onPointerDown}
          onPointerMove={brush.onPointerMove}
          onPointerUp={brush.onPointerUp}
        >
          {markers.map((m) => (
            <div
              key={`${m.at_ms}-${m.label}`}
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--warning)]/60"
              style={{
                left: `${Math.min(100, ((m.at_ms - windowForTotal.startMs) / (windowForTotal.endMs - windowForTotal.startMs)) * 100)}%`,
              }}
              title={m.label}
            />
          ))}
          {brush.draft ? (
            <div
              className="pointer-events-none absolute inset-y-0 bg-[var(--text-primary)]/10"
              style={{
                left: `${brush.draft.leftPct}%`,
                width: `${brush.draft.widthPct}%`,
              }}
            />
          ) : null}
          {visible.map((s, i) => {
            const { leftPct, widthPct } = barGeometry(s, windowForTotal);
            const failed = isFailedOutcome(s.outcome);
            const selected =
              s.span_id != null && selectedSpanId != null && s.span_id === selectedSpanId;
            const selectable = Boolean(s.span_id && onSpanSelect);
            return (
              <button
                key={`${s.span_id ?? s.name}-${i}`}
                type="button"
                disabled={!selectable}
                data-span-id={s.span_id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (s.span_id) onSpanSelect?.(s.span_id);
                }}
                className={cn(
                  "absolute top-1 bottom-1 rounded-sm",
                  failed ? "bg-[var(--error)]/85" : "bg-[var(--terminal)]/65",
                  selectable && "cursor-pointer hover:opacity-90",
                  !selectable && "cursor-default",
                  selected && "ring-1 ring-[var(--text-primary)] z-[1]",
                )}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                title={`${s.name}: ${s.duration_ms.toFixed(0)}ms`}
                aria-label={selectable ? `Select span ${s.name}` : undefined}
                aria-current={selected ? "true" : undefined}
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3" data-testid="trace-timeline" data-variant="full">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs text-[var(--text-muted)]">
          Condensed Gantt · {visible.length}/{steps.length} steps ·{" "}
          {(windowForTotal.endMs - windowForTotal.startMs).toFixed(0)}ms
          {brushed ? " window" : ""}
        </p>
        <div className="flex items-center gap-2">
          {error ? (
            <p className="text-2xs text-[var(--warning)]">
              API timeline unavailable — using span tree
            </p>
          ) : null}
          <TimelineZoomControls
            window={windowForTotal}
            totalMs={total}
            selectedCenterMs={selectedCenterMs}
            onWindowChange={setWindow}
            brushed={brushed}
          />
        </div>
      </div>
      <div
        ref={brush.trackRef}
        className="relative space-y-1.5"
        data-testid="timeline-brush-track"
        onPointerDown={brush.onPointerDown}
        onPointerMove={brush.onPointerMove}
        onPointerUp={brush.onPointerUp}
      >
        {brush.draft ? (
          <div
            className="pointer-events-none absolute inset-y-0 z-[1] bg-[var(--text-primary)]/8"
            style={{
              left: `${brush.draft.leftPct}%`,
              width: `${brush.draft.widthPct}%`,
            }}
          />
        ) : null}
        {markers.map((m) => (
          <div
            key={`${m.at_ms}-${m.label}`}
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--warning)]/60"
            style={{
              left: `${Math.min(100, ((m.at_ms - windowForTotal.startMs) / (windowForTotal.endMs - windowForTotal.startMs)) * 100)}%`,
            }}
            title={m.label}
          />
        ))}
        {visible.map((s, i) => {
          const { leftPct, widthPct } = barGeometry(s, windowForTotal);
          const failed = isFailedOutcome(s.outcome);
          const selected =
            s.span_id != null && selectedSpanId != null && s.span_id === selectedSpanId;
          const selectable = Boolean(s.span_id && onSpanSelect);
          return (
            <div
              key={`${s.span_id ?? s.name}-${i}`}
              className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2"
            >
              <span className="truncate font-mono text-2xs text-[var(--text-secondary)]" title={s.name}>
                {s.name}
              </span>
              <div className="relative h-5 rounded bg-[var(--bg-secondary)]">
                <button
                  type="button"
                  disabled={!selectable}
                  data-span-id={s.span_id}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (s.span_id) onSpanSelect?.(s.span_id);
                  }}
                  className={cn(
                    "absolute top-0.5 bottom-0.5 rounded",
                    failed ? "bg-[var(--error)]/80" : "bg-[var(--terminal)]/70",
                    selectable && "cursor-pointer hover:opacity-90",
                    !selectable && "cursor-default",
                    selected && "ring-1 ring-[var(--text-primary)]",
                  )}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`${s.name}: ${s.duration_ms.toFixed(0)}ms`}
                  aria-label={selectable ? `Select span ${s.name}` : undefined}
                  aria-current={selected ? "true" : undefined}
                />
              </div>
              <span className="w-12 text-right font-mono text-2xs text-[var(--text-muted)]">
                {s.duration_ms.toFixed(0)}ms
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-2xs text-[var(--text-muted)]">
        Drag across bars to brush a time range. Zoom ± centers on selected span.
      </p>
    </div>
  );
}
