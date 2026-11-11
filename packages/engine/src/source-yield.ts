/**
 * `sourceYield` (D505, on in the default since D509; the earn rule since D603): what each of a user's sources has
 * given back for the live reads made of it. A live read (a search of a copy the cap cut, a probe) is booked
 * against its source when the connector answers it, once a turn; an item of the source that reaches the agent (a
 * packet, an ask's answer) clears the source's run and marks the source used. The partner's `spentSources` skips a
 * read by two rules:
 *
 * - **The source's own run.** A source whose run of reads with nothing used is long is not read live again on weak
 *   evidence until the run decays (one half-life halves it), so a source that starts to matter is tried again.
 * - **A source earns its reads on weak evidence** (`sourceYieldEarn`, D600, D603). A source with nothing ever used
 *   is read live only on strong evidence: a name its items mentioned, or a word few of the user's sources hold. The
 *   pooled rates this replaced (per user, reads on no evidence and on words alone, D505) started flat, so every
 *   new user paid about 44 reads a pool before they acted, and a look-alike listed in an ask kept one open; their
 *   code is in commit 5861a56d.
 *
 * Unlike a budget per lookup (D390, deleted), nothing here bounds how many sources a lookup reads: each source earns
 * or loses its own reads. It never adds a call. All state is per user (tenant/user scope key), bounded, held in
 * memory only, content-free (a source id, a count, a time), and dropped with the user or the source (`forget`).
 */
import { scopeKey, type Scope } from "@eden/protocol";

/**
 * Sources kept per user, least recently read dropped first. A dropped source starts again with nothing used, as
 * every source does after a restart (this state is in memory only): read live on strong evidence until an item of
 * it reaches the agent, the state every new user starts in.
 */
const MAX_SOURCES = 4_096;
/** Users kept per tenant and in all, least recently used dropped first (as `ProbeEconomy`). */
const MAX_USERS_PER_TENANT = 1_000;
const MAX_USERS = 10_000;

interface Run {
  /** Live reads since an item of the source last reached the agent, as of `at` (it decays after). */
  empty: number;
  at: number;
  /** An item of the source has reached the agent. */
  used: boolean;
}

interface User {
  sources: Map<string, Run>;
}

/**
 * What a request has for a source: nothing (0), its words among the source's held items or in its sketch (1), or
 * strong evidence (2): a name the source's items mentioned, or a word few of the user's sources hold. A read on
 * strong evidence is never skipped.
 */
export type Evidence = 0 | 1 | 2;

export class SourceYield {
  private readonly users = new Map<string, User>();
  private readonly perTenant = new Map<string, number>();

  constructor(private readonly halfLifeMs: number) {}

  private user(scope: Scope, make: boolean): User | undefined {
    const key = scopeKey(scope);
    const held = this.users.get(key);
    if (held) {
      // Most recently used last.
      this.users.delete(key);
      this.users.set(key, held);
      return held;
    }
    if (!make) return undefined;
    if ((this.perTenant.get(scope.tenantId) ?? 0) >= MAX_USERS_PER_TENANT) {
      for (const k of this.users.keys()) {
        if (this.tenants.get(k) !== scope.tenantId) continue;
        this.drop(k, scope.tenantId);
        break;
      }
    }
    if (this.users.size >= MAX_USERS) {
      const oldest = this.users.keys().next().value!;
      this.drop(oldest, this.tenants.get(oldest)!);
    }
    const fresh: User = { sources: new Map() };
    this.users.set(key, fresh);
    this.tenants.set(key, scope.tenantId);
    this.perTenant.set(scope.tenantId, (this.perTenant.get(scope.tenantId) ?? 0) + 1);
    return fresh;
  }

  /** The tenant of each held user key, for the per-tenant count when the oldest user of all is dropped. */
  private readonly tenants = new Map<string, string>();

  private drop(key: string, tenantId: string): void {
    if (!this.users.delete(key)) return;
    this.tenants.delete(key);
    const left = (this.perTenant.get(tenantId) ?? 1) - 1;
    if (left > 0) this.perTenant.set(tenantId, left);
    else this.perTenant.delete(tenantId);
  }

  private fade(n: number, since: number, now: number): number {
    const age = Math.max(0, now - since);
    return this.halfLifeMs > 0 ? n * 0.5 ** (age / this.halfLifeMs) : n;
  }

  /** The source's run of live reads with nothing used, decayed to `now` (0 for a source never read). */
  run(scope: Scope, sourceId: string, now: number): number {
    const run = this.user(scope, false)?.sources.get(sourceId);
    return run ? this.fade(run.empty, run.at, now) : 0;
  }

  /** Whether an item of the source has reached the agent (while its record is held). */
  hasYielded(scope: Scope, sourceId: string): boolean {
    return this.user(scope, false)?.sources.get(sourceId)?.used === true;
  }

  /** Live reads were sent to these sources (once a source a lookup, however many calls it took). */
  read(scope: Scope, sourceIds: Iterable<string>, now: number): void {
    let u: User | undefined;
    for (const id of sourceIds) {
      u ??= this.user(scope, true)!;
      const run = u.sources.get(id);
      u.sources.delete(id);
      u.sources.set(id, {
        empty: (run ? this.fade(run.empty, run.at, now) : 0) + 1,
        at: now,
        used: run?.used ?? false,
      });
      if (u.sources.size > MAX_SOURCES) u.sources.delete(u.sources.keys().next().value!);
    }
  }

  /** Items of these sources reached the agent: their runs end. */
  used(scope: Scope, sourceIds: Iterable<string>, now: number): void {
    let u: User | undefined;
    for (const id of sourceIds) {
      u ??= this.user(scope, true)!;
      u.sources.delete(id);
      u.sources.set(id, { empty: 0, at: now, used: true });
      if (u.sources.size > MAX_SOURCES) u.sources.delete(u.sources.keys().next().value!);
    }
  }

  /**
   * `routerGate` (M8): one user's runs and uses, read many times in one lookup with one user lookup (the router reads
   * every source of a user with 1,000 connectors). The returned function writes `used` (1 or 0) and the decayed run
   * into `out[at]` and `out[at + 1]`; a source with no record reads as never read and never used.
   */
  view(scope: Scope, now: number): (sourceId: string, out: Float64Array, at: number) => void {
    const held = this.user(scope, false)?.sources;
    return (id, out, at) => {
      const r = held?.get(id);
      out[at] = r?.used ? 1 : 0;
      out[at + 1] = r ? this.fade(r.empty, r.at, now) : 0;
    };
  }

  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    if (sourceId === undefined) this.drop(key, scope.tenantId);
    else this.users.get(key)?.sources.delete(sourceId);
  }

  /** Sources with a record held for the user (tests, the lab's report). */
  size(scope: Scope): number {
    return this.users.get(scopeKey(scope))?.sources.size ?? 0;
  }
}
