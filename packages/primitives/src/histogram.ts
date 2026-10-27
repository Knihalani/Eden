/**
 * A latency histogram for rolling percentiles (adaptive hedging delays, slow-call thresholds, metrics), with
 * HDR-style log-linear buckets: about 3% relative precision from 1 µs to ~10 minutes in 1,024 Uint32 counters
 * (4 KB). Recording is a log and an increment; a quantile is one scan.
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

export class Histogram {
  readonly counts = new Uint32Array(BUCKETS);
  total = 0;

  record(ms: number): void {
    this.counts[bucketOf(ms)]!++;
    this.total++;
  }

  reset(): void {
    this.counts.fill(0);
    this.total = 0;
  }

  /** The `q` quantile (0..1) in ms (bucket upper bound), or NaN when empty. */
  quantile(q: number): number {
    return quantileOf([this], q);
  }
}

function quantileOf(hs: Histogram[], q: number): number {
  const total = hs.reduce((s, h) => s + h.total, 0);
  if (total === 0) return NaN;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let b = 0; b < BUCKETS; b++) {
    for (const h of hs) seen += h.counts[b]!;
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
