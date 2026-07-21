/**
 * Wave 7 — Improve V3 Cost (`/optimization`) redesign contracts.
 * 7.1 Primary tabs ≤4 · 7.2 Outcomes KPI strip · 7.3 Advisor compare ·
 * 7.4 Flatten nested headers + soft redirects · 7.5 Improve cross-link ·
 * 7.6 Marker `data-wave7-improve-cost`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHubRedirectUrl,
  HUB_REDIRECT_RULES,
} from "@/lib/portal-hub-redirect";

const portalRoot = resolve(__dirname, "../../../../..");
const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave 7.1 primary tabs ≤4", () => {
  it("Cost hub PRIMARY_TABS are cost|budget|outcomes|advisor", () => {
    const src = read("app/(portal)/optimization/page.tsx");
    expect(src).toContain(
      'const PRIMARY_TABS = ["cost", "budget", "outcomes", "advisor"]',
    );
    expect(src).toContain("ADVANCED_TABS");
    expect(src).toContain('data-testid="cost-advanced"');
    // Predict modes stay Advanced overflow — not a 5th primary underline tab.
    expect(src).not.toMatch(/PRIMARY_TABS = \[[^\]]*predict/);
  });
});

describe("Wave 7.2 Outcomes KPI strip (no StatCard soup)", () => {
  it("outcomes uses OutcomesKpiStrip not card KPIs", () => {
    const page = read("app/(portal)/optimization/outcomes/page.tsx");
    const strip = read("app/(portal)/optimization/_components/outcomes-kpi-strip.tsx");
    expect(page).toContain("OutcomesKpiStrip");
    expect(page).not.toMatch(/from "@\/components\/ui\/stat-card"/);
    expect(strip).toContain('data-testid="outcomes-kpi-strip"');
    expect(strip).not.toMatch(/from "@\/components\/ui\/stat-card"/);
  });
});

describe("Wave 7.3 Model Advisor side-by-side cost/latency/tokens", () => {
  it("CompareView exposes cost, latency, and context tokens rows", () => {
    const cmp = read(
      "app/(portal)/optimization/model-advisor/_components/compare-view.tsx",
    );
    expect(cmp).toContain("Side-by-side comparison");
    expect(cmp).toContain('label="Input $/1K"');
    expect(cmp).toContain('label="p95 latency"');
    expect(cmp).toContain('label="Context tokens"');
    expect(cmp).toContain("fmtTokens");
  });

  it("Advisor page mounts side-by-side compare + project without nested title chrome", () => {
    const page = read("app/(portal)/optimization/model-advisor/page.tsx");
    expect(page).toContain('data-testid="advisor-side-by-side"');
    expect(page).toContain('data-wave7-advisor="compare"');
    expect(page).not.toMatch(/from "@\/components\/layout\/page-header"/);
  });

  it("ProjectView uses KPI cells not card KPIs", () => {
    const proj = read(
      "app/(portal)/optimization/model-advisor/_components/project-view.tsx",
    );
    expect(proj).toContain('data-testid="advisor-project-kpi"');
    expect(proj).not.toMatch(/from "@\/components\/ui\/stat-card"/);
  });
});

describe("Wave 7.4 flatten nested headers + soft redirects", () => {
  it("budget and outcomes soft-redirect orphans when not embedded", () => {
    const budget = read("app/(portal)/optimization/budget/page.tsx");
    const outcomes = read("app/(portal)/optimization/outcomes/page.tsx");
    expect(budget).toContain("useEmbeddedSurface");
    expect(budget).toContain('router.replace("/optimization?tab=budget")');
    expect(budget).not.toMatch(/from "@\/components\/layout\/page-header"/);
    expect(outcomes).toContain("useEmbeddedSurface");
    expect(outcomes).toContain('router.replace("/optimization?tab=outcomes")');
    expect(outcomes).not.toMatch(/from "@\/components\/layout\/page-header"/);
  });

  it("next.config + hub rules redirect budget/outcomes orphans", () => {
    const nextConfig = readFileSync(resolve(portalRoot, "next.config.ts"), "utf8");
    expect(nextConfig).toContain('source: "/optimization/budget"');
    expect(nextConfig).toContain('destination: "/optimization?tab=budget"');
    expect(nextConfig).toContain('source: "/optimization/outcomes"');
    expect(nextConfig).toContain('destination: "/optimization?tab=outcomes"');
    expect(HUB_REDIRECT_RULES["/optimization/budget"]).toEqual({
      destination: "/optimization",
      tab: "budget",
    });
    expect(HUB_REDIRECT_RULES["/optimization/outcomes"]).toEqual({
      destination: "/optimization",
      tab: "outcomes",
    });
    expect(buildHubRedirectUrl("/optimization/budget", "")).toBe(
      "/optimization?tab=budget",
    );
    expect(buildHubRedirectUrl("/optimization/outcomes", "")).toBe(
      "/optimization?tab=outcomes",
    );
  });
});

describe("Wave 7.5 Improve cross-link", () => {
  it("CostImproveCrossLink bridges to improveHref on budget/outcomes/finops", () => {
    const link = read(
      "app/(portal)/optimization/_components/cost-improve-cross-link.tsx",
    );
    expect(link).toContain("improveHref");
    expect(link).toContain('data-testid="cost-improve-crosslink"');
    expect(link).toContain("Open Improve queue");
    const budget = read("app/(portal)/optimization/budget/page.tsx");
    const outcomes = read("app/(portal)/optimization/outcomes/page.tsx");
    const finops = read("app/(portal)/optimization/_components/finops-explorer.tsx");
    expect(budget).toContain("CostImproveCrossLink");
    expect(outcomes).toContain("CostImproveCrossLink");
    expect(finops).toContain("CostImproveCrossLink");
  });
});

describe("Wave 7.6 marker", () => {
  it("hub marks data-wave7-improve-cost completed", () => {
    const src = read("app/(portal)/optimization/page.tsx");
    expect(src).toContain("WAVE7_IMPROVE_COST_COMPLETED");
    expect(src).toContain('data-wave7-improve-cost=');
  });
});
