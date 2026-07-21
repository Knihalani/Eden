/**
 * W5-D — Playgrounds shared controls + scorecard honesty + amber tokens.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W5-D playgrounds shared Input/Select", () => {
  it("uses Textarea and Select instead of raw controls", () => {
    const src = read("app/(portal)/playgrounds/page.tsx");
    expect(src).toContain('from "@/components/ui/textarea"');
    expect(src).toContain('from "@/components/ui/select"');
    expect(src).toContain("<Textarea");
    expect(src).toContain("<Select");
    expect(src).not.toMatch(/<textarea[\s>]/);
    expect(src).not.toMatch(/<select[\s>]/);
  });
});

describe("W5-D scorecard quiet-link honesty", () => {
  it("does not claim org evolution lift / cost KPIs", () => {
    const widgets = read(
      "app/(portal)/dashboard/_components/home-widgets.ts",
    );
    expect(widgets).toContain("/improve/scorecard");
    expect(widgets).toContain('label: "Scorecard"');
    expect(widgets).not.toContain("Evolution lift & cost gates");
  });
});

describe("W5-D online-scoring amber tokenized", () => {
  it("uses warning tokens instead of amber Tailwind", () => {
    const src = read(
      "app/(portal)/improve/online-scoring/_components/online-scoring-rules.tsx",
    );
    expect(src).toContain("var(--warning");
    expect(src).not.toMatch(/amber-/);
  });
});
