/**
 * W5 settings IA — search-first rail, UX-P1-13 category grouping,
 * single title / no page-body org Select, DangerZone coverage.
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

  it("groups tabs into Org · Members · Security · Compliance · Billing · Advanced", () => {
    expect(page).toContain(
      '["Org", "Members", "Security", "Compliance", "Billing", "Advanced"]',
    );
    expect(page).toContain('category: "Org"');
    expect(page).toContain('category: "Members"');
    expect(page).toContain('category: "Security"');
    expect(page).toContain('category: "Compliance"');
    expect(page).toContain('category: "Billing"');
    expect(page).toContain('category: "Advanced"');
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

  it("search matches labels and synonym keywords (SSO/SCIM/PII/2FA)", () => {
    expect(page).toContain("SettingsSearch");
    expect(page).toContain("forceExpanded={isSearching}");
    expect(page).toMatch(/keywords:.*saml/s);
    expect(page).toMatch(/keywords:.*provisioning/s);
    expect(page).toMatch(/keywords:.*gdpr/s);
    expect(page).toMatch(/keywords:.*2fa/s);
    expect(page).toContain("(t.keywords ?? []).join");
  });

  it("uses skeleton Suspense (not fallback null)", () => {
    expect(page).toContain("fallback={<SettingsLoading />}");
    expect(page).not.toContain("fallback={null}");
  });
});

describe("W5 settings DangerZone consistency", () => {
  it("wraps destructive surfaces in DangerZone", () => {
    const orgTab = read("app/(portal)/settings/_components/org-tab.tsx");
    const orgSettings = read("app/(portal)/settings/_components/org-settings.tsx");
    const security = read("app/(portal)/settings/_components/security-tab.tsx");
    const finops = read("app/(portal)/settings/_components/finops-kills-tab.tsx");
    const autonomous = read("app/(portal)/settings/_components/autonomous-tab.tsx");

    for (const src of [orgTab, orgSettings, security, finops, autonomous]) {
      expect(src).toContain('from "@/components/settings/danger-zone"');
      expect(src).toContain("<DangerZone");
    }
  });
});

describe("W5 settings search/category primitives", () => {
  it("search bar uses Eden spacing tokens and min-h-11", () => {
    const src = read("components/settings/settings-search.tsx");
    expect(src).toContain("space-y-space-2");
    expect(src).toContain("min-h-11");
    expect(src).toContain('placeholder="Search settings…"');
  });

  it("category groups default Advanced collapsed and force-expand on search", () => {
    const src = read("components/settings/settings-category-group.tsx");
    expect(src).toContain("Advanced: true");
    expect(src).toContain("forceExpanded");
    expect(src).toContain("text-2xs");
    expect(src).not.toContain("text-[10px]");
  });
});
