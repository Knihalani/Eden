/**
 * Wave 7 — Observe satellite + Home gate.
 * Chrome bands ≤2 on Issues/Alerts/Agents/Dashboard; Trace grammar copied.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ResourcePageShell } from "@/components/portal-os/ResourcePageShell";

const portalSrc = resolve(__dirname, "../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W7 satellite — ResourcePageShell band budget", () => {
  it("reports data-page-bands ≤ 2 with identity + toolbar + kpi", () => {
    const { container } = render(
      <ResourcePageShell
        header={<h1>Hub</h1>}
        toolbar={<div data-testid="tb">filters</div>}
        kpiStrip={<div>kpi</div>}
        table={<div>table</div>}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-page-bands", "2");
    expect(Number(root.getAttribute("data-page-bands"))).toBeLessThanOrEqual(2);
  });
});

describe("W7 satellite — Issues hub", () => {
  it("composes ≤2 bands: tabs + ResourceOsToolbar in one toolbar slot", () => {
    const src = read("app/(portal)/issues/page.tsx");
    const listSrc = read("app/(portal)/issues/_components/issues-list.tsx");
    const detailSrc = read(
      "app/(portal)/issues/_components/issues-detail-panel.tsx",
    );
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain('data-testid="issues-toolbar"');
    expect(src).toContain("ResourceOsToolbar");
    expect(src).toMatch(/key:\s*"status"/);
    // QueryState / DetailPanelShell live in list + peek (peeled from page)
    expect(listSrc).toContain("QueryState");
    expect(detailSrc).toContain("DetailPanelShell");
    expect(src).toContain("BulkActionBar");
    // Status filter lives in hub toolbar — not a third content band
    expect(src).toMatch(/toolbar=\{[\s\S]*ResourceOsToolbar[\s\S]*key:\s*"status"/);
  });
});

describe("W7 satellite — Alerts hub", () => {
  it("keeps severity as thin KPI strip; related/Go-to in overflow (no CrossLinkBar band)", () => {
    const src = read("app/(portal)/alerts/page.tsx");
    const strip = read("app/(portal)/alerts/_components/alerts-severity-strip.tsx");
    const detail = read("app/(portal)/alerts/_components/alerts-detail-panel.tsx");
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain('data-testid="alerts-toolbar"');
    expect(strip).toContain('data-testid="alerts-severity-strip"');
    expect(src).toContain("kpiStrip");
    expect(src).toContain("ResourceOsToolbar");
    expect(src).toContain("DropdownMenu");
    expect(src).toMatch(/More[\s\S]*Incidents|Incidents[\s\S]*More/);
    expect(detail).toContain("DropdownMenuLabel>Go to");
    expect(src).not.toContain("CrossLinkBar");
    expect(detail).not.toContain("CrossLinkBar");
    // No peer CrossLinkBar chrome band in toolbar
    const toolbarStart = src.indexOf('data-testid="alerts-toolbar"');
    const kpiStart = src.indexOf("kpiStrip=");
    expect(toolbarStart).toBeGreaterThan(-1);
    expect(kpiStart).toBeGreaterThan(toolbarStart);
    expect(src.slice(toolbarStart, kpiStart)).not.toContain("CrossLinkBar");
  });
});

describe("W7 satellite — Agents hub", () => {
  it("one toolbar path: tabs + search; related links in More", () => {
    const src = read("app/(portal)/agents/page.tsx");
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain('data-testid="agents-toolbar"');
    expect(src).toContain('href="/agents/connect"');
    expect(src).toContain("DropdownMenu");
    expect(src).toMatch(/Search agents by name/);
    // Search lives in toolbar, not a third content band above the grid
    expect(src).toMatch(/toolbar=\{[\s\S]*Search agents by name/);
  });
});

describe("W7 satellite — Dashboard Home", () => {
  it("caps default KPI widgets at 5–7; Status→Action CTAs ≤3 primary", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    const widgets = read(
      "app/(portal)/dashboard/_components/home-widgets.ts",
    );
    const kpi = read(
      "app/(portal)/dashboard/_components/home-kpi-strip.tsx",
    );
    const diagnosis = read(
      "app/(portal)/dashboard/_components/diagnosis-strip.tsx",
    );
    expect(widgets).toContain("DEFAULT_WIDGETS");
    expect(kpi).toContain('data-testid="dashboard-status-kpis"');
    expect(diagnosis).toContain('data-testid="dashboard-diagnosis"');
    const match = widgets.match(
      /const DEFAULT_WIDGETS: WidgetId\[\] = \[([\s\S]*?)\];/,
    );
    expect(match).toBeTruthy();
    const ids = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/["']/g, ""))
      .filter(Boolean);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(ids.length).toBeLessThanOrEqual(7);
    expect(src).toContain("HomeHeaderActions");
    const header = read(
      "app/(portal)/dashboard/_components/home-header-actions.tsx",
    );
    expect(header).not.toContain("Edit layout");
    expect(header).toContain("DropdownMenu");
    expect(header).toContain("More home actions");
    expect(src).toContain("WAVE11_HOME_PROTECTED");
  });
});

describe("W7 satellite — embeds & leaves", () => {
  it("incidents/signals suppress dual chrome when embedded", () => {
    const incidents = read("app/(portal)/incidents/page.tsx");
    const signals = read("app/(portal)/signals/page.tsx");
    expect(incidents).toContain("useEmbeddedSurface");
    expect(signals).toContain("useEmbeddedSurface");
    expect(incidents).toMatch(/!embedded \? \([\s\S]*PageHeader/);
    expect(signals).toMatch(/!embedded \? \([\s\S]*PageHeader/);
  });

  it("fleet uses shell without CrossLink toolbar band", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain('data-testid="fleet-kpi-strip"');
    expect(src).not.toContain("CrossLinkBar");
    expect(src).toContain("DropdownMenu");
  });

  it("debugger uses Resource OS; no blank Suspense", () => {
    const src = read("app/(portal)/debugger/page.tsx");
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain('data-testid="debugger-toolbar"');
    expect(src).toContain("LoadingSkeleton");
    expect(src).not.toContain("fallback={null}");
  });

  it("replay/inspector use ObserveLeafHeader + Button; no null Suspense", () => {
    const replay = read("app/(portal)/replay/page.tsx");
    const inspector = read("app/(portal)/inspector/page.tsx");
    expect(replay).toContain("ObserveLeafHeader");
    expect(replay).toContain('from "@/components/ui/tabs"');
    expect(replay).toContain("LoadingSkeleton");
    expect(replay).not.toContain("fallback={null}");
    expect(inspector).toContain("ObserveLeafHeader");
  });
});
