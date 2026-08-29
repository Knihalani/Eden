import { describe, expect, test } from "bun:test";
import { tracesMatchSpans } from "@eden/ir";
import { createArmingStore, createState, sharedAcrossLine, wrapTools, type ToolDef } from "@eden/wrap";
import { FLEET_FETCH_AFTER, FLEET_FETCH_BEFORE, fetchTools, readOnlyFetchProgram } from "./fleet-dedupe";
import { fireOblivious, linearProgram } from "./struggle-harness";

describe("rotation: fleet-dedupe", () => {
  test("two agents, one fleet, one GET — second is claimed", async () => {
    const execs: Record<string, number> = {};
    const prog = readOnlyFetchProgram();
    const arming = createArmingStore();
    const aState = createState({
      programs: [prog],
      arming,
      sessionId: "sess-a",
      fleetId: "fleet-1",
      agentId: "intake",
      region: "us-east-1",
    });
    const bState = createState({
      programs: [prog],
      arming,
      sessionId: "sess-b",
      fleetId: "fleet-1",
      agentId: "billing",
      region: "us-east-1",
    });
    const a = wrapTools(fetchTools(execs), aState) as Record<string, ToolDef>;
    const b = wrapTools(fetchTools(execs), bState) as Record<string, ToolDef>;
    const script = [
      { tool: "fetchIssue", args: { id: "E-1" } },
      { tool: "fetchComments", args: { id: "E-1" } },
    ];
    await Promise.all([fireOblivious(a, script), fireOblivious(b, script)]);
    expect(execs["fetchIssue:E-1"]).toBe(FLEET_FETCH_AFTER);
    expect(execs["fetchComments:E-1"]).toBe(FLEET_FETCH_AFTER);
    const line = sharedAcrossLine(2);
    const reasons = [...aState.receipts, ...bState.receipts].map((r) => r.reason ?? "");
    expect(reasons.some((r) => r.includes(line))).toBe(true);
    const shared = [...aState.receipts, ...bState.receipts].filter((r) => (r.sharedAcross ?? 0) >= 2);
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((r) => r.sharedAcross !== 1)).toBe(true);
    expect(FLEET_FETCH_BEFORE).toBe(2);
  });

  test("empty fleetId does not share", async () => {
    const execs: Record<string, number> = {};
    const prog = readOnlyFetchProgram();
    const arming = createArmingStore();
    const a = wrapTools(
      fetchTools(execs),
      createState({ programs: [prog], arming, sessionId: "a" }),
    ) as Record<string, ToolDef>;
    const b = wrapTools(
      fetchTools(execs),
      createState({ programs: [prog], arming, sessionId: "b" }),
    ) as Record<string, ToolDef>;
    const script = [
      { tool: "fetchIssue", args: { id: "E-1" } },
      { tool: "fetchComments", args: { id: "E-1" } },
    ];
    await Promise.all([fireOblivious(a, script), fireOblivious(b, script)]);
    expect(execs["fetchIssue:E-1"]).toBe(2);
    expect(execs["fetchComments:E-1"]).toBe(2);
  });

  test("mutating still writes once per session on the same fleet", async () => {
    const writes: Record<string, number> = {};
    const prog = linearProgram("p_x", ["lookup", "write", "audit"], { text: true });
    const arming = createArmingStore();
    const toolsFor = (tag: string): Record<string, ToolDef> => ({
      lookup: { execute: async (args) => ({ id: args.id, tag }) },
      write: {
        execute: async (args) => {
          writes[tag] = (writes[tag] ?? 0) + 1;
          return { id: args.id, tag };
        },
      },
      audit: { execute: async (args) => ({ id: args.id, tag }) },
    });
    const a = wrapTools(
      toolsFor("a"),
      createState({ programs: [prog], arming, sessionId: "sess-a", fleetId: "fleet-1" }),
    ) as Record<string, ToolDef>;
    const b = wrapTools(
      toolsFor("b"),
      createState({ programs: [prog], arming, sessionId: "sess-b", fleetId: "fleet-1" }),
    ) as Record<string, ToolDef>;
    await Promise.all([
      fireOblivious(a, [
        { tool: "lookup", args: { id: "E-1", text: "a" } },
        { tool: "write", args: { id: "E-1" } },
        { tool: "audit", args: { id: "E-1" } },
      ]),
      fireOblivious(b, [
        { tool: "lookup", args: { id: "E-1", text: "b" } },
        { tool: "write", args: { id: "E-1" } },
        { tool: "audit", args: { id: "E-1" } },
      ]),
    ]);
    expect(writes.a).toBe(1);
    expect(writes.b).toBe(1);
  });

  test("attribution matches orchestrator spans", async () => {
    const parentState = createState({
      spanId: "wf-1",
      agentId: "orch",
      sessionId: "parent",
      fleetId: "fleet-1",
    });
    const parentTools = wrapTools({ notify: { execute: async () => "ok" } }, parentState);
    await parentTools.notify.execute({});
    const parentTrace = parentState.traces[0];
    expect(parentTrace).toBeTruthy();
    expect(parentTrace!.spanId).toBe("wf-1");
    expect(parentTrace!.spanName).toBe("invoke_workflow");
    expect(parentTrace!.agentId).toBe("orch");

    const arming = createArmingStore();
    const prog = readOnlyFetchProgram();
    const intakeState = createState({
      programs: [prog],
      arming,
      sessionId: "intake",
      fleetId: "fleet-1",
      agentId: "intake",
      parentRunId: parentTrace!.id,
      spanId: "ag-intake",
      region: "us-east-1",
    });
    const billingState = createState({
      programs: [prog],
      arming,
      sessionId: "billing",
      fleetId: "fleet-1",
      agentId: "billing",
      parentRunId: parentTrace!.id,
      spanId: "ag-billing",
      region: "us-east-1",
    });
    const script = [
      { tool: "fetchIssue", args: { id: "E-1" } },
      { tool: "fetchComments", args: { id: "E-1" } },
    ];
    await Promise.all([
      fireOblivious(wrapTools(fetchTools({}), intakeState) as Record<string, ToolDef>, script),
      fireOblivious(wrapTools(fetchTools({}), billingState) as Record<string, ToolDef>, script),
    ]);
    const flush = wrapTools({ notify: { execute: async () => "ok" } }, intakeState);
    await flush.notify.execute({});
    const flushB = wrapTools({ notify: { execute: async () => "ok" } }, billingState);
    await flushB.notify.execute({});

    const traces = [parentTrace!, ...intakeState.traces, ...billingState.traces];
    expect(
      tracesMatchSpans(traces, [
        { spanId: "wf-1", agentId: "orch", name: "invoke_workflow" },
        { spanId: "ag-intake", parentSpanId: "wf-1", agentId: "intake", name: "invoke_agent" },
        { spanId: "ag-billing", parentSpanId: "wf-1", agentId: "billing", name: "invoke_agent" },
      ]),
    ).toBe(true);
    expect(intakeState.traces.some((t) => t.spanName === "invoke_agent" && t.agentId === "intake")).toBe(true);
    expect(intakeState.receipts.some((r) => r.agentId === "intake" && r.region === "us-east-1")).toBe(true);
  });
});
