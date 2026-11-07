/**
 * A latency histogram for rolling percentiles (adaptive hedging delays, slow-call thresholds, metrics), with
 * HDR-style log-linear buckets: about 3% relative precision from 1 µs to ~10 minutes in 1,024 Uint32 counters
 * (4 KB), made once it has more than 64 samples (fewer are kept as bucket numbers, D261). Recording is a log and an
 * increment; a quantile is one scan.
 *
 * `RollingHistogram` keeps the current and previous window and answers over both, so a percentile never drops to
 * nothing at a window boundary.
 */
const BUCKETS = 1_024;
const MIN_MS = 0.001;
const MAX_MS = 600_000;
const SCALE = (BUCKETS - 1) / Math.log(MAX_MS / MIN_MS);

const bucketOf = (ms: number) => {
  if (!(ms > MIN_MS)) return 0;
  if (ms >= MAX_MS) return BUCKETS - 1;
  return Math.floor(Math.log(ms / MIN_MS) * SCALE);
};
const upperOf = (b: number) => MIN_MS * Math.exp((b + 1) / SCALE);

/** Samples a histogram holds as bucket numbers before it takes its 1,024 counters (`Histogram`). */
const FEW = 64;

export class Histogram {
  /**
   * The counters, made on the `FEW + 1`th sample: until then the samples' bucket numbers are kept in `few` (a 16-bit
   * array that doubles), so a histogram that saw a handful of calls costs about a hundred bytes, not 4 KB (D261: the
   * fan-out keeps one per (user, source) pair it has called). Quantiles are the same either way.
   */
  private counts: Uint32Array | null = null;
  private few: Uint16Array | null = null;
  total = 0;

  record(ms: number): void {
    const b = bucketOf(ms);
    this.total++;
    if (this.counts !== null) {
      this.counts[b]!++;
      return;
    }
    const n = this.total - 1;
    if (n < FEW) {
      if (this.few === null || n === this.few.length) {
        const grown = new Uint16Array(this.few === null ? 4 : this.few.length * 2);
        if (this.few !== null) grown.set(this.few);
        this.few = grown;
      }
      this.few[n] = b;
      return;
    }
    const counts = new Uint32Array(BUCKETS);
    for (let i = 0; i < n; i++) counts[this.few![i]!]!++;
    counts[b]!++;
    this.counts = counts;
    this.few = null;
  }

  /** Empties it and lets its counters go: a reset histogram is as small as a new one. */
  reset(): void {
    this.counts = null;
    this.few = null;
    this.total = 0;
  }

  /** The `q` quantile (0..1) in ms (bucket upper bound), or NaN when empty. */
  quantile(q: number): number {
    return quantileOf([this], q);
  }

  /** The counters, or null while the samples are few (`fewSorted` has them). */
  dense(): Uint32Array | null {
    return this.counts;
  }

  /** The bucket numbers of its samples, ascending, while they are few (null once it has counters). */
  fewSorted(): Uint16Array | null {
    if (this.counts !== null) return null;
    return this.few === null ? new Uint16Array(0) : this.few.slice(0, this.total).sort();
  }
}

function quantileOf(hs: Histogram[], q: number): number {
  const total = hs.reduce((s, h) => s + h.total, 0);
  if (total === 0) return NaN;
  const rank = Math.max(1, Math.ceil(q * total));
  // No histogram holding few samples (the busy case): the counters' scan as before, with nothing allocated.
  if (hs.every((h) => h.total === 0 || h.dense() !== null)) {
    let seen = 0;
    for (let b = 0; b < BUCKETS; b++) {
      for (const h of hs) if (h.total > 0) seen += h.dense()![b]!;
      if (seen >= rank) return upperOf(b);
    }
    return MAX_MS;
  }
  // Histograms still holding few samples count each bucket from their sorted samples, one cursor each; the rank-th
  // smallest bucket over all of them is the same bucket the counters' scan stops at.
  const dense: Uint32Array[] = [];
  const sparse: Uint16Array[] = [];
  for (const h of hs) {
    const d = h.dense();
    if (d !== null) dense.push(d);
    else if (h.total > 0) sparse.push(h.fewSorted()!);
  }
  if (dense.length === 0 && sparse.length === 1) return upperOf(sparse[0]![rank - 1]!);
  const at = sparse.map(() => 0);
  let seen = 0;
  for (let b = 0; b < BUCKETS; b++) {
    for (const d of dense) seen += d[b]!;
    for (let k = 0; k < sparse.length; k++) {
      const xs = sparse[k]!;
      let i = at[k]!;
      while (i < xs.length && xs[i] === b) i++;
      seen += i - at[k]!;
      at[k] = i;
    }
    if (seen >= rank) return upperOf(b);
  }
  return MAX_MS;
}

export class RollingHistogram {
  private current = new Histogram();
  private previous = new Histogram();
  private windowStart: number;

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStart = now();
  }

  record(ms: number): void {
    this.rotate();
    this.current.record(ms);
  }

  quantile(q: number): number {
    this.rotate();
    return quantileOf([this.previous, this.current], q);
  }

  get count(): number {
    this.rotate();
    return this.previous.total + this.current.total;
  }

  private rotate(): void {
    const elapsed = this.now() - this.windowStart;
    if (elapsed < this.windowMs) return;
    if (elapsed >= 2 * this.windowMs) {
      this.previous.reset();
      this.current.reset();
    } else {
      const recycled = this.previous;
      this.previous = this.current;
      recycled.reset();
      this.current = recycled;
    }
    this.windowStart += Math.floor(elapsed / this.windowMs) * this.windowMs;
  }
}
