/**
 * Wave E4 — Experiments compare OS contracts.
 * M1 baseline · M2 Diff · M3 grades · M4 layouts · M5 regression-first · shell ≤400.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeGradeSummary,
  gradeFromDatapoint,
  normalizeComparisonGrade,
  overallComparisonGrade,
  sortDatapointsFailingFirst,
  isFailingOrRegressedDatapoint,
} from "../_components/compare-grades";
import { resolveDefaultBaseline } from "../_components/use-experiments-page";
import type { Datapoint, ExperimentRow } from "../_components/types";
import {
  WAVE_E4_EXPERIMENTS_COMPLETED,
  WAVE_E4_COMPARE_MATRIX_COMPLETED,
  WAVE_E4_BASELINE_COMPLETED,
  WAVE_E4_DIFF_GRADES_COMPLETED,
} from "../_components/use-experiments-page";
import { WAVE_E4_COMPARE_MATRIX_UI } from "../_components/compare-matrix";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function loc(rel: string): number {
  return read(rel).split("\n").length;
}

describe("Wave E4 experiments compare", () => {
  it("marks WAVE_E4 completed markers", () => {
    expect(WAVE_E4_EXPERIMENTS_COMPLETED).toBe(true);
    expect(WAVE_E4_COMPARE_MATRIX_COMPLETED).toBe(true);
    expect(WAVE_E4_BASELINE_COMPLETED).toBe(true);
    expect(WAVE_E4_DIFF_GRADES_COMPLETED).toBe(true);
    expect(WAVE_E4_COMPARE_MATRIX_UI).toBe(true);

    const page = read("app/(portal)/experiments/page.tsx");
    expect(page).toContain('data-wave-e4-experiments="shell"');
    expect(page).toContain('data-wave-e4-cta="compare"');
    expect(page).toContain("ComparePanel");
    expect(page).toContain("ExperimentsList");
  });

  it("E4.1: shell split — list + detail + compare; page ≤400 LOC", () => {
    const pageLoc = loc("app/(portal)/experiments/page.tsx");
    expect(pageLoc).toBeLessThanOrEqual(400);

    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/experiments/_components/compare-matrix.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/experiments/_components/compare-panel.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/experiments/_components/experiments-list.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/experiments/_components/use-experiments-page.ts"),
      ),
    ).toBe(true);

    const page = read("app/(portal)/experiments/page.tsx");
    expect(page).not.toContain("charDiff(");
    expect(page).not.toContain("sortDatapointsFailingFirst");
    expect(page).toContain('from "./_components/compare-panel"');
    expect(page).toContain('from "./_components/experiments-list"');
  });

  it("E4.2 / M4: compare-matrix case × run + header aggregates", () => {
    const matrix = read(
      "app/(portal)/experiments/_components/compare-matrix.tsx",
    );
    expect(matrix).toContain('data-wave-e4-matrix="case-x-run"');
    expect(matrix).toContain('data-wave-e4-matrix="header"');
    expect(matrix).toContain('data-wave-e4-matrix="aggregates"');
    expect(matrix).toContain('data-testid="compare-matrix"');
    expect(matrix).toContain("sortDatapointsFailingFirst");
  });

  it("E4.3 / M1: persistent baseline picker + green/red deltas", () => {
    const hook = read(
      "app/(portal)/experiments/_components/use-experiments-page.ts",
    );
    expect(hook).toContain("BASELINE_PREF_KEY");
    expect(hook).toContain("baselineId");
    expect(hook).toContain("resolveDefaultBaseline");
    expect(hook).toContain("localStorage");

    const panel = read(
      "app/(portal)/experiments/_components/compare-panel.tsx",
    );
    expect(panel).toContain('data-wave-e4-baseline="picker"');
    expect(panel).toContain('data-testid="compare-baseline"');

    const grades = read(
      "app/(portal)/experiments/_components/compare-grades.ts",
    );
    expect(grades).toContain("deltaClassName");
    expect(grades).toContain("text-[var(--success)]");
    expect(grades).toContain("text-[var(--error)]");
  });

  it("E4.4 / M2: Diff mode Base↔Comparison / Expected↔Output + char-diff panel", () => {
    const panel = read(
      "app/(portal)/experiments/_components/compare-panel.tsx",
    );
    expect(panel).toContain('from "@/lib/char-diff"');
    expect(panel).toContain("charDiff");
    expect(panel).toContain('data-wave-e4-diff="panel"');
    expect(panel).toContain('data-wave-e4-diff-mode="base-comparison"');
    expect(panel).toContain('data-wave-e4-diff-mode="expected-output"');
    expect(panel).toContain("Base ↔ Comparison");
    expect(panel).toContain("Expected ↔ Output");
  });

  it("E4.5 / M3: Improve/Regress/Tradeoff/Tie from existing score fields", () => {
    expect(normalizeComparisonGrade("improvement")).toBe("improve");
    expect(normalizeComparisonGrade("regression")).toBe("regress");
    expect(normalizeComparisonGrade("tradeoff")).toBe("tradeoff");
    expect(normalizeComparisonGrade("tie")).toBe("tie");
    expect(normalizeComparisonGrade(undefined, 0.05)).toBe("improve");
    expect(normalizeComparisonGrade(undefined, -0.05)).toBe("regress");

    const summary = composeGradeSummary({
      improvement: 2,
      regression: 1,
      tie: 1,
    });
    expect(summary.improve).toBe(2);
    expect(summary.regress).toBe(1);
    expect(overallComparisonGrade(summary)).toBe("tradeoff");

    const dp: Datapoint = { grade: "improve", score_delta: 0.1 };
    expect(gradeFromDatapoint(dp)).toBe("improve");

    const panel = read(
      "app/(portal)/experiments/_components/compare-panel.tsx",
    );
    expect(panel).toContain("GRADE_LABELS");
    expect(panel).toContain("composeGradeSummary");
    expect(panel).not.toContain("fetch('/api/");
  });

  it("E4.6 / M4+M5: Summary | List | Grid; default Grid failing-first", () => {
    const panel = read(
      "app/(portal)/experiments/_components/compare-panel.tsx",
    );
    expect(panel).toContain('data-wave-e4-layouts="toggle"');
    expect(panel).toContain("data-wave-e4-layout-tab={l}");
    expect(panel).toContain("COMPARE_LAYOUTS");
    expect(panel).toContain('data-wave-e4-layout="summary"');
    expect(panel).toContain('data-wave-e4-layout="list"');
    expect(panel).toContain("CompareMatrix");

    const types = read("app/(portal)/experiments/_components/types.ts");
    expect(types).toContain('"summary"');
    expect(types).toContain('"list"');
    expect(types).toContain('"grid"');

    const hook = read(
      "app/(portal)/experiments/_components/use-experiments-page.ts",
    );
    expect(hook).toContain('return "grid"');
    expect(hook).toContain("compareLayout");

    const rows: Datapoint[] = [
      { row_id: "ok", grade: "improve", score_delta: 0.2 },
      { row_id: "bad", grade: "regress", score_delta: -0.5 },
      { row_id: "mid", grade: "tie", score_delta: 0 },
    ];
    const sorted = sortDatapointsFailingFirst(rows);
    expect(sorted.map((r) => r.row_id)).toEqual(["bad", "mid", "ok"]);
    expect(isFailingOrRegressedDatapoint(rows[1]!)).toBe(true);
  });

  it("E4.7: run lifecycle via eval-run-outcome; honest errors", () => {
    const hook = read(
      "app/(portal)/experiments/_components/use-experiments-page.ts",
    );
    expect(hook).toContain("interpretOfflineRunResult");
    expect(hook).toContain("isTerminalExperimentStatus");
    expect(hook).toContain('from "@/lib/eval-run-outcome"');

    const list = read(
      "app/(portal)/experiments/_components/experiments-list.tsx",
    );
    expect(list).toContain("Could not load experiments");
    expect(list).toContain("Could not start run");
    expect(list).toContain("ErrorState");

    const panel = read(
      "app/(portal)/experiments/_components/compare-panel.tsx",
    );
    expect(panel).toContain("Could not load compare");
  });

  it("E4.8: URL experimentId + compare selection (baselineId / layout / diffMode)", () => {
    const hook = read(
      "app/(portal)/experiments/_components/use-experiments-page.ts",
    );
    expect(hook).toContain('searchParams.get("baselineId")');
    expect(hook).toContain('searchParams.get("compareLayout")');
    expect(hook).toContain('searchParams.get("diffMode")');
    expect(hook).toContain("experimentId");
    expect(hook).toContain("patchCompareUrl");
  });

  it("E4.3 helper: default baseline prefers same-dataset latest", () => {
    const rows: ExperimentRow[] = [
      {
        id: "t1",
        name: "treatment",
        dataset_id: "ds-a",
        status: "completed",
        created_at: "2026-07-21T12:00:00Z",
      },
      {
        id: "b-old",
        name: "old",
        dataset_id: "ds-a",
        status: "completed",
        created_at: "2026-07-20T12:00:00Z",
      },
      {
        id: "b-new",
        name: "newer peer",
        dataset_id: "ds-a",
        status: "completed",
        created_at: "2026-07-21T10:00:00Z",
      },
      {
        id: "other",
        name: "other ds",
        dataset_id: "ds-b",
        status: "completed",
        created_at: "2026-07-21T11:00:00Z",
      },
    ];
    expect(resolveDefaultBaseline("t1", rows, {})).toBe("b-new");
    expect(resolveDefaultBaseline("t1", rows, { "ds-a": "b-old" })).toBe(
      "b-old",
    );
  });

  it("reuses offlineExperimentsApi — no new backend", () => {
    const hook = read(
      "app/(portal)/experiments/_components/use-experiments-page.ts",
    );
    expect(hook).toContain("offlineExperimentsApi.list");
    expect(hook).toContain("offlineExperimentsApi.compare");
    expect(hook).toContain("offlineExperimentsApi.run");
    expect(hook).not.toContain("fetch('/api/");
  });
});
