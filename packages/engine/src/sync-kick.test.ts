/**
 * `syncKick` (D751, D753, in the default since D755; docs/research/o4-new-user.md): a user the sync has not seen
 * starts their backfill with their first event, not at the sync's next tick, and it goes on without the ticks.
 *
 * The clock and the timer are the test's own (`now`, `after`): nothing moves unless a test moves it, so each wait
 * is read in the clock's milliseconds. Each test names the mechanism it holds; the review's rule is that it fails
 * with that mechanism removed (checked by mutation, o4-new-user-review.md).
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, Source, SourceFanout } from "@eden/sources";
import { ItemCache } from "./cache";
import type { EngineConfig } from "./config";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";
import { SyncManager, type SyncOptions } from "./sync";

const T0 = Date.UTC(2026, 10, 10, 9);
/** `KICK_RESUMES`, `KICK_RESUME_MS` and `KICKS_AT_ONCE` (sync.ts). */
const RESUMES = 128;
const RESUME_MS = 500;
const AT_ONCE = 4;

/** A clock and a timer that move only when told. */
function manual() {
  let t = T0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const live = () => timers.filter((x) => x.live).sort((a, b) => a.at - b.at);
  return {
    now: () => t,
    after: (ms: number, fn: () => void) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    /** Timers set and not yet fired or cancelled: how long from now each is due. */
    waits: () => live().map((x) => x.at - t),
    /** Timers ever set. */
    set: () => timers.length,
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

/**
 * A listing source of `count` items a user, in the pages asked. It counts its calls by user, notes each (user,
 * cursor) it was asked, and how many calls it and its siblings (`flight`) had in flight at most. A call waits
 * `ms` of wall time, or for `gate` when one is set.
 */
class Listing implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = new Map<string, number>();
  asked: string[] = [];
  gate: Promise<void> | null = null;
  fails = 0;
  constructor(
    readonly id: string,
    private readonly count = 30,
    private readonly ms = 1,
    private readonly flight = { now: 0, max: 0, users: new Set<string>(), maxUsers: 0 },
  ) {}
  async search(): Promise<ContextItem[]> {
    return [];
  }
  async list(scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists.set(scope.userId, (this.lists.get(scope.userId) ?? 0) + 1);
    this.asked.push(`${scope.userId}@${cursor ?? 0}`);
    const f = this.flight;
    f.now++;
    f.max = Math.max(f.max, f.now);
    f.users.add(scope.userId);
    f.maxUsers = Math.max(f.maxUsers, f.users.size);
    try {
      if (this.gate) await this.gate;
      else await Bun.sleep(this.ms);
      if (this.fails-- > 0) throw new Error("boom");
    } finally {
      f.now--;
      f.users.delete(scope.userId);
    }
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

function build(config: Partial<EngineConfig>, sources?: Listing[]) {
  const flight = { now: 0, max: 0, users: new Set<string>(), maxUsers: 0 };
  const srcs = sources ?? [new Listing("a", 30, 1, flight), new Listing("b", 30, 1, flight)];
  const clock = manual();
  const cache = new ItemCache();
  let resolved = 0;
  const partner = new ContextPartner({
    sources: async () => {
      resolved++;
      return srcs;
    },
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: clock.now,
    after: clock.after,
    config: { ...CORE_CONFIG, sync: true, syncPageSize: 10, syncCallsPerMin: 6_000, ...config },
  });
  const sync = partner.sync!;
  const lists = (userId: string) => srcs.reduce((n, s) => n + (s.lists.get(userId) ?? 0), 0);
  /** Waits for the kicked steps of these users to end (a step that ends may start a queued user's). */
  const settle = async (...users: string[]) => {
    for (let again = true; again;) {
      again = false;
      for (const userId of users.length ? users : ["u1"]) {
        const step = sync.kicked({ tenantId: "t1", userId });
        if (step) {
          await step;
          again = true;
        }
      }
    }
  };
  return { partner, sync, cache, clock, lists, settle, srcs, flight, resolved: () => resolved };
}

const scopeOf = (userId: string): Scope => ({ tenantId: "t1", userId });
const U1 = scopeOf("u1");
const hello = (userId: string): AgentEvent =>
  ({ tenantId: "t1", userId, sessionId: "s1", at: T0, kind: "session_start" }) as AgentEvent;
const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
/** Six calls a minute: two pages of a source at once, then one every ten seconds of the clock. */
const SLOW_BUDGET = { syncCallsPerMin: 6 };

describe("syncKick (D751)", () => {
  test("off: a new user's backfill waits for the sync's tick, and no timer is set", async () => {
    const { partner, sync, clock, lists } = build({});
    await partner.observe(hello("u1"));
    await Bun.sleep(10);
    expect(lists("u1")).toBe(0);
    expect(sync.warm(U1)).toBe(false);
    await sync.tick();
    expect(sync.warm(U1)).toBe(true);
    expect(clock.set()).toBe(0);
  });

  test("on: the backfill starts with the first event, once, and nothing of it runs inside the event", async () => {
    const { partner, sync, cache, clock, lists, settle, srcs, resolved } = build({ syncKick: true });
    // The step starts in a microtask: the caller's own turn runs no resolver and no listing.
    sync.track(U1);
    sync.kick(U1);
    expect(resolved()).toBe(0);
    // A second event of the user's does not kick again.
    await partner.observe(hello("u1"));
    await partner.observe({ ...hello("u1"), kind: "user_message", text: "hello there" } as AgentEvent);
    await settle();
    expect(sync.warm(U1)).toBe(true);
    expect(cache.syncedCount(U1)).toBe(60);
    // Two sources of 30 items in pages of 10: three pages each, each read once; done, so no resume is set.
    expect(lists("u1")).toBe(6);
    expect(dupes(srcs.flatMap((s) => s.asked.map((c) => `${s.id}:${c}`)))).toEqual([]);
    expect(resolved()).toBe(1);
    expect(clock.waits()).toEqual([]);
  });

  test("the resume timer: a backfill its budget stopped goes on when the budget allows, on the clock, no tick", async () => {
    const { partner, sync, cache, clock, lists, settle } = build({ syncKick: true, ...SLOW_BUDGET });
    await partner.observe(hello("u1"));
    await settle();
    // Two pages a source, then the budget: one timer, set for the budget's own wait in the clock's milliseconds.
    expect(lists("u1")).toBe(4);
    expect(sync.warm(U1)).toBe(false);
    expect(clock.waits()).toEqual([10_000]);
    // Wall time passing moves nothing: the wait is on the injected clock only.
    await Bun.sleep(30);
    expect(lists("u1")).toBe(4);
    // A kick while the resume is timed starts no step: the timer is the user's next step.
    sync.kick(U1);
    expect(sync.kicked(U1)).toBeNull();
    await clock.advance(9_999, settle);
    expect(lists("u1")).toBe(4);
    await clock.advance(1, settle);
    // The budget gave each source its next page.
    expect(lists("u1")).toBe(6);
    expect(sync.warm(U1)).toBe(true);
    expect(cache.syncedCount(U1)).toBe(60);
    expect(clock.waits()).toEqual([]);
  });

  test("off, the same backfill stops at its budget until a tick", async () => {
    const { partner, sync, clock, lists } = build(SLOW_BUDGET);
    await partner.observe(hello("u1"));
    await sync.tick();
    expect(lists("u1")).toBe(4);
    expect(sync.warm(U1)).toBe(false);
    expect(clock.set()).toBe(0);
  });

  test("the resume cap: a source that never answers is resumed 128 times, then left to the ticks", async () => {
    const dead = new Listing("dead");
    dead.fails = Infinity;
    const { partner, sync, clock, settle } = build({ syncKick: true }, [dead]);
    await partner.observe(hello("u1"));
    await settle();
    let fired = 0;
    for (; clock.waits().length > 0 && fired < 2 * RESUMES; fired++) await clock.advance(clock.waits()[0]!, settle);
    expect(fired).toBe(RESUMES);
    expect(clock.set()).toBe(RESUMES);
    // Each resume was one call at its back-off's end, never more.
    expect(dead.lists.get("u1")).toBe(RESUMES + 1);
    // The ticks still have the user.
    await clock.advance(30 * 60_000, settle);
    await sync.tick();
    expect(dead.lists.get("u1")).toBe(RESUMES + 2);
  });

  test("the timer's clean-up: a user forgotten with a resume pending has it cancelled", async () => {
    const { partner, clock, lists, settle, cache } = build({ syncKick: true, ...SLOW_BUDGET });
    await partner.observe(hello("u1"));
    await settle();
    expect(clock.waits().length).toBe(1);
    partner.forget(U1);
    expect(clock.waits()).toEqual([]);
    await clock.advance(60_000, settle);
    expect(lists("u1")).toBe(4);
    expect(cache.syncedCount(U1)).toBe(0);
  });

  test("the timer's clean-up: a user the sync drops as idle has it cancelled", async () => {
    const { partner, sync, clock, lists, settle } = build({ syncKick: true, ...SLOW_BUDGET, syncDropMs: 5_000 });
    await partner.observe(hello("u1"));
    await settle();
    expect(clock.waits()).toEqual([10_000]);
    // Idle past `syncDropMs` before the resume is due: the tick drops the user and their timer.
    await clock.advance(6_000, settle);
    await sync.tick();
    expect(clock.waits()).toEqual([]);
    await clock.advance(60_000, settle);
    expect(lists("u1")).toBe(4);
  });

  test("a user forgotten while their kicked step reads has nothing stored or counted after, and no timer", async () => {
    let open!: () => void;
    const a = new Listing("a");
    a.gate = new Promise((r) => (open = r));
    const { partner, sync, cache, clock, settle } = build({ syncKick: true, ...SLOW_BUDGET }, [a]);
    await partner.observe(hello("u1"));
    await Bun.sleep(5);
    expect(a.lists.get("u1")).toBe(1);
    const step = sync.kicked(U1);
    partner.forget(U1);
    open();
    await step;
    await settle();
    expect(cache.syncedCount(U1)).toBe(0);
    expect(sync.stats.backgroundCalls).toBe(0);
    expect(sync.stats.backgroundItems).toBe(0);
    expect(clock.set()).toBe(0);
    expect(a.lists.get("u1")).toBe(1);
  });

  // One user, one step at a time. In batches a second step beside the first lists a page again (the fast source's
  // read is over while the batch waits for the slow one); with the pool it reads past the pool's lanes.
  for (const lanes of [0, 1]) {
    const config = { syncKick: true, syncKickLanes: lanes, syncBackfillLanes: lanes === 0 ? 8 : 1 };
    const pair = () => {
      const flight = { now: 0, max: 0, users: new Set<string>(), maxUsers: 0 };
      return { flight, srcs: [new Listing("fast", 30, 1, flight), new Listing("slow", 30, 40, flight)] };
    };
    const once = (srcs: Listing[], flight: { max: number }) => {
      expect(dupes(srcs.flatMap((s) => s.asked.map((c) => `${s.id}:${c}`)))).toEqual([]);
      if (lanes === 1) expect(flight.max).toBe(1);
    };

    test(`a tick during a kicked step waits for it (lanes ${lanes})`, async () => {
      const { srcs, flight } = pair();
      const { partner, sync, cache, settle } = build(config, srcs);
      await partner.observe(hello("u1"));
      await Bun.sleep(15);
      expect(sync.kicked(U1)).not.toBeNull();
      await sync.tick();
      await settle();
      expect(cache.syncedCount(U1)).toBe(60);
      once(srcs, flight);
    });

    test(`a kick, and a resume, during a tick's step wait for it (lanes ${lanes})`, async () => {
      const { srcs, flight } = pair();
      const { sync, cache, clock, settle } = build(config, srcs);
      sync.track(U1);
      const ticked = sync.tick();
      await Bun.sleep(15);
      // The tick's step is reading. A kick now starts no step: it looks again in `KICK_RESUME_MS`.
      sync.kick(U1);
      expect(sync.kicked(U1)).toBeNull();
      expect(clock.waits()).toEqual([RESUME_MS]);
      // The timer firing while the tick still reads (the review's probe) starts none either.
      await clock.advance(RESUME_MS, settle);
      expect(sync.kicked(U1)).toBeNull();
      expect(clock.waits()).toEqual([RESUME_MS]);
      await ticked;
      expect(cache.syncedCount(U1)).toBe(60);
      once(srcs, flight);
      // The tick finished the backfill: the timer that is left finds nothing to resume.
      await clock.advance(RESUME_MS, settle);
      expect(clock.waits()).toEqual([]);
      once(srcs, flight);
    });
  }

  test("the pool reads another source as soon as a lane is free; a failed page does not stop the rest", async () => {
    // Six sources of one page, two lanes. The first source's page is held; the second's fails once.
    let open!: () => void;
    const slow = new Listing("slow");
    slow.gate = new Promise((r) => (open = r));
    const flaky = new Listing("flaky");
    flaky.fails = 1;
    const rest = ["c", "d", "e", "f"].map((id) => new Listing(id));
    const { partner, sync, cache, clock, settle } = build(
      { syncKick: true, syncKickLanes: 2, syncPageSize: 100, syncKickRetryMs: 0 },
      [slow, flaky, ...rest],
    );
    await partner.observe(hello("u1"));
    // The held source keeps one lane; the other reads the rest meanwhile (batches of two would wait for it).
    for (let i = 0; i < 400 && !rest.every((s) => sync.complete(U1, s.id)); i++) await Bun.sleep(5);
    expect(rest.every((s) => sync.complete(U1, s.id))).toBe(true);
    expect(sync.complete(U1, "slow")).toBe(false);
    expect(sync.kicked(U1)).not.toBeNull();
    open();
    await settle();
    expect(cache.syncedCount(U1)).toBe(150);
    expect(sync.complete(U1, "flaky")).toBe(false);
    // The pool's back-off: the failed source is read again when its 30 s end, not at a resume before.
    expect(clock.waits()).toEqual([30_000]);
    await clock.advance(29_999, settle);
    expect(flaky.lists.get("u1")).toBe(1);
    await clock.advance(1, settle);
    expect(flaky.lists.get("u1")).toBe(2);
    expect(sync.warm(U1)).toBe(true);
  });

  test("the pool's back-off holds while other sources go on: a resume before its end does not read it", async () => {
    // `big` stops for its budget (a resume in 10 s); `flaky` failed once and backs off 30 s.
    const flaky = new Listing("flaky", 10);
    flaky.fails = 1;
    const big = new Listing("big", 60);
    const { partner, sync, clock, settle } = build({ syncKick: true, ...SLOW_BUDGET, syncKickRetryMs: 0 }, [
      big,
      flaky,
    ]);
    await partner.observe(hello("u1"));
    await settle();
    expect(big.lists.get("u1")).toBe(2);
    expect(clock.waits()).toEqual([10_000]);
    await clock.advance(10_000, settle);
    await clock.advance(10_000, settle);
    // Two resumes read `big` on; `flaky`, still backing off, was not asked.
    expect(big.lists.get("u1")).toBe(4);
    expect(flaky.lists.get("u1")).toBe(1);
    await clock.advance(10_000, settle);
    expect(flaky.lists.get("u1")).toBe(2);
    await clock.advance(120_000, settle);
    expect(sync.warm(U1)).toBe(true);
  });

  test("the pool leaves a source a guard refused for the resume: it is not asked again as each other page lands", async () => {
    // The fan-out refuses `held` ("limited": its rate limit keeps tokens for serving) and answers `open`'s pages.
    const clock = manual();
    const open = new Listing("open", 60);
    const held = new Listing("held");
    const asked = { held: 0, open: 0 };
    const fanout = {
      list: async (source: Source, scope: Scope, cursor: string | undefined, limit: number) => {
        asked[source.id as "held" | "open"]++;
        return source.id === "held"
          ? "limited"
          : await source.list!(scope, cursor, limit, new AbortController().signal);
      },
    } as unknown as SourceFanout;
    const sync = new SyncManager(
      { sources: async () => [open, held], fanout, cache: new ItemCache(), now: clock.now, after: clock.after },
      {
        maxItems: 3_000,
        pageSize: 10,
        kickLanes: 2,
        callsPerMin: 6_000,
        staleChance: 0.5,
        maxStaleMs: 3_600_000,
        activeMs: 3_600_000,
        sweepMs: 86_400_000,
        dropMs: 86_400_000,
        catchupPages: 1,
        maxUsersPerTenant: 10,
        timeoutMs: 5_000,
      } satisfies SyncOptions,
    );
    sync.track(U1);
    sync.kick(U1);
    await sync.kicked(U1);
    // Six pages of `open` landed; `held` was asked once in the pass, and waits for the resume.
    expect(asked).toEqual({ held: 1, open: 6 });
    expect(clock.waits()).toEqual([RESUME_MS]);
    await clock.advance(RESUME_MS, async () => void (await sync.kicked(U1)));
    expect(asked).toEqual({ held: 2, open: 6 });
  });

  test("a failed first page is tried again after 1.5 s; a second failure waits 30 s, then it doubles (D753)", async () => {
    const flaky = new Listing("flaky", 10);
    flaky.fails = 3;
    const { partner, sync, clock, settle } = build({ syncKick: true }, [flaky]);
    const calls = () => flaky.lists.get("u1");
    await partner.observe(hello("u1"));
    await settle();
    expect(clock.waits()).toEqual([1_500]);
    await clock.advance(1_499, settle);
    expect(calls()).toBe(1);
    await clock.advance(1, settle);
    expect(calls()).toBe(2);
    expect(clock.waits()).toEqual([30_000]);
    await clock.advance(30_000, settle);
    expect(calls()).toBe(3);
    expect(clock.waits()).toEqual([60_000]);
    await clock.advance(60_000, settle);
    expect(calls()).toBe(4);
    expect(sync.warm(U1)).toBe(true);
  });

  test("off, a failed first page waits the 30 s (and with the retry set to 0)", async () => {
    for (const config of [{}, { syncKick: true, syncKickRetryMs: 0 }]) {
      const flaky = new Listing("flaky", 10);
      flaky.fails = 1;
      const { partner, sync, clock, settle } = build(config, [flaky]);
      await partner.observe(hello("u1"));
      await sync.tick();
      await settle();
      await clock.advance(29_999, settle);
      await sync.tick();
      expect(flaky.lists.get("u1")).toBe(1);
      await clock.advance(1, settle);
      await sync.tick();
      expect(flaky.lists.get("u1")).toBe(2);
    }
  });

  test("kicks across users: four kicked steps at once, the rest in turn, all without a tick", async () => {
    const flight = { now: 0, max: 0, users: new Set<string>(), maxUsers: 0 };
    const srcs = [new Listing("a", 30, 5, flight), new Listing("b", 30, 5, flight)];
    const { partner, sync, cache, lists, settle } = build({ syncKick: true }, srcs);
    const users = Array.from({ length: 10 }, (_, i) => `u${i + 1}`);
    await Promise.all(users.map((u) => partner.observe(hello(u))));
    await settle(...users);
    expect(flight.maxUsers).toBe(AT_ONCE);
    for (const u of users) {
      expect(sync.warm(scopeOf(u))).toBe(true);
      expect(cache.syncedCount(scopeOf(u))).toBe(60);
      expect(lists(u)).toBe(6);
    }
  });

  test("a tick leaves users waiting for a kick turn alone: users arriving together read no more at once than four pools", async () => {
    // 24 users of 40 sources arrive together and a tick comes while they are read. The tick's 16 lanes stepping the
    // waiting users as well (as pools: 512 listings at once in the review's probe; as batches: 128 more) would pass
    // the bound.
    const flight = { now: 0, max: 0, users: new Set<string>(), maxUsers: 0 };
    const srcs = Array.from({ length: 40 }, (_, i) => new Listing(`s${i}`, 10, 15, flight));
    const { partner, sync, lists, settle } = build({ syncKick: true, syncKickLanes: 32 }, srcs);
    const users = Array.from({ length: 24 }, (_, i) => `u${i + 1}`);
    await Promise.all(users.map((u) => partner.observe(hello(u))));
    await Bun.sleep(5);
    await sync.tick();
    await settle(...users);
    expect(flight.max).toBeLessThanOrEqual(AT_ONCE * 32);
    expect(flight.maxUsers).toBe(AT_ONCE);
    for (const u of users) {
      expect(sync.warm(scopeOf(u))).toBe(true);
      expect(lists(u)).toBe(40);
    }
    expect(dupes(srcs.flatMap((s) => s.asked.map((c) => `${s.id}:${c}`)))).toEqual([]);
  });

  test("a user forgotten while waiting for a turn is never started", async () => {
    const flight = { now: 0, max: 0, users: new Set<string>(), maxUsers: 0 };
    const srcs = [new Listing("a", 30, 5, flight), new Listing("b", 30, 5, flight)];
    const { partner, lists, settle, clock, resolved } = build({ syncKick: true }, srcs);
    const users = Array.from({ length: 6 }, (_, i) => `u${i + 1}`);
    await Promise.all(users.map((u) => partner.observe(hello(u))));
    partner.forget(scopeOf("u6"));
    await settle(...users);
    await Bun.sleep(5);
    // Not even their sources were asked for.
    expect(resolved()).toBe(5);
    expect(lists("u6")).toBe(0);
    expect(lists("u5")).toBe(6);
    expect(clock.waits()).toEqual([]);
  });

  test("only a user new to the sync is kicked: not a later event of theirs, not a user the sync already held", async () => {
    const { partner, sync, clock, lists, settle, resolved } = build({ syncKick: true });
    await partner.observe(hello("u1"));
    await settle();
    expect(sync.warm(U1)).toBe(true);
    const steps = resolved();
    await partner.observe({ ...hello("u1"), kind: "user_message", text: "hello again" } as AgentEvent);
    await settle();
    expect(resolved()).toBe(steps);
    // Tracked another way (a restored user, a harness): their first event starts nothing; the ticks have them.
    sync.track(scopeOf("u2"));
    await partner.observe(hello("u2"));
    await Bun.sleep(5);
    expect(sync.kicked(scopeOf("u2"))).toBeNull();
    expect(lists("u2")).toBe(0);
    expect(resolved()).toBe(steps);
    expect(clock.set()).toBe(0);
  });

  test("a kick after a tick's step ended with the backfill unfinished starts its step", async () => {
    const { sync, lists, clock, settle } = build({ syncKick: true, ...SLOW_BUDGET });
    sync.track(U1);
    await sync.tick();
    expect(lists("u1")).toBe(4);
    await clock.advance(10_000, settle);
    sync.kick(U1);
    await settle();
    expect(lists("u1")).toBe(6);
    expect(sync.warm(U1)).toBe(true);
  });

  test("only a kicked step reads as a pool: a tick's step for a user who was kicked reads batches", async () => {
    const flight = { now: 0, max: 0, users: new Set<string>(), maxUsers: 0 };
    const srcs = Array.from({ length: 6 }, (_, i) => new Listing(`s${i}`, 30, 5, flight));
    const { partner, sync, clock, lists, settle } = build(
      { syncKick: true, ...SLOW_BUDGET, syncBackfillLanes: 1 },
      srcs,
    );
    await partner.observe(hello("u1"));
    await settle();
    // The pool read two pages of each of the six sources, more than one at once; then the budget.
    expect(lists("u1")).toBe(12);
    expect(flight.max).toBeGreaterThan(1);
    // The kicks are stopped, so the ticks have the user: one source at a time, as `syncBackfillLanes` says.
    partner.stopSync();
    await clock.advance(10_000, settle);
    flight.max = 0;
    await sync.tick();
    expect(lists("u1")).toBe(18);
    expect(flight.max).toBe(1);
  });

  test("at the user's cap the pool keeps and cuts what the batches do", async () => {
    const outcome = async (lanes: number) => {
      const { partner, sync, cache, settle } = build({ syncKick: true, syncKickLanes: lanes, syncMaxItems: 25 });
      await partner.observe(hello("u1"));
      await settle();
      expect(sync.warm(U1)).toBe(true);
      return {
        held: cache.syncedCount(U1),
        a: sync.syncedIds(U1, "a").sort(),
        b: sync.syncedIds(U1, "b").sort(),
        whole: [sync.complete(U1, "a"), sync.complete(U1, "b")],
      };
    };
    const pool = await outcome(32);
    const batch = await outcome(0);
    // The trim waits for the cap to pass by a page (hysteresis) and pages already on the wire land past it, so the
    // pool's and the batches' held sets can differ by that slack; for each the newest items are kept, a copy is
    // whole exactly when all 30 of its items are held, and the cap cut something off the 60 listed.
    for (const o of [pool, batch]) {
      expect(o.whole).toEqual([o.a.length === 30, o.b.length === 30]);
      expect(o.held).toBeGreaterThanOrEqual(25);
      expect(o.held).toBeLessThan(60);
      expect(o.a).toContain(itemId("a", "u1-0"));
    }
  });

  test("in batches too (no pool), a backfill its budget stopped is resumed after the budget's wait", async () => {
    const { partner, sync, clock, lists, settle } = build({ syncKick: true, syncKickLanes: 0, ...SLOW_BUDGET });
    await partner.observe(hello("u1"));
    await settle();
    expect(lists("u1")).toBe(4);
    expect(clock.waits()).toEqual([10_000]);
    await clock.advance(10_000, settle);
    expect(lists("u1")).toBe(6);
    expect(sync.warm(U1)).toBe(true);
  });

  test("the quick retry is the first backfill's only: a warm source that fails waits the 30 s", async () => {
    const a = new Listing("a", 10);
    const { partner, sync, clock, settle } = build({ syncKick: true, syncSweepMs: 60_000 }, [a]);
    await partner.observe(hello("u1"));
    await settle();
    expect(sync.warm(U1)).toBe(true);
    // The sweep a minute on fails once.
    a.fails = 1;
    await clock.advance(60_000, settle);
    sync.track(U1, clock.now());
    await sync.tick();
    const failedAt = a.lists.get("u1")!;
    expect(failedAt).toBe(2);
    await clock.advance(1_500, settle);
    await sync.tick();
    expect(a.lists.get("u1")).toBe(failedAt);
    await clock.advance(28_500, settle);
    await sync.tick();
    expect(a.lists.get("u1")).toBe(failedAt + 1);
  });

  test("stopSync cancels resume timers and waiting kicks, and kicks start again with startSync", async () => {
    const flight = { now: 0, max: 0, users: new Set<string>(), maxUsers: 0 };
    const srcs = [new Listing("a", 30, 5, flight), new Listing("b", 30, 5, flight)];
    const { partner, sync, clock, lists, settle } = build({ syncKick: true, ...SLOW_BUDGET }, srcs);
    const users = Array.from({ length: 6 }, (_, i) => `u${i + 1}`);
    await partner.observe(hello("u1"));
    await settle("u1");
    expect(clock.waits()).toEqual([10_000]);
    // Five more arrive: four start, one waits. The stop lets the running steps end and starts nothing more.
    await Promise.all(users.slice(1).map((u) => partner.observe(hello(u))));
    partner.stopSync();
    expect(clock.waits()).toEqual([]);
    // Started again while those steps still read: the user who was waiting was let go, and stays with the ticks.
    partner.startSync(3_600_000);
    await settle(...users);
    expect(lists("u6")).toBe(0);
    partner.stopSync();
    expect(clock.waits()).toEqual([]);
    await clock.advance(60_000, () => settle(...users));
    expect(users.map(lists)).toEqual([4, 4, 4, 4, 4, 0]);
    // A new user's event after the stop kicks nothing.
    await partner.observe(hello("u7"));
    await settle("u7");
    expect(lists("u7")).toBe(0);
    partner.startSync(3_600_000);
    await partner.observe(hello("u8"));
    await settle("u8", "u6");
    expect(lists("u8")).toBe(4);
    // The user who was waiting when the stop came is not started by a later kick's end: the ticks have them.
    expect(lists("u6")).toBe(0);
    partner.stopSync();
    expect(sync.warm(scopeOf("u8"))).toBe(false);
    // And a tick does read them: the stop took them out of the kicks' queue, which a tick would otherwise skip.
    await sync.tick();
    expect(lists("u6")).toBe(4);
  });

  test("a kick syncs only the user whose event it was", async () => {
    const { partner, sync, lists, settle } = build({ syncKick: true });
    await partner.observe(hello("u1"));
    await settle();
    expect(lists("u1")).toBe(6);
    expect(lists("u2")).toBe(0);
    expect(sync.warm(scopeOf("u2"))).toBe(false);
  });
});
