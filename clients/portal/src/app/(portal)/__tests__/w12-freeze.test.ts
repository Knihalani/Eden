/**
 * Wave 12 — Hardening & freeze contracts (Portal UI Overhaul V2 final wave).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  U20_SERIOUS_AXE_ROUTES,
  WAVE12_CHROME_SINKS,
  WAVE12_LOOP_ROUTES,
  WAVE12_PEER_VISUAL_REFS,
  WAVE12_PORTAL_ROUTE_COUNT,
  WAVE12_VISUAL_BASELINE_IDS,
} from "@/lib/portal-polish";
import { CORE_NAV_ITEM_COUNT } from "@/lib/sidebar-config";
import { TRACES_PRIMARY_CONTROL_BUDGET } from "@/app/(portal)/traces/_components/TracesToolbar";
import { HUB_REDIRECT_RULES } from "@/lib/portal-hub-redirect";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("Wave 12.1 DESIGN.md ↔ code drift", () => {
  it("keeps DESIGN.md + motion / density / kit anchors", () => {
    expect(existsSync(resolve(ROOT, "DESIGN.md"))).toBe(true);
    const design = readFileSync(resolve(ROOT, "DESIGN.md"), "utf8");
    expect(design).toContain("≤5 primary toolbar actions");
    expect(design).toContain("28–32px");
    expect(design).toContain("Comfortable");
    expect(design).toContain("Compact");
    expect(design).toContain("Transcript-first");
    expect(design).toMatch(/200ms/);

    const css = src("app/globals.css");
    expect(css).toContain("--duration-normal: 200ms");
    expect(css).toContain("--duration-fast: 150ms");

    const button = src("components/ui/button.tsx");
    expect(button).toMatch(/h-7|h-8|min-h-11/);
    expect(src("components/ui/dialog.tsx")).toContain("Dialog");
    expect(src("components/ui/index.ts")).not.toContain("data-list");
    expect(src("components/ui/index.ts")).not.toContain("link-card");
    expect(existsSync(resolve(ROOT, "src/components/ui/link-card.tsx"))).toBe(
      false,
    );
    expect(existsSync(resolve(ROOT, "src/components/ui/data-list.tsx"))).toBe(
      false,
    );
  });

  it("documents residual drift in .wave12-design-drift.md", () => {
    expect(existsSync(resolve(ROOT, ".wave12-design-drift.md"))).toBe(true);
    const drift = readFileSync(resolve(ROOT, ".wave12-design-drift.md"), "utf8");
    expect(drift).toMatch(/Improve|714/);
    expect(drift).toMatch(/Settings|647/);
  });
});

describe("Wave 12.2 anti-clutter lint gates", () => {
  it("ships clutter script + package script for toolbar / Badge / nested hubs", () => {
    const clutter = readFileSync(
      resolve(ROOT, "scripts/lint-portal-clutter.cjs"),
      "utf8",
    );
    expect(clutter).toContain("TOOLBAR_PRIMARY_BUDGET");
    expect(clutter).toContain("TRACES_PRIMARY_BUDGET");
    expect(clutter).toContain("NESTED_HUBS");
    expect(clutter).toContain("eden/toolbar-primary-budget");
    expect(clutter).toContain("eden/no-nested-hub-headers");
    expect(clutter).toContain("eden/badge-grammar");
    expect(clutter).toContain("eden/analytics-thin-panels");
    expect(clutter).toContain("function Badge");
    expect(clutter).toContain("InsightsPanel");

    const pkg = readFileSync(resolve(ROOT, "package.json"), "utf8");
    expect(pkg).toContain('"lint:portal-clutter"');
  });

  it("locks traces first-paint ≤8 and D3 toolbar ≤5 constant", () => {
    expect(TRACES_PRIMARY_CONTROL_BUDGET).toBeLessThanOrEqual(8);
    const toolbar = src(
      "app/(portal)/traces/_components/TracesToolbar.tsx",
    );
    const markers = [...toolbar.matchAll(/data-primary-control="([^"]+)"/g)];
    expect(markers.length).toBeLessThanOrEqual(TRACES_PRIMARY_CONTROL_BUDGET);
    expect(markers.length).toBeLessThanOrEqual(5);
  });
});

describe("Wave 12.3–12.4 visual baselines + E2E loop", () => {
  it("documents golden PNG baselines under e2e/golden/screenshots", () => {
    const shotRoot = resolve(ROOT, "e2e/golden/screenshots");
    for (const id of WAVE12_VISUAL_BASELINE_IDS) {
      const png = resolve(shotRoot, `${id}.png`);
      const fail = resolve(shotRoot, `${id}-fail.png`);
      expect(existsSync(png) || existsSync(fail)).toBe(true);
    }
    expect(existsSync(resolve(ROOT, "e2e/golden/w12-visual-baselines.md"))).toBe(
      true,
    );
  });

  it("locks peer visual ref path contract (corpus or baselines doc)", () => {
    const corpus = resolve(
      ROOT,
      "../../.cursor/visual-research/ai-portals",
    );
    const baselinesDoc = readFileSync(
      resolve(ROOT, "e2e/golden/w12-visual-baselines.md"),
      "utf8",
    );
    for (const id of WAVE12_PEER_VISUAL_REFS) {
      const inCorpus = existsSync(resolve(corpus, id));
      expect(inCorpus || baselinesDoc.includes(id)).toBe(true);
    }
  });

  it("locks Observe → Eval → Improve route contract + sketch", () => {
    expect([...WAVE12_LOOP_ROUTES]).toEqual(["/traces", "/evals", "/improve"]);
    expect(existsSync(resolve(ROOT, "e2e/golden/w12-observe-eval-improve.mjs"))).toBe(
      true,
    );
    const sketch = readFileSync(
      resolve(ROOT, "e2e/golden/w12-observe-eval-improve.mjs"),
      "utf8",
    );
    for (const route of WAVE12_LOOP_ROUTES) {
      expect(sketch).toContain(route);
    }
  });
});

describe("Wave 12.5 axe serious=0 gate", () => {
  it("keeps serious-gate routes aligned with audit script", () => {
    expect([...U20_SERIOUS_AXE_ROUTES]).toEqual([
      "/traces",
      "/improve",
      "/evals",
      "/issues",
    ]);
    const script = readFileSync(resolve(ROOT, "scripts/audit-a11y.cjs"), "utf8");
    for (const route of U20_SERIOUS_AXE_ROUTES) {
      expect(script).toContain(`"${route}"`);
    }
    expect(script).toContain("SERIOUS_GATE_ROUTES");
    expect(existsSync(resolve(ROOT, ".wave12-axe-evidence.md"))).toBe(true);
  });
});

describe("Wave 12 success metrics + chrome", () => {
  it("chrome sinks ≤6 named always-on set (Home Shell: +ask-ai-fab)", () => {
    expect(WAVE12_CHROME_SINKS).toHaveLength(6);
    expect(WAVE12_CHROME_SINKS).toContain("ask-ai-fab");
    const chrome = src("app/(portal)/portal-chrome.tsx");
    expect(chrome).toContain("SidebarNav");
    expect(chrome).toContain("PortalHeader");
    expect(chrome).toContain("ChromeBanners");
    expect(chrome).toContain("CommandPalette");
    expect(chrome).toContain("AiRailHost");
    expect(chrome).toContain("MobileBottomNav");
  });

  it("portal-chrome.tsx LOC ≤400", () => {
    const lines = src("app/(portal)/portal-chrome.tsx").split("\n").length;
    expect(lines).toBeLessThanOrEqual(400);
  });

  it("settings default visible tabs ≤8", () => {
    const page = src("app/(portal)/settings/page.tsx");
    const defaults = [...page.matchAll(/defaultVisible:\s*true/g)];
    expect(defaults.length).toBeLessThanOrEqual(8);
  });

  it("dual entry points stay redirected (0 competing top-level Observe)", () => {
    const nextConfig = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");
    expect(nextConfig).toContain('source: "/observability"');
    expect(nextConfig).toContain('destination: "/traces"');
    expect(nextConfig).toContain('source: "/promotions"');
    expect(HUB_REDIRECT_RULES["/promotions"]).toBeTruthy();
    expect(CORE_NAV_ITEM_COUNT).toBeLessThanOrEqual(12);
  });
});

describe("Wave 12.8 75-route matrix", () => {
  it("locks portal page.tsx count + matrix artifact", () => {
    const portalRoot = resolve(ROOT, "src/app/(portal)");
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        const full = resolve(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name === "page.tsx") pages.push(full);
      }
    };
    walk(portalRoot);
    expect(pages.length).toBe(WAVE12_PORTAL_ROUTE_COUNT);
    expect(WAVE12_PORTAL_ROUTE_COUNT).toBe(75);

    const matrix = resolve(ROOT, ".wave12-route-matrix.md");
    expect(existsSync(matrix)).toBe(true);
    const text = readFileSync(matrix, "utf8");
    expect(text).toContain("75");
    expect(text).toContain("`/traces`");
    expect(text).toContain("`/improve`");
  });
});

describe("Wave 12 freeze artifacts", () => {
  it("ships changelog, walkthrough, open questions, final critic, axe evidence", () => {
    for (const f of [
      "CHANGELOG-UX.md",
      "WALKTHROUGH-UX.md",
      ".wave12-open-questions.md",
      ".wave12-final-critic.md",
      ".wave12-design-drift.md",
      ".wave12-route-matrix.md",
      ".wave12-axe-evidence.md",
    ]) {
      expect(existsSync(resolve(ROOT, f))).toBe(true);
    }
    const critic = readFileSync(resolve(ROOT, ".wave12-final-critic.md"), "utf8");
    expect(critic).toMatch(/SHIP/i);
    expect(critic).toMatch(/86%|polish/i);
  });
});
