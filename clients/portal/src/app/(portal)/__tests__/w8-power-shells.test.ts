/**
 * Observe V3 Wave 8 — Replay / Query / Inspector power shells ≤400 LOC.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function lineCount(rel: string): number {
  return read(rel).split("\n").length;
}

describe("Wave V3-8 power shells peel", () => {
  it.each([
    ["app/(portal)/replay/page.tsx"],
    ["app/(portal)/inspector/page.tsx"],
    ["app/(portal)/observability/query/page.tsx"],
  ] as const)("%s ≤400 LOC + Wave 8 peeled marker", (rel) => {
    expect(lineCount(rel)).toBeLessThanOrEqual(400);
    const src = read(rel);
    expect(src).toContain("WAVE_V3_8_POWER_ATTR");
    expect(src).toContain("ObserveLeafHeader");
    expect(src).toContain("ObserveBackToTraces");
  });

  it("Overflow-only: LEGACY_TOOL_LINKS owns Inspector/Replay/Query; no sidebar nav", () => {
    const toolbar = read(
      "app/(portal)/traces/_components/TracesToolbar.tsx",
    );
    expect(toolbar).toContain("LEGACY_TOOL_LINKS");
    for (const href of [
      "/traces?view=inspect",
      "/traces?view=replay",
      "/traces?view=query",
    ]) {
      expect(toolbar).toContain(href);
    }
    const sidebar = read("lib/sidebar-config.ts");
    expect(sidebar).not.toMatch(/href:\s*["']\/inspector["']/);
    expect(sidebar).not.toMatch(/href:\s*["']\/replay["']/);
    expect(sidebar).not.toMatch(
      /href:\s*["']\/observability\/query["']/,
    );
  });

  it("next.config keeps permanent redirects for standalone routes", () => {
    const cfg = readFileSync(
      resolve(portalSrc, "../next.config.ts"),
      "utf8",
    );
    expect(cfg).toContain(
      '{ source: "/inspector", destination: "/traces?view=inspect", permanent: true }',
    );
    expect(cfg).toContain(
      '{ source: "/replay", destination: "/traces?view=replay", permanent: true }',
    );
    expect(cfg).toContain(
      '{ source: "/observability/query", destination: "/traces?view=query", permanent: true }',
    );
  });
});
