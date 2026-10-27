/**
 * A circuit breaker for one upstream (or one user × upstream). Failure rate is measured over a sliding time window
 * of buckets, not a call count, because per-user traffic is low: resilience4j's defaults (100 calls) would never
 * trip. Defaults follow docs/research/fast-primitives.md: 60 s window, at least 5 calls, 50% failures to open,
 * open for 30 s, then one probe call (half-open) decides.
 *
 * Callers count a call that missed its deadline as a failure.
 */
export interface BreakerOptions {
  windowMs?: number;
  buckets?: number;
  minCalls?: number;
  failureRate?: number;
  openMs?: number;
  now?: () => number;
}

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private readonly bucketMs: number;
  private readonly calls: Uint32Array;
  private readonly failures: Uint32Array;
  private readonly stamps: Float64Array;
  private readonly minCalls: number;
  private readonly failureRate: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private openedAt = -Infinity;
  private probing = false;
  private probeAt = -Infinity;
  private mode: BreakerState = "closed";

  constructor(options: BreakerOptions = {}) {
    const buckets = options.buckets ?? 10;
    this.bucketMs = (options.windowMs ?? 60_000) / buckets;
    this.calls = new Uint32Array(buckets);
    this.failures = new Uint32Array(buckets);
    this.stamps = new Float64Array(buckets).fill(-1);
    this.minCalls = options.minCalls ?? 5;
    this.failureRate = options.failureRate ?? 0.5;
    this.openMs = options.openMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    if (this.mode === "open" && this.now() - this.openedAt >= this.openMs) this.mode = "half-open";
    return this.mode;
  }

  /**
   * Whether a call may go now. In half-open, one probe is allowed until it reports back; a probe that never reports
   * (its caller was aborted) is forgotten after `openMs`, so the breaker cannot stay half-open forever.
   */
  allow(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open") return false;
    const now = this.now();
    if (this.probing && now - this.probeAt < this.openMs) return false;
    this.probing = true;
    this.probeAt = now;
    return true;
  }

  success(): void {
    if (this.mode === "half-open") {
      this.reset();
      return;
    }
    this.record(false);
  }

  failure(): void {
    if (this.mode === "half-open") {
      this.trip();
      return;
    }
    this.record(true);
    let calls = 0;
    let failures = 0;
    const horizon = this.now() - this.bucketMs * this.calls.length;
    for (let i = 0; i < this.calls.length; i++) {
      if (this.stamps[i]! <= horizon) continue;
      calls += this.calls[i]!;
      failures += this.failures[i]!;
    }
    if (calls >= this.minCalls && failures / calls >= this.failureRate) this.trip();
  }

  private record(failed: boolean): void {
    const now = this.now();
    const slot = Math.floor(now / this.bucketMs);
    const i = slot % this.calls.length;
    if (this.stamps[i] !== slot * this.bucketMs) {
      this.stamps[i] = slot * this.bucketMs;
      this.calls[i] = 0;
      this.failures[i] = 0;
    }
    this.calls[i]!++;
    if (failed) this.failures[i]!++;
  }

  private trip(): void {
    this.mode = "open";
    this.openedAt = this.now();
    this.probing = false;
  }

  private reset(): void {
    this.mode = "closed";
    this.probing = false;
    this.calls.fill(0);
    this.failures.fill(0);
    this.stamps.fill(-1);
  }
}
