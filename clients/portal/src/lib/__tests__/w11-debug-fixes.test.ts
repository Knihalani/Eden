/**
 * Wave 11 — DEBUG wave regression locks for bugs fixed this session.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHubRedirectUrl,
  HUB_REDIRECT_RULES,
} from "@/lib/portal-hub-redirect";

const ROOT = resolve(__dirname, "../../..");
const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W11 model-advisor deep-link redirect", () => {
  const nextConfig = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");

  it("308s /optimization/model-advisor → Cost hub advisor tab", () => {
    expect(nextConfig).toContain('source: "/optimization/model-advisor"');
    expect(nextConfig).toContain('destination: "/optimization?tab=advisor"');
    expect(HUB_REDIRECT_RULES["/optimization/model-advisor"]).toEqual({
      destination: "/optimization",
      tab: "advisor",
    });
    expect(buildHubRedirectUrl("/optimization/model-advisor", "")).toBe(
      "/optimization?tab=advisor",
    );
  });
});

describe("W11 embed chrome leaks", () => {
  it("Fleet hides Card KPI strip when embedded", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain("showKpis && !embedded");
    expect(src).toContain("data-testid=\"fleet-kpi-strip\"");
  });

  it("Studio/Memory/Retrieval use pills tabs under EmbeddedSurface", () => {
    expect(read("app/(portal)/studio/page.tsx")).toContain(
      'variant={embedded ? "pills" : "underline"}',
    );
    expect(read("app/(portal)/observability/memory/page.tsx")).toContain(
      'variant={embedded ? "pills" : "underline"}',
    );
    expect(read("app/(portal)/observability/retrieval/page.tsx")).toContain(
      'variant={embedded ? "pills" : "underline"}',
    );
  });
});

describe("W11 CrossLinkBar overflow (band → More)", () => {
  it("Issues detail uses Go to dropdown, not CrossLinkBar band", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).not.toContain("<CrossLinkBar");
    expect(src).toContain("DropdownMenuLabel>Go to");
  });

  it("change-impact / improvement-loop / agent detail / alerts / experiments move CrossLinks to More", () => {
    for (const rel of [
      "app/(portal)/improve/change-impact/page.tsx",
      "app/(portal)/onboarding/improvement-loop.tsx",
      "app/(portal)/agents/[id]/page.tsx",
      "app/(portal)/alerts/page.tsx",
      "app/(portal)/experiments/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).not.toContain("<CrossLinkBar");
      expect(src).toContain("DropdownMenuLabel>Go to");
    }
  });
});

describe("W11 query-state + a11y + settings FormField", () => {
  it("improve plans gates KPI until data ready", () => {
    const src = read("app/(portal)/improve/plans/page.tsx");
    expect(src).toContain("!(loading && plans.length === 0)");
    expect(src).toContain("LoadingSkeleton");
  });

  it("FilterBar search has aria-label + min-h-11", () => {
    const src = read("components/ui/filter-bar.tsx");
    expect(src).toContain('aria-label={search.placeholder ?? "Search filters"}');
    expect(src).toMatch(/search && \([\s\S]*?min-h-11/);
  });

  it("TranscriptView expand control is ≥44px", () => {
    const src = read("components/observability/TranscriptView.tsx");
    expect(src).toContain("min-h-11 min-w-11");
    expect(src).toContain("Collapse details");
  });

  it("gateway create form uses FormField", () => {
    const src = read("app/(portal)/settings/_components/gateway-tab.tsx");
    expect(src).toContain('from "@/components/ui/form-field"');
    expect(src).toContain('<FormField');
    expect(src).toContain('htmlFor="gw-name"');
  });
});
