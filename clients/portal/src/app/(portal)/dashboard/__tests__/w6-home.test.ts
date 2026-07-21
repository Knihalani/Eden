/**
 * Wave 6 — Home / Dashboard exit criteria (updated for Wave 7 composition).
 * Status → Diagnosis → one Action; KPI ≤4; page <400 LOC; first-run polish.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave 6 Home / Dashboard exit", () => {
  const page = read("app/(portal)/dashboard/page.tsx");
  const widgets = read(
    "app/(portal)/dashboard/_components/home-widgets.ts",
  );
  const hook = read(
    "app/(portal)/dashboard/_components/use-home-dashboard.ts",
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
  const firstRun = read(
    "app/(portal)/dashboard/_components/home-first-run.tsx",
  );
  const header = read(
    "app/(portal)/dashboard/_components/home-header-actions.tsx",
  );

  it("marks wave6-home completed", () => {
    expect(page).toContain("WAVE6_HOME_COMPLETED = true");
    expect(page).toContain('data-wave6-home="completed"');
  });

  it("keeps page.tsx under 400 LOC", () => {
    const lines = page.split("\n").length;
    expect(lines).toBeLessThan(400);
  });

  it("default KPI strip is throughput, errors, cost, open issues (≤4)", () => {
    expect(widgets).toContain("HOME_KPI_STRIP_CAP = 4");
    const match = widgets.match(
      /const DEFAULT_WIDGETS:\s*WidgetId\[\]\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(match).toBeTruthy();
    const ids = (match![1].match(/"[a-z-]+"/g) ?? []).map((s) =>
      s.replace(/"/g, ""),
    );
    expect(ids).toEqual([
      "throughput",
      "errors",
      "cost",
      "issues",
      "failures",
      "traces",
    ]);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(ids.length).toBeLessThanOrEqual(7);
    expect(widgets).toContain("HOME_KPI_IDS");
    expect(widgets).not.toContain("EDIT_ONLY_WIDGETS");
    expect(widgets).not.toContain("loadLayout");
  });

  it("Status → Diagnosis → one Action with testids", () => {
    expect(page).toContain("HomeKpiStrip");
    expect(page).toContain("DiagnosisStrip");
    expect(page).toContain("RecentFailuresCard");
    expect(header).toContain("Open Traces");
    expect(kpi).toContain('data-testid="dashboard-status-kpis"');
    expect(diagnosis).toContain('data-testid="dashboard-diagnosis"');
    expect(failures).toContain('data-testid="dashboard-recent-failures"');
    // Single primary deep link in diagnosis (not dual Alerts+Issues).
    const actionButtons = diagnosis.match(/Button asChild/g) ?? [];
    expect(actionButtons.length).toBe(1);
  });

  it("no re-widget / Edit layout (Wave 11 protect)", () => {
    expect(header).not.toContain("Edit layout");
    expect(header).toContain("More home actions");
    expect(page).toContain("WAVE11_HOME_PROTECTED");
    expect(page).not.toContain("toggleWidget");
    expect(page).not.toContain("dashboard-edit-layout");
    expect(hook).not.toContain("toggleWidget");
    expect(hook).not.toContain("loadLayout");
  });

  it("first-run uses FIRST_EVENT_WAIT polish", () => {
    expect(firstRun).toContain("FIRST_EVENT_WAIT");
    expect(firstRun).toContain("FIRST_EVENT_WAIT.title");
    expect(firstRun).toContain("FIRST_EVENT_WAIT.checkCta");
    expect(firstRun).toContain("FIRST_EVENT_WAIT.doctorNpx");
    expect(firstRun).toContain("FIRST_EVENT_WAIT.doctorPython");
    expect(firstRun).toContain('data-testid="dashboard-first-run"');
    expect(page).toContain("HomeFirstRun");
  });

  it("quiet sticky time range control", () => {
    expect(header).toContain("TimeRangeControl");
    const time = read(
      "app/(portal)/dashboard/_components/time-range-control.tsx",
    );
    expect(time).toContain('aria-label="Time range"');
    expect(time).toContain('data-testid="dashboard-time-range"');
    expect(time).toContain("bg-[var(--bg-secondary)]");
  });

  it("mobile hides 4th+ KPI cells above fold", () => {
    expect(kpi).toContain("HOME_MOBILE_ABOVE_FOLD");
    expect(kpi).toContain("max-md:[&>*:nth-child(n+4)]:hidden");
    expect(widgets).toContain("HOME_MOBILE_ABOVE_FOLD = 3");
  });

  it("gates cost behind layoutReady + show(widget); no agentic query", () => {
    expect(hook).toMatch(/layoutReady/);
    expect(hook).toMatch(
      /enabled:\s*layoutReady\s*&&\s*show\(["']cost["']\)/,
    );
    expect(hook).not.toContain("show(\"agentic\")");
    expect(hook).not.toContain("agenticQuery");
  });

  it("derives isFirstRun without installPath setState effect", () => {
    expect(hook).not.toMatch(/setInstallPath/);
    expect(hook).toMatch(/const isFirstRun =/);
    expect(hook).toMatch(/!tracesQuery\.isError/);
  });
});
