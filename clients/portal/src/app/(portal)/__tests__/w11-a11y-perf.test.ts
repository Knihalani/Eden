/**
 * Wave 11 — Motion / a11y / perf / mobile / density contracts (portal UI overhaul).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  U20_MOTION_CLASSES,
  U20_SERIOUS_AXE_ROUTES,
  WAVE11_LIST_KEYBOARD_HUBS,
  WAVE11_MOBILE_CARD_SURFACES,
} from "@/lib/portal-polish";
import {
  WEB_VITAL_BUDGETS,
  F82_CORE_ROUTES,
  budgetFailures,
} from "@/lib/perf";
import { buildNavCommands, PALETTE_ACTIONS, SETTINGS_TAB_COMMANDS } from "@/lib/nav-commands";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("Wave 11 motion tokens ≤200ms", () => {
  it("panel-enter / row-select / live-append use duration tokens (hard ceiling)", () => {
    const css = src("app/globals.css");
    expect(css).toContain("--duration-fast: 150ms");
    expect(css).toContain("--duration-normal: 200ms");
    for (const cls of U20_MOTION_CLASSES) {
      expect(css).toContain(`.${cls}`);
    }
    expect(css).toMatch(
      /\.panel-enter\s*\{[^}]*animation:[^;]*var\(--duration-normal\)/,
    );
    expect(css).toMatch(
      /\.row-select-highlight\s*\{[^}]*var\(--duration-fast\)/,
    );
    expect(css).toMatch(
      /\.live-append-pulse\s*\{[^}]*animation:[^;]*var\(--duration-normal\)/,
    );
    expect(css).not.toMatch(/live-append-pulse-keyframes 600ms/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("DetailPanelShell + Sheet use panel-enter; hubs use row-select-highlight", () => {
    expect(src("components/portal-os/DetailPanelShell.tsx")).toContain("panel-enter");
    expect(src("components/ui/sheet.tsx")).toContain("panel-enter");
    expect(src("app/(portal)/issues/_components/issues-list.tsx")).toContain("row-select-highlight");
    expect(src("app/(portal)/artifacts/_components/artifacts-list.tsx")).toContain("row-select-highlight");
  });
});

describe("Wave 11 axe serious gate (traces + improve + evals + issues)", () => {
  it("keeps serious-gate routes aligned with audit script", () => {
    expect([...U20_SERIOUS_AXE_ROUTES]).toEqual(["/traces", "/improve", "/evals", "/issues"]);
    const script = readFileSync(resolve(ROOT, "scripts/audit-a11y.cjs"), "utf8");
    expect(script).toContain('"/traces"');
    expect(script).toContain('"/improve"');
    expect(script).toContain('"/evals"');
    expect(script).toContain('"/issues"');
    expect(script).toContain("SERIOUS_GATE_ROUTES");
    expect(script).toMatch(/serious/i);
  });

  it("documents authenticated live run requirement (jsdom gap)", () => {
    // Live axe needs running portal + Clerk storageState — not executable in vitest/jsdom.
    // Contract: script + route list exist; verifier records live-run debt when auth missing.
    expect(existsSync(resolve(ROOT, "scripts/audit-a11y.cjs"))).toBe(true);
    expect(existsSync(resolve(ROOT, ".wave11-verifier.md"))).toBe(true);
  });
});

describe("Wave 11 keyboard list nav + ⌘K", () => {
  it("useListKeyboardNav supports j/k and ArrowUp/Down", () => {
    const hook = src("hooks/use-list-keyboard-nav.ts");
    expect(hook).toContain("ArrowDown");
    expect(hook).toContain("ArrowUp");
    expect(hook).toContain("j:");
    expect(hook).toContain("k:");
  });

  it("wires list keyboard on traces / issues / alerts / artifacts", () => {
    for (const hub of WAVE11_LIST_KEYBOARD_HUBS) {
      const page =
        hub === "traces"
          ? src("app/(portal)/traces/_components/use-traces-hub.ts")
          : hub === "alerts"
            ? src("app/(portal)/alerts/_components/use-alerts-page.ts")
            : hub === "artifacts"
              ? src("app/(portal)/artifacts/_components/use-artifacts-page.ts")
              : src(`app/(portal)/${hub}/page.tsx`);
      expect(page, hub).toContain("useListKeyboardNav");
    }
  });

  it("⌘K indexes core hubs + Advanced + settings tabs", () => {
    const cmds = buildNavCommands();
    for (const href of ["/traces", "/issues", "/improve", "/evals", "/agents", "/dashboard"]) {
      expect(cmds.some((c) => c.href === href || c.href.startsWith(`${href}?`))).toBe(true);
    }
    expect(PALETTE_ACTIONS.some((a) => a.href === "/alerts")).toBe(true);
    expect(SETTINGS_TAB_COMMANDS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("Wave 11 focus rings", () => {
  it("kit primitives + density toggle use FOCUS_RING_CLASS", () => {
    for (const rel of [
      "components/ui/button.tsx",
      "components/ui/tabs.tsx",
      "components/ui/dialog.tsx",
      "components/ui/sheet.tsx",
      "app/(portal)/settings/page.tsx",
    ]) {
      expect(src(rel), rel).toContain("FOCUS_RING_CLASS");
    }
    expect(FOCUS_RING_CLASS).toContain("focus-visible:");
    expect(src("app/(portal)/settings/_components/sidebar-settings-view.tsx")).toContain(
      'data-testid="density-toggle"',
    );
  });
});

describe("Wave 11 virtualization + lazy islands", () => {
  it("large lists stay virtualized", () => {
    expect(src("components/portal-os/InfiniteDataTable.tsx")).toContain("@tanstack/react-virtual");
    expect(src("components/portal-os/VirtualizedList.tsx")).toContain("useVirtualizer");
    expect(src("components/traces/TraceDetailPanel.tsx")).toContain("VirtualizedTranscript");
    expect(src("app/(portal)/issues/_components/issues-list.tsx")).toContain("VirtualizedList");
    // W2 peel: queue virtualization lives in queue-board; History (runs) also virtualized.
    expect(src("app/(portal)/improve/_components/queue-board.tsx")).toContain(
      "VirtualizedList",
    );
    expect(src("app/(portal)/improve/runs/page.tsx")).toContain("VirtualizedList");
  });

  it("chrome islands stay dynamic()", () => {
    const chrome = src("app/(portal)/portal-chrome.tsx");
    expect(chrome).toMatch(/const CommandPalette = dynamic\(/);
    expect(chrome).toMatch(/const OnboardingOverlay = dynamic\(/);
    expect(src("components/portal-chrome/AiRailHost.tsx")).toMatch(/dynamic\(/);
  });
});

describe("Wave 11 mobile cards not shrunk tables", () => {
  it("marks card fallbacks on agents / fleet / improve", () => {
    for (const rel of WAVE11_MOBILE_CARD_SURFACES) {
      expect(src(rel), rel).toContain('data-wave11-mobile="cards"');
    }
    expect(src("app/(portal)/improve/runs/page.tsx")).toContain("lg:hidden");
    const agents = src("app/(portal)/agents/page.tsx");
    expect(agents).toContain("grid-cols-1");
    expect(agents).toContain("sm:grid-cols-");
    expect(src("app/(portal)/fleet/page.tsx")).toContain("grid-cols-1 md:grid-cols-");
  });
});

describe("Wave 11 density toggle (focused)", () => {
  it("settings density toggle persists via setDensity + AppShell data-density", () => {
    const settings = src("app/(portal)/settings/_components/sidebar-settings-view.tsx");
    expect(settings).toContain("setDensity");
    expect(settings).toContain('aria-pressed={prefs.density === d}');
    expect(settings).toContain("Comfortable");
    expect(settings).toContain("Compact");
    expect(settings).toContain("min-h-11");

    const prefs = src("hooks/use-sidebar-prefs.ts");
    expect(prefs).toContain('density: "comfortable" | "compact"');
    expect(prefs).toContain("setDensity:");

    const chrome = src("app/(portal)/portal-chrome.tsx");
    expect(chrome).toContain('density={densityCompact ? "compact" : "comfortable"}');
  });
});

describe("Wave 11 perf budgets (Home / Traces)", () => {
  it("publishes Web Vital budgets for F82 core routes", () => {
    expect([...F82_CORE_ROUTES]).toEqual(["/dashboard", "/traces"]);
    expect(WEB_VITAL_BUDGETS.LCP.max).toBeLessThanOrEqual(2600);
    expect(WEB_VITAL_BUDGETS.FCP.max).toBeLessThanOrEqual(1800);
    expect(WEB_VITAL_BUDGETS.INP.max).toBeLessThanOrEqual(220);
    expect(src("app/(portal)/dashboard/page.tsx")).toContain('usePagePerf("/dashboard")');
    expect(src("app/(portal)/traces/_components/use-traces-hub.ts")).toContain(
      'usePagePerf("/traces")',
    );
  });

  it("budgetFailures flags over-budget LCP samples", () => {
    const failures = budgetFailures([
      { route: "/dashboard", name: "LCP", value: 1000 },
      { route: "/traces", name: "LCP", value: 5000 },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.route).toBe("/traces");
  });
});

describe("Wave 11 verifier artifact", () => {
  it("ships .wave11-verifier.md against success metrics", () => {
    const doc = readFileSync(resolve(ROOT, ".wave11-verifier.md"), "utf8");
    expect(doc).toMatch(/Wave 11/i);
    expect(doc).toMatch(/Success metrics/i);
    expect(doc).toMatch(/Exit/i);
  });
});
