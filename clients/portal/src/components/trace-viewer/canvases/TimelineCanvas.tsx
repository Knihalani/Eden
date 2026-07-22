"use client";

import * as React from "react";
import { Loader2, Minus, Plus, X } from "lucide-react";
import { ErrorState } from "@/components/ui/error-state";
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
import { cn } from "@/lib/utils";

export interface TimelineCanvasProps {
  loading: boolean;
  error: string | null;
  steps: TimelineStep[];
  totalMs: number;
  markers: Array<{ at_ms: number; label: string; severity: string }>;
  selectedSpanId: string | null;
  onSpanSelect: (spanId: string) => void;
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
  const trackRef = React.useRef<HTMLDivElement>(null);
  const dragStartX = React.useRef<number | null>(null);
  const [draft, setDraft] = React.useState<{
    leftPct: number;
    widthPct: number;
  } | null>(null);

  const msAtClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return window.startMs;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(
      0,
      Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)),
    );
    return window.startMs + pct * (window.endMs - window.startMs);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartX.current = e.clientX;
    setDraft({ leftPct: 0, widthPct: 0 });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartX.current == null || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const a = Math.max(
      0,
      Math.min(1, (dragStartX.current - rect.left) / rect.width),
    );
    const b = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setDraft({
      leftPct: Math.min(a, b) * 100,
      widthPct: Math.max(Math.abs(b - a) * 100, 0.5),
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartX.current == null) return;
    const startMs = msAtClientX(dragStartX.current);
    const endMs = msAtClientX(e.clientX);
    dragStartX.current = null;
    setDraft(null);
    if (
      Math.abs(endMs - startMs) <
      Math.max(1, (window.endMs - window.startMs) * 0.02)
    ) {
      return;
    }
    onWindowChange(brushToWindow(startMs, endMs, totalMs));
  };

  return { trackRef, draft, onPointerDown, onPointerMove, onPointerUp };
}

/** Own Gantt UI — timeline-sync math only, distinctive labeled rows. */
export function TimelineCanvas({
  loading,
  error,
  steps,
  totalMs,
  markers,
  selectedSpanId,
  onSpanSelect,
}: TimelineCanvasProps) {
  const total = Math.max(totalMs, 1);
  const [viewWindow, setViewWindow] = React.useState<TimeWindow>(() =>
    fullWindow(total),
  );
  const [brushed, setBrushed] = React.useState(false);

  const setWindow = (w: TimeWindow) => {
    setViewWindow(w);
    const isFull = w.startMs <= 0 && w.endMs >= total - 0.001;
    setBrushed(!isFull);
  };

  const windowForTotal = React.useMemo(() => {
    if (viewWindow.endMs > total || viewWindow.startMs > total) {
      return fullWindow(total);
    }
    return viewWindow;
  }, [total, viewWindow]);

  const selectedCenterMs = React.useMemo(() => {
    const sel = steps.find((s) => s.span_id && s.span_id === selectedSpanId);
    if (!sel) return undefined;
    return (sel.start_ms + sel.end_ms) / 2;
  }, [steps, selectedSpanId]);

  const visible = React.useMemo(
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
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2"
        data-testid="timeline-canvas"
      >
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        <p className="text-xs text-[var(--text-muted)]">Loading timeline…</p>
      </div>
    );
  }

  if (error && steps.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="timeline-canvas">
        <ErrorState title="Could not load timeline" message={error} />
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="min-h-0 flex-1 p-4" data-testid="timeline-canvas">
        <p className="text-sm text-[var(--text-muted)]">No timeline steps for this trace.</p>
      </div>
    );
  }

  const isFull =
    windowForTotal.startMs <= 0 &&
    windowForTotal.endMs >= Math.max(total, 1) - 0.001;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="timeline-canvas"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <p className="text-xs text-[var(--text-muted)]">
          Timeline · {visible.length}/{steps.length} ·{" "}
          {(windowForTotal.endMs - windowForTotal.startMs).toFixed(0)}ms
          {brushed ? " window" : ""}
        </p>
        <div className="flex items-center gap-1" data-testid="timeline-zoom-controls">
          {error ? (
            <p className="mr-2 text-2xs text-[var(--warning)]">
              API unavailable — span timing
            </p>
          ) : null}
          <button
            type="button"
            aria-label="Zoom in"
            data-testid="timeline-zoom-in"
            className="rounded border border-[var(--border-subtle)] p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            onClick={() =>
              setWindow(zoomWindow(windowForTotal, total, "in", selectedCenterMs))
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
              setWindow(zoomWindow(windowForTotal, total, "out", selectedCenterMs))
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
              onClick={() => setWindow(fullWindow(total))}
            >
              <X className="h-2.5 w-2.5" />
              Reset
            </button>
          ) : null}
        </div>
      </div>

      <div
        ref={brush.trackRef}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3"
        data-testid="timeline-brush-track"
        data-testid-legacy="trace-timeline"
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
              left: `${Math.min(
                100,
                ((m.at_ms - windowForTotal.startMs) /
                  (windowForTotal.endMs - windowForTotal.startMs)) *
                  100,
              )}%`,
            }}
            title={m.label}
          />
        ))}
        {visible.map((s, i) => {
          const { leftPct, widthPct } = barGeometry(s, windowForTotal);
          const failed = isFailedOutcome(s.outcome);
          const selected =
            s.span_id != null &&
            selectedSpanId != null &&
            s.span_id === selectedSpanId;
          const selectable = Boolean(s.span_id && onSpanSelect);
          return (
            <div
              key={`${s.span_id ?? s.name}-${i}`}
              className="grid grid-cols-[minmax(0,9rem)_1fr_3.5rem] items-center gap-2"
            >
              <button
                type="button"
                disabled={!selectable}
                onClick={() => {
                  if (s.span_id) onSpanSelect(s.span_id);
                }}
                className={cn(
                  "truncate text-left text-[11px] text-[var(--text-secondary)]",
                  selectable && "hover:text-[var(--text-primary)]",
                  selected && "font-medium text-[var(--text-primary)]",
                )}
                title={s.name}
              >
                {s.name}
              </button>
              <div className="relative h-6 rounded bg-[var(--bg-tertiary)]/50">
                <button
                  type="button"
                  disabled={!selectable}
                  data-span-id={s.span_id}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (s.span_id) onSpanSelect(s.span_id);
                  }}
                  className={cn(
                    "absolute top-1 bottom-1 rounded-sm",
                    failed ? "bg-[var(--error)]/90" : "bg-[var(--accent)]/75",
                    selectable && "cursor-pointer hover:opacity-95",
                    !selectable && "cursor-default",
                    selected && "ring-1 ring-[var(--text-primary)] z-[1]",
                  )}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`${s.name}: ${s.duration_ms.toFixed(0)}ms`}
                  aria-label={selectable ? `Select span ${s.name}` : undefined}
                  aria-current={selected ? "true" : undefined}
                />
              </div>
              <span className="text-right font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
                {s.duration_ms.toFixed(0)}ms
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
