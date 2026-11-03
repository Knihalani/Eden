import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type ChatResponse, type Model } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import { StaticSource, type ListPage, type SearchQuery, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import type { Trace } from "./trace";

// `slowPathQueue`: a request that arrives while the session's slow path is busy is kept (one slot, the latest wins)
// and looked up once that slow path settles, instead of being dropped.

const T0 = Date.UTC(2026, 9, 20, 9);

/** A judge that takes `ms` to answer, and picks its first candidate. */
class SlowJudge implements Model {
  readonly id = "slow";
  readonly calls: ChatRequest[] = [];
  private readonly inner = new FakeModel(() => '{"pick": [0]}');
  constructor(private readonly ms: number) {}
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Counted when made, not when answered.
    this.calls.push(request);
    await Bun.sleep(this.ms);
    return this.inner.chat(request);
  }
}

const notes = new StaticSource("notes", "notes", [
  { ref: "globex", title: "Globex renewal", text: "The Globex renewal is due in March at the current price" },
  { ref: "initech", title: "Initech contact", text: "Bill Lumbergh is the Initech contact for the TPS project" },
  { ref: "hooli", title: "Hooli quarterly numbers", text: "Gavin Belson sent the Hooli quarterly numbers on Monday" },
  { ref: "piper", title: "Pied Piper pilot", text: "Richard Hendricks moved the Pied Piper pilot to Thursday" },
]);
const INITECH = itemId("notes", "initech");
const HOOLI = itemId("notes", "hooli");
const PIPER = itemId("notes", "piper");
const FIRST = "anything about the Globex renewal?";
const SECOND = "Who is the contact at Initech, Bill Lumbergh?";

function make(config: Record<string, unknown>) {
  let clock = T0;
  const traces: Trace[] = [];
  const model = new SlowJudge(300);
  const p = new ContextPartner({
    sources: async () => [notes],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model,
    now: () => clock,
    // Nothing is sure enough to skip the judge: every lookup makes its call.
    config: { confidentScore: 5, ...config },
    onTrace: (t) => traces.push(t),
  });
  return { p, traces, model, advance: (ms: number) => (clock += ms), now: () => clock };
}

const ev = (sessionId: string, text: string, userId = "u1") =>
  ({ tenantId: "t1", userId, sessionId, at: T0, kind: "user_message", text }) as AgentEvent;
const cited = (xs: (Injection | null | undefined)[]) => xs.flatMap((x) => x?.citations.map((c) => c.itemId) ?? []);

/**
 * Waits until the judge has had `calls` calls (at most 1 s), then for one more judge call's length and a margin: a
 * second lookup that was going to run has made its call and finished by then.
 */
async function settle(model: SlowJudge, calls: number) {
  for (let i = 0; i < 100 && model.calls.length < calls; i++) await Bun.sleep(10);
  await Bun.sleep(450);
}

describe("slowPathQueue", () => {
  test("on: a request made during the slow path is looked up after it settles, and its context is pending", async () => {
    const { p, traces, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    const r2 = await p.observe(ev("s1", SECOND), { waitMs: 0 });
    expect(r2.injection).toBeNull();
    expect(r2.pending).toBe(true);
    expect(traces.at(-1)?.reason).toBe("slow path busy: queued");
    await first;
    // The second request waits for the first's judge (300 ms); it is not run beside it.
    await Bun.sleep(150);
    expect(model.calls.length).toBe(1);
    await settle(model, 2);
    expect(model.calls.length).toBe(2);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).toContain(INITECH);
  });

  test("off: the request is dropped as before (traced 'slow path busy'), and nothing is delivered for it", async () => {
    const { p, traces, model } = make({});
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    const before = traces.length;
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    expect(traces.slice(before).map((t) => [t.decision, t.reason])).toEqual([["silent", "slow path busy"]]);
    await first;
    await settle(model, 1);
    expect(model.calls.length).toBe(1);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).not.toContain(INITECH);
  });

  test("the latest request wins the slot: an earlier queued one is never looked up", async () => {
    const { p, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    await p.observe(ev("s1", "What did the Hooli procurement team say?"), { waitMs: 0 });
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    await first;
    await settle(model, 2);
    // Two judge calls (first, then the latest), not three.
    expect(model.calls.length).toBe(2);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).toContain(INITECH);
  });

  test("a queued request that waited past the staleness bound is dropped, traced", async () => {
    const { p, traces, model, advance } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    advance(11_000);
    await first;
    await settle(model, 1);
    expect(model.calls.length).toBe(1);
    expect(traces.some((t) => t.reason === "queued cue: stale")).toBe(true);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).not.toContain(INITECH);
  });

  test("a queued request whose session closes is never looked up", async () => {
    const { p, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    await p.observe({ ...ev("s1", ""), kind: "session_end" } as AgentEvent);
    await first;
    await settle(model, 1);
    expect(model.calls.length).toBe(1);
  });

  test("isolation: three sessions busy at once each look up only their own queued request", async () => {
    const { p, traces, model } = make({ slowPathQueue: true });
    // Same tenant: a (user u1), b (another user, u2), c (the same user u1, another session). All three are busy with
    // their own slow path, and each queues a different request while it is.
    const sessions = [
      { sessionId: "a", userId: "u1", queued: SECOND, item: INITECH },
      { sessionId: "b", userId: "u2", queued: "When is the Pied Piper pilot with Richard Hendricks?", item: PIPER },
      { sessionId: "c", userId: "u1", queued: "Did Gavin Belson send the Hooli quarterly numbers?", item: HOOLI },
    ];
    const firsts = sessions.map((x) => p.observe(ev(x.sessionId, FIRST, x.userId), { waitMs: 0 }));
    await Bun.sleep(20);
    for (const x of sessions) {
      const r = await p.observe(ev(x.sessionId, x.queued, x.userId), { waitMs: 0 });
      expect(r.pending).toBe(true);
    }
    expect(traces.filter((t) => t.reason === "slow path busy: queued").map((t) => t.sessionId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    await Promise.all(firsts);
    await settle(model, 6);
    // Two judge calls per session: its first request, then its own queued one; none ran twice or in another session.
    expect(model.calls.length).toBe(6);
    const perSession = new Map<string, number>();
    for (const t of traces) if (t.modelCalls > 0) perSession.set(t.sessionId, (perSession.get(t.sessionId) ?? 0) + 1);
    expect(Object.fromEntries(perSession)).toEqual({ a: 2, b: 2, c: 2 });
    for (const x of sessions) {
      const got = cited(p.takePending({ tenantId: "t1", userId: x.userId, sessionId: x.sessionId }));
      expect(got).toContain(x.item);
      for (const other of sessions) if (other.item !== x.item) expect(got).not.toContain(other.item);
    }
  });
});

/** A connector with a recent-first list call that can be held open. */
class HeldListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
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
  /** Finds nothing: what the lookup knows of this source comes from the synced index only. */
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    if (this.held) await this.held;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** A source searched live whose search takes `ms`: it keeps a lookup busy with no model. */
class SlowSearch implements Source {
  readonly kind = "test";
  readonly description = "test";
  readonly id = "wiki";
  constructor(private readonly ms: number) {}
  async search(): Promise<ContextItem[]> {
    await Bun.sleep(this.ms);
    return [];
  }
}

test("with syncPollBehind, the queued lookup gets the follow-up on the fresh index, as any lookup does", async () => {
  const H = 3_600_000;
  const traces: Trace[] = [];
  let clock = T0;
  const mail = new HeldListSource("mail");
  for (let i = 0; i < 4; i++) mail.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * H);
  const p = new ContextPartner({
    sources: async () => [mail, new SlowSearch(300)],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      sync: true,
      syncPageSize: 2,
      syncCallsPerMin: 600,
      syncMaxStaleMs: 5_000,
      syncPollBehind: true,
      slowPathQueue: true,
    },
    onTrace: (t) => traces.push(t),
  });
  const scope = { tenantId: "t1", userId: "u1" };
  p.sync!.track(scope);
  while (!p.sync!.warm(scope)) await p.sync!.tick();
  clock += 6_000;
  const say = (text: string) =>
    p.observe({ ...scope, sessionId: "s1", at: clock, kind: "user_message", text } as AgentEvent, { waitMs: 0 });
  // The first request polls the stale mail (not held) and waits on the slow search.
  const first = say("anything new on the lunch orders note?");
  await Bun.sleep(20);
  expect((await say("When is the Dana Lee budget review?")).pending).toBe(true);
  // Stale again when the queued request runs, and its poll is held: it answers from the index as it stood, and only
  // its follow-up can see the new mail.
  clock += 6_000;
  mail.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", clock);
  mail.hold();
  await first;
  // Both lookups (300 ms of slow search each) are done by now; the queued one's poll is still held.
  await Bun.sleep(800);
  expect(traces.filter((t) => t.event === "user_message" && t.reason !== "slow path busy: queued").length).toBe(2);
  expect(cited(p.takePending({ ...scope, sessionId: "s1" }))).not.toContain(itemId("mail", "new"));
  mail.release();
  // The follow-up waits for the poll, then looks again (another 300 ms of slow search).
  await Bun.sleep(700);
  expect(cited(p.takePending({ ...scope, sessionId: "s1" }))).toContain(itemId("mail", "new"));
});
