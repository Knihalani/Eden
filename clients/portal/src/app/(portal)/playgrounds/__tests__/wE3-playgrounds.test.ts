/**
 * Wave E3 — Playgrounds mutable iterate contracts.
 * M8 fromSpan polish · M9 promote→compare · M10 failing-first matrix · shell ≤400.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { experimentHref } from "@/lib/portal-cross-links";
import {
  isFailingOrRegressedRow,
  sortMatrixFailingFirst,
  type RunMatrixRow,
} from "../_components/run-matrix-types";
import { WAVE_E3_MATRIX_COMPLETED } from "../_components/run-matrix";
import {
  WAVE_E3_PLAYGROUNDS_COMPLETED,
  WAVE_E3_FROM_SPAN_COMPLETED,
  WAVE_E3_PROMOTE_COMPARE_READY,
} from "../_components/use-playgrounds-page";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave E3 playgrounds", () => {
  it("marks WAVE_E3 completed markers", () => {
    expect(WAVE_E3_PLAYGROUNDS_COMPLETED).toBe(true);
    expect(WAVE_E3_FROM_SPAN_COMPLETED).toBe(true);
    expect(WAVE_E3_PROMOTE_COMPARE_READY).toBe(true);
    expect(WAVE_E3_MATRIX_COMPLETED).toBe(true);

    const page = read("app/(portal)/playgrounds/page.tsx");
    expect(page).toContain('data-wave-e3-playgrounds="shell"');
    expect(page).toContain('data-wave-e3-cta="run"');
    expect(page).toContain('data-wave-e3-cta="promote"');
    expect(page).toContain('data-wave-e3-promote="compare-ready"');
    expect(page).toContain('data-wave-e3-from-production="chip"');
    expect(page).toContain('data-wave-e3-dataset-bind="unbound"');
  });

  it("E3.1: shell split — run-matrix + hook; page ≤400 LOC", () => {
    const page = read("app/(portal)/playgrounds/page.tsx");
    const lines = page.split("\n").length;
    expect(lines).toBeLessThanOrEqual(400);

    expect(page).toContain('from "./_components/run-matrix"');
    expect(page).toContain("usePlaygroundsPage");
    expect(page).toContain("RunMatrixResults");
    expect(page).not.toContain("sortMatrixFailingFirst");

    const matrix = read("app/(portal)/playgrounds/_components/run-matrix.tsx");
    expect(matrix).toContain('data-wave-e3-matrix="results"');
    expect(matrix).toContain('data-testid="playground-run-matrix"');

    const hook = read("app/(portal)/playgrounds/_components/use-playgrounds-page.ts");
    expect(hook).toContain("playgroundApi.fromSpan");
    expect(hook).toContain("promoteExperiment");
    expect(hook).toContain("runPersisted");
  });

  it("E3.2: Run CTA hierarchy — solid Run; outline New / Promote", () => {
    const page = read("app/(portal)/playgrounds/page.tsx");
    expect(page).toContain('data-testid="playground-run-cta"');
    expect(page).toContain('data-wave-e3-cta="hierarchy"');

    const newWindow = page.slice(
      Math.max(0, page.indexOf("New playground") - 200),
      page.indexOf("New playground"),
    );
    expect(newWindow).toContain('variant="outline"');

    expect(page).toMatch(
      /variant="outline"\s*\n\s*onClick=\{promote\}[\s\S]*?Promote → experiment/,
    );
  });

  it("E3.3 / M8: fromSpan chip persists via sessionStorage + View trace", () => {
    const hook = read("app/(portal)/playgrounds/_components/use-playgrounds-page.ts");
    expect(hook).toContain("fromSpan");
    expect(hook).toContain("span_id: spanId");
    expect(hook).toContain("eden.playground.fromProduction");
    expect(hook).toContain("dismissFromProduction");
    expect(hook).toContain("sessionStorage");

    const page = read("app/(portal)/playgrounds/page.tsx");
    expect(page).toContain('data-wave-e1-from-production="chip"');
    expect(page).toContain('data-wave-e3-from-production="chip"');
    expect(page).toContain('data-testid="playground-from-production"');
    expect(page).toContain("From production");
    expect(page).toContain('data-wave-e3-from-production="trace-link"');
    expect(page).toContain("/traces?traceId=");
  });

  it("E3.4: dataset bind required before Promote; clear run when unbound", () => {
    const hook = read("app/(portal)/playgrounds/_components/use-playgrounds-page.ts");
    expect(hook).toContain("Bind a dataset before promoting");
    expect(hook).toContain("if (!datasetId) setRun(null)");
    expect(hook).toContain("canPromote");

    const page = read("app/(portal)/playgrounds/page.tsx");
    expect(page).toContain('data-wave-e3-dataset-bind="select"');
    expect(page).toContain('data-wave-e3-dataset-bind="unbound"');
    expect(page).toContain("disabled={busy || !canPromote}");
  });

  it("E3.5 / M9: Promote lands on Experiments compare-ready URL", () => {
    const hook = read("app/(portal)/playgrounds/_components/use-playgrounds-page.ts");
    expect(hook).toContain("experimentHref");
    expect(hook).toContain("router.push(expId ? experimentHref(expId) : experimentHref())");

    const href = experimentHref("exp-new-1");
    expect(href).toContain("tab=experiments");
    expect(href).toContain("experimentId=exp-new-1");
  });

  it("E3.6 / M10: failing/regressed cells first + j/k", () => {
    const rows: RunMatrixRow[] = [
      { row_id: "ok-1", grade: "pass", score_delta: 0.1 },
      { row_id: "bad-1", grade: "fail", score_delta: -0.5 },
      { row_id: "reg-1", grade: "ok", score_delta: -0.2 },
      { row_id: "mid-1", grade: "tie", score_delta: 0 },
    ];
    const sorted = sortMatrixFailingFirst(rows);
    expect(sorted.map((r) => r.row_id)).toEqual([
      "bad-1",
      "reg-1",
      "mid-1",
      "ok-1",
    ]);
    expect(isFailingOrRegressedRow(rows[1]!)).toBe(true);
    expect(isFailingOrRegressedRow(rows[2]!)).toBe(true);
    expect(isFailingOrRegressedRow(rows[0]!)).toBe(false);

    const matrix = read("app/(portal)/playgrounds/_components/run-matrix.tsx");
    expect(matrix).toContain("sortMatrixFailingFirst");
    expect(matrix).toContain('e.key !== "j"');
    expect(matrix).toContain('e.key !== "k"');
    expect(matrix).toContain("data-wave-e3-matrix-focus");
    expect(matrix).toContain('data-failing={failing ? "true" : "false"}');
  });

  it("reuses playground APIs — no new backend surface", () => {
    const hook = read("app/(portal)/playgrounds/_components/use-playgrounds-page.ts");
    expect(hook).toContain("playgroundApi.fromSpan");
    expect(hook).toContain("playgroundApi.runPersisted");
    expect(hook).toContain("playgroundApi.promoteExperiment");
    expect(hook).not.toContain("fetch('/api/");
  });
});
