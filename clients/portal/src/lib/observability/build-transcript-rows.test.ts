import { describe, expect, it } from "vitest";
import {
  buildTranscriptRows,
  groupParallelSteps,
  parseLazyPayloadMarker,
  transcriptTimeline,
  type TimedTranscriptStep,
} from "@/lib/observability/build-transcript-rows";

const T0 = Date.parse("2026-08-04T10:00:00.000Z");

function step(
  id: string,
  overrides: Partial<TimedTranscriptStep> = {},
): TimedTranscriptStep {
  return {
    id,
    kind: "tool",
    startedAt: new Date(T0).toISOString(),
    durationMs: 1_000,
    ...overrides,
  };
}

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

describe("groupParallelSteps", () => {
  it("groups same-parent tool steps with overlapping time ranges into lanes", () => {
    const steps = [
      step("llm", { kind: "llm", startedAt: at(0), durationMs: 500 }),
      step("a", { parentId: "llm", startedAt: at(500), durationMs: 2_000 }),
      step("b", { parentId: "llm", startedAt: at(900), durationMs: 2_000 }),
      step("c", { parentId: "llm", startedAt: at(1_200), durationMs: 300 }),
      step("after", { kind: "span", startedAt: at(4_000) }),
    ];

    const rows = groupParallelSteps(steps);
    expect(rows.map((r) => r.type)).toEqual(["step", "parallel", "step"]);
    const par = rows[1];
    if (par.type !== "parallel") throw new Error("expected parallel row");
    expect(par.lanes.map((l) => l.id)).toEqual(["a", "b", "c"]);
    expect(par.id).toBe("par:a");
  });

  it("keeps sequential tool steps as plain rows", () => {
    const steps = [
      step("a", { startedAt: at(0), durationMs: 100 }),
      step("b", { startedAt: at(200), durationMs: 100 }),
    ];
    expect(groupParallelSteps(steps).map((r) => r.type)).toEqual([
      "step",
      "step",
    ]);
  });

  it("never groups across different parents", () => {
    const steps = [
      step("a", { parentId: "p1", startedAt: at(0), durationMs: 5_000 }),
      step("b", { parentId: "p2", startedAt: at(100), durationMs: 5_000 }),
    ];
    expect(groupParallelSteps(steps).map((r) => r.type)).toEqual([
      "step",
      "step",
    ]);
  });

  it("never groups steps whose timestamps are missing or unparseable", () => {
    const steps = [
      step("a", { startedAt: undefined }),
      step("b", { startedAt: undefined }),
      step("c", { startedAt: "2m ago" }),
      step("d", { startedAt: "2m ago" }),
    ];
    expect(groupParallelSteps(steps).every((r) => r.type === "step")).toBe(
      true,
    );
  });

  it("never groups non-tool steps, even when they overlap", () => {
    const steps = [
      step("a", { kind: "llm", startedAt: at(0), durationMs: 5_000 }),
      step("b", { kind: "llm", startedAt: at(100), durationMs: 5_000 }),
    ];
    expect(groupParallelSteps(steps).every((r) => r.type === "step")).toBe(
      true,
    );
  });

  it("preserves step order and drops nothing", () => {
    const steps = [
      step("s0", { kind: "task", startedAt: at(0), durationMs: 10_000 }),
      step("s1", { startedAt: at(100), durationMs: 3_000 }),
      step("s2", { startedAt: at(200), durationMs: 3_000 }),
      step("s3", { startedAt: at(5_000), durationMs: 100 }),
    ];
    const rows = groupParallelSteps(steps);
    const flat = rows.flatMap((r) =>
      r.type === "step" ? [r.step.id] : r.lanes.map((l) => l.id),
    );
    expect(flat).toEqual(["s0", "s1", "s2", "s3"]);
  });
});

describe("transcriptTimeline", () => {
  it("builds t0-relative geometry via the timeline-sync builder", () => {
    const steps = [
      step("a", { startedAt: at(0), durationMs: 1_000 }),
      step("b", { startedAt: at(500), durationMs: 250 }),
      step("no-time", { startedAt: undefined }),
    ];
    const timeline = transcriptTimeline(steps);
    expect(timeline.map((t) => t.span_id)).toEqual(["a", "b"]);
    expect(timeline[0]).toMatchObject({ start_ms: 0, end_ms: 1_000 });
    expect(timeline[1]).toMatchObject({ start_ms: 500, end_ms: 750 });
  });
});

describe("parseLazyPayloadMarker", () => {
  it("parses a direct F82 marker", () => {
    const raw = JSON.stringify({ _lazy: true, preview: "abc…", bytes: 9001 });
    expect(parseLazyPayloadMarker(raw)).toEqual({
      preview: "abc…",
      bytes: 9001,
    });
  });

  it("finds a marker one level down (tool call arguments)", () => {
    const raw = JSON.stringify([
      {
        type: "function",
        name: "search",
        arguments: { _lazy: true, preview: "big…", bytes: 5000 },
      },
    ]);
    expect(parseLazyPayloadMarker(raw)).toEqual({
      preview: "big…",
      bytes: 5000,
    });
  });

  it("returns null for ordinary payloads and non-JSON text", () => {
    expect(parseLazyPayloadMarker("plain text output")).toBeNull();
    expect(parseLazyPayloadMarker(JSON.stringify({ ok: true }))).toBeNull();
    expect(parseLazyPayloadMarker(undefined)).toBeNull();
    expect(parseLazyPayloadMarker('{"broken json"')).toBeNull();
  });

  it("round-trips a marker produced by buildTranscriptRows lazyToolPayloads", () => {
    const bigResult = "x".repeat(5_000);
    const rows = buildTranscriptRows(
      [
        {
          span_id: "sp1",
          name: "tool: search",
          span_type: "tool_result",
          timestamp: at(0),
          duration_ms: 42,
          payload: { tool_call_id: "c1", result: bigResult },
        },
      ],
      { lazyToolPayloads: true },
    );
    expect(rows).toHaveLength(1);
    const content = rows[0].tool_results?.[0]?.content;
    const marker = parseLazyPayloadMarker(JSON.stringify(content));
    expect(marker).not.toBeNull();
    expect(marker?.bytes).toBe(5_000);
    expect(marker?.preview.length).toBeLessThan(1_300);
  });
});
