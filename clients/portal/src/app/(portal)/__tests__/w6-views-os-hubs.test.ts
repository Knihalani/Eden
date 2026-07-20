/**
 * Wave 6 gap-close — Issues + Alerts Views OS (P0-2 / §2.2).
 * Same ResourceOsToolbar → ViewsMenu + isViewDirty + useSavedViews path as Traces.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6 Issues/Alerts Views OS (P0-2 / §2.2)", () => {
  it("ResourceOsToolbar wires ViewsMenu dirty · save · discard", () => {
    const src = read("components/portal-os/ResourceOsToolbar.tsx");
    expect(src).toContain("ViewsMenu");
    expect(src).toContain("useSavedViews");
    expect(src).toContain("isViewDirty");
    expect(src).toContain("onSaveChanges");
    expect(src).toContain("onDiscard");
    expect(src).toContain("onFiltersChange");
    expect(src).toContain("viewsDirty");
    expect(src).toContain("data-testid={`${resourceKey}-views-os`}");
  });

  it("Issues hub uses ResourceOsToolbar Views OS with status in ViewState", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain('resourceKey="issues"');
    expect(src).toContain("ResourceOsToolbar");
    expect(src).toContain("onFiltersChange");
    expect(src).toContain('key: "status"');
    expect(src).toContain("sticky");
    // Status lives in QueryFilterBar selects — not a one-off chrome select
    expect(src).not.toContain('id="issues-status-filter"');
  });

  it("Alerts hub uses ResourceOsToolbar Views OS with severity/ack/verdict", () => {
    const src = read("app/(portal)/alerts/page.tsx");
    expect(src).toContain('resourceKey="alerts"');
    expect(src).toContain("ResourceOsToolbar");
    expect(src).toContain("onFiltersChange");
    expect(src).toContain('key: "severity"');
    expect(src).toContain('key: "ack"');
    expect(src).toContain('key: "verdict"');
    expect(src).toContain("sticky");
  });
});
