/**
 * Observe V3 Wave 4 — timeline ↔ transcript sync helpers.
 */
import { describe, expect, it } from "vitest";
import {
  barGeometry,
  brushToWindow,
  buildFallbackTimelineSteps,
  enrichTimelineStepsWithSpanIds,
  fullWindow,
  isFailedOutcome,
  resolveTimelineSteps,
  stepsOverlapWindow,
  zoomWindow,
  type TimelineStep,
} from "@/lib/observability/timeline-sync";

const rows = [
  {
    span_id: "s1",
    name: "agent.run",
    timestamp: "2026-01-01T00:00:00.000Z",
    duration_ms: 100,
    event_type: "agent",
    outcome: null,
  },
  {
    span_id: "s2",
    name: "llm.chat",
    timestamp: "2026-01-01T00:00:00.050Z",
    duration_ms: 40,
    event_type: "llm",
    outcome: "error",
  },
  {
    span_id: "s3",
    name: "tool.search",
    timestamp: "2026-01-01T00:00:00.090Z",
    duration_ms: 20,
    event_type: "tool",
    outcome: null,
  },
];

describe("buildFallbackTimelineSteps", () => {
  it("includes span_id on every step", () => {
    const steps = buildFallbackTimelineSteps(rows);
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => typeof s.span_id === "string")).toBe(true);
    expect(steps[0]).toMatchObject({
      span_id: "s1",
      name: "agent.run",
      start_ms: 0,
      duration_ms: 100,
    });
    expect(steps[1].start_ms).toBe(50);
    expect(steps[1].outcome).toBe("failure");
  });
});

describe("enrichTimelineStepsWithSpanIds", () => {
  it("fills missing span_id by name + closest start_ms", () => {
    const api: TimelineStep[] = [
      {
        name: "agent.run",
        start_ms: 0,
        end_ms: 100,
        duration_ms: 100,
        event_type: "agent",
        outcome: null,
      },
      {
        name: "llm.chat",
        start_ms: 48,
        end_ms: 90,
        duration_ms: 42,
        event_type: "llm",
        outcome: "error",
      },
    ];
    const enriched = enrichTimelineStepsWithSpanIds(api, rows);
    expect(enriched[0].span_id).toBe("s1");
    expect(enriched[1].span_id).toBe("s2");
  });

  it("preserves existing span_id and does not reuse matches", () => {
    const api: TimelineStep[] = [
      {
        name: "llm.chat",
        start_ms: 50,
        end_ms: 90,
        duration_ms: 40,
        event_type: "llm",
        outcome: null,
        span_id: "already",
      },
      {
        name: "llm.chat",
        start_ms: 50,
        end_ms: 90,
        duration_ms: 40,
        event_type: "llm",
        outcome: null,
      },
    ];
    const enriched = enrichTimelineStepsWithSpanIds(api, rows);
    expect(enriched[0].span_id).toBe("already");
    expect(enriched[1].span_id).toBe("s2");
  });
});

describe("resolveTimelineSteps", () => {
  it("uses enriched API steps when present", () => {
    const api: TimelineStep[] = [
      {
        name: "agent.run",
        start_ms: 0,
        end_ms: 100,
        duration_ms: 100,
        event_type: "agent",
        outcome: null,
      },
    ];
    const resolved = resolveTimelineSteps(api, rows);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].span_id).toBe("s1");
  });

  it("falls back to transcript steps when API empty", () => {
    expect(resolveTimelineSteps([], rows)).toHaveLength(3);
    expect(resolveTimelineSteps(undefined, rows)[0].span_id).toBe("s1");
  });
});

describe("zoom / brush / geometry", () => {
  it("zoom in halves window around center", () => {
    const w = fullWindow(1000);
    const next = zoomWindow(w, 1000, "in", 500);
    expect(next.endMs - next.startMs).toBe(500);
    expect(next.startMs).toBe(250);
    expect(next.endMs).toBe(750);
  });

  it("zoom out restores toward full range", () => {
    const mid = { startMs: 250, endMs: 750 };
    const out = zoomWindow(mid, 1000, "out", 500);
    expect(out.startMs).toBe(0);
    expect(out.endMs).toBe(1000);
  });

  it("brushToWindow normalizes and clamps", () => {
    expect(brushToWindow(800, 200, 1000)).toEqual({
      startMs: 200,
      endMs: 800,
    });
    expect(brushToWindow(-10, 50, 100).startMs).toBe(0);
  });

  it("stepsOverlapWindow + barGeometry respect window", () => {
    const steps = buildFallbackTimelineSteps(rows);
    const window = { startMs: 40, endMs: 100 };
    const visible = stepsOverlapWindow(steps, window);
    expect(visible.map((s) => s.span_id)).toEqual(["s1", "s2", "s3"]);
    const geo = barGeometry(steps[1], window);
    expect(geo.leftPct).toBeCloseTo(((50 - 40) / 60) * 100, 5);
    expect(geo.widthPct).toBeGreaterThan(0);
  });

  it("isFailedOutcome uses error/failure", () => {
    expect(isFailedOutcome("error")).toBe(true);
    expect(isFailedOutcome("failure")).toBe(true);
    expect(isFailedOutcome("ok")).toBe(false);
    expect(isFailedOutcome(null)).toBe(false);
  });
});
