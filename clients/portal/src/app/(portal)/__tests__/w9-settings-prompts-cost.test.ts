/**
 * Wave 9 — Settings + Prompts + Cost exit criteria (V2).
 * 9.1 ≤6 daily tabs · 9.2 kit Button CTAs · 9.3–9.5 Members/Billing/Advanced ·
 * 9.6 Prompts list|editor + environments secondary · 9.7 Cost primary modes ·
 * 9.8 Model Advisor modules ≤400 · 9.9 Audit trail · 9.10 Settings search.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function lineCount(rel: string): number {
  return read(rel).split("\n").length;
}

describe("Wave 9.1–9.5 settings IA", () => {
  const page = read("app/(portal)/settings/page.tsx");
  const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");

  it("9.1 keeps ≤6 daily-visible tabs", () => {
    expect(registry).toContain("WAVE9_DAILY_TAB_CAP = 6");
    expect(page).toContain("WAVE9_DAILY_TAB_CAP");
    const defaults = [...registry.matchAll(/defaultVisible:\s*true/g)];
    expect(defaults.length).toBeLessThanOrEqual(6);
    expect(defaults.length).toBeGreaterThanOrEqual(5);
    for (const id of ["org", "account", "api-keys", "members", "security", "billing"]) {
      expect(registry).toContain(`id: "${id}"`);
    }
    const auditBlock = registry.slice(
      registry.indexOf('id: "audit-log"'),
      registry.indexOf('id: "audit-log"') + 220,
    );
    expect(auditBlock).not.toContain("defaultVisible: true");
  });

  it("9.5 Advanced holds gateway/PII/retention/exports with separate group feel", () => {
    for (const id of ["gateway", "pii", "retention", "exports"]) {
      const block = registry.slice(
        registry.indexOf(`id: "${id}"`),
        registry.indexOf(`id: "${id}"`) + 280,
      );
      expect(block).toContain('category: "Advanced"');
      expect(block).not.toContain("defaultVisible: true");
    }
    expect(page).toContain('data-settings-group={cat === "Advanced" ? "advanced" : "daily"}');
    expect(page).toContain("border-dashed");
  });

  it("9.10 tokenizes settings search (AND match + keywords)", () => {
    expect(page).toContain("tabMatchesQuery");
    expect(registry).toContain("tokens.every");
    expect(registry).toContain("soc2");
  });
});

describe("Wave 9.2–9.4 members / keys / billing CTAs", () => {
  it("9.2 api-keys presets + revoke use kit Button", () => {
    const tab = read("app/(portal)/settings/_components/api-keys-tab.tsx");
    const create = read(
      "app/(portal)/settings/_components/api-keys-create-panel.tsx",
    );
    expect(create).toContain('variant="link"');
    expect(create).toContain("SDK presets");
    expect(tab).toContain('variant="ghost"');
    expect(tab).toContain('size="icon"');
    expect(create).not.toMatch(
      /className="min-h-11 px-2 text-sm text-\[var\(--accent\)\]/,
    );
  });

  it("9.3 members invite precedes table; remove uses kit Button", () => {
    const src = read("app/(portal)/settings/_components/members-tab.tsx");
    const inviteIdx = src.indexOf("Invite member");
    const tableIdx = src.indexOf('title="Members"');
    expect(inviteIdx).toBeGreaterThan(-1);
    expect(tableIdx).toBeGreaterThan(inviteIdx);
    expect(src).toContain('size="icon"');
    expect(src).not.toContain('header: "Joined"');
  });

  it("9.4 billing stays calm (no 4xl spend)", () => {
    const src = read("app/(portal)/settings/_components/billing-tab.tsx");
    expect(src).toContain("text-2xl font-semibold");
    expect(src).not.toContain("text-4xl font-bold");
  });
});

describe("Wave 9.6 prompts", () => {
  it("list|editor split with environments secondary", () => {
    const src = read("app/(portal)/prompts/page.tsx");
    const editor = read("app/(portal)/prompts/_components/prompts-editor.tsx");
    expect(src).toContain('data-wave9-prompts="completed"');
    expect(src).toContain('data-testid="prompts-master-detail"');
    expect(src).toContain("PromptsEditor");
    expect(src.split("\n").length).toBeLessThanOrEqual(400);
    expect(editor).toContain('data-testid="prompts-environments"');
    expect(editor).toContain("<details");
    expect(editor).toContain("Environments");
    expect(editor).toContain("./prompt-diff");
  });
});

describe("Wave 9.7–9.8 cost + advisor", () => {
  it("9.7 Cost primary modes + Advanced predict overflow", () => {
    const src = read("app/(portal)/optimization/page.tsx");
    expect(src).toContain("WAVE9_COST_COMPLETED = true");
    expect(src).toContain('data-wave9-cost="completed"');
    expect(src).toContain("PRIMARY_TABS");
    expect(src).toContain("ADVANCED_TABS");
    expect(src).toContain('data-testid="cost-advanced"');
    expect(src).toContain("PredictForecast");
    for (const t of ["cost", "budget", "outcomes", "advisor"]) {
      expect(src).toContain(`"${t}"`);
    }
  });

  it("9.8 Model Advisor modules are ≤400 LOC each", () => {
    const modules = [
      "app/(portal)/optimization/model-advisor/_components/advisor-views.tsx",
      "app/(portal)/optimization/model-advisor/_components/advisor-candidates.ts",
      "app/(portal)/optimization/model-advisor/_components/recommendation-card.tsx",
      "app/(portal)/optimization/model-advisor/_components/compare-view.tsx",
      "app/(portal)/optimization/model-advisor/_components/project-view.tsx",
      "app/(portal)/optimization/model-advisor/_components/candidate-picker.tsx",
      "app/(portal)/optimization/model-advisor/page.tsx",
    ];
    for (const rel of modules) {
      expect(existsSync(resolve(portalSrc, rel)), rel).toBe(true);
      expect(lineCount(rel), rel).toBeLessThanOrEqual(400);
    }
    const barrel = read(
      "app/(portal)/optimization/model-advisor/_components/advisor-views.tsx",
    );
    expect(barrel).toContain('from "./recommendation-card"');
    expect(barrel).toContain('from "./compare-view"');
  });
});

describe("Wave 9.9 audit trail", () => {
  it("quiet header + compliance tools in details", () => {
    const page = read("app/(portal)/audit-trail/page.tsx");
    const chain = read("app/(portal)/audit-trail/_components/chain-panel.tsx");
    expect(page).toContain('data-ws6-audit="completed"');
    expect(page).toContain("Chain-verified agent events");
    expect(chain).toContain("<details");
    expect(chain).toContain("Compliance tools");
    expect(page).not.toMatch(/description="Export SOC2/);
  });
});
