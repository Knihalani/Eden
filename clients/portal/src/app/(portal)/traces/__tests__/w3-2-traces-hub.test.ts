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
    expect(page).toContain("agent_id: next.agent_id ?? \"\"");
    expect(page).toContain('applyListFilters({ realm: "", outcome: "", agent_id: "" })');
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
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load traces");
    expect(src).toContain("Try again");
    expect(src).toContain("showFirstRunEmpty");
    expect(src).toContain("showFilteredEmpty");
    expect(src).toContain('title="No traces match"');
    expect(src).toContain("filtersFromSearchParams");
    expect(src).toContain("writeFilterParams");
    expect(src).toContain('params.set("agent_id"');
    expect(src).toContain('from "./traces-list-ui"');
    // Wave-2 hydration: hub tabs / detail are dynamic() like legacy views.
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\(["']@\/components\/traces\/SpansTab["']/);
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\(["']@\/components\/traces\/SessionsTab["']/);
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\(["']@\/components\/traces\/TraceDetailPanel["']/);
    // Orgless gate from Wave 2 must remain ahead of first-run empty.
    const noOrgIdx = src.indexOf("if (!currentOrg && !authError)");
    const emptyIdx = src.indexOf("<WaitingForFirstEvent");
    // WaitingForFirstEvent owns the empty title ("Waiting for first event").
    expect(src).toContain("WaitingForFirstEvent");
    expect(src).toContain("FIRST_EVENT_WAIT");
    expect(src).toContain("first_trace_at");
    expect(noOrgIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(noOrgIdx);
    expect(src).toMatch(/orgLoading\s*&&\s*!currentOrg/);
  });

  it("first-run empty polls and offers doctor + check CTA", () => {
    const src = read("app/(portal)/traces/page.tsx");
    expect(src).toContain("refetchInterval");
    expect(src).toContain("FIRST_EVENT_WAIT.pollMs");
    expect(src).toContain("onboardingV2Api.getState");
    expect(src).toContain('data-testid="traces-first-run-hint"');

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

    const detail = read("components/traces/TraceDetailPanel.tsx");
    expect(detail).toContain("Trace not found");
    expect(detail).toContain('from "@/components/ui/error-state"');

    const cross = read("lib/portal-cross-links.ts");
    expect(cross).toMatch(/tracesFilteredHref[\s\S]*agent_id/);
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
    // Identity
    expect(src).toContain('eyebrow="Observe"');
    expect(src).toContain('title="Traces"');
    expect(src).toContain('data-chrome-band="toolbar"');
    expect(src).toContain('data-testid="traces-toolbar"');
    expect(src).toContain("ResourcePageShell");
    // Hub tabs only — legacy tools not tab siblings
    expect(src).toContain('const HUB_VIEWS = ["traces", "spans", "sessions"]');
    expect(src).toContain("LEGACY_TOOL_LINKS");
    expect(src).toContain("More");
    expect(src).not.toMatch(/<TabsTrigger[^>]*value="inspect"/);
    // Facets are a QueryFilterBar select (`?facet=`) — never a third band
    expect(src).not.toContain('aria-label="Observability facets"');
    expect(src).toContain('key: "facet"');
    expect(src).toContain('params.set("facet"');
    expect(src).toContain('searchParams.get("facet")');
    expect(src).toContain("setFacet");
    // Live + Refresh live in the single toolbar band (not a third chrome row)
    expect(src).toMatch(/aria-label=\{liveOn \? "Turn off live tail"/);
    expect(src).toContain('searchParams.get("live") === "1"');
    expect(src).toContain("LiveTailPanel");
    expect(src).toMatch(/liveOn \?[\s\S]*LiveTailPanel/);
    expect(src).toContain('aria-label="Refresh traces"');
    expect(src).toContain('data-testid="traces-toolbar"');
    // Master–detail stays on hub
    expect(src).toContain("DetailPanelShell");
    expect(src).toContain("traceId");
    // Display hides optional cols inside More — not a new band
    expect(src).toContain("TRACES_OPTIONAL_COLUMNS");
    expect(src).toContain("writeVisibleColumns");
    expect(src).toContain('DropdownMenuLabel>Display');
  });

  it("UX-P0-10 wires ViewsMenu dirty + Save changes + Discard", () => {
    const src = read("app/(portal)/traces/page.tsx");
    expect(src).toContain("isViewDirty");
    expect(src).toContain("dirty={filterDirty}");
    expect(src).toContain("onSaveChanges");
    expect(src).toContain("currentViewState");
    expect(src).toContain("visibleColumns");
    expect(src).toContain("tableSort");
    expect(src).toMatch(/await update\(\{[\s\S]*viewId: savedViewId/);
    expect(src).toMatch(/onDiscard=\{\(\)\s*=>\s*\{[\s\S]*applyView\(savedViewId\)/);
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
    const detail = read("components/traces/TraceDetailPanel.tsx");
    expect(detail).toContain("TRACE_DETAIL_MODE_TABS");
    expect(detail).toContain('{ id: "transcript", label: "Transcript" }');
    expect(detail).toContain('{ id: "tree", label: "Tree" }');
    expect(detail).toContain('{ id: "timeline", label: "Timeline" }');
    expect(detail).toContain('{ id: "meta", label: "Metadata" }');
    expect(detail).toContain('useState<DetailMode>("transcript")');
    expect(detail).toContain('aria-label="Trace detail modes"');
    expect(detail).toContain("VirtualizedTranscript");
    expect(detail).toContain("CrossLinkBar");
    expect(detail).toContain('data-testid="trace-timeline"');
    expect(detail).toContain("useTraceTimeline");
  });
});
