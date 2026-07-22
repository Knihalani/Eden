import { describe, expect, it } from "vitest";
import {
  composeGradeSummary,
  normalizeComparisonGrade,
  overallComparisonGrade,
  sortDatapointsFailingFirst,
  type Datapoint,
} from "@/lib/compare-grades";

describe("compare-grades", () => {
  it("normalizeComparisonGrade maps aliases and score deltas", () => {
    expect(normalizeComparisonGrade("improvement")).toBe("improve");
    expect(normalizeComparisonGrade("regression")).toBe("regress");
    expect(normalizeComparisonGrade("trade-off")).toBe("tradeoff");
    expect(normalizeComparisonGrade("equal")).toBe("tie");
    expect(normalizeComparisonGrade(null, 0.5)).toBe("improve");
    expect(normalizeComparisonGrade(null, -0.5)).toBe("regress");
    expect(normalizeComparisonGrade(null, 0)).toBe("tie");
  });

  it("composeGradeSummary prefers summary then datapoints", () => {
    const fromSummary = composeGradeSummary({
      improvement: 2,
      regression: 1,
      tie: 1,
    });
    expect(fromSummary).toEqual({
      improve: 2,
      regress: 1,
      tradeoff: 0,
      tie: 1,
    });

    const dps: Datapoint[] = [
      { grade: "improve" },
      { score_delta: -0.2 },
      { grade: "tradeoff" },
    ];
    expect(composeGradeSummary(null, dps)).toEqual({
      improve: 1,
      regress: 1,
      tradeoff: 1,
      tie: 0,
    });
  });

  it("overallComparisonGrade picks verdict", () => {
    expect(
      overallComparisonGrade({
        improve: 3,
        regress: 0,
        tradeoff: 0,
        tie: 1,
      }),
    ).toBe("improve");
    expect(
      overallComparisonGrade({
        improve: 0,
        regress: 2,
        tradeoff: 0,
        tie: 0,
      }),
    ).toBe("regress");
    expect(
      overallComparisonGrade({
        improve: 1,
        regress: 2,
        tradeoff: 0,
        tie: 0,
      }),
    ).toBe("tradeoff");
    expect(
      overallComparisonGrade({
        improve: 2,
        regress: 2,
        tradeoff: 0,
        tie: 0,
      }),
    ).toBe("tradeoff");
    expect(
      overallComparisonGrade({
        improve: 0,
        regress: 0,
        tradeoff: 0,
        tie: 4,
      }),
    ).toBe("tie");
  });

  it("sortDatapointsFailingFirst puts regressions first by worst delta", () => {
    const rows: Datapoint[] = [
      { row_id: "ok", grade: "improve", score_delta: 0.2 },
      { row_id: "mild", grade: "regress", score_delta: -0.1 },
      { row_id: "bad", grade: "regress", score_delta: -0.9 },
      { row_id: "tie", grade: "tie", score_delta: 0 },
    ];
    const sorted = sortDatapointsFailingFirst(rows).map((r) => r.row_id);
    expect(sorted).toEqual(["bad", "mild", "tie", "ok"]);
  });
});
