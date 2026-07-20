/**
 * Wave 13 — Portal VISUAL POLISH regression locks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W13 CrossLink quiet (detail → Go to overflow)", () => {
  it("Alerts detail uses Go to dropdown, not CrossLinkBar band", () => {
    const src = read("app/(portal)/alerts/page.tsx");
    expect(src).not.toContain("<CrossLinkBar");
    expect(src).toContain("DropdownMenuLabel>Go to");
  });

  it("Experiments detail uses Go to dropdown, not CrossLinkBar band", () => {
    const src = read("app/(portal)/experiments/page.tsx");
    expect(src).not.toContain("<CrossLinkBar");
    expect(src).toContain("DropdownMenuLabel>Go to");
  });
});

describe("W13 density tokens on hub/advanced leaves", () => {
  it("Users leaf has no arbitrary text-[9|10|11px]", () => {
    const src = read("app/(portal)/users/page.tsx");
    expect(src).not.toMatch(/text-\[(?:9|10|11)px\]/);
  });

  it("PageContent + PageHeader keep space-token rhythm", () => {
    const content = read("components/layout/page-content.tsx");
    expect(content).toContain("space-y-space-5");
    expect(content).toContain("px-space-4");
    const header = read("components/layout/page-header.tsx");
    expect(header).toContain("mb-space-4");
    expect(header).toContain("text-xl lg:text-2xl");
    expect(header).toContain("text-2xs font-mono");
  });

  it("Insights overview KPI strip is thin (2 cards, not 4-col wall)", () => {
    const src = read("app/(portal)/insights/page.tsx");
    expect(src).toContain("max-w-xl");
    expect(src).toContain("grid grid-cols-2 gap-space-3");
    expect(src).not.toMatch(/lg:grid-cols-4/);
  });
});

describe("W13 card-nest flatten + empty quiet", () => {
  it("Tools empty attribution is plain EmptyState (no Card wrap)", () => {
    const src = read("app/(portal)/tools/page.tsx");
    expect(src).toMatch(
      /!result && !loading && \(\s*<EmptyState/,
    );
    expect(src).not.toMatch(
      /!result && !loading && \(\s*<Card[\s\S]*?<EmptyState/,
    );
  });

  it("Model advisor Compare/Project use Panel, not Card shells", () => {
    const src = read("app/(portal)/optimization/model-advisor/page.tsx");
    expect(src).toContain('tone="flat"');
    expect(src).toContain("Side-by-side comparison");
    expect(src).toContain("Cost projection");
    // CompareView / ProjectView loading should not open with Card>
    expect(src).not.toMatch(
      /function CompareView[\s\S]*?if \(loading\) \{\s*return \(\s*<Card>/,
    );
    expect(src).not.toMatch(
      /function ProjectView[\s\S]*?if \(loading\) \{\s*return \(\s*<Card>/,
    );
  });

  it("Settings exports forms use Panel inset (not form Cards)", () => {
    const src = read("app/(portal)/settings/_components/exports-tab.tsx");
    expect(src).toContain('tone="inset"');
    expect(src).toContain("New destination");
    expect(src).toContain("New schedule");
    expect(src).not.toMatch(/return <Card padding="md" className="mb-4 space-y-3">/);
  });

  it("Insights correlation empty week uses EmptyState", () => {
    const src = read("app/(portal)/insights/page.tsx");
    expect(src).toContain('title="No insights written in this window"');
  });
});

describe("W13 KPI caps", () => {
  it("Dashboard still enforces HOME_KPI_CAP_DESKTOP ≤ 7", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toContain("HOME_KPI_CAP_DESKTOP = 7");
    expect(src).toContain("DEFAULT_WIDGETS.length <= HOME_KPI_CAP_DESKTOP");
  });

  it("Guardrails PII category strip is sliced to ≤7", () => {
    const src = read("app/(portal)/guardrails/page.tsx");
    expect(src).toContain(".slice(0, 7)");
  });
});
