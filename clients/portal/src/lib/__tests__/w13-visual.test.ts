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
    const page = read("app/(portal)/alerts/page.tsx");
    const detail = read("app/(portal)/alerts/_components/alerts-detail-panel.tsx");
    expect(page).not.toContain("<CrossLinkBar");
    expect(detail).not.toContain("<CrossLinkBar");
    expect(detail).toContain("DropdownMenuLabel>Go to");
  });

  it("Experiments detail uses Go to dropdown, not CrossLinkBar band", () => {
    // Experiments hub shell no longer mounts a CrossLinkBar band (Wave E4 rewrite).
    const page = read("app/(portal)/experiments/page.tsx");
    const list = read("app/(portal)/experiments/_components/experiments-list.tsx");
    const compare = read("app/(portal)/experiments/_components/compare-panel.tsx");
    const src = `${page}\n${list}\n${compare}`;
    expect(src).not.toContain("<CrossLinkBar");
  });
});

describe("W13 density tokens on hub/advanced leaves", () => {
  it("Users thin panel has no arbitrary text-[9|10|11px]", () => {
    const src = read("app/(portal)/analytics/_components/users-panel.tsx");
    expect(src).not.toMatch(/text-\[(?:9|10|11)px\]/);
  });

  it("PageContent + PageHeader keep space-token rhythm", () => {
    const content = read("components/layout/page-content.tsx");
    expect(content).toContain("space-y-space-5");
    expect(content).toContain("px-space-4");
    const header = read("components/layout/page-header.tsx");
    expect(header).toContain("mb-space-4");
    expect(header).toContain("text-xl lg:text-2xl");
    // Wave 1.5 — eyebrow / mono meta removed; title remains the identity signal.
    expect(header).not.toContain("text-2xs font-mono");
  });

  it("Insights thin panel KPI strip is capped at 2", () => {
    const src = read("app/(portal)/analytics/_components/insights-panel.tsx");
    expect(src).toContain('data-testid="insights-kpi-cap"');
    expect(src).toContain("grid max-w-md grid-cols-2");
    expect(src).not.toMatch(/lg:grid-cols-4/);
  });
});

describe("W13 card-nest flatten + empty quiet", () => {
  it("Tools panel empty attribution is plain EmptyState (no Card wrap)", () => {
    const src = read("app/(portal)/analytics/_components/tools-panel.tsx");
    expect(src).toContain('title="Enter a tool ID"');
    expect(src).toContain("EmptyState");
    expect(src).not.toContain("<Card");
  });

  it("Model advisor Compare/Project use Panel, not Card shells", () => {
    const page = read("app/(portal)/optimization/model-advisor/page.tsx");
    const cmp = read(
      "app/(portal)/optimization/model-advisor/_components/compare-view.tsx",
    );
    const proj = read(
      "app/(portal)/optimization/model-advisor/_components/project-view.tsx",
    );
    expect(page).toContain("CompareView");
    expect(page).toContain("ProjectView");
    expect(cmp).toContain('tone="flat"');
    expect(cmp).toContain("Side-by-side comparison");
    expect(proj).toContain('tone="flat"');
    expect(proj).toContain("Cost projection");
    expect(cmp).not.toMatch(
      /if \(loading\) \{\s*return \(\s*<Card>/,
    );
    expect(proj).not.toMatch(
      /if \(loading\) \{\s*return \(\s*<Card>/,
    );
  });

  it("Settings exports forms use Panel inset (not form Cards)", () => {
    const src = read("app/(portal)/settings/_components/exports-forms.tsx");
    expect(src).toContain('tone="inset"');
    expect(src).toContain("New destination");
    expect(src).toContain("New schedule");
    expect(src).not.toMatch(/return <Card padding="md" className="mb-4 space-y-3">/);
  });

  it("Insights soft-redirect; correlation lives off thin panel first paint", () => {
    const redirect = read("app/(portal)/insights/page.tsx");
    expect(redirect).toContain('/analytics?tab=insights');
    const panel = read("app/(portal)/analytics/_components/insights-panel.tsx");
    expect(panel).toContain("QueryState");
    expect(panel).not.toContain("correlationQuery");
  });
});

describe("W13 KPI caps", () => {
  it("Dashboard still enforces HOME_KPI_CAP_DESKTOP ≤ 7", () => {
    const src = read(
      "app/(portal)/dashboard/_components/home-widgets.ts",
    );
    expect(src).toContain("HOME_KPI_CAP_DESKTOP = 7");
    expect(src).toContain("DEFAULT_WIDGETS.length <= HOME_KPI_CAP_DESKTOP");
  });

  it("Guardrails PII category strip is sliced to ≤7", () => {
    const src = read("app/(portal)/guardrails/_components/pii-tab.tsx");
    expect(src).toContain(".slice(0, 7)");
  });
});
