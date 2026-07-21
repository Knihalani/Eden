/**
 * Wave 12 — Portal PERFORMANCE regression locks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W12 chrome lazy islands", () => {
  it("portal-chrome keeps CommandPalette / ChatSidebar / OnboardingOverlay dynamic", () => {
    const src = read("app/(portal)/portal-chrome.tsx");
    const aiRail = read("components/portal-chrome/AiRailHost.tsx");
    const sidebar = read("components/portal-chrome/SidebarNav.tsx");
    expect(src).toMatch(/const CommandPalette = dynamic\(/);
    expect(aiRail).toMatch(/dynamic\(/);
    expect(aiRail).toMatch(/ChatSidebar/);
    expect(src).toMatch(/const OnboardingOverlay = dynamic\(/);
    expect(src).toMatch(/const OnboardingBanner = dynamic\(/);
    expect(sidebar).toMatch(/const BudgetTicker = dynamic\(/);
    expect(src).not.toMatch(
      /import\s+\{\s*ChatSidebar\s*\}\s+from\s+["']@\/components\/ai-insights\/ChatSidebar["']/,
    );
    expect(src).not.toMatch(
      /import\s+\{\s*CommandPalette\s*\}\s+from\s+["']@\/components\/portal-os\/CommandPalette["']/,
    );
    expect(src).not.toMatch(
      /import\s+\{\s*OnboardingOverlay\s*\}\s+from\s+["']@\/components\/onboarding\/OnboardingOverlay["']/,
    );
    expect(src).not.toMatch(
      /import\s+\{\s*OnboardingBanner\s*\}\s+from\s+["']@\/components\/onboarding-banner["']/,
    );
    expect(src).not.toMatch(
      /import\s+\{\s*BudgetTicker\s*\}\s+from\s+["']@\/components\/budget-ticker["']/,
    );
  });
});

describe("W12 bundle hotspots", () => {
  it("traces hub dynamic-imports LiveTail / export / annotate", () => {
    // Wave 3 shell: dynamics live in traces-hub-dynamics, re-exported into page
    const dynamics = read("app/(portal)/traces/_components/traces-hub-dynamics.tsx");
    const page = read("app/(portal)/traces/page.tsx");
    expect(dynamics).toMatch(/export const LiveTailPanel = dynamic\(/);
    expect(dynamics).toMatch(/export const TraceExportModal = dynamic\(/);
    expect(dynamics).toMatch(/export const AnnotateTraceDialog = dynamic\(/);
    expect(page).toContain("TraceExportModal");
    expect(page).toContain("AnnotateTraceDialog");
    expect(page).not.toMatch(
      /import\s+\{\s*LiveTailPanel\s*\}\s+from\s+["']\.\/_components\/LiveTailPanel["']/,
    );
  });

  it("session detail dynamic-imports TraceDetailPanel + BrowserReplayPanel", () => {
    const src = read("app/(portal)/sessions/[sessionId]/page.tsx");
    expect(src).toMatch(/const TraceDetailPanel = dynamic\(/);
    expect(src).toMatch(/const BrowserReplayPanel = dynamic\(/);
    expect(src).not.toMatch(
      /import\s+\{\s*BrowserReplayPanel\s*\}\s+from\s+["']@\/components\/browser\/BrowserReplayPanel["']/,
    );
  });

  it("TraceDetailPanel dynamic-imports ScoresTab + LatencyHistogram", () => {
    const src = read("components/traces/TraceDetailPanel.tsx");
    expect(src).toMatch(/const ScoresTab = dynamic\(/);
    expect(src).toMatch(/const LatencyHistogram = dynamic\(/);
  });

  it("rrweb stays iframe-UMD (not parent import)", () => {
    const panel = read("components/browser/BrowserReplayPanel.tsx");
    expect(panel).not.toMatch(/import\(["']rrweb-player["']\)/);
    expect(panel).toContain("/api/rrweb-player/");
  });
});

describe("W12 virtualization + table perf", () => {
  it("hub long lists still use InfiniteDataTable / VirtualizedTranscript", () => {
    expect(read("app/(portal)/observability/_components/TracesTab.tsx")).toContain(
      "InfiniteDataTable",
    );
    expect(read("components/traces/SpansTab.tsx")).toContain("InfiniteDataTable");
    expect(read("components/traces/SessionsTab.tsx")).toContain("InfiniteDataTable");
    expect(read("components/traces/TraceDetailPanel.tsx")).toContain(
      "VirtualizedTranscript",
    );
    expect(read("components/portal-os/InfiniteDataTable.tsx")).toContain(
      "@tanstack/react-virtual",
    );
  });

  it("TracesTab memoizes columns; DataTable sort keys off columnKeySig", () => {
    const tab = read("app/(portal)/observability/_components/TracesTab.tsx");
    expect(tab).toMatch(/const columns: DataTableColumn<TraceItem>\[\] = useMemo\(/);
    const table = read("components/ui/data-table.tsx");
    expect(table).toContain("columnKeySig");
  });
});

describe("W12 URL state churn", () => {
  it("useResourceUrlState skips identical QS navigations", () => {
    const src = read("components/portal-os/useResourceUrlState.ts");
    expect(src).toContain("if (qs === searchParams.toString()) return");
  });
});

describe("W12 loading waterfall leftovers", () => {
  it("fleet loading uses skeleton, not page re-export", () => {
    const src = read("app/(portal)/fleet/loading.tsx");
    expect(src).toContain("LoadingSkeleton");
    expect(src).not.toMatch(/import FleetPage from ["']\.\/page["']/);
  });

  it("settings status tab has loading skeleton route", () => {
    const src = read("app/(portal)/settings/(tabs)/status/loading.tsx");
    expect(src).toContain("LoadingSkeleton");
    expect(src).toContain('variant="stats"');
  });
});

describe("W12 analytics embed quiet + lazy", () => {
  it("Users/Tools/Insights/Topics soft-redirect into Analytics modes", () => {
    for (const [rel, tab] of [
      ["app/(portal)/users/page.tsx", "users"],
      ["app/(portal)/tools/page.tsx", "tools"],
      ["app/(portal)/insights/page.tsx", "insights"],
      ["app/(portal)/insights/topics/page.tsx", "topics"],
    ] as const) {
      const src = read(rel);
      expect(src).toContain(`router.replace("/analytics?tab=${tab}")`);
      expect(src).not.toContain("useEmbeddedSurface");
      expect(src).not.toContain("PageHeader");
    }
  });

  it("analytics mounts thin panels for active tabs only (no EmbeddedSurface)", () => {
    const src = read("app/(portal)/analytics/page.tsx");
    expect(src).toContain('{tab === "insights" ? <InsightsPanel />');
    expect(src).toContain('{tab === "topics" ? <TopicsPanel />');
    expect(src).toContain('{tab === "tools" ? <ToolsPanel />');
    expect(src).toContain('{tab === "users" ? <UsersPanel />');
    expect(src).not.toContain("EmbeddedSurface");
    expect(src).toMatch(/const OverviewCharts = dynamic\(/);
  });
});

describe("W12 image/font", () => {
  it("root layout Geist fonts use display swap", () => {
    const src = read("app/layout.tsx");
    expect(src).toContain('display: "swap"');
    expect(src).toContain("Geist");
    expect(src).toContain("Geist_Mono");
  });
});
