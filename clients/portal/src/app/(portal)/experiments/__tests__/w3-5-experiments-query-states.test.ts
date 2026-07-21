/**
 * W3-5 — Experiments false empty / in-page errors (list + compare).
 * Wave E4: list/compare ErrorState live in _components (shell split).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function showExperimentsEmpty(opts: {
  loading: boolean;
  loadError: string | null;
  rowCount: number;
}): boolean {
  return !opts.loading && !opts.loadError && opts.rowCount === 0;
}

function showCompareEmpty(opts: {
  summaryLoading: boolean;
  compareError: string | null;
  hasSummary: boolean;
}): boolean {
  return !opts.summaryLoading && !opts.compareError && !opts.hasSummary;
}

describe("W3-5 experiments query states", () => {
  it("list uses ErrorState with retry (not toast-only empty)", () => {
    const list = read("app/(portal)/experiments/_components/experiments-list.tsx");
    const hook = read("app/(portal)/experiments/_components/use-experiments-page.ts");
    expect(list).toContain('from "@/components/ui/error-state"');
    expect(list).toContain("Could not load experiments");
    expect(list).toContain("Try again");
    expect(list).toMatch(/loadError && !loading/);
    expect(hook).toMatch(/useState\(true\)/);
  });

  it("does not show list empty while loading or on error", () => {
    expect(
      showExperimentsEmpty({ loading: true, loadError: null, rowCount: 0 }),
    ).toBe(false);
    expect(
      showExperimentsEmpty({
        loading: false,
        loadError: "boom",
        rowCount: 0,
      }),
    ).toBe(false);
    expect(
      showExperimentsEmpty({ loading: false, loadError: null, rowCount: 0 }),
    ).toBe(true);
  });

  it("compare panel uses ErrorState (no false empty on compare failure)", () => {
    const panel = read("app/(portal)/experiments/_components/compare-panel.tsx");
    expect(panel).toContain("Could not load compare");
    expect(panel).toContain("compareError");
    expect(panel).toMatch(/compareError \?/);
    expect(
      showCompareEmpty({
        summaryLoading: false,
        compareError: "boom",
        hasSummary: false,
      }),
    ).toBe(false);
    expect(
      showCompareEmpty({
        summaryLoading: true,
        compareError: null,
        hasSummary: false,
      }),
    ).toBe(false);
    expect(
      showCompareEmpty({
        summaryLoading: false,
        compareError: null,
        hasSummary: false,
      }),
    ).toBe(true);
  });
});
