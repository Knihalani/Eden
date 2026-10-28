/**
 * Fan-out to a user's sources with the resilience layer from `@eden/primitives` around every call. Sources are slow,
 * rate-limited, and sometimes down; a lookup must still finish inside its deadline with the best it can get.
 *
 * Per (user, source):
 * - a circuit breaker: a failing connector is skipped (status "open") instead of costing a timeout per lookup;
 * - an adaptive concurrency limit (AIMD): a saturated connector is skipped ("busy") rather than queued;
 * - a GCRA rate limit, pushed back by rate-limit errors (429 / "rate limit" / Retry-After) ("limited");
 * - a rolling latency histogram, for observability and (later) adaptive deadlines.
 * Across calls:
 * - singleflight: identical concurrent searches (same user, source, query) share one call;
 * - a result cache with stale-while-revalidate: a fresh hit skips the call ("cached"); on timeout or error, a stale
 *   result is served ("stale") rather than nothing. Results are sanitized by the caller's hook *before* they are
 *   cached, so nothing unredacted is held (docs/PRIVACY.md).
 *
 * Never throws; every source reports what happened.
 */
import {
  AimdLimiter,
  CircuitBreaker,
  Gcra,
  RollingHistogram,
  S3FifoCache,
  Singleflight,
  type BreakerOptions,
} from "@eden/primitives";
import { scopeKey, type ContextItem, type Scope } from "@eden/protocol";
import { PlannedSource, type PlanCalls } from "./planner";
import type { SearchQuery, Source } from "./source";

export type FanoutStatus = "ok" | "cached" | "stale" | "error" | "timeout" | "open" | "busy" | "limited";

export interface FanoutOutcome {
  sourceId: string;
  status: FanoutStatus;
  items: ContextItem[];
  latencyMs: number;
  error?: string;
}

export interface FanoutOptions {
  /**
   * Redacts items before they are cached or returned. Required: nothing unredacted is held. It may be asynchronous
   * (gating in a worker pool) and runs inside the call's deadline; `signal` aborts with the call. Items it leaves out
   * are dropped.
   */
  sanitize: (items: ContextItem[], signal: AbortSignal) => ContextItem[] | Promise<ContextItem[]>;
  /** Result cache budget in bytes of item text (default 32 MB); 0 disables caching. */
  cacheBytes?: number;
  /** A cached result is fresh for this long (default 60 s), then stale (servable on failure) until `staleMs`. */
  freshMs?: number;
  staleMs?: number;
  /** Per (user, source) rate limit (default 5/s, burst 10). */
  ratePerSec?: number;
  burst?: number;
  breaker?: BreakerOptions;
  /** Concurrency limit per (user, source): AIMD between 1 and `maxConcurrency` (default 4). */
  maxConcurrency?: number;
  now?: () => number;
}

interface PerSource {
  breaker: CircuitBreaker;
  limiter: AimdLimiter;
  latency: RollingHistogram;
}

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;
/** Per-source state kept for at most this many (user, source) pairs; the least recently used is dropped. */
const MAX_STATES = 100_000;

export class SourceFanout {
  private readonly per = new Map<string, PerSource>();
  private readonly flights = new Singleflight<string, ContextItem[]>();
  private readonly results: S3FifoCache<string, ContextItem[]> | null;
  private readonly rate: Gcra<string>;
  private readonly shadowRate: Gcra<string>;
  private readonly options: FanoutOptions;
  private readonly now: () => number;
  /** The `PlanCalls` this fan-out handed out: a planned source using one returns items already sanitized here. */
  private readonly minted = new WeakSet<PlanCalls>();
  /** Counts `forget` calls: a planner call that started before one does not write its result back. */
  private forgets = 0;

  constructor(options: FanoutOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    const bytes = options.cacheBytes ?? 32_000_000;
    this.results =
      bytes > 0
        ? new S3FifoCache({
            maxBytes: bytes,
            staleAfterMs: options.freshMs ?? 60_000,
            expireAfterMs: options.staleMs ?? 600_000,
            now: this.now,
          })
        : null;
    const ratePerSec = options.ratePerSec ?? 5;
    const burst = options.burst ?? 10;
    this.rate = new Gcra({ ratePerSec, burst, now: this.now });
    // Shadow lookups' own bucket (permitShadow): half the rate and half the burst.
    this.shadowRate = new Gcra({
      ratePerSec: ratePerSec / 2,
      burst: Math.max(1, Math.floor(burst / 2)),
      now: this.now,
    });
  }

  /** Searches `sources` for `query` within `timeoutMs`, cancelled with `signal`. */
  async search(
    sources: Source[],
    query: SearchQuery,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<FanoutOutcome[]> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const deadline = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return Promise.all(sources.map((source) => this.one(source, query, deadline, timeout)));
  }

  /** Drops everything held for a user (cached results and per-source state), or for one of their sources. */
  forget(scope: Scope, sourceId?: string): void {
    const prefix = sourceId ? `${scopeKey(scope)}|${sourceId}|` : `${scopeKey(scope)}|`;
    this.forgets++;
    this.results?.deleteWhere((k) => k.startsWith(prefix));
    for (const k of [...this.per.keys()]) if (`${k}|`.startsWith(prefix) || k.startsWith(prefix)) this.per.delete(k);
  }

  /**
   * One more call to a source within a lookup already admitted (the query planner's extra calls): takes a token from
   * the same per-(user, source) rate limit, so the limit counts calls, not lookups. False when the limit is spent.
   */
  permit(scope: Scope, sourceId: string): boolean {
    return this.rate.take(`${scopeKey(scope)}|${sourceId}`) <= 0;
  }

  /**
   * A call that must never cost serving its budget (the query planner's shadow lookups). It draws from a separate
   * bucket at half the rate and half the burst, and only looks at serving's bucket (never takes from it): while
   * serving has nothing left, as after a 429, shadow waits too. The cost is upstream load: a shadowing deployment can
   * send a connector up to 1.5x what serving alone may (D29).
   */
  permitShadow(scope: Scope, sourceId: string): boolean {
    const key = `${scopeKey(scope)}|${sourceId}`;
    return this.rate.available(key) > 0 && this.shadowRate.take(key) <= 0;
  }

  /**
   * The query planner's calls to a source, through this fan-out (`PlanCalls`): each shape's query is cached apart
   * from whole lookups (its own key, so a lookup never joins its own call's flight), keyed by the query's own user,
   * shared while in flight, sanitized before it is held, and dropped by `forget`. A call that was abandoned, or that
   * was still running when any `forget` happened, returns what it got but holds nothing: writing it back could undo
   * the forget. Rate tokens, the breaker and the concurrency limit stay with the lookup that admitted the source and
   * with the planner's `permit`.
   */
  planCalls(source: Source): PlanCalls {
    const key = (q: SearchQuery) => `${scopeKey(q.scope)}|${source.id}|plan|${q.limit}|${q.text}`;
    const calls: PlanCalls = {
      cached: (q) => {
        const k = key(q);
        const v = this.results?.get(k);
        return v !== undefined && !this.results!.isStale(k) ? v : undefined;
      },
      call: (q, signal) => {
        const k = key(q);
        return this.flights.run(
          k,
          async (sig) => {
            const forgets = this.forgets;
            const items = await this.options.sanitize(await source.search(q, sig), sig);
            if (!sig.aborted && this.forgets === forgets) this.results?.set(k, items, sizeOf(items));
            return items;
          },
          signal,
        );
      },
    };
    this.minted.add(calls);
    return calls;
  }

  /** Tells the rate limits about an upstream's rate-limit error seen outside a fan-out call (shadow lookups). */
  rateLimited(scope: Scope, sourceId: string, message: string): void {
    if (!RATE_LIMITED.test(message)) return;
    const key = `${scopeKey(scope)}|${sourceId}`;
    const ms = retryAfterMs(message) ?? 5_000;
    this.rate.penalize(key, ms);
    this.shadowRate.penalize(key, ms);
  }

  /** The source's recent latency quantile in ms (NaN if no calls yet), for observability. */
  latency(scope: Scope, sourceId: string, q: number): number {
    return this.per.get(`${scopeKey(scope)}|${sourceId}`)?.latency.quantile(q) ?? NaN;
  }

  private state(key: string): PerSource {
    let s = this.per.get(key);
    if (s) {
      this.per.delete(key); // Re-insert: Map order is least recently used first.
      this.per.set(key, s);
    } else {
      if (this.per.size >= MAX_STATES) this.per.delete(this.per.keys().next().value as string);
      s = {
        breaker: new CircuitBreaker({ ...this.options.breaker, now: this.now }),
        limiter: new AimdLimiter({ initial: 2, min: 1, max: this.options.maxConcurrency ?? 4 }),
        latency: new RollingHistogram(60_000, this.now),
      };
      this.per.set(key, s);
    }
    return s;
  }

  private async one(
    source: Source,
    query: SearchQuery,
    deadline: AbortSignal,
    timeout: AbortSignal,
  ): Promise<FanoutOutcome> {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    const sourceKey = `${scopeKey(query.scope)}|${source.id}`;
    const cacheKey = `${sourceKey}|${query.limit}|${query.text}|${query.entities.join("\u0001")}`;
    const done = (status: FanoutStatus, items: ContextItem[], error?: string): FanoutOutcome => ({
      sourceId: source.id,
      status,
      items,
      latencyMs: elapsed(),
      ...(error ? { error } : {}),
    });

    const cached = this.results?.get(cacheKey);
    if (cached !== undefined && !this.results!.isStale(cacheKey)) return done("cached", cached);
    const stale = cached; // may be undefined
    const fallback = (status: FanoutStatus, error?: string) =>
      stale !== undefined ? done("stale", stale, error ?? status) : done(status, [], error);

    // Joining a call already in flight costs the source nothing: no permit, no rate-limit token, no breaker probe.
    if (this.flights.has(cacheKey)) {
      try {
        return done("ok", await this.flights.run(cacheKey, () => Promise.resolve([]), deadline));
      } catch (e) {
        return fallback(timeout.aborted ? "timeout" : "error", String(e));
      }
    }
    const s = this.state(sourceKey);
    if (!s.breaker.allow()) return fallback("open");
    if (this.rate.take(sourceKey) > 0) return fallback("limited");
    if (!s.limiter.tryAcquire()) return fallback("busy");

    const started = performance.now();
    try {
      // A planned source whose calls went through `planCalls` returns items sanitized there: not gated twice.
      const presanitized = source instanceof PlannedSource && source.via !== undefined && this.minted.has(source.via);
      const items = await this.flights.run(
        cacheKey,
        async (signal) => {
          const raw = await source.search(query, signal);
          return presanitized ? raw : this.options.sanitize(raw, signal);
        },
        deadline,
      );
      s.latency.record(performance.now() - started);
      s.limiter.release("ok");
      s.breaker.success();
      this.results?.set(cacheKey, items, sizeOf(items));
      return done("ok", items);
    } catch (e) {
      const message = String(e);
      const timedOut = timeout.aborted;
      if (deadline.aborted && !timedOut) {
        // The caller gave up (session ended, user forgotten): no evidence against the source. The breaker forgets
        // a half-open probe that never reports.
        s.limiter.release("ignored");
        return fallback("error", message);
      }
      s.latency.record(performance.now() - started);
      s.limiter.release("dropped");
      s.breaker.failure();
      if (RATE_LIMITED.test(message)) this.rate.penalize(sourceKey, retryAfterMs(message) ?? 5_000);
      return fallback(timedOut ? "timeout" : "error", message);
    }
  }
}

/** A result's weight in the cache: bytes of item text, at least 1. */
function sizeOf(items: ContextItem[]): number {
  return Math.max(
    1,
    items.reduce((n, it) => n + it.title.length + it.text.length, 0),
  );
}

/** A Retry-After hint in an error message ("retry after 30", "Retry-After: 12"), in ms. */
function retryAfterMs(message: string): number | undefined {
  const m = /retry.?after\D{0,3}(\d{1,5})/i.exec(message);
  return m ? Number(m[1]) * 1_000 : undefined;
}
