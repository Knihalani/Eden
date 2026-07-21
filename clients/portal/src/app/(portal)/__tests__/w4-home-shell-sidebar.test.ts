/**
 * Home Shell Wave 4 — Sidebar overhaul contracts.
 * Tonal rail · core ≤12 · SidebarSearch deleted · mobile core five · no Settings double rail.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_MOBILE_HREFS,
  CORE_NAV_ITEM_COUNT,
  DEFAULT_SIDEBAR,
} from "@/lib/sidebar-config";
import {
  MOBILE_CORE_NAV,
  MOBILE_MORE_LINKS,
} from "@/components/portal-os/MobileBottomNav";
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_EXPANDED_WIDTH,
} from "@/components/portal-chrome/SidebarNav";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W4 sidebar — IA + rail", () => {
  it("keeps core ≤12 and Advanced place labels", () => {
    expect(CORE_NAV_ITEM_COUNT).toBeLessThanOrEqual(12);
    expect(CORE_NAV_ITEM_COUNT).toBe(12);
    const issues = DEFAULT_SIDEBAR.flatMap((g) => g.items).find((i) => i.id === "issues");
    expect(issues?.label).toBe("Issues");
    const advanced = DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
      (i) => i.category === "advanced",
    );
    expect(advanced.map((i) => i.label)).toEqual(
      expect.arrayContaining([
        "Agents",
        "Analytics",
        "Debug sessions",
        "Scorecard",
        "Online scoring",
        "Change impact",
        "Guardrails",
        "Cost",
      ]),
    );
  });

  it("exports 240↔64 collapse widths and tonal-rail marker", () => {
    expect(SIDEBAR_EXPANDED_WIDTH).toBe(240);
    expect(SIDEBAR_COLLAPSED_WIDTH).toBe(64);
    const nav = src("components/portal-chrome/SidebarNav.tsx");
    expect(nav).toContain('data-home-shell-sidebar="tonal-rail"');
    expect(nav).toContain("bg-[var(--bg-secondary)]");
    expect(nav).toContain("Show Advanced");
  });

  it("active tick uses --accent once (no glow / full accent text)", () => {
    const items = src("components/portal-chrome/sidebar-nav-items.tsx");
    expect(items).toContain("bg-[var(--accent)]");
    expect(items).not.toContain("drop-shadow");
    expect(items).not.toContain('text-[var(--accent)] bg-[var(--accent-light)]');
    expect(items).toContain("quiet");
  });
});

describe("W4 sidebar — SidebarSearch deleted", () => {
  it("removes file, exports, and helper", () => {
    expect(existsSync(resolve(ROOT, "src/components/layout/sidebar-search.tsx"))).toBe(
      false,
    );
    const index = src("components/layout/index.ts");
    expect(index).not.toContain("SidebarSearch");
    expect(index).not.toContain("sidebar-search");
    const link = src("components/layout/portal-nav-link.tsx");
    expect(link).not.toContain("sidebarSearchResultClass");
  });
});

describe("W4 sidebar — mobile sync", () => {
  it("mobile core five matches desktop CORE_MOBILE_HREFS", () => {
    expect(MOBILE_CORE_NAV.map((i) => i.href)).toEqual([...CORE_MOBILE_HREFS]);
    expect(MOBILE_CORE_NAV).toHaveLength(5);
    expect(MOBILE_MORE_LINKS.some((l) => l.href === "/prompts")).toBe(true);
  });
});

describe("W4 sidebar — critic: no Settings double rail", () => {
  it("Settings hub still uses pills, not a nested 240px rail", () => {
    const page = src("app/(portal)/settings/page.tsx");
    expect(page).not.toContain("lg:w-[240px]");
    expect(page).not.toContain("w-[240px]");
    expect(page).not.toContain("SidebarNav");
    const preview = src(
      "app/(portal)/settings/_components/sidebar-settings-view.tsx",
    );
    expect(preview).toContain('data-home-shell-sidebar-preview="tonal-rail"');
  });
});
