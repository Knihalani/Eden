// @vitest-environment node
/**
 * A2 portal data — structural Done-when checks for Wave-1 optimization IDs.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("A2 portal data Done-when", () => {
  it("K3: no home-dashboard query on dashboard", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).not.toMatch(/home-dashboard/);
    expect(src).not.toMatch(/getHomeDashboard/);
  });

  it("P26: IntelligenceGrid module removed", () => {
    expect(
      existsSync(join(root, "app/(portal)/dashboard/_components/intelligence-grid.tsx")),
    ).toBe(false);
  });

  it("K6: LiveTail enabled default false + visibility pause", () => {
    const src = read("app/(portal)/traces/_components/LiveTailPanel.tsx");
    expect(src).toMatch(/enabledProp \?\? false|enabled = false/);
    expect(src).toMatch(/visibilityState|visibilitychange/);
    expect(src).toMatch(/streamEnabled = userEnabled && visible|enabled && visible/);
  });

  it("K7: users/analytics tab-gate fetches", () => {
    const users = read("app/(portal)/users/page.tsx");
    expect(users).toMatch(/enabled:\s*activeTab\s*===\s*"sessions"/);
    expect(users).toMatch(/enabled:\s*activeTab\s*===\s*"goals"/);
    const analytics = read("app/(portal)/analytics/page.tsx");
    expect(analytics).toMatch(/enabled:\s*tab\s*===\s*"overview"/);
  });

  it("K4: TraceDetail meta+tree parallel", () => {
    const src = read("components/traces/TraceDetailPanel.tsx");
    expect(src).toMatch(/Promise\.all\(/);
    expect(src).toMatch(/listObservabilityTraces/);
    expect(src).toMatch(/getTraceTree/);
  });

  it("K5: session traces use batch trace_ids request", () => {
    const src = read("app/(portal)/sessions/[sessionId]/page.tsx");
    expect(src).toMatch(/trace_ids/);
    expect(src).not.toMatch(/ids\.map\(\s*\(tid\)\s*=>/);
  });

  it("K8/P7: dashboard+traces share days in traces query key", () => {
    const dash = read("app/(portal)/dashboard/page.tsx");
    const traces = read("app/(portal)/traces/page.tsx");
    expect(dash).toMatch(/days:\s*7/);
    expect(traces).toMatch(/days:\s*7/);
    expect(dash).toMatch(/queryKeys\.observability\.traces/);
    expect(traces).toMatch(/queryKeys\.observability\.traces/);
    const keys = read("lib/query-keys.ts");
    expect(keys).toMatch(/kpi:/);
    expect(keys).toMatch(/sessionTraces:/);
  });

  it("P4: alerts poll ≥30s and tab-gated", () => {
    const src = read("app/(portal)/alerts/page.tsx");
    expect(src).toMatch(/refetchInterval:\s*30_000/);
    expect(src).not.toMatch(/refetchInterval:\s*15_000/);
    expect(src).toMatch(
      /enabled:\s*!orgSyncing\s*&&\s*!showSignals\s*&&\s*!rulesOpen/,
    );
    // Dual-poll consolidate: only listAlerts keeps refetchInterval.
    const intervals = src.match(/refetchInterval:\s*30_000/g) ?? [];
    expect(intervals.length).toBe(1);
  });

  it("P5: budget refetch ≥30s", () => {
    const src = read("app/(portal)/optimization/budget/page.tsx");
    expect(src).toMatch(/refetchInterval:\s*30_000/);
    expect(src).not.toMatch(/refetchInterval:\s*5_000/);
    // Dual-poll consolidate: only budget detail keeps refetchInterval.
    const intervals = src.match(/refetchInterval:\s*30_000/g) ?? [];
    expect(intervals.length).toBe(1);
  });

  it("P6 top-8: pages use useOrgQuery", () => {
    const files = [
      "app/(portal)/audit-trail/page.tsx",
      "app/(portal)/artifacts/page.tsx",
      "app/(portal)/synthetic/page.tsx",
      "app/(portal)/studio/page.tsx",
      "app/(portal)/observability/eval/page.tsx",
      "app/(portal)/observability/retrieval/page.tsx",
      "app/(portal)/settings/_components/gateway-tab.tsx",
      "app/(portal)/settings/_components/exports-tab.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, f).toMatch(/useOrgQuery/);
    }
  });

  it("P12: alerts + improve use virtualization", () => {
    const alerts = read("app/(portal)/alerts/page.tsx");
    const improve = read("app/(portal)/improve/page.tsx");
    expect(alerts).toMatch(/VirtualizedList|InfiniteDataTable/);
    expect(improve).toMatch(/VirtualizedList|InfiniteDataTable/);
  });

  it("P18: dehydrate helpers + dashboard/traces layouts consume them", () => {
    const src = read("lib/portal-dehydrate.ts");
    expect(src).toMatch(/dehydrateDashboardHome/);
    expect(src).toMatch(/dehydrateTracesHub/);
    expect(src).toMatch(/days:\s*DEFAULT_DAYS|days:\s*7/);
    // Wave-2: seed ME_QUERY_KEY so client skips immediate /auth/me refetch.
    expect(src).toMatch(/ME_QUERY_KEY\s*=\s*\["auth",\s*"me"\]/);
    expect(src).toMatch(/seedMeQuery/);
    const dashLayout = read("app/(portal)/dashboard/layout.tsx");
    const tracesLayout = read("app/(portal)/traces/layout.tsx");
    expect(dashLayout).toMatch(/dehydrateDashboardHome/);
    expect(dashLayout).toMatch(/HydrationBoundary/);
    expect(dashLayout).toMatch(/\bme\b/);
    expect(tracesLayout).toMatch(/dehydrateTracesHub/);
    expect(tracesLayout).toMatch(/HydrationBoundary/);
    expect(tracesLayout).toMatch(/\bme\b/);
  });

  it("P27: StreamingSparkline uses useOrgQuery", () => {
    const src = read("components/streaming-sparkline.tsx");
    expect(src).toMatch(/useOrgQuery/);
    expect(src).not.toMatch(/fetch\(`\$\{API_BASE\}/);
  });

  it("B12/B13: labeling+playgrounds request limit", () => {
    const labeling = read("app/(portal)/labeling/page.tsx");
    const playgrounds = read("app/(portal)/playgrounds/page.tsx");
    expect(labeling).toMatch(/limit=100/);
    expect(playgrounds).toMatch(/limit=100/);
  });
});
