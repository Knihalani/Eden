/**
 * Wave 10.2 CI pin: sibling-width inherit after K=3 clean live receipts.
 * Mined at width 10; width 7 stays OOD until the 3rd receipt.
 *
 *   bun test benchmarks/campaign/width-inherit.test.ts
 */
import { describe, expect, test } from "bun:test";
import { inDistribution, WIDTH_INHERIT_K } from "@eden/ir";
import { inheritWidth, siblingWidthReceipts } from "@eden/compile";
import { rollEnvelope, rollHoldout } from "@eden/shadow";
import {
  EXPECT,
  K,
  MINED_WIDTH,
  SIBLING_WIDTH,
  badWidth7Receipt,
  fourthWidth7Stretch,
  mineWidth10,
  width10Traces,
  width7Receipt,
  width7Receipts,
} from "./width-inherit";

describe("rotation: sibling-width inherit (Wave 10)", () => {
  test("pre-registered expect is width inherit, not a retune of orders cents", () => {
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("width 10");
    expect(EXPECT).toContain("width-7");
    expect(EXPECT).toContain("3rd inherits");
    expect(EXPECT.toLowerCase()).not.toMatch(/orders cents|long-orders/);
    expect(K).toBe(WIDTH_INHERIT_K);
    expect(MINED_WIDTH).toBe(10);
    expect(SIBLING_WIDTH).toBe(7);
  });

  test("mined at width 10; 2 width-7 receipts stay OOD; 3rd inherits; 4th serves; bad does not inherit", () => {
    const program = mineWidth10();
    expect(program.steps.some((s) => s.kind === "loop")).toBe(true);
    const envKeys = Object.keys(program.contract.envelope?.inputs ?? {});
    expect(envKeys.length).toBeGreaterThan(0);
    expect(envKeys).toContain("orderId");

    const minedIds = program.contract.envelope!.inputs.orderId as unknown[];
    expect(minedIds).toEqual(expect.arrayContaining(["O-10-0", "O-10-1", "O-10-2"]));

    const two = width7Receipts(2);
    const after2 = inheritWidth(program, two);
    expect(after2).toBe(program);
    expect(siblingWidthReceipts(program, two)).toHaveLength(2);
    for (const r of two) {
      expect(inDistribution(after2, r.input)).toBe(false);
    }

    const three = width7Receipts(3);
    const after3 = inheritWidth(program, three);
    expect(after3).not.toBe(program);
    expect(siblingWidthReceipts(program, three)).toHaveLength(3);
    for (const r of three) {
      expect(inDistribution(after3, r.input)).toBe(true);
    }
    expect(after3.contract.envelope!.inputs.orderId).toEqual(
      expect.arrayContaining(["O-10-0", "O-10-1", "O-10-2", "O-7-0", "O-7-1", "O-7-2"]),
    );
    expect(Object.keys(after3.contract.envelope!.inputs).sort()).toEqual(envKeys.sort());

    const fourth = fourthWidth7Stretch(three[0]!.input);
    expect(inDistribution(after3, fourth.input)).toBe(true);

    const poisoned = inheritWidth(program, [...two, badWidth7Receipt()]);
    expect(poisoned).toBe(program);
    expect(inDistribution(poisoned, width7Receipt(0).input)).toBe(false);

    const extra = inheritWidth(program, [
      ...three,
      { ok: true, input: { orderId: "O-7-0", invented: "nope" }, events: three[0]!.events },
    ]);
    expect(extra.contract.envelope!.inputs.invented).toBeUndefined();

    console.log(
      `width-inherit: mined=${MINED_WIDTH} sibling=${SIBLING_WIDTH} k=${K} after2_ood=2/2 after3_in_dist=3/3 fourth_in_dist=true bad_inherit=false`,
    );
  });

  test("rolling shadow refreshes in-distribution receipts and ignores OOD / failed", () => {
    const program = mineWidth10();
    const witnessed = { ok: true as const, input: { orderId: "O-10-0" } };
    const rolled = rollEnvelope(program, witnessed);
    expect(inDistribution(rolled, witnessed.input)).toBe(true);
    expect(rolled.contract.envelope!.inputs.invented).toBeUndefined();

    const novel = { ok: true as const, input: { orderId: "O-7-0" } };
    expect(rollEnvelope(program, novel)).toBe(program);

    const failed = { ok: false, input: { orderId: "O-10-0" } };
    expect(rollEnvelope(program, failed)).toBe(program);

    const held = width10Traces().slice(0, 3);
    expect(rollHoldout(held, program, witnessed)).toHaveLength(4);
    expect(rollHoldout(held, program, novel)).toHaveLength(3);
    expect(rollHoldout(held, program, failed)).toHaveLength(3);
  });
});
