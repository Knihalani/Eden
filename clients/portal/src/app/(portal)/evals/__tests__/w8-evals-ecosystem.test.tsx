/**
 * Wave 8 — Evaluate ecosystem gate: Evals hub ≤2 chrome bands,
 * CrossLinks in overflow (not a peer band), leaves use QueryState /
 * calm shells without mega-control rows.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ResourcePageShell } from "@/components/portal-os/ResourcePageShell";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W8 evals-ecosystem", () => {
  it("ResourcePageShell reports data-page-bands ≤ 2", () => {
    const { container } = render(
      <ResourcePageShell
        header={<h1>Evals</h1>}
        toolbar={<div data-testid="tb">tabs</div>}
        table={<div>table</div>}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-page-bands", "2");
    expect(Number(root.getAttribute("data-page-bands"))).toBeLessThanOrEqual(2);
  });

  it("evals hub: ui/tabs + single toolbar; CrossLinks in More overflow", () => {
    const src = read("app/(portal)/evals/page.tsx");
    expect(src).toContain('from "@/components/ui/tabs"');
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain('data-testid="evals-toolbar"');
    expect(src).toContain("PRIMARY_TABS");
    expect(src).toContain("ADVANCED_TABS");
    // Path CrossLinks live in overflow — not a peer CrossLinkBar band
    expect(src).toContain("DropdownMenuLabel>Go to");
    expect(src).toContain("PATH_LINKS");
    expect(src).not.toContain("CrossLinkBar");
    // Mobile: More label collapses Advanced chrome copy
    expect(src).toContain("sm:hidden");
  });

  it("playgrounds / datasets / labeling / synthetic / redteam use QueryState", () => {
    for (const rel of [
      "app/(portal)/playgrounds/page.tsx",
      "app/(portal)/datasets/page.tsx",
      "app/(portal)/labeling/page.tsx",
      "app/(portal)/synthetic/page.tsx",
      "app/(portal)/redteam/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toContain('from "@/components/ui/query-state"');
      expect(src).toContain("<QueryState");
    }
  });

  it("experiments compare chrome stays in detail with baseline", () => {
    const src = read("app/(portal)/experiments/page.tsx");
    expect(src).toContain('data-testid="compare-baseline"');
    expect(src).toContain("DropdownMenuLabel>Go to");
    expect(src).not.toContain("CrossLinkBar");
    expect(src).toContain("DetailPanelShell");
    // No Card nest around list table
    expect(src).not.toMatch(/table=\{\s*<Card/);
    // Datapoints sorted by regression (score_delta asc)
    expect(src).toMatch(/score_delta/);
  });

  it("studio uses underline tabs standalone (pills when embedded) and no Card wrappers", () => {
    const src = read("app/(portal)/studio/page.tsx");
    expect(src).toContain('variant={embedded ? "pills" : "underline"}');
    expect(src).toContain("useEmbeddedSurface");
    expect(src).not.toContain('from "@/components/ui/card"');
    expect(src).toContain("border-[var(--border-subtle)]");
  });

  it("labeling queues use progressive disclosure", () => {
    const src = read("app/(portal)/labeling/page.tsx");
    expect(src).toContain("<details");
    expect(src).toContain("Annotation queues");
  });
});
