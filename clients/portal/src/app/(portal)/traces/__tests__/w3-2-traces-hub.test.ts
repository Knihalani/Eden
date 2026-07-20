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
    expect(urlState).toContain('searchParams.get("trace")');
    expect(urlState).toContain('searchParams.get("trace_id")');
    expect(urlState).toContain('searchParams.get("traceId")');

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
});
