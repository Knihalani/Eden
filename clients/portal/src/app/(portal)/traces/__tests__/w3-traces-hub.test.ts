/**
 * Wave 3 — Traces hub chrome: toolbar ≤8, columns, live opt-in,
 * facets demoted, shell ≤400, j/k nav, saved views dirty amber.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRACES_PRIMARY_CONTROL_BUDGET,
  FACET_LINKS,
  FACET_VIEWS,
  HUB_VIEWS,
} from "../_components/TracesToolbar";
import {
  TRACES_CORE_COLUMNS,
  TRACES_DEFAULT_VISIBLE_OPTIONAL,
  TRACES_OPTIONAL_COLUMNS,
  TRACES_STATUS_COL_PX,
} from "../../observability/_components/TracesTab";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function loc(rel: string): number {
  return read(rel).split("\n").length;
}

describe("W3 traces hub — Laminar-class chrome", () => {
  it("3.1 TracesToolbar: Tabs + filters + Views + Overflow ≤8", () => {
    expect(TRACES_PRIMARY_CONTROL_BUDGET).toBeLessThanOrEqual(8);
    expect([...HUB_VIEWS]).toEqual(["traces", "spans", "sessions"]);
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    const markers = [...toolbar.matchAll(/data-primary-control="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(markers).toEqual(
      expect.arrayContaining(["hub-tabs", "filters", "views", "overflow", "display"]),
    );
    expect(markers.length).toBeLessThanOrEqual(TRACES_PRIMARY_CONTROL_BUDGET);
    expect(toolbar).toContain('data-testid="traces-overflow"');
    expect(toolbar).toContain("LEGACY_TOOL_LINKS");
  });

  it("3.2 QueryFilterBar defaults Basic; Advanced drawer for query/alert", () => {
    const qBar = read("components/portal-os/QueryFilterBar.tsx");
    expect(qBar).toContain('data-testid="query-filter-advanced-trigger"');
    expect(qBar).toContain('data-testid="query-filter-advanced-panel"');
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    // Facets are NOT in QueryFilterBar advancedSelects (Wave 3 demotion)
    expect(toolbar).not.toContain("advancedSelects");
    expect(toolbar).toContain('key: "realm"');
    expect(toolbar).toContain('key: "outcome"');
    // ≤3 first-paint selects
    const selectKeys = [...toolbar.matchAll(/key: "(realm|outcome|agent_id)"/g)];
    expect(selectKeys.length).toBeLessThanOrEqual(3);
  });

  it("3.3 Column defaults: Status 40 · id · type · time · duration · cost · tokens", () => {
    expect(TRACES_STATUS_COL_PX).toBe(40);
    expect([...TRACES_CORE_COLUMNS]).toEqual([
      "status",
      "id",
      "type",
      "time",
      "duration",
      "cost",
      "tokens",
    ]);
    const tab = read("app/(portal)/observability/_components/TracesTab.tsx");
    expect(tab).toContain("w-10 max-w-10");
    expect(tab).toContain('data-testid="trace-status-strip"');
    expect(tab).toContain('header: "Id"');
    expect(tab).toContain('header: "Type"');
    expect(tab).toContain('header: "Time"');
    expect(tab).toContain('header: "Duration"');
    expect(tab).toContain('header: "Cost"');
    expect(tab).toContain('header: "Tokens"');
    expect(TRACES_DEFAULT_VISIBLE_OPTIONAL).toEqual([]);
    expect(TRACES_OPTIONAL_COLUMNS.map((c) => c.id)).toEqual([
      "agent",
      "spans",
      "input",
      "output",
      "streaming_metrics",
      "actions",
    ]);
  });

  it("3.4 SpansTab: hideable columns + compact density + status strip", () => {
    const spans = read("components/traces/SpansTab.tsx");
    expect(spans).toContain("SPANS_OPTIONAL_COLUMNS");
    expect(spans).toContain('data-testid="spans-columns-menu"');
    expect(spans).toContain('data-density={density === "comfortable" ? "compact" : density}');
    expect(spans).toContain('data-testid="span-status-strip"');
    expect(spans).toContain("w-10 max-w-10");
  });

  it("3.5 SessionsTab: Laminar expand-in-place", () => {
    const sessions = read("components/traces/SessionsTab.tsx");
    expect(sessions).toContain('data-testid="session-expand-panel"');
    expect(sessions).toContain("onSelectTrace");
    expect(sessions).toContain("setExpandedId");
    expect(sessions).toContain("SessionTurnTimeline");
  });

  it("3.6 Live mode is opt-in only (?live=1), not default chrome", () => {
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    expect(hook).toContain('searchParams.get("live") === "1"');
    expect(toolbar).toContain("Turn on live tail");
    expect(toolbar).not.toMatch(/variant=\{liveOn \? "default"/);
    expect(toolbar).toContain('data-testid="traces-live-toggle"');
    expect(toolbar).toContain('data-primary-control="display"');
    // Live lives under Display — not always-on primary
    expect(toolbar).toContain("DropdownMenuLabel>Live");
    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    expect(list).toMatch(/liveOn && currentOrg/);
  });

  it("3.7 Saved views: dirty amber + named shareable", () => {
    const views = read("components/portal-os/ViewsMenu.tsx");
    expect(views).toContain('data-testid="views-share-checkbox"');
    expect(views).toContain("Share with project");
    const trigger = read("components/portal-os/QueryFilterBar.tsx");
    expect(trigger).toContain("Unsaved");
    expect(trigger).toContain("border-[var(--warning)]");
    const page = read("app/(portal)/traces/page.tsx");
    expect(page).toContain("is_shared: isShared");
    expect(page).toContain("filterDirty");
  });

  it("3.8 Facets demoted to Overflow / deep-link only", () => {
    expect([...FACET_VIEWS]).toEqual(["mcp", "decisions", "memory", "retrieval"]);
    expect(FACET_LINKS.every((l) => l.href.startsWith("/traces?facet="))).toBe(
      true,
    );
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    expect(toolbar).toContain("FACET_LINKS");
    expect(toolbar).toContain("DropdownMenuLabel>Facets");
    expect(toolbar).toContain('data-testid={`facet-link-${item.facet}`}');
    expect(toolbar).not.toContain("advancedSelects");
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(hook).toContain('searchParams.get("facet")');
  });

  it("3.9 page.tsx shell ≤400 LOC after split", () => {
    expect(loc("app/(portal)/traces/page.tsx")).toBeLessThanOrEqual(400);
    expect(read("app/(portal)/traces/page.tsx")).toContain("useTracesHub");
    expect(read("app/(portal)/traces/page.tsx")).toContain("TracesHubList");
    expect(read("app/(portal)/traces/page.tsx")).toContain("traces-hub-dynamics");
  });

  it("3.10 Critic: j/k list nav + ≤2-click failure path + Wave 2 stack intact", () => {
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(hook).toContain("useListKeyboardNav");
    expect(hook).toContain("hubView === \"traces\"");
    const nav = read("hooks/use-list-keyboard-nav.ts");
    expect(nav).toContain("j:");
    expect(nav).toContain("k:");

    // Failure → cause ≤2 clicks: row select opens transcript-first fullscreen modal
    const page = read("app/(portal)/traces/page.tsx");
    expect(page).toContain("TraceViewerModal");
    expect(page).toContain("TraceDetailPanel");
    expect(page).toContain('initialMode={hub.detailMode}');
    expect(page).toContain('layout="fullscreen"');
    expect(hook).toContain(': "transcript"');

    // Wave 2 transcript stack preserved
    const detail = read("components/traces/TraceDetailPanel.tsx");
    expect(detail).toContain("VirtualizedTranscript");
    expect(detail).toContain('initialMode = "transcript"');
  });
});
