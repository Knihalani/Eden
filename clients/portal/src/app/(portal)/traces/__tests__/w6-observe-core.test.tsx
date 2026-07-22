/**
 * Wave 6 — Observe core gate: chrome bands ≤2, facets in filters,
 * Display columns, master–detail, transcript-first, keyboard complete.
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
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(src).toContain("ResourcePageShell");
    expect(toolbar).toContain('data-testid="traces-toolbar"');
    expect(src).toContain("TraceViewerModal");
    expect(src).toContain("hub.traceId ? (");
    expect(toolbar).toContain("FACET_VIEWS");
    // Legacy tools only in More overflow
    expect(src).toContain("TracesToolbar");
    expect(toolbar).toContain("LEGACY_TOOL_LINKS");
    expect(toolbar).toMatch(/DropdownMenuLabel>Tools/);
    expect(toolbar).toContain("FACET_LINKS");
    expect(src).not.toMatch(/HUB_VIEWS.*inspect/);
    // URL round-trip for cols + filters + views
    expect(hook).toContain('searchParams.get("cols")');
    expect(src).toContain("writeVisibleColumns");
    expect(src).toContain("viewId");
    expect(hook).toContain("writeFilterParams");
  });

  it("optional column catalog exists for Display menu", () => {
    expect(TRACES_OPTIONAL_COLUMNS.map((c) => c.id)).toEqual([
      "agent",
      "spans",
      "input",
      "output",
      "streaming_metrics",
      "actions",
    ]);
    expect(TRACES_DEFAULT_VISIBLE_OPTIONAL).not.toContain("streaming_metrics");
    expect(TRACES_DEFAULT_VISIBLE_OPTIONAL).toEqual([]);
  });

  it("transcript-v2 flattens parallel lane outer card chrome", () => {
    const lane = read("components/transcript-v2/ParallelToolLane.tsx");
    expect(lane).toContain("border-y border-[var(--border-subtle)]");
    expect(lane).not.toContain(
      "rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]",
    );
  });
});

describe("W6 observe-core — keyboard complete", () => {
  it("list nav: j/k Enter + transcript scope + Esc/filter focus", () => {
    const listNav = read("hooks/use-list-keyboard-nav.ts");
    const shortcuts = read("hooks/use-keyboard-shortcuts.ts");
    const hub = read("app/(portal)/traces/_components/use-traces-hub.ts");
    const transcriptKb = read("components/transcript-v2/hooks/useTranscriptKeyboard.ts");
    const shell = read("components/portal-os/DetailPanelShell.tsx");
    const filterBar = read("components/ui/filter-bar.tsx");
    const qBar = read("components/portal-os/QueryFilterBar.tsx");

    expect(listNav).toContain("Enter:");
    expect(listNav).toContain("isFocusInTranscript");
    expect(shortcuts).toContain("e.metaKey || e.ctrlKey || e.altKey");
    expect(shortcuts).toContain("Escape");
    expect(hub).toContain('"/":');
    expect(hub).toContain("data-filter-search");
    expect(hub).toContain("Escape:");
    expect(hub).toContain("handleCloseDetail");
    expect(transcriptKb).toContain('data-testid="transcript-v2"');
    expect(transcriptKb).toContain("e.metaKey || e.ctrlKey");
    expect(shell).toContain('data-shortcut-chip="esc"');
    expect(filterBar).toContain("data-filter-search");
    expect(qBar).toContain('shortcutHint: "/"');
  });

  it("golden path script documents V3 URL grammar", () => {
    const e2e = readFileSync(
      resolve(__dirname, "../../../../../e2e/golden/w12-observe-eval-improve.mjs"),
      "utf8",
    );
    expect(e2e).toContain("W_V3_URL_GRAMMAR");
    expect(e2e).toContain("W_V3_LOOP");
    expect(e2e).toContain("traceId");
    expect(e2e).toContain("spanId");
    expect(e2e).toContain("pastHours");
    expect(e2e).toContain("W_V3_E2E_LIVE");
  });
});
