/**
 * When the push check's rule sheet carries its 1-hour cache breakpoint (D1800, amending D1197): only when caching it
 * is likely to pay for that user. The bytes the model reads are the same either way; only the provider's price moves.
 *
 * The cost model (Anthropic's prices, as a multiple of the sheet's plain input price): sent plain, a check pays 1.0;
 * marked, it pays 2.0 when it writes (the hour's TTL) and 0.1 when it reads. So a write costs +1.0 over plain and each
 * read saves 0.9: a write pays when the reads it earns exceed 1/0.9, about 1.1. A read happens when the next check
 * comes within the hour with the same sheet (a read or a write refreshes the hour), so with `p` the chance of that, a
 * write earns p + p^2 + ... = p / (1 - p) reads, and pays for p above about 0.53 (D1197's break-even hit rate).
 *
 * The rule, per user:
 * - The sheet the user last sent marked, unchanged and within the hour, is in the provider's cache: mark it (a read
 *   at 0.1, never dearer than plain).
 * - Otherwise marking it is a write. Mark it only when `reuse`, the share of the user's recent checks that came within
 *   the hour of the one before with the same sheet (what always marking would have read), is at least
 *   `SHEET_REUSE_MARK`. A new user starts plain: one who checks rarely never pays the write.
 * `reuse` is a plain mean over a user's first 32 checks, then a moving average with a weight of 1/32 (about two days of
 * a heavy user's checks): `packages/sim/lab/f7/sheet-adaptive.ts` swept the weight and the bar and priced the rule
 * against always and never marking (docs/COST-MODEL.md, "The sheet's breakpoint").
 *
 * Wall clock, never the engine's: the provider's cache lives in real time. The state is keyed by tenant/user, bounded
 * (`SHEET_CACHE_USERS`, least recently checked dropped first) and dropped on `forget`; it holds a hash of the sheet,
 * never its text.
 */

/** The sheet's cache TTL (D1197: Anthropic's 1 hour). */
export const SHEET_TTL_MS = 60 * 60_000;
/**
 * A check counts as within the hour only this far inside it: one right at the edge may find the entry gone (the
 * provider's clock and ours differ by the call's own time).
 */
const TTL_MARGIN_MS = 60_000;
/** The weight of the newest check in `reuse` once a user has 1/weight of them (a plain mean before). */
export const SHEET_REUSE_WEIGHT = 1 / 32;
/** The `reuse` a write needs: p / (1 - p) reads at 0.9 saved each pay for a write's +1.0 from p = 0.53. */
export const SHEET_REUSE_MARK = 0.55;
/**
 * Users whose sheet state is held: 232 bytes each measured (35-character keys, `bun:jsc` heap after a full GC,
 * three runs), so about 11.6 MB at the cap.
 */
export const SHEET_CACHE_USERS = 50_000;

interface SheetState {
  /** When the user's last check was sent, and the hash of its sheet. */
  at: number;
  hash: string;
  /** Whether that check sent the sheet marked (so it was written or read, and its hour runs from `at`). */
  marked: boolean;
  /** The share of checks that came within the hour of the one before with the same sheet (see the file's head). */
  reuse: number;
  /** Checks counted in `reuse`, capped at 1/weight. */
  seen: number;
}

export class SheetCachePolicy {
  private readonly users = new Map<string, SheetState>();

  constructor(
    private readonly limit = SHEET_CACHE_USERS,
    /** The lab's sweep only (`sheet-adaptive.ts`); the engine uses the defaults. */
    private readonly weight = SHEET_REUSE_WEIGHT,
    private readonly threshold = SHEET_REUSE_MARK,
  ) {}

  /** Whether a check sent at `now` with a sheet of `hash` should mark the sheet (see the file's head). */
  mark(user: string, hash: string, now: number): boolean {
    const st = this.users.get(user);
    if (!st) return false;
    if (st.marked && reuses(st, hash, now)) return true;
    return st.seen > 0 && st.reuse >= this.threshold;
  }

  /** Records a check that was answered: when it was sent, its sheet, and whether it marked the sheet. */
  note(user: string, hash: string, now: number, marked: boolean): void {
    const st = this.users.get(user);
    let reuse = 0;
    let seen = 0;
    if (st) {
      seen = Math.min(st.seen + 1, 1 / this.weight);
      reuse = st.reuse + (reuses(st, hash, now) - st.reuse) / seen;
    }
    // Re-inserted, so the map's order is least recently checked first, for the cap.
    this.users.delete(user);
    this.users.set(user, { at: now, hash, marked, reuse, seen });
    while (this.users.size > this.limit) this.users.delete(this.users.keys().next().value as string);
  }

  forget(user: string): void {
    this.users.delete(user);
  }

  get size(): number {
    return this.users.size;
  }
}

/** Whether a check of `hash` at `now` comes within the hour of the user's last, with the same sheet. */
function reuses(st: SheetState, hash: string, now: number): 0 | 1 {
  return st.hash === hash && now - st.at >= 0 && now - st.at <= SHEET_TTL_MS - TTL_MARGIN_MS ? 1 : 0;
}

/** The fixed instructions' cache TTL when no hour-asking sheet follows them: five minutes, or the hour (D1800). */
export const SYSTEM_TTL_FIVE_MS = 5 * 60_000;
/** Tenants whose check timing `SystemTtlPolicy` holds: 168 bytes each measured, so about 1.7 MB at the cap. */
export const SYSTEM_TTL_TENANTS = 10_000;

/**
 * The TTL of the push check's fixed instructions (`CHECK_SYSTEM`) when the sheet after them goes plain (D1800). A
 * marked sheet asks the hour, which carries the instructions with it (Anthropic wants a longer TTL first); a plain
 * one leaves them free. They are the same bytes for every user, so what decides is how far apart checks come, not
 * one user's: at a gap g between checks, the hour costs 0.1 if g is within it and 2.0 (a write) if not, five minutes
 * 0.1 within five minutes and 1.25 if not. `cost` is the running mean of (hour - five) over the gaps seen (a plain mean
 * over the first 32, then a weight of 1/32, as `SheetCachePolicy`); the hour is asked while it is below 0.
 *
 * Kept per tenant, not per process: a timing average across tenants would be state one tenant's traffic moves for
 * another's (D9), and a tenant's own checks are the conservative view of the provider's entry, which every tenant's
 * checks keep warm. Holds a time and two numbers a tenant (no user, no content), at most `SYSTEM_TTL_TENANTS`.
 *
 * No third choice of no breakpoint at all (D1810, rejected): a tenant whose own checks are hours apart cannot tell a
 * quiet box from one another tenant keeps warm, and there a plain request pays 1.0 for what five minutes reads at 0.1.
 */
export class SystemTtlPolicy {
  private readonly tenants = new Map<string, { at: number; cost: number; seen: number }>();

  constructor(
    private readonly limit = SYSTEM_TTL_TENANTS,
    private readonly weight = SHEET_REUSE_WEIGHT,
  ) {}

  /** Whether a check sent at `now` with a plain sheet (or none) should ask the hour for the instructions. */
  hour(tenant: string, _now: number): boolean {
    const st = this.tenants.get(tenant);
    return st !== undefined && st.seen > 0 && st.cost < 0;
  }

  /** Records a check sent at `now` (every check, with a sheet or without). */
  note(tenant: string, now: number): void {
    const st = this.tenants.get(tenant);
    let cost = 0;
    let seen = 0;
    if (st) {
      const gap = now - st.at;
      const hour = gap >= 0 && gap <= SHEET_TTL_MS - TTL_MARGIN_MS ? 0.1 : 2.0;
      const five = gap >= 0 && gap <= SYSTEM_TTL_FIVE_MS - TTL_MARGIN_MS ? 0.1 : 1.25;
      seen = Math.min(st.seen + 1, 1 / this.weight);
      cost = st.cost + (hour - five - st.cost) / seen;
    }
    this.tenants.delete(tenant);
    this.tenants.set(tenant, { at: now, cost, seen });
    while (this.tenants.size > this.limit) this.tenants.delete(this.tenants.keys().next().value as string);
  }

  get size(): number {
    return this.tenants.size;
  }
}
