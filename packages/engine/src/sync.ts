/**
 * Background connector sync, "Eden Atlas" (D57, behind `sync`, off by default): each active user's sources are read
 * through their read-only list tools (`Source.list`) into the user's own item cache, so a lookup can be answered from
 * the local index and request-time source calls drop.
 *
 * Per user and source:
 * - a backfill of the newest `syncMaxItems` items across the user's sources (pages merged by recency, so a busy
 *   mailbox does not crowd out a quiet calendar's newest), then
 * - incremental polls: the listing read newest first until a page holds an item already synced and unchanged, every
 *   `syncEveryMs` while the user is active (0: no timed polls), or on demand when a lookup finds the source stale;
 * - a sweep every `syncSweepMs` (while active) that re-lists everything and drops what two sweeps in a row did not
 *   list (one can skip an item: an offset listing shifts under a delete between its pages);
 * - a per-(user, source) budget of `syncCallsPerMin`, on top of the fan-out's own guards (breaker, AIMD concurrency,
 *   the serving rate limit, which background calls leave headroom in).
 *
 * Whether a source's synced copy is current is a learned chance, not a fixed age: each source's rate of new or
 * changed items is a Gamma posterior (seeded by the recency of what the backfill read, updated by each poll), and the
 * copy is current while the chance that something changed since the last poll is below `syncStaleChance` (and the
 * poll is at most `syncMaxStaleMs` old). A busy mailbox goes stale in minutes, a CRM in hours.
 *
 * Everything here is keyed by tenant and user, bounded (users per tenant, items per user, ids per source), runs off
 * the fast path (timers or a lookup's slow path), and stores only what the fan-out has already redacted. Users idle
 * longer than `syncDropMs` are no longer synced and their synced items are dropped (retention, D57).
 */
import { Gcra } from "@eden/primitives";
import { scopeKey, type ContextItem, type Scope } from "@eden/protocol";
import type { Source, SourceFanout, SourceResolver } from "@eden/sources";
import type { ItemCache } from "./cache";
import type { Tracer } from "./spans";

export interface SyncOptions {
  /** Items synced per user at most, across sources: the newest. */
  maxItems: number;
  /** Items asked per listing page. */
  pageSize: number;
  /** Timed polls of an active user's sources, this often (ms); 0 for none (polls on demand only). */
  everyMs: number;
  /** A source's synced copy is stale once the chance that it changed since the last poll reaches this. */
  staleChance: number;
  /** ... or once its last poll is this old (ms), whatever the chance. */
  maxStaleMs: number;
  /** A user with an event this recently (ms) is active: timed polls and sweeps run only for active users. */
  activeMs: number;
  /** A full re-listing, for deletes, this often per source (ms) while the user is active. */
  sweepMs: number;
  /** A user idle this long (ms) is no longer synced; their synced items are dropped. */
  dropMs: number;
  /** Sync calls per (user, source) per minute (the sync's own budget). */
  callsPerMin: number;
  /** Pages a lookup's on-demand poll reads before it answers (the rest is read in the background). */
  catchupPages: number;
  /** Users synced per tenant; past it, the tenant's least recently active user stops being synced. */
  maxUsersPerTenant: number;
  /** A sync call's deadline (ms). */
  timeoutMs: number;
}

export interface SyncDeps {
  sources: SourceResolver;
  fanout: SourceFanout;
  cache: ItemCache;
  now: () => number;
  /** Items newly synced or changed (already redacted), for the source map's mentions. */
  onStored?: (scope: Scope, items: ContextItem[]) => void;
  /** Ids of every item a listing returned, changed or not (cards' time to live restarts for content still held). */
  onListed?: (scope: Scope, ids: string[]) => void;
  /** Span tracing (`spans.ts`): each listing call is a `sync.list` span naming its phase; absent or null when off. */
  tracer?: Tracer | null;
}

/** Hours of item history the backfill reads a source's change rate from. */
const PRIOR_HOURS = 7 * 24;
/** The change-rate posterior's memory (hours): older evidence is scaled down past this, so a source's pace can move. */
const RATE_MEMORY_HOURS = 14 * 24;
/** Pages a timed poll or a background catch-up reads at most in one go. */
const MAX_POLL_PAGES = 20;
/** Background sync calls leave this many of the serving rate limit's tokens for lookups. */
const SERVING_HEADROOM = 2;
const HOUR = 3_600_000;
/** Users a tick works on at once. */
const USERS_AT_ONCE = 16;

interface SourceSync {
  id: string;
  /** Ids of the items synced from this source, oldest synced first (bounded: `trimIds`). */
  ids: Set<string>;
  phase: "backfill" | "warm";
  /** The backfill's next page, and whether the listing has no more. */
  cursor: string | undefined;
  exhausted: boolean;
  /** The oldest `updatedAt` the backfill has read (+Infinity before its first page): the recency merge's key. */
  frontier: number;
  /** When the last complete poll (or the backfill) ended; -Infinity before. */
  polledAt: number;
  sweptAt: number;
  /**
   * The sweep under way, read across ticks: its next page and every id it (or any other read of the source since it
   * began: a poll, a lookup's on-demand poll) has seen listed.
   */
  sweep: { cursor: string | undefined; seen: Set<string> } | null;
  /**
   * Ids the last complete sweep did not list. An item is dropped only when two sweeps in a row miss it: an offset
   * listing shifts under a delete or an update between pages, so one sweep can skip an item the source still has.
   */
  missed: Set<string>;
  /** The change rate's Gamma posterior: new or changed items (alpha) over hours watched (beta). */
  alpha: number;
  beta: number;
  failures: number;
  retryAt: number;
  /** The poll or page read in flight, so two never overlap. */
  busy: Promise<void> | null;
}

interface UserSync {
  key: string;
  scope: Scope;
  sources: Map<string, SourceSync>;
  activeAt: number;
  /** Set when the user is dropped or forgotten: work still in flight for them stores nothing. */
  gone: boolean;
}

export interface SyncStats {
  /** Listing calls made in the background (backfill, timed polls, sweeps, catch-ups). */
  backgroundCalls: number;
  /** Listing calls made inside lookups (on-demand polls). */
  demandCalls: number;
  /** Items dropped because their source no longer lists them. */
  deleted: number;
}

export class SyncManager {
  private readonly users = new Map<string, UserSync>();
  private readonly budget: Gcra<string>;
  private ticking = false;
  readonly stats: SyncStats = { backgroundCalls: 0, demandCalls: 0, deleted: 0 };

  constructor(
    private readonly deps: SyncDeps,
    private readonly o: SyncOptions,
  ) {
    this.budget = new Gcra({
      ratePerSec: Math.max(1e-3, o.callsPerMin / 60),
      burst: Math.max(1, Math.ceil(o.callsPerMin / 3)),
      now: deps.now,
    });
  }

  /**
   * Notes that the user is active (an event arrived), and starts syncing them if they were not. O(1) and no I/O, so
   * safe on the fast path: the backfill itself runs at the next `tick`.
   */
  track(scope: Scope, now = this.deps.now()): void {
    const key = scopeKey(scope);
    const u = this.users.get(key);
    if (u) {
      u.activeAt = now;
      return;
    }
    this.users.set(key, {
      key,
      scope: { tenantId: scope.tenantId, userId: scope.userId },
      sources: new Map(),
      activeAt: now,
      gone: false,
    });
  }

  /** Stops syncing a user (or one of their sources) and drops the sync's state; the cache is the caller's to forget. */
  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    const u = this.users.get(key);
    if (!u) return;
    if (sourceId === undefined) {
      u.gone = true;
      this.users.delete(key);
      return;
    }
    u.sources.delete(sourceId);
  }

  /** Whether the user's synced copy of a source can answer a lookup now: warm, and probably unchanged since polled. */
  current(scope: Scope, sourceId: string, now = this.deps.now()): boolean {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    return s !== undefined && this.isCurrent(s, now);
  }

  /** Users synced now. */
  get userCount(): number {
    return this.users.size;
  }

  /** Whether every source of the user has finished its backfill (the harness waits on it). */
  warm(scope: Scope): boolean {
    const u = this.users.get(scopeKey(scope));
    return !!u && u.sources.size > 0 && [...u.sources.values()].every((s) => s.phase === "warm");
  }

  /**
   * One round of background work, for every synced user: drop the idle and those past the tenant's cap, then per
   * user backfill, timed polls and sweeps, as each source's budget allows. Never runs twice at once, never throws.
   * Returns the listing calls it made.
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    const before = this.stats.backgroundCalls;
    try {
      const now = this.deps.now();
      this.evict(now);
      // Users in parallel, `USERS_AT_ONCE` at a time: one user's slow connector must not hold up the rest.
      const queue = [...this.users.values()];
      const lane = async () => {
        for (let u = queue.shift(); u; u = queue.shift()) if (!u.gone) await this.step(u).catch(() => {});
      };
      await Promise.all(Array.from({ length: Math.min(USERS_AT_ONCE, queue.length) }, lane));
    } finally {
      this.ticking = false;
    }
    return this.stats.backgroundCalls - before;
  }

  /**
   * A lookup's on-demand poll (`syncOnDemand`): every warm source of the user that is not current is polled now,
   * at most `catchupPages` pages each before the lookup goes on (the rest is read in the background), within the
   * lookup's deadline. Returns the listing calls made; the sources it brought current answer the lookup locally.
   */
  async freshen(scope: Scope, sources: Source[], signal: AbortSignal): Promise<number> {
    const u = this.users.get(scopeKey(scope));
    if (!u) return 0;
    const now = this.deps.now();
    const before = this.stats.demandCalls;
    await Promise.all(
      sources.map(async (source) => {
        const s = u.sources.get(source.id);
        if (!s || s.phase !== "warm" || this.isCurrent(s, now) || !source.list) return;
        if (s.busy) {
          // A poll already running (timed, or another lookup's): its answer, not a second call.
          await Promise.race([s.busy, aborted(signal)]);
          return;
        }
        await this.run(s, () => this.poll(u, s, source, this.o.catchupPages, true, signal));
      }),
    );
    return this.stats.demandCalls - before;
  }

  // ── internals ──

  private isCurrent(s: SourceSync, now: number): boolean {
    if (s.phase !== "warm") return false;
    const age = now - s.polledAt;
    if (!(age <= this.o.maxStaleMs)) return false;
    const rate = s.alpha / s.beta; // items per hour
    return 1 - Math.exp((-rate * Math.max(0, age)) / HOUR) < this.o.staleChance;
  }

  /** Users idle past `dropMs`, and each tenant's least recently active past its cap, stop being synced. */
  private evict(now: number): void {
    const perTenant = new Map<string, UserSync[]>();
    for (const u of this.users.values()) {
      if (now - u.activeAt > this.o.dropMs) {
        this.drop(u);
        continue;
      }
      const list = perTenant.get(u.scope.tenantId) ?? [];
      list.push(u);
      perTenant.set(u.scope.tenantId, list);
    }
    for (const list of perTenant.values()) {
      if (list.length <= this.o.maxUsersPerTenant) continue;
      list.sort((a, b) => a.activeAt - b.activeAt);
      for (const u of list.slice(0, list.length - this.o.maxUsersPerTenant)) this.drop(u);
    }
  }

  /** Stops syncing a user and drops their synced items from the cache (retention, D57). */
  private drop(u: UserSync): void {
    u.gone = true;
    this.users.delete(u.key);
    for (const s of u.sources.values()) this.stats.deleted += this.deps.cache.dropSynced(u.scope, s.ids);
  }

  private async step(u: UserSync): Promise<void> {
    // A resolver that fails says nothing about which sources the user has: nothing is changed until it answers.
    const all = await this.deps.sources(u.scope).catch((): null => null);
    if (u.gone || all === null) return;
    const listable = all.filter((x) => typeof x.list === "function");
    for (const x of listable) {
      if (!u.sources.has(x.id)) u.sources.set(x.id, newSourceSync(x.id));
    }
    // A source the user no longer has (or that no longer lists) is not synced: its state and synced items go.
    for (const [id, s] of [...u.sources]) {
      if (listable.some((x) => x.id === id)) continue;
      u.sources.delete(id);
      this.stats.deleted += this.deps.cache.dropSynced(u.scope, s.ids);
    }
    const byId = new Map(listable.map((x) => [x.id, x]));
    await this.backfill(u, byId);
    const now = this.deps.now();
    const active = now - u.activeAt <= this.o.activeMs;
    if (!active) return;
    await Promise.all(
      [...u.sources.values()].map(async (s) => {
        const source = byId.get(s.id);
        if (!source || s.phase !== "warm" || s.busy || now < s.retryAt) return;
        if (s.sweep !== null || now - s.sweptAt >= this.o.sweepMs) {
          await this.run(s, () => this.sweep(u, s, source));
        } else if (this.o.everyMs > 0 && now - s.polledAt >= this.o.everyMs) {
          await this.run(s, () => this.poll(u, s, source, MAX_POLL_PAGES, false));
        }
      }),
    );
  }

  /**
   * The backfill: pages read newest first, always from the source whose next page holds the newest items not yet
   * read (the smallest `frontier` gap), until the user's `maxItems` or every listing is read. A source whose budget
   * or guards say wait is left for the next tick, as is the rest once any call fails.
   */
  private async backfill(u: UserSync, byId: Map<string, Source>): Promise<void> {
    for (;;) {
      if (u.gone) return;
      const now = this.deps.now();
      const filling = [...u.sources.values()].filter((s) => s.phase === "backfill");
      if (filling.length === 0) return;
      // Over the cap, the oldest synced go; then a source whose unread items are all older than the oldest kept has
      // nothing left that would be kept, and its backfill is done.
      if (this.total(u) >= this.o.maxItems) {
        const cut = this.trim(u, now);
        for (const s of filling) if (s.frontier <= cut) this.warmUp(u, s, now);
        if (filling.every((s) => s.phase === "warm")) return;
      }
      const ready = filling.filter((s) => s.phase === "backfill" && now >= s.retryAt && !s.busy);
      // The newest unread page first: the source whose read items reach least far back.
      const next = ready.sort((a, b) => b.frontier - a.frontier)[0];
      if (!next) return;
      const source = byId.get(next.id);
      if (!source) return;
      if (this.budget.take(budgetKey(u, next)) > 0) return;
      let page: Awaited<ReturnType<SourceFanout["list"]>> | undefined;
      await this.run(next, async () => {
        page = await this.list("backfill", source, u.scope, next.cursor, this.o.pageSize, {
          timeoutMs: this.o.timeoutMs,
          reserve: SERVING_HEADROOM,
        });
      });
      if (page === undefined || u.gone) return;
      if (typeof page === "string") {
        if (page !== "limited" && page !== "busy") this.stats.backgroundCalls++;
        this.failed(next, page);
        return;
      }
      this.stats.backgroundCalls++;
      next.failures = 0;
      this.store(u, next, page.items);
      for (const it of page.items)
        if (it.updatedAt !== undefined) next.frontier = Math.min(next.frontier, it.updatedAt);
      if (page.items.length > 0 && page.items.every((it) => it.updatedAt === undefined)) next.frontier = -Infinity;
      next.cursor = page.next ?? undefined;
      if (page.next === null || page.items.length === 0) {
        next.exhausted = true;
        this.warmUp(u, next, this.deps.now());
      }
    }
  }

  private total(u: UserSync): number {
    let n = 0;
    for (const s of u.sources.values()) n += s.ids.size;
    return n;
  }

  /**
   * Keeps the user's newest `maxItems` synced items across sources (by `updatedAt`; an item without one counts as
   * oldest) and drops the rest from the cache. Returns the oldest kept time: the backfill's cut. Pages are read
   * whole, so the merge is exact only after this trim.
   */
  private trim(u: UserSync, now: number): number {
    const all: { id: string; at: number; s: SourceSync }[] = [];
    for (const s of u.sources.values()) {
      for (const id of s.ids) all.push({ id, at: this.deps.cache.get(u.scope, id, now)?.updatedAt ?? -Infinity, s });
    }
    all.sort((a, b) => b.at - a.at);
    const gone = all.slice(this.o.maxItems);
    for (const g of gone) g.s.ids.delete(g.id);
    this.deps.cache.dropSynced(
      u.scope,
      gone.map((g) => g.id),
    );
    return all[Math.min(all.length, this.o.maxItems) - 1]?.at ?? -Infinity;
  }

  /**
   * A source's backfill is done: it is warm, polled as of now, and its change rate's prior is how many of what it
   * listed changed in the last week (per hour), or one an hour when its items carry no time.
   */
  private warmUp(u: UserSync, s: SourceSync, now: number): void {
    if (s.phase === "warm") return;
    s.phase = "warm";
    s.polledAt = now;
    s.sweptAt = now;
    let recent = 0;
    let timed = 0;
    for (const id of s.ids) {
      const at = this.deps.cache.get(u.scope, id, now)?.updatedAt;
      if (at === undefined) continue;
      timed++;
      if (at <= now && at > now - PRIOR_HOURS * HOUR) recent++;
    }
    // What the backfill read reaches back to `frontier`: a source cut off by the cap was read over less than a week.
    const span = Math.min(PRIOR_HOURS, Math.max(1, (now - s.frontier) / HOUR));
    if (timed > 0) {
      s.alpha = 1 + recent;
      s.beta = 1 + (s.exhausted ? PRIOR_HOURS : span);
    }
  }

  /**
   * An incremental poll: the listing read newest first until a page holds an item already synced and unchanged (what
   * follows is older, and was read before), the listing ends, or `maxPages`. A complete poll marks the source polled
   * and teaches its change rate. Pages past `maxPages` (a long catch-up) are read in the background, and the source
   * stays stale until they are.
   */
  private async poll(
    u: UserSync,
    s: SourceSync,
    source: Source,
    maxPages: number,
    demand: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = this.deps.now();
    let cursor: string | undefined;
    let changed = 0;
    for (let p = 0; p < maxPages; p++) {
      if (u.gone || signal?.aborted) return;
      if (this.budget.take(budgetKey(u, s)) > 0) return;
      const page = await this.list(demand ? "demand" : "poll", source, u.scope, cursor, this.o.pageSize, {
        timeoutMs: this.o.timeoutMs,
        signal,
        reserve: demand ? 0 : SERVING_HEADROOM,
      });
      if (u.gone) return;
      if (typeof page === "string") {
        if (page !== "limited" && page !== "busy") this.count(demand);
        // The lookup gave up (its deadline, the session ending): no evidence against the source, no back-off.
        if (signal?.aborted) return;
        this.failed(s, page);
        return;
      }
      this.count(demand);
      s.failures = 0;
      const fresh = this.store(u, s, page.items);
      changed += fresh;
      const boundary = fresh < page.items.length;
      if (boundary || page.next === null || page.items.length === 0) {
        this.polled(s, started, changed);
        return;
      }
      cursor = page.next;
    }
    // Not caught up in `maxPages`: a lookup goes on with the source stale; the rest is read in the background.
    if (demand && !u.gone) {
      void Promise.resolve().then(() => this.run(s, () => this.poll(u, s, source, MAX_POLL_PAGES, false)));
    }
  }

  /** A complete poll: the change-rate posterior learns `changed` items over the hours since the last poll. */
  private polled(s: SourceSync, startedAt: number, changed: number): void {
    const hours = Math.max(0, (startedAt - s.polledAt) / HOUR);
    if (Number.isFinite(hours)) {
      s.alpha += changed;
      s.beta += hours;
      if (s.beta > RATE_MEMORY_HOURS) {
        const k = RATE_MEMORY_HOURS / s.beta;
        s.alpha = Math.max(0.5, s.alpha * k);
        s.beta = RATE_MEMORY_HOURS;
      }
    }
    s.polledAt = startedAt;
  }

  /**
   * A sweep: the whole listing re-read (up to `maxItems`), page by page across ticks as the budget allows; when it
   * ends, every item synced from the source that it did not list is dropped (delete propagation). A sweep that fails
   * is abandoned and nothing is dropped.
   */
  private async sweep(u: UserSync, s: SourceSync, source: Source): Promise<void> {
    const started = this.deps.now();
    s.sweep ??= { cursor: undefined, seen: new Set() };
    const sw = s.sweep;
    for (let p = 0; p < MAX_POLL_PAGES; p++) {
      if (u.gone) return;
      if (this.budget.take(budgetKey(u, s)) > 0) return;
      const page = await this.list("sweep", source, u.scope, sw.cursor, this.o.pageSize, {
        timeoutMs: this.o.timeoutMs,
        reserve: SERVING_HEADROOM,
      });
      if (u.gone) return;
      if (typeof page === "string") {
        if (page !== "limited" && page !== "busy") this.stats.backgroundCalls++;
        this.failed(s, page);
        if (page !== "limited" && page !== "busy") s.sweep = null;
        return;
      }
      this.stats.backgroundCalls++;
      const first = sw.seen.size === 0;
      const fresh = this.store(u, s, page.items);
      for (const it of page.items) sw.seen.add(it.id);
      // The sweep's first page is the newest: it is also a poll.
      if (first) this.polled(s, started, fresh);
      const full = sw.seen.size >= this.o.maxItems;
      if (page.next === null || page.items.length === 0 || full) {
        // Missed by this sweep and the one before: gone. Missed by this one only: perhaps skipped (an offset listing
        // shifted, a short page ended the listing early), so kept and checked again by the next sweep.
        const missed = [...s.ids].filter((id) => !sw.seen.has(id));
        const gone = missed.filter((id) => s.missed.has(id));
        s.missed = new Set(missed.filter((id) => !s.missed.has(id)));
        for (const id of gone) s.ids.delete(id);
        this.stats.deleted += this.deps.cache.dropSynced(u.scope, gone);
        s.sweep = null;
        s.sweptAt = this.deps.now();
        return;
      }
      sw.cursor = page.next;
    }
  }

  /** Stores a page's (redacted) items as synced; returns how many were new or changed. */
  private store(u: UserSync, s: SourceSync, items: ContextItem[]): number {
    // The same user object and source state: work for a user forgotten and back since must not land.
    if (u.gone || items.length === 0 || this.users.get(u.key) !== u || u.sources.get(s.id) !== s) return 0;
    const own = items.filter((it) => it.sourceId === s.id);
    const changed = this.deps.cache.put(u.scope, own, this.deps.now(), true, true);
    for (const it of own) {
      // Listed: not missing, whatever an earlier sweep thought (an offset listing may have skipped it then).
      s.missed.delete(it.id);
      s.ids.delete(it.id); // Re-insert: the set stays oldest synced first.
      s.ids.add(it.id);
      // Listed while a sweep is under way (by the sweep, or by a poll between its pages): the source has it.
      s.sweep?.seen.add(it.id);
    }
    trimIds(s.ids, this.o.maxItems);
    this.deps.onListed?.(
      u.scope,
      own.map((it) => it.id),
    );
    if (changed.length > 0) this.deps.onStored?.(u.scope, changed);
    return changed.length;
  }

  private failed(s: SourceSync, why: string): void {
    // A source skipped as busy or limited is tried at the next tick; one that failed backs off, doubling to 30 min.
    if (why === "busy" || why === "limited") return;
    s.failures++;
    s.retryAt = this.deps.now() + Math.min(30 * 60_000, 30_000 * 2 ** (s.failures - 1));
  }

  /** One listing call through the fan-out's guards, as a `sync.list` span when tracing (content-free: D19). */
  private async list(
    phase: "backfill" | "poll" | "demand" | "sweep",
    source: Source,
    scope: Scope,
    cursor: string | undefined,
    limit: number,
    options: { timeoutMs: number; signal?: AbortSignal; reserve?: number },
  ): ReturnType<SourceFanout["list"]> {
    const tracer = this.deps.tracer;
    if (!tracer) return this.deps.fanout.list(source, scope, cursor, limit, options);
    const sp = tracer.open("sync.list", 0, { async: true, phase, source: source.id });
    try {
      const page = await this.deps.fanout.list(source, scope, cursor, limit, options);
      tracer.close(sp, typeof page === "string" ? { status: page } : { status: "ok", items: page.items.length });
      return page;
    } catch (e) {
      tracer.close(sp, { error: true });
      throw e;
    }
  }

  private count(demand: boolean): void {
    if (demand) this.stats.demandCalls++;
    else this.stats.backgroundCalls++;
  }

  /** Runs one read for a source, so a poll, a sweep and a backfill page never overlap on it. */
  private async run(s: SourceSync, work: () => Promise<void>): Promise<void> {
    while (s.busy) await s.busy;
    const p = work().catch(() => {});
    s.busy = p;
    try {
      await p;
    } finally {
      if (s.busy === p) s.busy = null;
    }
  }
}

function newSourceSync(id: string): SourceSync {
  return {
    id,
    ids: new Set(),
    phase: "backfill",
    cursor: undefined,
    exhausted: false,
    frontier: Infinity,
    polledAt: -Infinity,
    sweptAt: -Infinity,
    sweep: null,
    missed: new Set(),
    // Before anything is known: one change an hour.
    alpha: 1,
    beta: 1,
    failures: 0,
    retryAt: 0,
    busy: null,
  };
}

const budgetKey = (u: UserSync, s: SourceSync) => `${u.key}|${s.id}`;

/** Keeps a source's id set at most `max * 1.5`, dropping the longest synced first (the cache bounds the items). */
function trimIds(ids: Set<string>, max: number): void {
  const cap = Math.ceil(max * 1.5);
  if (ids.size <= cap) return;
  for (const id of ids) {
    if (ids.size <= cap) break;
    ids.delete(id);
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
