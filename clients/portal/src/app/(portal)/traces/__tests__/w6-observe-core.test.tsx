/**
 * Wave 6 — Observe core gate: chrome bands ≤2, facets in filters,
 * Display columns, master–detail, transcript-first.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResourcePageShell } from "@/components/portal-os/ResourcePageShell";
import {
  TRACES_DEFAULT_VISIBLE_OPTIONAL,
  TRACES_OPTIONAL_COLUMNS,
} from "@/app/(portal)/observability/_components/TracesTab";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6 observe-core — Traces declutter", () => {
  it("ResourcePageShell never reports data-page-bands > 2", () => {
    const { container: withToolbar } = render(
      <ResourcePageShell
        header={<h1>Traces</h1>}
        toolbar={<div data-testid="tb">filters</div>}
        kpiStrip={<div>kpi</div>}
        table={<div>table</div>}
        detail={<aside>detail</aside>}
      />,
    );
    const root = withToolbar.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-page-bands", "2");
    expect(Number(root.getAttribute("data-page-bands"))).toBeLessThanOrEqual(2);
    expect(root.querySelectorAll("[data-chrome-band]").length).toBeGreaterThanOrEqual(2);
    // identity + toolbar + kpi (kpi allowed, does not bump page-bands)
    expect(root.querySelector('[data-chrome-band="identity"]')).toBeTruthy();
    expect(root.querySelector('[data-chrome-band="toolbar"]')).toBeTruthy();
    expect(root.querySelector('[data-chrome-band="kpi"]')).toBeTruthy();
    expect(screen.getByTestId("tb")).toBeInTheDocument();
  });

  it("hub page composes ≤2 bands and keeps list mounted with detail", () => {
    const src = read("app/(portal)/traces/page.tsx");
    expect(src).toContain("ResourcePageShell");
    expect(src).toContain('data-testid="traces-toolbar"');
    expect(src).toContain("DetailPanelShell");
    expect(src).toContain("traceId ? (");
    // Facet select inside QueryFilterBar selects[]
    expect(src).toMatch(/key:\s*"facet"/);
    expect(src).toContain("FACET_VIEWS");
    // Legacy tools only in More overflow
    expect(src).toContain("LEGACY_TOOL_LINKS");
    expect(src).toMatch(/DropdownMenuLabel>Tools/);
    expect(src).not.toMatch(/HUB_VIEWS.*inspect/);
    // URL round-trip for cols + filters + views
    expect(src).toContain('searchParams.get("cols")');
    expect(src).toContain("writeVisibleColumns");
    expect(src).toContain("viewId");
    expect(src).toContain("writeFilterParams");
  });

  it("optional column catalog exists for Display menu", () => {
    expect(TRACES_OPTIONAL_COLUMNS.map((c) => c.id)).toEqual([
      "streaming_metrics",
      "input_tokens",
      "output_tokens",
      "cost_cents",
    ]);
    expect(TRACES_DEFAULT_VISIBLE_OPTIONAL).not.toContain("streaming_metrics");
    expect(TRACES_DEFAULT_VISIBLE_OPTIONAL).toContain("cost_cents");
  });

  it("transcript-v2 flattens parallel lane outer card chrome", () => {
    const lane = read("components/transcript-v2/ParallelToolLane.tsx");
    expect(lane).toContain("border-y border-[var(--border-subtle)]");
    expect(lane).not.toContain("rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]");
  });
});
