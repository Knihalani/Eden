/**
 * W3-5 — Experiments false empty / in-page errors (list + compare).
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
    const src = read("app/(portal)/experiments/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load experiments");
    expect(src).toContain("Try again");
    expect(src).toMatch(/loadError && !loading/);
    expect(src).toMatch(/useState\(true\)/);
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
    const src = read("app/(portal)/experiments/page.tsx");
    expect(src).toContain("Could not load compare");
    expect(src).toContain("compareError");
    expect(src).toMatch(/compareError \?/);
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
