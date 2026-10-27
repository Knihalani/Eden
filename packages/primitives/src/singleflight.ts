/**
 * Request coalescing: concurrent calls with the same key share one underlying call (Go's x/sync/singleflight).
 * Every waiter gets the same result or the same error. Each waiter may bring its own AbortSignal: it then stops
 * waiting when that signal aborts, and the shared call is aborted only when *every* waiter has gone, so one
 * impatient caller never cancels work others still want.
 *
 * Keys must include everything that scopes the result (tenant, user, source, tool, canonical arguments); the
 * caller builds them. Results are not cached here: once the call settles, the next call runs again.
 */
interface Flight<V> {
  promise: Promise<V>;
  controller: AbortController;
  waiters: number;
}

export class Singleflight<K, V> {
  private readonly flights = new Map<K, Flight<V>>();

  /** In-flight calls, for metrics and tests. */
  get inFlight(): number {
    return this.flights.size;
  }

  /** True if a call for `key` is in flight (a new `run` would join it). */
  has(key: K): boolean {
    return this.flights.has(key);
  }

  run(key: K, fn: (signal: AbortSignal) => Promise<V>, signal?: AbortSignal): Promise<V> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let flight = this.flights.get(key);
    if (flight === undefined) {
      const controller = new AbortController();
      // Started synchronously, so `fn` registers its abort listeners before any waiter can leave.
      let started: Promise<V>;
      try {
        started = fn(controller.signal);
      } catch (e) {
        started = Promise.reject(e);
      }
      const created: Flight<V> = {
        controller,
        waiters: 0,
        promise: started.finally(() => {
          if (this.flights.get(key) === created) this.flights.delete(key);
        }),
      };
      flight = created;
      this.flights.set(key, flight);
    }
    const f = flight;
    f.waiters++;
    if (signal === undefined) return f.promise.finally(() => f.waiters--);
    return new Promise<V>((resolve, reject) => {
      let done = false;
      const leave = () => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        if (--f.waiters === 0 && this.flights.get(key) === f) {
          this.flights.delete(key);
          f.controller.abort(signal.reason);
        }
      };
      const onAbort = () => {
        leave();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      f.promise.then(
        (v) => {
          if (done) return;
          done = true;
          f.waiters--;
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          f.waiters--;
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }
}
