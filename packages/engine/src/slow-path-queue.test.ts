import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type ChatResponse, type Model } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import { StaticSource, type ListPage, type SearchQuery, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import type { Trace } from "./trace";
import { CORE_CONFIG } from "./parts";

// `slowPathQueue`: a request that arrives while the session's slow path is busy is kept (one slot, the latest wins)
// and looked up once that slow path settles, instead of being dropped.
//
// No test here sleeps. The judge and the slow search hold each call until the test answers it, so the order of events
// is the test's: it sees a call made, holds it, and checks what may or may not run meanwhile (the interleavings the
// sleeps used to stand for). `turns` lets the engine run every step it can take on its own, with no wall-clock wait.

const T0 = Date.UTC(2026, 9, 20, 9);

/** A promise and the function that settles it, for calls a test holds open. */
class Gate {
  private readonly waiting: (() => void)[] = [];
  /** Calls made so far, held or answered. */
  made = 0;
  wait(): Promise<void> {
    this.made++;
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  /** Answers the oldest call still held. */
  release(): void {
    const next = this.waiting.shift();
    if (!next) throw new Error("no call is held");
    next();
  }
  get held(): number {
    return this.waiting.length;
  }
}

/** A judge whose every call is held until the test releases it, and which then picks its first candidate. */
class HeldJudge implements Model {
  readonly id = "held";
  readonly calls: ChatRequest[] = [];
  readonly gate = new Gate();
  private readonly inner = new FakeModel(() => '{"pick": [0]}');
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Counted when made, not when answered.
    this.calls.push(request);
    await this.gate.wait();
    return this.inner.chat(request);
  }
  release(): void {
    this.gate.release();
  }
}

/** One turn of the event loop: the promises ready now, and the immediates and I/O due, have run. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Lets the engine take every step it can without the test: a lookup that was going to start (and make its judge or
 * search call) has done so by then. Its cost is event-loop turns, not a wall-clock wait.
 */
async function turns(n = 100) {
  for (let i = 0; i < n; i++) await turn();
}

/** Turns the event loop until `cond` holds; fails, rather than hanging, if it never does. */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 5_000 && !cond(); i++) await turn();
  if (!cond()) throw new Error(`never happened: ${what}`);
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
  const model = new HeldJudge();
  const p = new ContextPartner({
    sources: async () => [notes],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model,
    now: () => clock,
    // Nothing is sure enough to skip the judge: every lookup makes its call.
    config: { ...CORE_CONFIG, confidentScore: 5, ...config },
    onTrace: (t) => traces.push(t),
  });
  return { p, traces, model, advance: (ms: number) => (clock += ms), now: () => clock };
}

const ev = (sessionId: string, text: string, userId = "u1") =>
  ({ tenantId: "t1", userId, sessionId, at: T0, kind: "user_message", text }) as AgentEvent;
const cited = (xs: (Injection | null | undefined)[]) => xs.flatMap((x) => x?.citations.map((c) => c.itemId) ?? []);
/** Lookups that made their judge call and finished: each traces once, with its call counted. */
const judged = (traces: Trace[]) => traces.filter((t) => t.modelCalls > 0).length;

describe("slowPathQueue", () => {
  test("on: a request made during the slow path is looked up after it settles, and its context is pending", async () => {
    const { p, traces, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    // The first lookup is busy: its judge call is made and held.
    await until(() => model.calls.length === 1, "the first judge call");
    const r2 = await p.observe(ev("s1", SECOND), { waitMs: 0 });
    expect(r2.injection).toBeNull();
    expect(r2.pending).toBe(true);
    expect(traces.at(-1)?.reason).toBe("slow path busy: queued");
    await first;
    // The second request waits for the first's judge; it is not run beside it, however long that judge takes.
    await turns();
    expect(model.calls.length).toBe(1);
    model.release();
    await until(() => model.calls.length === 2, "the queued request's judge call");
    model.release();
    await until(() => judged(traces) === 2, "the queued lookup done");
    await turns();
    expect(model.calls.length).toBe(2);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).toContain(INITECH);
  });

  test("off: the request is dropped as before (traced 'slow path busy'), and nothing is delivered for it", async () => {
    const { p, traces, model } = make({});
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await until(() => model.calls.length === 1, "the first judge call");
    const before = traces.length;
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    expect(traces.slice(before).map((t) => [t.decision, t.reason])).toEqual([["silent", "slow path busy"]]);
    await first;
    model.release();
    await until(() => judged(traces) === 1, "the first lookup done");
    // Had the dropped request been kept, its lookup would have made its call by now.
    await turns();
    expect(model.calls.length).toBe(1);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).not.toContain(INITECH);
  });

  test("the latest request wins the slot: an earlier queued one is never looked up", async () => {
    const { p, traces, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await until(() => model.calls.length === 1, "the first judge call");
    await p.observe(ev("s1", "What did the Hooli procurement team say?"), { waitMs: 0 });
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    await first;
    model.release();
    await until(() => model.calls.length === 2, "the latest request's judge call");
    model.release();
    await until(() => judged(traces) === 2, "the latest request's lookup done");
    await turns();
    // Two judge calls (first, then the latest), not three.
    expect(model.calls.length).toBe(2);
    expect(model.gate.held).toBe(0);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).toContain(INITECH);
  });

  test("a queued request that waited past the staleness bound is dropped, traced", async () => {
    const { p, traces, model, advance } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await until(() => model.calls.length === 1, "the first judge call");
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    advance(11_000);
    await first;
    model.release();
    await until(() => traces.some((t) => t.reason === "queued cue: stale"), "the stale request dropped");
    await turns();
    expect(model.calls.length).toBe(1);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).not.toContain(INITECH);
  });

  test("a queued request whose session closes is never looked up", async () => {
    const { p, traces, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await until(() => model.calls.length === 1, "the first judge call");
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    await p.observe({ ...ev("s1", ""), kind: "session_end" } as AgentEvent);
    await first;
    model.release();
    await turns();
    expect(model.calls.length).toBe(1);
    expect(traces.some((t) => t.reason === "slow path busy: queued")).toBe(true);
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
    await until(() => model.calls.length === 3, "each session's first judge call");
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
    // None of the queued requests runs while its session's first judge call is held.
    await turns();
    expect(model.calls.length).toBe(3);
    for (let i = 0; i < 3; i++) model.release();
    await until(() => model.calls.length === 6, "each session's queued judge call");
    for (let i = 0; i < 3; i++) model.release();
    await until(() => judged(traces) === 6, "every lookup done");
    await turns();
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
  /** List calls waiting on `hold` right now. */
  blocked = 0;
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
    if (this.held) {
      this.blocked++;
      await this.held;
      this.blocked--;
    }
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** A source searched live whose every search is held until the test releases it: it keeps a lookup busy, no model. */
class HeldSearch implements Source {
  readonly kind = "test";
  readonly description = "test";
  readonly id = "wiki";
  readonly gate = new Gate();
  async search(): Promise<ContextItem[]> {
    await this.gate.wait();
    return [];
  }
}

test("with syncPollBehind, the queued lookup gets the follow-up on the fresh index, as any lookup does", async () => {
  const H = 3_600_000;
  const traces: Trace[] = [];
  let clock = T0;
  const mail = new HeldListSource("mail");
  const wiki = new HeldSearch();
  for (let i = 0; i < 4; i++) mail.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * H);
  const p = new ContextPartner({
    sources: async () => [mail, wiki],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
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
  const looked = () => traces.filter((t) => t.event === "user_message" && t.reason !== "slow path busy: queued");
  // The first request polls the stale mail (not held) and waits on the slow search, which is held.
  const first = say("anything new on the lunch orders note?");
  await until(() => wiki.gate.made === 1, "the first lookup's search");
  expect((await say("When is the Dana Lee budget review?")).pending).toBe(true);
  // Stale again when the queued request runs, and its poll is held: it answers from the index as it stood, and only
  // its follow-up can see the new mail.
  clock += 6_000;
  mail.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", clock);
  mail.hold();
  await first;
  // Not before the first lookup's search answers.
  await turns();
  expect(wiki.gate.made).toBe(1);
  wiki.gate.release();
  await until(() => wiki.gate.made === 2, "the queued lookup's search");
  wiki.gate.release();
  await until(() => looked().length === 2, "both lookups done");
  // Both lookups are done; the queued one's poll is still held, so no follow-up has searched.
  await turns();
  expect(mail.blocked).toBe(1);
  expect(wiki.gate.made).toBe(2);
  expect(looked().length).toBe(2);
  expect(cited(p.takePending({ ...scope, sessionId: "s1" }))).not.toContain(itemId("mail", "new"));
  mail.release();
  // The follow-up waits for the poll, then looks again on the fresh index (a search it makes is answered at once: the
  // planner, not this test, decides whether the follow-up searches the wiki again).
  await until(() => {
    if (wiki.gate.held > 0) wiki.gate.release();
    return looked().length === 3;
  }, "the follow-up done");
  await turns();
  expect(looked().at(-1)?.itemIds).toContain(itemId("mail", "new"));
  expect(cited(p.takePending({ ...scope, sessionId: "s1" }))).toContain(itemId("mail", "new"));
});
