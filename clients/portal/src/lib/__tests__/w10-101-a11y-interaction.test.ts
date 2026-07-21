/**
 * W10-10.1 — a11y interaction re-audit contracts.
 *
 * Guards FRONTEND_AUDIT F1–F4 patterns on high-traffic chrome:
 * sidebar Radix tooltips, cookie banner auth scope, 44px touch
 * targets on palette/chrome/cookie/issues/traces hubs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W10.1 command palette focus return (F4)", () => {
  const src = read("components/ui/command-palette.tsx");

  it("tracks focus while closed and restores only connected nodes", () => {
    expect(src).toContain('document.addEventListener("focusin", track)');
    expect(src).toContain("el.isConnected");
    expect(src).toContain("wasOpenRef");
    // Must not capture activeElement only after open (stores cmdk input).
    expect(src).not.toMatch(
      /if\s*\(\s*open\s*\)\s*\{[\s\S]*?lastFocusRef\.current\s*=\s*\(document\.activeElement/,
    );
  });

  it("focuses search input on open and traps Tab", () => {
    expect(src).toContain("input?.focus()");
    expect(src).toContain("FOCUSABLE_SELECTOR");
    expect(src).toContain('e.key !== "Tab"');
    expect(src).toContain('aria-modal="true"');
  });

  it("close control is ≥44px", () => {
    expect(src).toMatch(
      /Close command palette[\s\S]*?min-h-\[44px\][\s\S]*?min-w-\[44px\]|min-h-\[44px\][\s\S]*?min-w-\[44px\][\s\S]*?Close command palette/,
    );
  });
});

describe("W10.1 sidebar collapsed tooltips (F1)", () => {
  const navItems = read("components/portal-chrome/sidebar-nav-items.tsx");
  const header = read("components/portal-chrome/PortalHeader.tsx");
  const notifications = read("components/portal-chrome/NotificationsDropdown.tsx");

  it("uses Radix Tooltip for collapsed nav labels (no CSS nav-tooltip)", () => {
    expect(navItems).toContain("TooltipTrigger asChild");
    expect(navItems).toContain("TooltipContent");
    expect(navItems).toMatch(/collapsed\s*\?\s*\([\s\S]*?Tooltip/);
    expect(navItems).not.toContain("nav-tooltip");
  });

  it("search triggers announce ⌘K and meet 44px on touch chrome", () => {
    expect(header).toContain('aria-label="Search (⌘K)"');
    // W6: kit Button size="icon" owns touch via max-md:min-h-11 / min-w-11
    expect(header).toContain('size="icon"');
    expect(header).toMatch(/lg:hidden[\s\S]*?size="icon"/);
    expect(notifications).toContain('aria-label="Notifications"');
    expect(notifications).toContain('size="icon"');
    const buttonSrc = read("components/ui/button.tsx");
    expect(buttonSrc).toMatch(/icon:[\s\S]*?max-md:min-h-11[\s\S]*?max-md:min-w-11/);
  });
});

describe("W10.1 cookie banner scope (F3) + touch targets", () => {
  const cookie = read("components/cookie-consent.tsx");

  it("skips auth routes via shared isAuthPath", () => {
    expect(cookie).toContain('from "@/lib/auth-redirect"');
    expect(cookie).toContain("isAuthPath");
    expect(cookie).toContain("onAuthRoute");
    expect(cookie).toMatch(/if\s*\(\s*onAuthRoute\s*\)\s*return\s*null/);
  });

  it("Accept/Decline/expand controls use min-h-[44px]", () => {
    const acceptCount = (cookie.match(/min-h-\[44px\]/g) ?? []).length;
    expect(acceptCount).toBeGreaterThanOrEqual(4);
    expect(cookie).toContain("Accept");
    expect(cookie).toContain("Decline");
  });
});

describe("W10.1 high-traffic hub tabs ≥44px (min-h-11)", () => {
  it("issues section tabs + status filter select + detail section tabs", () => {
    const list = read("app/(portal)/issues/page.tsx");
    const detailHeader = read("app/(portal)/issues/_components/issue-detail-header.tsx");
    const filterBar = read("components/ui/filter-bar.tsx");
    // Wave 7 moved status into ResourceOsToolbar → FilterBar selects
    expect(list).toMatch(/Issues sections[\s\S]*?min-h-11/);
    expect(list).toContain('key: "status"');
    expect(filterBar).toMatch(/aria-label=\{\`\$\{s\.label\} filter\`\}/);
    expect(filterBar).toMatch(/min-h-11[\s\S]*?s\.label|aria-label=\{\`\$\{s\.label\} filter\`\}[\s\S]*?min-h-11/);
    expect(detailHeader).toMatch(/Issue sections[\s\S]*?min-h-11/);
  });

  it("traces observe hub tabs", () => {
    const traces =
      read("app/(portal)/traces/page.tsx") +
      read("app/(portal)/traces/_components/TracesToolbar.tsx");
    expect(traces).toMatch(/Observe hub[\s\S]*?min-h-11|TracesToolbar[\s\S]*?min-h-11|min-h-11[\s\S]*?Traces/);
  });
});
