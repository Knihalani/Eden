import { describe, expect, test } from "bun:test";
import { Budget } from "@eden/llm";
import { LeasedSpend, leaseChunk, SpendLedger, type LeaseRequest } from "./spend-lease";

const DAY0 = Date.UTC(2026, 10, 7, 12);
const LIMITS = { callsPerSession: 1e9, usdPerSession: 1e9, usdPerUserDay: 1e9 };

/** N children on one ledger, grants delivered at once (as an IPC round trip that has landed). */
function cluster(cap: number, n: number, clock: { now: number }) {
  const ledger = new SpendLedger(cap, n);
  const children: LeasedSpend[] = [];
  for (let i = 0; i < n; i++) {
    const ask = (r: LeaseRequest) => queueMicrotask(() => children[i]!.grant(ledger.lease(r.edenLease).edenGrant));
    children.push(new LeasedSpend(cap, n, ask, () => clock.now));
  }
  const budgets = children.map((c) => new Budget(LIMITS, () => clock.now, c));
  return { ledger, children, budgets };
}

/** Spends calls of `usd` on one child until it refuses `misses` times in a row; returns what it spent. */
async function spendUntilRefused(b: Budget, user: string, usd: number, misses = 3): Promise<number> {
  let spent = 0;
  let refused = 0;
  for (let i = 0; i < 100_000 && refused < misses; i++) {
    if (b.charge(user, `${user}#s${i}`, usd)) {
      spent += usd;
      refused = 0;
    } else refused++;
    await Promise.resolve(); // Grants land between calls.
  }
  return spent;
}

describe("spend leases across router children (D327)", () => {
  test("one busy child reaches most of the tenant's cap, not cap/N", async () => {
    const clock = { now: DAY0 };
    const { budgets } = cluster(25, 4, clock);
    const spent = await spendUntilRefused(budgets[0]!, "acme/u1", 0.01);
    // The other three children hold their unused starts (cap/16 each): the busy one can reach 25 - 3 x 1.5625.
    expect(spent).toBeGreaterThan(25 * 0.75 - 0.02);
    expect(spent).toBeLessThanOrEqual(25 - 3 * leaseChunk(25, 4) + 1e-9);
    expect(spent).toBeGreaterThan(25 / 4); // What the divided cap allowed (D163).
  });

  test("all children together never pass the cap", async () => {
    const clock = { now: DAY0 };
    const { budgets } = cluster(10, 4, clock);
    const spent = await Promise.all(budgets.map((b, i) => spendUntilRefused(b, `acme/u${i}`, 0.013)));
    const total = spent.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(10 + 1e-9);
    expect(total).toBeGreaterThan(10 - 4 * 0.013 * 2);
  });

  test("isolation (D9): one tenant's spend never uses another tenant's ledger", async () => {
    const clock = { now: DAY0 };
    const { budgets, ledger } = cluster(5, 2, clock);
    await spendUntilRefused(budgets[0]!, "acme/u1", 0.01);
    expect(ledger.granted("acme", "2026-11-07")).toBeCloseTo(5, 6);
    expect(ledger.granted("globex", "2026-11-07")).toBe(0);
    const other = await spendUntilRefused(budgets[0]!, "globex/u1", 0.01);
    expect(other).toBeGreaterThan(5 * 0.75 - 0.02);
  });

  test("a new UTC day starts every tenant again; a late grant for yesterday is dropped", async () => {
    const clock = { now: DAY0 };
    const { budgets, children, ledger } = cluster(2, 2, clock);
    const day1 = await spendUntilRefused(budgets[0]!, "acme/u1", 0.01);
    expect(day1).toBeGreaterThan(1.4);
    clock.now += 24 * 3_600_000;
    children[0]!.grant({ tenant: "acme", day: "2026-11-07", usd: 100 }); // Yesterday's: ignored.
    const day2 = await spendUntilRefused(budgets[0]!, "acme/u1", 0.01);
    expect(day2).toBeGreaterThan(1.4);
    expect(day2).toBeLessThanOrEqual(2 - leaseChunk(2, 2) + 1e-9);
    expect(ledger.granted("acme", "2026-11-07")).toBe(0); // The ledger forgot the day before.
  });

  test("with no router answering, a child spends its start and no more", async () => {
    const clock = { now: DAY0 };
    const asked: LeaseRequest[] = [];
    const spend = new LeasedSpend(
      8,
      4,
      (r) => void asked.push(r),
      () => clock.now,
    );
    const b = new Budget(LIMITS, () => clock.now, spend);
    const spent = await spendUntilRefused(b, "acme/u1", 0.01);
    expect(spent).toBeLessThanOrEqual(leaseChunk(8, 4) + 1e-9);
    expect(asked).toHaveLength(1); // One request in flight at a time.
    expect(spend.capOf("acme")).toBeCloseTo(leaseChunk(8, 4), 9);
  });

  test("the ledger refuses bad amounts and never grants past the cap", () => {
    const ledger = new SpendLedger(4, 2);
    const day = "2026-11-07";
    expect(ledger.lease({ tenant: "a", day, want: Number.NaN }).edenGrant.usd).toBe(0);
    expect(ledger.lease({ tenant: "a", day, want: -5 }).edenGrant.usd).toBe(0);
    expect(ledger.lease({ tenant: "a", day, want: 100 }).edenGrant.usd).toBeCloseTo(3, 9); // 4 - 2 x 0.5 (starts).
    expect(ledger.lease({ tenant: "a", day, want: 1 }).edenGrant.usd).toBe(0);
  });
});
