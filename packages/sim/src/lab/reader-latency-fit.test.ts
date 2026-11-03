import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fitCached, fitTokens, replayRows, runRows, tableRows } from "./reader-latency-fit";

const phase3 = join(import.meta.dir, "..", "..", "..", "..", "docs", "research", "haiku-phase3.md");

describe("reader latency fit", () => {
  test("recovers a known floor and per-token costs exactly", () => {
    const pts = [
      [1000, 100],
      [2000, 150],
      [4000, 120],
      [3000, 300],
      [5000, 250],
    ].map(([input, output]) => ({ input: input!, output: output!, ms: 400 + 0.01 * input! + 4 * output! }));
    const f = fitTokens(pts);
    expect(f.coef[0]).toBeCloseTo(400, 6);
    expect(f.coef[1]).toBeCloseTo(0.01, 9);
    expect(f.coef[2]).toBeCloseTo(4, 6);
    expect(f.r2).toBeCloseTo(1, 9);
  });

  test("splits cached input apart when the calls carry it", () => {
    const pts = [
      [3000, 0, 100],
      [3000, 2000, 120],
      [5000, 1000, 90],
      [6000, 4000, 200],
      [2000, 500, 300],
    ].map(([input, cached, output]) => ({
      input: input!,
      cached: cached!,
      output: output!,
      ms: 300 + 0.02 * (input! - cached!) + 0.002 * cached! + 5 * output!,
    }));
    const f = fitCached(pts);
    expect(f.coef.map((c) => Number(c.toFixed(4)))).toEqual([300, 0.02, 0.002, 5]);
  });

  test("haiku-phase3.md's train-screens table gives fit (a): floor about 365 ms, about 4.21 ms per output token", () => {
    const rows = tableRows(readFileSync(phase3, "utf8"));
    // The ten single-value rows; the v8 range row and the "(replayed)" rows are left out.
    expect(rows.length).toBe(10);
    expect(rows[1]).toMatchObject({ input: 3921, output: 188, ms: 1190 });
    const f = fitTokens(rows);
    expect(f.coef[0]).toBeCloseTo(364.9, 0);
    expect(f.coef[2]).toBeCloseTo(4.214, 2);
    expect(f.r2).toBeGreaterThan(0.98);
  });

  test("funnel log summary: one point per run, p50 and p90, pure replays marked by 0 sent", () => {
    const text = readFileSync(
      join(import.meta.dir, "..", "..", "lab", "haiku", "phase3", "funnel-reader-cost.txt"),
      "utf8",
    );
    const rows = runRows(text);
    expect(rows.length).toBe(19);
    expect(rows.find((r) => r.label === "f8-new.log")).toMatchObject({ input: 3921, output: 188, ms: 1190, p90: 1768 });
    expect(rows.filter((r) => r.sent === 0).map((r) => r.label)).toEqual(["f7-AB20k.log"]);
    const f = fitTokens(rows);
    expect(f.coef[0]).toBeCloseTo(534.7, 0);
    expect(f.coef[2]).toBeCloseTo(3.403, 2);
  });

  test("replay lines: one point per call with usage and latency, TTFT kept when streamed", () => {
    const usage = (inputTokens: number, outputTokens: number, cachedInputTokens: number) => ({
      inputTokens,
      outputTokens,
      cachedInputTokens,
    });
    const lines = [
      { k: "a", text: "{}", usage: usage(10, 2, 4), latencyMs: 900 },
      { k: "b", text: "{}", usage: usage(12, 3, 0), latencyMs: 950, ttftMs: 400 },
      { k: "c", text: "{}", usage: usage(12, 3, 0), latencyMs: 0 },
    ];
    const rows = replayRows(lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(rows).toEqual([
      { input: 10, output: 2, cached: 4, ms: 900, ttftMs: null },
      { input: 12, output: 3, cached: 0, ms: 950, ttftMs: 400 },
    ]);
  });
});
