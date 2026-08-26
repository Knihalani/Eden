/**
 * Frozen Determinism Coverage (DC%) definition — ROADMAP §0 / §13 / Arc 1.
 *
 * Product aggregation (Wave 2) must match this arithmetic. Provider cache
 * hits are a separate line and MUST NOT be blended into DC%.
 *
 *   DC% = (compiled + memoized + transparent + steeredSkip) / total
 *   total = those four + frontier
 */
export type TokenClasses = {
  compiled: number;
  memoized: number;
  transparent: number;
  steeredSkip: number;
  frontier: number;
  /** Provider cache hits — never added into the DC% numerator or denominator. */
  providerCache?: number;
};

export function dcShare(c: TokenClasses): number {
  const det = c.compiled + c.memoized + c.transparent + c.steeredSkip;
  const total = det + c.frontier;
  if (!(total > 0)) return 0;
  return det / total;
}

export function dcPct(c: TokenClasses): number {
  return dcShare(c) * 100;
}
