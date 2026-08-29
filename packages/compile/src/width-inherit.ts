/**
 * Width-class envelope inheritance (Wave 10.1).
 *
 * A program mined at one fan-out width stays raw on a sibling width until
 * K clean live receipts of that sibling (same collapsed tool order). Then
 * the envelope grows via inheritEnvelopeValues — existing keys only, never
 * invented ones. Before K the envelope is unchanged.
 *
 * Live receipts are `{ ok, input }`. Events, when present, prove shape and
 * width; a different collapsed order is not a sibling.
 */
import type { StretchProgram } from "@eden/ir";
import {
  honestyShape,
  honestyWidth,
  inDistribution,
  inheritEnvelopeValues,
  shouldInheritWidth,
  withVersion,
} from "@eden/ir";

export type WidthInheritReceipt = {
  ok: boolean;
  input?: Record<string, unknown>;
  events?: Array<{ name: string; ok?: boolean; skipped?: boolean }>;
};

function okNames(receipt: WidthInheritReceipt): string[] | null {
  if (!receipt.events) return null;
  const out: string[] = [];
  for (const e of receipt.events) {
    if (e.ok === false || e.skipped) continue;
    if (typeof e.name === "string" && e.name) out.push(e.name);
  }
  return out;
}

/**
 * Clean live receipts of a sibling fan-out width: ok, has input, currently
 * out of distribution, and (when events exist) the same collapsed tool order
 * at a different honestyWidth than the mined sequence.
 */
export function siblingWidthReceipts(
  program: StretchProgram,
  receipts: readonly WidthInheritReceipt[],
): WidthInheritReceipt[] {
  const seq = program.sequence;
  const minedWidth = seq?.length ? honestyWidth(seq) : 0;
  const minedShape = seq?.length ? honestyShape(seq) : "";
  const out: WidthInheritReceipt[] = [];
  for (const r of receipts) {
    if (r.ok !== true || !r.input) continue;
    const names = okNames(r);
    if (names) {
      if (minedShape && honestyShape(names) !== minedShape) continue;
      const liveWidth = honestyWidth(names);
      if (minedWidth > 1 && liveWidth === minedWidth) continue;
      if (minedWidth <= 1 && liveWidth <= 1) continue;
    }
    if (inDistribution(program, r.input)) continue;
    out.push(r);
  }
  return out;
}

/**
 * After K sibling-width receipts, return a new program whose envelope has
 * absorbed those confirmed live values. Before K, the same program.
 * Fail-open: `ok: false` does not count and does not write.
 */
export function inheritWidth(program: StretchProgram, receipts: readonly WidthInheritReceipt[]): StretchProgram {
  const env = program.contract.envelope;
  if (!env) return program;
  const siblings = siblingWidthReceipts(program, receipts);
  if (!shouldInheritWidth(siblings.length)) return program;
  let next = env;
  for (const r of siblings) {
    if (r.input) next = inheritEnvelopeValues(next, r.input);
  }
  return withVersion({
    ...program,
    contract: { ...program.contract, envelope: next },
  });
}
