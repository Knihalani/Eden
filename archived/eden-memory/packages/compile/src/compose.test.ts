import { describe, expect, test } from "bun:test";
import type { StretchProgram, StretchTrace } from "@eden/ir";
import { assertValid, withVersion } from "@eden/ir";
import { compileTraces } from "./compile";
import { intakeBillingHandoffTraces } from "./corpus/fixtures";
import { approveComposeInTest, assembleComposeProgram, assertComposeNotLive, findComposeJoins } from "./compose";
import { approveInTest, assertHandoffNotLive } from "./handoff";

const passManifest = {
  llmReduction: 5,
  latencyReduction: 2,
  costReduction: 2,
  skipRateBefore: 0.1,
  skipRateAfter: 0,
  nShadow: 6,
  tokensMeasured: true,
  tokensSaved: 400,
  timeMeasured: false,
  timeSavedMs: null,
};

const idArg = { id: { kind: "input" as const, path: "id" } };

function childProgram(name: string, sequence: string[]): StretchProgram {
  const steps = sequence.map((tool) => ({
    id: tool,
    kind: "tool" as const,
    tool,
    args: { ...idArg },
  }));
  return withVersion({
    id: `p_${name}`,
    name,
    description: name,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence,
    steps,
    returns: { kind: "from", step: steps.at(-1)!.id, path: "" },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { id: ["T-0", "T-1", "T-2"] } },
    },
    manifest: {
      llmReduction: 3,
      latencyReduction: 1,
      costReduction: 1,
      skipRateBefore: 0,
      skipRateAfter: 0,
      nShadow: 3,
    },
  });
}

const LOOKUP = ["lookupTicket", "fetchDetails", "classifyIssue"] as const;
const RESOLVE = ["fetchInvoice", "getBalance", "applyCredit"] as const;

function lookupEvents(id: string) {
  return [
    { name: "lookupTicket", args: { id }, result: { ok: true, id }, ok: true },
    { name: "fetchDetails", args: { id }, result: { id, body: "open" }, ok: true },
    { name: "classifyIssue", args: { id }, result: { class: "billing", id }, ok: true },
  ];
}

function resolveEvents(id: string) {
  return [
    { name: "fetchInvoice", args: { id }, result: { id, total: 40 }, ok: true },
    { name: "getBalance", args: { id }, result: { id, due: 40 }, ok: true },
    { name: "applyCredit", args: { id, amount: 40 }, result: { applied: true, id }, ok: true },
  ];
}

function concatTraces(n = 3): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `T-${i}`;
    return {
      id: `join-${i}`,
      agentId: "desk",
      llmCalls: 6,
      duration_ms: 60,
      cost_cents: 6,
      complete: true,
      input: { id },
      output: { applied: true, id },
      events: [...lookupEvents(id), ...resolveEvents(id)],
    };
  });
}

function lookupThenResolveFixture(): StretchTrace[] {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `T-${i}`;
    traces.push({
      id: `lu-${i}`,
      agentId: "desk",
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { class: "billing", id },
      events: lookupEvents(id),
    });
    traces.push({
      id: `rs-${i}`,
      agentId: "desk",
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { applied: true, id },
      events: resolveEvents(id),
    });
  }
  traces.push(...concatTraces(3));
  return traces;
}

function uniqueWorkTraces(): StretchTrace[] {
  const shapes = [
    ["lookupTicket", "fetchDetails", "classifyIssue"],
    ["searchLogs", "pageOncall", "fileIncident"],
    ["listItems", "getItem", "tagItem"],
  ];
  return shapes.map((events, i) => {
    const id = `U-${i}`;
    return {
      id: `uniq-${i}`,
      agentId: "desk",
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { id },
      events: events.map((name) => ({ name, args: { id }, result: { id, ok: true }, ok: true })),
    };
  });
}

function unboundMutatingJoinTraces(): StretchTrace[] {
  return Array.from({ length: 3 }, (_, i) => {
    const id = `T-${i}`;
    return {
      id: `ub-${i}`,
      agentId: "desk",
      llmCalls: 6,
      duration_ms: 60,
      cost_cents: 6,
      complete: true,
      input: { id },
      output: { wrote: true },
      events: [
        ...lookupEvents(id),
        { name: "fetchInvoice", args: { id }, result: { id, total: 40 }, ok: true },
        { name: "getBalance", args: { id }, result: { id, due: 40 }, ok: true },
        { name: "writeRecord", args: { id: `OTHER-${i}` }, result: { wrote: true }, ok: true },
      ],
    };
  });
}

describe("same-agent compose", () => {
  test("3 lookup→resolve traces (2 child programs exist) → one compose candidate, manifest null, composedOf 2", () => {
    const lookup = childProgram("lookup_ticket", [...LOOKUP]);
    const resolve = childProgram("resolve_ticket", [...RESOLVE]);
    const traces = concatTraces(3);
    const joins = findComposeJoins(traces, [lookup, resolve], 3);
    expect(joins).toHaveLength(1);
    expect(joins[0]!.a.id).toBe(lookup.id);
    expect(joins[0]!.b.id).toBe(resolve.id);
    expect(joins[0]!.witnesses).toBe(3);
    const drafted = assembleComposeProgram(joins[0]!, { minLlmReduction: 2, allowExact: false });
    expect(drafted.refuse).toBeUndefined();
    const p = drafted.program!;
    expect(p.manifest).toBeNull();
    expect(p.composedOf).toHaveLength(2);
    expect(p.composedOf).toEqual([lookup.id, resolve.id]);
    expect(p.origin?.mode).toBe("compose");
    expect(p.origin?.mode).not.toBe("handoff");
    const tools = p.steps.filter((s) => s.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.kind === "tool" && tools[0]!.tool).toBe("lookup_ticket");
    expect(tools[1]!.kind === "tool" && tools[1]!.tool).toBe("resolve_ticket");
    expect(() => assertValid(p)).not.toThrow();
    assertComposeNotLive(p);
    assertHandoffNotLive(p);
  });

  test("compileTraces with both children present emits a compose candidate", () => {
    // maxGram 3 keeps lookup and resolve as their own programs so the longer
    // concat is not the only cluster (clusterByShape drops subsequence arms).
    const { programs } = compileTraces(lookupThenResolveFixture(), { maxGram: 3 });
    const compose = programs.find((p) => p.origin?.mode === "compose");
    expect(compose).toBeTruthy();
    expect(compose!.manifest).toBeNull();
    expect(compose!.composedOf).toHaveLength(2);
    expect(compose!.origin?.mode).toBe("compose");
    assertComposeNotLive(compose!);
    for (const id of compose!.composedOf!) {
      const child = programs.find((p) => p.id === id);
      expect(child, `missing child ${id}`).toBeTruthy();
      expect(child!.composedOf).toBeUndefined();
      expect(child!.origin?.mode).not.toBe("handoff");
      expect(child!.origin?.mode).not.toBe("compose");
    }
  });

  test("default compileTraces (no maxGram) emits compose from a witnessed A then B join", () => {
    const traces = concatTraces(3);
    const { programs } = compileTraces(traces);
    const compose = programs.filter((p) => p.origin?.mode === "compose");
    expect(compose.length).toBeGreaterThanOrEqual(1);
    const p = compose[0]!;
    expect(p.manifest).toBeNull();
    expect(p.composedOf).toHaveLength(2);
    expect(p.origin?.mode).toBe("compose");
    assertComposeNotLive(p);
    for (const id of p.composedOf!) {
      const child = programs.find((q) => q.id === id);
      expect(child, `missing child ${id}`).toBeTruthy();
      expect(child!.composedOf).toBeUndefined();
      expect(child!.origin?.mode).not.toBe("handoff");
      expect(child!.origin?.mode).not.toBe("compose");
    }
    const joinSeq = [...LOOKUP, ...RESOLVE];
    expect(
      programs.some((q) => q.origin?.mode !== "compose" && (q.sequence ?? []).join("\0") === joinSeq.join("\0")),
    ).toBe(false);
  });

  test("unique-work: compose programs 0", () => {
    const { programs } = compileTraces(uniqueWorkTraces());
    expect(programs.filter((p) => p.origin?.mode === "compose")).toHaveLength(0);
    expect(programs.filter((p) => p.composedOf?.length && p.origin?.mode === "compose")).toHaveLength(0);
    const lookup = childProgram("lookup_ticket", [...LOOKUP]);
    const resolve = childProgram("resolve_ticket", [...RESOLVE]);
    expect(findComposeJoins(uniqueWorkTraces(), [lookup, resolve], 3)).toHaveLength(0);
  });

  test("handoff fixture still origin handoff not compose", () => {
    const { programs } = compileTraces(intakeBillingHandoffTraces(3));
    const handoff = programs.find((p) => p.composedOf?.length === 2);
    expect(handoff).toBeTruthy();
    expect(handoff!.origin?.mode).toBe("handoff");
    expect(handoff!.origin?.mode).not.toBe("compose");
    expect(programs.filter((p) => p.origin?.mode === "compose")).toHaveLength(0);
    assertHandoffNotLive(handoff!);
  });

  test("Approve helper ships a compose candidate; original stays null", () => {
    const lookup = childProgram("lookup_ticket", [...LOOKUP]);
    const resolve = childProgram("resolve_ticket", [...RESOLVE]);
    const drafted = assembleComposeProgram(findComposeJoins(concatTraces(3), [lookup, resolve], 3)[0]!, {
      minLlmReduction: 2,
      allowExact: false,
    });
    const p = drafted.program!;
    expect(p.manifest).toBeNull();
    const approved = approveComposeInTest(p, passManifest);
    expect(approved.manifest).toEqual(passManifest);
    expect(p.manifest).toBeNull();
    const viaHandoffHelper = approveInTest(p, passManifest);
    expect(viaHandoffHelper.manifest).toEqual(passManifest);
    expect(p.manifest).toBeNull();
  });

  test("child lacking id is not composed", () => {
    const lookup = { ...childProgram("lookup_ticket", [...LOOKUP]), id: "" };
    const resolve = childProgram("resolve_ticket", [...RESOLVE]);
    expect(findComposeJoins(concatTraces(3), [lookup, resolve], 3)).toHaveLength(0);
  });

  test("handoff parents are not compose children", () => {
    const lookup = childProgram("lookup_ticket", [...LOOKUP]);
    const resolve = childProgram("resolve_ticket", [...RESOLVE]);
    const parent: StretchProgram = {
      ...childProgram("handoff_parent", [lookup.name, resolve.name]),
      origin: { mode: "handoff" },
      composedOf: [lookup.id, resolve.id],
    };
    const joins = findComposeJoins(concatTraces(3), [lookup, resolve, parent], 3);
    expect(joins.every((j) => j.a.id !== parent.id && j.b.id !== parent.id)).toBe(true);
  });

  test("unbound mutating join refuses; do not guess", () => {
    const lookup = childProgram("lookup_ticket", [...LOOKUP]);
    const write = childProgram("write_out", ["fetchInvoice", "getBalance", "writeRecord"]);
    const joins = findComposeJoins(unboundMutatingJoinTraces(), [lookup, write], 3);
    expect(joins).toHaveLength(1);
    const drafted = assembleComposeProgram(joins[0]!, { minLlmReduction: 2, allowExact: false });
    expect(drafted.program).toBeUndefined();
    expect(drafted.refuse?.code).toBe("underdetermined_write");
  });

  test("below minSupport does not compose", () => {
    const lookup = childProgram("lookup_ticket", [...LOOKUP]);
    const resolve = childProgram("resolve_ticket", [...RESOLVE]);
    expect(findComposeJoins(concatTraces(2), [lookup, resolve], 3)).toHaveLength(0);
  });

  test("fork programs are not re-read as compose", () => {
    const traces: StretchTrace[] = [
      ...[101, 102, 103].map((pr, i) => ({
        id: `t${i}`,
        events: [
          { name: "get_ci", args: { pr }, result: { state: "failure", pr }, ok: true },
          { name: "fix_build", args: { pr }, result: { done: true, pr }, ok: true },
          { name: "notify", args: { pr }, result: { done: true, pr }, ok: true },
        ],
        input: { pr },
        output: { done: true },
        llmCalls: 4,
        duration_ms: 4000,
        cost_cents: 4,
        complete: true,
      })),
      ...[201, 202, 203].map((pr, i) => ({
        id: `s${i}`,
        events: [
          { name: "get_ci", args: { pr }, result: { state: "success", pr }, ok: true },
          { name: "notify", args: { pr }, result: { done: true, pr }, ok: true },
        ],
        input: { pr },
        output: { done: true },
        llmCalls: 4,
        duration_ms: 4000,
        cost_cents: 4,
        complete: true,
      })),
    ];
    const { programs } = compileTraces(traces);
    expect(programs.filter((p) => p.origin?.mode === "compose")).toHaveLength(0);
    expect(programs.filter((p) => p.steps.some((s) => s.kind === "branch"))).toHaveLength(1);
  });
});
