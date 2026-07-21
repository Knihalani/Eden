/**
 * W3-A — Dashboard telemetry outage uses shared ErrorState + Retry;
 * W1-C first-run derivation must still hold (no installPath loop).
 * Wave 7: restraint KPI strip (no agentic/latency edit-only cards).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W3-A dashboard ErrorState", () => {
  it("uses shared ErrorState with Retry for telemetry failures", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load some telemetry."');
    expect(src).toContain("Retry");
    expect(src).toContain("shard.query.refetch()");
    expect(src).not.toMatch(
      /Could not load some telemetry\.[\s\S]{0,200}border-\[var\(--error\)\]\/40/,
    );
  });

  it("keeps W1-C isFirstRun derivation (no installPath setState loop)", () => {
    const src = read(
      "app/(portal)/dashboard/_components/use-home-dashboard.ts",
    );
    expect(src).not.toMatch(/setInstallPath/);
    expect(src).not.toMatch(
      /useState\(true\);\s*\n\s*useEffect\(\(\) => \{[\s\S]*?setInstallPath/,
    );
    expect(src).toMatch(/const isFirstRun =/);
    expect(src).toMatch(/!tracesQuery\.isError/);
  });

  it("cost cell distinguishes unavailable vs empty on shard failure", () => {
    const hook = read(
      "app/(portal)/dashboard/_components/use-home-dashboard.ts",
    );
    const kpi = read(
      "app/(portal)/dashboard/_components/home-kpi-strip.tsx",
    );
    expect(hook).toMatch(/const costUnavailable/);
    expect(hook).toMatch(/costComparisonQuery\.isError/);
    expect(hook).toMatch(/costKpiQuery\.isError/);
    expect(hook).toContain("cost unavailable");
    expect(hook).toContain("no cost data yet");
    expect(kpi).toContain("costUnavailable");
    expect(kpi).toContain("costEmpty");
  });

  it("throughput/errors cells surface summaryError as unavailable", () => {
    const kpi = read(
      "app/(portal)/dashboard/_components/home-kpi-strip.tsx",
    );
    expect(kpi).toContain("summaryError");
    expect(kpi).toContain("unavailable");
    expect(kpi).toContain("no events yet");
  });

  it("dashboard loading skeleton mirrors restraint KPI + diagnosis + failures", () => {
    const loading = read("app/(portal)/dashboard/loading.tsx");
    const skeleton = read(
      "app/(portal)/dashboard/_components/home-dashboard-skeleton.tsx",
    );
    expect(loading).toContain("HomeDashboardSkeleton");
    expect(skeleton).toContain('label = "Loading dashboard"');
    expect(skeleton).toContain("aria-label={label}");
    expect(skeleton).toMatch(/xl:grid-cols-4/);
    expect(skeleton).toContain('data-home-shell-kpi="restraint"');
    expect(skeleton).toContain("Skeleton");
    expect(skeleton).toMatch(/Status → Diagnosis → Action|diagnosis/i);
  });

  it("default Home layout is 5–7 widgets with Status→Diagnosis→Action", () => {
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
    expect(widgets).toMatch(/const DEFAULT_WIDGETS/);
    expect(kpi).toContain('data-testid="dashboard-status-kpis"');
    expect(diagnosis).toContain('data-testid="dashboard-diagnosis"');
    expect(page).toContain("HomeHeaderActions");
    const header = read(
      "app/(portal)/dashboard/_components/home-header-actions.tsx",
    );
    expect(header).toContain("Open Traces");
    expect(page).not.toMatch(/text-\[9px\]|text-\[10px\]|text-\[11px\]/);
    const defaultMatch = widgets.match(
      /const DEFAULT_WIDGETS:\s*WidgetId\[\]\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(defaultMatch).toBeTruthy();
    const ids = (defaultMatch![1].match(/"[a-z-]+"/g) ?? []).length;
    expect(ids).toBeGreaterThanOrEqual(5);
    expect(ids).toBeLessThanOrEqual(7);
  });

  it("KPI strip uses Skeleton while loading (not spinner-only)", () => {
    const kpi = read(
      "app/(portal)/dashboard/_components/home-kpi-strip.tsx",
    );
    expect(kpi).toContain('from "@/components/ui/skeleton"');
    expect(kpi).toContain("Skeleton");
    expect(kpi).not.toMatch(/Loader2/);
  });
});
