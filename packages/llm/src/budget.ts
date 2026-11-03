/**
 * The model is the expensive, slow part, so it is rationed. A budget caps calls and spend per session and per user
 * per day; `reserve` reserves before a call and `settle` books what its `Reservation` really cost. When a cap is
 * reached the engine takes its no-model path; it never queues work to spend later.
 */
export interface BudgetLimits {
  callsPerSession: number;
  usdPerSession: number;
  usdPerUserDay: number;
}

export const DEFAULT_LIMITS: BudgetLimits = { callsPerSession: 20, usdPerSession: 0.02, usdPerUserDay: 0.25 };

interface Tally {
  calls: number;
  usd: number;
}

/**
 * One reserved call, from `reserve`, settled with `settle`. It holds the tallies it was charged to, so settling
 * books against the session and the day it was charged in: not a new session that reused the id after this one
 * ended, and not the next day when the call ran past midnight.
 */
export interface Reservation {
  readonly estimateUsd: number;
  readonly session: Tally;
  readonly day: Tally;
  /** The tenant's day it was charged to, when the budget shares a `TenantSpend`. */
  readonly tenantDay?: Tally;
}

/**
 * One cap on a tenant's model spend per UTC day, shared by every `Budget` built with it (the shipped servers give the
 * reader and the card enricher one each, D112), so one tenant's users cannot spend past it whichever role calls. The
 * tenant is the user key's part before its first "/" (`scopeKey` is `tenant/user`; ids never hold a "/"); a key with
 * none is its own tenant.
 */
export class TenantSpend {
  private readonly days = new Map<string, Tally>();
  private prunedDay = "";

  constructor(
    readonly usdPerTenantDay: number,
    private readonly now = () => Date.now(),
  ) {}

  private key(tenant: string): string {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.prunedDay) {
      for (const k of this.days.keys()) if (!k.endsWith(`@${today}`)) this.days.delete(k);
      this.prunedDay = today;
    }
    return `${tenant}@${today}`;
  }

  /** The tally a call of `estimateUsd` for this user key would be charged to, or null past the tenant's cap. */
  tally(user: string, estimateUsd: number): Tally | null {
    const slash = user.indexOf("/");
    const key = this.key(slash < 0 ? user : user.slice(0, slash));
    const t = this.days.get(key) ?? { calls: 0, usd: 0 };
    if (t.usd + estimateUsd > this.usdPerTenantDay) return null;
    this.days.set(key, t);
    return t;
  }

  /** What the tenant spent today (estimates until settled). */
  spent(tenant: string): number {
    return this.days.get(this.key(tenant))?.usd ?? 0;
  }

  /** Tenants tracked today, for leak tests. */
  get size(): number {
    return this.days.size;
  }
}

export class Budget {
  private readonly sessions = new Map<string, Tally>();
  private readonly userDays = new Map<string, Tally>();
  private prunedDay = "";

  constructor(
    readonly limits: BudgetLimits = DEFAULT_LIMITS,
    private readonly now = () => Date.now(),
    private readonly tenants?: TenantSpend,
  ) {}

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private dayKey(user: string) {
    return `${user}@${this.today()}`;
  }

  /** Drops earlier days' tallies once per day, so the map holds only today's users. */
  private prune(): void {
    const today = this.today();
    if (today === this.prunedDay) return;
    for (const key of this.userDays.keys()) if (!key.endsWith(`@${today}`)) this.userDays.delete(key);
    this.prunedDay = today;
  }

  /** Reserves one call of at most `estimateUsd`. Null means: do not call the model. */
  reserve(user: string, session: string, estimateUsd: number): Reservation | null {
    this.prune();
    const dayKey = this.dayKey(user);
    const s = this.sessions.get(session) ?? { calls: 0, usd: 0 };
    const d = this.userDays.get(dayKey) ?? { calls: 0, usd: 0 };
    if (s.calls + 1 > this.limits.callsPerSession) return null;
    if (s.usd + estimateUsd > this.limits.usdPerSession) return null;
    if (d.usd + estimateUsd > this.limits.usdPerUserDay) return null;
    // Last, so a refusal here leaves the session and day tallies untouched.
    const t = this.tenants?.tally(user, estimateUsd);
    if (t === null) return null;
    // Tallies change in place: a reservation keeps a reference to the ones it was charged to.
    s.calls++;
    s.usd += estimateUsd;
    d.calls++;
    d.usd += estimateUsd;
    this.sessions.set(session, s);
    this.userDays.set(dayKey, d);
    if (t) {
      t.calls++;
      t.usd += estimateUsd;
    }
    return { estimateUsd, session: s, day: d, ...(t ? { tenantDay: t } : {}) };
  }

  /** `reserve`, for callers that settle nothing (the estimate stands as the cost). */
  charge(user: string, session: string, estimateUsd: number): boolean {
    return this.reserve(user, session, estimateUsd) !== null;
  }

  /**
   * Replaces a reservation's estimate with the actual cost. A tally no longer tracked (the session ended, the day was
   * pruned) is left alone: it was dropped, and booking into it would change nothing anyone reads.
   */
  settle(r: Reservation, actualUsd: number): void {
    const delta = actualUsd - r.estimateUsd;
    r.session.usd = Math.max(0, r.session.usd + delta);
    r.day.usd = Math.max(0, r.day.usd + delta);
    if (r.tenantDay) r.tenantDay.usd = Math.max(0, r.tenantDay.usd + delta);
  }

  spent(session: string): Tally {
    return { ...(this.sessions.get(session) ?? { calls: 0, usd: 0 }) };
  }

  endSession(session: string): void {
    this.sessions.delete(session);
  }

  /** Tracked sessions and user-days, for leak tests and metrics. */
  get size(): { sessions: number; userDays: number } {
    return { sessions: this.sessions.size, userDays: this.userDays.size };
  }
}
