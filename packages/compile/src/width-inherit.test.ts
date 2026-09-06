import { describe, expect, test } from "bun:test";
import { inDistribution, withVersion, WIDTH_INHERIT_K, type StretchProgram } from "@eden/ir";
import { inheritWidth, siblingWidthReceipts } from "./width-inherit";

const SEQ10 = ["findOrder", ...Array.from({ length: 10 }, () => "checkStock"), "issueRefund", "sendReceipt"];

function mined(ids: string[]): StretchProgram {
  return withVersion({
    id: "p",
    name: "p",
    description: "p",
    inputSchema: { type: "object" },
    steps: [{ id: "t", kind: "tool" as const, tool: "findOrder", args: {} }],
    returns: { kind: "literal" as const, value: null },
    sequence: SEQ10,
    contract: {
      witnesses: ids.length,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { orderId: ids } },
    },
    manifest: null,
  });
}

function width7(orderId: string): { ok: true; input: { orderId: string }; events: Array<{ name: string; ok: true }> } {
  return {
    ok: true,
    input: { orderId },
    events: [
      { name: "findOrder", ok: true },
      ...Array.from({ length: 7 }, () => ({ name: "checkStock", ok: true as const })),
      { name: "issueRefund", ok: true },
      { name: "sendReceipt", ok: true },
    ],
  };
}

describe("inheritWidth", () => {
  test("K is 3; before K the envelope is unchanged", () => {
    expect(WIDTH_INHERIT_K).toBe(3);
    const p = mined(["O-10-0", "O-10-1", "O-10-2"]);
    const two = [width7("O-7-0"), width7("O-7-1")];
    expect(siblingWidthReceipts(p, two)).toHaveLength(2);
    expect(inheritWidth(p, two)).toBe(p);
    expect(inDistribution(p, { orderId: "O-7-0" })).toBe(false);
  });

  test("3rd sibling-width receipt inherits existing keys only", () => {
    const p = mined(["O-10-0"]);
    const three = [width7("O-7-0"), width7("O-7-1"), width7("O-7-2")];
    const next = inheritWidth(p, three);
    expect(inDistribution(next, { orderId: "O-7-0" })).toBe(true);
    expect(next.contract.envelope!.inputs.orderId).toEqual(["O-10-0", "O-7-0", "O-7-1", "O-7-2"]);
    const withExtra = inheritWidth(p, [...three, { ...width7("O-7-0"), input: { orderId: "O-7-0", extra: "nope" } }]);
    expect(withExtra.contract.envelope!.inputs.extra).toBeUndefined();
  });

  test("fail-open: bad receipt does not count toward K", () => {
    const p = mined(["O-10-0"]);
    const mixed = [width7("O-7-0"), width7("O-7-1"), { ok: false as const, input: { orderId: "O-7-2" }, events: width7("O-7-2").events }];
    expect(inheritWidth(p, mixed)).toBe(p);
  });

  test("ok+input receipts without events still inherit after K", () => {
    const p = mined(["O-10-0"]);
    const bare = (id: string) => ({ ok: true as const, input: { orderId: id } });
    expect(inheritWidth(p, [bare("O-7-0"), bare("O-7-1")])).toBe(p);
    const next = inheritWidth(p, [bare("O-7-0"), bare("O-7-1"), bare("O-7-2")]);
    expect(inDistribution(next, { orderId: "O-7-2" })).toBe(true);
  });

  test("different collapsed order is not a sibling", () => {
    const p = mined(["O-10-0"]);
    const other = Array.from({ length: 3 }, (_, i) => ({
      ok: true as const,
      input: { orderId: `X-${i}` },
      events: [
        { name: "lookupTicket", ok: true as const },
        { name: "writeRecord", ok: true as const },
        { name: "notify", ok: true as const },
      ],
    }));
    expect(siblingWidthReceipts(p, other)).toHaveLength(0);
    expect(inheritWidth(p, other)).toBe(p);
  });
});
