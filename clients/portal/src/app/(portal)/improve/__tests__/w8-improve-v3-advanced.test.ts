/**
 * Wave 8 — Improve V3 Advanced leaves.
 * 8.1 Scorecard synthetic gates · 8.2 Online scoring table + test ·
 * 8.3 Change impact preview→result one Run CTA · 8.4 Advanced/⌘K only ·
 * 8.5 Marker data-wave8-improve-advanced.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNavCommands, PALETTE_ACTIONS } from "@/lib/nav-commands";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

const ADVANCED_PAGES = [
  "app/(portal)/improve/scorecard/page.tsx",
  "app/(portal)/improve/online-scoring/page.tsx",
  "app/(portal)/improve/change-impact/page.tsx",
] as const;

describe("Wave 8.1 — Scorecard synthetic gates (not org KPIs)", () => {
  it("exposes gates table + synthetic banner clarity", () => {
    const src = read("app/(portal)/improve/scorecard/page.tsx");
    expect(src).toContain("Advanced · Improve");
    expect(src).toContain("Synthetic process gate — not org KPIs");
    expect(src).toContain("n/a (synthetic)");
    expect(src).toContain('data-testid="scorecard-synthetic-banner"');
    expect(src).toContain('data-testid="scorecard-gates-table"');
    expect(src).toContain("<table");
    expect(src).not.toContain("<CrossLinkBar");
    expect(src).not.toContain("StatCard");
    expect(src.split("\n").length).toBeLessThanOrEqual(400);
  });
});

describe("Wave 8.2 — Online scoring rules table + test", () => {
  it("uses calm table + test panel; no Card wall", () => {
    const page = read("app/(portal)/improve/online-scoring/page.tsx");
    const form = read(
      "app/(portal)/improve/online-scoring/_components/online-scoring-form.tsx",
    );
    const rules = read(
      "app/(portal)/improve/online-scoring/_components/online-scoring-rules.tsx",
    );
    expect(page).toContain("Advanced · Improve");
    expect(page).toContain("OnlineScoringRulesTable");
    expect(page).toContain("OnlineScoringTestPanel");
    expect(page).toContain("OnlineScoringForm");
    expect(page).toContain("CoreResourcePage");
    expect(page).not.toMatch(/from "@\/components\/ui\/card"/);
    expect(form).toContain('data-testid="online-scoring-form"');
    expect(rules).toContain('data-testid="online-scoring-rules-table"');
    expect(rules).toContain('data-testid="online-scoring-test"');
    expect(rules).toContain("<table");
    expect(page.split("\n").length).toBeLessThanOrEqual(400);
  });
});

describe("Wave 8.3 — Change impact preview → result; one Run CTA", () => {
  it("stages preview then result with a single primary Run CTA", () => {
    const src = read("app/(portal)/improve/change-impact/page.tsx");
    expect(src).toContain("Advanced · Improve");
    expect(src).toContain('data-testid="change-impact-preview"');
    expect(src).toContain('data-testid="change-impact-result"');
    expect(src).toContain('data-testid="change-impact-run"');
    expect(src).toContain("Run preview");
    // Exactly one primary Run CTA in preview form (not duplicated in empty state).
    const runMatches = src.match(/Run preview/g) ?? [];
    expect(runMatches.length).toBe(1);
    expect(src).not.toContain("Generate preview");
    expect(src).toContain('data-testid="change-impact-related-strip"');
    expect(src).not.toContain("<CrossLinkBar");
    expect(src.split("\n").length).toBeLessThanOrEqual(400);
  });
});

describe("Wave 8.4 — Stay Advanced / ⌘K; hub strip clean", () => {
  it("keeps Advanced leaves off hub related strip", () => {
    const related = read(
      "app/(portal)/improve/_components/improve-constants.ts",
    );
    expect(related).toContain('href: "/prompts"');
    expect(related).not.toContain("/improve/scorecard");
    expect(related).not.toContain("/improve/online-scoring");
    expect(related).not.toContain("/improve/change-impact");
  });

  it("sidebar Advanced + ⌘K discover scorecard / online-scoring / change-impact", () => {
    const advanced = DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
      (i) => i.category === "advanced",
    );
    const hrefs = advanced.map((i) => i.href);
    expect(hrefs).toContain("/improve/scorecard");
    expect(hrefs).toContain("/improve/online-scoring");
    expect(hrefs).toContain("/improve/change-impact");

    const cmds = buildNavCommands();
    expect(cmds.some((c) => c.href === "/improve/scorecard")).toBe(true);
    expect(cmds.some((c) => c.href === "/improve/online-scoring")).toBe(true);
    expect(cmds.some((c) => c.href === "/improve/change-impact")).toBe(true);
    expect(PALETTE_ACTIONS.some((a) => a.href === "/improve/scorecard")).toBe(
      true,
    );
    expect(
      PALETTE_ACTIONS.some((a) => a.href === "/improve/online-scoring"),
    ).toBe(true);
    expect(PALETTE_ACTIONS.some((a) => a.href === "/improve/change-impact")).toBe(
      true,
    );
  });
});

describe("Wave 8.5 — marker", () => {
  it("marks data-wave8-improve-advanced completed on all three leaves", () => {
    for (const rel of ADVANCED_PAGES) {
      const src = read(rel);
      expect(src).toContain('data-wave8-improve-advanced="completed"');
    }
  });
});
