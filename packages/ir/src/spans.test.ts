import { describe, expect, test } from "bun:test";
import { tracesMatchSpans, type OrchestratorSpan } from "./spans";

describe("tracesMatchSpans", () => {
  test("parent invoke_workflow plus two invoke_agent children", () => {
    const parent = { id: "run-parent", spanId: "wf-1", spanName: "invoke_workflow", agentId: "orch" };
    const traces = [
      parent,
      { id: "run-intake", spanId: "ag-intake", spanName: "invoke_agent", parentRunId: parent.id, agentId: "intake" },
      { id: "run-billing", spanId: "ag-billing", spanName: "invoke_agent", parentRunId: parent.id, agentId: "billing" },
    ];
    const spans: OrchestratorSpan[] = [
      { spanId: "wf-1", agentId: "orch", name: "invoke_workflow" },
      { spanId: "ag-intake", parentSpanId: "wf-1", agentId: "intake", name: "invoke_agent" },
      { spanId: "ag-billing", parentSpanId: "wf-1", agentId: "billing", name: "invoke_agent" },
    ];
    expect(tracesMatchSpans(traces, spans)).toBe(true);
  });

  test("false when a child points at the wrong parent run", () => {
    const traces = [
      { id: "run-parent", spanId: "wf-1", agentId: "orch" },
      { id: "run-intake", spanId: "ag-intake", parentRunId: "other", agentId: "intake" },
    ];
    const spans: OrchestratorSpan[] = [
      { spanId: "wf-1", agentId: "orch", name: "invoke_workflow" },
      { spanId: "ag-intake", parentSpanId: "wf-1", agentId: "intake", name: "invoke_agent" },
    ];
    expect(tracesMatchSpans(traces, spans)).toBe(false);
  });

  test("false when a span id is missing from traces", () => {
    expect(
      tracesMatchSpans([{ id: "a", spanId: "wf-1", agentId: "orch" }], [
        { spanId: "wf-1", agentId: "orch", name: "invoke_workflow" },
        { spanId: "ag-intake", parentSpanId: "wf-1", agentId: "intake", name: "invoke_agent" },
      ]),
    ).toBe(false);
  });

  test("false when span names do not match invoke_workflow / invoke_agent", () => {
    const parent = { id: "run-parent", spanId: "wf-1", spanName: "chat", agentId: "orch" };
    expect(
      tracesMatchSpans([parent], [{ spanId: "wf-1", agentId: "orch", name: "invoke_workflow" }]),
    ).toBe(false);
  });

  test("empty spans match empty traces only", () => {
    expect(tracesMatchSpans([], [])).toBe(true);
    expect(tracesMatchSpans([{ id: "a", spanId: "wf-1", agentId: "orch" }], [])).toBe(false);
  });
});
