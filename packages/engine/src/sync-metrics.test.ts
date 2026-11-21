/**
 * The backfill and fairness metrics `/metrics` exports (S1-P2, B4 of docs/research/s1-scale-1m.md): users still in
 * a first pass, users whose no source has produced a page, the kick queue's depth, listing calls by S1-P1 tier —
 * sent, held by the pace, throttled by the connector — and the first-event → first stored page histogram.
 *
 * Each test names the signal it holds and fails with the mechanism removed (checked by mutation, as the other
 * sync tests' reviews ask). The clock and timers are the test's own.
 */
import { describe, expect, test } from "bun:test";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, Source, SourceFanout } from "@eden/sources";
import { ItemCache } from "./cache";
import { FIRST_VALUE_LE, SyncManager, type SyncOptions } from "./sync";

const T0 = Date.UTC(2026, 10, 10, 9);
const U1: Scope = { tenantId: "t1", userId: "u1" };
const U = (tenantId: string, userId: string): Scope => ({ tenantId, userId });

/** A clock and a timer that move only when told (the `sync-kick.test.ts` shape). */
function manual() {
  let t = T0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const live = () => timers.filter((x) => x.live).sort((a, b) => a.at - b.at);
  return {
    now: () => t,
    set t(v: number) {
      t = v;
    },
    after: (ms: number, fn: () => void) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    /** Moves the clock `ms` on, firing each timer due on the way at its own time; `settle` runs after each. */
    async advance(ms: number, settle: () => Promise<void>) {
      const end = t + ms;
      for (let next = live()[0]; next && next.at <= end; next = live()[0]) {
        t = next.at;
        next.live = false;
        next.fn();
        await settle();
      }
      t = end;
    },
  };
}

/** A listing source of `count` items in pages of `pageSize`; `gate` holds each call until opened. */
class Listing implements Source {
  readonly kind = "test";
  readonly description = "test";
  gate: Promise<void> | null = null;
  constructor(
    readonly id: string,
    private readonly count = 10,
  ) {}
  async search(): Promise<ContextItem[]> {
    return [];
  }
  async list(scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    if (this.gate) await this.gate;
    const at = cursor ? Number(cursor) : 0;
    const all = Array.from({ length: this.count }, (_, i) => ({
      id: itemId(this.id, `${scope.userId}-${i}`),
      sourceId: this.id,
      ref: `${scope.userId}-${i}`,
      title: `Note ${i} of ${scope.userId}`,
      text: `words for ${scope.userId} note ${i}`,
      updatedAt: T0 - i * 3_600_000,
    }));
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const OPTS = {
  maxItems: 3_000,
  pageSize: 10,
  kickLanes: 4,
  callsPerMin: 6_000,
  staleChance: 0.5,
  maxStaleMs: 3_600_000,
  activeMs: 3_600_000,
  sweepMs: 86_400_000,
  dropMs: 86_400_000,
  catchupPages: 1,
  maxUsersPerTenant: 10,
  timeoutMs: 5_000,
} satisfies SyncOptions;

/** A SyncManager whose fan-out answers each source id as `results` names, else lists the page itself. */
function build(sources: Source[], results: Record<string, "limited" | "throttled" | "busy"> = {}) {
  const clock = manual();
  const fanout = {
    list: async (source: Source, scope: Scope, cursor: string | undefined, limit: number) => {
      const r = results[source.id];
      if (r) return r;
      return source.list!(scope, cursor, limit, new AbortController().signal);
    },
  } as unknown as SourceFanout;
  const sync = new SyncManager(
    { sources: async () => sources, fanout, cache: new ItemCache(), now: clock.now, after: clock.after },
    OPTS,
  );
  /** `clock.advance`'s settle: waits out the kicked steps of `users` until none runs (one ending can start another). */
  const settle = async (...users: Scope[]) => {
    const scopes = users.length ? users : [U1];
    for (let again = true; again;) {
      again = false;
      for (const u of scopes) {
        const step = sync.kicked(u);
        if (step) {
          await step;
          again = true;
        }
      }
    }
  };
  return { sync, clock, settle };
}

describe("the backfill and fairness gauges (S1-P2)", () => {
  test("a user waits for their first page until a source produces one", async () => {
    const results: Record<string, "limited"> = { a: "limited" };
    const { sync, clock, settle } = build([new Listing("a")], results);
    sync.track(U1);
    sync.kick(U1);
    await sync.kicked(U1);
    // The source resolved and its first page was refused: backfilling, and still waiting for a first page.
    expect(sync.gauges()).toMatchObject({ backfilling: 1, waitingFirstPage: 1 });
    // The resume read lands the page: no longer waiting, the first pass done (one page was the whole listing).
    delete (results as Record<string, string>).a;
    await clock.advance(600, settle);
    expect(sync.gauges()).toMatchObject({ backfilling: 0, waitingFirstPage: 0 });
  });

  test("the kick queue's users and waiting tenants are counted while it holds", async () => {
    let open!: () => void;
    const held = new Listing("held", 10);
    held.gate = new Promise((r) => (open = r));
    const { sync } = build([held]);
    // KICKS_AT_ONCE is 4: four kicked steps running hold the gate; two more of the same tenant and one of
    // another wait.
    const running = [U("t1", "a"), U("t1", "b"), U("t1", "c"), U("t1", "d")];
    const waiting = [U("t1", "e"), U("t1", "f"), U("t2", "g")];
    for (const u of [...running, ...waiting]) {
      sync.track(u);
      sync.kick(u);
    }
    await Bun.sleep(20);
    // All seven wait for a first page: the four running (their sources found, nothing stored) and the three
    // queued — a queued user's step has not discovered their sources yet, so `sources.size` alone would hide them.
    expect(sync.gauges()).toMatchObject({
      kickRunning: 4,
      kickQueuedUsers: 3,
      kickQueuedTenants: 2,
      waitingFirstPage: 7,
    });
    open();
    for (let i = 0; i < 120 && sync.gauges().kickQueuedUsers + sync.gauges().kickRunning > 0; i++) {
      await Bun.sleep(5);
    }
    expect(sync.gauges()).toMatchObject({ kickQueuedUsers: 0, kickQueuedTenants: 0, kickRunning: 0 });
  });

  test("first value is per source: one source's page does not end the wait for another's", async () => {
    const results: Record<string, "limited"> = { b: "limited" };
    const { sync, clock, settle } = build([new Listing("a"), new Listing("b")], results);
    sync.track(U1);
    sync.kick(U1);
    await sync.kicked(U1);
    // A stored its first page, b's was refused: one first value counted, the user still waiting on b.
    expect(sync.stats.firstPageCount).toBe(1);
    expect(sync.gauges().waitingFirstPage).toBe(1);
    delete (results as Record<string, string>).b;
    await clock.advance(600, settle);
    // B's page lands: a second first value, measured from the same first event, and nobody left waiting.
    expect(sync.stats.firstPageCount).toBe(2);
    expect(sync.gauges().waitingFirstPage).toBe(0);
  });

  test("a restored backfill with pages behind it does not wait or count first value again", async () => {
    const a = new Listing("a", 15);
    const list = a.list.bind(a);
    // The second page is refused: the kick ends with the first pass in progress — phase backfill, ids held,
    // polledAt still unset — exactly the restore that used to measure first value again.
    a.list = (s: Scope, c: string | undefined, l: number) =>
      c === undefined ? list(s, c, l) : Promise.resolve("limited" as unknown as ListPage);
    const { sync } = build([a]);
    sync.track(U1);
    sync.kick(U1);
    await sync.kicked(U1);
    // One of two pages stored: first value recorded, the first pass still in progress (polledAt is only set at its
    // end), so the snapshot's source row is phase backfill with ids and a cursor but polledAt null.
    expect(sync.stats.firstPageCount).toBe(1);
    const snap = sync.snapshot(U1)!;
    expect(snap.sources[0]!.phase).toBe("backfill");
    expect(snap.sources[0]!.polledAt).toBeNull();
    expect(snap.sources[0]!.ids.length).toBeGreaterThan(0);
    const { sync: again } = build([new Listing("a", 15)]);
    expect(again.restore(U1, snap)).toBe(true);
    // The ids say a page already landed: not waiting, and the rest of the pass records no second first value.
    expect(again.gauges().waitingFirstPage).toBe(0);
    again.kick(U1);
    await again.kicked(U1);
    expect(again.stats.firstPageCount).toBe(0);
  });
});

describe("listing calls by tier (S1-P2)", () => {
  test("a page the pace refused, the connector's 429 and the sent page are each counted under their tier", async () => {
    const results: Record<string, "limited" | "throttled"> = { a: "limited" };
    const { sync, clock, settle } = build([new Listing("a")], results);
    sync.track(U1);
    sync.kick(U1);
    await sync.kicked(U1);
    // A first page is tier 0: the refusal is held[0], no call was sent.
    expect(sync.stats.heldByTier[0]).toBe(1);
    expect(sync.stats.callsByTier).toEqual([0, 0, 0, 0]);
    // The connector's own rate-limit refusal is a call that went, counted throttled under the same tier. Its
    // back-off is 30 s on the clock; the resume at its end reads the page itself — a call, no hold, no refusal.
    results.a = "throttled";
    await clock.advance(600, settle);
    expect(sync.stats.callsByTier[0]).toBe(1);
    expect(sync.stats.throttledByTier[0]).toBe(1);
    delete (results as Record<string, string>).a;
    await clock.advance(31_000, settle);
    expect(sync.stats.callsByTier[0]).toBe(2);
    expect(sync.stats.throttledByTier[0]).toBe(1);
    expect(sync.stats.heldByTier).toEqual([1, 0, 0, 0]);
  });
});

describe("time to first value (S1-P2)", () => {
  test("first event to first stored page lands in the histogram, once per tracked user", async () => {
    let open!: () => void;
    const a = new Listing("a");
    a.gate = new Promise((r) => (open = r));
    const { sync, clock, settle } = build([a]);
    sync.track(U1);
    sync.kick(U1);
    await Bun.sleep(10); // The kicked step is reading its first page, held at the gate.
    // 45 s of the clock pass before the gate opens and the page stores.
    clock.t = T0 + 45_000;
    open();
    await sync.kicked(U1);
    const want = FIRST_VALUE_LE.map((le) => (45 <= le ? 1 : 0));
    expect(sync.stats.firstPageSeconds).toEqual(want);
    expect(sync.stats.firstPageCount).toBe(1);
    expect(sync.stats.firstPageSumSeconds).toBe(45);
    // Later pages are not first value again.
    await clock.advance(60_000, settle);
    expect(sync.stats.firstPageCount).toBe(1);
  });
});
