/**
 * An absolute deadline shared by every stage of one operation (route → fan out → merge → maybe a model call), so a
 * stage can never spend more than what is left, and work past the deadline is cancelled through one AbortSignal.
 * Stages take a slice with `child(ms)` or `fraction(f)`, always capped by the parent.
 */
export class Deadline {
  readonly at: number;
  readonly signal: AbortSignal;
  /** Milliseconds since the epoch: `Date.now` unless a test injects a clock. Children share their parent's. */
  private readonly clock: () => number;

  private constructor(at: number, signal: AbortSignal, clock: () => number) {
    this.at = at;
    this.signal = signal;
    this.clock = clock;
  }

  /** A deadline `ms` from now, also cancelled if `parent` aborts. `clock` is for tests (default `Date.now`). */
  static after(ms: number, parent?: AbortSignal, clock?: () => number): Deadline {
    const now = clock ?? Date.now;
    if (!Number.isFinite(ms)) return new Deadline(Infinity, parent ?? new AbortController().signal, now); // no timeout
    return Deadline.until(now() + ms, ms, parent, now);
  }

  /** A deadline at `at`, `ms` from the one clock read that gave `at`, with its timer and its parent's signal. */
  private static until(at: number, ms: number, parent: AbortSignal | undefined, clock: () => number): Deadline {
    const timeout = AbortSignal.timeout(Math.max(0, ms));
    return new Deadline(at, parent ? AbortSignal.any([parent, timeout]) : timeout, clock);
  }

  /** Milliseconds left, never negative. */
  remaining(): number {
    return Math.max(0, this.at - this.clock());
  }

  get expired(): boolean {
    return this.signal.aborted || this.clock() >= this.at;
  }

  /** A sub-deadline of at most `ms`, never later than this one, cancelled with it. */
  child(ms: number): Deadline {
    // Unbounded on both sides: no timer, the parent's signal (Infinity - now would ask for an infinite timeout).
    if (!Number.isFinite(this.at) && !Number.isFinite(ms)) return new Deadline(Infinity, this.signal, this.clock);
    // One clock read: reading it again to start the child (as `remaining()` then `after()` did) let a tick in
    // between put the child 1 ms past its parent.
    // A NaN `ms` compares false and gets the parent's deadline (Math.min would give NaN, an unbounded child).
    const now = this.clock();
    const at = ms < this.at - now ? now + ms : this.at;
    return Deadline.until(at, at - now, this.signal, this.clock);
  }

  /** A sub-deadline of `f` (0..1) of what is left, keeping the rest for later stages. */
  fraction(f: number): Deadline {
    const share = Math.min(1, Math.max(0, f));
    const left = this.remaining();
    // Unbounded: a positive share stays unbounded, but a zero share is no time at all (Infinity × 0 would be NaN).
    if (left === Infinity) return share > 0 ? this.child(Infinity) : this.child(0);
    return this.child(left * share);
  }

  /** Resolves with `work`, or rejects when the deadline passes first. `work` should honour `this.signal`. */
  race<T>(work: Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (v) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          this.signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }
}
