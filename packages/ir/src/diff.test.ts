import { describe, expect, test } from "bun:test";
import { diffPrograms, formatDiffCard, withVersion } from "../src/index";
import type { Binding, StretchProgram } from "../src/index";

const program = (over: Partial<StretchProgram> = {}): StretchProgram =>
  withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }],
    returns: { kind: "from", step: "a", path: "" },
    contract: { witnesses: 3, minLlmReduction: 5, allowExact: false },
    manifest: null,
    ...over,
  });

describe("diffPrograms", () => {
  test("identical programs yield an empty diff", () => {
    const a = program();
    const b = program();
    expect(diffPrograms(a, b)).toEqual({
      name_changed: false,
      steps_added: [],
      steps_removed: [],
      bindings_changed: [],
      literals_introduced: [],
      asserts_tightened: 0,
      asserts_loosened: 0,
      contract_changed: false,
      contract_changes: [],
      readonly_flips: [],
    });
  });

  test("manifest or witnesses-only change is not a structural diff", () => {
    // hashProgram covers contract.witnesses, so every re-mine gets a new
    // version even when nothing a reviewer votes on moved.
    const b = {
      ...program(),
      version: "different-hash",
      manifest: { llmReduction: 9 } as StretchProgram["manifest"],
      contract: { witnesses: 4, minLlmReduction: 5, allowExact: false },
    };
    const d = diffPrograms(program(), b);
    expect(d.contract_changed).toBe(true); // witnesses are contract
    expect(d.contract_changes).toEqual(["witnesses 3 -> 4"]);
    expect(d.steps_added).toEqual([]);
    expect(d.steps_removed).toEqual([]);
    expect(d.bindings_changed).toEqual([]);
    expect(d.literals_introduced).toEqual([]);
    expect(d.name_changed).toBe(false);
  });

  test("drop and add of steps", () => {
    const oldP = program({
      steps: [
        { id: "a", kind: "tool", tool: "x", args: {} },
        { id: "b", kind: "tool", tool: "y", args: {} },
      ],
    });
    const newP = program({
      steps: [
        { id: "a", kind: "tool", tool: "x", args: {} },
        { id: "c", kind: "island", input: { kind: "input", path: "" }, system: "s", outputSchema: {} },
      ],
    });
    const d = diffPrograms(oldP, newP);
    expect(d.steps_removed).toEqual([{ id: "b" }]);
    expect(d.steps_added).toEqual([{ id: "c", kind: "island" }]);
  });

  test("rebinding surfaces as a kind change with detail", () => {
    const oldP = program({
      steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "from", step: "root", path: "id" } } }],
    });
    const newP = program({ steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }] });
    const d = diffPrograms(oldP, newP);
    expect(d.bindings_changed).toHaveLength(1);
    expect(d.bindings_changed[0]).toMatchObject({ step: "a", field: "id", from_kind: "from", to_kind: "input" });
    expect(d.literals_introduced).toEqual([]);
  });

  test("a literal where a binding was is flagged for review", () => {
    const newP = program({ steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "literal", value: "T-100" } } }] });
    const d = diffPrograms(program(), newP);
    expect(d.literals_introduced).toEqual([{ step: "a", field: "id" }]);
    expect(d.bindings_changed[0]).toMatchObject({ from_kind: "input", to_kind: "literal" });
    expect(d.bindings_changed[0]?.detail).toContain("hardcoded literal");
  });

  test("a literal that stays a literal is not a review flag", () => {
    const oldP = program({ steps: [{ id: "a", kind: "tool", tool: "x", args: { q: { kind: "literal", value: 1 } } }] });
    const newP = program({ steps: [{ id: "a", kind: "tool", tool: "x", args: { q: { kind: "literal", value: 2 } } }] });
    const d = diffPrograms(oldP, newP);
    expect(d.literals_introduced).toEqual([]);
    expect(d.bindings_changed).toEqual([]);
  });

  test("transform rewrites surface via detail without changing kind", () => {
    const mk = (expr: string): Binding => ({ kind: "transform", fn: "jsonpath", expr, of: { kind: "input", path: "raw" } });
    const d = diffPrograms(
      program({ steps: [{ id: "a", kind: "tool", tool: "x", args: { q: mk("$.a") } }] }),
      program({ steps: [{ id: "a", kind: "tool", tool: "x", args: { q: mk("$.b") } }] }),
    );
    expect(d.bindings_changed).toHaveLength(1);
    expect(d.bindings_changed[0]).toMatchObject({ step: "a", field: "q", from_kind: "transform", to_kind: "transform" });
    expect(d.bindings_changed[0]?.detail).toContain("$.a");
    expect(d.literals_introduced).toEqual([]);
  });

  test("assert tighten and loosen accounting", () => {
    // deopt -> error on the same expr is a tightening; error -> deopt a
    // loosening; a rewritten expr counts as tightened; a dropped assert is a
    // loosening; a fresh one a tightening.
    const assertStep = (onFail: "deopt" | "error", expr = "true"): StretchProgram["steps"][number] => ({
      id: "chk",
      kind: "assert",
      expr,
      onFail,
    });
    const tighten = diffPrograms(program({ steps: [assertStep("deopt")] }), program({ steps: [assertStep("error")] }));
    expect(tighten.asserts_tightened).toBe(1);
    expect(tighten.asserts_loosened).toBe(0);

    const loosen = diffPrograms(program({ steps: [assertStep("error")] }), program({ steps: [assertStep("deopt")] }));
    expect(loosen.asserts_loosened).toBe(1);

    const rewrite = diffPrograms(program({ steps: [assertStep("error", "$.n > 1")] }), program({ steps: [assertStep("error", "$.n > 2")] }));
    expect(rewrite.asserts_tightened).toBe(1);

    const drop = diffPrograms(program({ steps: [assertStep("error")] }), program({ steps: [] }));
    expect(drop.asserts_loosened).toBe(1);

    const add = diffPrograms(program({ steps: [] }), program({ steps: [assertStep("error")] }));
    expect(add.asserts_tightened).toBe(1);
    expect(add.steps_added).toEqual([{ id: "chk", kind: "assert" }]);
  });

  test("contract changes list what moved", () => {
    const d = diffPrograms(program(), program({ contract: { witnesses: 7, minLlmReduction: 5, allowExact: true, envelope: { inputs: {} } } }));
    expect(d.contract_changed).toBe(true);
    expect(d.contract_changes).toEqual(["witnesses 3 -> 7", "allowExact false -> true", "envelope changed"]);
  });

  test("minLlmReduction change alone flags the contract", () => {
    const d = diffPrograms(program(), program({ contract: { witnesses: 3, minLlmReduction: 2, allowExact: false } }));
    expect(d.contract_changed).toBe(true);
    expect(d.contract_changes).toEqual(["minLlmReduction 5 -> 2"]);
  });

  test("readOnly flips are reported with absent read as unknown", () => {
    const oldP = program({ steps: [{ id: "a", kind: "tool", tool: "x", args: {}, readOnly: true }] });
    const newP = program({ steps: [{ id: "a", kind: "tool", tool: "x", args: {}, readOnly: false }] });
    const unknownP = program({ steps: [{ id: "a", kind: "tool", tool: "x", args: {} }] });
    expect(diffPrograms(oldP, newP).readonly_flips).toEqual([{ step: "a", from: true, to: false }]);
    expect(diffPrograms(oldP, unknownP).readonly_flips).toEqual([{ step: "a", from: true, to: "unknown" }]);
  });

  test("name change is reported", () => {
    expect(diffPrograms(program(), program({ name: "t2" })).name_changed).toBe(true);
  });

  test("fail-safe over partial IR", () => {
    // Missing steps arrays and contracts must not throw — this runs on the
    // approve path against whatever the store deserialised.
    const bare = { id: "x", name: "x", description: "", inputSchema: {}, returns: null, manifest: null } as unknown as StretchProgram;
    const d = diffPrograms(bare, bare);
    expect(d.steps_added).toEqual([]);
    expect(d.steps_removed).toEqual([]);
    expect(d.contract_changed).toBe(false);
  });

  test("kind change reads as remove+add rather than half-matched bindings", () => {
    const oldP = program({ steps: [{ id: "a", kind: "loop", over: { kind: "input", path: "xs" }, item: "x", body: ["b"] }] });
    const newP = program({ steps: [{ id: "a", kind: "tool", tool: "x", args: { xs: { kind: "input", path: "xs" } } }] });
    const d = diffPrograms(oldP, newP);
    expect(d.steps_removed).toEqual([{ id: "a" }]);
    expect(d.steps_added).toEqual([{ id: "a", kind: "tool", tool: "x" }]);
    expect(d.bindings_changed).toEqual([]);
  });

  test("formatDiffCard is one screen: name, steps, vs live, witnesses", () => {
    const first = formatDiffCard(null, { name: "desk_close", sequence: ["search", "close"], witnesses: 3, first: true });
    expect(first).toContain("desk_close");
    expect(first).toContain("search → close");
    expect(first).toContain("first version");
    expect(first).toContain("witnesses: 3");
    expect(first).toContain("eden approve desk_close --yes");
    const withId = formatDiffCard(null, {
      name: "desk_close",
      id: "c1",
      sequence: ["search", "close"],
      witnesses: 3,
      first: true,
    });
    expect(withId).toContain("desk_close");
    expect(withId).toContain("eden approve c1 --yes");
    expect(withId).not.toContain("eden approve desk_close --yes");
    const d = diffPrograms(
      program(),
      program({ steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "literal", value: "T" } } }] }),
    );
    const card = formatDiffCard(d, { name: "t", sequence: ["x"] });
    expect(card).toMatch(/literal baked in/);
  });
});
