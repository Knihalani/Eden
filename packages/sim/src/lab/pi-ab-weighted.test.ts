import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { quantile } from "./pi-timeline";
import {
  fixed,
  reportTables,
  weightedFromReport,
  weightedLines,
  weightedQuantile,
  weightedRow,
  type WeightedSample,
} from "./pi-ab-weighted";

const s = (wallS: number, usd = 0, edenUsd = 0, tools = 0): WeightedSample => ({ usd, edenUsd, tools, wallS });
const PHASE3 = resolve(import.meta.dir, "../../lab/haiku/phase3");

describe("weightedQuantile", () => {
  test("equal weights match the report's unweighted quantile", () => {
    const xs = [5, 1, 9, 3, 7, 2, 8];
    for (const p of [0.1, 0.5, 0.9, 0.99])
      expect(
        weightedQuantile(
          xs.map((v) => ({ v, weight: 1 })),
          p,
        ),
      ).toBe(quantile(xs, p));
  });
});

describe("weightedRow", () => {
  test("p50 comes from the pooled samples, not a weighted average of the two p50s", () => {
    // Hidden tasks all take 1 s, control tasks all 9 s. At w = 0.5 the averaged p50s would be 5 s, a time no task took;
    // the pooled median is 1 s (the hidden half reaches 0.5 cumulative weight).
    const hidden = [s(1), s(1), s(1), s(1)];
    const control = [s(9), s(9), s(9), s(9)];
    const row = weightedRow("x", hidden, control, 0.5)!;
    expect(row.p50).toBe(1);
    expect(row.p50).not.toBe(0.5 * quantile([1, 1, 1, 1], 0.5) + 0.5 * quantile([9, 9, 9, 9], 0.5));
    expect(row.p90).toBe(9);
    // At w = 0.1, 90% of traffic is control: both percentiles are control's.
    const mostlySilent = weightedRow("x", hidden, control, 0.1)!;
    expect(mostlySilent.p50).toBe(9);
  });

  test("each kind weighs w and 1 − w whatever its task count", () => {
    // One hidden task at 1 s against nine control tasks at 2..10 s: at w = 0.5 the lone hidden task holds half the
    // weight, so the p50 is 1 s (pooling without per-kind weights would give 5 s).
    const control = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => s(v));
    expect(weightedRow("x", [s(1)], control, 0.5)!.p50).toBe(1);
  });

  test("means are weighted per kind", () => {
    const row = weightedRow("x", [s(1, 0.001, 0.0004, 1)], [s(2, 0.002, 0.0008, 2), s(2, 0.004, 0.0012, 4)], 0.5)!;
    expect(row.perK).toBeCloseTo(0.5 * 1.4 + 0.5 * 4, 9);
    expect(row.edenPerK).toBeCloseTo(0.5 * 0.4 + 0.5 * 1.0, 9);
    expect(row.tools).toBeCloseTo(0.5 * 1 + 0.5 * 3, 9);
  });

  test("no row without both kinds", () => {
    expect(weightedRow("x", [s(1)], [], 0.5)).toBeNull();
  });
});

describe("weightedFromReport", () => {
  test("report-pi-h13: NEW's Eden cost at w = 0.5 is $0.666/1k", () => {
    const rows = weightedFromReport(readFileSync(`${PHASE3}/report-pi-h13.txt`, "utf8"));
    const row = rows.find((r) => r.condition === "eden~NEW" && r.w === 0.5)!;
    expect(fixed(row.edenPerK, 3)).toBe("0.666");
    expect(fixed(row.perK, 3)).toBe("0.961");
    const printed = weightedLines(rows).find((l) => l.startsWith("0.50  eden~NEW "))!;
    expect(printed).toContain(" 0.666 ");
    expect(row.p50).toBeNull();
  });

  test("reads the newer layout with bkfill and all-in columns", () => {
    const text = [
      "== hidden: hidden fact raised",
      "condition     n   rate   $/1k  (Eden) bkfill all-in  calls  tools   in tok",
      "eden~NEW     10  0.800  1.000   0.500  0.100  0.600   1.40   0.60     1400",
      "",
      "== control: false concern",
      "condition     n   rate   $/1k  (Eden) bkfill all-in  calls  tools   in tok",
      "eden~NEW     10  0.000  2.000   0.700  0.100  0.800   1.80   1.20     1800",
    ].join("\n");
    expect(reportTables(text).get("control")!.get("eden~NEW")!.tools).toBe(1.2);
    const row = weightedFromReport(text, [0.5])[0]!;
    expect(row.edenPerK).toBeCloseTo(0.6, 9);
    expect(row.tools).toBeCloseTo(0.9, 9);
  });
});
