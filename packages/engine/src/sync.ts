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
import { Gcra, IdSet } from "@eden/primitives";
import { scopeKey, type ContextItem, type Scope } from "@eden/protocol";
import type { Source, SourceFanout, SourceResolver } from "@eden/sources";
import type { ItemCache } from "./cache";
import { sketchTerms, termHashes, TermSketch } from "./sketch";
import type { Tracer } from "./spans";

export interface SyncOptions {
  /** Items synced per user at most, across sources: the newest. */
  maxItems: number;
  /** Items asked per listing page. */
  pageSize: number;
  /**
   * `syncBackfillLanes` (D262, 8 in the default): the backfill reads this many sources' next pages at once (the
   * newest unread first, as one lane does), so a user's cold start is not one listing call after another. 1 or unset:
   * one at a time.
   */
  backfillLanes?: number;
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
   * `syncKeepCut` (D321, a trial): the user's sync keeps to its `maxItems` after the backfill too. A poll or a sweep
   * stores no dated item older than the user's cut (the oldest item kept when the user is at the cap; the source's
   * copy is then cut, D264), the user's synced items are trimmed back to the cap once they pass it by a page, and a
   * sweep stops once it has listed every id it holds for the source.
   */
  keepCut?: boolean;
  /**
   * `syncEngagedDeep` (D323, a trial): a source a lookup of the user's searched (`engage`) whose copy the cap cut is
   * read again from the top, a page or two a tick, up to half the user's `maxItems`; the user's trim keeps the items
   * of such sources before any other's, so the copy of a source the user uses is whole and answers from the index.
   */
  engagedDeep?: boolean;
  /**
   * `routeSketch` (D322, a trial): each source keeps a vocabulary sketch of what the sync listed from it (`sketch.ts`),
   * which `sketchScores` reads for routing.
   */
  sketch?: boolean;
  /**
   * `syncUnusedSweepMs` (D356, on in the default at a week; 0 or absent: off): a source the user does not use
   * (`engage`) whose connector can fetch by ref is swept this often (ms) instead of every `sweepMs`. The engine
   * re-reads its copies a skipped sweep left unvouched for (`sweepLapsed`) or the last sweep missed (`sweepMissed`)
   * before delivering them, since a deletion may be behind them.
   */
  unusedSweepMs?: number;
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
  /**
   * `syncIngestTurns` (D328, on in the default since D370): a background read's page (backfill, sweep, a poll's
   * background pages) waits its `turn` before it is redacted and stored.
   */
  ingestTurns?: boolean;
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

/** Where a lookup's poll stopped at its page cap, for the background read that finishes it as one poll. */
interface PollResume {
  cursor: string | undefined;
  changed: number;
  started: number;
  notices: number;
  pushSeq: number;
}

/** Background sync calls leave this many of the serving rate limit's tokens for lookups. */
const SERVING_HEADROOM = 2;
const HOUR = 3_600_000;
/** Pushed item ids held per source between polls (`SourceSync.pushed`); past it the oldest are let go. */
const MAX_PUSHED = 1_000;
/** Users a tick works on at once. */
const USERS_AT_ONCE = 16;
/** Names held per user for `cardsSourceAware` (`notePeople`). */
const MAX_PEOPLE = 256;
/** Sources a user's lookups use at once (`engage`): past it, the least recently used is no longer counted. */
const MAX_USED = 64;

interface SourceSync {
  id: string;
  /**
   * Ids of the items synced from this source, oldest synced first (bounded: `trimIds`). An `IdSet` (D371): the ids'
   * characters in typed arrays, since a frozen user (D325) keeps them when nothing else of theirs is live.
   */
  ids: IdSet;
  phase: "backfill" | "warm";
  /** The backfill's next page, and whether the listing has no more. */
  cursor: string | undefined;
  exhausted: boolean;
  /**
   * Whether the user's copy of this source lacks items the source has (D264): its backfill stopped at the user's
   * `maxItems` cut before the listing ended, or a trim dropped some of its items. Such a copy holds only the source's
   * newest, so a lookup that answers the source from it can miss an older item the source would find.
   */
  cut: boolean;
  /** The cache revision at which every synced id was last found held (`complete`), or -1. */
  wholeAt: number;
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
  /** `cardsSourceAware`: a lookup of the user's has searched this source (`engage`). */
  engaged: boolean;
  /**
   * `engagedDeep`: the read from the top of an engaged source's listing under way (its next page), or null. `undefined`
   * cursor with `deep` set: the first page.
   */
  deep: { cursor: string | undefined; lost: boolean } | null;
  /** `routeSketch`: the terms of what the sync listed from the source (made at its first store). */
  sketch: TermSketch | null;
  /** The source's connector can fetch an item by ref (`unusedSweepMs`: only such a source may be swept less often). */
  fetches: boolean;
  /**
   * `unusedSweepMs`: a sweep the daily rule (`sweepMs`) would have run for an active user was not run since the last
   * complete sweep, because the source was on the longer one. Its copies older than `sweepMs` are then in doubt.
   */
  skipped: boolean;
}

interface UserSync {
  key: string;
  scope: Scope;
  sources: Map<string, SourceSync>;
  activeAt: number;
  /** Set when the user is dropped or forgotten: work still in flight for them stores nothing. */
  gone: boolean;
  /**
   * The oldest `updatedAt` the user's synced items keep once they reached `maxItems` (`trim`); -Infinity while under
   * it. With `keepCut`, polls and sweeps store nothing dated before it.
   */
  cutAt: number;
  /**
   * `cardsSourceAware`: names the user's own requests named (folded), most recently named last, at most `MAX_PEOPLE`.
   * Kept here because they live and go with the user's sync (eviction, `forget`).
   */
  people: Set<string>;
  /** Sources marked used (`engage`), least recently used first, at most `MAX_USED`. */
  used: Set<string>;
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
      cutAt: -Infinity,
      people: new Set(),
      used: new Set(),
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
   * Whether a notification for this source acts (`changed` would take it) and items it names can be stored as synced
   * (`ingest`): synced for the user, warm, and notifying. O(1), no I/O.
   */
  notifying(scope: Scope, sourceId: string): boolean {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    return s !== undefined && s.notifies && s.phase === "warm";
  }

  /**
   * Why `changed` ignored a notification for this source: no sync state for it (an unknown user or source, a typo'd
   * id, a search-only source, or one no lookup has synced yet; telling these apart would need the user's sources,
   * which is I/O), or synced but not declared `notifies`. O(1), no I/O.
   */
  ignoredBecause(scope: Scope, sourceId: string): "not-synced" | "not-notifying" {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    return s ? "not-notifying" : "not-synced";
  }

  /**
   * Items a notification carried (`syncPush`, `ContextPartner.sourceItems`), already redacted: stored as synced, as a
   * poll would, with no call. The source's copy is not marked current by them (other changes may have come
   * unannounced): only a poll does that. Returns how many were new or changed; 0 for a source not synced yet.
   */
  ingest(scope: Scope, sourceId: string, items: ContextItem[], readMark?: number): number {
    const u = this.users.get(scopeKey(scope));
    const s = u?.sources.get(sourceId);
    if (!u || !s || s.phase !== "warm") return 0;
    // Only what the push changed is marked: a replayed, unchanged item was synced before and is a true boundary.
    const changed = new Set<string>();
    // Read under the mark its signal set (`sourceChanged` comes first): no doubt of what it brought. Items a ref notice
    // fetched (`sourceRefs`, D347) are read under the mark their call began with (D133).
    const n = this.store(u, s, items, readMark ?? this.marks, changed);
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

  /**
   * Whether the user's copy of a source holds everything the source listed (D264): warm, and neither its backfill
   * nor a trim cut it at the user's `maxItems`. False for an unknown source.
   */
  complete(scope: Scope, sourceId: string, now = this.deps.now()): boolean {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    if (s === undefined || s.phase !== "warm" || s.cut) return false;
    // The cache can let synced items go on its own (its `maxSyncedPerUser` cap, `syncTtlMs`): a copy is whole only
    // while it still holds every item synced from the source. Checked again only after the user's cache changed.
    const revision = this.deps.cache.revision(scope);
    if (s.wholeAt === revision) return true;
    const held = this.deps.cache.syncedReader(scope, now);
    for (const id of s.ids) {
      if (held(id)) continue;
      s.cut = true;
      return false;
    }
    s.wholeAt = revision;
    return true;
  }

  /** Whether the user's copy of a source has finished its backfill, current or not (`syncPollBehind`). */
  isWarm(scope: Scope, sourceId: string): boolean {
    return this.users.get(scopeKey(scope))?.sources.get(sourceId)?.phase === "warm";
  }

  /** How many sources the user's sync holds (listable sources the resolver gave at the last tick). */
  sourceCount(scope: Scope): number {
    return this.users.get(scopeKey(scope))?.sources.size ?? 0;
  }

  /**
   * `cardsSourceAware`: marks sources a lookup of the user's searched (or answered from the index). Returns those
   * marked for the first time, whose held items the caller may now read. O(ids), no I/O.
   */
  engage(scope: Scope, sourceIds: Iterable<string>): string[] {
    const u = this.users.get(scopeKey(scope));
    if (!u) return [];
    const fresh: string[] = [];
    for (const id of sourceIds) {
      const s = u.sources.get(id);
      if (!s) continue;
      // Most recently used last: past `MAX_USED`, the least recently used is used no longer (the review: a set that
      // only grew gave back the card savings over weeks).
      u.used.delete(id);
      u.used.add(id);
      if (s.engaged) continue;
      s.engaged = true;
      fresh.push(id);
      // `engagedDeep`: a cut copy of a source the user uses is read again, whole, from the top (`deepen`).
      if (this.o.engagedDeep && s.phase === "warm" && s.cut) s.deep = { cursor: undefined, lost: false };
    }
    while (u.used.size > MAX_USED) {
      const old = u.used.values().next().value as string;
      u.used.delete(old);
      const s = u.sources.get(old);
      if (s) {
        s.engaged = false;
        s.deep = null;
      }
    }
    return fresh;
  }

  /**
   * `unusedSweepMs` (D356): whether the source skipped a daily sweep for the longer one since its last complete sweep,
   * which is older than `sweepMs`, so a copy of its items older than that may hide a deletion the daily sweep would
   * have seen.
   * False for a source the sync does not hold or with the trial off. O(1), no I/O.
   */
  sweepLapsed(scope: Scope, sourceId: string, now = this.deps.now()): boolean {
    if (!((this.o.unusedSweepMs ?? 0) > 0)) return false;
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    // Whether it is used now or not: a lookup that cites an item engages its source first, and the sweep that makes
    // due runs at a tick, after the delivery. Only a sweep the trial skipped counts: an idle user's daily sweep waits
    // for them as before (the 5-source days: counting those re-read 27 copies for nothing).
    return s !== undefined && s.phase === "warm" && s.skipped && now - s.sweptAt > this.o.sweepMs;
  }

  /**
   * `unusedSweepMs` (D356): whether the source's last complete sweep did not list this item (one miss; two drop it).
   * On the daily sweep the second miss comes a day later; on the longer one a week, so until a re-read or a listing
   * vouches for it the copy is in doubt. False with the trial off. O(1), no I/O.
   */
  sweepMissed(scope: Scope, sourceId: string, itemId: string): boolean {
    if (!((this.o.unusedSweepMs ?? 0) > 0)) return false;
    // Only a source whose re-read can confirm the item: for another, it would only be withheld (the review, D356).
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    return s !== undefined && s.fetches && s.missed.has(itemId);
  }

  /** A re-read found the item at its source (`verifyDelivery`): no longer counted as missed by a sweep. O(1). */
  vouched(scope: Scope, sourceId: string, itemId: string): void {
    this.users.get(scopeKey(scope))?.sources.get(sourceId)?.missed.delete(itemId);
  }

  /**
   * `unusedSweepMs` (D356): a re-read of one of the source's unswept copies could not confirm it, so its sweep is due
   * at the next tick of an active user, whatever its interval. O(1), no I/O.
   */
  sweepSoon(scope: Scope, sourceId: string): void {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    if (s && s.phase === "warm") s.sweptAt = -Infinity;
  }

  /** Whether a lookup of the user's has searched the source (`engage`). False for one the sync does not hold. */
  engaged(scope: Scope, sourceId: string): boolean {
    return this.users.get(scopeKey(scope))?.sources.get(sourceId)?.engaged === true;
  }

  /** Ids of the items synced from a source for the user, oldest synced first (a copy). */
  syncedIds(scope: Scope, sourceId: string): string[] {
    const s = this.users.get(scopeKey(scope))?.sources.get(sourceId);
    return s ? [...s.ids] : [];
  }

  /** `cardsSourceAware`: names the user's own requests named (folded by the caller). Bounded: the oldest named go. */
  notePeople(scope: Scope, names: Iterable<string>): void {
    const u = this.users.get(scopeKey(scope));
    if (!u) return;
    for (const n of names) {
      u.people.delete(n);
      u.people.add(n);
    }
    while (u.people.size > MAX_PEOPLE) u.people.delete(u.people.values().next().value as string);
  }

  /** The names `notePeople` holds for the user (live: read, do not keep). */
  peopleOf(scope: Scope): ReadonlySet<string> {
    return this.users.get(scopeKey(scope))?.people ?? EMPTY;
  }

  /**
   * `routeSketch` (D322): per source, log2(1 + the request's terms its sketch holds, each weighted by how few of the
   * user's sketched sources hold it: log(N / df) / log(N), so a term every source has counts nothing). Sources
   * matching no term are absent; undefined when fewer than two sources are sketched. No I/O; O(sources × terms).
   */
  sketchScores(scope: Scope, terms: readonly (readonly [number, number])[]): Map<string, number> | undefined {
    const u = this.users.get(scopeKey(scope));
    if (!u || terms.length === 0) return undefined;
    const sketched: SourceSync[] = [];
    for (const s of u.sources.values()) if (s.sketch) sketched.push(s);
    if (sketched.length < 2) return undefined;
    const hits = terms.map((t) => sketched.filter((s) => s.sketch!.has(t[0], t[1])));
    const logN = Math.log(sketched.length);
    const score = new Map<string, number>();
    for (const holders of hits) {
      if (holders.length === 0) continue;
      const w = Math.log(sketched.length / holders.length) / logN;
      if (w <= 0) continue;
      for (const s of holders) score.set(s.id, (score.get(s.id) ?? 0) + w);
    }
    if (score.size === 0) return undefined;
    for (const [id, x] of score) score.set(id, Math.log2(1 + x));
    return score;
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

  /** Users of the tenant this sync keeps current (D326). */
  tenantUsers(tenantId: string): number {
    let n = 0;
    for (const u of this.users.values()) if (u.scope.tenantId === tenantId) n++;
    return n;
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
   * lookup's deadline (`signal`: the poll itself goes on past it, unless `stop` aborts). Returns the listing calls
   * this freshen made (not another lookup's, made meanwhile); the sources it brought current answer the lookup
   * locally. `tally.fresh` counts the items stored new or changed by its polls, and by any read it waited on
   * instead (a sweep, a catch-up, another lookup's poll: `SourceSync.busy` resolves to what that read stored), or
   * none for one it stopped waiting on (`signal`).
   */
  async freshen(
    scope: Scope,
    sources: Source[],
    signal: AbortSignal,
    tally?: { fresh: number },
    stop?: AbortSignal,
  ): Promise<number> {
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
        // Its listing failed twice running and is backing off (`failed`): every lookup listed it again regardless, a
        // billed call on top of the live search it makes anyway (audit A5). Not current, so searched live, as D127 has
        // it. After one failure it is polled as before: a listing that failed once is usually back, and one listing
        // costs less than the live search and probes it replaces (the funnel: 2.69 request calls a task either way,
        // 2.83 when one failure was enough to skip).
        if (s.failures >= 2 && now < s.retryAt) return;
        if (s.busy) {
          // A read already running (a sweep, a catch-up, or another lookup's poll): its answer, not a second call.
          own.fresh += await Promise.race([s.busy, aborted(signal).then(() => 0)]);
          return;
        }
        // The lookup stops waiting at its deadline; the listing does not stop with it (audit A5). Cut at the lookup's
        // deadline, a listing slower than it was billed by every lookup and never stored anything, so the source never
        // became current; it now finishes under the sync's own timeout, and the next lookup finds it current.
        // `stop` (the session ending) still cuts it: then nothing waits for it, and its calls are traced as made.
        const polling = this.run(s, () => this.poll(u, s, source, this.o.catchupPages, true, stop, own));
        const done = await Promise.race([polling.then(() => true), aborted(signal).then(() => false)]);
        // Ended with its session: the cut listing settles at once (as before), and its call is counted as made.
        if (!done && stop?.aborted) await polling;
        else if (!done) s.demandGaveUpAt = this.deps.now();
      }),
    );
    if (tally) tally.fresh += own.fresh;
    return own.calls;
  }

  // ── internals ──

  /**
   * `unusedSweepMs` (D356): a source the user does not use whose connector can fetch by ref is swept that often. One
   * without a fetch keeps the daily sweep: its copies could not be re-read before delivery.
   */
  private onLongSweep(s: SourceSync): boolean {
    return (this.o.unusedSweepMs ?? 0) > 0 && !s.engaged && s.fetches;
  }

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
    const listed = new Set(listable.map((x) => x.id));
    const unlisted: SourceSync[] = [];
    for (const [id, s] of [...u.sources]) {
      if (listed.has(id)) continue;
      u.sources.delete(id);
      unlisted.push(s);
    }
    const byId = new Map(listable.map((x) => [x.id, x]));
    // D325: a frozen user is thawed in slices before a read that touches their items (the unlisted sources' drop, the
    // backfill), not all at once inside it. Only when a thaw is pending: one more await on every step would move when
    // pages land (the funnel's cards).
    const reads = unlisted.some((s) => s.ids.size > 0) || [...u.sources.values()].some((s) => s.phase === "backfill");
    let thawing = reads ? this.deps.cache.ready(u.scope) : null;
    if (thawing) await thawing;
    // Dropped even when the user went meanwhile: their sources' drop (`drop`) no longer holds these.
    for (const s of unlisted) this.stats.deleted += this.deps.cache.dropSynced(u.scope, s.ids);
    if (u.gone) return;
    await this.backfill(u, byId);
    if (this.o.engagedDeep) {
      await Promise.all(
        [...u.sources.values()].map(async (s) => {
          const source = byId.get(s.id);
          if (!source || !s.deep || s.busy || this.deps.now() < s.retryAt) return;
          await this.run(s, () => this.deepen(u, s, source));
        }),
      );
      if (!u.gone && this.total(u) > this.o.maxItems + this.o.pageSize && (await this.thawed(u))) {
        this.trim(u, this.deps.now());
      }
    }
    // `keepCut`: polls and sweeps add the sources' new items; half the cap past it, the oldest go, back to the cap,
    // before the cache's own synced cap would evict by sync order instead. Not sooner: trimming the backfill's last
    // pages back to the cap took evidence routing reads (`routeLocalHits`) and lost 2 of 96 hidden facts at 1,000
    // sources (a13-scale.md).
    if (this.o.keepCut && !u.gone && this.total(u) > this.o.maxItems * 1.5 && (await this.thawed(u))) {
      this.trim(u, this.deps.now());
    }
    const now = this.deps.now();
    const active = now - u.activeAt <= this.o.activeMs;
    if (!active) return;
    const due = (s: SourceSync) => s.phase === "warm" && (s.sweep !== null || now - s.sweptAt >= this.o.sweepMs);
    thawing = [...u.sources.values()].some(due) ? this.deps.cache.ready(u.scope) : null;
    if (thawing) await thawing;
    if (u.gone) return;
    await Promise.all(
      [...u.sources.values()].map(async (s) => {
        const source = byId.get(s.id);
        if (!source || s.phase !== "warm" || s.busy || now < s.retryAt) return;
        const every = this.onLongSweep(s) ? Math.max(this.o.unusedSweepMs!, this.o.sweepMs) : this.o.sweepMs;
        if (s.sweep !== null || now - s.sweptAt >= every) await this.run(s, () => this.sweep(u, s, source));
        else if (now - s.sweptAt >= this.o.sweepMs) s.skipped = true;
      }),
    );
  }

  /**
   * The backfill: pages read newest first, always from the source whose next page holds the newest items not yet
   * read (the smallest `frontier` gap), until the user's `maxItems` or every listing is read. A source whose budget
   * or guards say wait is left for the next tick, as is the rest once any call fails.
   */
  private async backfill(u: UserSync, byId: Map<string, Source>): Promise<void> {
    const lanes = Math.max(1, Math.floor(this.o.backfillLanes ?? 1));
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
      // The newest unread page first: the source whose read items reach least far back. With lanes, the next
      // `lanes` such sources at once; the first that has no source or must wait for its budget ends the batch, as it
      // ends the one-lane backfill.
      ready.sort((a, b) => b.frontier - a.frontier);
      const batch: { next: SourceSync; source: Source }[] = [];
      for (const next of ready) {
        if (batch.length >= lanes) break;
        const source = byId.get(next.id);
        if (!source || this.budget.take(budgetKey(u, next)) > 0) break;
        batch.push({ next, source });
      }
      if (batch.length === 0) return;
      const pages = await Promise.all(
        batch.map(async ({ next, source }) => {
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
          return page;
        }),
      );
      let stop = false;
      for (let k = 0; k < batch.length; k++) {
        const next = batch[k]!.next;
        const page = pages[k];
        if (u.gone) return;
        // The lane's read did not run or threw: nothing to record; the others' pages were stored and are recorded.
        if (page === undefined) {
          stop = true;
          continue;
        }
        if (typeof page === "string") {
          if (page !== "limited" && page !== "busy") this.stats.backgroundCalls++;
          this.failed(next, page);
          stop = true;
          continue;
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
      if (stop) return;
    }
  }

  /**
   * The oldest `updatedAt` among the items synced from `s`; -Infinity (read as before, to the user's cap) when one has
   * none (it cannot be placed in the listing) or when none is synced: an empty or trimmed source's new items reach
   * the background only through this sweep (the review: Infinity there stored nothing and marked the source current).
   */
  private oldestSynced(u: UserSync, s: SourceSync): number {
    if (s.ids.size === 0) return -Infinity;
    const now = this.deps.now();
    let oldest = Infinity;
    for (const id of s.ids) {
      const at = this.deps.cache.get(u.scope, id, now)?.updatedAt;
      if (at === undefined) return -Infinity;
      if (at < oldest) oldest = at;
    }
    return oldest;
  }

  /**
   * D325: before a trim reads a user's items, a frozen user is thawed in slices (`ItemCache.ready`), not at once inside
   * the read. No await when nothing is frozen or queued. False when the user stopped being synced meanwhile.
   */
  private async thawed(u: UserSync): Promise<boolean> {
    const thawing = this.deps.cache.ready(u.scope);
    if (thawing) await thawing;
    return !u.gone;
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
    const at = this.deps.cache.updatedAtReader(u.scope, now);
    for (const s of u.sources.values()) {
      for (const id of s.ids) all.push({ id, at: at(id) ?? -Infinity, s });
    }
    all.sort((a, b) => b.at - a.at);
    // `engagedDeep`: the newest items of sources the user's lookups use, up to half the cap in all, are kept before any
    // other's; the rest compete by recency. A bound, or two large used mailboxes filled the whole cap and no other
    // source's new item could be stored again (the review: `cutAt` went to Infinity).
    const first = this.o.engagedDeep === true;
    const kept: typeof all = [];
    const rest: typeof all = [];
    if (first) {
      let used = 0;
      const share = Math.floor(this.o.maxItems / 2);
      for (const x of all) {
        if (x.s.engaged && used < share) {
          kept.push(x);
          used++;
        } else rest.push(x);
      }
    } else rest.push(...all);
    const room = Math.max(0, this.o.maxItems - kept.length);
    const gone = rest.slice(room);
    for (const g of gone) {
      g.s.ids.delete(g.id);
      g.s.cut = true;
      if (g.s.deep) g.s.deep.lost = true;
    }
    this.deps.cache.dropSynced(
      u.scope,
      gone.map((g) => g.id),
    );
    // The recency cut: the oldest kept of what competed by recency (all of it without `engagedDeep`). Half the cap or
    // more competes, so it is finite once the user is at the cap.
    const oldest = room > 0 ? (rest[Math.min(rest.length, room) - 1]?.at ?? -Infinity) : -Infinity;
    u.cutAt = all.length >= this.o.maxItems ? oldest : -Infinity;
    return oldest;
  }

  /**
   * A source's backfill is done: it is warm, polled as of now, and its change rate's prior is how many of what it
   * listed changed in the last week (per hour), or one an hour when its items carry no time.
   */
  private warmUp(u: UserSync, s: SourceSync, now: number): void {
    if (s.phase === "warm") return;
    s.phase = "warm";
    // The backfill's pages are in: a quiet source's sketch shrinks to what its terms need.
    s.sketch?.fold();
    // Done before its listing ended: the rest was older than the user's cut, and is not held.
    if (!s.exhausted) s.cut = true;
    // `engagedDeep`: a source a lookup used while its backfill ran is read whole now (`engage` saw it cold).
    if (this.o.engagedDeep && s.engaged && s.cut && !s.deep) s.deep = { cursor: undefined, lost: false };
    s.polledAt = now;
    // Notifications that came before the backfill's last page began are read by it; later ones are not.
    s.noticesPolled = s.noticesBackfill;
    s.sweptAt = now;
    let recent = 0;
    let timed = 0;
    const updatedAt = this.deps.cache.updatedAtReader(u.scope, now);
    for (const id of s.ids) {
      const at = updatedAt(id);
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
    resume?: PollResume,
  ): Promise<void> {
    // A background continuation of a lookup's poll goes on from where that poll stopped, as one poll: from the top,
    // its first page held what the lookup had just stored, read as the boundary, and the source was marked current
    // with the pages past the cap never read (audit A5).
    const started = resume?.started ?? this.deps.now();
    const notices = resume?.notices ?? s.notices;
    const pushSeq = resume?.pushSeq ?? s.pushSeq;
    let cursor: string | undefined = resume?.cursor;
    let changed = resume?.changed ?? 0;
    // `pollPageSize`: the first page is sized to what changed, not to the backfill's page; each page after it tops the
    // items asked up to the next multiple of `pageSize` (5, then 95, then 100). So a poll lists no more items than
    // `maxPages` full pages would, catches up as far before the lookup goes on, and makes at most one more call.
    const adaptive = (this.o.pollPageSize ?? 0) > 0;
    const itemCap = maxPages * this.o.pageSize;
    const first = adaptive && !resume ? Math.min(this.firstPage(s, started), itemCap) : this.o.pageSize;
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
      // A lookup's tally counts the call when it is sent: the lookup may stop waiting before it answers (D283), and
      // its trace must still hold the call the connector received (the review). A guard's skip, no call, is taken back.
      if (tally) tally.calls++;
      const page = await this.list(demand ? "demand" : "poll", source, u.scope, cursor, limit, {
        timeoutMs: this.o.timeoutMs,
        signal,
        reserve: demand ? 0 : SERVING_HEADROOM,
      });
      if (u.gone) return;
      if (typeof page === "string") {
        if (page !== "limited" && page !== "busy") this.count(demand);
        else if (tally) tally.calls--;
        // The lookup gave up (its deadline, the session ending): no evidence against the source, no back-off.
        if (signal?.aborted) return gaveUp();
        this.failed(s, page);
        return;
      }
      this.count(demand);
      if (demand) this.stats.demandItems += page.items.length;
      else this.stats.backgroundItems += page.items.length;
      s.failures = 0;
      const stored = new Set<string>();
      const fresh = this.store(u, s, page.items, readMark, stored, this.o.keepCut && !demand);
      changed += fresh;
      if (tally) tally.fresh += fresh;
      // The listing has reached what was synced before: an item held unchanged that a notification did not bring.
      // An item `keepCut` refused (older than the user's cut) counts too: listings run newest first, so what follows is
      // older still, and the poll is done.
      const boundary = page.items.some((it) => !stored.has(it.id) && !s.pushed.has(it.id));
      if (boundary || page.next === null || page.items.length === 0) {
        this.polled(s, started, changed, notices, pushSeq);
        return;
      }
      cursor = page.next;
    }
    // Not caught up in `maxPages`: a lookup goes on with the source stale; the rest is read in the background.
    if (demand && !u.gone) {
      const from: PollResume = { cursor, changed, started, notices, pushSeq };
      void Promise.resolve().then(() =>
        this.run(s, () => this.poll(u, s, source, MAX_POLL_PAGES, false, undefined, undefined, from)),
      );
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
   * `engagedDeep`: up to two pages of an engaged source's listing from the top, stored as the backfill stores (past
   * the user's cut: the trim then keeps them first). The listing read to its end with every item held makes the copy
   * whole again (D264); one past half the user's `maxItems` stops, and the copy stays cut (searched live, as before).
   */
  private async deepen(u: UserSync, s: SourceSync, source: Source): Promise<void> {
    const deep = s.deep;
    if (!deep) return;
    for (let p = 0; p < 2; p++) {
      if (u.gone || s.deep !== deep) return;
      if (this.budget.take(budgetKey(u, s)) > 0) return;
      const readMark = this.marks;
      const page = await this.list("backfill", source, u.scope, deep.cursor, this.o.pageSize, {
        timeoutMs: this.o.timeoutMs,
        reserve: SERVING_HEADROOM,
      });
      if (u.gone) return;
      if (typeof page === "string") {
        if (page !== "limited" && page !== "busy") this.stats.backgroundCalls++;
        this.failed(s, page);
        return;
      }
      this.stats.backgroundCalls++;
      this.stats.backgroundItems += page.items.length;
      s.failures = 0;
      this.store(u, s, page.items, readMark);
      if (page.next === null || page.items.length === 0) {
        s.deep = null;
        s.exhausted = true;
        // Whole if no trim let any of it go meanwhile; `complete` still checks every id against the cache.
        s.cut = deep.lost;
        s.wholeAt = -1;
        return;
      }
      if (s.ids.size >= this.o.maxItems / 2) {
        s.deep = null;
        return;
      }
      deep.cursor = page.next;
    }
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
    // How far back this source's synced items reach: the sweep reads that far, not the user's whole cap (`maxItems`
    // is across sources; a quiet source was paged to 3,000 items a day and its synced set grew past the backfill's
    // cut, audit A5). Listings run newest first; a source with an undated item is read as before.
    const cut = this.oldestSynced(u, s);
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
      const older = (it: ContextItem) => it.updatedAt !== undefined && it.updatedAt < cut;
      const fresh = this.store(
        u,
        s,
        page.items.filter((it) => !older(it)),
        readMark,
        undefined,
        this.o.keepCut,
      );
      for (const it of page.items) sw.seen.add(it.id);
      // The sweep's first page is the newest: it is also a poll.
      if (first) this.polled(s, started, fresh, notices, pushSeq);
      // `keepCut`: every id held for the source is listed: what follows is older than all of it, and not held.
      const all = this.o.keepCut === true && seenAll(s.ids, sw.seen);
      const full = sw.seen.size >= this.o.maxItems || page.items.some(older) || all;
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
        s.skipped = false;
        return;
      }
      sw.cursor = page.next;
    }
  }

  /**
   * Stores a page's (redacted) items as synced, read under `readMark` (`mark` when its call began); returns how many
   * were new or changed (their ids into `changedIds`).
   */
  private store(
    u: UserSync,
    s: SourceSync,
    items: ContextItem[],
    readMark: number,
    changedIds?: Set<string>,
    keepCut = false,
  ): number {
    // The same user object and source state: work for a user forgotten and back since must not land.
    if (u.gone || items.length === 0 || this.users.get(u.key) !== u || u.sources.get(s.id) !== s) return 0;
    const now = this.deps.now();
    // `routeSketch`: every listed item's terms, kept or not (what the cap trims still says what the source holds).
    if (this.o.sketch) {
      const sketch = (s.sketch ??= new TermSketch());
      for (const it of items) {
        // Held items too: a sketch that restarted (saturated) is filled again by the next sweep's re-listing.
        if (it.sourceId !== s.id) continue;
        for (const t of sketchTerms(`${it.title} ${it.text}`)) sketch.add(...termHashes(t));
      }
    }
    // `keepCut`: a poll's or a sweep's item dated before the user's cut would be the first a trim drops (the cache's
    // synced cap evicted such items oldest synced first, which could be the user's newest mail). Not stored, and the
    // source's copy is then not whole (D264). An item already held is stored as before (an update of what is kept).
    let kept = items;
    // A used source's items are kept before the cut's (`engagedDeep`): the cut is the other sources' only.
    if (keepCut && u.cutAt > -Infinity && !(this.o.engagedDeep && s.engaged)) {
      const cut = u.cutAt;
      kept = items.filter((it) => it.updatedAt === undefined || it.updatedAt >= cut || s.ids.has(it.id));
      if (kept.length < items.length) s.cut = true;
      if (kept.length === 0) return 0;
    }
    // An item its source said is gone (`ItemCache.isHeldGone`) was listed before the deletion: neither stored nor
    // counted as synced, or the listing would undo `removed`.
    const own = kept.filter((it) => it.sourceId === s.id && !this.deps.cache.isHeldGone(u.scope, it.id, now));
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
    if (trimIds(s.ids, this.o.maxItems)) {
      s.cut = true;
      if (s.deep) s.deep.lost = true;
    }
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
    // Not every `fetch` can find an item: an MCP source without a get tool answers null to all (the review, D356).
    s.fetches = typeof source.fetch === "function" && (source.fetchesById ?? source.fetchReportsGone === true);
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
    const options = {
      ...given,
      reuse: this.deps.cache.reuseFor(scope),
      // D328 (trial): background pages wait their turn; a lookup's own poll never waits behind them.
      ...(this.o.ingestTurns && phase !== "demand" ? { turn: this.turn } : {}),
    };
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

  /** The last turn handed out (`turn`). */
  private turns: Promise<void> = Promise.resolve();

  /**
   * `syncIngestTurns` (D328): resolves one turn of the event loop after the turn before it resolved, so the pages
   * waiting on it are redacted and stored one per loop turn, in the order they arrived, with every request, timer
   * and I/O callback that came meanwhile run in between. A page is a few milliseconds to ~15 ms of work (100 items).
   */
  private readonly turn = (): Promise<void> => {
    this.waiting++;
    const t = this.turns.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.turns = t;
    void t.then(() => this.waiting--);
    return t;
  };

  /** Pages handed a turn that has not come yet (`turn`). */
  private waiting = 0;

  /**
   * D370: while pages wait their turn, resolves one loop turn after the last of them was let through (its store has
   * run by then, unless redaction went to the worker pool); null when none waits. The card drain waits on it so its
   * batches hold what arrived together (`CardEnricher.gather`).
   */
  pending(): Promise<void> | null {
    if (this.waiting === 0) return null;
    return this.turns.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }

  /** One listing call, a lookup's (`demand`, also counted in its freshen's `tally`) or the background's. */
  private count(demand: boolean): void {
    if (demand) this.stats.demandCalls++;
    else this.stats.backgroundCalls++;
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
    // What waiters see: settles with the read, or when the watchdog below lets the source go.
    let free!: (stored: number) => void;
    const busy = new Promise<number>((r) => (free = r));
    void p.then(free);
    s.busy = busy;
    // A listing that ignores its signal and never answers would hold the source busy for good (every later read and
    // lookup waits on it; the review). Past the longest a read that honours its timeouts can take, the source is let
    // go; the stuck read, if it ever settles, changes nothing it no longer owns. A timer, not a race: one more await on
    // the listing path moves the card drain's timing (a5-bugs.md).
    const release = () => {
      free(reading.stored);
      if (s.busy === busy) s.busy = null;
      if (s.reading === reading) s.reading = null;
    };
    const watchdog = setTimeout(release, (MAX_POLL_PAGES + 1) * this.o.timeoutMs);
    (watchdog as { unref?: () => void }).unref?.();
    try {
      return await p;
    } finally {
      clearTimeout(watchdog);
      release();
    }
  }
}

function newSourceSync(id: string): SourceSync {
  return {
    id,
    ids: new IdSet(),
    phase: "backfill",
    cursor: undefined,
    exhausted: false,
    cut: false,
    wholeAt: -1,
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
    engaged: false,
    deep: null,
    sketch: null,
    fetches: false,
    skipped: false,
  };
}

const EMPTY: ReadonlySet<string> = new Set();

const budgetKey = (u: UserSync, s: SourceSync) => `${u.key}|${s.id}`;

/**
 * Keeps a source's id set at most `max * 1.5`, dropping the longest synced first (the cache bounds the items); returns
 * whether any went (the copy is then cut, D264).
 */
function trimIds(ids: IdSet, max: number): boolean {
  const cap = Math.ceil(max * 1.5);
  if (ids.size <= cap) return false;
  for (const id of ids) {
    if (ids.size <= cap) break;
    ids.delete(id);
  }
  return true;
}

/** Whether every held id has been seen (an early exit, no copy of the set). */
function seenAll(ids: IdSet, seen: ReadonlySet<string>): boolean {
  for (const id of ids) if (!seen.has(id)) return false;
  return true;
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
