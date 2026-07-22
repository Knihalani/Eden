/**
 * Wave 4 — Traces hub: ≤8 first-paint controls, transcript-first,
 * progressive filters, live opt-in, sessions expand-in-place.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRACES_PRIMARY_CONTROL_BUDGET,
  countTracesPrimaryControls,
} from "../_components/TracesToolbar";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W4 traces hub — Laminar-class triage", () => {
  it("keeps first-paint primary control budget ≤8", () => {
    expect(TRACES_PRIMARY_CONTROL_BUDGET).toBeLessThanOrEqual(8);
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    const markers = [...toolbar.matchAll(/data-primary-control="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(markers).toEqual(
      expect.arrayContaining(["hub-tabs", "filters", "views", "overflow", "display"]),
    );
    const qBar = read("components/portal-os/QueryFilterBar.tsx");
    expect(qBar).toContain('data-primary-control="advanced"');
    // Toolbar markers (5) + Advanced in QFB (1) = 6 ≤ 8
    expect(markers.length + 1).toBeLessThanOrEqual(TRACES_PRIMARY_CONTROL_BUDGET);
    expect(countTracesPrimaryControls).toBeTypeOf("function");
  });

  it("toolbar is Tabs + filters + Views + Display + Overflow; Live not primary", () => {
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    expect(toolbar).toContain("TracesToolbar");
    expect(toolbar).toContain('data-testid="traces-toolbar"');
    expect(toolbar).toContain('data-testid="traces-overflow"');
    expect(toolbar).toContain('data-testid="traces-display"');
    expect(toolbar).toContain('data-testid="traces-live-toggle"');
    expect(toolbar).toContain("Turn on live tail");
    expect(toolbar).toContain('data-testid="traces-refresh"');
    // Live is Display submenu — not a solid primary Button in the band
    expect(toolbar).not.toMatch(/variant=\{liveOn \? "default"/);
    expect(toolbar).toContain("LEGACY_TOOL_LINKS");
    expect(toolbar).toContain("FACET_LINKS");
    expect(toolbar).not.toContain("advancedSelects");

    const page = read("app/(portal)/traces/page.tsx");
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(page).toContain("TracesToolbar");
    expect(hook).toContain('searchParams.get("live") === "1"');
    expect(page).not.toContain("SpanSearchBar");
  });

  it("QueryFilterBar defaults to Basic with Advanced drawer", () => {
    const qBar = read("components/portal-os/QueryFilterBar.tsx");
    expect(qBar).toContain('data-testid="query-filter-advanced-trigger"');
    expect(qBar).toContain('data-testid="query-filter-advanced-panel"');
    expect(qBar).toContain("advancedSelects");
    expect(qBar).toContain("Create alert from filters");
    // Mode toggle (Query language) is inside the Advanced panel region
    const panelIdx = qBar.indexOf('data-testid="query-filter-advanced-panel"');
    const modeToggleIdx = qBar.indexOf('{m === "query" ? "Query language" : "Basic"}');
    expect(panelIdx).toBeGreaterThan(-1);
    expect(modeToggleIdx).toBeGreaterThan(panelIdx);
  });

  it("detail defaults to Transcript; metrics in top bar; actions in overflow", () => {
    const types = read("components/trace-viewer/types.ts");
    const viewer = read("components/trace-viewer/TraceViewer.tsx");
    const topbar = read("components/trace-viewer/UnifiedTopBar.tsx");
    const canvas = read("components/trace-viewer/canvases/TranscriptCanvas.tsx");
    expect(types).toContain('{ id: "transcript", label: "Transcript" }');
    expect(viewer).toContain('initialMode = "transcript"');
    expect(viewer).toContain("UnifiedTopBar");
    expect(topbar).toContain('data-testid="trace-actions-overflow"');
    expect(canvas).toContain("VirtualTranscript");
    expect(viewer).not.toContain("<CrossLinkBar");
    expect(topbar).toContain('data-testid="trace-header-metrics"');

    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(hook).toContain('export const DETAIL_MODES = [');
    expect(hook).toContain('"transcript"');
    expect(hook).toMatch(/: "transcript"/);
  });

  it("TranscriptView collapses subagents and uses semantic span colors", () => {
    const row = read("components/transcript-v2/TranscriptRowItem.tsx");
    expect(row).toContain("SubagentGroup");
    expect(row).toContain("SpanKindPill");
    expect(row).toContain("classifySpanKind");
    expect(row).not.toContain("var(--accent-purple)");
    expect(row).toContain('data-testid="span-inline-preview"');

    const pill = read("components/transcript-v2/SpanTypeIcon.tsx");
    expect(pill).toContain('data-testid="span-kind-pill"');

    const kind = read("components/transcript-v2/span-kind.ts");
    expect(kind).toContain('return "var(--accent)"');
    expect(kind).toContain('return "var(--warning)"');
    expect(kind).toContain('return "var(--info)"');
  });

  it("ViewsMenu shows Unsaved amber and shareable names", () => {
    const trigger = read("components/portal-os/QueryFilterBar.tsx");
    expect(trigger).toContain('data-testid="views-menu-trigger"');
    expect(trigger).toContain("Unsaved");
    expect(trigger).toContain("border-[var(--warning)]");

    const views = read("components/portal-os/ViewsMenu.tsx");
    expect(views).toContain('data-testid="views-share-checkbox"');
    expect(views).toContain("Share with project");
    expect(views).toContain("onSave(saveName.trim(), shareWithProject)");

    const page = read("app/(portal)/traces/page.tsx");
    expect(page).toContain("is_shared: isShared");
  });

  it("Sessions expand-in-place; Spans hideable columns + compact density", () => {
    const sessions = read("components/traces/SessionsTab.tsx");
    expect(sessions).toContain('data-testid="session-expand-panel"');
    expect(sessions).toContain("onSelectTrace");
    expect(sessions).toContain("setExpandedId");
    expect(sessions).toContain("SessionTurnTimeline");
    expect(sessions).toContain('layout="stack"');

    const spans = read("components/traces/SpansTab.tsx");
    expect(spans).toContain("SPANS_OPTIONAL_COLUMNS");
    expect(spans).toContain('data-testid="spans-columns-menu"');
    expect(spans).toContain('data-density={density === "comfortable" ? "compact" : density}');
    expect(spans).toContain("visibleOptional");
  });

  it("page stays under 400 LOC after Wave 3 shell split", () => {
    const page = read("app/(portal)/traces/page.tsx");
    const loc = page.split("\n").length;
    expect(loc).toBeLessThanOrEqual(400);
    expect(page).toContain('from "./_components/TracesToolbar"');
    expect(page).toContain("TraceViewer");
    expect(page).not.toContain("TraceViewerModal");
    expect(page).toContain("useTracesHub");
  });

  it("Wave 2: Display first-class + pastHours→days query + spanId writers", () => {
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    const page = read("app/(portal)/traces/page.tsx");
    const cross = read("lib/portal-cross-links.ts");
    const triage = read("app/(portal)/issues/_components/issue-triage-panel.tsx");
    const core = read("components/portal-os/CoreResourcePage.tsx");

    // Display owns columns / density / LIVE / time range
    expect(toolbar).toContain('data-primary-control="display"');
    expect(toolbar).toContain('data-testid="traces-display"');
    expect(toolbar).toContain("TRACES_TIME_RANGE_OPTIONS");
    expect(toolbar).toContain("setDensity");
    expect(toolbar).toContain("Turn on live tail");
    expect(toolbar).not.toMatch(/data-primary-control="live"/);
    const markers = [...toolbar.matchAll(/data-primary-control="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(markers.length).toBeLessThanOrEqual(TRACES_PRIMARY_CONTROL_BUDGET);

    // pastHours URL → list days (no hardcoded days: 7)
    expect(hook).toContain('urlState.pastHours ?? "168"');
    expect(hook).toContain("Math.ceil((Number(pastHours) || 168) / 24)");
    expect(hook).toContain("days: listDays");
    expect(hook).not.toMatch(/days:\s*7\b/);
    expect(page).toContain("pastHours={hub.pastHours}");
    expect(page).toContain("onPastHoursChange={hub.setPastHours}");

    // Canonical span writer + legacy span alias-read
    expect(cross).toContain("opts?: { spanId?: string }");
    expect(triage).toContain("traceHref(tid, preserve, { spanId: span })");
    expect(core).toMatch(/spanId:[\s\S]*"span"/);
  });
});
