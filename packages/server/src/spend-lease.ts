/**
 * Per-tenant spend caps that hold across router children without dividing them (trial `EDEN_SPEND_LEASES`, D327).
 *
 * Without leases each of N children holds 1/N of the tenant's daily cap (D163): together they never pass it, but a
 * tenant whose traffic lands on one child (one busy user, or a few) is held to cap/N. With leases the router keeps
 * one ledger per tenant and UTC day (`SpendLedger`) and grants each child its spend in chunks (`LeasedSpend`):
 *
 * - every child may spend `start` = cap/(4N) of a tenant's day before hearing from the router, so a tenant's first
 *   model call never waits on IPC; the ledger counts those N starts from the first lease of the day (cap/4 in all);
 * - a child asks for another chunk of cap/(4N) once less than half a chunk is left of what it holds; the router
 *   grants what the ledger has left, up to the chunk; a child out of grant takes the no-model path (D41), as at a cap;
 * - so what all children may spend in a tenant's day is at most the cap, and one child alone can reach the cap less
 *   the others' unused starts (at least 3/4 of it), instead of 1/N.
 *
 * Caveats, all bounded and conservative except the first: a child that restarts mid-day starts again with its
 * `start` the ledger already counted (at most cap/(4N) more per restart; restarts are rare and logged); grants a
 * child held when it exited stay counted (never returned); a child whose IPC is gone keeps its grant and asks no
 * more. Content-free: tenants, days and dollar amounts only.
 */
import { TenantSpend } from "@eden/llm";

/** What a child sends the router (`process.send`) and the router answers. */
export interface LeaseRequest {
  edenLease: { tenant: string; day: string; want: number };
}
export interface LeaseGrant {
  edenGrant: { tenant: string; day: string; usd: number };
}

/** The share of the cap each child holds at the start of a tenant's day, and each chunk: cap / (CHUNKS × N). */
const CHUNKS = 4;

export function leaseChunk(capUsd: number, processes: number): number {
  return capUsd / (CHUNKS * Math.max(1, processes));
}

/** A child's tenant spend whose cap is what the router granted it (D327). */
export class LeasedSpend extends TenantSpend {
  private readonly chunk: number;
  /** tenant@day → USD granted on top of `start`. */
  private readonly granted = new Map<string, number>();
  /** tenant@day with a lease request in flight. */
  private readonly asking = new Set<string>();
  /** tenant@day the router answered 0 for: the day's cap is all granted, so nothing more is asked (A24). */
  private readonly exhausted = new Set<string>();
  private day = "";

  constructor(
    readonly capUsd: number,
    processes: number,
    private readonly ask: (request: LeaseRequest) => void,
    now?: () => number,
  ) {
    super(capUsd, now);
    this.chunk = leaseChunk(capUsd, processes);
  }

  protected override capFor(tenant: string, day: string, spentUsd: number): number {
    if (day !== this.day) {
      // A new UTC day: yesterday's grants are spent or void.
      this.granted.clear();
      this.asking.clear();
      this.exhausted.clear();
      this.day = day;
    }
    const key = `${tenant}@${day}`;
    const cap = this.chunk + (this.granted.get(key) ?? 0);
    if (cap - spentUsd < this.chunk / 2 && !this.asking.has(key) && !this.exhausted.has(key) && cap < this.capUsd) {
      this.asking.add(key);
      try {
        this.ask({ edenLease: { tenant, day, want: this.chunk } });
      } catch {
        // The router is gone: keep what is held, ask again at the next call.
        this.asking.delete(key);
      }
    }
    return Math.min(cap, this.capUsd);
  }

  /** The router's answer to a lease request. A grant for another day than today's is dropped. */
  grant(g: LeaseGrant["edenGrant"]): void {
    if (g.day !== this.day) return;
    const key = `${g.tenant}@${g.day}`;
    this.asking.delete(key);
    if (g.usd > 0) this.granted.set(key, (this.granted.get(key) ?? 0) + g.usd);
    // The ledger grants 0 only once the tenant's day is all granted: asking again (each tally, each `/v1/usage`
    // read) would be an IPC round trip per call for the same 0.
    else this.exhausted.add(key);
  }
}

/** The router's ledger of what it granted each tenant per UTC day, across its children (D327). */
export class SpendLedger {
  /** tenant@day → USD granted, the children's starts included. */
  private readonly days = new Map<string, number>();
  private today = "";

  constructor(
    readonly capUsd: number,
    readonly processes: number,
  ) {}

  /** Grants up to `want` of what is left of the tenant's day; 0 when nothing is. */
  lease(r: LeaseRequest["edenLease"]): LeaseGrant {
    if (r.day > this.today) {
      for (const k of this.days.keys()) if (!k.endsWith(`@${r.day}`)) this.days.delete(k);
      this.today = r.day;
    }
    const key = `${r.tenant}@${r.day}`;
    // Every child spends its start before it asks: count all N from the first lease of the day.
    const held = this.days.get(key) ?? leaseChunk(this.capUsd, this.processes) * this.processes;
    const want = Number.isFinite(r.want) && r.want > 0 ? r.want : 0;
    const usd = r.day < this.today ? 0 : Math.max(0, Math.min(want, this.capUsd - held));
    this.days.set(key, held + usd);
    return { edenGrant: { tenant: r.tenant, day: r.day, usd } };
  }

  /** USD granted for the tenant's day so far, starts included (0 before its first lease). */
  granted(tenant: string, day: string): number {
    return this.days.get(`${tenant}@${day}`) ?? 0;
  }
}

/** Whether an IPC message is a child's lease request (the router's `ipc` handler sees every message). */
export function isLeaseRequest(m: unknown): m is LeaseRequest {
  const r = (m as LeaseRequest | null)?.edenLease;
  return !!r && typeof r.tenant === "string" && typeof r.day === "string" && typeof r.want === "number";
}

/** Whether an IPC message is the router's grant. */
export function isLeaseGrant(m: unknown): m is LeaseGrant {
  const g = (m as LeaseGrant | null)?.edenGrant;
  return !!g && typeof g.tenant === "string" && typeof g.day === "string" && typeof g.usd === "number";
}
