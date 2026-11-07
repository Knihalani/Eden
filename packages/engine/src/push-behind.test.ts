import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import type { Ledger } from "./ledger";
import { ContextPartner } from "./partner";
import { AskReader, type ReaderInput, type ReaderKind, type ReaderMaker } from "./reader";
import type { Trace } from "./trace";
import { CORE_CONFIG } from "./parts";

// `readerPushBehind` (audit 2026-11-03b, lat-push-read-waits-poll): under `syncPollBehind` the push's own lookup no
// longer waits for the sync's on-demand poll, so its reader starts at once; a poll that then stores something gets one
// second reading on the refreshed index, whose packet replaces a stale one the agent has not taken.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 27, 9);
const REQUEST = "Pay the Harlow invoice today";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const until = async (cond: () => boolean, turns = 2_000) => {
  for (let n = 0; !cond(); n++) {
    if (n >= turns) throw new Error("condition never held");
    await tick();
  }
};
const cited = (xs: Injection[]) => xs.flatMap((x) => x.citations.map((c) => c.itemId));

/** A connector with a recent-first list call that can be held open (`hold`), to see what a lookup waits for. */
class SlowListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  items: ContextItem[] = [];
  private held: Promise<void> | null = null;
  private free: (() => void) | null = null;
  constructor(readonly id: string) {}
  add(ref: string, title: string, text: string, at: number): void {
    this.items.push({ id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  hold(): void {
    this.held = new Promise((r) => (this.free = r));
  }
  release(): void {
    this.free?.();
    this.held = null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    if (this.held) await this.held;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** Flags the first of `ids` its pool holds; counts the calls that reached it. */
class PickReader implements ReaderMaker {
  calls: ReaderInput[] = [];
  constructor(public ids: string[]) {}
  async read(input: ReaderInput) {
    this.calls.push(input);
    const i = this.ids.map((id) => input.items.findIndex((x) => x.id === id)).find((k) => k >= 0) ?? -1;
    const kind: ReaderKind = "blocks";
    return {
      bears: i >= 0 ? [{ i, kind, why: "the Harlow payment depends on it" }] : [],
      costUsd: 0.0002,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    };
  }
}

const NEW = itemId("mail", "new");
const HOLD = itemId("mail", "hold");

function setup(config: Record<string, unknown> = {}, reads = [NEW, HOLD]) {
  let clock = T0;
  const src = new SlowListSource("mail");
  src.add(
    "hold",
    "Harlow invoice on hold",
    "Harlow invoice payments are on hold until the dispute ends",
    T0 - 2 * HOUR,
  );
  for (let i = 0; i < 4; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * HOUR);
  const maker = new PickReader(reads);
  const traces: Trace[] = [];
  const p = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    reader: new AskReader({ maker, budget: new Budget(), now: () => clock }),
    onTrace: (t) => traces.push(t),
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPageSize: 2,
      syncCallsPerMin: 600,
      syncMaxStaleMs: 4 * HOUR,
      syncPollBehind: true,
      askReader: true,
      readerPush: true,
      readerPushBehind: true,
      // The event's own lookup delivers nothing with no model here, so every packet is the push's.
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      ...config,
    },
  });
  const warm = async (s: Scope) => {
    p.sync!.track(s);
    while (!p.sync!.warm(s)) await p.sync!.tick();
  };
  return { p, src, maker, traces, warm, advance: (ms: number) => (clock += ms), now: () => clock };
}

const user = { tenantId: "t1", userId: "u1" };
const say = (p: ContextPartner, at: number, s: Scope = user, sessionId = "s1", text = REQUEST) =>
  p.observe({ ...s, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });

describe("readerPushBehind: the push's reader does not wait for the sync's poll", () => {
  test("the read starts and its packet is queued while a 500 ms poll is still out", async () => {
    const { p, src, maker, warm, advance, now } = setup();
    await warm(user);
    advance(5 * HOUR); // Stale: the lookup polls.
    src.hold();
    const t0 = performance.now();
    const release = setTimeout(() => src.release(), 500);
    await say(p, now());
    const waited = performance.now() - t0;
    clearTimeout(release);
    expect(maker.calls).toHaveLength(1);
    expect(waited).toBeLessThan(400);
    const packets = p.takePending({ ...user, sessionId: "s1" });
    expect(cited(packets)).toContain(HOLD);
    src.release();
  });

  test("off (syncPollBehind alone): the push's read waits for the poll, as before", async () => {
    const { p, src, maker, warm, advance, now } = setup({ readerPushBehind: false });
    await warm(user);
    advance(5 * HOUR);
    src.hold();
    const observed = say(p, now());
    await Bun.sleep(30);
    expect(maker.calls).toHaveLength(0);
    src.release();
    await observed;
    expect(maker.calls).toHaveLength(1);
  });

  test("a late poll that changes the pool triggers one re-read; its packet replaces the stale one untaken", async () => {
    const { p, src, maker, traces, warm, advance, now } = setup();
    await warm(user);
    advance(5 * HOUR);
    src.add(
      "new",
      "Harlow dispute settled",
      "Harlow dispute settled: the invoice may be paid, new bank details",
      now(),
    );
    src.hold();
    await say(p, now());
    expect(maker.calls).toHaveLength(1); // Read from the index as it stood: without the new item.
    expect(maker.calls[0]!.items.map((x) => x.id)).not.toContain(NEW);
    src.release();
    await until(() => maker.calls.length >= 2);
    await Bun.sleep(20);
    expect(maker.calls).toHaveLength(2);
    expect(maker.calls[1]!.items.map((x) => x.id)).toContain(NEW);
    const packets = p.takePending({ ...user, sessionId: "s1" }).filter((x) => x.reason.startsWith("reader:"));
    // One packet, from the fresh index: the stale one gave way to it.
    expect(packets).toHaveLength(1);
    expect(cited(packets)).toEqual([NEW]);
    // The second reading searched nothing: its trace carries no source call.
    const pushes = traces.filter((t) => t.decision === "reader-push");
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.sourceCalls).toBe(0);
  });

  test("a packet the agent already took stays taken; the re-read adds only what is new to it", async () => {
    const { p, src, maker, warm, advance, now } = setup({}, [HOLD, NEW]);
    await warm(user);
    advance(5 * HOUR);
    src.add(
      "new",
      "Harlow dispute settled",
      "Harlow dispute settled: the invoice may be paid, new bank details",
      now(),
    );
    src.hold();
    await say(p, now());
    expect(cited(p.takePending({ ...user, sessionId: "s1" }))).toContain(HOLD);
    src.release();
    await until(() => maker.calls.length >= 2);
    await Bun.sleep(20);
    // The re-read flags the same item: nothing new, so no second packet.
    expect(p.takePending({ ...user, sessionId: "s1" }).filter((x) => x.reason.startsWith("reader:"))).toEqual([]);
  });

  test("a poll that stores nothing triggers no re-read", async () => {
    const { p, src, maker, traces, warm, advance, now } = setup();
    await warm(user);
    advance(5 * HOUR);
    src.hold();
    await say(p, now());
    src.release();
    await Bun.sleep(30);
    expect(maker.calls).toHaveLength(1);
    expect(traces.filter((t) => t.decision === "reader-push")).toHaveLength(1);
  });

  test("a poll that stores something outside the pool re-ranks, but the unchanged pool is a cache hit: no call", async () => {
    const { p, src, maker, traces, warm, advance, now } = setup();
    await warm(user);
    advance(5 * HOUR);
    src.add("lunch", "Lunch orders", "Note about lunch orders for Friday", now());
    src.hold();
    await say(p, now());
    src.release();
    await until(() => traces.filter((t) => t.decision === "reader-push").length >= 2);
    expect(maker.calls).toHaveLength(1);
    const second = traces.filter((t) => t.decision === "reader-push")[1]!;
    expect(second.modelCalls).toBe(0);
    // Still exactly one reader packet pending, carrying what it carried.
    const packets = p.takePending({ ...user, sessionId: "s1" }).filter((x) => x.reason.startsWith("reader:"));
    expect(packets).toHaveLength(1);
    expect(cited(packets)).toEqual([HOLD]);
  });

  test("a session closed while the poll is out queues nothing and reads nothing again", async () => {
    const { p, src, maker, warm, advance, now } = setup();
    await warm(user);
    advance(5 * HOUR);
    src.add(
      "new",
      "Harlow dispute settled",
      "Harlow dispute settled: the invoice may be paid, new bank details",
      now(),
    );
    src.hold();
    await say(p, now());
    await p.observe({ ...user, sessionId: "s1", at: now(), kind: "session_end" } as AgentEvent);
    src.release();
    await Bun.sleep(30);
    expect(maker.calls).toHaveLength(1);
    expect(p.takePending({ ...user, sessionId: "s1" })).toEqual([]);
  });

  test("a newer request makes the late re-read stale: it is not made", async () => {
    const { p, src, maker, warm, advance, now } = setup();
    await warm(user);
    advance(5 * HOUR);
    src.add(
      "new",
      "Harlow dispute settled",
      "Harlow dispute settled: the invoice may be paid, new bank details",
      now(),
    );
    src.hold();
    await say(p, now());
    await say(p, now(), user, "s1", "Thanks, what about lunch orders?");
    src.release();
    await Bun.sleep(30);
    expect(maker.calls.filter((c) => c.request === REQUEST)).toHaveLength(1);
  });

  test("isolation: one user's late poll re-reads into their own session only (tenant/user#session)", async () => {
    const { p, src, maker, warm, advance, now } = setup();
    const other = { tenantId: "t2", userId: "u1" };
    await warm(user);
    await warm(other);
    advance(5 * HOUR);
    src.add(
      "new",
      "Harlow dispute settled",
      "Harlow dispute settled: the invoice may be paid, new bank details",
      now(),
    );
    src.hold();
    await say(p, now(), user, "a");
    await say(p, now(), user, "b");
    await say(p, now(), other, "a");
    const before = maker.calls.length;
    src.release();
    await until(() => maker.calls.length > before);
    await Bun.sleep(30);
    for (const [s, sid] of [
      [user, "a"],
      [user, "b"],
      [other, "a"],
    ] as const) {
      const packets = p.takePending({ ...s, sessionId: sid }).filter((x) => x.reason.startsWith("reader:"));
      // Each session got its own single packet, never another's, and none twice.
      expect(packets).toHaveLength(1);
      expect(packets[0]!.sessionId).toBe(sid);
      expect(packets[0]!.tenantId).toBe(s.tenantId);
    }
  });
});

type Open = {
  sessions: Map<string, { id: string; scope: Scope; turn: number; ledger: Ledger; delivered: unknown[] }>;
  slowPath: (...a: unknown[]) => Promise<unknown>;
};
const sessionOf = (p: ContextPartner, s: Scope, sid: string) =>
  [...(p as unknown as Open).sessions.values()].find(
    (x) => x.id === sid && x.scope.tenantId === s.tenantId && x.scope.userId === s.userId,
  )!;

// Audit 2026-11-03b (corr-push-behind-withdraw-leaves-ledger-marked): the second reading withdraws the first packet
// the agent has not taken; what it does not deliver again must not stay marked delivered, or the agent never gets it.
describe("readerPushBehind: a withdrawn packet gives its items back", () => {
  const SETTLED = "Harlow dispute settled: the invoice may be paid, new bank details";

  test("an item the withdrawn packet carried reaches the agent on its next request", async () => {
    const { p, src, maker, traces, warm, advance, now } = setup({ cueCooldownTurns: 0 });
    await warm(user);
    advance(5 * HOUR);
    src.add("new", "Harlow dispute settled", SETTLED, now());
    src.hold();
    await say(p, now()); // Read from the stale index: HOLD is flagged and queued.
    src.release();
    await until(() => maker.calls.length >= 2);
    await Bun.sleep(20);
    // The re-read flags NEW: the HOLD packet is withdrawn untaken, and only NEW goes out.
    expect(cited(p.takePending({ ...user, sessionId: "s1" }))).toEqual([NEW]);
    const s = sessionOf(p, user, "s1");
    expect(s.ledger.isFresh(HOLD, s.turn)).toBe(true);
    expect(s.ledger.isFresh(NEW, s.turn)).toBe(false);
    // Nor is HOLD in the near-duplicate memory a lookup reads: only NEW's sketch is.
    expect(s.delivered).toHaveLength(1);
    maker.ids = [HOLD];
    await say(p, now(), user, "s1", "Wire the Harlow invoice payment now");
    await Bun.sleep(20);
    const second = p.takePending({ ...user, sessionId: "s1" });
    expect(cited(second)).toContain(HOLD);
    const pushes = traces.filter((t) => t.decision === "reader-push");
    expect(pushes.at(-1)!.itemIds).toContain(HOLD);
  });

  test("an item the second packet delivers again stays delivered; the near-duplicate memory drops the rest", async () => {
    const { p, src, maker, warm, advance, now } = setup({ cueCooldownTurns: 0 }, [NEW, HOLD]);
    await warm(user);
    advance(5 * HOUR);
    src.add("new", "Harlow dispute settled", SETTLED, now());
    src.hold();
    await say(p, now());
    const s = sessionOf(p, user, "s1");
    const remembered = s.delivered.length;
    expect(remembered).toBeGreaterThan(0);
    // The second reading flags both: the withdrawn HOLD goes out again beside NEW.
    maker.ids = [HOLD];
    const read = maker.read.bind(maker);
    maker.read = async (input) => {
      const r = await read(input);
      const i = input.items.findIndex((x) => x.id === NEW);
      return i >= 0
        ? { ...r, bears: [...r.bears, { i, kind: "blocks" as const, why: "the payment details changed" }] }
        : r;
    };
    src.release();
    await until(() => maker.calls.length >= 2);
    await Bun.sleep(20);
    expect(new Set(cited(p.takePending({ ...user, sessionId: "s1" })))).toEqual(new Set([HOLD, NEW]));
    // HOLD's sketch is there once (taken out with its packet, put back with the new one), beside NEW's.
    expect(s.delivered).toHaveLength(remembered + 1);
    expect(s.ledger.isFresh(HOLD, s.turn)).toBe(false);
    expect(s.ledger.isFresh(NEW, s.turn)).toBe(false);
  });

  test("isolation: the withdrawal restores only its own session's ledger (tenant/user#session)", async () => {
    const { p, src, maker, warm, advance, now } = setup({ cueCooldownTurns: 0 });
    const other = { tenantId: "t2", userId: "u1" };
    await warm(user);
    await warm(other);
    advance(5 * HOUR);
    src.add("new", "Harlow dispute settled", SETTLED, now());
    // The other tenant, and the same user's other session, are read with nothing held: HOLD is theirs.
    maker.ids = [HOLD];
    await say(p, now(), other, "s1");
    await Bun.sleep(30);
    maker.ids = [NEW, HOLD];
    const others = [sessionOf(p, other, "s1")];
    const before = others.map((x) => [x.ledger.entry(HOLD), x.ledger.entry(NEW)]);
    expect(before[0]![0]).toBeDefined();
    advance(5 * HOUR); // Stale again for this user.
    src.add("newer", "Harlow dispute settled again", SETTLED, now());
    src.hold();
    await say(p, now(), user, "s1");
    src.release();
    await until(() => maker.calls.filter((c) => c.request === REQUEST).length >= 3);
    await Bun.sleep(20);
    const mine = sessionOf(p, user, "s1");
    expect(mine.ledger.isFresh(HOLD, mine.turn)).toBe(true);
    expect(others.map((x) => [x.ledger.entry(HOLD), x.ledger.entry(NEW)])).toEqual(before);
  });
});

// Audit 2026-11-03b (corr-shared-poll-counts-as-fresh): a lookup that waited on another's poll counts what that poll
// stored, so in a static world no lookup is made again and no push is read again.
describe("syncPollBehind: a lookup waiting on another's poll", () => {
  const counting = (p: ContextPartner) => {
    const open = p as unknown as Open;
    const orig = open.slowPath.bind(p);
    const n = { followUps: 0 };
    open.slowPath = (...a: unknown[]) => {
      if ((a[1] as { followUp?: boolean }).followUp) n.followUps++;
      return orig(...a);
    };
    return n;
  };

  test("two concurrent lookups on a stale static source: no follow-up, no push re-read", async () => {
    const { p, src, traces, warm, advance, now } = setup();
    await warm(user);
    advance(5 * HOUR);
    const n = counting(p);
    src.hold();
    const lists = src.lists;
    const a = say(p, now(), user, "a");
    const b = say(p, now(), user, "b");
    await Bun.sleep(10);
    src.release();
    await Promise.all([a, b]);
    await Bun.sleep(30);
    expect(src.lists - lists).toBe(1);
    expect(n.followUps).toBe(0);
    // One reading per session's request, none again.
    expect(traces.filter((t) => t.decision === "reader-push")).toHaveLength(2);
  });

  test("off readerPush: two concurrent lookups give no follow-up; one stored item gives each exactly one", async () => {
    for (const store of [false, true]) {
      const { p, src, warm, advance, now } = setup({ readerPush: false, readerPushBehind: false });
      await warm(user);
      advance(5 * HOUR);
      if (store) src.add("new", "Harlow dispute settled", "Harlow dispute settled: the invoice may be paid", now());
      const n = counting(p);
      src.hold();
      const a = say(p, now(), user, "a");
      const b = say(p, now(), user, "b");
      await Bun.sleep(10);
      src.release();
      await Promise.all([a, b]);
      await Bun.sleep(30);
      expect(n.followUps).toBe(store ? 2 : 0);
    }
  });

  test("the push as the waiter: no re-read in a static world, one when the poll it waited on stored", async () => {
    for (const store of [false, true]) {
      const { p, src, maker, traces, warm, advance, now } = setup();
      await warm(user);
      advance(5 * HOUR);
      if (store) src.add("new", "Harlow dispute settled", "Harlow dispute settled: the invoice may be paid", now());
      src.hold();
      // The agent's ask in another session polls first and waits for its poll; the request's lookups wait on it.
      const asked = p.ask({ ...user, sessionId: "x", question: "Anything about lunch orders?" });
      await Bun.sleep(5);
      const lists = src.lists;
      await say(p, now());
      expect(src.lists).toBe(lists); // The push and the event's lookup made no listing call of their own.
      src.release();
      await asked;
      await Bun.sleep(30);
      const pushes = traces.filter((t) => t.decision === "reader-push" && t.sessionId === "s1");
      expect(pushes).toHaveLength(store ? 2 : 1);
      expect(maker.calls.filter((c) => c.request === REQUEST).length).toBe(store ? 2 : 1);
    }
  });
});

describe("revisionNotice beside the push's second reading (wave-1 review)", () => {
  test("an item of a packet the second reading withdraws gets no update, though the poll behind revised it", async () => {
    const N0 = itemId("mail", "n0");
    const { p, src, maker, warm, advance, now } = setup({ revisionNotice: true }, [NEW, HOLD, N0]);
    await warm(user);
    advance(10 * 60_000);
    await say(p, now(), user, "s1", "Order the lunch orders for the team");
    p.takePending({ ...user, sessionId: "s1" });
    // The session watches for revisions (it was handed a copy of something else).
    const P = p as any;
    P.watchCopies(P.sessions.get("t1/u1#s1"), [{ id: N0, sourceId: "mail", version: 1 }]);
    advance(5 * HOUR);
    src.items = src.items.filter((i) => i.ref !== "hold");
    src.add(
      "hold",
      "Harlow invoice on hold",
      "Harlow invoice payments are on hold until the audit on 3 December ends",
      now(),
    );
    src.add(
      "new",
      "Harlow dispute settled",
      "Harlow dispute settled: the invoice may be paid, new bank details",
      now(),
    );
    const calls0 = maker.calls.length;
    src.hold();
    await say(p, now());
    src.release();
    await until(() => maker.calls.length >= calls0 + 2);
    await Bun.sleep(30);
    const got = p.takePending({ ...user, sessionId: "s1" });
    const updated = got.filter((g) => g.reason.startsWith("updated:"));
    expect(cited(updated)).not.toContain(HOLD);
  });
});
