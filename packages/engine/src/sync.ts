/**
 * Background connector sync, "Eden Atlas" (D57, behind `sync`, on in the default, D112): each active user's sources
 * are read through their read-only list tools (`Source.list`) into the user's own item cache, so a lookup can be
 * answered from the local index and request-time source calls drop.
 *
 * Per user and source:
 * - a backfill of the newest `syncMaxItems` items across the user's sources (pages merged by recency, so a busy
 *   mailbox does not crowd out a quiet calendar's newest), then
 * - incremental polls: the listing read newest first until a page holds an item already synced and unchanged, on
 *   demand when a lookup finds the source stale (timed polls were deleted, D121: 2.3x the calls, no fresher answers);
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
  /**
   * An incremental poll's first page, at least (`syncPollPageSize`; 0 or absent: every page is `pageSize`). Set, a
   * poll's first page is sized to the changes the source's learned rate expects since its last poll (twice that, at
   * least this, at most `pageSize`). A page after it that is needed tops the items asked up to the next multiple of
   * `pageSize`, so a poll lists at most what `maxPages` full pages would, in at most `maxPages + 1` calls. Backfill
   * and sweeps always read `pageSize`.
   */
  pollPageSize?: number;
  /** A source's synced copy is stale once the chance that it changed since the last poll reaches this. */
  staleChance: number;
  /** ... or once its last poll is this old (ms), whatever the chance. */
  maxStaleMs: number;
  /** A user with an event this recently (ms) is active: sweeps run only for active users. */
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
  /**
   * A lookup's deadline (ms, `sourceTimeoutMs`): for this long after a lookup's on-demand poll of a source ran out of
   * time, `freshen` does not poll that source again (D140). A listing that just hung would most likely take the next
   * lookup's whole deadline too; the source is searched live instead. 0 or absent: every lookup polls.
   */
  demandTimeoutMs?: number;
  /**
   * `syncPush`: a source that says it `notifies` is current until told it changed (`Sync.changed`) or its last poll
   * is `maxStaleMs` old, instead of by its learned change rate.
   */
  push?: boolean;
  /**
   * With `push`: a notifying source's copy stands this long (ms) with no notification before it is polled anyway,
   * the bound on a lost notification (`syncPushMaxStaleMs`); 0 or absent: `maxStaleMs`.
   */
  pushMaxStaleMs?: number;
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
/** Pages a background catch-up reads at most in one go. */
const MAX_POLL_PAGES = 20;
/** Background sync calls leave this many of the serving rate limit's tokens for lookups. */
const SERVING_HEADROOM = 2;
const HOUR = 3_600_000;
/** Pushed item ids held per source between polls (`SourceSync.pushed`); past it the oldest are let go. */
const MAX_PUSHED = 1_000;
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
  /** When a lookup's on-demand poll of this source last gave up before it answered (`demandTimeoutMs`). */
  demandGaveUpAt: number;
  /**
   * The poll, sweep or page read in flight, so two never overlap. It resolves to how many items that read stored new
   * or changed (`reading`), so a lookup that waited on it instead of polling knows whether the index moved.
   */
  busy: Promise<number> | null;
  /** The read `busy` holds: what it has stored so far (`store` adds to it). */
  reading: { stored: number } | null;
  /** `push`: the source notifies, so its copy is current until `notices` moves past what the last poll began with. */
  notifies: boolean;
  /** Change notifications received (`Sync.changed`). */
  notices: number;
  /**
   * The sync's read mark (`SyncManager.mark`) the latest notification set (0 before any). A signal does not say which
   * item changed, and the poll it causes reads only the newest page: a copy whose read began before it is in doubt
   * until read again (`signalledSince`).
   */
  noticedMark: number;
  /** `notices` when the last complete poll began: the copy is behind while they differ. */
  noticesPolled: number;
  /** `notices` when the backfill's latest page began: what the backfill has read when it ends (`warmUp`). */
  noticesBackfill: number;
  /**
   * Items stored from notifications (`ingest`) since the last complete poll, with the order they came in. They are the
   * newest the source has but were never listed, so a poll must not take one of them for the point where its listing
   * reaches what was synced before (`boundary`): items between them and that point would be skipped.
   */
  pushed: Map<string, number>;
  pushSeq: number;
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
  /** Listing calls made in the background (backfill, sweeps, catch-ups). */
  backgroundCalls: number;
  /** Listing calls made inside lookups (on-demand polls). */
  demandCalls: number;
  /** Items the background calls and the on-demand polls' calls listed (what came back, changed or not). */
  backgroundItems: number;
  demandItems: number;
  /** Items dropped because their source no longer lists them. */
  deleted: number;
}

export class SyncManager {
  private readonly users = new Map<string, UserSync>();
  private readonly budget: Gcra<string>;
  private ticking = false;
  /**
   * Change notifications taken, across every user and source (`mark`): it orders reads against signals. Global, so a
   * user's state dropped and made again (eviction, `untrack`) starts past every mark a stored copy holds.
   */
  private marks = 0;
  readonly stats: SyncStats = {
    backgroundCalls: 0,
    demandCalls: 0,
    backgroundItems: 0,
    demandItems: 0,
    deleted: 0,
  };

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

  /**
   * A change notification for a user's source (`syncPush`): its synced copy is behind until a poll that begins after
   * now completes, which the next lookup that reads it makes (behind it with `syncPollBehind`). A burst of
   * notifications before that poll costs one poll. Returns whether the notification acts: the source is synced for the
   * user and says it notifies (with `push`); for any other source it is ignored and false, so an integrator that
   * forgot to declare `notifies` is told so. O(1), no I/O.
   */
  changed(scope: Scope, sourceId: string): boolean {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    if (!s || !s.notifies) return false;
    s.notices++;
    s.noticedMark = ++this.marks;
    return true;
  }

  /**
   * Items a notification carried (`syncPush`, `ContextPartner.sourceItems`), already redacted: stored as synced, as a
   * poll would, with no call. The source's copy is not marked current by them (other changes may have come
   * unannounced): only a poll does that. Returns how many were new or changed; 0 for a source not synced yet.
   */
  ingest(scope: Scope, sourceId: string, items: ContextItem[]): number {
    const u = this.users.get(scopeKey(scope));
    const s = u?.sources.get(sourceId);
    if (!u || !s || s.phase !== "warm") return 0;
    // Only what the push changed is marked: a replayed, unchanged item was synced before and is a true boundary.
    const changed = new Set<string>();
    // Read under the mark its signal set (`sourceChanged` comes first): no doubt of what it brought.
    const n = this.store(u, s, items, this.marks, changed);
    for (const id of changed) {
      s.pushed.delete(id); // Re-insert: the map stays in arrival order.
      s.pushed.set(id, ++s.pushSeq);
    }
    while (s.pushed.size > MAX_PUSHED) s.pushed.delete(s.pushed.keys().next().value as string);
    return n;
  }

  /**
   * Items the source deleted (a deletion notification, or a fetch that found them gone): no longer counted as synced
   * from it, nor as pushed. The caller drops them from the cache. O(ids).
   */
  removed(scope: Scope, sourceId: string, ids: Iterable<string>): void {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    if (!s) return;
    for (const id of ids) {
      s.ids.delete(id);
      s.pushed.delete(id);
      s.missed.delete(id);
    }
  }

  /**
   * The read mark now: taken when a read of a source begins and stored with the copies it brings (`ItemCache.put`'s
   * `readMark`), so `signalledSince` can tell a signal that came after the read began from one before it. A read's
   * end, or its copy's store time, cannot: a signal that lands while the call is on the wire (or in the same
   * millisecond) comes before the store yet may follow what the source answered (D133, amends D126). O(1).
   */
  mark(): number {
    return this.marks;
  }

  /**
   * Whether a notifying source has signalled a change since `readMark` (`mark` when the copy's read began): a signal
   * does not say which item changed, and the poll it causes reads only the newest page, so a copy read before it (or
   * one the source has since deleted) is in doubt until it is read again (`verifyDelivery`). Items a notification
   * carried (`ingest`) are read under the mark its signal set; the sync's polls under the mark when each page's call
   * began, so a poll a signal starts does not doubt what it brings.
   */
  signalledSince(scope: Scope, sourceId: string, readMark: number): boolean {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    return s !== undefined && s.notifies && s.noticedMark > readMark;
  }

  /** Whether the user's copy of a source has finished its backfill, current or not (`syncPollBehind`). */
  isWarm(scope: Scope, sourceId: string): boolean {
    return this.users.get(scopeKey(scope))?.sources.get(sourceId)?.phase === "warm";
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
   * user backfill and sweeps, as each source's budget allows. Never runs twice at once, never throws.
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
   * lookup's deadline. Returns the listing calls this freshen made (not another lookup's, made meanwhile); the
   * sources it brought current answer the lookup locally. `tally.fresh` counts the items stored new or changed by its
   * polls, and by any read it waited on instead (a sweep, a catch-up, another lookup's poll: `SourceSync.busy`
   * resolves to what that read stored), or none for one it stopped waiting on (`signal`).
   */
  async freshen(scope: Scope, sources: Source[], signal: AbortSignal, tally?: { fresh: number }): Promise<number> {
    const u = this.users.get(scopeKey(scope));
    if (!u) return 0;
    const now = this.deps.now();
    const own = { fresh: 0, calls: 0 };
    await Promise.all(
      sources.map(async (source) => {
        const s = u.sources.get(source.id);
        if (s) this.notes(s, source);
        if (!s || s.phase !== "warm" || this.isCurrent(s, now) || !source.list) return;
        // Its last on-demand poll just ran out of time (D140): not current, so the lookup searches it live.
        if (now - s.demandGaveUpAt < (this.o.demandTimeoutMs ?? 0)) return;
        if (s.busy) {
          // A read already running (a sweep, a catch-up, or another lookup's poll): its answer, not a second call.
          own.fresh += await Promise.race([s.busy, aborted(signal).then(() => 0)]);
          return;
        }
        await this.run(s, () => this.poll(u, s, source, this.o.catchupPages, true, signal, own));
      }),
    );
    if (tally) tally.fresh += own.fresh;
    return own.calls;
  }

  // ── internals ──

  private isCurrent(s: SourceSync, now: number): boolean {
    if (s.phase !== "warm") return false;
    const age = now - s.polledAt;
    // A source that notifies changed only when it said so, or (a lost notification) after `pushMaxStaleMs`.
    if (s.notifies) return age <= (this.o.pushMaxStaleMs || this.o.maxStaleMs) && s.notices === s.noticesPolled;
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
      this.notes(u.sources.get(x.id)!, x);
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
        if (s.sweep !== null || now - s.sweptAt >= this.o.sweepMs) await this.run(s, () => this.sweep(u, s, source));
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
      next.noticesBackfill = next.notices;
      await this.run(next, async () => {
        const readMark = this.marks;
        page = await this.list("backfill", source, u.scope, next.cursor, this.o.pageSize, {
          timeoutMs: this.o.timeoutMs,
          reserve: SERVING_HEADROOM,
        });
        // Stored within the read, so what it stored is the read's (`SourceSync.reading`).
        if (typeof page !== "string" && !u.gone) this.store(u, next, page.items, readMark);
      });
      if (page === undefined || u.gone) return;
      if (typeof page === "string") {
        if (page !== "limited" && page !== "busy") this.stats.backgroundCalls++;
        this.failed(next, page);
        return;
      }
      this.stats.backgroundCalls++;
      this.stats.backgroundItems += page.items.length;
      next.failures = 0;
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
    // Notifications that came before the backfill's last page began are read by it; later ones are not.
    s.noticesPolled = s.noticesBackfill;
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
    tally?: { fresh: number; calls: number },
  ): Promise<void> {
    const started = this.deps.now();
    const notices = s.notices;
    const pushSeq = s.pushSeq;
    let cursor: string | undefined;
    let changed = 0;
    // `pollPageSize`: the first page is sized to what changed, not to the backfill's page; each page after it tops the
    // items asked up to the next multiple of `pageSize` (5, then 95, then 100). So a poll lists no more items than
    // `maxPages` full pages would, catches up as far before the lookup goes on, and makes at most one more call.
    const adaptive = (this.o.pollPageSize ?? 0) > 0;
    const itemCap = maxPages * this.o.pageSize;
    const first = adaptive ? Math.min(this.firstPage(s, started), itemCap) : this.o.pageSize;
    let asked = 0;
    // A lookup's poll that stops because the lookup ran out of time (or ended): no evidence against the source, but
    // the next lookup within `demandTimeoutMs` searches it live rather than wait on its listing again (D140).
    const gaveUp = () => {
      if (demand) s.demandGaveUpAt = this.deps.now();
    };
    for (let p = 0; adaptive ? asked < itemCap && p <= maxPages : p < maxPages; p++) {
      if (u.gone) return;
      if (signal?.aborted) return gaveUp();
      if (this.budget.take(budgetKey(u, s)) > 0) return;
      const topUp = this.o.pageSize - (asked % this.o.pageSize);
      const limit = !adaptive ? this.o.pageSize : p === 0 ? first : Math.min(topUp, itemCap - asked);
      asked += limit;
      const readMark = this.marks;
      const page = await this.list(demand ? "demand" : "poll", source, u.scope, cursor, limit, {
        timeoutMs: this.o.timeoutMs,
        signal,
        reserve: demand ? 0 : SERVING_HEADROOM,
      });
      if (u.gone) return;
      if (typeof page === "string") {
        if (page !== "limited" && page !== "busy") this.count(demand, tally);
        // The lookup gave up (its deadline, the session ending): no evidence against the source, no back-off.
        if (signal?.aborted) return gaveUp();
        this.failed(s, page);
        return;
      }
      this.count(demand, tally);
      if (demand) this.stats.demandItems += page.items.length;
      else this.stats.backgroundItems += page.items.length;
      s.failures = 0;
      const stored = new Set<string>();
      const fresh = this.store(u, s, page.items, readMark, stored);
      changed += fresh;
      if (tally) tally.fresh += fresh;
      // The listing has reached what was synced before: an item held unchanged that a notification did not bring.
      const boundary = page.items.some((it) => !stored.has(it.id) && !s.pushed.has(it.id));
      if (boundary || page.next === null || page.items.length === 0) {
        this.polled(s, started, changed, notices, pushSeq);
        return;
      }
      cursor = page.next;
    }
    // Not caught up in `maxPages`: a lookup goes on with the source stale; the rest is read in the background.
    if (demand && !u.gone) {
      void Promise.resolve().then(() => this.run(s, () => this.poll(u, s, source, MAX_POLL_PAGES, false)));
    }
  }

  /**
   * A poll's first page under `pollPageSize`: twice the changes the source's rate posterior expects since its last
   * poll (room for a rate that has risen), at least `pollPageSize`, at most `pageSize`.
   */
  private firstPage(s: SourceSync, startedAt: number): number {
    const hours = Math.max(0, (startedAt - s.polledAt) / HOUR);
    const expected = Math.ceil((2 * s.alpha * hours) / s.beta);
    const floor = Math.min(this.o.pollPageSize ?? 0, this.o.pageSize);
    return Number.isFinite(expected) ? Math.min(this.o.pageSize, Math.max(floor, expected)) : this.o.pageSize;
  }

  /**
   * A complete poll: the change-rate posterior learns `changed` items over the hours since the last poll, and the
   * notifications received before it began (`notices`) are read.
   */
  private polled(s: SourceSync, startedAt: number, changed: number, notices: number, pushSeq: number): void {
    s.noticesPolled = notices;
    // Items pushed before the poll began are listed now, or lie past where it stopped: no longer a false boundary.
    for (const [id, seq] of s.pushed) if (seq <= pushSeq) s.pushed.delete(id);
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
    const notices = s.notices;
    const pushSeq = s.pushSeq;
    s.sweep ??= { cursor: undefined, seen: new Set() };
    const sw = s.sweep;
    for (let p = 0; p < MAX_POLL_PAGES; p++) {
      if (u.gone) return;
      if (this.budget.take(budgetKey(u, s)) > 0) return;
      const readMark = this.marks;
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
      this.stats.backgroundItems += page.items.length;
      const first = sw.seen.size === 0;
      const fresh = this.store(u, s, page.items, readMark);
      for (const it of page.items) sw.seen.add(it.id);
      // The sweep's first page is the newest: it is also a poll.
      if (first) this.polled(s, started, fresh, notices, pushSeq);
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

  /**
   * Stores a page's (redacted) items as synced, read under `readMark` (`mark` when its call began); returns how many
   * were new or changed (their ids into `changedIds`).
   */
  private store(u: UserSync, s: SourceSync, items: ContextItem[], readMark: number, changedIds?: Set<string>): number {
    // The same user object and source state: work for a user forgotten and back since must not land.
    if (u.gone || items.length === 0 || this.users.get(u.key) !== u || u.sources.get(s.id) !== s) return 0;
    const now = this.deps.now();
    // An item its source said is gone (`ItemCache.isHeldGone`) was listed before the deletion: neither stored nor
    // counted as synced, or the listing would undo `removed`.
    const own = items.filter((it) => it.sourceId === s.id && !this.deps.cache.isHeldGone(u.scope, it.id, now));
    const changed = this.deps.cache.put(u.scope, own, now, true, true, readMark);
    if (changedIds) for (const it of changed) changedIds.add(it.id);
    if (s.reading) s.reading.stored += changed.length;
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

  /** Whether a source's copy goes by its notifications (`push` and the source `notifies`). */
  private notes(s: SourceSync, source: Source): void {
    s.notifies = this.o.push === true && source.notifies === true;
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
    given: { timeoutMs: number; signal?: AbortSignal; reserve?: number },
  ): ReturnType<SourceFanout["list"]> {
    // Items the cache holds unchanged are not redacted again (most of a poll or a sweep re-lists what is held).
    const options = { ...given, reuse: this.deps.cache.reuseFor(scope) };
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

  /** One listing call, a lookup's (`demand`, also counted in its freshen's `tally`) or the background's. */
  private count(demand: boolean, tally?: { calls: number }): void {
    if (demand) {
      this.stats.demandCalls++;
      if (tally) tally.calls++;
    } else this.stats.backgroundCalls++;
  }

  /**
   * Runs one read for a source, so a poll, a sweep and a backfill page never overlap on it. Resolves to what the read
   * stored new or changed (`SourceSync.reading`), as its `busy` does for a lookup waiting on it.
   */
  private async run(s: SourceSync, work: () => Promise<void>): Promise<number> {
    while (s.busy) await s.busy;
    const reading = { stored: 0 };
    s.reading = reading;
    const p = work()
      .catch(() => {})
      .then(() => reading.stored);
    s.busy = p;
    try {
      return await p;
    } finally {
      if (s.busy === p) s.busy = null;
      if (s.reading === reading) s.reading = null;
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
    demandGaveUpAt: -Infinity,
    busy: null,
    reading: null,
    notifies: false,
    notices: 0,
    noticedMark: 0,
    noticesPolled: 0,
    noticesBackfill: 0,
    pushed: new Map(),
    pushSeq: 0,
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
