/**
 * Home Shell Wave 9 — bottom-layer exclusivity + mobile safe areas.
 * Source contracts only (no full e2e).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const design = () => readFileSync(resolve(ROOT, "DESIGN.md"), "utf8");

describe("Home Shell W9 — z-stack tokens", () => {
  it("globals.css documents cookie / mobile / AI / bulk ladder + --ai-fab-bottom", () => {
    const css = src("app/globals.css");
    expect(css).toContain("--z-bulk-bar: 20");
    expect(css).toContain("--z-mobile-nav: 30");
    expect(css).toContain("--z-ai-fab: 35");
    expect(css).toContain("--z-ai-rail: 40");
    expect(css).toContain("--z-cookie: 40");
    expect(css).toContain("--mobile-nav-height: 4rem");
    expect(css).toContain("--ai-fab-bottom:");
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).toContain("data-cookie-awaiting");
    expect(css).toContain("data-ai-rail-open");
  });

  it("DESIGN §13 lists bottom-layer tokens + exclusivity table", () => {
    const d = design();
    expect(d).toContain("## 13. Z-index / bottom-layer contract");
    expect(d).toContain("`--z-bulk-bar`");
    expect(d).toContain("`--z-mobile-nav`");
    expect(d).toContain("`--z-ai-fab`");
    expect(d).toContain("`--z-ai-rail`");
    expect(d).toContain("`--ai-fab-bottom`");
    expect(d).toContain("Mutually exclusive");
    expect(d).toContain("Cookie awaiting choice");
    expect(d).toContain("AI open");
  });
});

describe("Home Shell W9 — mutual exclusion markers", () => {
  it("MobileBottomNav hides on eden:ai-rail-open + safe-area", () => {
    const nav = src("components/portal-os/MobileBottomNav.tsx");
    expect(nav).toContain('data-bottom-layer="mobile-nav"');
    expect(nav).toContain("eden:ai-rail-open");
    expect(nav).toContain('data-ai-rail-open") === "1"');
    expect(nav).toContain("if (aiRailOpen) return null");
    expect(nav).toContain("pb-[env(safe-area-inset-bottom,0px)]");
    expect(nav).toContain('data-wave9-mobile-nav="safe-area"');
  });

  it("Ask AI FAB uses --ai-fab-bottom and yields to cookie / open rail", () => {
    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain("bottom-[var(--ai-fab-bottom)]");
    expect(shell).toContain('data-bottom-layer="ai-fab"');
    expect(shell).toContain('data-wave9-fab="clear-of-mobile-nav"');
    expect(shell).toContain("!chat.cookieAwaiting");
    expect(shell).toContain('data-ai-fab');
    expect(shell).not.toContain("bottom-20");

    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain("cookieAwaiting");
    expect(hook).toContain("data-cookie-awaiting");
    expect(hook).toContain("eden:ai-rail-open");
  });

  it("cookie sets data-cookie-awaiting; yields to AI; null after choice (2A)", () => {
    const cookie = src("components/cookie-consent.tsx");
    expect(cookie).toContain('setAttribute("data-cookie-awaiting", "1")');
    expect(cookie).toContain('removeAttribute("data-cookie-awaiting")');
    expect(cookie).toContain("eden:ai-rail-open");
    expect(cookie).toContain("showBanner");
    expect(cookie).toContain('data-bottom-layer="cookie"');
    expect(cookie).toContain("if (ready && hasChoice && !visible) return null");
    expect(cookie).toContain(
      "bottom-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom,0px)+0.75rem)]",
    );
  });

  it("BulkActionBar hideOnMobile + AppShell exclusivity + safe-area pad", () => {
    const bulk = src("components/portal-os/BulkActionBar.tsx");
    expect(bulk).toContain('data-bottom-layer="bulk-bar"');
    expect(bulk).toContain('data-wave9-bulk="hide-on-mobile"');
    expect(bulk).toContain("hidden lg:flex");
    expect(bulk).toContain("safe-area-inset-bottom");

    const shell = src("components/portal-os/AppShell.tsx");
    expect(shell).toContain('data-bottom-exclusivity="1"');
    expect(shell).toContain('data-wave9-shell="bottom-exclusive"');
    expect(shell).toContain(
      "pb-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom,0px)+1rem)]",
    );
    expect(shell).toContain("overflow-x-hidden");
  });
});

describe("Home Shell W9 — responsive Home", () => {
  it("dashboard single-column overflow guard + WAVE9 marker", () => {
    const page = src("app/(portal)/dashboard/page.tsx");
    expect(page).toContain("WAVE9_HOME_MOBILE = true");
    expect(page).toContain('data-wave9-home="mobile"');
    expect(page).toContain('data-wave9-mobile="single-column"');
    expect(page).toContain("overflow-x-hidden");
    expect(page).toContain("min-w-0");

    const kpi = src("app/(portal)/dashboard/_components/home-kpi-strip.tsx");
    expect(kpi).toContain("grid-cols-1");
    expect(kpi).toContain("min-w-0");
  });
});
