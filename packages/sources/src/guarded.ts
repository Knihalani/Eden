/**
 * Fan-out to a user's sources with the resilience layer from `@eden/primitives` around every call. Sources are slow,
 * rate-limited, and sometimes down; a lookup must still finish inside its deadline with the best it can get.
 *
 * Per (user, source):
 * - a circuit breaker: a failing connector is skipped (status "open") instead of costing a timeout per lookup;
 * - an adaptive concurrency limit (AIMD): a saturated connector is skipped ("busy") rather than queued;
 * - a GCRA rate limit, pushed back by rate-limit errors (429 / "rate limit" / Retry-After) ("limited" when our own
 *   limit skips the call; "throttled" when the connector itself refused it as rate-limited, D212);
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
import { untilAborted } from "./abort";
import { FetchErrorResult, type ListPage, type SearchQuery, type Source } from "./source";

/**
 * One lookup's queries in flight or answered, by source and text (`sharedKey`): what the query planner and the probes
 * of the same lookup send alike ("Jamie Fox" to mail, by both) is sent once. A failed entry resolves to null.
 */
export type SharedCalls = Map<string, Promise<ContextItem[] | null>>;

/** The key of a query in `SharedCalls`: the source, the text in lowercase with its spacing collapsed, and a window. */
export function sharedKey(sourceId: string, q: SearchQuery): string {
  // Quotes kept: a phrase query ("Dana Lee" in quotes) and the same words loose may find different items.
  const text = q.text.toLowerCase().replace(/\s+/g, " ").trim();
  return `${sourceId}|${text}|${q.window ? `${q.window.start}..${q.window.end}` : ""}`;
}

/**
 * How a source answered a call. "limited" is our own rate limit skipping the call (no call went out); "throttled" is
 * the connector's own rate-limit refusal (a 429, "rate limit", "too many requests"): the call reached it, and its
 * answer was "not now" (D212). Before D212 a 429 was an "error".
 */
export type FanoutStatus = "ok" | "cached" | "stale" | "error" | "throttled" | "timeout" | "open" | "busy" | "limited";

export interface FanoutOutcome {
  sourceId: string;
  status: FanoutStatus;
  items: ContextItem[];
  latencyMs: number;
  error?: string;
  /** The outcome of a call already in flight for the same query, joined: the connector received no call of its own. */
  joined?: true;
}

/**
 * Why `fetchChecked` could not say (D211): the source has no fetch tool ("no-fetch"), a guard skipped the call
 * ("refused"), the caller gave up ("aborted"), the call failed ("error", "timeout") or the connector refused it as
 * rate-limited ("throttled"), the source answered null without `fetchReportsGone` ("null"), or our gate failed
 * ("gate"). Only "error" is worth one immediate retry: the others would be refused or answered the same way again.
 * A refusal names its guard (`guard`): "open" (the breaker) says the source is in trouble now; "limited" is our rate
 * limit, which is in trouble too only when the connector's own rate-limit error pushed it back (`pushedBack`); without
 * that, like "busy" (no free permit), it is ordinary use that clears in moments.
 */
export interface FetchFailed {
  status: "failed";
  why: "no-fetch" | "refused" | "aborted" | "error" | "timeout" | "throttled" | "null" | "error-result" | "gate";
  guard?: "open" | "limited" | "busy";
  pushedBack?: boolean;
}

/** Statuses of a call a guard refused before it went out (no rate token, no call). */
const REFUSED = new Set<string>(["open", "busy", "limited"]);

/**
 * Whether this outcome is a call the connector received. Not one answered by the result cache ("cached"), one that
 * joined another lookup's call in flight (`joined`), or one a guard refused (with a stale result, a "stale" outcome
 * whose `error` names the refusal). A call that failed or timed out at the connector was received.
 */
export function reachedSource(o: FanoutOutcome): boolean {
  if (o.joined || o.status === "cached" || REFUSED.has(o.status)) return false;
  return !(o.status === "stale" && o.error !== undefined && REFUSED.has(o.error));
}

/**
 * `planCalls`' calls with a count of those that reached the connector (`made`): a shape's query answered from the
 * cache, by `SharedCalls`, or by joining a call already in flight is not one.
 */
export interface CountedPlanCalls extends PlanCalls {
  made: number;
}

/**
 * Lets a listing skip redacting items the caller already holds unchanged (`SourceFanout.list`'s `reuse`): a sync
 * re-lists mostly what it has. `held` returns the caller's redacted copy of `raw` only when `raw` is exactly what that
 * copy was made from, else undefined (the item is redacted as usual); `made` tells it the copy made of `raw`.
 */
export interface ListReuse {
  held(raw: ContextItem): ContextItem | undefined;
  made(raw: ContextItem, redacted: ContextItem): void;
}

export interface FanoutOptions {
  /**
   * Redacts items before they are cached or returned. Required: nothing unredacted is held. It may be asynchronous
   * (gating in a worker pool) and runs inside the call's deadline; `signal` aborts with the call. Items it leaves out
   * are dropped.
   */
  sanitize: (items: ContextItem[], signal: AbortSignal) => ContextItem[] | Promise<ContextItem[]>;
  /**
   * Result cache budget in bytes (default 32 MB); 0 disables caching. A page is charged its estimated heap: item text,
   * its key, and a measured overhead per entry and per item (`sizeOf`), so an empty page is not free.
   */
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
  /** Per-source state is kept for at most this many (user, source) pairs (default 100,000); tests make it small. */
  maxStates?: number;
  now?: () => number;
}

interface PerSource {
  breaker: CircuitBreaker;
  limiter: AimdLimiter;
  latency: RollingHistogram;
  /**
   * Latency of the planner's single calls (`planCalls`), apart from whole lookups, which may be several calls. Made on
   * the first one: most (user, source) pairs never see the planner.
   */
  callLatency?: RollingHistogram;
  /** Until when the rate limit is pushed back by the connector's own rate-limit error (engine clock), if it was. */
  pushedBackUntil?: number;
  /** When a call last took this state (`state`, the fan-out's clock): `park` reads it. */
  usedAt: number;
}

/**
 * The calls of one (user, source) running now that may write a page back, and the `dropResults` calls since the
 * first of them started. Kept apart from `PerSource`, which can be evicted while a call runs: a drop must reach every
 * call it overlaps. Exists only while a call runs, so it is bounded by the calls in flight.
 */
interface Running {
  calls: number;
  drops: number;
}

/** A call's place in its pair's `Running`: the drops seen when it started. */
interface DropMark {
  running: Running;
  drops: number;
}

/**
 * The call leading the flight for one result key, beside the flight itself: its flight key (the result key and a
 * sequence number, so a caller that may not join leads a new flight under its own key) and its drop mark and
 * `forgets` when it started. A caller joins only while neither moved: a call begun before a `dropResults` read the
 * source as it was, and a lookup after the drop that joined it would get (and store under its own later read mark,
 * D133) the copy from before the change.
 */
interface Lead {
  flight: string;
  mark: DropMark;
  forgets: number;
}

/** Planner calls a connector's call-latency quantile needs before it is trusted. */
const MIN_CALL_SAMPLES = 5;
/**
 * The call-latency history's window: ten minutes, not one, since a user's planner calls to one connector are sparse
 * and its latency changes slowly. A rolling histogram answers over the current and the previous window: 10–20 min.
 */
const CALL_LATENCY_WINDOW_MS = 600_000;

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;
/** The name of an error raised by our own gate (redaction) rather than by the source. */
const GATE_ERROR = "GateError";
/** Per-source state kept for at most this many (user, source) pairs; the least recently used is dropped. */
const MAX_STATES = 100_000;
/** A pair's concurrency limit before it has learned one. */
const LIMIT_INITIAL = 2;
/**
 * A (user, source) pair's guards are looked at for parking once no call has taken them for this long (D754): as
 * long as the longest history they hold by default (a rolling histogram answers over its current and its previous
 * window, so the planner calls' ten-minute one holds a sample for up to twenty). `park` then checks what they
 * hold, not the time alone: a breaker's window can be configured longer, and a report can be written long after
 * its call began.
 */
const PARK_IDLE_MS = 2 * CALL_LATENCY_WINDOW_MS;
/**
 * Pairs `state` looks at for parking each time it is called: the least recently used. The scan stops at the first
 * pair that is not idle, so a call pays for it only while idle pairs are there to park. (At 8 a user whose requests
 * make few calls kept a quarter of their idle guards after ten requests.)
 */
const PARK_SCAN = 64;

/**
 * A results-cache key: the (user, source) pair, length-prefixed so the pair is read back exactly (`pairOf`) whatever
 * characters a tenant, user or source id holds, then the rest of the query.
 */
function resultKey(pair: string, rest: string): string {
  return `${pair.length}:${pair}|${rest}`;
}

/**
 * The results-cache key of a search page: `one()` holds its page under it, and `held` reads it back. One helper, so a
 * cache-only read can never build a key the search did not.
 */
function pageKey(scope: Scope, sourceId: string, query: SearchQuery): string {
  const span = query.window ? `|${query.window.start}..${query.window.end}` : "";
  return resultKey(
    `${scopeKey(scope)}|${sourceId}`,
    `${query.limit}|${query.text}|${query.entities.join("\u0001")}${span}`,
  );
}

/** The (user, source) pair a `resultKey` belongs to: the results cache's group, so a drop is O(that pair's pages). */
function pairOf(key: string): string {
  const colon = key.indexOf(":");
  return key.slice(colon + 1, colon + 1 + Number(key.slice(0, colon)));
}

export class SourceFanout {
  private readonly per = new Map<string, PerSource>();
  /**
   * The concurrency limit of each pair whose guards were parked (`park`), by the pair's key, least recently parked
   * first, at most `maxStates` (past it the oldest is let go, as a pair's guards are). A user with 1,000 sources
   * otherwise holds about 1 MB of guards for sources called once, in their backfill (o4-per-source.md).
   */
  private readonly parked = new Map<string, number>();
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
  /** Calls that may write a page back, by (user, source), while they run: what `dropResults` must reach. */
  private readonly running = new Map<string, Running>();
  /**
   * The flight leading each result key, while its call runs (set and cleared inside the flight's own function, so it
   * is bounded by the calls in flight and released however the call ends).
   */
  private readonly leads = new Map<string, Lead>();
  private flightSeq = 0;
  private readonly maxStates: number;

  constructor(options: FanoutOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.maxStates = Math.max(1, options.maxStates ?? MAX_STATES);
    const bytes = options.cacheBytes ?? 32_000_000;
    this.results =
      bytes > 0
        ? new S3FifoCache({
            maxBytes: bytes,
            staleAfterMs: options.freshMs ?? 60_000,
            expireAfterMs: options.staleMs ?? 600_000,
            now: this.now,
            group: pairOf,
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

  /**
   * The page a search of `sourceId` for `query` would be answered from without a call, or undefined: a fresh one as
   * "cached", one past `freshMs` (but not expired) as "stale" with error "timeout", as `one()`'s fallback reports a
   * call cut off by the deadline. Cache only: no rate token, concurrency slot, breaker probe or flight, so a lookup
   * with no time left to search still answers from what is held (D140). A `forget` or `dropResults` deleted the
   * pair's pages, so nothing from before one is served.
   */
  held(sourceId: string, query: SearchQuery): FanoutOutcome | undefined {
    const k = pageKey(query.scope, sourceId, query);
    const page = this.results?.get(k);
    if (page === undefined) return undefined;
    return this.results!.isStale(k)
      ? { sourceId, status: "stale", items: page, latencyMs: 0, error: "timeout" }
      : { sourceId, status: "cached", items: page, latencyMs: 0 };
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

  /**
   * One item by its ref through the source's `fetch` (refreshing a cached item), under the same per-(user, source)
   * breaker, rate limit and concurrency limit as a search, within `timeoutMs`, sanitized before it is returned. Not
   * cached here: a refresh wants the source's current copy. Null when the source has no fetch, a guard skips the call,
   * it fails, or the source returns nothing. Never throws.
   */
  async fetch(
    source: Source,
    scope: Scope,
    ref: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ContextItem | null> {
    const got = await this.fetchChecked(source, scope, ref, options);
    return got.status === "ok" ? got.item : null;
  }

  /**
   * `fetch`, telling apart what `fetch` folds into null: the source answered with the item (`ok`), answered that it
   * has no such item (`gone`: a null from a source whose `fetchReportsGone` is true), or could not say (`failed`: no
   * fetch, a guard skipped the call, an error, a timeout, a gate failure, a null from any other source). A freshness
   * check drops an item only when it is `gone`.
   */
  async fetchChecked(
    source: Source,
    scope: Scope,
    ref: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ status: "ok"; item: ContextItem } | { status: "gone" } | FetchFailed> {
    const failed = (why: FetchFailed["why"]): FetchFailed => ({ status: "failed", why });
    if (!source.fetch) return failed("no-fetch");
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const key = `${scopeKey(scope)}|${source.id}`;
    const s = this.state(key);
    const epoch = this.admit(key, s);
    if (typeof epoch !== "number") {
      const pushedBack = epoch === "limited" && (s.pushedBackUntil ?? -Infinity) > this.now();
      return { status: "failed", why: "refused", guard: epoch, ...(pushedBack ? { pushedBack } : {}) };
    }
    const started = performance.now();
    let raw: ContextItem | null;
    try {
      raw = await untilAborted(source.fetch(ref, scope, signal), signal);
    } catch (e) {
      const message = String(e);
      if (signal.aborted && !timeout.aborted) {
        s.limiter.release("ignored"); // The caller gave up: no evidence against the source.
        return failed("aborted");
      }
      s.latency.record(performance.now() - started);
      if (e instanceof FetchErrorResult) {
        // The source answered, with an error result (`isError`): settled as answered, as its null was before D298;
        // it says nothing either way about the item, and is not held (`error-result`, not `null`).
        s.limiter.release("ok");
        s.breaker.success(epoch);
        return failed("error-result");
      }
      s.limiter.release("dropped");
      s.breaker.failure(epoch);
      if (RATE_LIMITED.test(message)) {
        this.pushBack(key, s, retryAfterMs(message) ?? 5_000);
        return failed("throttled");
      }
      return failed(timeout.aborted ? "timeout" : "error");
    }
    // The source answered: its permit and breaker are settled once, here. Gating is ours, not the source's: a gate
    // that fails or runs out of time drops the item and says nothing against the source.
    s.latency.record(performance.now() - started);
    s.limiter.release("ok");
    s.breaker.success(epoch);
    // Null is "no such item" only from a source that says so (`fetchReportsGone`); from another (an MCP tool's
    // reply without the asked-for row could be an error worded as prose) it says nothing either way.
    if (!raw) return source.fetchReportsGone === true ? { status: "gone" } : failed("null");
    try {
      const [item] = await this.options.sanitize([raw], signal);
      return item ? { status: "ok", item } : failed("gate");
    } catch {
      return failed("gate");
    }
  }

  /**
   * One page of a source's listing through its `list` (a background sync, D57), under the same per-(user, source)
   * breaker, rate limit and concurrency limit as a search, within `timeoutMs`, sanitized before it is returned. Not
   * cached here: a listing wants the source's current page. `reserve` rate tokens must be left after this call's own
   * (background syncing leaves serving its headroom; a lookup's own sync call reserves none). Returns the page, or why
   * there is none: the guard that skipped the call ("open", "limited", "busy"), the connector's own rate-limit refusal
   * ("throttled", D212), or "error"/"timeout". Never throws.
   */
  async list(
    source: Source,
    scope: Scope,
    cursor: string | undefined,
    limit: number,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      reserve?: number;
      reuse?: ListReuse;
      /** Awaited after the source answered and before its page is redacted (the sync's `syncIngestTurns`, D328). */
      turn?: () => Promise<void>;
    },
  ): Promise<ListPage | Exclude<FanoutStatus, "ok" | "cached" | "stale">> {
    if (!source.list) return "error";
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const key = `${scopeKey(scope)}|${source.id}`;
    if ((options.reserve ?? 0) > 0 && this.rate.available(key) < 1 + options.reserve!) return "limited";
    const s = this.state(key);
    const epoch = this.admit(key, s);
    if (typeof epoch !== "number") return epoch;
    const started = performance.now();
    let page: ListPage;
    try {
      page = await source.list(scope, cursor, limit, signal);
    } catch (e) {
      const message = String(e);
      if (signal.aborted && !timeout.aborted) {
        s.limiter.release("ignored"); // The caller gave up: no evidence against the source.
        return "error";
      }
      s.latency.record(performance.now() - started);
      s.limiter.release("dropped");
      s.breaker.failure(epoch);
      if (RATE_LIMITED.test(message)) {
        this.pushBack(key, s, retryAfterMs(message) ?? 5_000);
        if (!timeout.aborted) return "throttled";
      }
      return timeout.aborted ? "timeout" : "error";
    }
    s.latency.record(performance.now() - started);
    s.limiter.release("ok");
    s.breaker.success(epoch);
    try {
      if (options.turn) await options.turn(); // Only when asked: an await here moves the funnel's card batching.
      return { items: await this.redactListed(page.items, signal, options.reuse), next: page.next };
    } catch {
      // Our gate failed, not the source: no page, and nothing unredacted held.
      return "error";
    }
  }

  /**
   * A listing's items redacted, in the source's order: those `reuse` holds unchanged are its copies, the rest go
   * through the hook. The hook may leave items out; then its output cannot be paired with its input, so nothing is
   * remembered and the whole page goes through the hook, as without `reuse`.
   */
  private async redactListed(raw: ContextItem[], signal: AbortSignal, reuse?: ListReuse): Promise<ContextItem[]> {
    if (!reuse) return this.options.sanitize(raw, signal);
    const held = raw.map((r) => reuse.held(r));
    const fresh = raw.filter((_, i) => held[i] === undefined);
    const made = fresh.length > 0 ? await this.options.sanitize(fresh, signal) : [];
    if (made.length !== fresh.length) return held.length === fresh.length ? made : this.options.sanitize(raw, signal);
    let next = 0;
    return held.map((h, i) => {
      if (h !== undefined) return h;
      const out = made[next++]!;
      reuse.made(raw[i]!, out);
      return out;
    });
  }

  /** Drops everything held for a user (cached results and per-source state), or for one of their sources. */
  forget(scope: Scope, sourceId?: string): void {
    const prefix = sourceId ? `${scopeKey(scope)}|${sourceId}|` : `${scopeKey(scope)}|`;
    this.forgets++;
    if (sourceId) this.results?.deleteGroup(`${scopeKey(scope)}|${sourceId}`);
    else this.results?.deleteWhere((k) => pairOf(k).startsWith(prefix)); // Rare (forget-a-user): a scan is fine.
    for (const k of [...this.per.keys()]) if (`${k}|`.startsWith(prefix) || k.startsWith(prefix)) this.per.delete(k);
    for (const k of [...this.parked.keys()]) {
      if (`${k}|`.startsWith(prefix) || k.startsWith(prefix)) this.parked.delete(k);
    }
  }

  /**
   * Drops the results held for one of a user's sources, keeping its breaker, limits and latency: the source changed or
   * deleted something, so a held page may show it as it was. A call still running when this happens holds nothing.
   */
  dropResults(scope: Scope, sourceId: string): void {
    const key = `${scopeKey(scope)}|${sourceId}`;
    // Counted per (user, source), not on `forgets`: one user's notifications must not stop other users' calls from
    // holding their pages or recording their latency. Counted on the pair's running calls, not on its `PerSource`
    // (which LRU eviction can drop mid-call, losing the drop): no running call means none can write a page back.
    const r = this.running.get(key);
    if (r) r.drops++;
    this.results?.deleteGroup(key);
  }

  /** Registers a call of a (user, source) that may write a page back; `leave` it when it ends, however it ends. */
  private enter(key: string): DropMark {
    let running = this.running.get(key);
    if (!running) {
      running = { calls: 0, drops: 0 };
      this.running.set(key, running);
    }
    running.calls++;
    return { running, drops: running.drops };
  }

  private leave(key: string, mark: DropMark): void {
    if (--mark.running.calls === 0 && this.running.get(key) === mark.running) this.running.delete(key);
  }

  /** No `dropResults` for the call's pair since it entered. */
  private undropped(mark: DropMark): boolean {
    return mark.running.drops === mark.drops;
  }

  /** The flight a call for `key` may join: one in flight with no drop for its pair and no `forget` since it began. */
  private joinable(key: string): string | undefined {
    const lead = this.leads.get(key);
    if (!lead || !this.flights.has(lead.flight)) return undefined;
    return this.undropped(lead.mark) && this.forgets === lead.forgets ? lead.flight : undefined;
  }

  /**
   * Runs `fn` as the leader of a new flight for result key `key` of pair `pair`, registered (`enter`) and joinable
   * for exactly as long as `fn` runs, even after the caller that started it stops waiting while others still do.
   * `fn` gets the call's drop mark and `forgets` at its start, to decide whether to hold its result.
   */
  private lead(
    key: string,
    pair: string,
    fn: (signal: AbortSignal, mark: DropMark, forgets: number) => Promise<ContextItem[]>,
    signal: AbortSignal | undefined,
  ): Promise<ContextItem[]> {
    const flight = `${key}\u0002${++this.flightSeq}`;
    return this.flights.run(
      flight,
      async (sig) => {
        const mark = this.enter(pair);
        const lead: Lead = { flight, mark, forgets: this.forgets };
        this.leads.set(key, lead);
        try {
          return await fn(sig, mark, lead.forgets);
        } finally {
          this.leave(pair, mark);
          if (this.leads.get(key) === lead) this.leads.delete(key);
        }
      },
      signal,
    );
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
  planCalls(source: Source, shared?: SharedCalls): CountedPlanCalls {
    const sourceKey = (q: SearchQuery) => `${scopeKey(q.scope)}|${source.id}`;
    const key = (q: SearchQuery) =>
      resultKey(sourceKey(q), `plan|${q.limit}|${q.text}` + (q.window ? `|${q.window.start}..${q.window.end}` : ""));
    const calls: CountedPlanCalls = {
      made: 0,
      expectMs: (q, quantile) => {
        const h = this.per.get(sourceKey(q))?.callLatency;
        return h && h.count >= MIN_CALL_SAMPLES ? h.quantile(quantile) : 0;
      },
      cached: (q) => {
        const k = key(q);
        const v = this.results?.get(k);
        return v !== undefined && !this.results!.isStale(k) ? v : undefined;
      },
      call: async (q, signal) => {
        // The same query to the same source made in this lookup by someone else (a probe, `SharedCalls`): its items,
        // at no call. One that failed is no answer: the call is made.
        const sk = shared ? sharedKey(source.id, q) : "";
        const had = shared?.get(sk);
        if (had) {
          const got = await had.catch(() => null);
          if (got) return got;
        }
        const k = key(q);
        // A call in flight for the same query joins, unless a drop or forget came since it began (`joinable`).
        const flight = this.joinable(k);
        const run = flight
          ? this.flights.run(flight, () => Promise.resolve([]), signal)
          : this.lead(
              k,
              sourceKey(q),
              async (sig, drops, forgets) => {
                // Only the flight's leader runs this: a call that joins it is not one the connector receives.
                calls.made++;
                const t0 = performance.now();
                let raw: ContextItem[];
                try {
                  raw = await source.search(q, sig);
                } catch (e) {
                  // A call cut off by the timeout counts with its time so far (a lower bound): the slow calls are the
                  // ones the estimate must see. One abandoned for another reason (the session ended, the user was
                  // forgotten) or failing fast says nothing about latency.
                  if ((sig.reason as Error | undefined)?.name === "TimeoutError")
                    this.recordCall(sourceKey(q), t0, forgets);
                  throw e;
                }
                this.recordCall(sourceKey(q), t0, forgets);
                const items = await this.gate(raw, sig);
                const held = this.forgets === forgets && this.undropped(drops);
                if (!sig.aborted && held) this.results?.set(k, items, sizeOf(k, items));
                return items;
              },
              signal,
            );
        if (shared) shared.set(sk, run);
        return run;
      },
    };
    this.minted.add(calls);
    return calls;
  }

  /**
   * One planner call's latency into its (user, source) history. Only into state that exists (the lookup that
   * admitted the source made it), and not if any `forget` happened since the call started: recording then could
   * bring back state the forget dropped.
   */
  private recordCall(key: string, t0: number, forgets: number): void {
    const s = this.per.get(key);
    if (!s || this.forgets !== forgets) return;
    (s.callLatency ??= new RollingHistogram(CALL_LATENCY_WINDOW_MS, this.now)).record(performance.now() - t0);
  }

  /** Tells the rate limits about an upstream's rate-limit error seen outside a fan-out call (shadow lookups). */
  rateLimited(scope: Scope, sourceId: string, message: string): void {
    if (!RATE_LIMITED.test(message)) return;
    const key = `${scopeKey(scope)}|${sourceId}`;
    const ms = retryAfterMs(message) ?? 5_000;
    // A parked pair's guards come back to note the push-back, as the guards it had would have (`FetchFailed`).
    this.pushBack(key, this.per.get(key) ?? (this.parked.has(key) ? this.state(key) : undefined), ms);
    this.shadowRate.penalize(key, ms);
  }

  /** Pushes the rate limit back after the connector's own rate-limit error, and notes until when (`FetchFailed`). */
  private pushBack(key: string, s: PerSource | undefined, ms: number): void {
    // Until the bucket is full again, not until the Retry-After ends: the refusals in between are the penalty's too.
    const until = this.rate.penalize(key, ms);
    if (s && until >= 0) s.pushedBackUntil = Math.max(s.pushedBackUntil ?? 0, until);
  }

  /** The source's recent latency quantile in ms (NaN if no calls yet), for observability. */
  latency(scope: Scope, sourceId: string, q: number): number {
    return this.per.get(`${scopeKey(scope)}|${sourceId}`)?.latency.quantile(q) ?? NaN;
  }

  /**
   * Admits one call to a source, or says why not. Each check that refuses takes nothing: the rate token is spent and
   * the breaker's half-open probe is taken only once the call is sure to go, so a call skipped as limited or busy
   * neither burns a token nor uses up the probe. Returns the breaker epoch to report with.
   */
  private admit(key: string, s: PerSource): number | "open" | "limited" | "busy" {
    if (s.breaker.state === "open") return "open";
    if (this.rate.available(key) < 1) return "limited";
    if (!s.limiter.tryAcquire()) return "busy";
    if (!s.breaker.allow()) {
      s.limiter.release("ignored"); // half-open with its probe already out
      return "open";
    }
    this.rate.take(key);
    return s.breaker.epoch;
  }

  /** Sanitizes a source's items, marking a failure as the gate's (`GATE_ERROR`), not the source's. */
  private async gate(items: ContextItem[], signal: AbortSignal): Promise<ContextItem[]> {
    try {
      return await this.options.sanitize(items, signal);
    } catch (e) {
      const error = new Error(`gate: ${e instanceof Error ? e.message : String(e)}`);
      error.name = GATE_ERROR;
      throw error;
    }
  }

  private state(key: string): PerSource {
    const now = this.now();
    let s = this.per.get(key);
    if (s) {
      this.per.delete(key); // Re-insert: Map order is least recently used first.
      this.per.set(key, s);
    } else {
      if (this.per.size >= this.maxStates) this.per.delete(this.per.keys().next().value as string);
      // A parked pair comes back with the limit it had learned; everything else it held had run out (`park`).
      const limit = this.parked.get(key);
      this.parked.delete(key);
      s = {
        breaker: new CircuitBreaker({ ...this.options.breaker, now: this.now }),
        limiter: new AimdLimiter({ initial: limit ?? LIMIT_INITIAL, min: 1, max: this.options.maxConcurrency ?? 4 }),
        latency: new RollingHistogram(60_000, this.now),
        usedAt: now,
      };
      this.per.set(key, s);
    }
    s.usedAt = now;
    this.park(now);
    return s;
  }

  /** How many (user, source) pairs hold guards, and how many hold only a parked limit (observability, tests). */
  guards(): { live: number; parked: number } {
    return { live: this.per.size, parked: this.parked.size };
  }

  /**
   * D754: parks the guards of pairs no call has taken for `PARK_IDLE_MS`, looking at the `PARK_SCAN` least recently
   * used each time `state` is called (so the work is bounded per call and needs no timer). A pair is parked only
   * when a new set of guards would behave as its own do: nothing in flight, the breaker closed with an empty window,
   * both latency histories empty, no rate-limit push-back still standing. Its learned concurrency limit is kept
   * (`parked`) and given back on its next call. What is not kept: the phase of the histograms' rolling windows (a
   * new one's windows start when it is made), which moves by up to a window when a later sample runs out; and a
   * planner call that runs with no lookup holding the pair's permit and reports after the pair was parked is not
   * recorded (`recordCall` writes only into guards that exist; in the shipped wiring such a call runs inside a
   * lookup). A pair
   * that is idle but not so (an open breaker, a call that never returned its permit) is moved behind the others, so
   * it cannot hold up the scan; it is still dropped at `maxStates` as before, a little later than its last use
   * alone would have it.
   */
  private park(now: number): void {
    let seen = 0;
    for (const [key, s] of this.per) {
      if (seen++ >= PARK_SCAN || now - s.usedAt < PARK_IDLE_MS) return;
      this.per.delete(key);
      const quiet =
        s.limiter.inFlight === 0 &&
        s.breaker.idle &&
        s.latency.count === 0 &&
        (s.callLatency?.count ?? 0) === 0 &&
        !(s.pushedBackUntil! > now);
      if (!quiet) {
        this.per.set(key, s);
        continue;
      }
      if (this.parked.size >= this.maxStates) this.parked.delete(this.parked.keys().next().value as string);
      this.parked.set(key, s.limiter.learned);
    }
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
    const cacheKey = pageKey(query.scope, source.id, query);
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
    // Not one begun before a drop or forget (`joinable`): the caller then leads a fresh call below.
    const flight = this.joinable(cacheKey);
    if (flight) {
      try {
        return { ...done("ok", await this.flights.run(flight, () => Promise.resolve([]), deadline)), joined: true };
      } catch (e) {
        return { ...fallback(failure(timeout.aborted, String(e)), String(e)), joined: true };
      }
    }
    const s = this.state(sourceKey);
    const epoch = this.admit(sourceKey, s);
    if (typeof epoch !== "number") return fallback(epoch);

    const started = performance.now();
    // This caller's own mark, held until it has decided whether to write back (the flight's mark, which `lead` keeps
    // for joining, ends with the call, a few microtasks before this caller resumes).
    const forgets = this.forgets;
    const drops = this.enter(sourceKey);
    // Set once the source has answered: a deadline that runs out after that ran out in our gate, not at the source.
    let answered = false;
    try {
      // A planned source whose calls went through `planCalls` returns items sanitized there: not gated twice.
      const presanitized = source instanceof PlannedSource && source.via !== undefined && this.minted.has(source.via);
      const items = await this.lead(
        cacheKey,
        sourceKey,
        async (signal) => {
          const raw = await source.search(query, signal);
          answered = true;
          return presanitized ? raw : this.gate(raw, signal);
        },
        deadline,
      );
      s.latency.record(performance.now() - started);
      s.limiter.release("ok");
      s.breaker.success(epoch);
      // A forget, or this pair's `dropResults`, while the call ran: writing the result back could undo it.
      if (this.forgets === forgets && this.undropped(drops))
        this.results?.set(cacheKey, items, sizeOf(cacheKey, items));
      return done("ok", items);
    } catch (e) {
      const message = String(e);
      const timedOut = timeout.aborted;
      if ((e as Error | undefined)?.name === GATE_ERROR || (answered && timedOut)) {
        s.latency.record(performance.now() - started);
        if (timedOut) {
          // The source answered so late that the gate ran out of time: neither a success nor the source's failure.
          s.limiter.release("ignored");
          return fallback("timeout", message);
        }
        // The source answered; our gate failed (a worker pool overloaded). No evidence against the source.
        s.limiter.release("ok");
        s.breaker.success(epoch);
        return fallback("error", message);
      }
      if (deadline.aborted && !timedOut) {
        // The caller gave up (session ended, user forgotten): no evidence against the source. The breaker forgets
        // a half-open probe that never reports.
        s.limiter.release("ignored");
        return fallback("error", message);
      }
      s.latency.record(performance.now() - started);
      s.limiter.release("dropped");
      s.breaker.failure(epoch);
      if (RATE_LIMITED.test(message)) this.pushBack(sourceKey, s, retryAfterMs(message) ?? 5_000);
      return fallback(failure(timedOut, message), message);
    } finally {
      this.leave(sourceKey, drops);
    }
  }
}

/**
 * Heap of one held page beyond its key and items, at steady state under eviction: the cache's slot (typed arrays,
 * ring), index and group entries, the page array, and its share of the ghost list (about one evicted key per live
 * one). Measured through this fan-out (200,000-400,000 empty pages, 16 MB budget, heap held by the cache = `bun:jsc`
 * heapSize after a full GC minus the same with the cache dropped): 789 / 971 / 1,252 B per live entry at 81 / 141 /
 * 381-char keys, so 627-689 B after charging the key at 2 B a character. Rounded up with ~10% margin.
 */
const ENTRY_OVERHEAD = 768;
/** Heap of one item beyond its title and text (the object, id, ref, source id): measured 93 B for short fields. */
const ITEM_OVERHEAD = 100;

/**
 * A result's weight in the cache, an estimate of its heap: the key at two bytes a character (it is held twice, live
 * and later as a ghost, at one byte a character for Latin-1 text), each item's title and text at one byte a character
 * (Latin-1 text is stored one byte a character; other scripts take two, so this undercounts them), and the measured
 * overheads. Before, an empty page cost 1 byte and the key nothing: the 32 MB budget held ~32M entries (~10 GB).
 */
function sizeOf(key: string, items: ContextItem[]): number {
  let n = ENTRY_OVERHEAD + key.length * 2;
  for (const it of items) n += ITEM_OVERHEAD + it.title.length + it.text.length;
  return n;
}

/** A call that reached the source and failed: "timeout", the connector's rate-limit refusal ("throttled"), "error". */
function failure(timedOut: boolean, message: string): "timeout" | "throttled" | "error" {
  if (timedOut) return "timeout";
  return RATE_LIMITED.test(message) ? "throttled" : "error";
}

/** A Retry-After hint in an error message ("retry after 30", "Retry-After: 12"), in ms. */
function retryAfterMs(message: string): number | undefined {
  const m = /retry.?after\D{0,3}(\d{1,5})/i.exec(message);
  return m ? Number(m[1]) * 1_000 : undefined;
}
