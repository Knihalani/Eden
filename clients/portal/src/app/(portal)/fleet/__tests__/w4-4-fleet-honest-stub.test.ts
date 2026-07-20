/**
 * Wave 4.4 — Fleet honest stub (not a dead core-nav lie).
 *
 * Keep minimal health API wiring when present; empty / unavailable
 * must surface clear CTAs to Issues + SDK (not zero KPIs pretending
 * to be a full N05 product).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/core";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

/** Mirrors page helper: feature-gated fleet returns 404. */
function isFleetUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

function showFleetKpis(opts: {
  loading: boolean;
  error: unknown | null;
}): boolean {
  return !opts.loading && !opts.error;
}

function showFleetEmpty(opts: {
  loading: boolean;
  error: unknown | null;
  agentCount: number;
}): boolean {
  if (opts.loading) return false;
  if (opts.error) return false;
  return opts.agentCount === 0;
}

describe("W4-4 fleet honest stub", () => {
  it("wires fleetApi summary/heatmap/delegation (minimal health API)", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain("fleetApi.summary");
    expect(src).toContain("fleetApi.heatmap");
    expect(src).toContain("fleetApi.delegation");
    expect(src).toContain('from "@/lib/api"');
  });

  it("tab-gates heatmap and delegation queries", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toMatch(/enabled:\s*tab\s*===\s*"heatmap"/);
    expect(src).toMatch(/enabled:\s*tab\s*===\s*"delegation"/);
  });

  it("empty and unavailable states use EmptyState with Issues + SDK CTAs", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain('from "@/components/ui/empty-state"');
    expect(src).toContain('data-testid="fleet-onboarding-ctas"');
    expect(src).toContain('href="/issues"');
    expect(src).toContain("Install SDK");
    expect(src).toContain("DOCS_QUICKSTART_URL");
    expect(src).toContain('href="/settings?tab=api-keys"');
    expect(src).toContain("No agents in the fleet yet");
    expect(src).toContain("Fleet Health is not available yet");
  });

  it("load failures use QueryState with retry, not empty zeros", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain("Could not load fleet");
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain("QueryState");
    expect(src).toContain("summaryQuery.refetch()");
  });

  it("hides KPI strip while loading or on error", () => {
    expect(showFleetKpis({ loading: true, error: null })).toBe(false);
    expect(showFleetKpis({ loading: false, error: new Error("boom") })).toBe(false);
    expect(showFleetKpis({ loading: false, error: null })).toBe(true);

    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain("showKpis");
    expect(src).toContain('data-testid="fleet-kpi-strip"');
  });

  it("treats ApiError 404 as unavailable (flag off), not empty success", () => {
    expect(isFleetUnavailable(new ApiError(404, "Not Found"))).toBe(true);
    expect(isFleetUnavailable(new ApiError(500, "boom"))).toBe(false);
    expect(isFleetUnavailable(new Error("Not Found"))).toBe(false);

    expect(
      showFleetEmpty({
        loading: false,
        error: new ApiError(404, "Not Found"),
        agentCount: 0,
      }),
    ).toBe(false);
    expect(
      showFleetEmpty({ loading: false, error: null, agentCount: 0 }),
    ).toBe(true);
  });

  it("does not oversell full N05 product in subtitle", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain("not a full fleet SRE product yet");
    expect(src).not.toContain(
      "Multi-agent SRE view — severity-ranked health cards, stumble heatmap, and delegation graph.",
    );
  });
});
