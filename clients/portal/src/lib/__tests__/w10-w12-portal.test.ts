/**
 * Waves 10–12 portal shell / tables OS / UX — structural contracts.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  U20_CORE_AXE_ROUTES,
  U20_MOTION_CLASSES,
  W11_OS_HUBS,
} from "@/lib/portal-polish";
import {
  PALETTE_ACTIONS,
  OPEN_AI_CHAT_HREF,
  GROUP_LABEL,
  buildNavCommands,
} from "@/lib/nav-commands";
import { MOBILE_CORE_NAV, MOBILE_MORE_LINKS } from "@/components/portal-os/MobileBottomNav";
import { BREADCRUMB_LABELS, buildBreadcrumbs } from "@/lib/breadcrumbs";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W10 shell + design system", () => {
  it("exports FormField, Checkbox, Switch, Sheet, Empty/Error/Query/NoOrg from ui barrel", () => {
    const barrel = src("components/ui/index.ts");
    for (const name of [
      "FormField",
      "Checkbox",
      "Switch",
      "Sheet",
      "EmptyState",
      "ErrorState",
      "QueryState",
      "NoOrgState",
      "FOCUS_RING_CLASS",
    ]) {
      expect(barrel).toContain(name);
    }
  });

  it("defines focus-ring token helpers", () => {
    expect(FOCUS_RING_CLASS).toContain("focus-visible");
    const css = src("app/globals.css");
    expect(css).toContain("--focus-ring");
    expect(css).not.toMatch(/dark\/light toggles/);
  });

  it("wires density into tables and filters", () => {
    expect(src("components/portal-os/InfiniteDataTable.tsx")).toContain("useDensity");
    expect(src("components/portal-os/QueryFilterBar.tsx")).toContain("useDensity");
    expect(src("components/portal-os/VirtualizedList.tsx")).toContain("useDensity");
  });

  it("ships mobile More sheet with Artifacts/Alerts/Evals", () => {
    expect(MOBILE_CORE_NAV).toHaveLength(4);
    expect(MOBILE_MORE_LINKS.map((l) => l.href)).toEqual(
      expect.arrayContaining(["/artifacts", "/alerts", "/evals", "/settings"]),
    );
    expect(src("components/portal-os/MobileBottomNav.tsx")).toContain("SheetContent");
  });

  it("completes breadcrumb labels for Phase 2 hubs", () => {
    for (const key of ["artifacts", "experiments", "playgrounds", "promotions", "evals", "sessions", "ledger", "book"]) {
      expect(BREADCRUMB_LABELS[key]?.label).toBeTruthy();
    }
    expect(buildBreadcrumbs("/artifacts").at(-1)?.label).toBe("Artifacts");
  });

  it("maps breadcrumb categories to sidebar IA groups", () => {
    expect(BREADCRUMB_LABELS.issues?.category).toBe("observe");
    expect(BREADCRUMB_LABELS.issues?.label).toBe("Agent Issues");
    expect(BREADCRUMB_LABELS.improve?.category).toBe("optimize");
    expect(BREADCRUMB_LABELS.ledger?.category).toBe("optimize");
    expect(BREADCRUMB_LABELS.agents?.category).toBe("observe");
    expect(BREADCRUMB_LABELS.artifacts?.category).toBe("optimize");
    expect(BREADCRUMB_LABELS.promotions?.category).toBe("optimize");
    expect(BREADCRUMB_LABELS["debugger-sessions"]?.label).toBe("Debug sessions");
    expect(BREADCRUMB_LABELS.dashboard?.label).toBe("Home");
    expect(BREADCRUMB_LABELS.dashboard?.category).toBeUndefined();
    expect(GROUP_LABEL.build).toBe("Home");
    expect(GROUP_LABEL.observe).toBe("Observe");
    expect(GROUP_LABEL.automate).toBe("Evaluate");
    expect(GROUP_LABEL.optimize).toBe("Improve");
    expect(GROUP_LABEL.workspace).toBe("Workspace");
    expect(src("app/(portal)/portal-chrome.tsx")).toContain("GROUP_LABEL[crumb.category]");
  });

  it("folds Topic clusters into Analytics hub", () => {
    expect(PALETTE_ACTIONS.some((a) => a.href === "/analytics?tab=topics")).toBe(true);
    expect(PALETTE_ACTIONS.every((a) => a.href !== "/insights/topics")).toBe(true);
    expect(src("app/(portal)/analytics/page.tsx")).toMatch(/"topics"/);
    expect(src("app/(portal)/insights/page.tsx")).toContain("/analytics?tab=topics");
    expect(src("../next.config.ts")).toContain(
      'source: "/insights/topics", destination: "/analytics?tab=topics"',
    );
  });

  it("toast supports warning + pause + queue cap", () => {
    const toast = src("components/ui/toast.tsx");
    expect(toast).toContain('"warning"');
    expect(toast).toContain("MAX_QUEUE");
    expect(toast).toContain("onMouseEnter");
    expect(toast).toContain("pauseToast");
  });

  it("keeps AppShell state stubs for Storybook", () => {
    expect(existsSync(resolve(ROOT, "src/components/portal-os/stubs/AppShellStates.tsx"))).toBe(true);
    const stubs = src("components/portal-os/stubs/AppShellStates.tsx");
    expect(stubs).toContain("U18_SHELL_FIXTURES");
    expect(stubs).toContain("AppShellMobileFixture");
  });
});

describe("W11 tables / filters OS", () => {
  it("uses @tanstack/react-virtual in InfiniteDataTable", () => {
    const table = src("components/portal-os/InfiniteDataTable.tsx");
    expect(table).toContain("@tanstack/react-virtual");
    expect(table).toContain("useVirtualizer");
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies["@tanstack/react-virtual"]).toBeTruthy();
  });

  it("ships ResourceOsToolbar on ≥6 hubs", () => {
    expect(W11_OS_HUBS.length).toBeGreaterThanOrEqual(6);
    for (const hub of W11_OS_HUBS) {
      if (hub === "traces") {
        expect(src("app/(portal)/traces/page.tsx")).toContain("QueryFilterBar");
        continue;
      }
      const page = src(`app/(portal)/${hub}/page.tsx`);
      expect(page).toContain("ResourceOsToolbar");
    }
  });

  it("exposes Ask AI in command palette", () => {
    expect(OPEN_AI_CHAT_HREF).toBe("eden:open-ai-chat");
    expect(PALETTE_ACTIONS.some((a) => a.href === OPEN_AI_CHAT_HREF)).toBe(true);
    expect(PALETTE_ACTIONS.some((a) => a.label === "Ask AI")).toBe(true);
    const cmds = buildNavCommands();
    expect(cmds.some((c) => c.href === OPEN_AI_CHAT_HREF)).toBe(true);
    expect(src("components/ui/command-palette.tsx")).toContain("eden:ask-ai");
  });

  it("ships TableExportToolbar + BulkActionBar on Issues/Alerts/Artifacts", () => {
    expect(src("components/portal-os/TableExportToolbar.tsx")).toContain("downloadCsv");
    expect(src("app/(portal)/issues/page.tsx")).toContain("BulkActionBar");
    expect(src("app/(portal)/alerts/page.tsx")).toContain("BulkActionBar");
    expect(src("app/(portal)/artifacts/page.tsx")).toContain("BulkActionBar");
  });

  it("CrossLinkBar appears on ≥10 surfaces", () => {
    const files = [
      "app/(portal)/issues/page.tsx",
      "app/(portal)/alerts/page.tsx",
      "app/(portal)/experiments/page.tsx",
      "app/(portal)/datasets/page.tsx",
      "app/(portal)/promotions/page.tsx",
      "app/(portal)/playgrounds/page.tsx",
      "app/(portal)/improve/page.tsx",
      "app/(portal)/ledger/page.tsx",
      "app/(portal)/sessions/[sessionId]/page.tsx",
      "components/traces/TraceDetailPanel.tsx",
      "components/artifacts/ArtifactDetailPanel.tsx",
    ];
    let count = 0;
    for (const f of files) {
      if (src(f).includes("CrossLinkBar")) count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(10);
  });
});

describe("W12 forms / charts / a11y / mobile", () => {
  it("expands axe routes to evals + improve + alerts", () => {
    expect(U20_CORE_AXE_ROUTES).toEqual([
      "/dashboard",
      "/traces",
      "/issues",
      "/artifacts",
      "/playgrounds",
      "/evals",
      "/improve",
      "/alerts",
    ]);
    const script = readFileSync(resolve(ROOT, "scripts/audit-a11y.cjs"), "utf8");
    for (const route of U20_CORE_AXE_ROUTES) {
      expect(script).toContain(`"${route}"`);
    }
  });

  it("ChartCard exports PNG and CSV", () => {
    const chart = src("components/ui/chart-card.tsx");
    expect(chart).toContain("downloadCsv");
    expect(chart).toContain("downloadPng");
    expect(chart).toContain("csvRows");
  });

  it("DetailPanelShell uses aria-modal; BulkActionBar has safe-area", () => {
    expect(src("components/portal-os/DetailPanelShell.tsx")).toContain("aria-modal");
    expect(src("components/portal-os/BulkActionBar.tsx")).toContain("safe-area-inset-bottom");
  });

  it("keeps U20 motion classes", () => {
    const css = src("app/globals.css");
    for (const cls of U20_MOTION_CLASSES) {
      expect(css).toContain(`.${cls}`);
    }
  });

  it("form kit files exist", () => {
    for (const f of [
      "components/ui/form-field.tsx",
      "components/ui/checkbox.tsx",
      "components/ui/switch.tsx",
      "components/ui/sheet.tsx",
    ]) {
      expect(existsSync(resolve(ROOT, "src", f))).toBe(true);
    }
  });
});
