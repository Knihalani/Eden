/**
 * W3-A — Issues list uses shared ErrorState / QueryState with Retry (not ad-hoc banner).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W3-A issues ErrorState", () => {
  it("uses QueryState with retry for list failures", () => {
    const src = read("app/(portal)/issues/_components/issues-list.tsx");
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain('errorTitle="Could not load issues"');
    expect(src).toContain("onRetry={load}");
  });

  it("gates empty state via QueryState isEmpty (no false empty on outage)", () => {
    const src = read("app/(portal)/issues/_components/issues-list.tsx");
    expect(src).toContain("isEmpty={(d) => (d?.data?.issues.length ?? 0) === 0}");
    expect(src).toContain("<QueryState");
  });

  it("issue detail fails closed on stumbles/experiments/regression (no catch→[])", () => {
    const hook = read("app/(portal)/issues/_components/use-issue-detail.ts");
    const page = read("app/(portal)/issues/[id]/page.tsx");
    const stumbles = read("app/(portal)/issues/_components/issue-stumbles-list.tsx");
    const experiment = read("app/(portal)/issues/_components/issue-experiment-panel.tsx");
    const regression = read("app/(portal)/issues/_components/issue-regression-panel.tsx");
    // Soft-empty swallows hide 5xx as "no stumbles / no experiments".
    expect(hook).not.toMatch(/\.catch\(\(\)\s*=>\s*\[\]\)/);
    expect(page).not.toMatch(/\.catch\(\(\)\s*=>\s*\[\]\)/);
    expect(stumbles).toContain('title="Stumbles unavailable"');
    expect(experiment).toContain('title="Experiments unavailable"');
    expect(regression).toContain('title="Regression memory unavailable"');
    expect(hook).toContain("stumblesError");
    expect(hook).toContain("experimentsError");
    expect(hook).toContain("regressionError");
    expect(hook).toContain("queryKeys.issues.regressionCases");
  });
});
