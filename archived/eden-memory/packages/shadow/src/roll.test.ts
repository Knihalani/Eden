import { describe, expect, test } from "bun:test";
import { inDistribution, withVersion, type StretchProgram } from "@eden/ir";
import { rollEnvelope, rollHoldout } from "./roll";

function mini(ids: unknown[]): StretchProgram {
  return withVersion({
    id: "p",
    name: "p",
    description: "p",
    inputSchema: { type: "object" },
    steps: [{ id: "t", kind: "tool" as const, tool: "noop", args: {} }],
    returns: { kind: "literal" as const, value: null },
    contract: {
      witnesses: ids.length,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { id: ids } },
    },
    manifest: null,
  });
}

describe("rollEnvelope / rollHoldout", () => {
  test("in-distribution ok receipt refreshes via inheritEnvelopeValues only", () => {
    const p = mini(["T-1", "T-2"]);
    const next = rollEnvelope(p, { ok: true, input: { id: "T-1", extra: "nope" } });
    expect(inDistribution(next, { id: "T-1" })).toBe(true);
    expect(next.contract.envelope!.inputs.id).toEqual(["T-1", "T-2"]);
    expect(next.contract.envelope!.inputs.extra).toBeUndefined();
    expect(next).toBe(p);
  });

  test("OOD receipt does not grow the envelope", () => {
    const p = mini(["T-1"]);
    const next = rollEnvelope(p, { ok: true, input: { id: "T-9" } });
    expect(next).toBe(p);
    expect(inDistribution(p, { id: "T-9" })).toBe(false);
  });

  test("failed receipt fails open", () => {
    const p = mini(["T-1"]);
    expect(rollEnvelope(p, { ok: false, input: { id: "T-1" } })).toBe(p);
    expect(rollHoldout([], p, { ok: false, input: { id: "T-1" } })).toEqual([]);
  });

  test("hold-out grows only from clean in-distribution receipts", () => {
    const p = mini(["T-1"]);
    const held = rollHoldout([], p, { ok: true, input: { id: "T-1" } });
    expect(held).toHaveLength(1);
    expect(held[0]!.input).toEqual({ id: "T-1" });
    expect(rollHoldout(held, p, { ok: true, input: { id: "T-9" } })).toHaveLength(1);
  });
});
