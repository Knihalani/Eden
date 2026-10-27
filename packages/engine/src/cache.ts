/**
 * The per-user item cache: what sources returned recently, redacted, indexed for the fast path. It lives in memory
 * only. Content is never written to disk by default (docs/PRIVACY.md), so a restart costs warm-up, not a leak.
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

export class ItemCache {
  private readonly users = new Map<string, UserCache>();

  constructor(
    private readonly maxItemsPerUser = 2_000,
    private readonly ttlMs = 24 * 3_600_000,
  ) {}

  private user(scope: Scope): UserCache {
    const key = scopeKey(scope);
    let u = this.users.get(key);
    if (!u) this.users.set(key, (u = new UserCache()));
    return u;
  }

  /** Adds items, redacting their text first. Returns the stored (redacted) copies. */
  put(scope: Scope, items: ContextItem[], now = Date.now()): ContextItem[] {
    const u = this.user(scope);
    const stored = items.map((raw) => {
      const item = { ...raw, title: sanitizeForStore(raw.title), text: sanitizeForStore(raw.text) };
      u.items.delete(item.id); // Re-insert so Map order stays oldest-first for eviction.
      u.items.set(item.id, { item, fetchedAt: now });
      u.index.add(item.id, `${item.title} ${item.title} ${item.text}`);
      return item;
    });
    while (u.items.size > this.maxItemsPerUser) {
      const oldest = u.items.keys().next().value as string;
      u.items.delete(oldest);
      u.index.remove(oldest);
    }
    return stored;
  }

  get(scope: Scope, id: string, now = Date.now()): ContextItem | null {
    const e = this.user(scope).items.get(id);
    return e && now - e.fetchedAt <= this.ttlMs ? e.item : null;
  }

  search(scope: Scope, query: string, limit: number, now = Date.now()): (Hit & { item: ContextItem })[] {
    const u = this.user(scope);
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
    const u = this.user(scope);
    for (const [id, e] of u.items) {
      if (e.item.sourceId === sourceId) {
        u.items.delete(id);
        u.index.remove(id);
      }
    }
  }
}
