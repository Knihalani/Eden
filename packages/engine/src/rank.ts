/**
 * A learned, no-model ranker over the facts the engine already computes for each candidate (`decide.ts`), for
 * `askRank` and `rankTies` (docs/research/smart-rank.md). A linear score: one weight per fact, fitted offline by a
 * pairwise logistic loss on the lab's ask dumps (`packages/sim/src/lab/rank-fit.ts`): a hidden task's planted item
 * should outrank every other candidate, and every other candidate should outrank a control task's decoy (a resolved,
 * expired, other-party or other-day lookalike). The weights live in `rank-weights.json`; a score is a dot product over
 * a few dozen numbers (well under a microsecond), and only its order means anything: there is no threshold in it, so
 * it never decides whether Eden speaks, only which of what may be said comes first.
 */
import type { Facts } from "./decide";
import WEIGHTS from "./rank-weights.json";

/** A fitted ranker: the facts it reads, a weight each (on the raw fact, scaling folded in), and where it came from. */
export interface RankModel {
  names: readonly (keyof Facts)[];
  weights: readonly number[];
  /** The fingerprint of the facts' definition it was fitted on (`facts-fingerprint.ts`); checked by `rank.test.ts`. */
  facts?: string;
}

export const RANK_MODEL: RankModel = WEIGHTS as unknown as RankModel;

/** The ranker's score for one candidate: higher ranks first. Only comparisons between candidates are meaningful. */
export function rankScore(f: Facts, model: RankModel = RANK_MODEL): number {
  let s = 0;
  const { names, weights } = model;
  for (let j = 0; j < names.length; j++) s += weights[j]! * (f[names[j]!] ?? 0);
  return s;
}

/**
 * The ask's answer under `askRank`: the rule paths' pool (verdict hits, grounded items, the lexically likely) in the
 * ranker's order, cut to `limit`; then the ranker's best candidate outside the pool takes the weakest seat when it
 * outscores it by more than `margin`. The answer never grows: a seat is swapped, never added (bytes stay put).
 * `score` returns undefined for a candidate with no facts, which keeps its place behind those with them.
 */
export function rankAnswer<T>(
  pool: readonly T[],
  outside: readonly T[],
  limit: number,
  margin: number,
  score: (x: T) => number | undefined,
): T[] {
  const s = (x: T) => score(x) ?? -Infinity;
  // A stable sort: equal scores keep the rule paths' order.
  const top = pool
    .map((x, i) => ({ x, i, v: s(x) }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .slice(0, limit);
  let best: { x: T; v: number } | null = null;
  for (const x of outside) {
    const v = score(x);
    if (v !== undefined && (best === null || v > best.v)) best = { x, v };
  }
  if (best && top.length > 0) {
    const worst = top[top.length - 1]!;
    if (best.v > worst.v + margin) top[top.length - 1] = { x: best.x, i: Infinity, v: best.v };
    top.sort((a, b) => b.v - a.v || a.i - b.i);
  }
  return top.map((t) => t.x);
}
