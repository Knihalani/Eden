import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import { withVersion } from "@eden/ir";
import { bindingFaults, layoutProgram, methodSteps, strippedFromMethod } from "./layout-program";

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
  });
});
