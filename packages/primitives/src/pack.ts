/**
 * Budgeted context packing: choose which candidate items go into a size-limited packet so it holds the most relevant
 * material without repeating itself, and nothing that does not earn its bytes.
 *
 * The objective is a set function, so "best packet" is well defined and the greedy can be checked against the exact
 * optimum (pack.test.ts, bench/pack.bench.ts):
 *
 *   f(S) = Σ_{i∈S} rel_i − β · Σ_{{i,j}⊆S} sim(i, j) · min(rel_i, rel_j)
 *
 * rel is a calibrated probability of usefulness (never a raw retrieval score) and sim ∈ [0, 1] a redundancy measure
 * (the caller's, or `jaccardMatrix` over term ids from `tokenizeInto`). Read f as the relevance the packet covers,
 * counted once: the pair term is the second-order inclusion–exclusion correction for relevance two items share. With
 * β = 1 an exact duplicate (sim 1) of a chosen item adds exactly nothing, whatever the relevances; β < 1 tolerates
 * more overlap. Pair weights are non-negative, so f is submodular: an item's gain, rel_k − β·Σ_{i∈S} sim(i, k)·
 * min(rel_i, rel_k), only shrinks as S grows.
 *
 * This replaces the λ-weighted MMR of Carbonell & Goldstein (1998), λ·rel − (1 − λ)·max sim, which charges
 * redundancy in similarity units: at the λ = 0.7 suggested in docs/research/fast-primitives.md an exact duplicate of
 * a chosen item with rel > 0.43 still has positive gain and is packed (pack.test.ts shows the arithmetic).
 *
 * `Packer.pack` is the Lin & Bilmes (2010) budgeted greedy: repeatedly take the candidate with the best gain/cost^r
 * among those not yet considered, add it if it fits the budget, drop it either way; then compare against the best
 * single item that fits. For a monotone submodular f and r = 1 that is a (1 − e^(−1/2)) ≈ 0.39 approximation; f here
 * is not monotone (an item similar to two chosen ones can have negative gain), so the bound does not formally apply.
 * What holds: the greedy stops at the first non-positive gain (it never pads). It also runs the plain greedy (r = 0)
 * and keeps the better packet. That run's first pick is the best single item that fits, so it subsumes Lin–Bilmes'
 * singleton comparison, and it matters on its own: when the item cap binds rather than the byte budget (Eden's ≤ 3
 * items of ≤ 300 bytes in 1,200), cost scaling only steers toward small items and lost 13% of the optimum on average
 * at r = 0.5, while when bytes bind the plain greedy's worst case was 0.27 of the optimum (bench/pack.bench.ts).
 * `packExact` finds the optimum by enumeration for small maxItems.
 *
 * Packing allocates nothing per call; scratch is sized by `maxCandidates` at construction.
 */

export class Packer {
  readonly maxCandidates: number;
  /** f of the last packet. */
  value = 0;
  /** True when the last packet came from the plain (r = 0) greedy rather than the cost-scaled one. */
  usedPlain = false;
  private readonly penalty: Float64Array;
  private readonly open: Uint8Array;
  private readonly stack: Int32Array;
  private readonly best: Int32Array;
  private readonly costs: Float64Array;

  constructor(maxCandidates: number) {
    this.maxCandidates = Math.max(1, maxCandidates | 0);
    this.penalty = new Float64Array(this.maxCandidates);
    this.open = new Uint8Array(this.maxCandidates);
    this.stack = new Int32Array(this.maxCandidates);
    this.best = new Int32Array(this.maxCandidates);
    this.costs = new Float64Array(this.maxCandidates + 1);
  }

  /**
   * Greedy budgeted packing. `rel`, `cost` (bytes or tokens; must be > 0, at most `budget` to be eligible) and `sim`
   * (n×n row-major, symmetric; the diagonal is ignored) describe n ≤ maxCandidates candidates. Candidates with a
   * non-finite or non-positive rel or cost never enter. `r` scales cost (1: gain per byte, the guarantee's setting;
   * 0.3–0.5 suggested); the plain r = 0 greedy is always tried too. `redundancy` is β above (1: a duplicate adds
   * nothing). Writes chosen indexes to `out` in pick order; returns how many (0: send nothing).
   */
  pack(
    rel: Float64Array,
    cost: Float64Array,
    sim: Float64Array,
    n: number,
    budget: number,
    maxItems: number,
    redundancy: number,
    r: number,
    out: Int32Array,
  ): number {
    const m = Math.min(n, this.maxCandidates);
    const cap = Math.min(maxItems, out.length);
    let count = this.greedy(rel, cost, sim, n, m, budget, cap, redundancy, r, out);
    let value = this.runValue;
    this.usedPlain = r === 0;
    if (r !== 0) {
      const alt = this.best;
      const altCount = this.greedy(rel, cost, sim, n, m, budget, cap, redundancy, 0, alt);
      if (this.runValue > value) {
        value = this.runValue;
        count = altCount;
        this.usedPlain = true;
        for (let j = 0; j < count; j++) out[j] = alt[j]!;
      }
    }
    this.value = value;
    return count;
  }

  /** f of the last `greedy` run. */
  private runValue = 0;

  /** One cost-scaled greedy pass (see `pack`); sets `runValue`. */
  private greedy(
    rel: Float64Array,
    cost: Float64Array,
    sim: Float64Array,
    n: number,
    m: number,
    budget: number,
    cap: number,
    redundancy: number,
    r: number,
    out: Int32Array,
  ): number {
    const pen = this.penalty;
    const open = this.open;
    for (let i = 0; i < m; i++) {
      pen[i] = 0;
      open[i] = rel[i]! > 0 && rel[i]! < Infinity && cost[i]! > 0 && cost[i]! <= budget ? 1 : 0;
    }
    let count = 0;
    let used = 0;
    let value = 0;
    while (count < cap) {
      let pick = -1;
      let bestRatio = 0;
      let bestGain = 0;
      for (let k = 0; k < m; k++) {
        if (open[k] === 0) continue;
        const gain = rel[k]! - redundancy * pen[k]!;
        if (!(gain > 0)) continue;
        const ratio = r === 0 ? gain : gain / Math.pow(cost[k]!, r);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestGain = gain;
          pick = k;
        }
      }
      if (pick < 0) break; // No positive gain left: stop rather than pad.
      open[pick] = 0;
      if (used + cost[pick]! > budget) continue; // Lin–Bilmes: discard what does not fit, keep looking.
      out[count++] = pick;
      used += cost[pick]!;
      value += bestGain;
      // pen[k] = Σ_{i∈S} sim(i, k)·min(rel_i, rel_k), kept up to date for the open candidates.
      const row = pick * n;
      const rp = rel[pick]!;
      for (let k = 0; k < m; k++) if (open[k] !== 0) pen[k]! += sim[row + k]! * (rp < rel[k]! ? rp : rel[k]!);
    }
    this.runValue = value;
    return count;
  }

  /**
   * The exact optimum of f under the budget and maxItems, by depth-first enumeration of index-ordered subsets (with
   * pruning by budget). C(n, maxItems) subsets: fine for n ≤ 50 and maxItems ≤ 3 (see the bench), exponential
   * beyond. Same inputs and output as `pack`; `out` is in index order. Used to measure the greedy, and usable
   * directly where the item cap is small.
   */
  packExact(
    rel: Float64Array,
    cost: Float64Array,
    sim: Float64Array,
    n: number,
    budget: number,
    maxItems: number,
    redundancy: number,
    out: Int32Array,
  ): number {
    const m = Math.min(n, this.maxCandidates);
    const open = this.open;
    for (let i = 0; i < m; i++)
      open[i] = rel[i]! > 0 && rel[i]! < Infinity && cost[i]! > 0 && cost[i]! <= budget ? 1 : 0;
    const cap = Math.min(maxItems, out.length, m);
    const stack = this.stack;
    const best = this.best;
    let bestValue = 0;
    let bestCount = 0;
    // Iterative DFS over index-ordered subsets: stack[d] is the index chosen at depth d, vals[d] the value of the
    // first d + 1 chosen, costs[d] the cost of the first d.
    const vals = this.penalty;
    const costs = this.costs;
    let depth = 0;
    stack[0] = -1;
    costs[0] = 0;
    if (cap <= 0) return 0;
    for (;;) {
      // Advance the index at this depth.
      let i = stack[depth]! + 1;
      const baseValue = depth === 0 ? 0 : vals[depth - 1]!;
      const baseCost = costs[depth]!;
      for (; i < m; i++) if (open[i] !== 0 && baseCost + cost[i]! <= budget) break;
      if (i >= m) {
        if (depth === 0) break;
        depth--;
        continue;
      }
      stack[depth] = i;
      const ri = rel[i]!;
      let gain = ri;
      for (let d = 0; d < depth; d++) {
        const rd = rel[stack[d]!]!;
        gain -= redundancy * sim[stack[d]! * n + i]! * (rd < ri ? rd : ri);
      }
      const v = baseValue + gain;
      vals[depth] = v;
      if (v > bestValue) {
        bestValue = v;
        bestCount = depth + 1;
        for (let d = 0; d <= depth; d++) best[d] = stack[d]!;
      }
      if (depth + 1 < cap) {
        costs[depth + 1] = baseCost + cost[i]!;
        depth++;
        stack[depth] = i;
      }
    }
    for (let d = 0; d < bestCount; d++) out[d] = best[d]!;
    this.value = bestValue;
    this.usedPlain = false;
    return bestCount;
  }
}

/**
 * Pairwise Jaccard similarity |A ∩ B| / |A ∪ B| of n term-id sets into `out` (n×n row-major; diagonal 1, 0 between
 * empty sets). Item i's terms are `terms[offsets[i] .. offsets[i+1])`, duplicates allowed (as `tokenizeInto` writes
 * them). Sorts and deduplicates each item's ids in place in `terms` and writes the deduplicated lengths to `lengths`.
 * O(n² · terms per item) merges: about 1,225 pairs for 50 candidates.
 */
export function jaccardMatrix(
  terms: Uint32Array,
  offsets: Uint32Array,
  n: number,
  lengths: Uint32Array,
  out: Float64Array,
): void {
  for (let i = 0; i < n; i++) {
    const start = offsets[i]!;
    const end = offsets[i + 1]!;
    insertionOrSort(terms, start, end);
    let w = start;
    for (let r = start; r < end; r++) if (r === start || terms[r] !== terms[w - 1]) terms[w++] = terms[r]!;
    lengths[i] = w - start;
  }
  for (let i = 0; i < n; i++) {
    out[i * n + i] = 1;
    const ai = offsets[i]!;
    const ae = ai + lengths[i]!;
    for (let j = i + 1; j < n; j++) {
      const bi = offsets[j]!;
      const be = bi + lengths[j]!;
      let x = ai;
      let y = bi;
      let inter = 0;
      // Branch-free merge step: which side advances is a coin flip the CPU cannot predict, and arithmetic on the
      // comparisons was 1.7x faster than if/else on Bun (docs/research/primitives-decision.md).
      while (x < ae && y < be) {
        const u = terms[x]!;
        const v = terms[y]!;
        inter += +(u === v);
        x += +(u <= v);
        y += +(u >= v);
      }
      const union = lengths[i]! + lengths[j]! - inter;
      const s = union > 0 ? inter / union : 0;
      out[i * n + j] = s;
      out[j * n + i] = s;
    }
  }
}

/** Sorts terms[start, end) ascending: insertion sort for short runs (no allocation), the typed-array sort otherwise. */
function insertionOrSort(a: Uint32Array, start: number, end: number): void {
  if (end - start > 32) {
    a.subarray(start, end).sort();
    return;
  }
  for (let i = start + 1; i < end; i++) {
    const v = a[i]!;
    let j = i - 1;
    while (j >= start && a[j]! > v) {
      a[j + 1] = a[j]!;
      j--;
    }
    a[j + 1] = v;
  }
}
