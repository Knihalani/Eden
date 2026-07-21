/**
 * Wave 11 V2 — Home protect + Auth + residual OS/chrome.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WAVE11_MOBILE_CARD_SURFACES } from "@/lib/portal-polish";
import { PRODUCT_TOUR_STEPS, WAVE11_TOUR_SLIM } from "@/lib/product-tour";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("Wave 11.1–11.3 Home protect", () => {
  const page = src("app/(portal)/dashboard/page.tsx");
  const widgets = src("app/(portal)/dashboard/_components/home-widgets.ts");
  const hook = src("app/(portal)/dashboard/_components/use-home-dashboard.ts");
  const firstRun = src("app/(portal)/dashboard/_components/home-first-run.tsx");
  const header = src("app/(portal)/dashboard/_components/home-header-actions.tsx");

  it("locks Status → Diagnosis → Action with no re-widget", () => {
    expect(page).toContain("WAVE11_HOME_PROTECTED = true");
    expect(page).toContain('data-wave11-home="protected"');
    expect(page).toContain("HomeKpiStrip");
    expect(page).toContain("DiagnosisStrip");
    expect(page).toContain("RecentFailuresCard");
    expect(page).not.toContain("toggleWidget");
    expect(page).not.toContain("dashboard-edit-layout");
    expect(header).not.toContain("Edit layout");
    expect(hook).toContain("DEFAULT_WIDGETS");
    expect(hook).not.toContain("loadLayout");
    expect(hook).not.toContain("toggleWidget");
  });

  it("keeps KPI strip ≤4", () => {
    expect(widgets).toContain("HOME_KPI_STRIP_CAP = 4");
    const match = widgets.match(
      /const DEFAULT_WIDGETS:\s*WidgetId\[\]\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(match).toBeTruthy();
    const ids = (match![1].match(/"[a-z-]+"/g) ?? []).map((s) =>
      s.replace(/"/g, ""),
    );
    expect(ids.slice(0, 4)).toEqual(["throughput", "errors", "cost", "issues"]);
  });

  it("first-event wait polish stays wired", () => {
    expect(firstRun).toContain("FIRST_EVENT_WAIT");
    expect(firstRun).toContain('data-testid="dashboard-first-run"');
    expect(page).toContain("HomeFirstRun");
  });
});

describe("Wave 11.4 Auth consistency", () => {
  it("sign-in / sign-up / invite / password share AuthSplitLayout + AuthPageIntro grammar", () => {
    expect(src("components/auth/auth-page-intro.tsx")).toContain(
      'data-wave11-auth="intro"',
    );
    expect(src("app/(auth)/login/[[...login]]/page.tsx")).toContain("AuthPageIntro");
    expect(src("app/(auth)/login/[[...login]]/page.tsx")).toContain(
      'data-wave11-auth="sign-in"',
    );
    expect(src("app/(auth)/signup/[[...signup]]/page.tsx")).toContain("AuthPageIntro");
    expect(src("app/(auth)/signup/[[...signup]]/page.tsx")).toContain(
      'data-wave11-auth="sign-up"',
    );
    expect(src("app/(auth)/forgot-password/page.tsx")).toContain(
      'data-wave11-auth="forgot-password"',
    );
    expect(src("app/(auth)/reset-password/page.tsx")).toContain(
      'data-wave11-auth="reset-password"',
    );
    expect(src("app/(auth)/invite/[token]/page.tsx")).toContain(
      'data-wave11-auth="invite"',
    );
    for (const rel of [
      "app/(auth)/login/[[...login]]/page.tsx",
      "app/(auth)/signup/[[...signup]]/page.tsx",
      "app/(auth)/forgot-password/page.tsx",
      "app/(auth)/reset-password/page.tsx",
      "app/(auth)/invite/[token]/page.tsx",
    ]) {
      expect(src(rel), rel).toContain("AuthSplitLayout");
    }
  });
});

describe("Wave 11.5 Onboarding slim", () => {
  it("tour stays ≤5 steps and defers overlapping chrome", () => {
    expect(WAVE11_TOUR_SLIM).toBe(true);
    expect(PRODUCT_TOUR_STEPS.length).toBeLessThanOrEqual(5);
    expect(src("components/onboarding/OnboardingOverlay.tsx")).toContain(
      "shouldDeferBlockingOverlays",
    );
    expect(src("app/(portal)/onboarding/improvement-loop.tsx")).toContain(
      'data-wave11-onboarding="improvement-loop"',
    );
  });
});

describe("Wave 11.6–11.7 Shell + density", () => {
  it("AppShell / BulkActionBar / MobileBottomNav declare bottom exclusivity", () => {
    expect(src("components/portal-os/AppShell.tsx")).toContain(
      'data-bottom-exclusivity="1"',
    );
    expect(src("components/portal-os/BulkActionBar.tsx")).toContain(
      'data-bottom-layer="bulk-bar"',
    );
    expect(src("components/portal-os/MobileBottomNav.tsx")).toContain(
      'data-bottom-layer="mobile-nav"',
    );
    expect(src("components/portal-os/MobileBottomNav.tsx")).toContain(
      "eden:ai-rail-open",
    );
    expect(src("components/portal-os/ResourcePageShell.tsx")).toContain(
      'data-wave11-shell="resource"',
    );
  });

  it("DataTable + InfiniteDataTable honor compact/comfortable density", () => {
    const table = src("components/ui/data-table.tsx");
    expect(table).toContain("useDensity");
    expect(table).toContain('data-wave11-density={density}');
    expect(table).toContain('density === "compact"');
    expect(table).toContain('density === "comfortable"');
    expect(src("components/portal-os/InfiniteDataTable.tsx")).toContain(
      "useDensity",
    );
  });
});

describe("Wave 11.8 Mobile cards — core five", () => {
  it("marks cards on Home / Traces / Issues / Evals / Improve", () => {
    for (const rel of WAVE11_MOBILE_CARD_SURFACES) {
      expect(src(rel), rel).toContain('data-wave11-mobile="cards"');
    }
    expect(src("app/(portal)/observability/_components/TracesTab.tsx")).toContain(
      "md:hidden",
    );
    expect(src("app/(portal)/observability/_components/TracesTab.tsx")).toContain(
      "hidden md:block",
    );
  });
});

describe("Wave 11.9 AiRail collapsed + Ask AI entry (1A)", () => {
  /**
   * Home Shell fleet: collapsed-default rail stays; discoverability is header +
   * redesigned FAB + ⌘K/⌘J (not ⌘K-only).
   */
  it("defaults collapsed; Ask AI via header · FAB · ⌘K/⌘J (1A)", () => {
    expect(src("components/portal-chrome/AiRailHost.tsx")).toContain(
      'data-wave11-airail="collapsed-default"',
    );
    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain("useState<boolean>(false)");
    expect(hook).not.toContain('sessionStorage.getItem("eden:ai-sidebar:open") === "1"');
    expect(src("lib/nav-commands.ts")).toContain('label: "Ask AI"');
    expect(src("app/(portal)/portal-chrome.tsx")).toContain("AiRailHost");

    const header = src("components/portal-chrome/PortalHeader.tsx");
    expect(header).toContain('aria-label="Ask AI"');
    expect(header).toContain("data-ask-ai-header");
    expect(header).toContain("eden:ask-ai");

    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain('data-ai-fab');
    expect(shell).toContain('aria-label="Ask AI"');
    expect(shell).toContain('variant="secondary"');
    expect(shell).toContain("z-[var(--z-ai-fab)]");
  });
});

describe("Wave 11.10 Chrome ≤400", () => {
  it("portal-chrome orchestrator peels under 400 LOC", () => {
    const chrome = src("app/(portal)/portal-chrome.tsx");
    const lines = chrome.split("\n").length;
    expect(lines).toBeLessThanOrEqual(400);
    expect(chrome).toContain("use-portal-chrome-effects");
    expect(
      src("hooks/use-portal-chrome-effects.ts"),
    ).toContain("usePortalChromeShortcuts");
  });
});
