/**
 * Wave 10 rotation world: sibling-width envelope inherit.
 *
 * A program mined at fan-out width 10 stays raw on width 7 until K=3 clean
 * live receipts of that sibling (same collapsed tool order). The 3rd receipt
 * grows the envelope via inheritEnvelopeValues (existing keys only). A later
 * width-7 stretch of a confirmed id is inDistribution. A bad receipt does
 * not inherit (fail-open).
 *
 * Not a retune of orders cents.
 *
 *   bun test benchmarks/campaign/width-inherit.test.ts
 *
 * Pre-registered expect (ROADMAP §4.9) is `EXPECT` below.
 */
import type { StretchProgram, StretchTrace } from "@eden/ir";
import { inDistribution } from "@eden/ir";
import { compileTraces, inheritWidth, type WidthInheritReceipt } from "@eden/compile";

/**
 * Pre-registered Wave 10 rotation verdict. Recorded before the run.
 * expect: mined width 10; 2 width-7 receipts OOD; 3rd inherits; 4th width-7 inDistribution;
 * bad receipt does not inherit
 */
export const EXPECT =
  "mined at width 10; 2 clean width-7 receipts stay OOD; 3rd inherits; 4th width-7 stretch inDistribution; bad receipt does not inherit";

export const MINED_WIDTH = 10;
export const SIBLING_WIDTH = 7;
export const K = 3;

const CHECK = "checkStock";

export function fanoutEvents(orderId: string, width: number): StretchTrace["events"] {
  const ids = Array.from({ length: width }, (_, j) => `${orderId}-sku-${j}`);
  return [
    { name: "findOrder", args: { orderId }, result: { orderId, items: ids, paid: true }, ok: true },
    ...ids.map((itemId) => ({
      name: CHECK,
      args: { itemId },
      result: { itemId, inStock: true },
      ok: true,
    })),
    { name: "issueRefund", args: { orderId }, result: { refunded: true }, ok: true },
    { name: "sendReceipt", args: { orderId }, result: { sent: true }, ok: true },
  ];
}

export function fanoutTrace(orderId: string, width: number, i: number): StretchTrace {
  return {
    id: `w${width}-${i}`,
    llmCalls: width + 4,
    duration_ms: 40,
    cost_cents: width,
    complete: true,
    input: { orderId },
    output: { sent: true },
    events: fanoutEvents(orderId, width),
  };
}

/** Three unique width-10 witnesses — enough to mine, not a retune of orders. */
export function width10Traces(): StretchTrace[] {
  return Array.from({ length: 3 }, (_, i) => fanoutTrace(`O-10-${i}`, MINED_WIDTH, i));
}

export function mineWidth10(): StretchProgram {
  const { programs, refusals } = compileTraces(width10Traces());
  const p = programs.find((q) => q.steps.some((s) => s.kind === "loop")) ?? programs[0];
  if (!p) {
    throw new Error(`width-10 mine produced no program: ${refusals.map((r) => r.reason).join("; ") || "empty"}`);
  }
  return p;
}

export function width7Receipt(i: number): WidthInheritReceipt & { ok: true; input: { orderId: string } } {
  const orderId = `O-7-${i}`;
  return {
    ok: true,
    input: { orderId },
    events: fanoutEvents(orderId, SIBLING_WIDTH),
  };
}

export function badWidth7Receipt(): WidthInheritReceipt {
  return {
    ok: false,
    input: { orderId: "O-7-bad" },
    events: fanoutEvents("O-7-bad", SIBLING_WIDTH),
  };
}

/** Later stretch of a confirmed sibling id — not a newly invented value. */
export function fourthWidth7Stretch(confirmed: { orderId: string }): {
  input: { orderId: string };
  events: StretchTrace["events"];
} {
  return {
    input: { orderId: confirmed.orderId },
    events: fanoutEvents(confirmed.orderId, SIBLING_WIDTH),
  };
}

export function width7Receipts(n: number): Array<WidthInheritReceipt & { ok: true; input: { orderId: string } }> {
  return Array.from({ length: n }, (_, i) => width7Receipt(i));
}

export function isOod(program: StretchProgram, input: Record<string, unknown>): boolean {
  return !inDistribution(program, input);
}
