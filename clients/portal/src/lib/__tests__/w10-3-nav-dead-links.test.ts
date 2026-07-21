/**
 * Wave 10.3 — nav-dead-links: sidebar / palette / quick links / mobile nav
 * must never href removed routes; next.config soft-lands bookmarks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_QUIET_LINKS } from "@/app/(portal)/dashboard/_components/home-widgets";
import { MOBILE_CORE_NAV, MOBILE_MORE_LINKS } from "@/components/portal-os/MobileBottomNav";
import { isSafePortalHref } from "@/components/ai-insights/clientToolExecutors";
import {
  buildNavCommands,
  collectSidebarHrefs,
  PALETTE_ACTIONS,
} from "@/lib/nav-commands";
import {
  isRemovedPortalPath,
  REMOVED_PORTAL_PATH_PREFIXES,
} from "@/lib/portal-routes";
import { isExternalHref } from "@/lib/utils";

const ROOT = resolve(__dirname, "../../..");
const nextConfig = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");

function pathOnly(href: string): string {
  return href.split("?")[0].split("#")[0];
}

function assertNoRemoved(hrefs: string[], label: string) {
  for (const href of hrefs) {
    if (isExternalHref(href) || href.startsWith("eden:")) continue;
    expect(isRemovedPortalPath(pathOnly(href)), `${label}: ${href}`).toBe(false);
  }
}

describe("W10.3 nav-dead-links", () => {
  it("lists the July 2026 cut routes", () => {
    expect(REMOVED_PORTAL_PATH_PREFIXES).toEqual(
      expect.arrayContaining([
        "/marketplace",
        "/multi-agent",
        "/builder",
        "/jobs",
        "/eval-harnesses",
        "/sandbox",
      ]),
    );
  });

  it("sidebar + command palette + actions have zero removed hrefs", () => {
    assertNoRemoved(collectSidebarHrefs(), "sidebar");
    assertNoRemoved(
      buildNavCommands().map((c) => c.href),
      "nav-commands",
    );
    assertNoRemoved(
      PALETTE_ACTIONS.map((c) => c.href),
      "palette-actions",
    );
  });

  it("quiet home links + mobile nav have zero removed hrefs", () => {
    assertNoRemoved(
      HOME_QUIET_LINKS.map((l) => l.href),
      "home-quiet-links",
    );
    assertNoRemoved(
      MOBILE_CORE_NAV.map((l) => l.href),
      "mobile-core",
    );
    assertNoRemoved(
      MOBILE_MORE_LINKS.map((l) => l.href),
      "mobile-more",
    );
    // UX-P0-14: Agents stays in More (not core); Settings last OK.
    expect(MOBILE_MORE_LINKS.some((l) => l.href === "/agents")).toBe(true);
    expect(MOBILE_CORE_NAV.every((l) => l.href !== "/agents")).toBe(true);
  });

  it("next.config soft-lands every removed route (+ finops)", () => {
    for (const prefix of REMOVED_PORTAL_PATH_PREFIXES) {
      expect(nextConfig).toContain(`source: "${prefix}"`);
      expect(nextConfig).toContain(`source: "${prefix}/:path*"`);
      expect(nextConfig).toMatch(
        new RegExp(
          `source:\\s*"${prefix.replace(/\//g, "\\/")}"[^\\n]*destination:\\s*"/dashboard"`,
        ),
      );
    }
    expect(nextConfig).toContain('source: "/finops"');
    expect(nextConfig).toContain('destination: "/settings?tab=finops"');
  });

  it("AI navigate allowlist rejects removed routes and bare /finops", () => {
    for (const prefix of REMOVED_PORTAL_PATH_PREFIXES) {
      expect(isSafePortalHref(prefix)).toBe(false);
      expect(isSafePortalHref(`${prefix}/x`)).toBe(false);
    }
    expect(isSafePortalHref("/finops")).toBe(false);
    expect(isSafePortalHref("/finops/kills")).toBe(false);
    expect(isSafePortalHref("/settings?tab=finops")).toBe(true);
    expect(isSafePortalHref("/analytics")).toBe(true);
    expect(isSafePortalHref("/guardrails")).toBe(true);
    expect(isSafePortalHref("/traces")).toBe(true);
  });
});
