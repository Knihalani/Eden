/**
 * Wave 1 — Workspace IA exit (M2, M3↓, M4, M11↓, M12 + evidence markers).
 * Source-level asserts: mobile More, sidebar, registry, redirect, overview, no 240px rail.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS1 Workspace IA — mobile More", () => {
  const mobile = read("components/portal-os/MobileBottomNav.tsx");

  it("MOBILE_MORE_GROUPS workspace links include audit-trail, settings, api-keys", () => {
    const workspaceBlock = mobile.slice(
      mobile.indexOf('id: "workspace"'),
      mobile.indexOf('id: "workspace"') + 450,
    );
    expect(workspaceBlock).toContain('href: "/audit-trail"');
    expect(workspaceBlock).toContain('href: "/settings"');
    expect(workspaceBlock).toMatch(/href:\s*"\/settings\?tab=api-keys"/);
    expect(workspaceBlock).not.toContain('href: "/artifacts"');
    expect(workspaceBlock).not.toContain('href: "/alerts"');
    expect(workspaceBlock).not.toContain('href: "/ledger"');
    expect(mobile).toContain("WS1_MOBILE_WORKSPACE_COMPLETED");
    expect(mobile).toContain("data-ws1-mobile-workspace");
  });
});

describe("WS1 Workspace IA — desktop sidebar", () => {
  const sidebar = read("lib/sidebar-config.ts");

  it("Workspace group has audit-trail + settings", () => {
    const workspaceBlock = sidebar.slice(
      sidebar.indexOf('id: "workspace"'),
      sidebar.indexOf("export const ALL_ITEM_IDS"),
    );
    expect(workspaceBlock).toContain('id: "audit-trail"');
    expect(workspaceBlock).toContain('href: "/audit-trail"');
    expect(workspaceBlock).toContain('id: "settings"');
    expect(workspaceBlock).toContain('href: "/settings"');
    expect(sidebar).toContain("WS1_SIDEBAR_COMPLETED");
  });
});

describe("WS1 Settings registry — daily ≤6 + overview + redirect", () => {
  const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");
  const page = read("app/(portal)/settings/page.tsx");

  it("daily defaultVisible ≤6", () => {
    const defaults = [...registry.matchAll(/defaultVisible:\s*true/g)];
    expect(defaults.length).toBeLessThanOrEqual(6);
    expect(defaults.length).toBeGreaterThanOrEqual(5);
    expect(registry).toContain("WAVE9_DAILY_TAB_CAP = 6");
    expect(registry).toContain("DEFAULT_VISIBLE_TAB_IDS");
  });

  it("audit-log redirect constant or page replaces to /audit-trail", () => {
    expect(registry).toContain('SETTINGS_AUDIT_LOG_REDIRECT_HREF = "/audit-trail"');
    expect(page).toContain("SETTINGS_AUDIT_LOG_REDIRECT_HREF");
    expect(page).toMatch(/router\.replace\([\s\S]*SETTINGS_AUDIT_LOG_REDIRECT_HREF/);
    expect(page).toContain('urlTabParam === "audit-log"');
    expect(page).toContain('params.set("segment", "events")');
  });

  it("overview tab or OverviewPanel exists", () => {
    expect(registry).toContain('id: "overview"');
    expect(page).toContain("OverviewPanel");
    expect(page).toMatch(/panelTab === "overview"|activeTab === "overview"/);
    const overview = read("app/(portal)/settings/_components/overview-panel.tsx");
    expect(overview).toMatch(/export function OverviewPanel/);
    expect(overview).toMatch(/WS1_OVERVIEW_SCAFFOLD_COMPLETED|WS2_OVERVIEW_COMPLETED/);
  });

  it("WS1 markers / data-ws1 present", () => {
    expect(page).toContain("data-ws1-settings-shell");
    expect(page).toContain("WS1_SETTINGS_SHELL_COMPLETED");
    expect(registry).toContain("WS1_TAB_REGISTRY_COMPLETED");
    const overview = read("app/(portal)/settings/_components/overview-panel.tsx");
    expect(overview).toContain("data-ws1-overview");
    expect(page).toContain("data-ws1-ghost-notice");
  });

  it("no second 240px settings sidebar pattern in page", () => {
    expect(page).not.toContain("lg:w-[240px]");
    expect(page).not.toContain("w-[240px]");
    expect(page).toContain('variant="pills"');
    expect(page).toContain("TabsList");
  });
});
