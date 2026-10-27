/**
 * Frozen Determinism Coverage (DC%) definition — ROADMAP §0 / §13 / Arc 1.
 *
 * Product aggregation (Wave 2) must match this arithmetic. Provider cache
 * hits are a separate line and MUST NOT be blended into DC%.
 *
 *   DC% = (compiled + memoized + transparent + steeredSkip) / total
 *   total = those four + frontier
 */
import type { TokenClasses } from "@eden/ir";

export type { TokenClasses } from "@eden/ir";
export { billedTokens, emptyTokenClasses, reconcileTokenClasses } from "@eden/ir";

export function dcShare(c: TokenClasses): number {
  const det = c.compiled + c.memoized + c.transparent + c.steeredSkip;
  const total = det + c.frontier;
  if (!(total > 0)) return 0;
  return det / total;
}

export function dcPct(c: TokenClasses): number {
  return dcShare(c) * 100;
}
