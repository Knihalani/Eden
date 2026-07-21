/**
 * Wave 1 — Improve V3 IA contract.
 * Prompts → core; Advanced = scorecard / online-scoring / change-impact /
 * guardrails / cost; related strip scent; redirects preserved.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_NAV_ITEM_COUNT,
  DEFAULT_SIDEBAR,
} from "@/lib/sidebar-config";
import {
  buildNavCommands,
  PALETTE_ACTIONS,
} from "@/lib/nav-commands";
import { PAGE_DESCRIPTIONS } from "@/lib/page-descriptions";
import {
  RELATED_LINKS,
  IMPROVE_QUEUE_COLUMNS,
  WAVE1_IMPROVE_IA_COMPLETED,
} from "@/app/(portal)/improve/_components";

const ROOT = resolve(__dirname, "../../../..");
const nextConfig = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, "src", rel), "utf8");
}

const improveGroup = () => DEFAULT_SIDEBAR.find((g) => g.id === "improve")!;

describe("W1 Improve V3 IA — sidebar", () => {
  it("1.1 Prompts is core Improve (no advanced category)", () => {
    const prompts = improveGroup().items.find((i) => i.id === "prompts");
    expect(prompts).toBeDefined();
    expect(prompts!.href).toBe("/prompts");
    expect(prompts!.category).toBeUndefined();
    expect(prompts!.category).not.toBe("advanced");
  });

  it("1.1 core Improve order: queue → artifacts → ledger → prompts", () => {
    const core = improveGroup().items.filter((i) => i.category !== "advanced");
    expect(core.map((i) => i.id)).toEqual([
      "improve",
      "artifacts",
      "ledger",
      "prompts",
    ]);
    expect(core.map((i) => i.href)).toEqual([
      "/improve",
      "/artifacts",
      "/ledger",
      "/prompts",
    ]);
  });

  it("1.1 Advanced Improve list + order is locked", () => {
    const advanced = improveGroup().items.filter(
      (i) => i.category === "advanced",
    );
    expect(advanced.map((i) => i.id)).toEqual([
      "scorecard",
      "online-scoring",
      "change-impact",
      "guardrails",
      "optimization",
    ]);
    expect(advanced.map((i) => i.href)).toEqual([
      "/improve/scorecard",
      "/improve/online-scoring",
      "/improve/change-impact",
      "/guardrails",
      "/optimization",
    ]);
    expect(advanced.some((i) => i.id === "prompts")).toBe(false);
  });

  it("keeps ≤12 core nav after Prompts promotion", () => {
    expect(CORE_NAV_ITEM_COUNT).toBeLessThanOrEqual(12);
    expect(CORE_NAV_ITEM_COUNT).toBe(12);
  });
});

describe("W1 Improve V3 IA — ⌘K + page descriptions", () => {
  it("1.2 ⌘K indexes Prompts under Improve and as palette action", () => {
    const cmds = buildNavCommands();
    const promptsRoute = cmds.find((c) => c.href === "/prompts");
    expect(promptsRoute).toBeDefined();
    expect(promptsRoute!.group).toBe("Improve");
    expect(
      PALETTE_ACTIONS.some(
        (a) => a.href === "/prompts" && a.label === "Open prompts",
      ),
    ).toBe(true);
  });

  it("1.2 Advanced leaves remain ⌘K-reachable", () => {
    const hrefs = buildNavCommands().map((c) => c.href.split("?")[0]);
    for (const href of [
      "/improve/scorecard",
      "/improve/online-scoring",
      "/improve/change-impact",
      "/guardrails",
      "/optimization",
    ]) {
      expect(hrefs).toContain(href);
    }
  });

  it("1.2 page-descriptions scent Prompts as core Improve", () => {
    expect(PAGE_DESCRIPTIONS["/prompts"]).toMatch(/core Improve/i);
    expect(PAGE_DESCRIPTIONS["/improve"]).toMatch(/Improve/i);
    expect(PAGE_DESCRIPTIONS["/optimization"]).toMatch(/Advanced Improve/i);
    expect(PAGE_DESCRIPTIONS["/guardrails"]).toMatch(/Advanced Improve/i);
  });
});

describe("W1 Improve V3 IA — related strips + scaffold", () => {
  it("1.3 hub related strip is Issues · Artifacts · Ledger · Prompts", () => {
    expect(RELATED_LINKS.map((l) => l.label)).toEqual([
      "Issues",
      "Artifacts",
      "Ledger",
      "Prompts",
    ]);
    expect(RELATED_LINKS.map((l) => l.href)).toEqual([
      "/issues",
      "/artifacts",
      "/ledger",
      "/prompts",
    ]);
    expect(RELATED_LINKS.some((l) => l.href.includes("scorecard"))).toBe(false);
    expect(RELATED_LINKS.some((l) => l.href.includes("online-scoring"))).toBe(
      false,
    );
    expect(RELATED_LINKS.some((l) => l.href.includes("change-impact"))).toBe(
      false,
    );
  });

  it("1.3 Artifacts / Ledger / Prompts strips include core loop links", () => {
    const artifacts = read("app/(portal)/artifacts/page.tsx");
    expect(artifacts).toContain('data-testid="artifacts-related-strip"');
    expect(artifacts).toContain('href="/issues"');
    expect(artifacts).toContain('href="/prompts"');
    expect(artifacts).toContain('href="/improve"');
    expect(artifacts).toContain('href="/ledger"');

    const ledger = read("app/(portal)/ledger/page.tsx");
    expect(ledger).toContain('data-testid="ledger-related-strip"');
    expect(ledger).toContain('href="/issues"');
    expect(ledger).toContain('href="/prompts"');
    expect(ledger).toContain('href="/improve"');

    const prompts = read("app/(portal)/prompts/page.tsx");
    expect(prompts).toContain('data-testid="prompts-related-strip"');
    expect(prompts).toContain('href="/issues"');
    expect(prompts).toContain('href="/improve"');
    expect(prompts).toContain('href="/artifacts"');
    expect(prompts).toContain('href="/ledger"');
  });

  it("1.4 improve/_components scaffold exports column ids + RELATED_LINKS", () => {
    expect(WAVE1_IMPROVE_IA_COMPLETED).toBe(true);
    expect(IMPROVE_QUEUE_COLUMNS.map((c) => c.id)).toEqual([
      "needs_you",
      "in_progress",
      "verify",
    ]);
    const hub = read("app/(portal)/improve/page.tsx");
    const constants = read(
      "app/(portal)/improve/_components/improve-constants.ts",
    );
    expect(hub).toContain('from "./_components"');
    expect(constants).toContain("RELATED_LINKS");
    expect(constants).toContain("IMPROVE_QUEUE_COLUMNS");
    expect(hub).toContain('data-wave1-improve=');
  });

  it("1.5 ImproveFeatureDisabledState remains the shared path", () => {
    const shared = read("components/improve/feature-disabled-state.tsx");
    expect(shared).toContain("export function ImproveFeatureDisabledState");
    for (const rel of [
      "app/(portal)/improve/_components/queue-board.tsx",
      "app/(portal)/improve/plans/page.tsx",
      "app/(portal)/improve/plans/[id]/page.tsx",
      "app/(portal)/improve/runs/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toContain(
        'from "@/components/improve/feature-disabled-state"',
      );
      expect(src).toContain("<ImproveFeatureDisabledState");
    }
  });
});

describe("W1 Improve V3 IA — redirects still valid", () => {
  it("1.6 preserve Improve-group soft/hard redirects", () => {
    const required = [
      { source: "/pr-suggestions", destination: "/improve?tab=plans" },
      { source: "/agents/eden/inbox", destination: "/improve?tab=plans" },
      { source: "/closed-loop", destination: "/improve" },
      { source: "/autonomous", destination: "/improve" },
      { source: "/improve/plans", destination: "/improve?tab=plans" },
      { source: "/improve/runs", destination: "/improve?tab=history" },
      { source: "/promotions", destination: "/ledger?tab=promotions" },
      { source: "/redteam", destination: "/guardrails?tab=redteam" },
      { source: "/llmops", destination: "/optimization" },
      {
        source: "/optimization/model-advisor",
        destination: "/optimization?tab=advisor",
      },
    ];
    for (const { source, destination } of required) {
      expect(nextConfig).toContain(`source: "${source}"`);
      expect(nextConfig).toContain(`destination: "${destination}"`);
    }
  });
});
