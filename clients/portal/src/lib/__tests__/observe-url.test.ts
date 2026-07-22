import { describe, expect, it } from "vitest";
import {
  OBSERVE_FILTER_PRESERVE_KEYS,
  clearObserveSelection,
  legacyObserveExternalRedirect,
  normalizeObserveSearchParams,
  parseObserveSearchParams,
  preserveObserveFilters,
  progressiveEscClear,
  writeObserveSearchParams,
} from "@/lib/observe-url";

describe("observe-url", () => {
  it("parses aliases onto camelCase identity fields", () => {
    const params = new URLSearchParams(
      "trace_id=tr_1&span=sp_2&session_id=ses_3&agent_id=ag_4&issue_id=is_5&alert_id=al_6",
    );
    const state = parseObserveSearchParams(params);
    expect(state.traceId).toBe("tr_1");
    expect(state.spanId).toBe("sp_2");
    expect(state.sessionId).toBe("ses_3");
    expect(state.agentId).toBe("ag_4");
    expect(state.issueId).toBe("is_5");
    expect(state.alertId).toBe("al_6");
  });

  it("defaults view=traces and mode=transcript when traceId set", () => {
    const state = parseObserveSearchParams(
      new URLSearchParams("traceId=tr_abc"),
    );
    expect(state.view).toBe("traces");
    expect(state.mode).toBe("transcript");
  });

  it("maps legacy view=inspect to mode=meta", () => {
    const state = parseObserveSearchParams(
      new URLSearchParams("view=inspect&traceId=tr_1"),
    );
    expect(state.view).toBe("traces");
    expect(state.mode).toBe("meta");
  });

  it("maps legacy view=replay|debug|time-travel to debugger URLs", () => {
    expect(
      legacyObserveExternalRedirect(
        new URLSearchParams("view=replay&traceId=tr_9"),
      ),
    ).toBe("/debugger?tab=replay&traceId=tr_9");
    expect(
      legacyObserveExternalRedirect(new URLSearchParams("view=debug")),
    ).toBe("/debugger?tab=compare");
    expect(
      legacyObserveExternalRedirect(
        new URLSearchParams("view=time-travel&trace_id=tr_a"),
      ),
    ).toBe("/debugger?tab=time-travel&traceId=tr_a");
    expect(
      legacyObserveExternalRedirect(new URLSearchParams("view=traces")),
    ).toBeNull();
  });

  it("normalize drops aliases and writes camelCase", () => {
    const raw = new URLSearchParams(
      "trace_id=tr_1&span_id=sp_2&agent_id=ag_9&q=checkout",
    );
    const next = normalizeObserveSearchParams(raw);
    expect(next.get("traceId")).toBe("tr_1");
    expect(next.get("spanId")).toBe("sp_2");
    expect(next.get("agentId")).toBe("ag_9");
    expect(next.get("trace_id")).toBeNull();
    expect(next.get("span_id")).toBeNull();
    expect(next.get("agent_id")).toBeNull();
    expect(next.get("q")).toBe("checkout");
  });

  it("write omits default view and empty values; drops aliases", () => {
    const base = new URLSearchParams("trace_id=old&q=keep");
    const next = writeObserveSearchParams(
      {
        view: "traces",
        mode: "transcript",
        traceId: "tr_new",
        spanId: undefined,
        q: "keep",
      },
      base,
    );
    const normalized = normalizeObserveSearchParams(next);
    expect(normalized.get("view")).toBeNull();
    expect(normalized.get("mode")).toBeNull();
    expect(normalized.get("traceId")).toBe("tr_new");
    expect(normalized.get("trace_id")).toBeNull();
    expect(normalized.get("q")).toBe("keep");
  });

  it("write sets non-default view/mode", () => {
    const next = writeObserveSearchParams({
      view: "sessions",
      mode: "tree",
      sessionId: "ses_1",
      traceId: "tr_1",
    });
    expect(next.get("view")).toBe("sessions");
    expect(next.get("mode")).toBe("tree");
    expect(next.get("sessionId")).toBe("ses_1");
    expect(next.get("traceId")).toBe("tr_1");
  });

  it("preserveObserveFilters keeps only the IA preserve set", () => {
    const from = new URLSearchParams(
      "pastHours=24&q=err&filter=x&agent_id=ag_1&outcome=error&realm=prod&viewId=v1&traceId=tr_drop&facet=mcp",
    );
    const preserved = preserveObserveFilters(from);
    for (const key of OBSERVE_FILTER_PRESERVE_KEYS) {
      if (key === "agentId") {
        expect(preserved.get("agentId")).toBe("ag_1");
        continue;
      }
      if (key === "from" || key === "to") {
        expect(preserved.get(key)).toBeNull();
        continue;
      }
      expect(preserved.get(key)).toBeTruthy();
    }
    expect(preserved.get("traceId")).toBeNull();
    expect(preserved.get("facet")).toBeNull();
  });

  it("Esc clear helpers remove selection without wiping filters", () => {
    const params = new URLSearchParams(
      "view=sessions&sessionId=ses_1&traceId=tr_1&spanId=sp_1&mode=tree&q=keep&pastHours=24",
    );

    const spanCleared = progressiveEscClear(params);
    expect(spanCleared.get("spanId")).toBeNull();
    expect(spanCleared.get("traceId")).toBe("tr_1");
    expect(spanCleared.get("q")).toBe("keep");

    const traceCleared = progressiveEscClear(spanCleared);
    expect(traceCleared.get("traceId")).toBeNull();
    expect(traceCleared.get("mode")).toBeNull();
    expect(traceCleared.get("sessionId")).toBe("ses_1");
    expect(traceCleared.get("pastHours")).toBe("24");

    const sessionCleared = progressiveEscClear(traceCleared);
    expect(sessionCleared.get("sessionId")).toBeNull();
    expect(sessionCleared.get("view")).toBe("sessions");
    expect(sessionCleared.get("q")).toBe("keep");
  });

  it("clearObserveSelection(level=issue) clears issueId only", () => {
    const params = new URLSearchParams(
      "tab=open&issueId=is_1&q=keep&agentId=ag_1",
    );
    const next = clearObserveSelection(params, "issue");
    expect(next.get("issueId")).toBeNull();
    expect(next.get("tab")).toBe("open");
    expect(next.get("q")).toBe("keep");
    expect(next.get("agentId")).toBe("ag_1");
  });
});
