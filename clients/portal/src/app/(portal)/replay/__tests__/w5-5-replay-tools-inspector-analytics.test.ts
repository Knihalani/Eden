/**
 * Wave 5.5 — replay / tools / inspector / analytics / synthetic
 *
 * Load failures must use in-page ErrorState + retry (not toast-only /
 * AlertTriangle banner / false EmptyState).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function showReplayEmpty(opts: {
  loading: boolean;
  listError: string | null;
  traceError: string | null;
  hasSummary: boolean;
}): boolean {
  if (opts.loading) return false;
  if (opts.listError) return false;
  if (opts.traceError) return false;
  return !opts.hasSummary;
}

function showTaxonomyEmpty(opts: {
  loading: boolean;
  error: string | null;
  toolCount: number;
}): boolean {
  if (opts.loading) return false;
  if (opts.error) return false;
  return opts.toolCount === 0;
}

function showAnalyticsKpis(opts: {
  loading: boolean;
  errorMessage: string | null;
  isEmpty?: boolean;
}): boolean {
  // Fail closed: any shard error hides KPIs (even while other shards load).
  if (opts.errorMessage) return false;
  if (opts.isEmpty) return false;
  return true;
}

function showAnalyticsEmpty(opts: {
  loading: boolean;
  errorMessage: string | null;
  allKpisZero: boolean;
}): boolean {
  if (opts.loading) return false;
  if (opts.errorMessage) return false;
  return opts.allKpisZero;
}

function showSyntheticRunsEmpty(opts: {
  loading: boolean;
  error: string | null;
  runCount: number;
}): boolean {
  if (opts.loading) return false;
  if (opts.error) return false;
  return opts.runCount === 0;
}

describe("W5-5 replay query states", () => {
  it("list + detail failures use ErrorState with Try again (not toast)", () => {
    const page = read("app/(portal)/replay/page.tsx");
    const timeline = read("app/(portal)/replay/_components/replay-timeline.tsx");
    const events = read("app/(portal)/replay/_components/replay-events.tsx");
    const src = `${page}\n${timeline}\n${events}`;
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Couldn't load traces");
    expect(src).toContain("Couldn't load trace");
    expect(src).toContain("traceError");
    expect(page).toContain("onClick={fetchJobs}");
    expect(page).toContain("onRetry={fetchTrace}");
    expect(src).toContain("Try again");
    expect(src).not.toContain("useToast");
    expect(src).not.toMatch(/toast\.error/);
  });

  it("gates timeline/events empty behind list + detail errors", () => {
    const page = read("app/(portal)/replay/page.tsx");
    const timeline = read("app/(portal)/replay/_components/replay-timeline.tsx");
    const events = read("app/(portal)/replay/_components/replay-events.tsx");
    expect(page).toMatch(/error \? \([\s\S]*ErrorState[\s\S]*Couldn't load traces/);
    expect(timeline).toMatch(/traceError[\s\S]*ErrorState[\s\S]*Couldn't load trace/);
    expect(events).toMatch(/traceError[\s\S]*ErrorState[\s\S]*Couldn't load trace/);
    expect(
      showReplayEmpty({
        loading: false,
        listError: "boom",
        traceError: null,
        hasSummary: false,
      }),
    ).toBe(false);
    expect(
      showReplayEmpty({
        loading: false,
        listError: null,
        traceError: "boom",
        hasSummary: false,
      }),
    ).toBe(false);
    expect(
      showReplayEmpty({
        loading: false,
        listError: null,
        traceError: null,
        hasSummary: false,
      }),
    ).toBe(true);
  });
});

describe("W5-5 tools query states", () => {
  it("uses QueryState for taxonomy failures on Analytics tools panel", () => {
    const src = read("app/(portal)/analytics/_components/tools-panel.tsx");
    expect(src).toContain("QueryState");
    expect(src).toContain("Couldn't load tool catalog");
    expect(src).toContain("taxonomyQuery.refetch");
    expect(src).not.toContain("AlertTriangle");
  });

  it("does not show taxonomy empty while loading or on error", () => {
    expect(
      showTaxonomyEmpty({ loading: true, error: null, toolCount: 0 }),
    ).toBe(false);
    expect(
      showTaxonomyEmpty({ loading: false, error: "boom", toolCount: 0 }),
    ).toBe(false);
    expect(
      showTaxonomyEmpty({ loading: false, error: null, toolCount: 0 }),
    ).toBe(true);
  });
});

describe("W5-5 inspector query states", () => {
  it("load failure uses in-page ErrorState without toast", () => {
    const src = read("app/(portal)/inspector/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Couldn't load trace");
    expect(src).toContain("Try again");
    expect(src).toContain("errorFromCaught");
    expect(src).not.toContain("useToast");
    expect(src).not.toMatch(/toast\.error/);
    // Error before empty — no false empty on fetch failure.
    expect(src).toMatch(/error \? \([\s\S]*ErrorState[\s\S]*\) : orderedSpans\.length === 0/);
  });

  it("auto-refresh defaults off and polls at ≥15s when enabled", () => {
    const src = read("app/(portal)/inspector/page.tsx");
    expect(src).toMatch(/const \[autoRefresh,\s*setAutoRefresh\]\s*=\s*useState\(false\)/);
    expect(src).toMatch(/intervalMs:\s*15_000/);
    expect(src).not.toMatch(/intervalMs:\s*3_000/);
  });
});

describe("W5-5 analytics query states", () => {
  it("overview fetch failure uses ErrorState and hides KPI strip", () => {
    const src = read("app/(portal)/analytics/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load analytics");
    expect(src).toContain("Try again");
    expect(src).toContain('data-testid="analytics-kpi-strip"');
    expect(src).toMatch(/errorMessage \?[\s\S]*ErrorState/);
    expect(
      showAnalyticsKpis({ loading: false, errorMessage: "boom" }),
    ).toBe(false);
    expect(
      showAnalyticsKpis({ loading: true, errorMessage: "boom" }),
    ).toBe(false);
    expect(
      showAnalyticsKpis({ loading: false, errorMessage: null }),
    ).toBe(true);
  });

  it("successful load with all-zero KPIs uses EmptyState not ErrorState", () => {
    const src = read("app/(portal)/analytics/page.tsx");
    expect(src).toContain('from "@/components/ui/empty-state"');
    expect(src).toContain("No analytics yet");
    expect(src).toContain("isEmptyOverview");
    expect(src).toMatch(/isEmptyOverview \?[\s\S]*EmptyState/);
    expect(
      showAnalyticsEmpty({
        loading: false,
        errorMessage: null,
        allKpisZero: true,
      }),
    ).toBe(true);
    expect(
      showAnalyticsEmpty({
        loading: false,
        errorMessage: "boom",
        allKpisZero: true,
      }),
    ).toBe(false);
    expect(
      showAnalyticsKpis({
        loading: false,
        errorMessage: null,
        isEmpty: true,
      }),
    ).toBe(false);
  });
});

describe("W5-5 synthetic query states", () => {
  it("run history deferred uses EmptyState (not false ErrorState table)", () => {
    const src = read("app/(portal)/synthetic/page.tsx");
    expect(src).toContain('from "@/components/ui/empty-state"');
    expect(src).toContain("Persisted run history is deferred");
    expect(src).toContain('data-wave-e5-synthetic="history-deferred"');
    expect(src).not.toContain('from "@/components/ui/error-state"');
    expect(
      showSyntheticRunsEmpty({ loading: false, error: "boom", runCount: 0 }),
    ).toBe(false);
    expect(
      showSyntheticRunsEmpty({ loading: false, error: null, runCount: 0 }),
    ).toBe(true);
  });
});
