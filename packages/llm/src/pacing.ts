/**
 * Pacing for runs against rate-limited endpoints (OpenRouter's free models: about 20 requests a minute and 1,000 a day
 * for the whole account). A `Pacer` is shared by every caller in one process, and `pacer.fetch` is a `fetch` that
 * goes through it:
 *
 * - a client-side rate limit (a sliding minute), so a run stays under the account's limit instead of bouncing off it;
 * - a request cap: every HTTP request, retries included, counts against it (the free daily quota counts them too),
 *   and once it is reached the next request throws `RequestCapReached` before anything is sent;
 * - retries on 429 and 5xx gateway errors and on network failures, with jittered exponential backoff, honouring the
 *   server's `Retry-After` (seconds or an HTTP date), `retry-after-ms`, or a 429's `x-ratelimit-reset` (epoch ms).
 *   A 429 holds every caller of the pacer until its delay passes, not only the request that got it: the limit is the
 *   account's. A delay longer than `maxDelayMs` (a daily limit) is not waited out: the response goes back as is.
 *
 * The lab uses it (packages/sim/src/lab/free.ts); the product's calls do not: the engine's model calls have their own
 * deadlines and budget, and a request the engine cannot make in time takes its no-model path.
 */
export class RequestCapReached extends Error {
  override name = "RequestCapReached";
}

export interface PacingOptions {
  /** Requests started per sliding minute. 0: no limit. */
  perMinute?: number;
  /** Requests (retries included) this pacer may ever send. 0: no cap. */
  maxRequests?: number;
  /** Retries after the first attempt of one request. Default 4. */
  retries?: number;
  /** The first backoff, doubled per retry, before jitter. Default 2,000 ms. */
  baseDelayMs?: number;
  /** The longest delay waited out, server-requested or not. Default 65,000 ms. */
  maxDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  random?: () => number;
  /** The fetch underneath. Default: the global one. */
  fetch?: typeof fetch;
}

/** Statuses worth sending again: rate limited, or a gateway or upstream failure. */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

function sleepFor(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The delay a response asks for, in ms, or null when it names none. `now` reads an HTTP date and an epoch reset
 * against the same clock the pacer runs on.
 */
export function retryAfterMs(res: Response, now: number): number | null {
  const ms = Number.parseFloat(res.headers.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const after = res.headers.get("retry-after");
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  // OpenRouter's rate-limit headers: the reset is an epoch time in milliseconds.
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? "");
  if (res.status === 429 && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, (reset < 1e11 ? reset * 1_000 : reset) - now);
  }
  return null;
}

export class Pacer {
  /** HTTP requests sent (each attempt counts). */
  sent = 0;
  /** Requests refused because the cap was reached. */
  refused = 0;
  /** Attempts sent again after a retryable status or a network failure. */
  retried = 0;
  /** Retryable statuses seen, by status (0: network failure). */
  readonly statuses: Record<number, number> = {};
  private readonly perMinute: number;
  private readonly maxRequests: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  private readonly random: () => number;
  private readonly inner: typeof fetch;
  /** Start times of the requests in the current minute, oldest first. */
  private readonly starts: number[] = [];
  /** No request starts before this time: a 429 holds every caller. */
  private holdUntil = 0;
  /** Slots are handed out one at a time, in arrival order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: PacingOptions = {}) {
    this.perMinute = Math.max(0, options.perMinute ?? 0);
    this.maxRequests = Math.max(0, options.maxRequests ?? 0);
    this.retries = Math.max(0, options.retries ?? 4);
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 65_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? sleepFor;
    this.random = options.random ?? Math.random;
    this.inner = options.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
  }

  /** The cap is reached: no further request will be sent. */
  get exhausted(): boolean {
    return this.maxRequests > 0 && this.sent >= this.maxRequests;
  }

  /** Requests left under the cap (Infinity with none). */
  get remaining(): number {
    return this.maxRequests > 0 ? Math.max(0, this.maxRequests - this.sent) : Infinity;
  }

  /** Waits for a slot under the rate limit and any hold, then counts the request. Throws once the cap is reached. */
  acquire(signal?: AbortSignal | null): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot(signal));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async waitForSlot(signal?: AbortSignal | null): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError();
      if (this.exhausted) {
        this.refused++;
        throw new RequestCapReached(`request cap of ${this.maxRequests} reached`);
      }
      const now = this.now();
      while (this.starts.length && this.starts[0]! <= now - 60_000) this.starts.shift();
      let wait = this.holdUntil - now;
      if (this.perMinute > 0 && this.starts.length >= this.perMinute) {
        wait = Math.max(wait, this.starts[0]! + 60_000 - now);
      }
      if (wait <= 0) break;
      await this.sleep(wait, signal);
    }
    this.starts.push(this.now());
    this.sent++;
  }

  /** The backoff before retry `attempt` (0-based): the server's delay if it named one, else jittered exponential. */
  private delayFor(res: Response | null, attempt: number): number {
    const asked = res ? retryAfterMs(res, this.now()) : null;
    if (asked !== null) return asked + this.random() * Math.min(1_000, asked * 0.2 + 100);
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    return exp * (0.5 + this.random() * 0.5);
  }

  /** `fetch` through this pacer: paced, capped and retried. */
  readonly fetch = (async (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    for (let attempt = 0; ; attempt++) {
      await this.acquire(signal);
      let res: Response | null = null;
      try {
        res = await this.inner((input instanceof Request ? input.clone() : input) as typeof input, init);
      } catch (e) {
        if (signal?.aborted || attempt >= this.retries) throw e;
        this.statuses[0] = (this.statuses[0] ?? 0) + 1;
      }
      if (res) {
        if (!RETRY_STATUSES.has(res.status)) return res;
        this.statuses[res.status] = (this.statuses[res.status] ?? 0) + 1;
        if (attempt >= this.retries) return res;
      }
      const delay = this.delayFor(res, attempt);
      // A daily limit, or an outage longer than the run should wait: the caller gets the response as it came.
      if (res && delay > this.maxDelayMs) return res;
      if (res) await res.body?.cancel().catch(() => {});
      if (res?.status === 429) this.holdUntil = Math.max(this.holdUntil, this.now() + delay);
      this.retried++;
      await this.sleep(delay, signal);
    }
  }) as typeof fetch;

  /** A summary for a run's results file. */
  summary(): { sent: number; retried: number; refused: number; statuses: Record<number, number>; cap: number } {
    return {
      sent: this.sent,
      retried: this.retried,
      refused: this.refused,
      statuses: { ...this.statuses },
      cap: this.maxRequests,
    };
  }
}
