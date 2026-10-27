/**
 * The model is the expensive, slow part, so it is rationed. A budget caps calls and spend per session and per user
 * per day; `charge` reserves before a call and `settle` books what it really cost. When a cap is reached the engine
 * takes its no-model path; it never queues work to spend later.
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

export class Budget {
  private readonly sessions = new Map<string, Tally>();
  private readonly userDays = new Map<string, Tally>();

  constructor(
    readonly limits: BudgetLimits = DEFAULT_LIMITS,
    private readonly now = () => Date.now(),
  ) {}

  private dayKey(user: string) {
    return `${user}@${new Date(this.now()).toISOString().slice(0, 10)}`;
  }

  /** Reserves one call of at most `estimateUsd`. False means: do not call the model. */
  charge(user: string, session: string, estimateUsd: number): boolean {
    const s = this.sessions.get(session) ?? { calls: 0, usd: 0 };
    const d = this.userDays.get(this.dayKey(user)) ?? { calls: 0, usd: 0 };
    if (s.calls + 1 > this.limits.callsPerSession) return false;
    if (s.usd + estimateUsd > this.limits.usdPerSession) return false;
    if (d.usd + estimateUsd > this.limits.usdPerUserDay) return false;
    this.sessions.set(session, { calls: s.calls + 1, usd: s.usd + estimateUsd });
    this.userDays.set(this.dayKey(user), { calls: d.calls + 1, usd: d.usd + estimateUsd });
    return true;
  }

  /** Replaces a reservation's estimate with the actual cost. */
  settle(user: string, session: string, estimateUsd: number, actualUsd: number): void {
    const delta = actualUsd - estimateUsd;
    for (const [map, key] of [
      [this.sessions, session],
      [this.userDays, this.dayKey(user)],
    ] as const) {
      const t = map.get(key);
      if (t) t.usd = Math.max(0, t.usd + delta);
    }
  }

  spent(session: string): Tally {
    return { ...(this.sessions.get(session) ?? { calls: 0, usd: 0 }) };
  }

  endSession(session: string): void {
    this.sessions.delete(session);
  }
}
