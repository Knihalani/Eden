import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { assertValid } from "@eden/ir";
import { composedRegistry, registryFrom, runProgram } from "@eden/runtime";
import { compileTraces } from "./compile";
import { intakeBillingHandoffTraces } from "./corpus/fixtures";
import { approveInTest, assertHandoffNotLive, findHandoffGroups } from "./handoff";

/**
 * Wave 7.3: repeated agent→agent patterns compile to a composed candidate.
 * `manifest` stays null until Approve. Children are existing linear programs;
 * the parent steps call them by name through `composedRegistry`.
 */

function uniqueWorkTraces(): StretchTrace[] {
  const shapes = [
    {
      intake: ["lookupTicket", "fetchDetails", "classifyIssue"] as const,
      billing: ["fetchInvoice", "getBalance", "applyCredit"] as const,
    },
    {
      intake: ["searchLogs", "pageOncall", "fileIncident"] as const,
      billing: ["getAccount", "listInvoices", "emailCustomer"] as const,
    },
    {
      intake: ["listItems", "getItem", "tagItem"] as const,
      billing: ["grepCode", "readFile", "writeNotes"] as const,
    },
  ];
  const traces: StretchTrace[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const id = `U-${i}`;
    const parentId = `uniq-${i}`;
    const { intake, billing } = shapes[i]!;
    traces.push({
      id: parentId,
      agentId: "intake",
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { id },
      events: intake.map((name) => ({ name, args: { id }, result: { id, ok: true }, ok: true })),
    });
    traces.push({
      id: `uniq-bill-${i}`,
      agentId: "billing",
      parentRunId: parentId,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { id },
      events: billing.map((name) => ({ name, args: { id }, result: { id, ok: true }, ok: true })),
    });
  }
  return traces;
}

function underdeterminedBillingTraces(): StretchTrace[] {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `T-${i}`;
    const parentId = `ud-${i}`;
    traces.push({
      id: parentId,
      agentId: "intake",
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { class: "billing", id },
      events: [
        { name: "lookupTicket", args: { id }, result: { ok: true, id }, ok: true },
        { name: "fetchDetails", args: { id }, result: { id, body: "open" }, ok: true },
        { name: "classifyIssue", args: { id }, result: { class: "billing", id }, ok: true },
      ],
    });
    traces.push({
      id: `ud-bill-${i}`,
      agentId: "billing",
      parentRunId: parentId,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { wrote: true },
      events: [
        { name: "fetchInvoice", args: { id }, result: { id, total: 40 }, ok: true },
        { name: "getBalance", args: { id }, result: { id, due: 40 }, ok: true },
        { name: "writeRecord", args: { id: `OTHER-${i}` }, result: { wrote: true }, ok: true },
      ],
    });
  }
  return traces;
}

function siblingHandoffTraces(): StretchTrace[] {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < 3; i++) {
    const id = `S-${i}`;
    const run = `run-${i}`;
    traces.push({
      id: `sib-intake-${i}`,
      agentId: "intake",
      parentRunId: run,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { class: "billing", id },
      events: [
        { name: "lookupTicket", args: { id }, result: { ok: true, id }, ok: true },
        { name: "fetchDetails", args: { id }, result: { id, body: "open" }, ok: true },
        { name: "classifyIssue", args: { id }, result: { class: "billing", id }, ok: true },
      ],
    });
    traces.push({
      id: `sib-bill-${i}`,
      agentId: "billing",
      parentRunId: run,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { applied: true, id },
      events: [
        { name: "fetchInvoice", args: { id }, result: { id, total: 40 }, ok: true },
        { name: "getBalance", args: { id }, result: { id, due: 40 }, ok: true },
        { name: "applyCredit", args: { id, amount: 40 }, result: { applied: true, id }, ok: true },
      ],
    });
  }
  return traces;
}

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

describe("handoff mining", () => {
  test("detects intake→billing groups at minSupport", () => {
    const groups = findHandoffGroups(intakeBillingHandoffTraces(3), 3);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.uniqueAgents).toEqual(["intake", "billing"]);
    expect(groups[0]!.witnesses).toBe(3);
  });

  test("compileTraces emits one composed handoff; manifest null; children compile", () => {
    const { programs } = compileTraces(intakeBillingHandoffTraces(3));
    const handoff = programs.find((p) => p.composedOf?.length === 2);
    expect(handoff).toBeTruthy();
    expect(handoff!.origin?.mode).toBe("handoff");
    expect(handoff!.manifest).toBeNull();
    expect(handoff!.composedOf).toHaveLength(2);
    expect(handoff!.contract.witnesses).toBeGreaterThanOrEqual(3);
    const tools = handoff!.steps.filter((s) => s.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.kind === "tool" && tools[0]!.args.id?.kind).toBe("input");
    expect(tools[1]!.kind === "tool" && tools[1]!.args.id?.kind).toBe("from");
    expect(() => assertValid(handoff!)).not.toThrow();
    assertHandoffNotLive(handoff!);
    for (const id of handoff!.composedOf!) {
      const child = programs.find((p) => p.id === id);
      expect(child, `missing child ${id}`).toBeTruthy();
      expect(child!.composedOf).toBeUndefined();
      expect(child!.origin?.mode).not.toBe("handoff");
    }
  });

  test("stable identity across recompiles", () => {
    const a = compileTraces(intakeBillingHandoffTraces(3)).programs.find((p) => p.composedOf?.length === 2)!;
    const b = compileTraces(intakeBillingHandoffTraces(3)).programs.find((p) => p.composedOf?.length === 2)!;
    expect(a.id).toBe(b.id);
    expect(a.version).toBe(b.version);
  });

  test("siblings sharing parentRunId also compose", () => {
    const { programs } = compileTraces(siblingHandoffTraces());
    const handoff = programs.find((p) => p.origin?.mode === "handoff");
    expect(handoff?.composedOf).toHaveLength(2);
    expect(handoff!.manifest).toBeNull();
  });

  test("composedRegistry runs the mined parent through its children", async () => {
    const { programs } = compileTraces(intakeBillingHandoffTraces(3));
    const parent = programs.find((p) => p.composedOf?.length === 2)!;
    const children = parent.composedOf!.map((id) => programs.find((p) => p.id === id)!);
    expect(children).toHaveLength(2);
    const calls: string[] = [];
    const base = {
      lookupTicket: async (args: Record<string, unknown>) => {
        calls.push("lookupTicket");
        return { ok: true, id: args.id };
      },
      fetchDetails: async (args: Record<string, unknown>) => {
        calls.push("fetchDetails");
        return { id: args.id, body: "open" };
      },
      classifyIssue: async (args: Record<string, unknown>) => {
        calls.push("classifyIssue");
        return { class: "billing", id: args.id };
      },
      fetchInvoice: async (args: Record<string, unknown>) => {
        calls.push("fetchInvoice");
        return { id: args.id, total: 40 };
      },
      getBalance: async (args: Record<string, unknown>) => {
        calls.push("getBalance");
        return { id: args.id, due: 40 };
      },
      applyCredit: async (args: Record<string, unknown>) => {
        calls.push("applyCredit");
        return { applied: true, id: args.id };
      },
    };
    const sub: Record<string, { program: (typeof children)[number] }> = {};
    for (const c of children) sub[c.name] = { program: c };
    const reg = composedRegistry(base, sub);
    const out = await runProgram(parent, { id: "T-0" }, { registry: reg });
    expect(out.stats.deopt).toBe(false);
    expect(calls).toContain("lookupTicket");
    expect(calls).toContain("applyCredit");
    expect(out.value).toEqual({ applied: true, id: "T-0" });
  });

  test("Approve helper is the only way a handoff gains a manifest", () => {
    const { programs } = compileTraces(intakeBillingHandoffTraces(3));
    const p = programs.find((q) => q.composedOf?.length === 2)!;
    assertHandoffNotLive(p);
    const tagged = { ...p, composedOf: p.composedOf };
    expect(tagged.manifest).toBeNull();
    assertHandoffNotLive(tagged);
    const approved = approveInTest(p, passManifest);
    expect(approved.manifest).toEqual(passManifest);
    expect(p.manifest).toBeNull();
  });

  test("two agents but unique work does not compose", () => {
    const { programs } = compileTraces(uniqueWorkTraces());
    expect(programs.filter((p) => p.origin?.mode === "handoff")).toHaveLength(0);
    expect(programs.filter((p) => p.composedOf?.length)).toHaveLength(0);
  });

  test("mutating under-determined child refuses; no guessed compose", () => {
    const { programs, refusals } = compileTraces(underdeterminedBillingTraces());
    expect(programs.filter((p) => p.origin?.mode === "handoff")).toHaveLength(0);
    expect(
      refusals.some((r) => r.code === "underdetermined_write" || /under-determined|Handoff refused/i.test(r.reason)),
    ).toBe(true);
  });

  test("fork programs are not stolen as handoffs", () => {
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
    const branches = programs.filter((p) => p.steps.some((s) => s.kind === "branch"));
    expect(branches).toHaveLength(1);
    expect(programs.filter((p) => p.origin?.mode === "handoff")).toHaveLength(0);
  });

  test("single-agent traces are unchanged", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => ({
      id: `solo-${i}`,
      agentId: "intake",
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id: `T-${i}` },
      output: { class: "billing", id: `T-${i}` },
      events: [
        { name: "lookupTicket", args: { id: `T-${i}` }, result: { ok: true, id: `T-${i}` }, ok: true },
        { name: "fetchDetails", args: { id: `T-${i}` }, result: { id: `T-${i}`, body: "open" }, ok: true },
        { name: "classifyIssue", args: { id: `T-${i}` }, result: { class: "billing", id: `T-${i}` }, ok: true },
      ],
    }));
    const { programs } = compileTraces(traces);
    expect(programs.filter((p) => p.origin?.mode === "handoff")).toHaveLength(0);
    expect(programs.length).toBeGreaterThanOrEqual(1);
    expect(programs[0]!.sequence).toEqual(["lookupTicket", "fetchDetails", "classifyIssue"]);
  });

  test("below minSupport does not compose", () => {
    const { programs } = compileTraces(intakeBillingHandoffTraces(2));
    expect(programs.filter((p) => p.origin?.mode === "handoff")).toHaveLength(0);
  });
});
