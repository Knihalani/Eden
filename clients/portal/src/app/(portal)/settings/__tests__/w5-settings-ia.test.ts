/**
 * W5 settings IA — search-first, UX-P1-13 category grouping,
 * single title / no page-body org Select, DangerZone coverage.
 * Wave 9: category pills replace the 240px rail.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W5 settings IA (UX-P1-13)", () => {
  const page = read("app/(portal)/settings/page.tsx");

  it("groups tabs into Workspace · Members · Security · Billing · Advanced (no Compliance pill)", () => {
    const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");
    expect(page).toContain("CATEGORY_ORDER");
    expect(registry).toContain('"Org"');
    expect(registry).toContain('"Members"');
    expect(registry).toContain('"Security"');
    expect(registry).toContain('"Billing"');
    expect(registry).toContain('"Advanced"');
    expect(registry).not.toContain('"Compliance"');
    expect(registry).toContain('category: "Org"');
    expect(registry).toContain('category: "Members"');
    expect(registry).toContain('category: "Security"');
    expect(registry).toContain('category: "Billing"');
    expect(registry).toContain('category: "Advanced"');
    expect(registry).toContain("redirectOnly: true");
    expect(registry).toContain("CATEGORY_LABELS");
  });

  it("keeps a single Settings title via PageHeader (no rail h2)", () => {
    expect(page).toContain('title="Settings"');
    expect(page).not.toMatch(/<h2[^>]*>Settings<\/h2>/);
  });

  it("has no page-body org Select switcher", () => {
    expect(page).not.toContain("settings-org-select");
    expect(page).not.toContain("useOrganizationList");
    expect(page).not.toContain("SelectTrigger");
    expect(page).not.toContain("Current Organization");
  });

  it("search matches labels and synonym keywords (SCIM/PII/2FA; SSO stays ghost)", () => {
    const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");
    expect(page).toContain("SettingsSearch");
    expect(page).toContain("tabMatchesQuery");
    // Ghost SSO must not be promoted via SCIM keywords.
    expect(registry).not.toMatch(/id:\s*"scim"[\s\S]*?keywords:\s*\[[^\]]*sso/);
    expect(registry).toMatch(/keywords:[\s\S]*provisioning/);
    expect(registry).toMatch(/keywords:[\s\S]*gdpr/);
    expect(registry).toMatch(/keywords:[\s\S]*2fa/);
    expect(registry).toContain("(tab.keywords ?? []).join");
  });

  it("uses skeleton Suspense (not fallback null)", () => {
    expect(page).toContain("fallback={<SettingsLoading />}");
    expect(page).not.toContain("fallback={null}");
  });

  it("uses top category pills (Wave 9 — no 240px rail)", () => {
    expect(page).toContain('variant="pills"');
    expect(page).not.toContain("lg:w-[240px]");
    expect(page).not.toContain("SettingsCategoryGroup");
  });
});

describe("W5 settings DangerZone consistency", () => {
  it("wraps destructive surfaces in DangerZone", () => {
    const orgTab = read("app/(portal)/settings/_components/org-tab.tsx");
    const security = read("app/(portal)/settings/_components/security-tab.tsx");
    const finops = read("app/(portal)/settings/_components/finops-kills-tab.tsx");
    const autonomous = read("app/(portal)/settings/_components/autonomous-tab.tsx");
    const account = read("app/(portal)/settings/_components/account-panel.tsx");

    for (const src of [orgTab, security, finops, autonomous, account]) {
      expect(src).toContain('from "@/components/settings/danger-zone"');
      expect(src).toContain("<DangerZone");
    }

    // Wave 8 S15 — org-settings re-exports org-tab (canonical DangerZone surface)
    const orgSettings = read("app/(portal)/settings/_components/org-settings.tsx");
    expect(orgSettings).toContain('from "./org-tab"');
    expect(orgSettings).toContain("OrgTab as OrgSettings");
  });
});

describe("W5 settings search/category primitives", () => {
  it("search bar uses Eden spacing tokens and min-h-11", () => {
    const src = read("components/settings/settings-search.tsx");
    expect(src).toContain("space-y-space-2");
    expect(src).toContain("min-h-11");
    expect(src).toContain("Search settings");
  });

  it("category groups default Advanced collapsed and force-expand on search", () => {
    const src = read("components/settings/settings-category-group.tsx");
    expect(src).toContain("Advanced: true");
    expect(src).toContain("forceExpanded");
    expect(src).toContain("text-2xs");
    expect(src).not.toContain("text-[10px]");
  });
});
