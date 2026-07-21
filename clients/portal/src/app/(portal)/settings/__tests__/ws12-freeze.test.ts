/**
 * Wave 12 — Workspace freeze contracts (Ambition A + Ghosts A).
 * IA match, redirects, ≤6 daily, ghosts soft-hide, shell LOC ≤400.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISIBLE_TAB_IDS,
  GHOST_TABS,
  SETTINGS_AUDIT_LOG_REDIRECT_HREF,
  TABS,
  WAVE9_DAILY_TAB_CAP,
} from "../_components/settings-tab-registry";
import { MOBILE_MORE_GROUPS } from "@/components/portal-os/MobileBottomNav";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";

const portalRoot = resolve(__dirname, "../../../../..");
const portalSrc = resolve(__dirname, "../../../..");

function readSrc(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

export const WS12_FREEZE_COMPLETED = true as const;

describe("WS12 Workspace freeze", () => {
  it("shell LOC ≤400 (settings/page.tsx line count)", () => {
    const page = readSrc("app/(portal)/settings/page.tsx");
    const lines = page.split("\n").length;
    expect(lines).toBeLessThanOrEqual(400);
    expect(page).not.toContain("lg:w-[240px]");
    expect(page).not.toContain("w-[240px]");
    expect(page).toContain('variant="pills"');
  });

  it("daily tabs ≤6 including overview", () => {
    expect(WAVE9_DAILY_TAB_CAP).toBe(6);
    expect(DEFAULT_VISIBLE_TAB_IDS.length).toBeLessThanOrEqual(WAVE9_DAILY_TAB_CAP);
    expect(DEFAULT_VISIBLE_TAB_IDS.length).toBe(WAVE9_DAILY_TAB_CAP);
    expect(DEFAULT_VISIBLE_TAB_IDS).toContain("overview");
    expect([...DEFAULT_VISIBLE_TAB_IDS].sort()).toEqual(
      [
        "account",
        "api-keys",
        "billing",
        "members",
        "overview",
        "security",
      ].sort(),
    );
  });

  it("IA match — mobile Workspace matches desktop", () => {
    const mobile = MOBILE_MORE_GROUPS.find((g) => g.id === "workspace")!;
    const hrefs = mobile.links.map((l) => l.href);
    expect(hrefs).toEqual([
      "/audit-trail",
      "/settings",
      "/settings?tab=api-keys",
    ]);
    expect(hrefs).not.toContain("/artifacts");
    expect(hrefs).not.toContain("/alerts");
    expect(hrefs).not.toContain("/ledger");

    const desktop = DEFAULT_SIDEBAR.find((g) => g.id === "workspace")!;
    expect(desktop.items.some((i) => i.id === "audit-trail")).toBe(true);
    expect(desktop.items.some((i) => i.id === "settings")).toBe(true);
  });

  it("redirects — audit-log → /audit-trail; ⌘K skips settings audit body", () => {
    expect(SETTINGS_AUDIT_LOG_REDIRECT_HREF).toBe("/audit-trail");
    const page = readSrc("app/(portal)/settings/page.tsx");
    expect(page).toContain("SETTINGS_AUDIT_LOG_REDIRECT_HREF");
    expect(page).toMatch(
      /router\.replace\([\s\S]*SETTINGS_AUDIT_LOG_REDIRECT_HREF/,
    );
    expect(page).toContain('urlTabParam === "audit-log"');

    const nav = readSrc("lib/nav-commands.ts");
    expect(nav).toContain('href: "/audit-trail"');
    expect(nav).not.toMatch(/href:\s*"\/settings\?tab=audit-log"/);

    const audit = readSrc("app/(portal)/audit-trail/page.tsx");
    expect(audit).toContain("WS6_AUDIT_COMPLETED");
  });

  it("ghosts soft-hide — roles/sso out of IA and ⌘K promo", () => {
    expect([...GHOST_TABS].sort()).toEqual(["roles", "sso"]);
    expect(TABS.map((t) => t.id)).not.toContain("roles");
    expect(TABS.map((t) => t.id)).not.toContain("sso");

    const page = readSrc("app/(portal)/settings/page.tsx");
    expect(page).toMatch(/GHOST_TABS\.has/);
    expect(page).toContain("data-ws1-ghost-notice");

    const nav = readSrc("lib/nav-commands.ts");
    expect(nav).not.toMatch(/tab=roles/);
    expect(nav).not.toMatch(/tab=sso/);
  });

  it("overview fail→act CTAs present (≤2 clicks)", () => {
    const overview = readSrc(
      "app/(portal)/settings/_components/overview-panel.tsx",
    );
    expect(overview).toContain("/settings?tab=api-keys");
    expect(overview).toContain("/settings?tab=members");
    expect(overview).toContain("/settings?tab=billing");
    expect(overview).toMatch(/data-ws2-overview|data-ws1-overview/);
  });

  it("freeze pack artifacts + Workspace changelog sections exist", () => {
    const required = [
      ".workspace-wave12-route-matrix.md",
      ".workspace-wave12-axe-evidence.md",
      ".workspace-wave12-design-drift.md",
      ".workspace-wave12-final-critic.md",
      ".workspace-wave12-open-questions.md",
      ".workspace-wave12-signoff.md",
      ".workspace-wave12-verifier.md",
    ];
    for (const rel of required) {
      expect(existsSync(resolve(portalRoot, rel))).toBe(true);
    }
    const changelog = readFileSync(resolve(portalRoot, "CHANGELOG-UX.md"), "utf8");
    const walkthrough = readFileSync(
      resolve(portalRoot, "WALKTHROUGH-UX.md"),
      "utf8",
    );
    expect(changelog).toMatch(/## Workspace/i);
    expect(walkthrough).toMatch(/## Workspace/i);
  });
});
