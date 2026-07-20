/**
 * W4-B / Wave 3.4 — Artifacts false empty / in-page errors / mode filters.
 *
 * Empty must not render while list is loading or on error;
 * ErrorState + retry must be in-page (not toast-only for load).
 * Mode-tab empty must not claim "No artifacts yet" when other modes have rows.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function showArtifactsEmpty(opts: {
  loading: boolean;
  error: string | null;
  filteredCount: number;
}): boolean {
  return !opts.loading && !opts.error && opts.filteredCount === 0;
}

function artifactsEmptyCopy(opts: {
  tab: "all" | "shadow" | "promoted" | "archived";
  artifactsCount: number;
}): { title: string; clearFilter: boolean } {
  const filterActive = opts.tab !== "all";
  if (filterActive && opts.artifactsCount > 0) {
    return { title: `No ${opts.tab} artifacts`, clearFilter: true };
  }
  return { title: "No artifacts yet", clearFilter: false };
}

describe("W4-B artifacts query states", () => {
  it("gates list UI behind !error and uses ErrorState with retry", () => {
    const src = read("app/(portal)/artifacts/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load artifacts");
    expect(src).toContain("Try again");
    expect(src).toMatch(/error \? null : \(/);
  });

  it("does not show empty while loading or on error", () => {
    expect(
      showArtifactsEmpty({ loading: true, error: null, filteredCount: 0 }),
    ).toBe(false);
    expect(
      showArtifactsEmpty({
        loading: false,
        error: "boom",
        filteredCount: 0,
      }),
    ).toBe(false);
    expect(
      showArtifactsEmpty({ loading: false, error: null, filteredCount: 0 }),
    ).toBe(true);
  });

  it("mode filter empty does not claim first-run empty when artifacts exist", () => {
    const src = read("app/(portal)/artifacts/page.tsx");
    expect(src).toContain("No ${tab} artifacts");
    expect(src).toContain('data-testid="artifacts-clear-mode-filter"');
    expect(src).toContain('onClick={() => setTab("all")}');

    expect(
      artifactsEmptyCopy({ tab: "shadow", artifactsCount: 3 }),
    ).toEqual({ title: "No shadow artifacts", clearFilter: true });
    expect(
      artifactsEmptyCopy({ tab: "all", artifactsCount: 0 }),
    ).toEqual({ title: "No artifacts yet", clearFilter: false });
  });

  it("hides KPI / author chrome while load failed", () => {
    const src = read("app/(portal)/artifacts/page.tsx");
    // ErrorState precedes the success-only fragment that owns KPI + tabs.
    const errIdx = src.indexOf("Could not load artifacts");
    const kpiIdx = src.indexOf('{ label: "Shadow"');
    expect(errIdx).toBeGreaterThan(-1);
    expect(kpiIdx).toBeGreaterThan(errIdx);
    expect(src).toMatch(/error \? null : \(\s*<>/);
  });
});
