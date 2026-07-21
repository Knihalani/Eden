/**
 * Home Shell Wave 6 — Button + chrome control grammar.
 * Kit Button on Home path; IconButton = size="icon"; zero hand-rolled accent CTAs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

const SHELL_FILES = [
  "components/portal-chrome/PortalHeader.tsx",
  "components/portal-chrome/NotificationsDropdown.tsx",
  "components/portal-chrome/SidebarNav.tsx",
  "components/portal-chrome/sidebar-nav-items.tsx",
  "components/portal-chrome/ChromeBanners.tsx",
  "components/cookie-consent.tsx",
  "app/(portal)/dashboard/_components/home-header-actions.tsx",
] as const;

function rawAccentButtonCount(text: string): number {
  const lower = text.toLowerCase();
  let total = 0;
  let i = 0;
  while (i < text.length) {
    const start = lower.indexOf("<button", i);
    if (start < 0) break;
    const after = start + 7;
    if (text[after] && /[a-zA-Z0-9]/.test(text[after])) {
      i = after;
      continue;
    }
    let j = after;
    let quote: string | null = null;
    while (j < text.length && j - start < 4000) {
      const c = text[j];
      if (quote) {
        if (c === quote && text[j - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j += 1;
    }
    const tag = text.slice(start, j + 1);
    if (/bg-\[var\(--accent\)\]/.test(tag)) total += 1;
    i = j + 1;
  }
  return total;
}

describe("W6 shell — kit Button grammar", () => {
  it("PortalHeader utilities are kit Button (no raw <button>)", () => {
    const header = src("components/portal-chrome/PortalHeader.tsx");
    expect(header).toContain('from "@/components/ui/button"');
    expect(header).toContain('size="icon"');
    expect(header).toContain("data-search-chip");
    expect(header).toContain("data-ask-ai-header");
    expect(header).not.toMatch(/<button[\s>]/);
  });

  it("Notifications bell is Button size=icon", () => {
    const notifs = src("components/portal-chrome/NotificationsDropdown.tsx");
    expect(notifs).toContain('from "@/components/ui/button"');
    expect(notifs).toContain('size="icon"');
    expect(notifs).toContain('aria-label="Notifications"');
    expect(notifs).not.toMatch(/<button[\s>]/);
  });

  it("Sidebar collapse / close / pin use kit Button", () => {
    const nav = src("components/portal-chrome/SidebarNav.tsx");
    const items = src("components/portal-chrome/sidebar-nav-items.tsx");
    expect(nav).toContain('from "@/components/ui/button"');
    expect(nav).toContain("Collapse sidebar");
    expect(nav).toContain('size="icon"');
    expect(items).toContain('from "@/components/ui/button"');
    expect(items).toContain("pin-button");
    expect(items).toContain('size="icon"');
  });

  it("Home header: first-run primary; ready Open Traces is ghost", () => {
    const actions = src(
      "app/(portal)/dashboard/_components/home-header-actions.tsx",
    );
    expect(actions).toContain('from "@/components/ui/button"');
    expect(actions).toContain('variant="ghost"');
    // First-run Docs secondary is ghost (not outline) when keys exist.
    expect(actions).not.toContain('variant="outline"');
    // First-run owns the default CTA; ready toolbar demotes Open Traces (diagnosis owns accent).
    const defaultAsChild = (actions.match(/<Button asChild(?![^>]*variant=)/g) ?? [])
      .length;
    expect(defaultAsChild).toBeGreaterThanOrEqual(1);
    expect(actions).toMatch(
      /data-home-shell-toolbar="≤5"[\s\S]*?<Button asChild variant="ghost"[\s\S]*?Open Traces/,
    );
  });

  it("Cookie banner Accept is kit Button default; no hand-rolled accent", () => {
    const cookie = src("components/cookie-consent.tsx");
    expect(cookie).toContain('from "@/components/ui/button"');
    expect(cookie).toContain('variant="default"');
    expect(cookie).toContain("Accept");
    expect(cookie).toContain("Decline");
    expect(rawAccentButtonCount(cookie)).toBe(0);
    // 2A preserved: null after choice.
    expect(cookie).toMatch(/if\s*\(\s*ready\s*&&\s*hasChoice\s*&&\s*!visible\s*\)\s*return\s*null/);
  });
});

describe("W6 shell — zero hand-rolled accent CTAs", () => {
  it("shell Home path files have no raw accent <button>", () => {
    for (const rel of SHELL_FILES) {
      expect(rawAccentButtonCount(src(rel)), rel).toBe(0);
    }
  });

  it("DESIGN.md documents shell Button examples", () => {
    const design = readFileSync(resolve(ROOT, "DESIGN.md"), "utf8");
    expect(design).toContain("Shell Home path examples (W6)");
    expect(design).toContain('size="icon"');
    expect(design).toContain("Cookie Accept");
  });
});
