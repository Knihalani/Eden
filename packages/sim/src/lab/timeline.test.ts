import { describe, expect, test } from "bun:test";
import { bootstrap, breakdown, covered, perSecond, quantile, spansOf, Timeline, type Span } from "./timeline";

const span = (ev: string, cat: Span["cat"], start: number, end: number, lane: Span["lane"] = "path"): Span => ({
  ev,
  cat,
  lane,
  start,
  end,
});

describe("timeline: the arithmetic behind pi-ab's report", () => {
  test("begin and end pair into spans on the task's clock; an unclosed span ends at the last event", () => {
    const tl = new Timeline(1_000);
    const a = tl.begin("model.request", "model", "path", { turn: 1 }, 1_100);
    tl.point("model.first-token", undefined, 1_150);
    tl.end(a, { in: 10 }, 1_400);
    tl.begin("eden.slow", "eden", "bg", undefined, 1_200);
    tl.point("task.end", undefined, 1_500);
    const spans = spansOf(tl.events);
    expect(spans).toEqual([
      { ev: "model.request", cat: "model", lane: "path", start: 100, end: 400, data: { turn: 1, in: 10 } },
      { ev: "eden.slow", cat: "eden", lane: "bg", start: 200, end: 500 },
    ]);
  });

  test("a timeline is bounded: past its cap, events are counted as dropped, not kept", () => {
    const tl = new Timeline(0, 3);
    for (let i = 0; i < 5; i++) tl.point("x", undefined, i);
    expect(tl.events.length).toBe(3);
    expect(tl.dropped).toBe(2);
  });

  test("the critical path gives each instant to one phase: Eden over a tool over the model; gaps are the loop's", () => {
    const spans = [
      span("eden.observe", "eden", 0, 100),
      span("model.request", "model", 100, 600),
      span("tool.ask_context", "eden", 600, 800),
      span("tool.search_gmail", "tool", 650, 900),
      span("model.request", "model", 950, 1_200),
      // Beside the loop: never on the critical path.
      span("eden.slow", "eden", 0, 2_000, "bg"),
    ];
    expect(breakdown(spans, 0, 1_200)).toEqual({ eden: 300, model: 750, tool: 100, grading: 0, other: 50 });
    // Seconds: the first holds everything up to 1000, the second the rest.
    const secs = perSecond(spans, 1_200);
    expect(secs.length).toBe(2);
    expect(secs[0]).toEqual({ eden: 300, model: 550, tool: 100, grading: 0, other: 50 });
    expect(secs[1]).toEqual({ eden: 0, model: 200, tool: 0, grading: 0, other: 0 });
  });

  test("background coverage merges overlapping spans and clips to the window; none covers nothing", () => {
    const bg = [span("a", "eden", 0, 300, "bg"), span("b", "eden", 200, 500, "bg"), span("c", "eden", 900, 950, "bg")];
    expect(covered(bg, 0, Infinity)).toBe(550);
    expect(covered(bg, 400, 1_000)).toBe(150);
    expect(covered([], 0, Infinity)).toBe(0);
  });

  test("quantiles by nearest rank, and a paired bootstrap whose interval holds its mean", () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([5, 1, 3, 2, 4], 0.99)).toBe(5);
    expect(quantile([], 0.5)).toBe(0);
    let seed = 7;
    const next = () => ((seed = (seed * 16_807) % 2_147_483_647) - 1) / 2_147_483_646;
    const b = bootstrap([1, 0, 1, 1, 0, 1, 0, 1], next);
    expect(b.mean).toBeCloseTo(0.625);
    expect(b.lo).toBeLessThanOrEqual(b.mean);
    expect(b.hi).toBeGreaterThanOrEqual(b.mean);
    expect(bootstrap([], next)).toEqual({ mean: 0, lo: 0, hi: 0 });
  });

  test("the sweep stays fast on a long timeline", () => {
    const spans = Array.from({ length: 400 }, (_, i) => span("m", i % 2 ? "model" : "tool", i * 10, i * 10 + 15));
    const t0 = performance.now();
    perSecond(spans, 4_000);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
