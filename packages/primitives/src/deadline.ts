/**
 * An absolute deadline shared by every stage of one operation (route → fan out → merge → maybe a model call), so a
 * stage can never spend more than what is left, and work past the deadline is cancelled through one AbortSignal.
 * Stages take a slice with `child(ms)` or `fraction(f)`, always capped by the parent.
 */
export class Deadline {
  readonly at: number;
  readonly signal: AbortSignal;

  private constructor(at: number, signal: AbortSignal) {
    this.at = at;
    this.signal = signal;
  }

  /** A deadline `ms` from now, also cancelled if `parent` aborts. */
  static after(ms: number, parent?: AbortSignal): Deadline {
    if (!Number.isFinite(ms)) return new Deadline(Infinity, parent ?? new AbortController().signal); // no timeout
    const timeout = AbortSignal.timeout(Math.max(0, ms));
    return new Deadline(Date.now() + ms, parent ? AbortSignal.any([parent, timeout]) : timeout);
  }

  /** Milliseconds left, never negative. */
  remaining(): number {
    return Math.max(0, this.at - Date.now());
  }

  get expired(): boolean {
    return this.signal.aborted || Date.now() >= this.at;
  }

  /** A sub-deadline of at most `ms`, never later than this one, cancelled with it. */
  child(ms: number): Deadline {
    const left = this.remaining();
    return Deadline.after(Math.min(ms, left), this.signal);
  }

  /** A sub-deadline of `f` (0..1) of what is left, keeping the rest for later stages. */
  fraction(f: number): Deadline {
    return this.child(this.remaining() * Math.min(1, Math.max(0, f)));
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
