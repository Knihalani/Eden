/**
 * Wave 14 — Portal INTERACTION polish regression locks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNavCommands,
  PALETTE_ACTIONS,
  SETTINGS_TAB_COMMANDS,
} from "@/lib/nav-commands";
import {
  U20_EMPTY_COPY,
  U20_FILTER_EMPTY_COPY,
} from "@/lib/portal-polish";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W14 focus-ring util on interactive primitives", () => {
  it("Button, Tabs, FilterBar, Dialog, Sheet import FOCUS_RING_CLASS", () => {
    for (const rel of [
      "components/ui/button.tsx",
      "components/ui/tabs.tsx",
      "components/ui/filter-bar.tsx",
      "components/ui/dialog.tsx",
      "components/ui/sheet.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).toMatch(/from ["'].*focus-ring["']/);
      expect(src, rel).toContain("FOCUS_RING_CLASS");
    }
    expect(FOCUS_RING_CLASS).toContain("focus-visible:");
  });

  it("Dialog + Sheet close controls are ≥44px with focus ring", () => {
    const dialog = read("components/ui/dialog.tsx");
    const sheet = read("components/ui/sheet.tsx");
    expect(dialog).toMatch(/min-h-11[\s\S]*?Close dialog|Close dialog[\s\S]*?min-h-11/);
    expect(dialog).toContain("FOCUS_RING_CLASS");
    expect(sheet).toMatch(/min-h-\[44px\][\s\S]*?min-w-\[44px\]/);
    expect(sheet).toContain("FOCUS_RING_CLASS");
  });
});

describe("W14 keyboard hubs (ViewsMenu + More sheet)", () => {
  it("ViewsMenu closes on Escape and uses focus-ring + min-h-11 menuitems", () => {
    const src = read("components/portal-os/ViewsMenu.tsx");
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain("FOCUS_RING_CLASS");
    expect(src).toContain("min-h-11");
    expect(src).toContain('aria-haspopup="menu"');
    expect(src).toContain('role="menu"');
  });

  it("Mobile More sheet keeps 44px rows + focus ring", () => {
    const src = read("components/portal-os/MobileBottomNav.tsx");
    expect(src).toContain("FOCUS_RING_CLASS");
    expect(src).toContain('min-h-[44px]');
    expect(src).toContain("<Sheet");
  });
});

describe("W14 empty / filter microcopy", () => {
  it("keeps calm voice and filter-empty distinct from zero-data", () => {
    for (const text of [
      ...Object.values(U20_EMPTY_COPY),
      ...Object.values(U20_FILTER_EMPTY_COPY),
    ]) {
      expect(text).not.toMatch(/!/);
    }
    expect(U20_FILTER_EMPTY_COPY.traces).toMatch(/filters/i);
    expect(U20_EMPTY_COPY.traces).toMatch(/ingested|doctor|SDK/i);
    expect(U20_EMPTY_COPY.onlineScoring).toBeTruthy();
    expect(U20_EMPTY_COPY.improveQueue).toBeTruthy();
  });

  it("hubs wire shared empty / filter-empty copy", () => {
    expect(read("app/(portal)/improve/_components/queue-board.tsx")).toContain(
      "U20_EMPTY_COPY.improveQueue",
    );
    expect(read("app/(portal)/agents/page.tsx")).toContain("U20_EMPTY_COPY.agents");
    expect(read("app/(portal)/agents/page.tsx")).toContain("U20_FILTER_EMPTY_COPY.agents");
    expect(read("app/(portal)/issues/_components/issues-list.tsx")).toContain("U20_FILTER_EMPTY_COPY.issues");
    const traces =
      read("app/(portal)/traces/page.tsx") +
      read("app/(portal)/traces/_components/traces-hub-list.tsx") +
      read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(traces).toContain("U20_FILTER_EMPTY_COPY.traces");
  });
});

describe("W14 ErrorState retry affordance", () => {
  it("ErrorState accepts onRetry and QueryState uses it", () => {
    const err = read("components/ui/error-state.tsx");
    const qs = read("components/ui/query-state.tsx");
    expect(err).toContain("onRetry?:");
    expect(err).toContain("Try again");
    expect(err).toContain("min-h-11");
    expect(qs).toContain("onRetry={onRetry}");
    expect(qs).not.toContain("RefreshCw");
  });
});

describe("W14 touch targets (filter chips + guardrails)", () => {
  it("FilterBar applied chips are removable ≥44px controls", () => {
    const src = read("components/ui/filter-bar.tsx");
    expect(src).toContain("Remove filter");
    expect(src).toContain("min-h-11");
    expect(src).toContain("FOCUS_RING_CLASS");
    expect(src).not.toContain("sm:min-h-6");
  });

  it("Guardrails table chips drop py-0.5 half-steps; enable toggle ≥44px", () => {
    const page = read("app/(portal)/guardrails/page.tsx");
    const policies = read("app/(portal)/guardrails/_components/policies-tab.tsx");
    const src = [page, policies].join("\n");
    expect(src).not.toMatch(/py-0\.5/);
    expect(src).toContain("min-h-11");
  });
});

describe("W14 ⌘K indexes core + Advanced + settings tabs (S-06)", () => {
  it("buildNavCommands includes Advanced sidebar routes and settings ?tab= deep-links", () => {
    const cmds = buildNavCommands();
    expect(cmds.some((c) => c.href === "/agents")).toBe(true);
    expect(cmds.some((c) => c.href === "/analytics")).toBe(true);
    expect(SETTINGS_TAB_COMMANDS.length).toBeGreaterThanOrEqual(10);
    expect(
      SETTINGS_TAB_COMMANDS.every(
        (c) =>
          c.href === "/settings" ||
          c.href.startsWith("/settings?tab=") ||
          c.href === "/audit-trail",
      ),
    ).toBe(true);
    expect(SETTINGS_TAB_COMMANDS.some((c) => c.href === "/audit-trail")).toBe(true);
    expect(SETTINGS_TAB_COMMANDS.some((c) => c.href === "/settings")).toBe(true);
    expect(cmds.some((c) => c.href === "/settings?tab=scim")).toBe(true);
    expect(cmds.some((c) => c.href === "/settings?tab=api-keys")).toBe(true);
    expect(PALETTE_ACTIONS.some((a) => a.href === "/improve/online-scoring")).toBe(true);
  });
});

describe("W14 online-scoring discoverability (I-02)", () => {
  it("Online scoring lives in Advanced nav + ⌘K (not Improve path overflow)", () => {
    const improve = read("app/(portal)/improve/page.tsx");
    const related = read(
      "app/(portal)/improve/_components/improve-constants.ts",
    );
    expect(improve).not.toContain('href: "/improve/online-scoring"');
    expect(improve).not.toContain("PATH_LINKS");
    expect(related).toContain("RELATED_LINKS");
    expect(related).not.toContain("/improve/online-scoring");

    expect(PALETTE_ACTIONS.some((a) => a.href === "/improve/online-scoring")).toBe(true);
    const cmds = buildNavCommands();
    expect(cmds.some((c) => c.href === "/improve/online-scoring")).toBe(true);
  });

  it("online-scoring leaf links back to Improve + uses shared empty + onRetry", () => {
    const src = read("app/(portal)/improve/online-scoring/page.tsx");
    expect(src).toContain('href="/improve"');
    expect(src).toContain("U20_EMPTY_COPY.onlineScoring");
    expect(src).toContain("onRetry=");
  });
});
