/**
 * Top-k selection by score: a bounded binary min-heap over parallel typed arrays (no object per candidate).
 * `push` is O(1) when the candidate cannot enter (score ≤ the current k-th best) and O(log k) otherwise, so scoring
 * loops can also read `floor` to skip work for documents that cannot make the cut.
 */
export class TopK {
  readonly k: number;
  private readonly scores: Float64Array;
  private readonly ids: Int32Array;
  private n = 0;

  constructor(k: number) {
    this.k = Math.max(1, k | 0);
    this.scores = new Float64Array(this.k);
    this.ids = new Int32Array(this.k);
  }

  get size(): number {
    return this.n;
  }

  /** The score a candidate must beat to enter (−Infinity until k candidates are held). */
  get floor(): number {
    return this.n < this.k ? -Infinity : this.scores[0]!;
  }

  clear(): void {
    this.n = 0;
  }

  push(id: number, score: number): void {
    if (score !== score) return; // NaN never enters: it would compare false everywhere and corrupt the heap.
    const scores = this.scores;
    // The common case first: a full heap and a candidate that cannot enter.
    if (this.n === this.k) {
      if (score <= scores[0]!) return;
      this.replaceMin(id, score);
      return;
    }
    const ids = this.ids;
    {
      // Sift up.
      let i = this.n++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (scores[parent]! <= score) break;
        scores[i] = scores[parent]!;
        ids[i] = ids[parent]!;
        i = parent;
      }
      scores[i] = score;
      ids[i] = id;
    }
  }

  /**
   * Pushes `scores[i]` with id `i` for every i in [start, end) whose score is above `minScore`: the shape of a dense
   * score accumulator. One call instead of one per candidate: JavaScriptCore does not inline `push` into a caller's
   * loop, which made a per-candidate `push` ~4x slower on Bun than this (bench/topk.bench.ts).
   */
  pushDense(scores: Float64Array | Float32Array, start: number, end: number, minScore: number): void {
    let floor = this.n === this.k ? Math.max(minScore, this.scores[0]!) : minScore;
    for (let i = start; i < end; i++) {
      const s = scores[i]!;
      if (s <= floor) continue;
      this.push(i, s);
      if (this.n === this.k) floor = Math.max(minScore, this.scores[0]!);
    }
  }

  /** Replaces the minimum with a better candidate and sifts it down. */
  private replaceMin(id: number, score: number): void {
    const scores = this.scores;
    const ids = this.ids;
    const n = this.n;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && scores[r]! < scores[l]! ? r : l;
      if (scores[c]! >= score) break;
      scores[i] = scores[c]!;
      ids[i] = ids[c]!;
      i = c;
    }
    scores[i] = score;
    ids[i] = id;
  }

  /**
   * Writes the held ids and scores into the given arrays, best first, and returns how many. Leaves the heap empty.
   */
  drain(outIds: Int32Array | number[], outScores: Float64Array | number[] | null): number {
    const count = this.n;
    // Pop the minimum repeatedly, filling from the back.
    for (let at = count - 1; at >= 0; at--) {
      outIds[at] = this.ids[0]!;
      if (outScores !== null) outScores[at] = this.scores[0]!;
      const last = --this.n;
      const score = this.scores[last]!;
      const id = this.ids[last]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= last) break;
        const r = l + 1;
        const c = r < last && this.scores[r]! < this.scores[l]! ? r : l;
        if (this.scores[c]! >= score) break;
        this.scores[i] = this.scores[c]!;
        this.ids[i] = this.ids[c]!;
        i = c;
      }
      this.scores[i] = score;
      this.ids[i] = id;
    }
    return count;
  }
}
