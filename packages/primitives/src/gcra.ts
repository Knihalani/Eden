/**
 * Rate limiting with GCRA (the generic cell rate algorithm): per key, one number, the theoretical arrival time
 * (TAT). A request is allowed if TAT − burst tolerance ≤ now; allowing it advances TAT by one emission interval.
 * Equivalent to a token bucket, with O(1) state per key, no timers and no refill loop.
 *
 * `take` returns 0 when allowed, else how long to wait. `penalize` pushes a key's TAT forward, to honour an
 * upstream's 429 Retry-After. Keys idle long enough to be full again are pruned lazily, so the map stays bounded by
 * the active set.
 */
export interface GcraOptions {
  /** Sustained requests per second. */
  ratePerSec: number;
  /** Requests allowed back to back on top of the rate. */
  burst: number;
  now?: () => number;
}

export class Gcra<K = string> {
  private readonly tat = new Map<K, number>();
  private readonly interval: number;
  private readonly tolerance: number;
  private readonly now: () => number;
  private ops = 0;

  private readonly burst: number;

  constructor(options: GcraOptions) {
    if (!(options.ratePerSec > 0) || !Number.isFinite(options.ratePerSec)) throw new Error("ratePerSec must be > 0");
    if (!(options.burst >= 1)) throw new Error("burst must be >= 1");
    this.burst = options.burst;
    this.interval = 1_000 / options.ratePerSec;
    this.tolerance = this.interval * Math.max(0, options.burst - 1);
    this.now = options.now ?? Date.now;
  }

  /** 0 if `cost` requests may go now (and records them), else milliseconds until they may; Infinity if never. */
  take(key: K, cost = 1): number {
    if (cost > this.burst) return Infinity; // More than the bucket holds: no wait makes it fit.
    const now = this.now();
    if ((++this.ops & 1023) === 0) this.prune(now);
    const tat = Math.max(this.tat.get(key) ?? now, now);
    const next = tat + this.interval * cost;
    const allowAt = next - this.interval - this.tolerance;
    if (allowAt > now) return allowAt - now;
    this.tat.set(key, next);
    return 0;
  }

  /** How many requests `key` could make now, back to back, without waiting (records nothing). */
  available(key: K): number {
    const now = this.now();
    const tat = Math.max(this.tat.get(key) ?? now, now);
    return Math.max(0, Math.floor((now - tat + this.tolerance) / this.interval) + 1);
  }

  /** Blocks `key` for at least `ms` (e.g. an upstream's Retry-After). */
  penalize(key: K, ms: number): void {
    if (!(ms >= 0)) return; // NaN or negative (an unparsable Retry-After): no penalty, rather than a TAT of NaN
    const now = this.now();
    const blockedUntil = now + ms + this.interval + this.tolerance;
    this.tat.set(key, Math.max(this.tat.get(key) ?? now, blockedUntil));
  }

  get trackedKeys(): number {
    return this.tat.size;
  }

  private prune(now: number): void {
    for (const [key, tat] of this.tat) if (tat <= now) this.tat.delete(key);
  }
}
