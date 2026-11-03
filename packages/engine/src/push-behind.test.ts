import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { AskReader, type ReaderInput, type ReaderKind, type ReaderMaker } from "./reader";
import type { Trace } from "./trace";

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
  constructor(private readonly ids: string[]) {}
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
