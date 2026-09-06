import { describe, expect, test } from "bun:test";
import type { Binding, Step, StretchTrace } from "@eden/ir";
import { compileTraces } from "./index";

/**
 * A readable snapshot of what the compiler decides.
 *
 * The binder and the miner are full of caches and early exits, and three of
 * them were added purely for speed. Nothing in the unit tests would have
 * noticed if one of those had quietly changed a binding from `from` to a baked
 * literal, or dropped a step. This pins the shape of the output — names,
 * sequences, step kinds, binding kinds, refusal reasons — so a performance
 * change has to be output-preserving or explain itself.
 *
 * Deliberately structural rather than a hash: a diff here should say what
 * changed, not merely that something did.
 */

function synth(n: number, len: number, salt: number): StretchTrace[] {
  const tools = [
    "lookup",
    "fetchDetails",
    "parseFields",
    "validate",
    "draftReply",
    "writeRecord",
    "verifyWrite",
    "notify",
    "tagItem",
    "closeItem",
  ];
  return Array.from({ length: n }, (_, i) => ({
    id: `s${salt}-${i}`,
    llmCalls: len,
    duration_ms: 10 * len,
    cost_cents: len,
    input: { id: `X-${i}`, tag: `T${i % 3}` },
    events: Array.from({ length: len }, (_, j) => ({
      name: tools[(j + salt) % tools.length]!,
      args: { id: `X-${i}`, seq: j, tag: `T${i % 3}` },
      result: { ok: true, id: `X-${i}`, n: j, nested: { deep: `d${i}` } },
      ok: true,
    })),
  }));
}

const bindingKind = (b: Binding): string => (b.kind === "transform" ? `transform:${b.fn}` : b.kind);

/** One line per step: enough to read, enough to break on a real change. */
function shape(step: Step): string {
  if (step.kind === "tool") {
    const args = Object.entries(step.args)
      .map(([k, b]) => `${k}=${bindingKind(b)}`)
      .sort()
      .join(",");
    // id as well as tool: a wrapped stretch can call the same tool twice, and
    // the ids are what the bindings actually reference.
    return `tool ${step.id}:${step.tool}(${args})`;
  }
  if (step.kind === "island") return `island ${step.id}<-${bindingKind(step.input)}`;
  if (step.kind === "loop") return `loop ${step.id} over ${bindingKind(step.over)} body=${step.body.join("+")}`;
  if (step.kind === "branch") {
    const cases = (step.cases ?? []).map((c) => `${c.expr}->${c.steps.join("+")}`).join(";");
    return `branch ${step.expr} then=${step.then.join("+")} else=${(step.else ?? []).join("+")}${cases ? ` cases=${cases}` : ""}`;
  }
  return `assert ${step.expr} onFail=${step.onFail}`;
}

describe("compile golden", () => {
  test("a uniform stretch compiles to a stable program", () => {
    const { programs, refusals } = compileTraces(synth(40, 12, 0));
    expect(refusals).toEqual([]);
    expect(programs).toHaveLength(1);
    const p = programs[0]!;
    // 12 events over a 10-tool rotation, so the stretch wraps and the last two
    // tools repeat. That wrap is why `notify` is not the terminal step and the
    // name is derived from the first and last of the mined window.
    expect(p.name).toBe("lookup_to_fetchDetails");
    expect(p.sequence).toEqual([
      "lookup",
      "fetchDetails",
      "parseFields",
      "validate",
      "draftReply",
      "writeRecord",
      "verifyWrite",
      "notify",
      "tagItem",
      "closeItem",
      "lookup",
      "fetchDetails",
    ]);
    expect(p.steps.map(shape)).toEqual([
      "tool lookup:lookup(id=input,seq=literal,tag=input)",
      "tool fetchDetails:fetchDetails(id=input,seq=literal,tag=input)",
      "tool parseFields:parseFields(id=input,seq=literal,tag=input)",
      "tool validate:validate(id=input,seq=literal,tag=input)",
      // `validate` is a check name, so a boolean assert is pinned after it.
      "assert ok == true onFail=deopt",
      "island draftReply<-input",
      "tool writeRecord:writeRecord(id=input,seq=literal,tag=input)",
      "tool verifyWrite:verifyWrite(id=input,seq=literal,tag=input)",
      "assert ok == true onFail=deopt",
      "tool notify:notify(id=input,seq=literal,tag=input)",
      "tool tagItem:tagItem(id=input,seq=literal,tag=input)",
      "tool closeItem:closeItem(id=input,seq=literal,tag=input)",
      "tool lookup_2:lookup(id=input,seq=literal,tag=input)",
      "tool fetchDetails_2:fetchDetails(id=input,seq=literal,tag=input)",
    ]);
    expect(p.contract.witnesses).toBe(40);
    expect(Object.keys(p.contract.envelope?.inputs ?? {}).sort()).toEqual(["id", "tag"]);
  });

  test("the program version is content-addressed and reproducible", () => {
    const a = compileTraces(synth(20, 12, 1)).programs[0]!;
    const b = compileTraces(synth(20, 12, 1)).programs[0]!;
    expect(a.version).toBe(b.version);
    expect(a.id).toBe(b.id);
  });

  test("more witnesses bump the version but keep the tool identity", () => {
    // The distinction the store depends on. `id` says which stretch this is, so
    // approving, pausing, rolling back and the `prev` version stack all keep
    // working as evidence accumulates. `version` says which compilation it is,
    // so a widened envelope is still visible as a change.
    const a = compileTraces(synth(20, 12, 1)).programs[0]!;
    const b = compileTraces(synth(21, 12, 1)).programs[0]!;
    expect(a.id).toBe(b.id);
    expect(a.version).not.toBe(b.version);
    expect(a.steps.map(shape)).toEqual(b.steps.map(shape));
    expect(a.contract.witnesses).not.toBe(b.contract.witnesses);
  });

  test("a different stretch gets a different identity", () => {
    const a = compileTraces(synth(20, 12, 1)).programs[0]!;
    const b = compileTraces(synth(20, 14, 5)).programs[0]!;
    expect(a.sequence).not.toEqual(b.sequence!);
    expect(a.id).not.toBe(b.id);
  });

  test("two distinct stretches compile separately, longest first", () => {
    const { programs } = compileTraces([...synth(20, 12, 1), ...synth(20, 14, 5)]);
    const seqs = programs.map((p) => p.sequence!.length);
    expect(programs.length).toBeGreaterThanOrEqual(2);
    expect([...seqs]).toEqual([...seqs].sort((x, y) => y - x));
  });

  test("allowExact only widens what can bind, never narrows it", () => {
    const traces = synth(30, 20, 3);
    const strict = compileTraces(traces, { allowExact: false });
    const loose = compileTraces(traces, { allowExact: true });
    expect(loose.programs.length).toBeGreaterThanOrEqual(strict.programs.length);
    expect(loose.refusals.length).toBeLessThanOrEqual(strict.refusals.length);
  });

  test("compilation is deterministic across repeated runs", () => {
    const traces = synth(25, 16, 2);
    const runs = [0, 1, 2].map(() => {
      const r = compileTraces(traces);
      return JSON.stringify({
        programs: r.programs.map((p) => ({ v: p.version, steps: p.steps.map(shape) })),
        refusals: r.refusals.map((x) => x.reason),
      });
    });
    expect(runs[1]).toBe(runs[0]!);
    expect(runs[2]).toBe(runs[0]!);
  });

  test("trace order does not change the compiled program", () => {
    // The binder walks witnesses in order and short-circuits once the candidate
    // set empties, so a reordering must not be able to change which producer
    // survives.
    const traces = synth(24, 12, 4);
    const forward = compileTraces(traces).programs[0]!;
    const reversed = compileTraces([...traces].reverse()).programs[0]!;
    expect(reversed.steps.map(shape)).toEqual(forward.steps.map(shape));
    expect(reversed.version).toBe(forward.version);
  });
});
