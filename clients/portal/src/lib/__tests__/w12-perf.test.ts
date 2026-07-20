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
    expect(src).toMatch(/const CommandPalette = dynamic\(/);
    expect(src).toMatch(/const ChatSidebar = dynamic\(/);
    expect(src).toMatch(/const OnboardingOverlay = dynamic\(/);
    expect(src).toMatch(/const OnboardingBanner = dynamic\(/);
    expect(src).toMatch(/const BudgetTicker = dynamic\(/);
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
    const src = read("app/(portal)/traces/page.tsx");
    expect(src).toMatch(/const LiveTailPanel = dynamic\(/);
    expect(src).toMatch(/const TraceExportModal = dynamic\(/);
    expect(src).toMatch(/const AnnotateTraceDialog = dynamic\(/);
    expect(src).not.toMatch(
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
  it("Users/Tools/Insights/Topics suppress PageHeader + use pills when embedded", () => {
    for (const rel of [
      "app/(portal)/users/page.tsx",
      "app/(portal)/tools/page.tsx",
      "app/(portal)/insights/page.tsx",
      "app/(portal)/insights/topics/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toContain("useEmbeddedSurface");
      expect(src).toContain("!embedded");
      expect(src).toMatch(/variant=\{embedded \? "pills"/);
    }
  });

  it("analytics only mounts active embed children", () => {
    const src = read("app/(portal)/analytics/page.tsx");
    expect(src).toContain('{tab === "insights" ? (');
    expect(src).toContain('{tab === "topics" ? (');
    expect(src).toContain('{tab === "tools" ? (');
    expect(src).toContain('{tab === "users" ? (');
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
