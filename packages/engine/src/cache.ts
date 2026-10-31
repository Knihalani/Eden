/**
 * The per-user item cache: what sources returned recently, redacted, indexed for the fast path. It lives in memory
 * only. Content is never written to disk by default (docs/PRIVACY.md), so a restart costs warm-up, not a leak.
 *
 * Each user has a vocabulary (term ↔ id) and a two-field inverted index (title, body; title weighted 2, which the
 * cache used to approximate by indexing the title twice) from `@eden/primitives`. An item is tokenized once, when it
 * is stored; a query never rescans item text, and "does this item name the entity" is a binary search over the item's
 * stored term ids (pipeline.bench.ts: these two rescans were ~30% of end-to-end CPU before).
 *
 * Bounded three ways: items per user (oldest evicted), users per tenant (least recently written dropped, so one tenant
 * never evicts another's), and item text length. Expired items are swept on write, so they stop shaping idf. A
 * vocabulary never forgets a term, so a user's is rebuilt from the live items when a source is forgotten (no term of
 * a revoked source's content survives) and when it outgrows `VOCAB_REBUILD_FACTOR` times its size after the last
 * rebuild.
 */
import { createHash } from "node:crypto";
import { dedupText, hamming64, SparseIndex, TextSketcher, Vocab } from "@eden/primitives";
import { itemId, scopeKey, type ContextItem, type Scope } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import { userOffset } from "./grounding";
import { squash, UserGraph, type Seed, type Walked, type WalkOptions } from "./kg";
import { head, termIds } from "./text";

const NO_TERMS = new Uint32Array(0);

interface Entry {
  item: ContextItem;
  fetchedAt: number;
  doc: number;
  sketch: Sketch | null;
  /**
   * Held by the user's background sync (D57): counted against `maxSyncedPerUser`, not `maxItemsPerUser`, kept for
   * `syncTtlMs`, and dropped by the sync when its source no longer lists it. A lookup that returns it keeps it synced.
   */
  synced?: true;
}

/**
 * A near-duplicate sketch of an item's own words (quotes, signatures and greetings stripped; for an acknowledgement
 * or bare forward, the message it carries): 64-bit SimHash plus a key of its numbers. Two items are near-duplicates
 * when their SimHashes differ in ≤ 8 bits and their numbers agree (docs/research/primitives-dedup.md: F1 0.963, and
 * stripping quotes first lifts precision from 0.580 to 0.983; the numbers guard keeps "3pm" and "4pm" apart).
 */
export interface Sketch {
  lo: number;
  hi: number;
  numbers: number;
}

const NEAR_DUP_BITS = 8;

/** True when two items are near-duplicates (see `Sketch`). Null sketches (no own words) are never duplicates. */
export function nearDuplicate(a: Sketch | null, b: Sketch | null): boolean {
  return a !== null && b !== null && a.numbers === b.numbers && hamming64(a.lo, a.hi, b.lo, b.hi) <= NEAR_DUP_BITS;
}

/** A user's vocabulary may grow to this many times its size after the last rebuild (at least `MIN_VOCAB_REBUILD`). */
const VOCAB_REBUILD_FACTOR = 4;
const MIN_VOCAB_REBUILD = 50_000;

class UserCache {
  constructor(readonly scope: Scope) {}
  /** Vocabulary size after the last rebuild. */
  baseline = 0;
  readonly items = new Map<string, Entry>();
  /** How many of `items` are synced (D57). */
  synced = 0;
  readonly byDoc: (Entry | undefined)[] = [];
  readonly vocab = new Vocab(256); // Grows by doubling: most users hold few terms.
  readonly index = new SparseIndex({ fields: 2, weights: [2, 1] });
  readonly sketcher = new TextSketcher(this.vocab, 8_192, 3);
  /** The UTC offset most of the user's events carry (minutes), computed on demand; reset as events come and go. */
  offset: number | undefined;
  /** Recent probes (`probes.ts`): a query → the ids it found and when, shared by the user's sessions. */
  readonly probes = new Map<string, { ids: string[]; at: number }>();
  /** The user's own name as their items list it (`selfOf`), computed on demand; null when none stands out. */
  self: string | null | undefined;
  /** How many cached items name each person (`partiesOf`), and how many name anyone: kept as items come and go. */
  parties = new Map<string, number>();
  partied = 0;
  /** The parties' names and first names, lowercased (`isPerson`), computed on demand; reset as the tally changes. */
  personNames: Set<string> | undefined;
  /** The user's knowledge graph (`kg.ts`), when the cache keeps one (`enableGraph`); built on first use. */
  graph: UserGraph | undefined;
}

/** Header lines naming who takes part in an item: a mail's From, To and Cc, an event's attendees, an owner. */
const PARTY_LINES = /^(from|to|cc|attendees|owner|organi[sz]er):[^\n]*$/gim;
/**
 * The people an item names as taking part: its `meta.people`, and its header lines (a mail's From, To and Cc, an
 * event's attendees, a record's owner), as full names of two or three capitalised words.
 */
function partiesOf(item: ContextItem): string[] {
  const heads = item.text.match(PARTY_LINES) ?? [];
  const out: string[] = [];
  for (const entry of [item.meta?.people ?? "", ...heads.map((h) => h.replace(/^[^:]*:/, ""))]
    .join(";")
    .split(/[;,\n]/)) {
    const name = entry
      .replace(/<[^<>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (/^\p{Lu}[\p{L}'-]*( \p{Lu}[\p{L}'-]*){1,2}$/u.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Counts an item's people in or out of the user's tally (`selfOf`). */
function tally(u: UserCache, item: ContextItem, by: 1 | -1): void {
  const names = partiesOf(item);
  if (names.length === 0) return;
  u.partied += by;
  for (const n of names) {
    const c = (u.parties.get(n) ?? 0) + by;
    if (c > 0) u.parties.set(n, c);
    else u.parties.delete(n);
  }
  u.self = undefined;
  u.personNames = undefined;
}

const simScratch = new Uint32Array(2);

export interface CacheHit {
  item: ContextItem;
  /** Near-duplicate sketch of the item (null when it has no own words). */
  sketch: Sketch | null;
  /** The item's doc number in the user's index, for `containsAll`. */
  doc: number;
  score: number;
  /** Share of the query's known-term idf the item holds, 0..1. */
  coverage: number;
  /** Distinct query terms the item holds. */
  matched: number;
}

export interface CacheLimits {
  maxItemsPerUser: number;
  /**
   * Users held per tenant. Past this, that tenant's least recently written user is dropped: one tenant's traffic
   * never evicts another tenant's cache.
   */
  maxUsersPerTenant: number;
  ttlMs: number;
  maxTextChars: number;
  /**
   * Items a user's background sync may hold (D57), apart from `maxItemsPerUser`: lookups never evict what the sync
   * keeps, nor the sync what lookups brought. Past it, the least recently synced is dropped.
   */
  maxSyncedPerUser: number;
  /** How long a synced item is kept without a sync seeing it again (a re-listing refreshes it). */
  syncTtlMs: number;
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  maxItemsPerUser: 2_000,
  maxUsersPerTenant: 10_000,
  ttlMs: 24 * 3_600_000,
  maxTextChars: 8_000,
  maxSyncedPerUser: 5_000,
  syncTtlMs: 7 * 24 * 3_600_000,
};

/**
 * A source item made safe to hold: every text field redacted, text clipped, and an id that never embeds a secret (a
 * ref that held one gets an id from a hash of the raw ref, so two refs that redact alike stay distinct).
 */
export function sanitizeItem(raw: ContextItem, maxTextChars = DEFAULT_CACHE_LIMITS.maxTextChars): ContextItem {
  const ref = sanitizeForStore(raw.ref);
  return {
    ...raw,
    id: sanitizedId(raw, ref),
    ref,
    // Clipped with `head`, never a plain slice: a secret split by the cut would no longer look like one to the gate.
    title: sanitizeForStore(head(raw.title, 500)),
    text: sanitizeForStore(head(raw.text, maxTextChars)),
    url: raw.url === undefined ? undefined : sanitizeForStore(raw.url),
    meta: raw.meta && Object.fromEntries(Object.entries(raw.meta).map(([k, v]) => [k, sanitizeForStore(v)])),
  };
}

/**
 * The id an item has once sanitized: its own, unless its ref held something the gate redacts, then a hash of the ref.
 * For places that keep only an item's id (shadow records) without paying to redact its text.
 */
export function sanitizedId(raw: ContextItem, sanitizedRef = sanitizeForStore(raw.ref)): string {
  if (sanitizedRef === raw.ref) return raw.id;
  return itemId(raw.sourceId, `h-${createHash("sha256").update(raw.ref).digest("hex").slice(0, 16)}`);
}

let titleIds = new Uint32Array(256);
let bodyIds = new Uint32Array(4_096);

export class ItemCache {
  private readonly users = new Map<string, UserCache>();
  private readonly perTenant = new Map<string, number>();
  private readonly limits: CacheLimits;
  /** Whether each user's items are also put in a knowledge graph (`enableGraph`). */
  private graphs = false;
  /** Told of every item that leaves (`onDropped`); null ids: the whole user. */
  private dropped: ((scope: Scope, ids: string[] | null) => void) | null = null;

  constructor(limits: Partial<CacheLimits> = {}) {
    this.limits = { ...DEFAULT_CACHE_LIMITS, ...limits };
  }

  /** A user's cache, without creating one: reads never allocate state for a user who has none. */
  private peek(scope: Scope): UserCache | undefined {
    return this.users.get(scopeKey(scope));
  }

  private touch(scope: Scope): UserCache {
    const key = scopeKey(scope);
    const existing = this.users.get(key);
    if (existing) {
      this.users.delete(key); // Re-insert: Map order is least recently written first.
      this.users.set(key, existing);
      return existing;
    }
    if ((this.perTenant.get(scope.tenantId) ?? 0) >= this.limits.maxUsersPerTenant) {
      const prefix = `${scope.tenantId}/`;
      for (const k of this.users.keys()) {
        if (!k.startsWith(prefix)) continue;
        this.dropUser(k, scope.tenantId);
        break;
      }
    }
    const u = new UserCache({ tenantId: scope.tenantId, userId: scope.userId });
    this.users.set(key, u);
    this.perTenant.set(scope.tenantId, (this.perTenant.get(scope.tenantId) ?? 0) + 1);
    return u;
  }

  private dropUser(key: string, tenantId: string): void {
    const u = this.users.get(key);
    if (!u || !this.users.delete(key)) return;
    this.dropped?.(u.scope, null);
    const n = (this.perTenant.get(tenantId) ?? 1) - 1;
    if (n <= 0) this.perTenant.delete(tenantId);
    else this.perTenant.set(tenantId, n);
  }

  /**
   * Keeps a knowledge graph per user from now on (`kg.ts`, the engine's `graph` flag). A user's graph is built from
   * their cached items on first use, then kept as items come and go; it is dropped with them and with the user.
   */
  enableGraph(): void {
    this.graphs = true;
  }

  /**
   * Calls `fn` whenever items leave a user's cache (expired, evicted, replaced by a changed copy, deleted by the
   * sync, forgotten) with their ids, or null when the whole user goes: what is derived from an item (its implication
   * card) is held no longer than the item.
   */
  onDropped(fn: (scope: Scope, ids: string[] | null) => void): void {
    this.dropped = fn;
  }

  /** The user's graph, built from their live items if it does not exist yet; undefined without one. */
  private graphOf(u: UserCache, now: number): UserGraph | undefined {
    if (!this.graphs) return undefined;
    if (!u.graph) {
      u.graph = new UserGraph();
      for (const e of u.items.values()) u.graph.add(e.item, e.fetchedAt || now);
    }
    return u.graph;
  }

  /**
   * Items the user's knowledge graph reaches from `seeds` (`UserGraph.walk`), fresh ones only. Empty without a graph.
   * Reads never allocate a cache for a user who has none.
   */
  walk(scope: Scope, seeds: Seed[], opt: WalkOptions, now = Date.now()): Walked[] {
    const u = this.peek(scope);
    if (!u || seeds.length === 0) return [];
    const g = this.graphOf(u, now);
    if (!g) return [];
    // The user themself is on nearly everything they hold: their name, addresses and organisation spread nothing.
    const self = this.selfOf(scope);
    if (self && !opt.exclude) opt = { ...opt, exclude: g.around(`n:${squash(self)}`) };
    // Asked for a few more than wanted: an expired item is skipped, not counted.
    return g
      .walk(seeds, { ...opt, limit: opt.limit * 2 })
      .filter((w) => {
        const e = u.items.get(w.id);
        // Its own time to live: a synced item's is `syncTtlMs`, as every other read has it.
        return e !== undefined && this.alive(e, now);
      })
      .slice(0, opt.limit);
  }

  /** Teaches the user's graph an outcome of items reached through `mask`'s edge types (`UserGraph.learn`). */
  learnGraph(scope: Scope, mask: number, used: boolean): void {
    this.peek(scope)?.graph?.learn(mask, used);
  }

  /** Nodes in the user's graph (0 without one), for tests and bounds. */
  graphSize(scope: Scope): number {
    return this.peek(scope)?.graph?.size ?? 0;
  }

  /** The user's vocabulary (creating the user's cache if needed). */
  vocabOf(scope: Scope): Vocab {
    return this.touch(scope).vocab;
  }

  /** The user's vocabulary, or undefined when the user has no cache: reads never allocate one. */
  peekVocab(scope: Scope): Vocab | undefined {
    return this.peek(scope)?.vocab;
  }

  /** Characters of item text kept (`sanitizeItem`'s limit for this cache). */
  get maxTextChars(): number {
    return this.limits.maxTextChars;
  }

  /**
   * Adds items, redacting every text field first (`sanitizeItem`) unless `sanitized` says the caller already did
   * (results from `SourceFanout`, which sanitizes before caching). Returns the stored copies of the items that were
   * new or whose content changed. An item already cached with the same title and text is only refreshed (fetch time,
   * recency): most lookups return items the cache already holds, and re-indexing them was ~12% of server CPU at
   * saturation (packages/sim perf-cli, docs/research/simulation.md).
   */
  put(scope: Scope, items: ContextItem[], now = Date.now(), sanitized = false, synced = false): ContextItem[] {
    const u = this.touch(scope);
    this.sweep(u, now);
    const changed: ContextItem[] = [];
    for (const raw of items) {
      const item = sanitized ? raw : sanitizeItem(raw, this.limits.maxTextChars);
      const old = u.items.get(item.id);
      if (old && synced && !old.synced) {
        old.synced = true;
        u.synced++;
      }
      // A lookup's copy of a synced item leaves it synced: the sync still lists it, and drops it once it does not.
      const isSynced = synced || old?.synced === true;
      if (old && old.item.text === item.text && old.item.title === item.title) {
        // Same words, so the index and sketch stand; the rest (url, meta, updatedAt) is taken from the new copy. Its
        // people are counted again: its meta may name others.
        tally(u, old.item, -1);
        old.item = item;
        tally(u, item, 1);
        old.fetchedAt = now;
        u.items.delete(item.id); // Re-insert: Map order stays oldest-first for eviction.
        u.items.set(item.id, old);
        continue;
      }
      if (old) this.drop(u, old);
      if (item.meta?.start) u.offset = undefined;
      tally(u, item, 1);
      // Added before the item is: a graph built on first use (`graphOf`) must not read it twice.
      this.graphOf(u, now)?.add(item, now);
      const doc = this.index(u, item);
      const entry: Entry = { item, fetchedAt: now, doc, sketch: sketchOf(u, item) };
      if (isSynced) {
        entry.synced = true;
        u.synced++;
      }
      u.items.set(item.id, entry); // Map order stays oldest-first for eviction (old entry was removed above).
      u.byDoc[doc] = entry;
      changed.push(item);
    }
    if (u.synced === 0) {
      while (u.items.size > this.limits.maxItemsPerUser) this.drop(u, u.items.values().next().value as Entry);
    } else {
      this.evictMixed(u);
    }
    if (u.vocab.size > Math.max(MIN_VOCAB_REBUILD, u.baseline * VOCAB_REBUILD_FACTOR)) this.rebuild(scope, u);
    return changed;
  }

  /**
   * Eviction when some items are synced (D57): lookups' items over `maxItemsPerUser` and synced ones over
   * `maxSyncedPerUser` go, each class oldest first, in one pass over the oldest-first order.
   */
  private evictMixed(u: UserCache): void {
    let loose = u.items.size - u.synced - this.limits.maxItemsPerUser;
    let synced = u.synced - this.limits.maxSyncedPerUser;
    if (loose <= 0 && synced <= 0) return;
    for (const e of [...u.items.values()]) {
      if (loose <= 0 && synced <= 0) break;
      if (e.synced && synced > 0) {
        this.drop(u, e);
        synced--;
      } else if (!e.synced && loose > 0) {
        this.drop(u, e);
        loose--;
      }
    }
  }

  /** Whether the cached item is held by the user's sync (D57). */
  isSynced(scope: Scope, id: string): boolean {
    return this.peek(scope)?.items.get(id)?.synced === true;
  }

  /**
   * Drops synced items by id (a sync's delete propagation: its source no longer lists them, D57). An item a lookup
   * also brought is dropped too: the source no longer has it. Returns how many were dropped.
   */
  dropSynced(scope: Scope, ids: Iterable<string>): number {
    const u = this.peek(scope);
    if (!u) return 0;
    let n = 0;
    for (const id of ids) {
      const e = u.items.get(id);
      if (e?.synced) {
        this.drop(u, e);
        n++;
      }
    }
    return n;
  }

  /** Synced items the user's cache holds (D57). */
  syncedCount(scope: Scope): number {
    return this.peek(scope)?.synced ?? 0;
  }

  /** Whether an entry is still within its time to live: a synced item's is `syncTtlMs` (D57). */
  private alive(e: Entry, now: number): boolean {
    return now - e.fetchedAt <= (e.synced ? this.limits.syncTtlMs : this.limits.ttlMs);
  }

  /**
   * Replaces a user's vocabulary, index and sketcher with ones built from its live items, in the same order. Doc
   * numbers change; nothing outside holds them across calls. Sketches are kept (they do not depend on term ids).
   */
  private rebuild(scope: Scope, old: UserCache): void {
    const u = new UserCache(old.scope);
    for (const e of old.items.values()) {
      const doc = this.index(u, e.item);
      const entry = { ...e, doc };
      u.items.set(e.item.id, entry);
      u.byDoc[doc] = entry;
    }
    u.baseline = u.vocab.size;
    // Same items, so the same people: their counts carry over.
    u.parties = old.parties;
    u.partied = old.partied;
    u.self = old.self;
    u.synced = old.synced;
    // Keyed by item id, not doc number: the graph stands as it is.
    u.graph = old.graph;
    this.users.set(scopeKey(scope), u); // Same key: the user's place in the eviction order is unchanged.
  }

  private index(u: UserCache, item: ContextItem): number {
    if (titleIds.length < item.title.length) titleIds = new Uint32Array(item.title.length * 2);
    if (bodyIds.length < item.text.length) bodyIds = new Uint32Array(item.text.length * 2);
    const t = termIds(item.title, u.vocab, true);
    titleIds.set(t.ids.subarray(0, t.n));
    const nt = t.n;
    const b = termIds(item.text, u.vocab, true);
    return u.index.addFields([titleIds, b.ids], [nt, b.n]);
  }

  /**
   * Removes expired items. Map order is oldest-first, so the scan stops at the first fresh one; a synced item (its
   * own, longer time to live) is passed over, and reads check its time on their own.
   */
  private sweep(u: UserCache, now: number): void {
    for (const e of u.items.values()) {
      if (e.synced) {
        if (!this.alive(e, now)) this.drop(u, e);
        continue;
      }
      if (now - e.fetchedAt <= this.limits.ttlMs) break;
      this.drop(u, e);
    }
  }

  private drop(u: UserCache, e: Entry): void {
    if (e.synced) u.synced--;
    u.items.delete(e.item.id);
    u.index.remove(e.doc);
    if (u.byDoc[e.doc] === e) u.byDoc[e.doc] = undefined;
    if (e.item.meta?.start) u.offset = undefined; // An event gone (evicted, expired, forgotten) may change the mode.
    tally(u, e.item, -1);
    u.graph?.remove(e.item.id);
    this.dropped?.(u.scope, [e.item.id]);
  }

  /** When the cached item was last fetched or seen in a lookup (ms), or undefined if it is not cached. */
  fetchedAt(scope: Scope, id: string): number | undefined {
    return this.peek(scope)?.items.get(id)?.fetchedAt;
  }

  get(scope: Scope, id: string, now = Date.now()): ContextItem | null {
    const e = this.peek(scope)?.items.get(id);
    return e && this.alive(e, now) ? e.item : null;
  }

  /** Top items for the query's term ids (`ids[0..n)` in the user's vocabulary), fresh only. */
  search(scope: Scope, ids: ArrayLike<number>, n: number, limit: number, now = Date.now()): CacheHit[] {
    const u = this.peek(scope);
    if (!u || n === 0) return [];
    const res = u.index.search(ids, n, limit * 2);
    const out: CacheHit[] = [];
    for (let j = 0; j < res.count && out.length < limit; j++) {
      const e = u.byDoc[res.docs[j]!];
      if (!e || !this.alive(e, now)) continue;
      out.push({
        item: e.item,
        sketch: e.sketch,
        doc: e.doc,
        score: res.scores[j]!,
        coverage: res.coverage[j]!,
        matched: res.matched[j]!,
      });
    }
    return out;
  }

  /**
   * Top fresh items of the given sources for the query's term ids, at most `limit` per source: a synced source
   * answered from the local index (D57). With `all`, only items holding every query term, newest first (as a mail
   * or chat search answers); otherwise the best scored. Reads the best `depth` of the whole index, so a source whose
   * matches all rank below it answers fewer.
   */
  searchIn(
    scope: Scope,
    ids: ArrayLike<number>,
    n: number,
    limit: number,
    sources: ReadonlySet<string>,
    all: boolean,
    now = Date.now(),
    depth = 400,
  ): CacheHit[] {
    const u = this.peek(scope);
    if (!u || n === 0) return [];
    const res = u.index.search(ids, n, depth);
    const hits: CacheHit[] = [];
    for (let j = 0; j < res.count; j++) {
      const e = u.byDoc[res.docs[j]!];
      if (!e || !sources.has(e.item.sourceId) || !this.alive(e, now)) continue;
      if (all && res.matched[j]! < n) continue;
      hits.push({
        item: e.item,
        sketch: e.sketch,
        doc: e.doc,
        score: res.scores[j]!,
        coverage: res.coverage[j]!,
        matched: res.matched[j]!,
      });
    }
    if (all) hits.sort((a, b) => (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0));
    const per = new Map<string, number>();
    return hits.filter((h) => {
      const k = per.get(h.item.sourceId) ?? 0;
      per.set(h.item.sourceId, k + 1);
      return k < limit;
    });
  }

  /**
   * Fresh cached items that start on one of `days` (YYYY-MM-DD of their `meta.start`: events), soonest first, at most
   * `limit`: for requests that name a day rather than words the item holds (D44). A scan of the user's items (at most
   * `maxItemsPerUser`), run only for such requests; the cap keeps what is scored after it small.
   */
  timed(scope: Scope, days: ReadonlySet<string>, now = Date.now(), limit = 30): CacheHit[] {
    const u = this.peek(scope);
    if (!u || days.size === 0) return [];
    const out: CacheHit[] = [];
    for (const e of u.items.values()) {
      const start = e.item.meta?.start;
      if (!start || !days.has(start.slice(0, 10)) || !this.alive(e, now)) continue;
      out.push({ item: e.item, sketch: e.sketch, doc: e.doc, score: 0, coverage: 0, matched: 0 });
    }
    return out.sort((a, b) => Date.parse(a.item.meta!.start!) - Date.parse(b.item.meta!.start!)).slice(0, limit);
  }

  /** A probe this user made within `maxAgeMs` (D46): its ids, when every one is still cached and fresh; else null. */
  probeHits(scope: Scope, key: string, maxAgeMs: number, now = Date.now()): CacheHit[] | null {
    const memo = this.peek(scope)?.probes.get(key);
    if (!memo || now - memo.at >= maxAgeMs) return null;
    const hits = this.hits(scope, memo.ids, now);
    return hits.length === memo.ids.length ? hits : null;
  }

  /** Remembers a probe's finds for the user, at most `max` probes, the least recently made dropped first. */
  rememberProbe(scope: Scope, key: string, ids: string[], max: number, now = Date.now()): void {
    const u = this.touch(scope);
    u.probes.delete(key);
    u.probes.set(key, { ids, at: now });
    if (u.probes.size > max) u.probes.delete(u.probes.keys().next().value!);
  }

  /** Fresh cached items by id, as unscored hits (the probes' finds); unknown or expired ids are skipped. */
  hits(scope: Scope, ids: Iterable<string>, now = Date.now()): CacheHit[] {
    const u = this.peek(scope);
    if (!u) return [];
    const out: CacheHit[] = [];
    for (const id of ids) {
      const e = u.items.get(id);
      if (e && this.alive(e, now)) {
        out.push({ item: e.item, sketch: e.sketch, doc: e.doc, score: 0, coverage: 0, matched: 0 });
      }
    }
    return out;
  }

  /** The UTC offset (minutes) most of the user's cached events carry: their calendar's zone; 0 if none says. */
  offsetOf(scope: Scope): number {
    const u = this.peek(scope);
    if (!u) return 0;
    if (u.offset === undefined) {
      const starts: string[] = [];
      for (const e of u.items.values()) if (e.item.meta?.start) starts.push(e.item.meta.start);
      u.offset = userOffset(starts);
    }
    return u.offset;
  }

  /**
   * The user's own name, read from their items: the person their items' `meta.people` lists most, when listed on at
   * least a third of the items that list anyone and on at least five (the user is on their own events and mail).
   * Null when no one stands out. Compaction writes it as their first name (`render.ts`).
   */
  selfOf(scope: Scope): string | null {
    const u = this.peek(scope);
    if (!u) return null;
    // Kept as items come and go (`tally`): what is computed here is only the best of the counts.
    if (u.self === undefined) {
      let best: string | null = null;
      let most = 0;
      for (const [name, n] of u.parties) if (n > most) [best, most] = [name, n];
      u.self = best && most >= 5 && most * 3 >= u.partied ? best : null;
    }
    return u.self;
  }

  /**
   * Whether `name` is someone who takes part in the user's items (`partiesOf`: a mail's From, To or Cc, an event's
   * attendees, an owner): their full name, or a first name one of them goes by ("Zoë" for Zoë Müller). A place, a
   * company or a project is not, unless someone is called that. Case-insensitive.
   */
  isPerson(scope: Scope, name: string): boolean {
    const u = this.peek(scope);
    if (!u) return false;
    if (u.personNames === undefined) {
      u.personNames = new Set();
      for (const full of u.parties.keys()) {
        const lower = full.toLowerCase();
        u.personNames.add(lower);
        u.personNames.add(lower.split(" ")[0]!);
      }
    }
    return u.personNames.has(name.trim().replace(/\s+/g, " ").toLowerCase());
  }

  /**
   * Whether `word` is on fewer than `share` of the user's live items (a name, a place, a constraint), rather than
   * common to many ("perfect", "booked"). A word the user's items never hold is rare; so is every word while the
   * cache holds too few items for a share to mean anything (fewer than 1/share).
   */
  isRare(scope: Scope, word: string, share: number): boolean {
    const u = this.peek(scope);
    if (!u || u.index.size * share < 1) return true;
    const id = u.vocab.lookup(word);
    if (id < 0) return true;
    // idf is monotone in a term's document count: compare it with the idf a term on exactly `share` of them has.
    const n = u.index.size;
    const at = share * n;
    return u.index.idf(id) > Math.log(1 + (n - at + 0.5) / (at + 0.5));
  }

  /** The cached item `doc`'s sorted unique term ids (title and body, the user's vocabulary); empty if unknown. */
  termsOf(scope: Scope, doc: number): Uint32Array {
    return this.peek(scope)?.index.termsOf(doc) ?? NO_TERMS;
  }

  /** True if the cached item `doc` contains every term id in `ids[0..n)`: whole-term matching, no text rescans. */
  containsAll(scope: Scope, doc: number, ids: ArrayLike<number>, n: number): boolean {
    return this.peek(scope)?.index.containsAll(doc, ids, n) ?? false;
  }

  forget(scope: Scope, sourceId?: string): void {
    if (!sourceId) {
      this.dropUser(scopeKey(scope), scope.tenantId);
      return;
    }
    const u = this.peek(scope);
    if (!u) return;
    for (const e of [...u.items.values()]) if (e.item.sourceId === sourceId) this.drop(u, e);
    this.rebuild(scope, u);
  }

  get userCount(): number {
    return this.users.size;
  }
}

function sketchOf(u: UserCache, item: ContextItem): Sketch | null {
  const own = dedupText(item.text, 6);
  if (u.sketcher.load(`${item.title}\n${own}`) === 0) return null;
  u.sketcher.simhash(simScratch);
  return { lo: simScratch[0]!, hi: simScratch[1]!, numbers: u.sketcher.numberKey };
}
