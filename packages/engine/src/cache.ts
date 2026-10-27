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
 * never evicts another's), and item text length. Expired items are swept on write, so they stop shaping idf.
 */
import { createHash } from "node:crypto";
import { SparseIndex, Vocab } from "@eden/primitives";
import { itemId, scopeKey, type ContextItem, type Scope } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import { termIds } from "./text";

interface Entry {
  item: ContextItem;
  fetchedAt: number;
  doc: number;
}

class UserCache {
  readonly items = new Map<string, Entry>();
  readonly byDoc: (Entry | undefined)[] = [];
  readonly vocab = new Vocab(4_096);
  readonly index = new SparseIndex({ fields: 2, weights: [2, 1] });
}

export interface CacheHit {
  item: ContextItem;
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

  /** The user's vocabulary (creating the user's cache if needed): sessions tokenize with it so ids agree. */
  vocabOf(scope: Scope): Vocab {
    return this.touch(scope).vocab;
  }

  /** Adds items, redacting every text field first. Returns the stored (redacted) copies. */
  put(scope: Scope, items: ContextItem[], now = Date.now()): ContextItem[] {
    const u = this.touch(scope);
    this.sweep(u, now);
    const stored = items.map((raw) => {
      const ref = sanitizeForStore(raw.ref);
      const item: ContextItem = {
        ...raw,
        // The id embeds the ref and travels to traces, citations and the ledger. A ref that held a secret gets an id
        // from a hash of the raw ref instead: never the secret, and two refs that redact alike stay distinct.
        id:
          ref === raw.ref
            ? raw.id
            : itemId(raw.sourceId, `h-${createHash("sha256").update(raw.ref).digest("hex").slice(0, 16)}`),
        ref,
        title: sanitizeForStore(raw.title.slice(0, 500)),
        text: sanitizeForStore(raw.text.slice(0, this.limits.maxTextChars)),
        url: raw.url === undefined ? undefined : sanitizeForStore(raw.url),
        meta: raw.meta && Object.fromEntries(Object.entries(raw.meta).map(([k, v]) => [k, sanitizeForStore(v)])),
      };
      const old = u.items.get(item.id);
      if (old) this.drop(u, old);
      const doc = this.index(u, item);
      const entry = { item, fetchedAt: now, doc };
      u.items.set(item.id, entry); // Map order stays oldest-first for eviction (old entry was removed above).
      u.byDoc[doc] = entry;
      return item;
    });
    while (u.items.size > this.limits.maxItemsPerUser) this.drop(u, u.items.values().next().value as Entry);
    return stored;
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
        doc: e.doc,
        score: res.scores[j]!,
        coverage: res.coverage[j]!,
        matched: res.matched[j]!,
      });
    }
    return out;
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
  }

  get userCount(): number {
    return this.users.size;
  }
}
