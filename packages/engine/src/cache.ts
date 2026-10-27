/**
 * The per-user item cache: what sources returned recently, redacted, indexed for the fast path. It lives in memory
 * only. Content is never written to disk by default (docs/PRIVACY.md), so a restart costs warm-up, not a leak.
 *
 * Bounded three ways: items per user (oldest evicted), users held (least recently used dropped), and item text
 * length. Expired items are swept on write, so they stop shaping the index's idf.
 */
import { createHash } from "node:crypto";
import { itemId, scopeKey, type ContextItem, type Scope } from "@eden/protocol";
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
      this.dropUser(scopeKey(scope), scope.tenantId);
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
