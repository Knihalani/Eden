/**
 * Observe V3 Wave 4 — timeline ↔ transcript sync helpers.
 * Pure functions for span_id enrichment, zoom windows, and range brush.
 */

export type TimelineStep = {
  name: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  event_type: string;
  outcome: string | null;
  span_id?: string;
};

export type TimeWindow = { startMs: number; endMs: number };

export type TranscriptTimingRow = {
  span_id: string;
  name: string;
  timestamp: string;
  duration_ms: number;
  event_type?: string | null;
  outcome?: string | null;
};

/** Build Gantt steps from transcript rows (API timeline may omit span_id). */
export function buildFallbackTimelineSteps(
  rows: TranscriptTimingRow[],
): TimelineStep[] {
  if (rows.length === 0) return [];
  const t0 = Math.min(...rows.map((r) => new Date(r.timestamp).getTime()));
  return rows.map((r) => {
    const start = Math.max(0, new Date(r.timestamp).getTime() - t0);
    const duration = Math.max(0, r.duration_ms);
    return {
      name: r.name,
      span_id: r.span_id,
      start_ms: start,
      end_ms: start + duration,
      duration_ms: duration,
      event_type: String(r.event_type ?? "span"),
      outcome:
        r.outcome === "failure" || r.outcome === "error" ? "failure" : null,
    };
  });
}

/**
 * Attach span_id to API timeline steps by matching transcript fallback
 * (name + closest start_ms). Preserves existing span_id when present.
 */
export function enrichTimelineStepsWithSpanIds(
  steps: TimelineStep[],
  rows: TranscriptTimingRow[],
): TimelineStep[] {
  if (steps.length === 0) return steps;
  if (steps.every((s) => s.span_id)) return steps;

  const fallback = buildFallbackTimelineSteps(rows);
  if (fallback.length === 0) return steps;

  const used = new Set<string>();

  return steps.map((step) => {
    if (step.span_id) {
      used.add(step.span_id);
      return step;
    }

    const byName = fallback.filter(
      (f) => f.span_id && f.name === step.name && !used.has(f.span_id),
    );
    const pool =
      byName.length > 0
        ? byName
        : fallback.filter((f) => f.span_id && !used.has(f.span_id));

    if (pool.length === 0) return step;

    const best = [...pool].sort(
      (a, b) =>
        Math.abs(a.start_ms - step.start_ms) -
        Math.abs(b.start_ms - step.start_ms),
    )[0];
    if (!best?.span_id) return step;
    used.add(best.span_id);
    return { ...step, span_id: best.span_id };
  });
}

/** Prefer API steps (enriched); fall back to transcript-derived steps. */
export function resolveTimelineSteps(
  apiSteps: TimelineStep[] | undefined | null,
  rows: TranscriptTimingRow[],
): TimelineStep[] {
  const fallback = buildFallbackTimelineSteps(rows);
  if (apiSteps && apiSteps.length > 0) {
    return enrichTimelineStepsWithSpanIds(apiSteps, rows);
  }
  return fallback;
}

export function fullWindow(totalMs: number): TimeWindow {
  return { startMs: 0, endMs: Math.max(totalMs, 1) };
}

export function windowDuration(w: TimeWindow): number {
  return Math.max(1, w.endMs - w.startMs);
}

/** Zoom in around center (selected span mid or window mid). Min span 1ms. */
export function zoomWindow(
  current: TimeWindow,
  totalMs: number,
  direction: "in" | "out",
  centerMs?: number,
  factor = 0.5,
): TimeWindow {
  const total = Math.max(totalMs, 1);
  const span = windowDuration(current);
  const nextSpan =
    direction === "in"
      ? Math.max(1, span * factor)
      : Math.min(total, span / factor);
  const center = centerMs ?? (current.startMs + current.endMs) / 2;
  let startMs = center - nextSpan / 2;
  let endMs = center + nextSpan / 2;
  if (startMs < 0) {
    endMs -= startMs;
    startMs = 0;
  }
  if (endMs > total) {
    startMs = Math.max(0, startMs - (endMs - total));
    endMs = total;
  }
  return { startMs, endMs };
}

export function stepsOverlapWindow(
  steps: TimelineStep[],
  window: TimeWindow,
): TimelineStep[] {
  return steps.filter(
    (s) => s.end_ms >= window.startMs && s.start_ms <= window.endMs,
  );
}

/** Bar geometry as % within the visible window. */
export function barGeometry(
  step: TimelineStep,
  window: TimeWindow,
): { leftPct: number; widthPct: number } {
  const span = windowDuration(window);
  const left = ((step.start_ms - window.startMs) / span) * 100;
  const width = (step.duration_ms / span) * 100;
  const leftPct = Math.max(0, Math.min(100, left));
  const widthPct = Math.max(0.5, Math.min(100 - leftPct, width));
  return { leftPct, widthPct };
}

export function isFailedOutcome(outcome: string | null | undefined): boolean {
  return outcome === "failure" || outcome === "error";
}

/** Normalize a drag-select pair into a TimeWindow clamped to total. */
export function brushToWindow(
  aMs: number,
  bMs: number,
  totalMs: number,
  minSpanMs = 1,
): TimeWindow {
  const total = Math.max(totalMs, 1);
  let startMs = Math.max(0, Math.min(aMs, bMs));
  let endMs = Math.min(total, Math.max(aMs, bMs));
  if (endMs - startMs < minSpanMs) {
    endMs = Math.min(total, startMs + minSpanMs);
  }
  return { startMs, endMs };
}
