import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import { withVersion } from "@eden/ir";
import {
  bindingFaults,
  layoutProgram,
  methodSteps,
  stepAccessLine,
  strippedFromMethod,
  tokenClassForNode,
  nodeProviderCacheHitLine,
  tokenClassLedgerLine,
  tokenClassLedgerReconcileLine,
  witnessLines,
} from "./layout-program";

function program(): StretchProgram {
  return withVersion({
    id: "p",
    name: "resolve_ticket",
    description: "test",
    inputSchema: { type: "object" },
    steps: [
      { id: "lookup", kind: "tool", tool: "lookupTicket", args: { id: { kind: "input", path: "id" } }, readOnly: true },
      {
        id: "write",
        kind: "tool",
        tool: "writeRecord",
        args: { id: { kind: "from", step: "lookup", path: "id" } },
      },
      { id: "check", kind: "assert", expr: "ok", onFail: "deopt" },
    ],
    returns: { kind: "from", step: "write", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
    manifest: null,
    sequence: ["lookupTicket", "draftReply", "writeRecord"],
  });
}

describe("canvas layout", () => {
  test("wires are from-bindings, left to right", () => {
    const g = layoutProgram(program());
    const lookup = g.nodes.find((n) => n.id === "lookup")!;
    const write = g.nodes.find((n) => n.id === "write")!;
    expect(lookup.col).toBe(0);
    expect(write.col).toBe(1);
    expect(write.x).toBeGreaterThan(lookup.x);
    expect(g.edges).toEqual([{ from: "lookup", to: "write", field: "id", path: "id" }]);
    expect(write.write).toBe(true);
    expect(g.nodes.find((n) => n.id === "check")!.col).toBeGreaterThan(write.col);
  });

  test("independent roots sit in the same column", () => {
    const p = withVersion({
      id: "p2",
      name: "parallel",
      description: "test",
      inputSchema: { type: "object" },
      steps: [
        { id: "a", kind: "tool", tool: "lookupTicket", args: { id: { kind: "input", path: "id" } }, readOnly: true },
        { id: "b", kind: "tool", tool: "fetchUser", args: { id: { kind: "input", path: "user" } }, readOnly: true },
      ],
      returns: { kind: "from", step: "a", path: "id" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    });
    const g = layoutProgram(p);
    expect(g.nodes.find((n) => n.id === "a")!.col).toBe(0);
    expect(g.nodes.find((n) => n.id === "b")!.col).toBe(0);
    expect(g.edges).toEqual([]);
  });

  test("loop bodies are not drawn as extra nodes", () => {
    const p = program();
    p.steps.push({
      id: "each",
      kind: "loop",
      over: { kind: "from", step: "lookup", path: "items" },
      item: "item",
      body: ["write"],
    });
    expect(methodSteps(p).map((s) => s.id)).toEqual(["lookup", "check", "each"]);
    expect(layoutProgram(p).nodes.map((n) => n.id)).toEqual(["lookup", "check", "each"]);
  });

  test("stripped list is sequence tools the method dropped", () => {
    expect(strippedFromMethod(program())).toEqual(["draftReply"]);
  });

  test("unknown from step fails closed", () => {
    const p = program();
    const write = p.steps.find((s) => s.id === "write");
    if (write?.kind === "tool") write.args.id = { kind: "from", step: "nope", path: "id" };
    const faults = bindingFaults(p);
    expect(faults.some((f) => f.field === "write.id" && /unknown/i.test(f.message))).toBe(true);
  });

  test("empty compiled path is the whole output, not a fault", () => {
    expect(bindingFaults(program()).filter((f) => f.field === "returns")).toEqual([]);
  });

  test("island steps are labeled model, not island", () => {
    const p = withVersion({
      id: "p3",
      name: "reason",
      description: "test",
      inputSchema: { type: "object" },
      steps: [{ id: "think", kind: "island", input: { kind: "input", path: "q" }, system: "go", outputSchema: {} }],
      returns: { kind: "from", step: "think", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    });
    const g = layoutProgram(p);
    const node = g.nodes.find((n) => n.id === "think")!;
    expect(node.kind).toBe("island");
    expect(node.label).toBe("model");
    expect(node.tokenClass).toBe("compiled");
  });

  test("token classes: island compiled, skipped steered-skip, live tools compiled, else frontier, assert unlabeled", () => {
    expect(tokenClassForNode({ id: "think", kind: "island" })).toBe("compiled");
    expect(tokenClassForNode({ id: "think", kind: "island" }, { memoized: true })).toBe("memoized");
    expect(tokenClassForNode({ id: "lookup", kind: "tool", tool: "lookupTicket" }, { skipped: ["lookupTicket"] })).toBe(
      "steered-skip",
    );
    expect(tokenClassForNode({ id: "lookup", kind: "tool", tool: "lookupTicket" }, { compiledRan: true })).toBe("compiled");
    expect(tokenClassForNode({ id: "lookup", kind: "tool", tool: "lookupTicket" })).toBe("frontier");
    expect(tokenClassForNode({ id: "lookup", kind: "tool", tool: "lookupTicket" }, { transparent: true })).toBe("transparent");
    expect(tokenClassForNode({ id: "lookup", kind: "tool", tool: "lookupTicket" }, { skipped: ["lookupTicket"], transparent: true })).toBe(
      "steered-skip",
    );
    expect(tokenClassForNode({ id: "check", kind: "assert" })).toBeUndefined();
    expect(tokenClassForNode({ id: "each", kind: "loop" })).toBeUndefined();
    expect(tokenClassForNode({ id: "branch_state", kind: "branch" })).toBeUndefined();
  });

  test("layout stamps skipped receipt names as steered-skip", () => {
    const g = layoutProgram(program(), { skipped: ["writeRecord"], compiledRan: true });
    expect(g.nodes.find((n) => n.id === "lookup")!.tokenClass).toBe("compiled");
    expect(g.nodes.find((n) => n.id === "write")!.tokenClass).toBe("steered-skip");
    expect(g.nodes.find((n) => n.id === "check")!.tokenClass).toBeUndefined();
  });

  test("layout stamps transparent serving on tools that actually ran", () => {
    const g = layoutProgram(program(), { transparent: true, skipped: ["writeRecord"] });
    expect(g.nodes.find((n) => n.id === "lookup")!.tokenClass).toBe("transparent");
    expect(g.nodes.find((n) => n.id === "write")!.tokenClass).toBe("steered-skip");
  });

  test("five-class ledger names every class and sums; cache stays off the sum line", () => {
    const line = tokenClassLedgerLine({
      compiled: 100,
      memoized: 0,
      transparent: 20,
      steeredSkip: 0,
      frontier: 50,
      providerCache: 999,
    });
    expect(line).toBe("compiled 100 · memoized 0 · transparent 20 · steered-skip 0 · frontier 50 = 170");
    expect(line).toContain("compiled");
    expect(line).toContain("memoized");
    expect(line).toContain("transparent");
    expect(line).toContain("steered-skip");
    expect(line).toContain("frontier");
    expect(line).not.toContain("999");
    expect(line).not.toMatch(/cache/i);
  });

  test("ledger names mismatch when billed does not equal prompt+completion — no fake share", () => {
    const classes = {
      compiled: 100,
      memoized: 0,
      transparent: 20,
      steeredSkip: 0,
      frontier: 50,
    };
    expect(tokenClassLedgerReconcileLine(classes, { prompt: 100, completion: 70 })).toBe(
      "compiled 100 · memoized 0 · transparent 20 · steered-skip 0 · frontier 50 = 170 · prompt+completion 170",
    );
    expect(tokenClassLedgerReconcileLine(classes, { prompt: 100, completion: 40 })).toBe(
      "compiled 100 · memoized 0 · transparent 20 · steered-skip 0 · frontier 50 = 170 · prompt+completion 140 · mismatch",
    );
    expect(tokenClassLedgerReconcileLine(classes, { prompt: 100, completion: 40 })).not.toMatch(/40%/);
    expect(tokenClassLedgerReconcileLine(classes)).toBe(
      "compiled 100 · memoized 0 · transparent 20 · steered-skip 0 · frontier 50 = 170",
    );
  });

  test("provider cache hit % is a separate graphite line; omitted when unmeasured; not run-cache reads", () => {
    expect(nodeProviderCacheHitLine({ cached_tokens: 1920, prompt_tokens: 2006 })).toBe("provider cache hit % 96%");
    expect(
      nodeProviderCacheHitLine({
        cached_tokens: 40,
        prompt_tokens: 50,
        cache_write_tokens: 10,
        cache_input_tokens: 100,
      }),
    ).toBe("provider cache hit % 40%");
    expect(nodeProviderCacheHitLine({ cached_tokens: 0, prompt_tokens: 100 })).toBe("provider cache hit % 0%");
    expect(nodeProviderCacheHitLine({ prompt_tokens: 50 })).toBeNull();
    expect(nodeProviderCacheHitLine({ cached_tokens: 40 })).toBeNull();
    expect(nodeProviderCacheHitLine(null)).toBeNull();
    expect(nodeProviderCacheHitLine({})).toBeNull();
    expect(nodeProviderCacheHitLine({ cached_tokens: 1920, prompt_tokens: 2006 })).not.toMatch(/3 of 4 reads/);
    expect(
      tokenClassLedgerReconcileLine(
        { compiled: 100, memoized: 0, transparent: 20, steeredSkip: 0, frontier: 50 },
        { prompt: 100, completion: 40 },
      ),
    ).toMatch(/mismatch/);
    expect(
      tokenClassLedgerReconcileLine(
        { compiled: 100, memoized: 0, transparent: 20, steeredSkip: 0, frontier: 50 },
        { prompt: 100, completion: 40 },
      ),
    ).not.toMatch(/provider cache hit/);
  });

  test("branch-ci-gate: one branch gate, then/else as parallel columns after it", async () => {
    const { compileTraces } = await import("../../../../packages/compile/src/index");
    const { CORPUS } = await import("../../../../packages/compile/src/corpus/fixtures");
    const fixture = CORPUS.find((f) => f.name === "branch-ci-gate");
    expect(fixture).toBeDefined();
    const { programs } = compileTraces(fixture!.traces);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "branch"));
    expect(p, "corpus branch-ci-gate compiles a branch program").toBeDefined();
    if (!p) return;

    const gateStep = p.steps.find((s) => s.kind === "branch");
    expect(gateStep?.kind).toBe("branch");
    if (gateStep?.kind !== "branch") return;

    expect(methodSteps(p).some((s) => gateStep.then.includes(s.id))).toBe(false);
    expect(methodSteps(p).some((s) => (gateStep.else ?? []).includes(s.id))).toBe(false);

    const g = layoutProgram(p);
    const gate = g.nodes.find((n) => n.kind === "branch")!;
    expect(g.nodes.filter((n) => n.kind === "branch")).toHaveLength(1);
    expect(gate.label).toBe("branch");
    expect(g.nodes.filter((n) => n.label === "check")).toEqual([]);

    const thenHead = g.nodes.find((n) => n.id === gateStep.then[0])!;
    const elseHead = g.nodes.find((n) => n.id === (gateStep.else ?? [])[0])!;
    expect(thenHead).toBeDefined();
    expect(elseHead).toBeDefined();
    expect(thenHead.col).toBe(elseHead.col);
    expect(thenHead.col).toBeGreaterThan(gate.col);
    expect(thenHead.row).not.toBe(elseHead.row);

    const prefix = g.nodes.find((n) => n.id === methodSteps(p)[0]!.id)!;
    expect(prefix.col).toBeLessThan(gate.col);

    expect(g.nodes.every((n) => n.col === 0)).toBe(false);
    expect(g.nodes.length).toBeGreaterThanOrEqual(3);
    expect(strippedFromMethod(p)).not.toContain(gateStep.id);

    expect(gateStep.expr.length).toBeGreaterThan(0);
    expect(g.edges).toContainEqual({ from: prefix.id, to: gate.id, field: "expr", path: gateStep.expr });
    expect(g.edges).toContainEqual({ from: gate.id, to: thenHead.id, field: "then", path: "" });
    expect(g.edges).toContainEqual({ from: gate.id, to: elseHead.id, field: "else", path: "" });
    expect(stepAccessLine(gateStep)).toContain(gateStep.expr);
    expect(stepAccessLine(gateStep)).not.toBe("Branch. Both arms witnessed before shipping.");
    expect(witnessLines(gateStep)).toEqual([{ field: "expr", text: gateStep.expr }]);
  });

  test("branch gate wire is prefix → gate on expr, not a from binding", () => {
    const p = withVersion({
      id: "p-br",
      name: "ci_gate",
      description: "test",
      inputSchema: { type: "object" },
      steps: [
        { id: "get_ci", kind: "tool", tool: "get_ci", args: { pr: { kind: "input", path: "pr" } }, readOnly: true },
        {
          id: "branch_state",
          kind: "branch",
          expr: 'state == "green"',
          then: ["merge_pr"],
          else: ["comment_pr"],
        },
        { id: "merge_pr", kind: "tool", tool: "merge_pr", args: { pr: { kind: "input", path: "pr" } } },
        { id: "comment_pr", kind: "tool", tool: "comment_pr", args: { pr: { kind: "input", path: "pr" } } },
      ],
      returns: { kind: "from", step: "merge_pr", path: "" },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    });
    const g = layoutProgram(p);
    expect(g.edges).toContainEqual({
      from: "get_ci",
      to: "branch_state",
      field: "expr",
      path: 'state == "green"',
    });
    expect(g.edges).toContainEqual({ from: "branch_state", to: "merge_pr", field: "then", path: "" });
    expect(g.edges).toContainEqual({ from: "branch_state", to: "comment_pr", field: "else", path: "" });
    expect(g.edges.every((e) => e.field !== "from")).toBe(true);
    expect(stepAccessLine(p.steps.find((s) => s.kind === "branch")!)).toBe(
      'Branch. state == "green". Both arms witnessed before shipping.',
    );
  });
});

describe("canvas model envelope on a laid-out program", () => {
  test("envelope line is frozen copy on the program contract", async () => {
    const { envelopeLine } = await import("@eden/ir");
    const { programDecor } = await import("./contract");
    const p = program();
    p.contract.envelope = { inputs: { id: ["T-1", "T-2"], n: ["a"] } };
    expect(programDecor(p).envelopeLine).toBe("Envelope · 2 keys · 3 values");
    expect(programDecor(p).envelopeLine).toBe(envelopeLine(p.contract.envelope));
    expect(layoutProgram(p).nodes.length).toBeGreaterThan(0);
  });
});
