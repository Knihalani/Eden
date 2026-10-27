/**
 * An adaptive concurrency limit (AIMD), as Netflix's concurrency-limits recommends for clients: the limit grows by
 * 1/limit per success (about +1 per round trip at full use) and shrinks ×`backoff` on a drop, timeout or rate-limit
 * signal. It finds how much parallelism an upstream tolerates without a configured number. Defaults from
 * docs/research/fast-primitives.md: start 8, bounds [1, 32], backoff 0.9.
 *
 * `tryAcquire` never waits (the fast path skips a saturated source); `acquire` queues up to an AbortSignal.
 */
export interface LimiterOptions {
  initial?: number;
  min?: number;
  max?: number;
  backoff?: number;
}

export type Outcome = "ok" | "dropped";

export class AimdLimiter {
  private value: number;
  private readonly min: number;
  private readonly max: number;
  private readonly backoff: number;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(options: LimiterOptions = {}) {
    this.min = options.min ?? 1;
    this.max = options.max ?? 32;
    this.backoff = options.backoff ?? 0.9;
    this.value = Math.min(this.max, Math.max(this.min, options.initial ?? 8));
  }

  get limit(): number {
    return Math.floor(this.value);
  }

  get inFlight(): number {
    return this.active;
  }

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false;
    this.active++;
    return true;
  }

  /** Waits for a permit; rejects if `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  /** Returns a permit, adjusting the limit by the call's outcome. */
  release(outcome: Outcome): void {
    this.active = Math.max(0, this.active - 1);
    if (outcome === "ok") this.value = Math.min(this.max, this.value + 1 / this.value);
    else this.value = Math.max(this.min, this.value * this.backoff);
    while (this.waiters.length > 0 && this.active < this.limit) this.waiters.shift()!();
  }
}
