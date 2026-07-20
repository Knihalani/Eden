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
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('errorTitle="Could not load issues"');
    expect(src).toContain("onRetry={load}");
  });

  it("gates empty state via QueryState isEmpty (no false empty on outage)", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain("isEmpty={(d) => (d?.data?.issues.length ?? 0) === 0}");
    expect(src).toContain("<QueryState");
  });

  it("issue detail fails closed on stumbles/experiments/regression (no catch→[])", () => {
    const src = read("app/(portal)/issues/[id]/page.tsx");
    // Soft-empty swallows hide 5xx as "no stumbles / no experiments".
    expect(src).not.toMatch(/\.catch\(\(\)\s*=>\s*\[\]\)/);
    expect(src).not.toMatch(/\.catch\(\(\)\s*=>\s*setRegressionCases\(\[\]\)\)/);
    expect(src).toContain('title="Stumbles unavailable"');
    expect(src).toContain('title="Experiments unavailable"');
    expect(src).toContain('title="Regression memory unavailable"');
    expect(src).toContain("stumblesError");
    expect(src).toContain("experimentsError");
    expect(src).toContain("regressionError");
    expect(src).toContain("queryKeys.issues.regressionCases");
  });
});
