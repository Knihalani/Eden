/**
 * The per-user item cache: what sources returned recently, redacted, indexed for the fast path. It lives in memory
 * only. Content is never written to disk by default (docs/PRIVACY.md), so a restart costs warm-up, not a leak.
 *
 * Bounded three ways: items per user (oldest evicted), users held (least recently used dropped), and item text
 * length. Expired items are swept on write, so they stop shaping the index's idf.
 */
import { scopeKey, type ContextItem, type Scope } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import { Bm25Index, type Hit } from "./bm25";

interface Entry {
  item: ContextItem;
  fetchedAt: number;
}

class UserCache {
  readonly items = new Map<string, Entry>();
  readonly index = new Bm25Index();
}

export interface CacheLimits {
  maxItemsPerUser: number;
  maxUsers: number;
  ttlMs: number;
  maxTextChars: number;
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  maxItemsPerUser: 2_000,
  maxUsers: 10_000,
  ttlMs: 24 * 3_600_000,
  maxTextChars: 8_000,
};

export class ItemCache {
  private readonly users = new Map<string, UserCache>();
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
    let u = this.users.get(key);
    if (u)
      this.users.delete(key); // Re-insert: Map order is least recently written first.
    else u = new UserCache();
    this.users.set(key, u);
    while (this.users.size > this.limits.maxUsers) this.users.delete(this.users.keys().next().value as string);
    return u;
  }

  /** Adds items, redacting every text field first. Returns the stored (redacted) copies. */
  put(scope: Scope, items: ContextItem[], now = Date.now()): ContextItem[] {
    const u = this.touch(scope);
    this.sweep(u, now);
    const stored = items.map((raw) => {
      const item: ContextItem = {
        ...raw,
        ref: sanitizeForStore(raw.ref),
        title: sanitizeForStore(raw.title.slice(0, 500)),
        text: sanitizeForStore(raw.text.slice(0, this.limits.maxTextChars)),
        url: raw.url === undefined ? undefined : sanitizeForStore(raw.url),
        meta: raw.meta && Object.fromEntries(Object.entries(raw.meta).map(([k, v]) => [k, sanitizeForStore(v)])),
      };
      u.items.delete(item.id); // Re-insert so Map order stays oldest-first for eviction.
      u.items.set(item.id, { item, fetchedAt: now });
      u.index.add(item.id, `${item.title} ${item.title} ${item.text}`);
      return item;
    });
    while (u.items.size > this.limits.maxItemsPerUser) this.drop(u, u.items.keys().next().value as string);
    return stored;
  }

  /** Removes expired items. Map order is oldest-first, so the scan stops at the first fresh one. */
  private sweep(u: UserCache, now: number): void {
    for (const [id, e] of u.items) {
      if (now - e.fetchedAt <= this.limits.ttlMs) break;
      this.drop(u, id);
    }
  }

  private drop(u: UserCache, id: string): void {
    u.items.delete(id);
    u.index.remove(id);
  }

  get(scope: Scope, id: string, now = Date.now()): ContextItem | null {
    const e = this.peek(scope)?.items.get(id);
    return e && now - e.fetchedAt <= this.limits.ttlMs ? e.item : null;
  }

  search(scope: Scope, query: string, limit: number, now = Date.now()): (Hit & { item: ContextItem })[] {
    const u = this.peek(scope);
    if (!u) return [];
    const out: (Hit & { item: ContextItem })[] = [];
    for (const hit of u.index.search(query, limit * 2)) {
      const item = this.get(scope, hit.id, now);
      if (item) out.push({ ...hit, item });
      if (out.length === limit) break;
    }
    return out;
  }

  forget(scope: Scope, sourceId?: string): void {
    if (!sourceId) {
      this.users.delete(scopeKey(scope));
      return;
    }
    const u = this.peek(scope);
    if (!u) return;
    for (const [id, e] of u.items) if (e.item.sourceId === sourceId) this.drop(u, id);
  }

  get userCount(): number {
    return this.users.size;
  }
}
