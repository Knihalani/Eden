/**
 * W3-A — Issues list uses shared ErrorState with Retry (not ad-hoc banner).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W3-A issues ErrorState", () => {
  it("uses shared ErrorState with Retry for list failures", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Failed to load issues"');
    expect(src).toContain("Retry");
    expect(src).toContain("onClick={load}");
    expect(src).not.toMatch(/Failed to load issues[\s\S]*AlertCircle/);
  });

  it("gates empty state behind error (no false empty on outage)", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toMatch(/loading \?[\s\S]*: error \?[\s\S]*: issues\.length === 0 \?/);
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
