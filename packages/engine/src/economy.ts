/**
 * The probe economy: what each user's probes have been bringing back, learned per user with no model, and used to
 * decide which probe calls are worth making (docs/research/probe-economy.md). Two questions, two estimates:
 *
 * - **Has the answer changed?** (`probeFresh`). A probe is a query to one source ("Rose Kimura" to the mail). Its
 *   answer changes as new mail, events and documents arrive, at a rate that differs by person and source: a
 *   colleague who writes daily, a dentist who writes twice a year. Each (query, source) keeps the times it was asked
 *   and whether its answer had changed since the time before (a new item, or an item's text changed); its change rate
 *   is the Gamma–Poisson posterior mean, shrunk toward the user's own rate over all their probes (empirical Bayes:
 *   a query asked once borrows the user's typical rate). The chance its answer changed since it was last asked is
 *   1 − e^(−λ·Δt); below `probeFreshFloor` the call is not made, and the answer it gave last time, still cached, is
 *   used in its place (its items keep their seats with the judge). This is a web crawler's revisit policy (Cho &
 *   Garcia-Molina 2003), applied per person per source: time-based and unit-free, it learns in whatever time scale the
 *   user's own traffic runs in.
 * - **Is this kind of probe worth a call to this source?** (`probeYield`). An arm is a probe kind (first person,
 *   second person, organisation, topic, role, day listing) at one source. A live call is a hit when an item it
 *   brought new to the user's cache, and the lookup's own search did not return, is seated with the judge or
 *   delivered, in that lookup or any later one (a probe's find often pays off turns later, from the cache): each call
 *   is booked a miss when made and turned into a hit when one of its finds first reaches. The call is made while the
 *   arm's yield could still plausibly be worth it: the upper `YIELD_CONFIDENCE` bound of its Beta posterior (prior:
 *   the user's pooled yield for that kind) is at least `probeYieldFloor`. A bound, not a draw: missing a fact costs
 *   far more than a wasted call, so an arm is dropped only on evidence (a draw dropped useful arms after a few misses
 *   and lost recall in the simulation). An arm is always called for its first `YIELD_WARMUP` calls; evidence decays
 *   (γ per call, and per skip of a dropped arm), so a dropped arm's bound rises back over the floor and it is tried
 *   again: a source that starts to matter is found.
 *
 * Neither ever adds a call: they only skip calls the probes would have made. All state is per user (tenant/user
 * scope key), bounded, and dropped with the user (`forget`). Nothing here reads item text beyond a hash of it.
 */
import { scopeKey, type ContextItem, type Scope } from "@eden/protocol";
import { betaIncInv, hashString } from "@eden/primitives";

/** What a probe asks for: a request's first or second person, an organisation, its topic, a role, a day's listing. */
export type ProbeKind = "person" | "second" | "org" | "topic" | "role" | "day";

/** Re-asks a user's probes must have answered, with and without a change, before any is skipped as unchanged. */
export const FRESH_WARMUP = 6;
/** Observations of an arm before the yield gate may skip it. */
export const YIELD_WARMUP = 4;
/** Per-call discount of an arm's evidence (memory ≈ 1 / (1 − γ) ≈ 100 calls). */
const YIELD_GAMMA = 0.99;
/** The posterior bound an arm's yield must reach the floor at: dropped when 90% sure it is below. */
const YIELD_CONFIDENCE = 0.9;
/** Per-skip discount of a dropped arm's evidence: tried again after some tens of skips, not every few. */
const YIELD_SKIP_GAMMA = 0.99;
/** Strength (pseudo-observations) of the user's pooled rate as an arm's prior. */
const YIELD_PRIOR = 2;
/** Pseudo-changes of the user's pooled rate as a query's prior (its prior weighs as much as one change). */
const FRESH_PRIOR = 1;
/** Queries and arms kept per user, least recently used dropped first; users kept, least recently used dropped. */
const MAX_QUERIES = 512;
const MAX_ARMS = 128;
const MAX_FINDS = 2_048;
const MAX_USERS = 10_000;

interface Asked {
  /** Hashes of the items (id, title, text) the query's last answer held. */
  prints: Set<number>;
  ids: string[];
  /** When it was last asked live. */
  at: number;
  /** Re-asks answered, and how many of them had changed; total time between re-asks (ms). */
  n: number;
  changed: number;
  exposure: number;
}

/** A probe call's finds, open until one of them reaches the judge or is delivered. */
interface Find {
  arm: string;
  kind: ProbeKind;
  open: boolean;
}

interface Arm {
  a: number;
  b: number;
  n: number;
}

class UserEconomy {
  readonly asked = new Map<string, Asked>();
  /** Pooled over every query of the user: re-asks, changes, exposure. */
  n = 0;
  changed = 0;
  exposure = 0;
  readonly arms = new Map<string, Arm>();
  /** Pooled per probe kind: discounted rewards and misses. */
  readonly kinds = new Map<ProbeKind, { a: number; b: number }>();
  /** Item id -> the probe call that first brought it into the cache. */
  readonly finds = new Map<string, Find>();
}

/** A query's key at one source: the source first, so a source's keys can be dropped with it. */
const queryKey = (sourceId: string, query: string) => `${sourceId}\u0000${query}`;
const armKey = (kind: ProbeKind, sourceId: string) => `${sourceId}\u0000${kind}`;
const printOf = (item: ContextItem) => hashString(`${item.id}\n${item.title}\n${item.text}`, 0x9e3779b9);

export class ProbeEconomy {
  private readonly users = new Map<string, UserEconomy>();

  private user(scope: Scope, create: true): UserEconomy;
  private user(scope: Scope, create: false): UserEconomy | undefined;
  private user(scope: Scope, create: boolean): UserEconomy | undefined {
    const key = scopeKey(scope);
    const u = this.users.get(key);
    if (u) {
      this.users.delete(key); // Re-insert: Map order is least recently used first.
      this.users.set(key, u);
      return u;
    }
    if (!create) return undefined;
    const made = new UserEconomy();
    this.users.set(key, made);
    if (this.users.size > MAX_USERS) this.users.delete(this.users.keys().next().value!);
    return made;
  }

  /**
   * The chance a query's answer at a source changed since it was last asked live, from its own record and the
   * user's: 1 while either is too new to say (`FRESH_WARMUP`) or the query was never asked.
   */
  changeChance(scope: Scope, sourceId: string, query: string, now: number): number {
    const u = this.user(scope, false);
    const q = u?.asked.get(queryKey(sourceId, query));
    if (!u || !q || u.n < FRESH_WARMUP || u.exposure <= 0) return 1;
    // The user's pooled rate is the prior (FRESH_PRIOR pseudo-changes over the exposure that rate implies); the
    // query's own re-asks move it. Half a change is added to the user's count (Jeffreys): no change seen yet is a low
    // rate, not a zero one.
    const pooled = (u.changed + 0.5) / u.exposure;
    const rate = (q.changed + FRESH_PRIOR) / (q.exposure + FRESH_PRIOR / pooled);
    return 1 - Math.exp(-rate * Math.max(0, now - q.at));
  }

  /** The ids a query's last live answer at a source held (to stand in for a call skipped as unchanged). */
  lastIds(scope: Scope, sourceId: string, query: string): string[] | null {
    return this.user(scope, false)?.asked.get(queryKey(sourceId, query))?.ids ?? null;
  }

  /**
   * Records a live answer to a query at a source: whether it changed since the last (an item the last did not hold,
   * or held with other text) teaches the query's and the user's change rates.
   */
  answered(scope: Scope, sourceId: string, query: string, items: ContextItem[], now: number): void {
    const u = this.user(scope, true);
    const key = queryKey(sourceId, query);
    const before = u.asked.get(key);
    const prints = new Set(items.map(printOf));
    if (before) {
      const dt = Math.max(0, now - before.at);
      let changed = 0;
      for (const p of prints) if (!before.prints.has(p)) changed = 1;
      before.n++;
      before.changed += changed;
      before.exposure += dt;
      u.n++;
      u.changed += changed;
      u.exposure += dt;
      before.prints = prints;
      before.ids = items.map((i) => i.id);
      before.at = now;
      u.asked.delete(key);
      u.asked.set(key, before);
    } else {
      u.asked.set(key, { prints, ids: items.map((i) => i.id), at: now, n: 0, changed: 0, exposure: 0 });
      if (u.asked.size > MAX_QUERIES) u.asked.delete(u.asked.keys().next().value!);
    }
  }

  /**
   * Whether a probe of this kind is worth a call to this source for the user: the upper `YIELD_CONFIDENCE` bound of
   * the arm's posterior (prior: the user's pooled yield for the kind) is at least `floor`. Always while the arm is
   * new. A skip discounts the arm's evidence, so it is tried again after a while.
   */
  worth(scope: Scope, kind: ProbeKind, sourceId: string, floor: number): boolean {
    const u = this.user(scope, false);
    const arm = u?.arms.get(armKey(kind, sourceId));
    if (!u || !arm || arm.n < YIELD_WARMUP) return true;
    const pool = u.kinds.get(kind) ?? { a: 0, b: 0 };
    const mean = (pool.a + 1) / (pool.a + pool.b + 2);
    if (betaIncInv(YIELD_CONFIDENCE, arm.a + YIELD_PRIOR * mean, arm.b + YIELD_PRIOR * (1 - mean)) >= floor)
      return true;
    arm.a *= YIELD_SKIP_GAMMA;
    arm.b *= YIELD_SKIP_GAMMA;
    return false;
  }

  /**
   * A live probe call of this kind to this source: counted a miss now, and turned into a hit when one of the items it
   * brought new to the user's cache (`fresh`) reaches the judge or is delivered (`reached`), in this lookup or a later
   * one: a probe's find often pays off turns later, from the cache.
   */
  called(scope: Scope, kind: ProbeKind, sourceId: string, fresh: readonly string[]): void {
    const u = this.user(scope, true);
    const key = armKey(kind, sourceId);
    const arm = u.arms.get(key) ?? { a: 0, b: 0, n: 0 };
    u.arms.delete(key); // Re-insert: least recently used first.
    u.arms.set(key, arm);
    if (u.arms.size > MAX_ARMS) u.arms.delete(u.arms.keys().next().value!);
    arm.a *= YIELD_GAMMA;
    arm.b = arm.b * YIELD_GAMMA + 1;
    arm.n++;
    const pool = u.kinds.get(kind) ?? { a: 0, b: 0 };
    pool.a *= YIELD_GAMMA;
    pool.b = pool.b * YIELD_GAMMA + 1;
    u.kinds.set(kind, pool);
    const find: Find = { arm: key, kind, open: true };
    for (const id of fresh) {
      u.finds.delete(id);
      u.finds.set(id, find);
      if (u.finds.size > MAX_FINDS) u.finds.delete(u.finds.keys().next().value!);
    }
  }

  /** Items that reached the judge or were delivered: each probe call that first brought one of them was a hit. */
  reached(scope: Scope, ids: Iterable<string>): void {
    const u = this.user(scope, false);
    if (!u) return;
    for (const id of ids) {
      const find = u.finds.get(id);
      if (!find?.open) continue;
      find.open = false; // One hit per call, however many of its finds reach.
      const arm = u.arms.get(find.arm);
      if (arm) {
        arm.a += 1;
        arm.b = Math.max(0, arm.b - 1);
      }
      const pool = u.kinds.get(find.kind);
      if (pool) {
        pool.a += 1;
        pool.b = Math.max(0, pool.b - 1);
      }
    }
  }

  /** Items the lookup's own search returned too: not the probes' contribution, so never their hit. */
  claimed(scope: Scope, ids: Iterable<string>): void {
    const u = this.user(scope, false);
    if (!u) return;
    for (const id of ids) {
      const find = u.finds.get(id);
      if (find) find.open = false;
    }
  }

  /** Drops what was learned for a user, or only for one of their sources. */
  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    if (!sourceId) {
      this.users.delete(key);
      return;
    }
    const u = this.users.get(key);
    if (!u) return;
    const prefix = `${sourceId}\u0000`;
    for (const k of [...u.asked.keys()]) if (k.startsWith(prefix)) u.asked.delete(k);
    for (const k of [...u.arms.keys()]) if (k.startsWith(prefix)) u.arms.delete(k);
    for (const [id, find] of [...u.finds]) if (find.arm.startsWith(prefix)) u.finds.delete(id);
  }

  get userCount(): number {
    return this.users.size;
  }
}
