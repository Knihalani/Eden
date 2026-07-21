/**
 * Wave 6 — Table mobile sticky first-col / card fallback (UX-P1-11).
 *
 * Dense tables on fleet heatmap, improve runs, cohorts, and observability
 * query must not rely on horizontal-scroll-only UX without sticky identity
 * or stacked cards &lt;lg.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STICKY_FIRST,
  STICKY_FIRST_TD,
  STICKY_FIRST_TH,
} from "@/components/ui/table-sticky";

const portalSrc = resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6 table-sticky shared util", () => {
  it("exports sticky left-0 z-10 with dark-terminal bg tokens", () => {
    expect(STICKY_FIRST).toContain("sticky left-0");
    expect(STICKY_FIRST).toContain("z-10");
    expect(STICKY_FIRST_TH).toContain("bg-[var(--bg-secondary)]");
    expect(STICKY_FIRST_TD).toContain("bg-[var(--bg-primary)]");
  });

  it("DataTable uses shared sticky classes for col.sticky", () => {
    const src = read("components/ui/data-table.tsx");
    expect(src).toContain('from "@/components/ui/table-sticky"');
    expect(src).toContain("STICKY_FIRST_TH");
    expect(src).toContain("STICKY_FIRST_TD");
  });
});

describe("W6 mobile table surfaces", () => {
  it("fleet heatmap pins Agent as sticky first column", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain("STICKY_FIRST_TD");
    expect(src).toMatch(/STICKY_FIRST_TD[\s\S]*Agent/);
  });

  it("improve runs uses &lt;lg card stack + sticky Started on desktop table", () => {
    const src = read("app/(portal)/improve/runs/page.tsx");
    expect(src).toContain("lg:hidden");
    expect(src).toContain('data-testid="improve-runs-mobile-cards"');
    expect(src).toContain("gap-space-3");
    expect(src).toContain("STICKY_FIRST_TH");
    expect(src).toContain("STICKY_FIRST_TD");
    expect(src).toContain("hidden overflow-x-auto");
    expect(src).toContain("lg:block");
  });

  it("cohorts results sticky-pin first SQL column", () => {
    const src = read("app/(portal)/observability/cohorts/page.tsx");
    expect(src).toContain("STICKY_FIRST_TH");
    expect(src).toContain("STICKY_FIRST_TD");
    expect(src).toContain("colIdx === 0 && STICKY_FIRST_TH");
    expect(src).toContain("colIdx === 0 && STICKY_FIRST_TD");
  });

  it("observability query run results sticky-pin first column", () => {
    const src = read("app/(portal)/observability/query/_components/query-panels.tsx");
    expect(src).toContain("STICKY_FIRST_TH");
    expect(src).toContain("STICKY_FIRST_TD");
    expect(src).toContain("colIdx === 0 && STICKY_FIRST_TH");
    expect(src).toContain("colIdx === 0 && STICKY_FIRST_TD");
  });
});
