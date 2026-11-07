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
 * never evicts another's), and item text length. Expired items are swept on write, so they stop shaping idf, and on a
 * timer (`expireIdle`), which also drops users left with none: memory follows the users active within the time to
 * live, not every user seen since the process started. Each class of item (a lookup's, the sync's) is also kept in
 * its own oldest-first list, so eviction and expiry touch only what goes, plus one check per class.
 *
 * Terms. By default a vocabulary never forgets a term, so a user's is rebuilt from the live items when a source is
 * forgotten (no term of a revoked source's content survives) and when it outgrows `VOCAB_REBUILD_FACTOR` times its
 * size after the last rebuild: a synchronous reindex of every live item (57–340 ms for a heavy user, docs/audits). With
 * `releaseTerms`, the index reports each term no live item holds once it compacts, and the vocabulary releases it
 * (`Vocab.release`: its string and fingerprint cleared, its id reused): the vocabulary tracks the live items, and
 * forgetting a source compacts and checks that every term left is held by a live item instead of reindexing. The
 * rebuild stays as the fallback (a term interned but never indexed, ids left sparse after a mass eviction).
 */
import { createHash } from "node:crypto";
import { dedupText, hamming64, SparseIndex, TextSketcher, Vocab } from "@eden/primitives";
import { itemId, scopeKey, type ContextItem, type Scope } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import type { ListReuse } from "@eden/sources";
import { dayOf, offsetOf as startOffset, parseWhen, userOffset } from "./grounding";
import { clearDecoded, packItem, repackLike } from "./packed-text";
import { head, termIds } from "./text";

const NO_TERMS = new Uint32Array(0);

interface Entry {
  item: ContextItem;
  fetchedAt: number;
  /**
   * The read mark its copy was read under (`put`'s `readMark`: `SyncManager.mark` when the read began), so a change
   * signal that lands while a read is on the wire still doubts the copy it stores (D133). An unchanged copy read again
   * keeps the later of the two.
   */
  readMark: number;
  doc: number;
  /**
   * Near-duplicate sketch (`sketchOf`), computed on the item's first return as a hit (`sketched`), not at `put`: most
   * stored items are never a hit, and sketching each was a third of the sync's backfill CPU (ingest.bench.ts).
   * Undefined: not computed yet; null: the item has no own words.
   */
  sketch: Sketch | null | undefined;
  /**
   * Held by the user's background sync (D57): counted against `maxSyncedPerUser`, not `maxItemsPerUser`, kept for
   * `syncTtlMs`, and dropped by the sync when its source no longer lists it. A lookup that returns it keeps it synced.
   */
  synced?: true;
  /** Neighbours in its class's oldest-first list (`UserCache.heads`): a lookup's items, or the sync's. */
  prev: Entry | null;
  next: Entry | null;
  /**
   * The hash (`rawHash`) of the raw listed item `item` was redacted from, when it came from a listing that noted it
   * (`reuseFor`): a later listing of the same raw item reuses `item` instead of redacting it again.
   */
  raw?: number;
  /**
   * When the item's doc entered the index, cache-wide and increasing (`ItemCache.seqs`): a frozen user is indexed again
   * in this order on thaw (`thaw`), so equal scores reach the top-k in the order they did before (`SparseIndex`
   * feeds candidates in insertion order), and the thawed user answers exactly as before.
   */
  seq: number;
}

/**
 * A per-process seed for `rawHash`: listed content cannot be crafted ahead of time to collide with another item's
 * hash. A collision could only keep an older redacted copy, never let unredacted text in.
 */
const RAW_SEED = new BigUint64Array(crypto.getRandomValues(new Uint32Array(2)).buffer)[0]!;

/**
 * What `sanitizeItem` reads of a raw item, hashed (wyhash, cut to 53 bits so it is a plain number, held unboxed: a
 * BigInt per item cost 75 B in ingest.bench): equal hashes mean `sanitizeItem` gives the same copy. Title and text are
 * clipped as `sanitizeItem` clips them, so a huge listed text costs no more here than in the gate (D25 keeps that off
 * the event loop), and fields are named, not serialized whole: a getter or `toJSON` cannot hide a change. Undefined
 * when the item cannot be hashed (the caller then redacts it as usual).
 */
function rawHash(raw: ContextItem, maxTextChars: number): number | undefined {
  try {
    // Each part prefixed with its length, so no field's content can pass for a boundary between two.
    const parts: string[] = [
      raw.id,
      raw.sourceId,
      raw.ref,
      head(String(raw.title), 500),
      head(String(raw.text), maxTextChars),
      raw.url === undefined ? "" : `=${String(raw.url)}`,
      String(raw.updatedAt),
    ];
    if (raw.meta) for (const [k, v] of Object.entries(raw.meta)) parts.push(k, String(v));
    const key = parts.map((p) => `${p.length}:${p}`).join("");
    return Number(BigInt.asUintN(53, Bun.hash.wyhash(key, RAW_SEED)));
  } catch {
    return undefined;
  }
}

/** The raw hash each redacted copy a listing made was made from (`ListReuse.made`), read when it is `put`. */
const madeFrom = new WeakMap<ContextItem, number>();

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

/** The class lists' slots: a lookup's items, the sync's (D57). */
const LOOSE = 0;
const SYNCED = 1;

class UserCache {
  constructor(
    readonly scope: Scope,
    releaseTerms: boolean,
  ) {
    // With `releaseTerms`, a term no live item holds is released once the index has compacted it away.
    this.index = new SparseIndex({
      fields: 2,
      weights: [2, 1],
      onTermFreed: releaseTerms ? (t) => this.vocab.release(t) : undefined,
    });
  }
  /** Vocabulary size after the last rebuild. */
  baseline = 0;
  /** The expiry tick (`ItemCache.epoch`) at which the user was last read or written: idle ones freeze (D325). */
  seen = 0;
  /** Changes whenever an item is added, changed or dropped (`ItemCache.revision`); unique across rebuilds. */
  revision = 0;
  readonly items = new Map<string, Entry>();
  /** Per class (`LOOSE`, `SYNCED`): the oldest and newest entry of its list, the same order as `items` restricted. */
  readonly heads: [Entry | null, Entry | null] = [null, null];
  readonly tails: [Entry | null, Entry | null] = [null, null];
  /** How many of `items` are synced (D57). */
  synced = 0;
  readonly byDoc: (Entry | undefined)[] = [];
  readonly vocab = new Vocab(256); // Grows by doubling: most users hold few terms.
  readonly index: SparseIndex;
  readonly sketcher = new TextSketcher(this.vocab, 8_192, 3);
  /** The UTC offset most of the user's events carry (minutes), computed on demand; reset as events come and go. */
  offset: number | undefined;
  /** How many items' `meta.start` carry each UTC offset (`offsetOf`): kept as items come and go. */
  offsets = new Map<number, number>();
  /** Recent probes (`probes.ts`): a query → the ids it found and when, shared by the user's sessions. */
  probes = new Map<string, { ids: string[]; at: number }>();
  /** The user's own name as their items list it (`selfOf`), computed on demand; null when none stands out. */
  self: string | null | undefined;
  /** How many cached items name each person (`partiesOf`), and how many name anyone: kept as items come and go. */
  parties = new Map<string, number>();
  partied = 0;
  /** The parties' names and first names, lowercased (`isPerson`), computed on demand; reset as the tally changes. */
  personNames: Set<string> | undefined;
}

/**
 * A user's cache while idle (`CacheLimits.freezeIdleMs`, D325): every entry, with the tallies kept beside them, as one
 * deflated JSON blob in memory, and no vocabulary, index, sketcher or entry objects. Content stays in memory (D8):
 * nothing is written to disk. The next read or write of the user thaws it (`ItemCache.thaw`) into the same state:
 * the same items in the same order, fetch times, read marks, raw hashes and sketches, the same revision and probes,
 * and an index whose docs were added in the same order, so every answer is the same (`cache-freeze.test.ts`).
 */
class FrozenUser {
  constructor(
    readonly scope: Scope,
    readonly revision: number,
    readonly synced: number,
    readonly size: number,
    readonly probes: Map<string, { ids: string[]; at: number }>,
    readonly blob: Uint8Array,
    /** Per class (`LOOSE`, `SYNCED`): the fetch time of its oldest and newest entry, NaN for none (expiry). */
    readonly oldest: [number, number],
    readonly newest: [number, number],
    /** The user's `seen` when frozen. */
    readonly seen: number,
  ) {}
}

/** One frozen entry: the item as JSON sees it (text decoded), and the entry's own fields. */
interface FrozenEntry {
  i: ContextItem;
  f: number;
  m: number;
  /** Synced (1) or a lookup's (0). */
  s: 0 | 1;
  r?: number;
  /** The sketch: [lo, hi, numbers], null (no own words), or absent (not computed yet). */
  k?: [number, number, number] | null;
  q: number;
}

interface FrozenBody {
  entries: FrozenEntry[];
  parties: [string, number][];
  partied: number;
  offsets: [number, number][];
}

/** Entries per step of a freeze or thaw (`freezeSteps`, `thawSteps`): a few milliseconds of work at most. */
const STEP_ITEMS = 64;
/** A sliced freeze or thaw gives the event loop back at least this often (ms, D325). */
const SLICE_MS = 5;

/** A unit of sliced work (`ItemCache.pump`): its steps, and what to call when they end. */
interface SlicedJob {
  steps: Generator<undefined, void>;
  done: () => void;
}

/** Lets every queued callback (other users' requests, timers, I/O) run before the slice that follows. */
function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

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

/** Counts an item's start offset in or out of the user's tally (`offsetOf`). */
function tallyOffset(u: UserCache, item: ContextItem, by: 1 | -1): void {
  const start = item.meta?.start;
  if (!start) return;
  u.offset = undefined; // An event come or gone, or moved in the order (a refresh), may change the mode or its tie.
  const o = startOffset(start);
  if (o === null) return;
  const c = (u.offsets.get(o) ?? 0) + by;
  if (c > 0) u.offsets.set(o, c);
  else u.offsets.delete(o);
}

/** Appends an entry to its class's list (it is the newest of its class). */
function link(u: UserCache, e: Entry): void {
  const k = e.synced ? SYNCED : LOOSE;
  const tail = u.tails[k];
  e.prev = tail;
  e.next = null;
  if (tail) tail.next = e;
  else u.heads[k] = e;
  u.tails[k] = e;
}

/** Takes an entry out of its class's list; call before its `synced` changes. */
function unlink(u: UserCache, e: Entry): void {
  const k = e.synced ? SYNCED : LOOSE;
  if (e.prev) e.prev.next = e.next;
  else u.heads[k] = e.next;
  if (e.next) e.next.prev = e.prev;
  else u.tails[k] = e.prev;
  e.prev = null;
  e.next = null;
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
  /**
   * How often expired items are swept from every user, and users left with none dropped (`expireIdle`), on an unref'd
   * timer started by the first `put`. 0: never (expired items then go only when their user writes again).
   */
  expireEveryMs: number;
  /**
   * Release a term once no live item holds it (`Vocab.release`), instead of keeping it until the user's vocabulary
   * outgrows its live items and is rebuilt (a synchronous reindex); forgetting a source then needs no reindex either.
   * On by default (D112): `churn.bench.ts` worst put 274.5 to 26.3 ms, heap 38.9 to 25.0 MB.
   */
  releaseTerms: boolean;
  /**
   * Hold each stored item's text deflated (`packed-text.ts`) and decode it on read through its `text` getter (D188,
   * which reopened D111's compressed text as a trial and promoted it): cached text was about half a synced user's
   * heap. `ingest.bench.ts --world`, shipped, 200 users x 500 items: 3,799-3,953 to 2,368-2,543 B/item released
   * (1.55-1.61x), backfill 1.17-1.30x the CPU; `pipeline.bench.ts` 1.01-1.04x; eval and funnel identical. Off: text as
   * plain strings (the benches' `--plain`, for before/after figures).
   */
  packText: boolean;
  /**
   * A user neither read nor written for about this long (ms) is frozen at an expiry tick (`FrozenUser`, D325): held as
   * one compressed blob and thawed, exactly, on next use. Counted in expiry ticks (`expireEveryMs`), at least two: a
   * user last seen in tick k freezes at tick k + ceil(freezeIdleMs / expireEveryMs), so 20-30 minutes after their last
   * use at the defaults, and a lookup that read the user's vocabulary before an await never finds it rebuilt after.
   * 0: never.
   */
  freezeIdleMs: number;
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  maxItemsPerUser: 2_000,
  maxUsersPerTenant: 10_000,
  ttlMs: 24 * 3_600_000,
  maxTextChars: 8_000,
  maxSyncedPerUser: 5_000,
  syncTtlMs: 7 * 24 * 3_600_000,
  expireEveryMs: 10 * 60_000,
  releaseTerms: true,
  packText: true,
  freezeIdleMs: 30 * 60_000,
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
 * Gone-holds (`removeItems` with a hold) kept per user at most: past it, the user's oldest go, so one user's bulk
 * deletion cannot flush other users' holds (and reopen D126's store-back race for them).
 */
const MAX_HOLDS_PER_USER = 1_000;

/**
 * Gone-holds kept per tenant at most, across its users. A hold must last its `holdMs` (`GONE_HOLD_MS`, 10 minutes) to
 * close D126's store-back race, so the cap is sized for a deletion-heavy tenant: 100,000 holds over 10 minutes is ~167
 * deletions a second (the earlier 20,000 dropped holds after ~4 minutes above ~33 a second). Past it, expired holds go
 * first, tenant-wide; only then live ones, the oldest of the user held least recently, each counted (`holdsEvicted`).
 * A hold is an id, an end and a sequence number (a few hundred bytes with its user's map; cache.test.ts measures it,
 * ≤600 B: 208 B, 32 B more than the end alone), so a tenant's holds stay within tens of MB however many users a
 * deletion feed names. They are not in the users' caches: a hold for a user Eden has never seen (a lookup may still be
 * in flight) must not allocate a user's cache nor count against `maxUsersPerTenant`.
 */
const MAX_HOLDS_PER_TENANT = 100_000;

/**
 * Over the tenant cap, a tenant-wide sweep of expired holds runs at most this often: each sweep visits every user
 * holding something, so a tenant at the cap under steady deletion pays one walk a second, not one per removal.
 */
const HOLD_SWEEP_EVERY_MS = 1_000;

/**
 * One gone-hold: until when (ms), and its removal's sequence number (`ItemCache.heldGoneSeq`). The number, drawn from
 * a counter that only grows, tells two removals of the same id apart even within one millisecond, when `until` cannot.
 */
interface Hold {
  until: number;
  seq: number;
}

/**
 * One tenant's gone-holds: per user, id → hold (`Hold`), each user's oldest first, and the users least recently held
 * first. Bounded per user (`MAX_HOLDS_PER_USER`) and per tenant (`MAX_HOLDS_PER_TENANT`); every operation is O(1) per
 * id but `trim`, which stops at each user's first live hold, and the tenant-wide sweep over the cap (at most once per
 * `HOLD_SWEEP_EVERY_MS`, and only once some hold may have expired).
 */
class TenantHolds {
  private readonly users = new Map<string, Map<string, Hold>>();
  /** Holds across the tenant's users. */
  size = 0;
  /** Live holds dropped before their end by a cap (per user or per tenant), since the tenant's holds began. */
  evicted = 0;
  /** No hold ends before this (a lower bound: the earliest end seen since the last sweep). */
  private nextEnd = 0;
  /** When the last tenant-wide sweep ran. */
  private sweptAt = Number.NEGATIVE_INFINITY;

  /**
   * Holds `id` for the user until `until`, under removal sequence `seq`, replacing an earlier hold of it (a re-hold
   * takes the new sequence: it is a later removal).
   */
  hold(userId: string, id: string, until: number, seq: number, now: number): void {
    let held = this.users.get(userId);
    if (held)
      this.users.delete(userId); // Re-insert: the user is now the most recently held.
    else held = new Map();
    this.users.set(userId, held);
    if (held.delete(id)) this.size--; // Re-insert: the user's holds stay oldest first.
    held.set(id, { until, seq });
    this.size++;
    if (until < this.nextEnd) this.nextEnd = until;
    if (held.size > MAX_HOLDS_PER_USER) this.evict(userId, held, now);
    if (this.size <= MAX_HOLDS_PER_TENANT) return;
    // Expired holds go before any live one (a clock that went back sweeps too, rather than waiting a second for it).
    if (now >= this.nextEnd && (now - this.sweptAt >= HOLD_SWEEP_EVERY_MS || now < this.sweptAt)) {
      this.sweptAt = now;
      this.trim(now);
    }
    while (this.size > MAX_HOLDS_PER_TENANT) {
      const [oldest, theirs] = this.users.entries().next().value as [string, Map<string, Hold>];
      this.evict(oldest, theirs, now);
    }
  }

  /** Whether the user's `id` is held at `now`; an expired hold is dropped. */
  isGone(userId: string, id: string, now: number): boolean {
    return this.seqOf(userId, id, now) !== 0;
  }

  /** The sequence of the hold on the user's `id` at `now`, 0 when not held; an expired hold is dropped. */
  seqOf(userId: string, id: string, now: number): number {
    const held = this.users.get(userId);
    const h = held?.get(id);
    if (held === undefined || h === undefined) return 0;
    if (now < h.until) return h.seq;
    this.drop(userId, held, id);
    return 0;
  }

  /** Lifts the user's holds on these ids. */
  revive(userId: string, ids: Iterable<string>): void {
    const held = this.users.get(userId);
    if (held) for (const id of ids) if (held.has(id)) this.drop(userId, held, id);
  }

  /** Drops every hold of the user (`ItemCache.forget`). */
  forget(userId: string): void {
    const held = this.users.get(userId);
    if (!held) return;
    this.size -= held.size;
    this.users.delete(userId);
  }

  /**
   * Drops expired holds: from the front of one user's (with `userId`), or of every user's. A tenant-wide trim also
   * learns the earliest end left (each user's front), so the cap's sweep skips walks that would find nothing.
   */
  trim(now: number, userId?: string): void {
    if (userId !== undefined) {
      const held = this.users.get(userId);
      if (held) this.trimUser(userId, held, now);
      return;
    }
    let nextEnd = Number.POSITIVE_INFINITY;
    for (const [user, held] of this.users) {
      this.trimUser(user, held, now);
      const front = held.values().next().value;
      if (front !== undefined && front.until < nextEnd) nextEnd = front.until;
    }
    this.nextEnd = nextEnd;
  }

  private trimUser(userId: string, held: Map<string, Hold>, now: number): void {
    for (const [id, h] of held) {
      if (now < h.until) break;
      this.drop(userId, held, id);
    }
  }

  /** Drops the user's oldest hold for a cap, counted as early when it was still live. */
  private evict(userId: string, held: Map<string, Hold>, now: number): void {
    const [id, h] = held.entries().next().value as [string, Hold];
    if (now < h.until) this.evicted++;
    this.drop(userId, held, id);
  }

  private drop(userId: string, held: Map<string, Hold>, id: string): void {
    held.delete(id);
    this.size--;
    if (held.size === 0) this.users.delete(userId);
  }
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
  private readonly users = new Map<string, UserCache | FrozenUser>();
  /** Expiry ticks so far (`expireIdle`): a user's `seen` against it says how long they have been idle (D325). */
  private epoch = 0;
  /** The last `Entry.seq` handed out. */
  private seqs = 0;
  /** Users the timer's sliced work will look at again (`drainLater`): to freeze, or frozen with an item expired. */
  private readonly later = new Set<string>();
  /** The slice scheduler's queues (`pump`): thaws a request waits on, then the timer's freezes and expiries. */
  private readonly urgent: SlicedJob[] = [];
  private readonly background: SlicedJob[] = [];
  private pumping = false;
  /** Thaws under way in slices (`ready`): the frozen user each started from, and when it is done. */
  private readonly thawing = new Map<string, { from: FrozenUser; done: Promise<void> }>();
  /** Users frozen and thawed since the cache was built (D325): for the benches and stats. */
  readonly freezes = { frozen: 0, thawed: 0, thawMs: 0 };
  private readonly perTenant = new Map<string, number>();
  /**
   * Gone-holds per tenant (`removeItems` with a hold; `TenantHolds`), bounded per user and per tenant. Apart from the
   * users' caches, so holding an id never allocates one or evicts a user. A tenant's entry goes when it holds nothing,
   * unless a cap dropped a live hold of its: then it stays (empty, a few hundred bytes) to keep its count.
   */
  private readonly holds = new Map<string, TenantHolds>();
  /** Live gone-holds dropped before their end by a cap, every tenant's (`holdsEvicted`). */
  private holdsEvictedTotal = 0;
  /**
   * The last removal sequence handed out (`heldGoneSeq`): cache-wide, so a tenant's holds dropped and begun again never
   * reuse a number a caller may have snapshotted.
   */
  private holdSeqs = 0;
  private readonly limits: CacheLimits;
  /** Told of every item that leaves (`onDropped`); null ids: the whole user. */
  private dropped: ((scope: Scope, ids: string[] | null) => void) | null = null;
  /** The last revision handed out: every user's revisions are drawn from it, so one never repeats. */
  private revisions = 0;
  /** The expiry timer (`expireEveryMs`), started by the first `put`; null before then and after `close`. */
  private expiry: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /**
   * The cache's clock for the timer: the `now` of the last `put`, and the wall time it came at. A tick reads that
   * clock moved on by the wall time since, so a caller on an injected clock (a simulation, a replay) has its items
   * expired on its own time, not on the wall clock's; in production the two are the same.
   */
  private lastNow = 0;
  private lastWall = 0;

  constructor(limits: Partial<CacheLimits> = {}) {
    this.limits = { ...DEFAULT_CACHE_LIMITS, ...limits };
  }

  /** A user's cache, without creating one: reads never allocate state for a user who has none. */
  private peek(scope: Scope): UserCache | undefined {
    const key = scopeKey(scope);
    const x = this.users.get(key);
    if (x === undefined) return undefined;
    const u = x instanceof UserCache ? x : this.thaw(key, x);
    u.seen = this.epoch;
    return u;
  }

  private touch(scope: Scope): UserCache {
    const key = scopeKey(scope);
    const found = this.users.get(key);
    if (found) {
      const existing = found instanceof UserCache ? found : this.thaw(key, found);
      existing.seen = this.epoch;
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
    const u = new UserCache({ tenantId: scope.tenantId, userId: scope.userId }, this.limits.releaseTerms);
    u.revision = ++this.revisions;
    u.seen = this.epoch;
    this.users.set(key, u);
    this.perTenant.set(scope.tenantId, (this.perTenant.get(scope.tenantId) ?? 0) + 1);
    return u;
  }

  private dropUser(key: string, tenantId: string): void {
    const u = this.users.get(key);
    if (!u || !this.users.delete(key)) return;
    this.dropped?.(u.scope, null);
    clearDecoded(); // An expired or evicted user's decoded text does not stay in the memo (`packed-text.ts`).
    const n = (this.perTenant.get(tenantId) ?? 1) - 1;
    if (n <= 0) this.perTenant.delete(tenantId);
    else this.perTenant.set(tenantId, n);
  }

  /**
   * Calls `fn` whenever items leave a user's cache (expired, evicted, replaced by a changed copy, deleted by the
   * sync, forgotten) with their ids, or null when the whole user goes: what is derived from an item (its implication
   * card) is held no longer than the item.
   */
  onDropped(fn: (scope: Scope, ids: string[] | null) => void): void {
    this.dropped = fn;
  }

  /** The user's vocabulary (creating the user's cache if needed). */
  vocabOf(scope: Scope): Vocab {
    return this.touch(scope).vocab;
  }

  /** The user's vocabulary, or undefined when the user has no cache: reads never allocate one. */
  peekVocab(scope: Scope): Vocab | undefined {
    return this.peek(scope)?.vocab;
  }

  /**
   * A listing's reuse of this user's held copies (`ListReuse`, for `SourceFanout.list`): a raw item identical, field
   * for field, to the one a held copy was redacted from gets that copy back, not a second redaction; anything else
   * (new, changed, a ref the gate rewrote, a copy a lookup replaced) is redacted. Per user: never another's copy.
   */
  reuseFor(scope: Scope): ListReuse {
    const hashes = new WeakMap<ContextItem, number | undefined>();
    const hashOf = (raw: ContextItem) => {
      if (hashes.has(raw)) return hashes.get(raw);
      const h = rawHash(raw, this.limits.maxTextChars);
      hashes.set(raw, h);
      return h;
    };
    return {
      held: (raw) => {
        const e = this.peek(scope)?.items.get(raw.id);
        if (e?.raw === undefined) return undefined;
        return e.raw === hashOf(raw) ? e.item : undefined;
      },
      made: (raw, redacted) => {
        const h = hashOf(raw);
        if (h !== undefined) madeFrom.set(redacted, h);
      },
    };
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
   * saturation (packages/sim perf-cli, docs/research/simulation.md). `readMark` is the sync's read mark when the read
   * that brought them began (`Entry.readMark`; 0, before any signal, when the caller has none).
   */
  put(
    scope: Scope,
    items: ContextItem[],
    now = Date.now(),
    sanitized = false,
    synced = false,
    readMark = 0,
  ): ContextItem[] {
    this.lastNow = now;
    this.lastWall = Date.now();
    if (this.expiry === null && !this.closed && this.limits.expireEveryMs > 0) {
      this.expiry = expiryTimer(new WeakRef<ItemCache>(this), this.limits.expireEveryMs);
    }
    const u = this.touch(scope);
    this.sweep(u, now);
    const changed: ContextItem[] = [];
    const held = this.holds.get(scope.tenantId);
    for (const raw of items) {
      const item = sanitized ? raw : sanitizeItem(raw, this.limits.maxTextChars);
      if (held !== undefined && held.isGone(scope.userId, item.id, now)) continue;
      const old = u.items.get(item.id);
      if (old && synced && !old.synced) {
        unlink(u, old); // Out of the lookups' list into the sync's (re-placed below, refreshed or dropped).
        old.synced = true;
        u.synced++;
        link(u, old);
      }
      // A lookup's copy of a synced item leaves it synced: the sync still lists it, and drops it once it does not.
      const isSynced = synced || old?.synced === true;
      if (old && old.item === item) {
        // A listing reused the copy held (`reuseFor`): nothing about it changed, so only its fetch time and order.
        old.fetchedAt = now;
        old.readMark = Math.max(old.readMark, readMark);
        u.items.delete(item.id);
        u.items.set(item.id, old);
        unlink(u, old);
        link(u, old);
        continue;
      }
      const from = madeFrom.get(item);
      if (old && old.item.text === item.text && old.item.title === item.title) {
        // Same words, so the index and sketch stand; the rest (url, meta, updatedAt) is taken from the new copy. Its
        // people are counted again: its meta may name others.
        if (!sameDetails(old.item, item)) u.revision = ++this.revisions;
        tally(u, old.item, -1);
        tallyOffset(u, old.item, -1);
        // The new copy's fields, its text still deflated (the held bytes reused: same words, no second deflate).
        const fresh = this.limits.packText ? repackLike(item, old.item) : item;
        old.item = fresh;
        tally(u, fresh, 1);
        tallyOffset(u, fresh, 1);
        old.raw = from; // What this copy was redacted from, if a listing said; a lookup's copy ends the reuse.
        old.fetchedAt = now;
        old.readMark = Math.max(old.readMark, readMark); // The same words: current as of the later read.
        u.items.delete(item.id); // Re-insert: Map order stays oldest-first for eviction.
        u.items.set(item.id, old);
        unlink(u, old);
        link(u, old);
        continue;
      }
      if (old) this.drop(u, old);
      tallyOffset(u, item, 1);
      tally(u, item, 1);
      const doc = this.index(u, item);
      // The copy held: with `packText`, its text deflated (the tallies and index above read the plain one).
      const stored = this.limits.packText ? packItem(item) : item;
      // `raw` always set (if undefined), so every entry has one shape.
      const entry: Entry = {
        item: stored,
        fetchedAt: now,
        readMark,
        doc,
        sketch: undefined,
        prev: null,
        next: null,
        raw: from,
        seq: ++this.seqs,
      };
      if (isSynced) {
        entry.synced = true;
        u.synced++;
      }
      u.items.set(item.id, entry); // Map order stays oldest-first for eviction (old entry was removed above).
      link(u, entry);
      u.byDoc[doc] = entry;
      u.revision = ++this.revisions;
      changed.push(stored);
    }
    if (u.synced === 0) {
      while (u.items.size > this.limits.maxItemsPerUser) this.drop(u, u.items.values().next().value as Entry);
    } else {
      this.evictMixed(u);
    }
    if (this.vocabOverGrown(u)) this.rebuild(scope, u);
    // Only what is still held: an item evicted by this same put is not new to the cache (its drop hook already ran,
    // so a card or a mention made from it now would outlive it).
    return changed.filter((item) => u.items.get(item.id)?.item === item);
  }

  /**
   * Whether the user's vocabulary should be rebuilt from the live items. Without `releaseTerms`, once its id count
   * passes `VOCAB_REBUILD_FACTOR` times its size after the last rebuild (dead terms pile up until then). With it, dead
   * terms are released as the index compacts and their ids reused, so the id count follows the terms live items hold;
   * a rebuild is only the fallback for ids left sparse (a mass eviction after a peak) or terms never indexed.
   */
  private vocabOverGrown(u: UserCache): boolean {
    const floor = this.limits.releaseTerms ? u.index.termCount : u.baseline;
    return u.vocab.size > Math.max(MIN_VOCAB_REBUILD, floor * VOCAB_REBUILD_FACTOR);
  }

  /**
   * Eviction when some items are synced (D57): lookups' items over `maxItemsPerUser` and synced ones over
   * `maxSyncedPerUser` go, each class oldest first, from the head of its own list (no walk past the other class).
   */
  private evictMixed(u: UserCache): void {
    for (let loose = u.items.size - u.synced - this.limits.maxItemsPerUser; loose > 0; loose--) {
      this.drop(u, u.heads[LOOSE]!);
    }
    for (let synced = u.synced - this.limits.maxSyncedPerUser; synced > 0; synced--) this.drop(u, u.heads[SYNCED]!);
  }

  /**
   * A number that changes whenever the user's cached items do (one added, its words or details changed, or one
   * dropped), and not when a lookup only refreshes what is held: what is derived from the items can be kept until it
   * changes. 0 for a user with no cache.
   */
  revision(scope: Scope): number {
    return this.users.get(scopeKey(scope))?.revision ?? 0; // A frozen user's too, without thawing it.
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

  /**
   * Drops items by id, synced or not: the source no longer has them (a deletion notification, a fetch that found the
   * item gone). Their cards go with them (`onDropped`). With `holdMs`, a later `put` of one of them
   * is ignored until `now + holdMs` (or `revive`): a search or listing that read it before the deletion cannot bring it
   * back. The hold is kept even for a user with no cache yet (their first lookup may be in flight), in the tenant's
   * holds (`TenantHolds`, bounded per user and per tenant): it allocates no user's cache and evicts no user. Returns
   * how many cached items were dropped (not how many ids were held).
   */
  removeItems(scope: Scope, ids: Iterable<string>, now = Date.now(), holdMs = 0): number {
    clearDecoded(); // A deleted item's decoded text does not stay in the memo.
    let held: TenantHolds | undefined;
    if (holdMs > 0) {
      held = this.holds.get(scope.tenantId);
      if (held === undefined) this.holds.set(scope.tenantId, (held = new TenantHolds()));
      else held.trim(now, scope.userId);
    }
    const evicted = held?.evicted ?? 0;
    const u = this.peek(scope);
    let n = 0;
    for (const id of ids) {
      held?.hold(scope.userId, id, now + holdMs, ++this.holdSeqs, now);
      const e = u?.items.get(id);
      if (!e) continue;
      this.drop(u!, e);
      n++;
    }
    if (held) this.holdsEvictedTotal += held.evicted - evicted;
    return n;
  }

  /** Lifts `removeItems`' hold on these ids: their source has them (a notification carried them, a re-read found). */
  revive(scope: Scope, ids: Iterable<string>): void {
    this.holds.get(scope.tenantId)?.revive(scope.userId, ids);
  }

  /** Whether `removeItems` holds this id as gone at `now` (a page read before its deletion must not count it). */
  isHeldGone(scope: Scope, id: string, now = Date.now()): boolean {
    return this.holds.get(scope.tenantId)?.isGone(scope.userId, id, now) === true;
  }

  /**
   * The sequence number of the removal holding this id as gone at `now`, 0 when none does. Every removal with a hold
   * takes a new, larger number, a second removal of an id already held included, so a caller that snapshots it before
   * an await can tell whether a removal landed during the await (`sourceItems`, D176). A cap that drops the hold
   * reads as 0.
   */
  heldGoneSeq(scope: Scope, id: string, now = Date.now()): number {
    return this.holds.get(scope.tenantId)?.seqOf(scope.userId, id, now) ?? 0;
  }

  /** Gone-holds kept for the tenant (`removeItems`), expired ones not yet swept included: for tests and bounds. */
  holdCount(tenantId: string): number {
    return this.holds.get(tenantId)?.size ?? 0;
  }

  /**
   * Gone-holds a cap dropped while still live (before their `holdMs` ended): the tenant's, or every tenant's without
   * one. Non-zero means deletions outran `MAX_HOLDS_PER_TENANT` (or one user's outran `MAX_HOLDS_PER_USER`), so a read
   * from before a deletion could store its item back (D126's race). Partner reports it as `freshness.holdsEvicted`.
   */
  holdsEvicted(tenantId?: string): number {
    if (tenantId === undefined) return this.holdsEvictedTotal;
    return this.holds.get(tenantId)?.evicted ?? 0;
  }

  /** Synced items the user's cache holds (D57). */
  syncedCount(scope: Scope): number {
    return this.users.get(scopeKey(scope))?.synced ?? 0; // A frozen user's too, without thawing it.
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
    const u = new UserCache(old.scope, this.limits.releaseTerms);
    u.revision = ++this.revisions;
    u.seen = old.seen;
    for (const e of old.items.values()) {
      const doc = this.index(u, e.item);
      const { item, fetchedAt, readMark, sketch, raw } = e;
      const seq = ++this.seqs; // The new index's insertion order.
      const entry: Entry = { item, fetchedAt, readMark, doc, sketch, prev: null, next: null, raw, seq };
      if (e.synced) entry.synced = true;
      u.items.set(e.item.id, entry);
      link(u, entry); // In `items` order, so each class's list keeps its order.
      u.byDoc[doc] = entry;
    }
    u.baseline = u.vocab.size;
    // Same items, so the same people: their counts carry over.
    u.parties = old.parties;
    u.partied = old.partied;
    u.self = old.self;
    u.synced = old.synced;
    u.offsets = old.offsets;
    u.offset = old.offset;
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
   * Removes expired items. Each class's list is oldest-first and the class has one time to live, so its expired items
   * are a prefix of it: the walk stops at the first live one of each, touching only what goes.
   */
  private sweep(u: UserCache, now: number): void {
    for (let e = u.heads[LOOSE]; e && !this.alive(e, now); e = u.heads[LOOSE]) this.drop(u, e);
    for (let e = u.heads[SYNCED]; e && !this.alive(e, now); e = u.heads[SYNCED]) this.drop(u, e);
  }

  /** Whether any of the user's items is past its time to live: the oldest of each class is (`sweep`). */
  private anyExpired(u: UserCache, now: number): boolean {
    const loose = u.heads[LOOSE];
    const synced = u.heads[SYNCED];
    return (loose !== null && !this.alive(loose, now)) || (synced !== null && !this.alive(synced, now));
  }

  private drop(u: UserCache, e: Entry): void {
    u.revision = ++this.revisions;
    unlink(u, e);
    if (e.synced) u.synced--;
    u.items.delete(e.item.id);
    u.index.remove(e.doc);
    if (u.byDoc[e.doc] === e) u.byDoc[e.doc] = undefined;
    tallyOffset(u, e.item, -1); // An event gone (evicted, expired, forgotten) may change the mode.
    tally(u, e.item, -1);
    this.dropped?.(u.scope, [e.item.id]);
  }

  /** When the cached item was last fetched or seen in a lookup (ms), or undefined if it is not cached. */
  fetchedAt(scope: Scope, id: string): number | undefined {
    return this.peek(scope)?.items.get(id)?.fetchedAt;
  }

  /** The read mark the cached item's copy was read under (`Entry.readMark`), or undefined if it is not cached. */
  readMark(scope: Scope, id: string): number | undefined {
    return this.peek(scope)?.items.get(id)?.readMark;
  }

  /**
   * `get(scope, id, now)?.updatedAt` for many ids of one user, looking the user up once (the sync's trim reads every
   * synced item's time after each backfill page; one lookup per id was a tenth of a 1,000-source cold start, D261).
   */
  updatedAtReader(scope: Scope, now = Date.now()): (id: string) => number | undefined {
    const items = this.peek(scope)?.items;
    return (id) => {
      const e = items?.get(id);
      return e && this.alive(e, now) ? e.item.updatedAt : undefined;
    };
  }

  /** Whether each id is held as a synced item and alive, for many ids of one user (the sync's `complete`, D264). */
  syncedReader(scope: Scope, now = Date.now()): (id: string) => boolean {
    const items = this.peek(scope)?.items;
    return (id) => {
      const e = items?.get(id);
      return e !== undefined && e.synced === true && this.alive(e, now);
    };
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
        sketch: sketched(u, e),
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
      // Sketched below, only once the per-source cap has kept it: up to `depth` hits are built here.
      hits.push({
        item: e.item,
        sketch: null,
        doc: e.doc,
        score: res.scores[j]!,
        coverage: res.coverage[j]!,
        matched: res.matched[j]!,
      });
    }
    if (all) hits.sort((a, b) => (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0));
    const per = new Map<string, number>();
    const kept = hits.filter((h) => {
      const k = per.get(h.item.sourceId) ?? 0;
      per.set(h.item.sourceId, k + 1);
      return k < limit;
    });
    for (const h of kept) h.sketch = sketched(u, u.byDoc[h.doc]!);
    return kept;
  }

  /**
   * Fresh cached items that start on one of `days` (YYYY-MM-DD of their `meta.start`: events), soonest first, at most
   * `limit`: for requests that name a day rather than words the item holds (D44). A scan of the user's items (at most
   * `maxItemsPerUser`), run only for such requests; the cap keeps what is scored after it small. An item's day is
   * `startDay`'s at `offset` (`dayOf`): the user's, or the one the request's days were resolved at (`Cue.offset`), so
   * the engine's on-day checks agree with what this returns even if a sync moved the user's offset in between.
   */
  timed(scope: Scope, days: ReadonlySet<string>, now = Date.now(), limit = 30, offset?: number): CacheHit[] {
    const u = this.peek(scope);
    if (!u || days.size === 0) return [];
    offset ??= this.offsetOf(scope);
    const out: CacheHit[] = [];
    for (const e of u.items.values()) {
      const start = e.item.meta?.start;
      if (!start || !days.has(dayOf(start, offset)) || !this.alive(e, now)) continue;
      out.push({ item: e.item, sketch: null, doc: e.doc, score: 0, coverage: 0, matched: 0 });
    }
    // Zone-less starts read as UTC (`parseWhen`); one that does not parse sorts last (NaN compares false).
    const at = (h: CacheHit) => {
      const t = parseWhen(h.item.meta!.start!);
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    const kept = out.sort((a, b) => at(a) - at(b) || 0).slice(0, limit);
    // Sketched after the cut: every item on the day was a candidate above.
    for (const h of kept) h.sketch = sketched(u, u.byDoc[h.doc]!);
    return kept;
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
        out.push({ item: e.item, sketch: sketched(u, e), doc: e.doc, score: 0, coverage: 0, matched: 0 });
      }
    }
    return out;
  }

  /**
   * The UTC offset (minutes) most of the user's cached events carry: their calendar's zone; 0 if none says. Read from
   * the tally kept as items come and go (O(distinct offsets)); `userOffset` over the items in order is what it equals.
   * Its tie-break (a non-zero offset over 0, then the offset seen first in item order) needs the order only when two
   * or more non-zero offsets tie for the most, and then the items are scanned as before.
   */
  offsetOf(scope: Scope): number {
    const u = this.peek(scope);
    if (!u) return 0;
    if (u.offset === undefined) {
      let most = 0;
      let nonZero = 0; // Non-zero offsets at the most.
      let pick = 0;
      for (const [o, c] of u.offsets) {
        if (c > most) {
          most = c;
          nonZero = 0;
        }
        if (c === most && o !== 0 && nonZero++ === 0) pick = o;
      }
      if (nonZero === 0) pick = 0;
      else if (nonZero > 1) {
        const starts: string[] = [];
        for (const e of u.items.values()) if (e.item.meta?.start) starts.push(e.item.meta.start);
        pick = userOffset(starts);
      }
      u.offset = pick;
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
  /** How many of the user's cached items name `name` (full name, case-insensitive) as a party (`partiesOf`). */
  partyCount(scope: Scope, name: string): number {
    const u = this.peek(scope);
    if (!u) return 0;
    const want = name.trim().replace(/\s+/g, " ").toLowerCase();
    for (const [full, n] of u.parties) if (full.toLowerCase() === want) return n;
    return 0;
  }

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

  /**
   * Sweeps expired items from every user (`sweep`: a lookup's past `ttlMs`, a synced one past `syncTtlMs`) and drops
   * each user left with none, telling `onDropped` (null ids: the whole user, so their cards go too). Reads already
   * skip expired items, so no answer changes; what changes is that an idle user's items, index and vocabulary are
   * freed instead of held until they write again. Every user is visited on their own items alone: one user's fresh
   * items keep no other user, and no tenant's traffic expires another's. Returns how many users were dropped.
   *
   * A user with nothing expired costs one check per class of item (the oldest of each, `anyExpired`). Runs on the timer
   * (`expireEveryMs`), so never inside a caller's synchronous use of a user's vocabulary ids; callable directly
   * (tests, a simulation on its own clock).
   */
  expireIdle(now = Date.now(), sliced = false): number {
    let n = 0;
    this.epoch++;
    // Expired gone-holds go too, and a tenant left with none: holds outlive no one's interest in them.
    for (const [tenant, held] of this.holds) {
      held.trim(now);
      if (held.size === 0 && held.evicted === 0) this.holds.delete(tenant);
    }
    const freezeTicks = this.freezeTicks();
    // Deleting the entry being visited is safe in a Map walk: no copy of 10k+ users per tick.
    for (const [key, x] of this.users) {
      let u: UserCache;
      if (x instanceof FrozenUser) {
        // A frozen user is thawed here only when something of theirs expired (and frozen again below if still idle).
        if (!this.frozenExpired(x, now)) continue;
        if (sliced) {
          this.later.add(key);
          continue;
        }
        u = this.thaw(key, x);
      } else u = x;
      if (this.expireUser(key, u, now)) {
        n++;
        continue;
      }
      if (!this.freezable(u, freezeTicks)) continue;
      if (sliced) this.later.add(key);
      else this.freeze(key, u);
    }
    if (sliced && this.later.size > 0) this.drainLater();
    return n;
  }

  /** `freezeIdleMs` in expiry ticks (at least two: see `CacheLimits.freezeIdleMs`); 0 when users never freeze. */
  private freezeTicks(): number {
    const { freezeIdleMs, expireEveryMs } = this.limits;
    if (!(freezeIdleMs > 0) || !(expireEveryMs > 0)) return 0;
    return Math.max(2, Math.ceil(freezeIdleMs / expireEveryMs));
  }

  /** Whether a user has been idle long enough to freeze (`freezeIdleMs`). */
  private freezable(u: UserCache, freezeTicks: number): boolean {
    return freezeTicks > 0 && u.items.size > 0 && this.epoch - u.seen >= freezeTicks;
  }

  /**
   * The timer's freezing, and its expiry of frozen users, as background jobs of the slice scheduler (`pump`, D325):
   * one user at a time, a few milliseconds a turn of the event loop, after any thaw a request waits on. A user read
   * or written meanwhile is left as they are (a freeze in progress is dropped: `freezeJob`).
   */
  private drainLater(): void {
    for (const key of this.later) this.background.push({ steps: this.laterJob(key), done: () => {} });
    this.later.clear();
    void this.pump();
  }

  /** What `drainLater` does for one user, looked at again when the job starts (things may have moved since). */
  private *laterJob(key: string): Generator<undefined, void> {
    const now = this.lastNow + (Date.now() - this.lastWall);
    let x = this.users.get(key);
    if (x instanceof FrozenUser) {
      if (!this.frozenExpired(x, now)) return;
      yield* this.thawJob(key, x);
      x = this.users.get(key);
      if (!(x instanceof UserCache) || this.expireUser(key, x, now)) return;
    }
    if (x instanceof UserCache && this.freezable(x, this.freezeTicks())) yield* this.freezeJob(key, x);
  }

  /**
   * Runs the sliced jobs (D325): thaws a request waits on (`urgent`) first, then the timer's (`background`), each
   * job to its end in steps, giving the event loop back every `SLICE_MS`. One job at a time, first come first served,
   * so however many users return at once, other work waits at most one slice per turn: a burst of thaws queues
   * (admission), it does not spread across the loop.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let t = performance.now();
      for (;;) {
        const job = this.urgent[0] ?? this.background[0];
        if (job === undefined) return;
        let r: IteratorResult<undefined, void>;
        try {
          r = job.steps.next();
        } catch {
          r = { done: true, value: undefined }; // A job that throws ends; its user stays as it was.
        }
        if (r.done) {
          (this.urgent[0] === job ? this.urgent : this.background).shift();
          job.done();
        }
        if (performance.now() - t >= SLICE_MS) {
          await yieldLoop();
          t = performance.now();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** `expireIdle`'s work on one user: their expired items swept; true when the user was dropped whole. */
  private expireUser(key: string, u: UserCache, now: number): boolean {
    // Holds items, none expired: nothing to sweep, and alive. (A user with none may be dropped below.) A merge left
    // under way by a user who stopped writing holds two copies of the index's arrays: end it (D120).
    if (u.items.size > 0 && !this.anyExpired(u, now)) {
      u.index.settle();
      return false;
    }
    // A probe made within the time to live is kept with its user, even one that found nothing: forgetting it would
    // cost the source call it saves (D46).
    const idle = !probedSince(u.probes, now - this.limits.ttlMs);
    // A user with nothing alive goes whole, without unindexing item by item (2.2 s for 100k items when swept one
    // by one, scratch measurement): the drop hook hears (scope, null), as for `forget`.
    if (idle && !this.anyAlive(u, now)) {
      this.dropUser(key, u.scope.tenantId);
      return true;
    }
    this.sweep(u, now);
    // After the sweep: its removes may purge, and a purge may start a merge.
    u.index.settle();
    if (idle && u.items.size === 0) {
      this.dropUser(key, u.scope.tenantId);
      return true;
    }
    return false;
  }

  /** Whether a frozen user holds an expired item (`anyExpired` on the oldest of each class) or holds none. */
  private frozenExpired(f: FrozenUser, now: number): boolean {
    if (f.size === 0) return true;
    const [loose, synced] = f.oldest;
    return now - loose > this.limits.ttlMs || now - synced > this.limits.syncTtlMs; // NaN (none) compares false.
  }

  /**
   * Freezes an idle user (D325): their entries and tallies serialized in `items` order, each with its insertion
   * sequence, compressed into one blob; the user's vocabulary, index, sketcher and entries are let go.
   */
  private freeze(key: string, u: UserCache): void {
    const steps = this.freezeSteps(u);
    let r = steps.next();
    while (!r.done) r = steps.next();
    this.install(key, r.value);
  }

  /** `freeze` as a sliced job: given up if the user is read, written or replaced before it is done. */
  private *freezeJob(key: string, u: UserCache): Generator<undefined, void> {
    const { seen, revision } = u;
    const steps = this.freezeSteps(u);
    for (let r = steps.next(); ; r = steps.next()) {
      if (this.users.get(key) !== u || u.seen !== seen || u.revision !== revision) return;
      if (r.done) return this.install(key, r.value);
      yield;
    }
  }

  private install(key: string, f: FrozenUser): void {
    this.users.set(key, f); // Same key: the user's place in the eviction order is unchanged.
    clearDecoded(); // Decoded texts of this user's items do not stay in the memo.
    this.freezes.frozen++;
  }

  /** The work of a freeze, a step per `STEP_ITEMS` entries (reading each item's text inflates it). */
  private *freezeSteps(u: UserCache): Generator<undefined, FrozenUser> {
    const parts: string[] = [];
    let chunk: FrozenEntry[] = [];
    const oldest: [number, number] = [Number.NaN, Number.NaN];
    const newest: [number, number] = [Number.NaN, Number.NaN];
    for (const e of u.items.values()) {
      const s = e.synced ? SYNCED : LOOSE;
      if (Number.isNaN(oldest[s])) oldest[s] = e.fetchedAt;
      newest[s] = e.fetchedAt;
      const rec: FrozenEntry = { i: e.item, f: e.fetchedAt, m: e.readMark, s: e.synced ? 1 : 0, q: e.seq };
      if (e.raw !== undefined) rec.r = e.raw;
      if (e.sketch !== undefined) rec.k = e.sketch && [e.sketch.lo, e.sketch.hi, e.sketch.numbers];
      chunk.push(rec);
      if (chunk.length >= STEP_ITEMS) {
        parts.push(JSON.stringify(chunk).slice(1, -1));
        chunk = [];
        yield;
      }
    }
    if (chunk.length > 0) parts.push(JSON.stringify(chunk).slice(1, -1));
    // Class lists are `items` order restricted (`link`), so their heads and tails are the first and last seen above.
    const rest = JSON.stringify({ parties: [...u.parties], partied: u.partied, offsets: [...u.offsets] });
    const json = `{"entries":[${parts.join(",")}],${rest.slice(1)}`;
    // zstd at level 3 over the whole user: 270 B an item against 464 for deflate at its default level, at 3.3 against
    // 42.7 µs an item (500 workload items, `.local` scratch measurement; docs/research/a14-scale-users.md).
    const blob = Bun.zstdCompressSync(utf8.encode(json), { level: 3 });
    return new FrozenUser(u.scope, u.revision, u.synced, u.items.size, u.probes, blob, oldest, newest, u.seen);
  }

  /**
   * Null when the user is not frozen; else a promise that resolves once they are thawed (D325), as an urgent job of
   * the slice scheduler (`pump`): other users' events do not wait behind this one's thaw. A read before it resolves
   * thaws the rest at once (`peek`): the answer is the same, only the wait moves. While a thaw some caller waits on
   * is still queued, a later caller waits on it too, even if a read (or a forget) already ended the frozen state:
   * otherwise a session's later event would run before its earlier one, still waiting in the queue.
   */
  ready(scope: Scope): Promise<void> | null {
    const key = scopeKey(scope);
    const x = this.users.get(key);
    const running = this.thawing.get(key);
    if (!(x instanceof FrozenUser)) return running?.done ?? null;
    if (running?.from === x) return running.done;
    const done = new Promise<void>((resolve) => {
      this.urgent.push({
        steps: this.thawJob(key, x),
        done: () => {
          if (this.thawing.get(key)?.from === x) this.thawing.delete(key);
          resolve();
        },
      });
    });
    this.thawing.set(key, { from: x, done });
    void this.pump();
    return done;
  }

  /** A thaw as a sliced job: given up if the user is thawed (`peek`) or dropped meanwhile. */
  private *thawJob(key: string, f: FrozenUser): Generator<undefined, void> {
    const t0 = performance.now();
    const steps = this.thawSteps(f);
    for (let r = steps.next(); ; r = steps.next()) {
      if (this.users.get(key) !== f) return;
      if (r.done) {
        this.thawed(key, r.value, t0);
        return;
      }
      yield;
    }
  }

  /**
   * Thaws a frozen user into the state they were frozen in (D325): entries in `items` order (so both class lists and
   * the eviction order are as before), docs indexed in their old insertion order (`Entry.seq`), the same revision
   * (what is derived from the items stays valid), tallies, probes and sketches. Vocabulary ids and doc numbers are new,
   * as after `rebuild`: nothing outside holds them across calls. Does not mark the user seen (the caller does).
   */
  private thaw(key: string, f: FrozenUser): UserCache {
    const t0 = performance.now();
    const steps = this.thawSteps(f);
    let r = steps.next();
    while (!r.done) r = steps.next();
    return this.thawed(key, r.value, t0);
  }

  private thawed(key: string, u: UserCache, t0: number): UserCache {
    this.users.set(key, u); // Same key: the user's place in the eviction order is unchanged.
    this.freezes.thawed++;
    this.freezes.thawMs += performance.now() - t0;
    return u;
  }

  /** The work of a thaw, a step per `STEP_ITEMS` entries; returns the thawed user, not yet in `users`. */
  private *thawSteps(f: FrozenUser): Generator<undefined, UserCache> {
    const body = JSON.parse(fromUtf8.decode(Bun.zstdDecompressSync(f.blob))) as FrozenBody;
    yield;
    const u = new UserCache(f.scope, this.limits.releaseTerms);
    u.revision = f.revision;
    u.seen = f.seen;
    u.probes = f.probes;
    u.parties = new Map(body.parties);
    u.partied = body.partied;
    u.offsets = new Map(body.offsets);
    const plain: ContextItem[] = new Array(body.entries.length);
    const entries: Entry[] = new Array(body.entries.length);
    for (let j = 0; j < body.entries.length; j++) {
      const r = body.entries[j]!;
      const item = r.i;
      plain[j] = item;
      const sketch = r.k === undefined ? undefined : r.k && { lo: r.k[0], hi: r.k[1], numbers: r.k[2] };
      const entry: Entry = {
        item: this.limits.packText ? packItem(item) : item,
        fetchedAt: r.f,
        readMark: r.m,
        doc: -1,
        sketch,
        prev: null,
        next: null,
        raw: r.r,
        seq: r.q,
      };
      if (r.s === 1) {
        entry.synced = true;
        u.synced++;
      }
      u.items.set(item.id, entry);
      link(u, entry);
      entries[j] = entry;
      if (j % STEP_ITEMS === STEP_ITEMS - 1) yield;
    }
    // Indexed in their old insertion order, from the plain text (no inflate of what was just packed).
    const order = entries.map((_, j) => j).sort((a, b) => entries[a]!.seq - entries[b]!.seq);
    for (let k = 0; k < order.length; k++) {
      const j = order[k]!;
      const doc = this.index(u, plain[j]!);
      entries[j]!.doc = doc;
      u.byDoc[doc] = entries[j]!;
      if (k % STEP_ITEMS === STEP_ITEMS - 1) yield;
    }
    u.index.settle();
    u.baseline = u.vocab.size;
    return u;
  }

  /** Users held frozen (D325). */
  get frozenCount(): number {
    let n = 0;
    for (const x of this.users.values()) if (x instanceof FrozenUser) n++;
    return n;
  }

  /** A tenant's users held, and how many of them are frozen (D325, D326: the usage report): a walk of every user. */
  tenantStats(tenantId: string): { users: number; frozen: number; items: number } {
    const prefix = `${tenantId}/`;
    let users = 0;
    let frozen = 0;
    let items = 0;
    for (const [key, x] of this.users) {
      if (!key.startsWith(prefix)) continue;
      users++;
      if (x instanceof FrozenUser) {
        frozen++;
        items += x.size;
      } else items += x.items.size;
    }
    return { users, frozen, items };
  }

  /** Sliced jobs queued or running (D325; `pump`): 0 once the timer's freezes and every waited-on thaw are done. */
  get slicedPending(): number {
    return this.urgent.length + this.background.length;
  }

  /** Bytes of every frozen user's blob (D325): for the benches. */
  get frozenBytes(): number {
    let n = 0;
    for (const x of this.users.values()) if (x instanceof FrozenUser) n += x.blob.byteLength;
    return n;
  }

  /** Whether any of the user's items is within its time to live: the newest of a class is, if any of it is. */
  private anyAlive(u: UserCache, now: number): boolean {
    const loose = u.tails[LOOSE];
    const synced = u.tails[SYNCED];
    return (loose !== null && this.alive(loose, now)) || (synced !== null && this.alive(synced, now));
  }

  /** Runs `expireIdle` on the cache's own clock (the last `put`'s `now` moved on by wall time since). */
  tick(): void {
    this.expireIdle(this.lastNow + (Date.now() - this.lastWall), true);
  }

  /** Stops the expiry timer for good (a closing server, a test). The cache still answers; nothing expires on time. */
  close(): void {
    this.closed = true;
    if (this.expiry !== null) clearInterval(this.expiry);
    this.expiry = null;
  }

  forget(scope: Scope, sourceId?: string): void {
    clearDecoded(); // The decode memo may hold their text (`packed-text.ts`).
    if (!sourceId) {
      this.dropUser(scopeKey(scope), scope.tenantId);
      // The user's gone-holds go with them.
      const held = this.holds.get(scope.tenantId);
      if (held) {
        held.forget(scope.userId);
        if (held.size === 0 && held.evicted === 0) this.holds.delete(scope.tenantId);
      }
      return;
    }
    const u = this.peek(scope);
    if (!u) return;
    for (const e of [...u.items.values()]) if (e.item.sourceId === sourceId) this.drop(u, e);
    if (this.limits.releaseTerms) {
      // Compact now: every term no live item holds is released. Then if the vocabulary holds exactly the terms live
      // items do, no term of the source's content is left that a rebuild would remove, and none is needed.
      u.index.flush();
      if (u.vocab.live === u.index.termCount) return;
    }
    this.rebuild(scope, u);
  }

  get userCount(): number {
    return this.users.size;
  }
}

/** Whether the user made a probe at or after `since` (the probes map is least recently made first). */
function probedSince(probes: Map<string, { at: number }>, since: number): boolean {
  let last: { at: number } | undefined;
  for (const p of probes.values()) last = p;
  return last !== undefined && last.at >= since;
}

/** Whether a refreshed copy carries the same details as the one held (its link, its source's time, its metadata). */
function sameDetails(a: ContextItem, b: ContextItem): boolean {
  if (a.url !== b.url || a.updatedAt !== b.updatedAt) return false;
  if (a.meta === b.meta) return true;
  return a.meta !== undefined && b.meta !== undefined && JSON.stringify(a.meta) === JSON.stringify(b.meta);
}

/** The entry's sketch, computed on first use and kept (`Entry.sketch`). */
function sketched(u: UserCache, e: Entry): Sketch | null {
  if (e.sketch === undefined) e.sketch = sketchOf(u, e.item);
  return e.sketch;
}

function sketchOf(u: UserCache, item: ContextItem): Sketch | null {
  const own = dedupText(item.text, 6);
  if (u.sketcher.load(`${item.title}\n${own}`) === 0) return null;
  u.sketcher.simhash(simScratch);
  return { lo: simScratch[0]!, hi: simScratch[1]!, numbers: u.sketcher.numberKey };
}

/**
 * The expiry timer of one cache, which it holds only weakly. `unref` keeps the timer from holding the process open,
 * but a tick closing over the cache would keep a dropped one (labs build one per task, session or loop and close
 * none) resident until exit. A module-level function, so the tick's scope holds nothing of `put`'s (in JSC a closure
 * keeps its whole enclosing scope, `this` included). A collected cache stops its own timer on the next tick.
 */
function expiryTimer(ref: WeakRef<ItemCache>, everyMs: number): ReturnType<typeof setInterval> {
  const id: ReturnType<typeof setInterval> = setInterval(() => {
    const c = ref.deref();
    if (c === undefined) clearInterval(id);
    else c.tick();
  }, everyMs);
  // Never what keeps a process alive: a server's own handles do, and a test or script exits when it is done.
  (id as { unref?: () => void }).unref?.();
  return id;
}
