/**
 * Phase 5 Guardrails contract — surfaces/guardrails.md acceptance (hub chrome / IA).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves } from "@/lib/sidebar-config";
import {
  GUARDRAILS_TABS,
  normalizeGuardrailsSearchParams,
  parseGuardrailsSearchParams,
  parseGuardrailsTab,
} from "@/lib/guardrails-url";

const portalSrc = path.resolve(__dirname, "../../../..");
const guardrailsRoot = path.join(portalSrc, "app/(portal)/guardrails");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");
const commandPalette = path.join(
  portalSrc,
  "components/ui/command-palette.tsx",
);
const sidebarConfig = path.join(portalSrc, "lib/sidebar-config.ts");

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

describe("rebuild guardrails contract", () => {
  it("required hub routes and chrome exist", () => {
    expect(existsSync(path.join(guardrailsRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(guardrailsRoot, "loading.tsx"))).toBe(true);
    expect(
      existsSync(
        path.join(guardrailsRoot, "_hooks/use-guardrails-url-state.ts"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(guardrailsRoot, "_components/guardrails-hub-toolbar.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(path.join(guardrailsRoot, "_components/policies-tab.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(guardrailsRoot, "_components/violations-tab.tsx")),
    ).toBe(true);
  });

  it("hub tabs only policies|violations; keyboard + QueryState; no EmbeddedSurface", () => {
    const page = readFileSync(path.join(guardrailsRoot, "page.tsx"), "utf8");
    expect(page).toContain("policies");
    expect(page).toContain("violations");
    expect(page).toContain("GUARDRAILS_TABS");
    expect(page).toContain("clearSelection");
    expect(page).toContain("PageHeader");
    expect(page).toContain("guardrails-new-policy");
    expect(page).not.toContain("EmbeddedSurface");
    expect(page).not.toContain("useEmbeddedSurface");

    expect(GUARDRAILS_TABS).toEqual(["policies", "violations"]);

    expect(page).toContain("guardrails-tab-${id}");
    expect(page).toContain("GUARDRAILS_TABS.map");
    expect(GUARDRAILS_TABS).toHaveLength(2);

    for (const f of walkTs(guardrailsRoot)) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("EmbeddedSurface");
      expect(src).not.toContain("useEmbeddedSurface");
      expect(src).not.toMatch(/red-?team/i);
      expect(src).not.toMatch(/\battacks?\b/i);
      expect(src).not.toContain("injections-tab");
      expect(src).not.toContain("test-tab");
      expect(src).not.toContain("RedTeam");
      expect(src).not.toContain("scanInjection");
    }

    const policiesTab = readFileSync(
      path.join(guardrailsRoot, "_components/policies-tab.tsx"),
      "utf8",
    );
    expect(policiesTab).toContain("QueryState");

    const violationsTab = readFileSync(
      path.join(guardrailsRoot, "_components/violations-tab.tsx"),
      "utf8",
    );
    expect(violationsTab).toContain("QueryState");
    expect(violationsTab).not.toMatch(/red-?team/i);
    expect(violationsTab).not.toMatch(/\battacks?\b/i);
  });

  it("has no banned red-team component files in guardrails tree", () => {
    const banned = [
      "redteam-report.tsx",
      "test-tab.tsx",
      "injections-tab.tsx",
      "pii-tab.tsx",
      "test-result-cards.tsx",
    ];
    for (const name of banned) {
      expect(
        existsSync(path.join(guardrailsRoot, "_components", name)),
      ).toBe(false);
    }
    expect(existsSync(path.join(portalSrc, "app/(portal)/redteam"))).toBe(
      false,
    );
  });

  it("URL grammar normalizes illegal tab to policies", () => {
    expect(parseGuardrailsTab("redteam")).toBe("policies");
    expect(parseGuardrailsTab("policies")).toBe("policies");
    expect(parseGuardrailsTab("violations")).toBe("violations");
    expect(parseGuardrailsTab("unknown")).toBe("policies");

    const params = new URLSearchParams("tab=redteam&policyId=pol_1");
    const state = parseGuardrailsSearchParams(params);
    expect(state.tab).toBe("policies");
    expect(state.policyId).toBe("pol_1");

    const normalized = normalizeGuardrailsSearchParams(params);
    expect(normalized.get("tab")).toBeNull();
    expect(normalized.get("policyId")).toBe("pol_1");
  });

  it("sidebar guardrails href is live /guardrails", () => {
    const leaf = getCoreNavLeaves().find((i) => i.id === "guardrails");
    expect(leaf?.href).toBe("/guardrails");

    const sidebar = readFileSync(sidebarConfig, "utf8");
    expect(sidebar).not.toMatch(/redteam/i);
  });

  it("Cmd+K has zero red-team destinations", () => {
    const palette = readFileSync(commandPalette, "utf8");
    expect(palette).not.toMatch(/red-?team/i);
    expect(palette).not.toContain("/redteam");
  });

  it("softLand excludes /guardrails; /redteam redirects to policies", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/guardrails"/);
    expect(softLandBody).not.toMatch(/"\/redteam"/);

    expect(cfg).toMatch(/source: ["']\/redteam["']/);
    expect(cfg).toMatch(/destination: ["']\/guardrails\?tab=policies["']/);
    expect(cfg).toMatch(/source: ["']\/redteam\/:path\*["']/);
  });

  it("i18n guardrails namespace present in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      guardrails?: {
        title?: string;
        tabs?: { policies?: string; violations?: string };
        policies?: { empty?: { body?: string } };
        violations?: { empty?: { body?: string } };
      };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      guardrails?: {
        title?: string;
        tabs?: { policies?: string; violations?: string };
        policies?: { empty?: { body?: string } };
        violations?: { empty?: { body?: string } };
      };
    };

    expect(en.guardrails?.title).toBeTruthy();
    expect(de.guardrails?.title).toBeTruthy();
    expect(en.guardrails?.tabs?.policies).toBeTruthy();
    expect(en.guardrails?.tabs?.violations).toBeTruthy();
    expect(de.guardrails?.tabs?.policies).toBeTruthy();
    expect(de.guardrails?.tabs?.violations).toBeTruthy();

    const enEmpty = JSON.stringify(en.guardrails ?? {}).toLowerCase();
    const deEmpty = JSON.stringify(de.guardrails ?? {}).toLowerCase();
    expect(enEmpty).not.toMatch(/red-?team/);
    expect(enEmpty).not.toMatch(/\battacks?\b/);
    expect(deEmpty).not.toMatch(/red-?team/);
    expect(deEmpty).not.toMatch(/\battacks?\b/);
  });
});
