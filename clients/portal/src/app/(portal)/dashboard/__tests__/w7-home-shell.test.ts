/**
 * Wave 7 — Home composition overhaul (Home + Shell fleet).
 * Restraint KPI strip · diagnosis one-CTA · master-list failures · no widget editor.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave 7 Home composition", () => {
  const page = read("app/(portal)/dashboard/page.tsx");
  const widgets = read(
    "app/(portal)/dashboard/_components/home-widgets.ts",
  );
  const kpi = read(
    "app/(portal)/dashboard/_components/home-kpi-strip.tsx",
  );
  const diagnosis = read(
    "app/(portal)/dashboard/_components/diagnosis-strip.tsx",
  );
  const failures = read(
    "app/(portal)/dashboard/_components/recent-failures-card.tsx",
  );
  const header = read(
    "app/(portal)/dashboard/_components/home-header-actions.tsx",
  );
  const hook = read(
    "app/(portal)/dashboard/_components/use-home-dashboard.ts",
  );
  const quiet = read(
    "app/(portal)/dashboard/_components/home-quiet-links.tsx",
  );
  const loading = read("app/(portal)/dashboard/loading.tsx");

  it("marks wave7 composition + preserves W6/W11 intent", () => {
    expect(page).toContain("WAVE7_HOME_COMPOSITION = true");
    expect(page).toContain('data-wave7-home="composition"');
    expect(page).toContain("WAVE6_HOME_COMPLETED = true");
    expect(page).toContain("WAVE11_HOME_PROTECTED = true");
    expect(page).toContain('data-home-shell-home="status-diagnosis-action"');
  });

  it("KPI strip is restraint metrics (not card collage)", () => {
    expect(kpi).toContain('data-home-shell-kpi="restraint"');
    expect(kpi).not.toMatch(/from ["']@\/components\/ui\/stat-card["']/);
    expect(kpi).not.toContain("ThroughputCard");
    expect(kpi).not.toContain("LatencyCard");
    expect(widgets).toContain("HOME_KPI_STRIP_CAP = 4");
    expect(page).toContain("HomeKpiStrip");
  });

  it("Diagnosis owns one primary CTA", () => {
    expect(diagnosis).toContain('data-home-shell-diagnosis="one-cta"');
    expect((diagnosis.match(/Button asChild/g) ?? []).length).toBe(1);
    expect(page).toContain("DiagnosisStrip");
  });

  it("Recent failures is master-list with traces deep link", () => {
    expect(failures).toContain('data-home-shell-failures="master-list"');
    expect(failures).toContain("/traces?traceId=");
    expect(failures).toContain("/traces?outcome=failure");
    expect(page).toContain("RecentFailuresCard");
  });

  it("toolbar ≤5 actions; no Edit layout", () => {
    expect(header).toContain('data-home-shell-toolbar="≤5"');
    expect(header).not.toContain("Edit layout");
    expect(header).toContain("TimeRangeControl");
    expect(header).toContain("Open Traces");
    expect(header).toContain("More home actions");
  });

  it("hook is data contract only — no widget editor / agentic", () => {
    expect(hook).toContain("DEFAULT_WIDGETS");
    expect(hook).not.toContain("loadLayout");
    expect(hook).not.toContain("toggleWidget");
    expect(hook).not.toContain("agenticQuery");
    expect(widgets).not.toContain("loadLayout");
    expect(widgets).not.toContain("EDIT_ONLY_WIDGETS");
  });

  it("dead Home widgets removed; quiet links replace quick-links card", () => {
    const dash = resolve(portalSrc, "app/(portal)/dashboard/_components");
    expect(existsSync(resolve(dash, "quick-links.tsx"))).toBe(false);
    expect(existsSync(resolve(dash, "latency-card.tsx"))).toBe(false);
    expect(existsSync(resolve(dash, "throughput-card.tsx"))).toBe(false);
    expect(existsSync(resolve(dash, "recent-traces-card.tsx"))).toBe(false);
    expect(page).toContain("HomeQuietLinks");
    expect(quiet).toContain('data-home-shell-links="quiet"');
    expect(widgets).toContain("HOME_QUIET_LINKS");
    expect(widgets).toContain('/improve/scorecard');
    expect(widgets).toContain('label: "Scorecard"');
  });

  it("loading skeleton matches restraint strip (not icon cards)", () => {
    const skeleton = read(
      "app/(portal)/dashboard/_components/home-dashboard-skeleton.tsx",
    );
    expect(loading).toContain("HomeDashboardSkeleton");
    expect(skeleton).toContain('data-home-shell-kpi="restraint"');
    expect(skeleton).not.toContain("h-10 w-10 rounded-lg");
    expect(skeleton).toContain("xl:grid-cols-4");
  });
});
