/**
 * W3-A — Dashboard telemetry outage uses shared ErrorState + Retry;
 * W1-C first-run derivation must still hold (no installPath loop).
 * Wave 3.1: cost/agentic/latency must not false-empty on hard API failure.
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
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).not.toMatch(/setInstallPath/);
    expect(src).not.toMatch(/useState\(true\);\s*\n\s*useEffect\(\(\) => \{[^}]*setInstallPath/s);
    expect(src).toMatch(/const isFirstRun =/);
    expect(src).toMatch(/!tracesQuery\.isError/);
  });

  it("cost card distinguishes unavailable vs empty on shard failure", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toMatch(/const costUnavailable/);
    expect(src).toMatch(/costComparisonQuery\.isError/);
    expect(src).toMatch(/costKpiQuery\.isError/);
    expect(src).toContain("Cost unavailable — could not load spend.");
    expect(src).toContain("No cost data — start routing calls to populate.");
  });

  it("agentic card uses unavailable copy on isError (not Layer A empty)", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toContain(
      "Agentic scores unavailable — could not load metrics.",
    );
    expect(src).toMatch(/agenticQuery\.isError/);
    expect(src).toContain(
      "Scores appear after Layer A runs on finalized traces.",
    );
  });

  it("latency unavailable when summary errors and no fallback p95", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toMatch(
      /unavailable=\{summaryQuery\.isError && p95 == null\}/,
    );
  });

  it("throughput card surfaces unavailable prop from summary isError", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toMatch(/unavailable=\{summaryQuery\.isError\}/);
    const throughput = read(
      "app/(portal)/dashboard/_components/throughput-card.tsx",
    );
    expect(throughput).toContain("throughput unavailable");
    expect(throughput).toContain("no events yet");
  });

  it("dashboard loading skeleton mirrors KPI + diagnosis + traces layout", () => {
    const loading = read("app/(portal)/dashboard/loading.tsx");
    expect(loading).toContain('aria-label="Loading dashboard"');
    expect(loading).toMatch(/xl:grid-cols-4/);
    expect(loading).toMatch(/xl:grid-cols-3/);
    expect(loading).toMatch(/xl:col-span-2/);
    expect(loading).toContain("Skeleton");
    expect(loading).toMatch(/Status→Diagnosis→Action|diagnosis/i);
  });

  it("default Home layout is 5–7 widgets with Status→Diagnosis→Action", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toMatch(/const DEFAULT_WIDGETS/);
    expect(src).toContain('data-testid="dashboard-status-kpis"');
    expect(src).toContain('data-testid="dashboard-diagnosis"');
    expect(src).toContain("Open Traces");
    expect(src).toContain('aria-label="Time range"');
    expect(src).not.toMatch(/text-\[9px\]|text-\[10px\]|text-\[11px\]/);
    // Default visible set ≤7 (agentic + links are progressive extras).
    const defaultMatch = src.match(
      /const DEFAULT_WIDGETS:\s*WidgetId\[\]\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(defaultMatch).toBeTruthy();
    const ids = (defaultMatch![1].match(/"[a-z]+"/g) ?? []).length;
    expect(ids).toBeGreaterThanOrEqual(5);
    expect(ids).toBeLessThanOrEqual(7);
  });

  it("latency/throughput cards use Skeleton while loading (not spinner-only)", () => {
    const latency = read(
      "app/(portal)/dashboard/_components/latency-card.tsx",
    );
    const throughput = read(
      "app/(portal)/dashboard/_components/throughput-card.tsx",
    );
    expect(latency).toContain('from "@/components/ui/skeleton"');
    expect(throughput).toContain('from "@/components/ui/skeleton"');
    expect(latency).not.toMatch(/Loader2/);
    expect(throughput).not.toMatch(/Loader2/);
  });
});
