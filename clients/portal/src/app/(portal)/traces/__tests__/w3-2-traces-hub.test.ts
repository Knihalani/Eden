/**
 * W3-2 — Traces hub: filters / empty vs error / deep links / list 200 honesty.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { clearedFilters } from "@/components/ui/filter-bar";
import {
  deriveTracesListUi,
  filtersFromSearchParams,
} from "../traces-list-ui";
import {
  TRACES_BUILTIN_VIEW_PRESETS,
  resolveTracesBuiltinView,
  isTracesUnreviewedSoftView,
} from "../_components/trace-builtin-views";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W3-2 traces hub list UI gate", () => {
  it("hydrates agent_id / outcome / realm from URL search params", () => {
    const sp = new URLSearchParams(
      "agent_id=a1&outcome=failure&realm=production",
    );
    expect(filtersFromSearchParams(sp)).toEqual({
      realm: "production",
      outcome: "failure",
      agent_id: "a1",
    });
    expect(filtersFromSearchParams(new URLSearchParams())).toEqual({
      realm: "",
      outcome: "",
      agent_id: "",
    });
  });

  it("Clear resets filter-only keys like agent_id, not just select keys", () => {
    expect(
      clearedFilters(
        { realm: "production", outcome: "failure", agent_id: "bot-1" },
        ["realm", "outcome"],
      ),
    ).toEqual({
      realm: "",
      outcome: "",
      agent_id: "",
    });
    // agent_id alone (deep-link chip, no select) must still clear.
    expect(clearedFilters({ agent_id: "bot-1" }, ["realm", "outcome"])).toEqual({
      agent_id: "",
      realm: "",
      outcome: "",
    });
  });

  it("FilterBar Clear and QueryFilterBar draft sync wire agent_id + query", () => {
    const filterBar = read("components/ui/filter-bar.tsx");
    expect(filterBar).toContain("export function clearedFilters");
    expect(filterBar).toContain("clearedFilters(filters");

    const qBar = read("components/portal-os/QueryFilterBar.tsx");
    expect(qBar).toContain("setQueryDraft(query)");
    expect(qBar).toMatch(/useEffect\(\(\)\s*=>\s*\{\s*setQueryDraft\(query\);/);
    expect(qBar).toContain("clearedFilters");

    const page = read("app/(portal)/traces/page.tsx");
    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    expect(page).toContain("agent_id: next.agent_id");
    expect(list).toContain('applyListFilters({ realm: "", outcome: "", agent_id: "" })');
  });

  it("does not show empty while loading or on error", () => {
    expect(
      deriveTracesListUi({
        isLoading: true,
        isFetched: false,
        isError: false,
        accumulatedCount: 0,
        filterDirty: false,
      }),
    ).toMatchObject({
      loading: true,
      showError: false,
      showFirstRunEmpty: false,
      showFilteredEmpty: false,
    });
    expect(
      deriveTracesListUi({
        isLoading: false,
        isFetched: true,
        isError: true,
        accumulatedCount: 0,
        filterDirty: false,
      }),
    ).toMatchObject({
      showError: true,
      showFirstRunEmpty: false,
      showFilteredEmpty: false,
    });
  });

  it("treats HTTP 200 empty list as first-run empty only without filters", () => {
    expect(
      deriveTracesListUi({
        isLoading: false,
        isFetched: true,
        isError: false,
        accumulatedCount: 0,
        filterDirty: false,
      }),
    ).toMatchObject({
      showFirstRunEmpty: true,
      showFilteredEmpty: false,
    });
    expect(
      deriveTracesListUi({
        isLoading: false,
        isFetched: true,
        isError: false,
        accumulatedCount: 0,
        filterDirty: true,
      }),
    ).toMatchObject({
      showFirstRunEmpty: false,
      showFilteredEmpty: true,
    });
  });

  it("page wires ErrorState, filtered empty, and URL filter sync", () => {
    const src = read("app/(portal)/traces/page.tsx");
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    const dynamics = read("app/(portal)/traces/_components/traces-hub-dynamics.tsx");
    expect(list).toContain('from "@/components/ui/error-state"');
    expect(list).toContain("Could not load traces");
    expect(list).toContain("Try again");
    expect(list).toContain("showFirstRunEmpty");
    expect(list).toContain("showFilteredEmpty");
    expect(list).toContain('title="No traces match"');
    expect(hook).toContain("filtersFromSearchParams");
    expect(hook).toContain("writeFilterParams");
    expect(hook).toContain('params.set("agent_id"');
    expect(hook).toContain('from "../traces-list-ui"');
    // Wave-2 hydration: hub tabs / detail are dynamic() like legacy views.
    expect(dynamics).toMatch(/import\(["']@\/components\/traces\/SpansTab["']/);
    expect(dynamics).toMatch(/import\(["']@\/components\/traces\/SessionsTab["']/);
    expect(dynamics).toMatch(/import\(["']@\/components\/trace-viewer["']/);
    // Orgless gate from Wave 2 must remain ahead of first-run empty.
    const noOrgIdx = src.indexOf("if (!hub.currentOrg && !hub.authError)");
    const emptyIdx = list.indexOf("<WaitingForFirstEvent");
    expect(list).toContain("WaitingForFirstEvent");
    expect(hook).toContain("FIRST_EVENT_WAIT");
    expect(hook).toContain("first_trace_at");
    expect(noOrgIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(-1);
    expect(src).toMatch(/hub\.orgLoading\s*&&\s*!hub\.currentOrg/);
    // authError must not blank-page — show ErrorState instead of return null.
    expect(src).toContain('title="Could not load workspace"');
    expect(src).toContain("hub.authError");
    expect(src).not.toMatch(/if\s*\(\s*!hub\.currentOrg\s*\)\s*return\s+null/);
  });

  it("first-run empty polls and offers doctor + check CTA", () => {
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    expect(hook).toContain("refetchInterval");
    expect(hook).toContain("FIRST_EVENT_WAIT.pollMs");
    expect(hook).toContain("onboardingV2Api.getState");
    expect(list).toContain('data-testid="traces-first-run-hint"');
    // Dual-poll collapse: tracesQuery owns interval; firstTraceSignal does not.
    expect(hook).toContain("refetchInterval: false");
    expect(hook).not.toContain(
      "refetchInterval: showFirstRunEmpty ? FIRST_EVENT_WAIT.pollMs : false",
    );

    const wait = read("components/onboarding/WaitingForFirstEvent.tsx");
    expect(wait).toContain("FIRST_EVENT_WAIT.title");
    expect(wait).toContain("FIRST_EVENT_WAIT.doctorNpx");
    expect(wait).toContain("FIRST_EVENT_WAIT.doctorPython");
    expect(wait).toContain("FIRST_EVENT_WAIT.checkCta");

    const polish = read("lib/portal-polish.ts");
    expect(polish).toContain('title: "Waiting for first event"');
    expect(polish).toContain('doctorNpx: "npx eden-doctor"');
    expect(polish).toContain('doctorPython: "python -m eden_sdk.doctor"');
    expect(polish).toContain('checkCta: "Check for events"');
  });

  it("deep-link helpers and resource URL state accept trace aliases", () => {
    const urlState = read("components/portal-os/useResourceUrlState.ts");
    expect(urlState).toContain("readMasterDetailParam");
    expect(urlState).toContain('readMasterDetailParam(searchParams, "traceId")');
    expect(urlState).toContain("writeMasterDetailParam");

    const core = read("components/portal-os/CoreResourcePage.tsx");
    expect(core).toContain("MASTER_DETAIL_QUERY_KEYS");
    expect(core).toMatch(/traceId:[\s\S]*"traceId"[\s\S]*"trace_id"[\s\S]*"trace"/);
    expect(core).toMatch(/spanId:[\s\S]*"spanId"[\s\S]*"span_id"[\s\S]*"span"/);

    const data = read("components/trace-viewer/use-trace-viewer-data.ts");
    const viewer = read("components/trace-viewer/TraceViewer.tsx");
    expect(data).toContain("Trace not found");
    expect(viewer).toContain('from "@/components/ui/error-state"');

    const cross = read("lib/portal-cross-links.ts");
    expect(cross).toMatch(/tracesFilteredHref[\s\S]*agent_id/);
    expect(cross).toContain("opts?: { spanId?: string }");

    const triage = read("app/(portal)/issues/_components/issue-triage-panel.tsx");
    expect(triage).toContain("traceHref(tid, preserve, { spanId: span })");
    expect(triage).not.toMatch(/\/traces\/\$\{tid\}\?span=/);
  });

  it("spans and sessions tabs gate empty behind ErrorState", () => {
    const spans = read("components/traces/SpansTab.tsx");
    expect(spans).toContain("Could not load spans");
    expect(spans).toContain("listError");
    expect(spans).toContain('from "@/components/ui/error-state"');

    const sessions = read("components/traces/SessionsTab.tsx");
    expect(sessions).toContain("Could not load sessions");
    expect(sessions).toContain("listError");
    expect(sessions).toContain('from "@/components/ui/error-state"');
  });

  it("UX-P0-01 chrome is Identity + one toolbar band (no facet strip)", () => {
    const src = read("app/(portal)/traces/page.tsx");
    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    // Identity
    expect(src).toContain('eyebrow="Observe"');
    expect(src).toContain('title="Traces"');
    expect(toolbar).toContain('data-chrome-band="toolbar"');
    expect(toolbar).toContain('data-testid="traces-toolbar"');
    expect(src).toContain("ResourcePageShell");
    // Hub tabs only — legacy tools not tab siblings
    expect(toolbar).toContain('export const HUB_VIEWS = ["traces", "spans", "sessions"]');
    expect(toolbar).toContain("LEGACY_TOOL_LINKS");
    expect(toolbar).toContain("More");
    expect(src).not.toMatch(/<TabsTrigger[^>]*value="inspect"/);
    // Facets are Overflow / deep-link only (`?facet=`) — never a third band
    expect(src).not.toContain('aria-label="Observability facets"');
    expect(hook).toContain('searchParams.get("facet")');
    expect(toolbar).toContain("FACET_LINKS");
    expect(toolbar).toContain("DropdownMenuLabel>Facets");
    expect(toolbar).not.toContain("advancedSelects");
    // Live + Refresh: Live under Display; Refresh stays in More
    expect(hook).toContain('searchParams.get("live") === "1"');
    expect(list).toContain("LiveTailPanel");
    expect(list).toMatch(/liveOn && currentOrg/);
    expect(src).toContain("TracesToolbar");
    expect(toolbar).toContain('data-testid="traces-live-toggle"');
    expect(toolbar).toContain('data-testid="traces-refresh"');
    expect(toolbar).toContain('data-primary-control="display"');
    // Master–detail stays on hub via fullscreen modal
    expect(src).toContain("TraceViewer");
    expect(src).not.toContain("TraceViewerModal");
    expect(src).toContain("traceId");
    // Display is first-class (columns / density / LIVE / range) — not buried only in More
    expect(toolbar).toContain("TRACES_OPTIONAL_COLUMNS");
    expect(src).toContain("writeVisibleColumns");
    expect(toolbar).toContain('data-testid="traces-display"');
    expect(toolbar).toContain("DropdownMenuLabel>Columns");
  });

  it("UX-P0-10 wires ViewsMenu dirty + Save changes + Discard", () => {
    const src = read("app/(portal)/traces/page.tsx");
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(hook).toContain("isViewDirty");
    expect(src).toContain("filterDirty={hub.filterDirty}");
    expect(src).toContain("onSaveChanges");
    expect(src).toContain("currentViewState");
    expect(src).toContain("visibleColumns");
    expect(hook).toContain("tableSort");
    expect(src).toMatch(/await hub\.update\(\{[\s\S]*viewId: hub\.savedViewId/);
    expect(src).toContain("onDiscardView");
    expect(src).toMatch(/hub\.applyView\(hub\.savedViewId\)/);
  });

  it("Wave 6: TracesTab has no sibling filter Card (hub owns filters)", () => {
    const tab = read("app/(portal)/observability/_components/TracesTab.tsx");
    expect(tab).not.toContain("All Realms");
    expect(tab).not.toContain("Filter by realm");
    expect(tab).not.toContain("Create alert from filters");
    expect(tab).toContain("visibleColumns");
    expect(tab).toContain("InfiniteDataTable");
    expect(tab).toContain("selectable");
    expect(tab).toContain("onSortChange");
    expect(tab).toContain('data-testid="traces-table"');
  });

  it("Wave 6: ResourcePageShell hard-codes page-bands ≤2", () => {
    const shell = read("components/portal-os/ResourcePageShell.tsx");
    expect(shell).toContain('data-page-bands={pageBands}');
    expect(shell).toContain('const pageBands = toolbar ? "2" : "1"');
    expect(shell).toContain('data-chrome-band="identity"');
    expect(shell).toContain('data-chrome-band="toolbar"');
    // KPI must not bump to 3
    expect(shell).toContain('data-chrome-band="kpi"');
    expect(shell).not.toMatch(/pageBands\s*=\s*"3"/);
  });

  it("Wave 6: spans/sessions share InfiniteDataTable hub grammar", () => {
    const spans = read("components/traces/SpansTab.tsx");
    expect(spans).toContain("InfiniteDataTable");
    expect(spans).toContain("selectable");
    expect(spans).not.toContain("Create alert from filters");
    expect(spans).not.toContain("text-[11px]");

    const sessions = read("components/traces/SessionsTab.tsx");
    expect(sessions).toContain("InfiniteDataTable");
    expect(sessions).toContain("selectable");
    expect(sessions).toContain("outcome?:");
    // No local outcome chrome strip — hub QueryFilterBar owns it
    expect(sessions).not.toContain('(["all", "success", "failure", "open"]');
  });

  it("Wave 6: transcript modes live in detail tabs; default Transcript", () => {
    const types = read("components/trace-viewer/types.ts");
    const viewer = read("components/trace-viewer/TraceViewer.tsx");
    const topbar = read("components/trace-viewer/UnifiedTopBar.tsx");
    const canvas = read("components/trace-viewer/canvases/TranscriptCanvas.tsx");
    const data = read("components/trace-viewer/use-trace-viewer-data.ts");
    expect(types).toContain('{ id: "transcript", label: "Transcript" }');
    expect(types).toContain("tree");
    expect(types).toContain('{ id: "timeline", label: "Timeline" }');
    expect(types).toContain('{ id: "meta", label: "Metadata" }');
    expect(viewer).toContain('initialMode = "transcript"');
    expect(viewer).toContain("SpanNavTree");
    expect(topbar).toContain('aria-label="Trace detail modes"');
    expect(canvas).toContain("VirtualTranscript");
    expect(topbar).toContain('data-testid="trace-actions-overflow"');
    expect(data).toContain("useTraceTimeline");
    const views = read("components/traces/trace-detail-views.tsx");
    expect(views).toContain('data-testid="trace-timeline"');
  });

  it("Wave 2: built-in views + I/O cols + empty≠filtered + Spans use hub search", () => {
    expect(TRACES_BUILTIN_VIEW_PRESETS.map((p) => p.id)).toEqual([
      "builtin:errors",
      "builtin:high-latency",
      "builtin:unreviewed",
    ]);
    expect(resolveTracesBuiltinView("builtin:errors")?.filter?.outcome).toBe(
      "failure",
    );
    expect(resolveTracesBuiltinView("builtin:high-latency")?.sort).toEqual({
      key: "duration_ms",
      direction: "desc",
    });
    expect(isTracesUnreviewedSoftView("builtin:unreviewed")).toBe(true);

    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(hook).toContain("TRACES_BUILTIN_VIEW_PRESETS");
    expect(hook).toContain("resolveTracesBuiltinView");
    expect(hook).toContain("filterDirty: hasListConstraints");
    // Query honesty: unsupported q tokens must not count as list constraints.
    expect(hook).not.toContain("Boolean(query)");
    expect(hook).toContain("effectiveFilter.realm");
    expect(hook).toContain("effectiveFilter.outcome");
    expect(hook).toContain("effectiveFilter.agent_id");

    const toolbar = read("app/(portal)/traces/_components/TracesToolbar.tsx");
    expect(toolbar).toContain("presets={viewPresets}");

    const tab = read("app/(portal)/observability/_components/TracesTab.tsx");
    expect(tab).toContain('id: "input"');
    expect(tab).toContain('id: "output"');
    expect(tab).toContain('data-testid="trace-input-preview"');

    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    expect(list).toContain("traces-unreviewed-soft-note");
    expect(list).toContain("showFirstRunEmpty");
    expect(list).toContain("showFilteredEmpty");
    expect(list).toContain("loading");

    const page = read("app/(portal)/traces/page.tsx");
    const spans = read("components/traces/SpansTab.tsx");
    expect(page).not.toContain("SpanSearchBar");
    expect(spans).not.toContain("SpanSearchBar");
    expect(list).toContain("query={query}");
  });
});
