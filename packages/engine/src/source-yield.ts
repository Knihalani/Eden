/**
 * `sourceYield` (D505, a trial): what each of a user's sources has given back for the live reads made of it. A live
 * read (a search of a copy the cap cut, a probe) is booked against its source when it is sent; an item of the source
 * that reaches the agent (a packet, an ask's answer) clears the source's run. Two rules skip a read, both learned:
 *
 * - **The source's own run.** A source whose run of reads with nothing used is long is not read live again on no
 *   name until the run decays (one half-life halves it), so a source that starts to matter is tried again. A read
 *   for a request that names an entity the source's items mentioned is never skipped by the run.
 * - **The user's reads on weak evidence.** With hundreds of sources a per-source run fills too slowly to matter (a
 *   source is read a few times a week), so the user's reads are pooled by what the request had for the source:
 *   nothing, or only its words. Each pool counts the reads sent to sources with nothing used yet, and how
 *   many of those sources then had their first item reach the agent. While a pool's rate is surely under `floor` (the upper `CONFIDENCE` bound of its Beta
 *   posterior, after `POOL_WARMUP` reads), a source that has never had an item reach the agent is not read on that
 *   kind of evidence. A source that has is exempt, a read on a name the source mentioned is never pooled, and the
 *   pools decay with the same half-life, so such reads resume now and then.
 *
 * Unlike a budget per lookup (D390, deleted), nothing here bounds how many sources a lookup reads: each source earns
 * or loses its own reads. It never adds a call. All state is per user (tenant/user scope key), bounded, held in
 * memory only, content-free (a source id, a count, a time), and dropped with the user or the source (`forget`).
 */
import { scopeKey, type Scope } from "@eden/protocol";
import { betaIncInv } from "@eden/primitives";

/** Reads on no evidence a user must have sent before the pooled rate may skip one. */
export const POOL_WARMUP = 24;
/** The posterior bound the pooled rate must reach the floor at: skipped when 90% sure it is below. */
const CONFIDENCE = 0.9;

/** Sources kept per user, least recently read dropped first (a dropped source starts again: read live). */
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
  /** The pools with a read of the source open: its next use is a win for each (a bit per pool). */
  open: number;
}

/**
 * Reads sent on one kind of evidence to sources with nothing used yet, and how many of those sources then had their
 * first item reach the agent; decayed, as of `at`.
 */
interface Pool {
  reads: number;
  wins: number;
  at: number;
}

interface User {
  sources: Map<string, Run>;
  pools: [Pool, Pool];
}

/**
 * What a request has for a source: nothing (0), its words among the source's held items or in its sketch (1), or a
 * name the source's items mentioned (2). Reads on nothing and reads on words are pooled, each apart; a read on a name
 * is never pooled, so it is never skipped.
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
      const prefix = scopeKey({ tenantId: scope.tenantId, userId: "" });
      for (const k of this.users.keys()) {
        if (!k.startsWith(prefix)) continue;
        this.drop(k, scope.tenantId);
        break;
      }
    }
    if (this.users.size >= MAX_USERS) {
      const oldest = this.users.keys().next().value!;
      this.drop(oldest, this.tenants.get(oldest)!);
    }
    const fresh: User = {
      sources: new Map(),
      pools: [
        { reads: 0, wins: 0, at: 0 },
        { reads: 0, wins: 0, at: 0 },
      ],
    };
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

  /**
   * Whether the user's reads on this kind of evidence (0 nothing, 1 words) are not paying: after `POOL_WARMUP` such
   * reads, the upper bound of the rate at which their sources went on to be used is under `floor`.
   */
  poolSpent(scope: Scope, kind: 0 | 1, floor: number, now: number): boolean {
    const pool = this.user(scope, false)?.pools[kind];
    if (!pool || floor <= 0) return false;
    const reads = this.fade(pool.reads, pool.at, now);
    if (reads < POOL_WARMUP) return false;
    const wins = Math.min(reads, this.fade(pool.wins, pool.at, now));
    return betaIncInv(CONFIDENCE, wins + 1, reads - wins + 1) < floor;
  }

  private bump(pool: Pool, reads: number, wins: number, now: number): void {
    pool.reads = this.fade(pool.reads, pool.at, now) + reads;
    pool.wins = this.fade(pool.wins, pool.at, now) + wins;
    pool.at = now;
  }

  /**
   * Live reads were sent to these sources (once a source a lookup, however many calls it took), each on the evidence
   * the request had for it.
   */
  read(scope: Scope, sourceIds: Iterable<string>, now: number, evidence: (sourceId: string) => Evidence): void {
    let u: User | undefined;
    for (const id of sourceIds) {
      u ??= this.user(scope, true)!;
      const run = u.sources.get(id);
      const kind = evidence(id);
      // The pools are about sources with nothing used yet (the ones they may skip): a read of a source that has
      // earned its place says nothing about them.
      const used = run?.used ?? false;
      if (!used && kind !== 2) this.bump(u.pools[kind], 1, 0, now);
      u.sources.delete(id);
      u.sources.set(id, {
        empty: (run ? this.fade(run.empty, run.at, now) : 0) + 1,
        at: now,
        used,
        open: used || kind === 2 ? (run?.open ?? 0) : (run?.open ?? 0) | (1 << kind),
      });
      if (u.sources.size > MAX_SOURCES) u.sources.delete(u.sources.keys().next().value!);
    }
  }

  /** Items of these sources reached the agent: their runs end. */
  used(scope: Scope, sourceIds: Iterable<string>, now: number): void {
    let u: User | undefined;
    for (const id of sourceIds) {
      u ??= this.user(scope, true)!;
      const open = u.sources.get(id)?.open ?? 0;
      for (const kind of [0, 1] as const) if (open & (1 << kind)) this.bump(u.pools[kind], 0, 1, now);
      u.sources.delete(id);
      u.sources.set(id, { empty: 0, at: now, used: true, open: 0 });
      if (u.sources.size > MAX_SOURCES) u.sources.delete(u.sources.keys().next().value!);
    }
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
