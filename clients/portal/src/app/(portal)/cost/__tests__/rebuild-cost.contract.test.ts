/**
 * Phase 5 Cost contract — surfaces/cost.md acceptance (hub chrome / IA).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves } from "@/lib/sidebar-config";
import { COST_TABS } from "@/lib/cost-url";

const portalSrc = path.resolve(__dirname, "../../../..");
const costRoot = path.join(portalSrc, "app/(portal)/cost");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe("rebuild cost contract", () => {
  it("required hub routes and chrome exist", () => {
    expect(existsSync(path.join(costRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(costRoot, "loading.tsx"))).toBe(true);
    expect(
      existsSync(path.join(costRoot, "_hooks/use-cost-url-state.ts")),
    ).toBe(true);
    expect(
      existsSync(path.join(costRoot, "_components/cost-hub-toolbar.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(costRoot, "_components/overview-tab.tsx")),
    ).toBe(true);
    expect(existsSync(path.join(costRoot, "_components/budget-tab.tsx"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(costRoot, "_components/outcomes-tab.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(costRoot, "_components/forecast-tab.tsx")),
    ).toBe(true);
    expect(existsSync(path.join(costRoot, "_components/advisor-tab.tsx"))).toBe(
      true,
    );
  });

  it("hub tabs + keyboard + related strip + no EmbeddedSurface", () => {
    const page = readFileSync(path.join(costRoot, "page.tsx"), "utf8");
    for (const tab of COST_TABS) {
      expect(page).toContain(tab);
    }
    expect(page).toContain("COST_TABS");
    expect(page).toContain("clearSelection");
    expect(page).toContain("Escape");
    expect(page).toContain("cost-breadcrumb");
    expect(page).toContain("/traces");
    expect(page).toContain("/agents");
    expect(page).toContain("/improve");
    expect(page).toContain("/evals");
    expect(page).not.toContain("EmbeddedSurface");
    expect(page).not.toContain("useEmbeddedSurface");

    for (const f of walkTs(costRoot)) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("EmbeddedSurface");
      expect(src).not.toContain("useEmbeddedSurface");
      expect(src).not.toMatch(/red-?team/i);
      expect(src).not.toMatch(/\/optimization(?![A-Za-z])/);
    }
  });

  it("overview links costly traces to /traces?traceId=", () => {
    const overview = readFileSync(
      path.join(costRoot, "_components/overview-tab.tsx"),
      "utf8",
    );
    expect(overview).toContain("/traces?traceId=");
    expect(overview).toContain("StatCard");
    expect(overview).toContain("Panel");
  });

  it("budget overage exits to Alerts and Issues", () => {
    const budget = readFileSync(
      path.join(costRoot, "_components/budget-tab.tsx"),
      "utf8",
    );
    expect(budget).toContain("/alerts");
    expect(budget).toContain("/issues");
    expect(budget).toContain("upsertBudget");
  });

  it("advisor closed-loop exits stay at ≤2 primary actions", () => {
    const advisor = readFileSync(
      path.join(costRoot, "_components/advisor-tab.tsx"),
      "utf8",
    );
    expect(advisor).toContain("/improve");
    expect(advisor).toContain("/evals");
    expect(advisor).toContain("/traces");
    expect(advisor).toContain("cost-advisor-actions");
  });

  it("sidebar cost href is live /cost", () => {
    const cost = getCoreNavLeaves().find((i) => i.id === "cost");
    expect(cost?.href).toBe("/cost");
  });

  it("softLand excludes /cost; redirects source legacy optimization leaves", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/cost"/);
    expect(softLandBody).not.toMatch(/"\/optimization"/);
    expect(softLandBody).not.toMatch(/"\/llmops"/);

    expect(cfg).toMatch(/source: ["']\/optimization["']/);
    expect(cfg).toMatch(/destination: ["']\/cost["']/);
    expect(cfg).toMatch(/source: ["']\/optimization\/budget["']/);
    expect(cfg).toMatch(/destination: ["']\/cost\?tab=budget["']/);
    expect(cfg).toMatch(/source: ["']\/optimization\/outcomes["']/);
    expect(cfg).toMatch(/destination: ["']\/cost\?tab=outcomes["']/);
    expect(cfg).toMatch(/source: ["']\/optimization\/predict["']/);
    expect(cfg).toMatch(/destination: ["']\/cost\?tab=forecast["']/);
    expect(cfg).toMatch(/source: ["']\/optimization\/model-advisor["']/);
    expect(cfg).toMatch(/destination: ["']\/cost\?tab=advisor["']/);
    expect(cfg).toMatch(/source: ["']\/llmops["']/);
  });

  it("i18n cost namespace present in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      cost?: { title?: string; tabs?: { overview?: string; budget?: string } };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      cost?: { title?: string; tabs?: { overview?: string; budget?: string } };
    };
    expect(en.cost?.title).toBeTruthy();
    expect(de.cost?.title).toBeTruthy();
    expect(en.cost?.tabs?.overview).toBeTruthy();
    expect(de.cost?.tabs?.overview).toBeTruthy();
    expect(en.cost?.tabs?.budget).toBeTruthy();
    expect(de.cost?.tabs?.budget).toBeTruthy();
  });
});
