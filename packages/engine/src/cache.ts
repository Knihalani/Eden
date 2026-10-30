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
import { head, termIds } from "./text";

const NO_TERMS = new Uint32Array(0);

interface Entry {
  item: ContextItem;
  fetchedAt: number;
  doc: number;
  sketch: Sketch | null;
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
  /** Vocabulary size after the last rebuild. */
  baseline = 0;
  readonly items = new Map<string, Entry>();
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
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  maxItemsPerUser: 2_000,
  maxUsersPerTenant: 10_000,
  ttlMs: 24 * 3_600_000,
  maxTextChars: 8_000,
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
    const u = new UserCache();
    this.users.set(key, u);
    this.perTenant.set(scope.tenantId, (this.perTenant.get(scope.tenantId) ?? 0) + 1);
    return u;
  }

  private dropUser(key: string, tenantId: string): void {
    if (!this.users.delete(key)) return;
    const n = (this.perTenant.get(tenantId) ?? 1) - 1;
    if (n <= 0) this.perTenant.delete(tenantId);
    else this.perTenant.set(tenantId, n);
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
  put(scope: Scope, items: ContextItem[], now = Date.now(), sanitized = false): ContextItem[] {
    const u = this.touch(scope);
    this.sweep(u, now);
    const changed: ContextItem[] = [];
    for (const raw of items) {
      const item = sanitized ? raw : sanitizeItem(raw, this.limits.maxTextChars);
      const old = u.items.get(item.id);
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
      const doc = this.index(u, item);
      const entry = { item, fetchedAt: now, doc, sketch: sketchOf(u, item) };
      u.items.set(item.id, entry); // Map order stays oldest-first for eviction (old entry was removed above).
      u.byDoc[doc] = entry;
      changed.push(item);
    }
    while (u.items.size > this.limits.maxItemsPerUser) this.drop(u, u.items.values().next().value as Entry);
    if (u.vocab.size > Math.max(MIN_VOCAB_REBUILD, u.baseline * VOCAB_REBUILD_FACTOR)) this.rebuild(scope, u);
    return changed;
  }

  /**
   * Replaces a user's vocabulary, index and sketcher with ones built from its live items, in the same order. Doc
   * numbers change; nothing outside holds them across calls. Sketches are kept (they do not depend on term ids).
   */
  private rebuild(scope: Scope, old: UserCache): void {
    const u = new UserCache();
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

  /** Removes expired items. Map order is oldest-first, so the scan stops at the first fresh one. */
  private sweep(u: UserCache, now: number): void {
    for (const e of u.items.values()) {
      if (now - e.fetchedAt <= this.limits.ttlMs) break;
      this.drop(u, e);
    }
  }

  private drop(u: UserCache, e: Entry): void {
    u.items.delete(e.item.id);
    u.index.remove(e.doc);
    if (u.byDoc[e.doc] === e) u.byDoc[e.doc] = undefined;
    if (e.item.meta?.start) u.offset = undefined; // An event gone (evicted, expired, forgotten) may change the mode.
    tally(u, e.item, -1);
  }

  /** When the cached item was last fetched or seen in a lookup (ms), or undefined if it is not cached. */
  fetchedAt(scope: Scope, id: string): number | undefined {
    return this.peek(scope)?.items.get(id)?.fetchedAt;
  }

  get(scope: Scope, id: string, now = Date.now()): ContextItem | null {
    const e = this.peek(scope)?.items.get(id);
    return e && now - e.fetchedAt <= this.limits.ttlMs ? e.item : null;
  }

  /** Top items for the query's term ids (`ids[0..n)` in the user's vocabulary), fresh only. */
  search(scope: Scope, ids: ArrayLike<number>, n: number, limit: number, now = Date.now()): CacheHit[] {
    const u = this.peek(scope);
    if (!u || n === 0) return [];
    const res = u.index.search(ids, n, limit * 2);
    const out: CacheHit[] = [];
    for (let j = 0; j < res.count && out.length < limit; j++) {
      const e = u.byDoc[res.docs[j]!];
      if (!e || now - e.fetchedAt > this.limits.ttlMs) continue;
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
      if (!start || !days.has(start.slice(0, 10)) || now - e.fetchedAt > this.limits.ttlMs) continue;
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
      if (e && now - e.fetchedAt <= this.limits.ttlMs) {
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
