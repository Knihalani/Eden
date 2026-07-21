/**
 * Home Shell — contracts (W1) + freeze protect (W11).
 * Locks DESIGN 1A/2A + final product markers from W2–W10.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WAVE12_CHROME_SINKS } from "@/lib/portal-polish";

const ROOT = resolve(__dirname, "../../../..");
const design = () => readFileSync(resolve(ROOT, "DESIGN.md"), "utf8");
const button = () =>
  readFileSync(resolve(ROOT, "src/components/ui/button.tsx"), "utf8");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const rootFile = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("Home Shell W1 — DESIGN contracts", () => {
  it("locks Ask AI 1A — three doors, one surface", () => {
    const d = design();
    expect(d).toContain("Ask AI — three doors, one surface (1A)");
    expect(d).toContain("header utility icon + redesigned FAB + ⌘K/⌘J");
    expect(d).toContain("Header utility strip");
    expect(d).toContain("Search · Ask AI · Notifications");
    expect(d).not.toContain("Demote competing ⌘J FAB / coach overlays");
  });

  it("locks Cookie 2A — banner then gone; Settings/footer reopen", () => {
    const d = design();
    expect(d).toContain("### Cookie consent (2A)");
    expect(d).toContain("Render **nothing** fixed");
    expect(d).toContain("Settings · Privacy · footer only");
    expect(d).toContain("Ban any post-choice fixed pill");
  });

  it("locks ≤2 chrome bands + Home + Shell reopen section", () => {
    const d = design();
    expect(d).toContain("≤2 bands above content");
    expect(d).toContain("## Home + Shell (fleet reopen)");
    expect(d).toContain("ask-ai-fab");
    expect(d).toMatch(/Chrome\s+→\s+≤2 bands/);
  });

  it("locks IconButton = Button size=\"icon\" only", () => {
    const d = design();
    expect(d).toContain('size="icon"');
    expect(d).toContain("Ban raw chrome `<button>`");
    expect(button()).toContain("icon:");
  });

  it("locks breadcrumb prefer kit ui/breadcrumb.tsx", () => {
    const d = design();
    expect(d).toContain("### Breadcrumb");
    expect(d).toContain("ui/breadcrumb.tsx");
    expect(d).toContain("single breadcrumb API = kit");
  });
});

describe("Home Shell W1 — chrome sink budget ≤6", () => {
  it("WAVE12_CHROME_SINKS is exactly six including ask-ai-fab", () => {
    expect(WAVE12_CHROME_SINKS).toHaveLength(6);
    expect([...WAVE12_CHROME_SINKS]).toEqual([
      "sidebar",
      "header",
      "command-palette",
      "banner",
      "toast",
      "ask-ai-fab",
    ]);
  });
});

describe("Home Shell W3 — Ask AI 1A product", () => {
  it("header Ask AI + redesigned FAB + collapsed default + palette door", () => {
    const header = src("components/portal-chrome/PortalHeader.tsx");
    expect(header).toContain("data-ask-ai-header");
    expect(header).toContain("eden:ask-ai");
    expect(header).toContain('aria-label="Ask AI"');

    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain("data-ai-fab");
    expect(shell).toContain('variant="secondary"');
    expect(shell).toContain("z-[var(--z-ai-fab)]");
    expect(shell).toContain("bottom-[var(--ai-fab-bottom)]");
    expect(shell).not.toContain("bottom-20");

    expect(src("components/portal-chrome/AiRailHost.tsx")).toContain(
      'data-wave11-airail="collapsed-default"',
    );
    expect(src("lib/nav-commands.ts")).toContain("header · FAB · ⌘K/⌘J");
    expect(src("components/ai-insights/hooks/useChatSidebar.ts")).toContain(
      "setShowCoach(true)",
    );
  });
});

describe("Home Shell W11 — freeze protect", () => {
  it("locks final Home composition + protect markers", () => {
    const page = src("app/(portal)/dashboard/page.tsx");
    expect(page).toContain("WAVE6_HOME_COMPLETED = true");
    expect(page).toContain("WAVE7_HOME_COMPOSITION = true");
    expect(page).toContain("WAVE8_HOME_STATES = true");
    expect(page).toContain("WAVE9_HOME_MOBILE = true");
    expect(page).toContain("WAVE11_HOME_PROTECTED = true");
    expect(page).toContain('data-home-shell-home="status-diagnosis-action"');
    expect(page).toContain('data-wave7-home="composition"');
    expect(page).toContain('data-wave11-home="protected"');
  });

  it("locks shell markers — sidebar, slim header Search chip, diagnosis one-CTA", () => {
    expect(src("components/portal-chrome/SidebarNav.tsx")).toContain(
      'data-home-shell-sidebar="tonal-rail"',
    );
    const header = src("components/portal-chrome/PortalHeader.tsx");
    expect(header).toContain('data-home-shell-header="slim"');
    expect(header).toContain("data-search-chip");
    expect(header).toContain("Search…");
    expect(header).toContain("⌘K");
    expect(
      src("app/(portal)/dashboard/_components/diagnosis-strip.tsx"),
    ).toContain('data-home-shell-diagnosis="one-cta"');
    expect(
      src("app/(portal)/dashboard/_components/home-kpi-strip.tsx"),
    ).toContain('data-home-shell-kpi="restraint"');
  });

  it("locks Cookie 2A product — null after choice", () => {
    const cookie = src("components/cookie-consent.tsx");
    expect(cookie).toMatch(
      /if\s*\(\s*ready\s*&&\s*hasChoice\s*&&\s*!visible\s*\)\s*return\s*null/,
    );
  });

  it("locks ready-Home Open Traces as ghost (diagnosis owns accent)", () => {
    const actions = src(
      "app/(portal)/dashboard/_components/home-header-actions.tsx",
    );
    expect(actions).toMatch(
      /data-home-shell-toolbar="≤5"[\s\S]*?<Button asChild variant="ghost"[\s\S]*?Open Traces/,
    );
  });

  it("SidebarSearch and dead Home widgets stay gone", () => {
    expect(
      existsSync(resolve(ROOT, "src/components/layout/sidebar-search.tsx")),
    ).toBe(false);
    const layoutIndex = src("components/layout/index.ts");
    expect(layoutIndex).not.toContain("SidebarSearch");
    expect(layoutIndex).not.toContain("sidebar-search");

    const dash = resolve(ROOT, "src/app/(portal)/dashboard/_components");
    for (const dead of [
      "quick-links.tsx",
      "latency-card.tsx",
      "throughput-card.tsx",
      "recent-traces-card.tsx",
    ]) {
      expect(existsSync(resolve(dash, dead)), dead).toBe(false);
    }
  });

  it("portal-chrome.tsx stays ≤400 LOC", () => {
    const chrome = src("app/(portal)/portal-chrome.tsx");
    expect(chrome.split("\n").length).toBeLessThanOrEqual(400);
  });

  it("freeze docs exist — CHANGELOG, WALKTHROUGH, W11 freeze note", () => {
    expect(existsSync(resolve(ROOT, "CHANGELOG-UX.md"))).toBe(true);
    expect(existsSync(resolve(ROOT, "WALKTHROUGH-UX.md"))).toBe(true);
    expect(existsSync(resolve(ROOT, ".home-shell-w11-freeze.md"))).toBe(true);
    expect(rootFile("CHANGELOG-UX.md")).toContain("Home + Shell");
    expect(rootFile("WALKTHROUGH-UX.md")).toContain("Home + Shell");
    expect(rootFile(".home-shell-w11-freeze.md")).toContain("SHIP");
  });
});
