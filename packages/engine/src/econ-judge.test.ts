import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type ChatResponse, type Model } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import { StaticSource, type ListPage, type SearchQuery, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner, type PartnerDeps } from "./partner";
import type { Trace } from "./trace";

// docs/research/econ-judge.md: the judge off the critical path (`judgeBehind`), and a lookup that does not wait for
// the sync's on-demand poll (`syncPollBehind`).

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const scope = { tenantId: "t1", userId: "u1" };
const ids = (xs: (Injection | null)[]) => xs.flatMap((x) => x?.citations.map((c) => c.itemId) ?? []);

/** A model whose answer waits until `release` is called: the test sees what the engine does meanwhile. */
class GatedModel implements Model {
  readonly id = "gated";
  readonly calls: ChatRequest[] = [];
  private open!: () => void;
  private readonly gate = new Promise<void>((r) => (this.open = r));
  constructor(private readonly reply: string) {}
  release(): void {
    this.open();
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    await this.gate;
    return {
      text: this.reply,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
      costUsd: 0.0001,
      model: this.id,
      latencyMs: 0,
      truncated: false,
    };
  }
}

describe("judgeBehind: the judge off the critical path", () => {
  const notes = new StaticSource("notes", "notes", [
    {
      ref: "qbr",
      title: "Quarterly budget review",
      text: "Marketing budget review outcome: approved with travel cuts",
    },
    {
      ref: "memo",
      title: "Travel memo",
      text: "After the quarterly marketing budget review, travel is frozen until reissue",
    },
    { ref: "other", title: "Office plants", text: "Water the office plants on Fridays" },
  ]);
  const ask = "what was the outcome of the quarterly marketing budget review";
  let clock = T0;
  const ev = (sessionId: string, text: string) =>
    ({ ...scope, sessionId, at: clock++, kind: "user_message", text }) as AgentEvent;
  const make = (model: Model | null, extra: Partial<PartnerDeps> = {}, config: Record<string, unknown> = {}) => {
    const traces: Trace[] = [];
    const p = new ContextPartner({
      sources: async () => [notes],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model,
      onTrace: (t) => traces.push(t),
      config: { judgeBehind: true, ...config },
      ...extra,
    });
    return { p, traces };
  };

  test("the lookup answers as with no model, without waiting; the judge only adds what that answer left out", async () => {
    const model = new GatedModel('{"pick": [0]}');
    const { p, traces } = make(model);
    const r = await p.observe(ev("a", ask), { waitMs: 1_000 });
    // The no-model answer (D36's fallback here) went out while the judge's call was still open.
    expect(ids([r.injection])).toEqual(["notes:qbr"]);
    expect(model.calls).toHaveLength(1);
    // The judge saw only what the answer left out, never the delivered item.
    expect(JSON.stringify(model.calls[0]!.messages)).not.toContain("Marketing budget review outcome");
    expect(p.takePending({ ...scope, sessionId: "a" })).toEqual([]);
    model.release();
    await Bun.sleep(5);
    const later = p.takePending({ ...scope, sessionId: "a" });
    expect(later).toHaveLength(1);
    expect(later[0]!.reason).toStartWith("model:");
    expect(ids(later)).not.toContain("notes:qbr");
    const judged = traces.find((t) => t.reason.startsWith("judge-behind"));
    expect(judged).toMatchObject({ decision: "model", modelCalls: 1, costUsd: 0.0001 });
  });

  test("off by default: with a model, the judge decides on the critical path as before", async () => {
    const model = new FakeModel(() => '{"pick": []}');
    const traces: Trace[] = [];
    const p = new ContextPartner({
      sources: async () => [notes],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model,
      onTrace: (t) => traces.push(t),
    });
    const r = await p.observe(ev("off", ask), { waitMs: 1_000 });
    expect(r.injection).toBeNull();
    expect(model.calls).toHaveLength(1);
    expect(traces.some((t) => t.reason.startsWith("judge-behind"))).toBe(false);
  });

  test("a judge that says none, fails or is over budget changes nothing about the answer", async () => {
    const none = new FakeModel(() => '{"pick": []}');
    const a = make(none);
    expect(ids([(await a.p.observe(ev("n", ask), { waitMs: 1_000 })).injection])).toEqual(["notes:qbr"]);
    await Bun.sleep(5);
    expect(a.p.takePending({ ...scope, sessionId: "n" })).toEqual([]);
    expect(none.calls).toHaveLength(1);

    const broken: Model = {
      id: "broken",
      chat: async () => {
        throw new Error("model 402: spend limit");
      },
    };
    const b = make(broken);
    expect(ids([(await b.p.observe(ev("b", ask), { waitMs: 1_000 })).injection])).toEqual(["notes:qbr"]);
    await Bun.sleep(5);
    expect(b.p.takePending({ ...scope, sessionId: "b" })).toEqual([]);

    const pricey = new FakeModel(() => '{"pick": [0]}');
    const broke = new Budget({ callsPerSession: 0, usdPerSession: 1, usdPerUserDay: 1 });
    const c = make(pricey, { budget: broke });
    expect(ids([(await c.p.observe(ev("c", ask), { waitMs: 1_000 })).injection])).toEqual(["notes:qbr"]);
    expect(pricey.calls).toHaveLength(0);
  });

  test("a session that ends while the judge reads delivers nothing later, and its budget is released", async () => {
    const model = new GatedModel('{"pick": [0]}');
    const budget = new Budget();
    const { p } = make(model, { budget });
    await p.observe(ev("gone", ask), { waitMs: 1_000 });
    await p.observe({ ...scope, sessionId: "gone", at: clock++, kind: "session_end" } as AgentEvent);
    model.release();
    await Bun.sleep(5);
    expect(p.takePending({ ...scope, sessionId: "gone" })).toEqual([]);
    expect(budget.size.sessions).toBe(0);
  });
});

/** A connector with a recent-first list call that can be held open (`hold`), to see what a lookup waits for. */
class SlowListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  searches = 0;
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
    this.searches++;
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

describe("syncPollBehind: the first packet does not wait for the on-demand poll", () => {
  const setup = (config: Record<string, unknown> = {}) => {
    let clock = T0;
    const src = new SlowListSource("mail");
    src.add("old", "Dana Lee: budget", "Dana Lee says the budget review moved to Friday", T0 - 2 * HOUR);
    for (let i = 0; i < 4; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * HOUR);
    const p = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { sync: true, syncPageSize: 2, syncCallsPerMin: 600, syncMaxStaleMs: 4 * HOUR, ...config },
    });
    const warm = async (s: Scope) => {
      p.sync!.track(s);
      while (!p.sync!.warm(s)) await p.sync!.tick();
    };
    return { p, src, warm, advance: (ms: number) => (clock += ms), now: () => clock };
  };
  const say = (p: ContextPartner, text: string, at: number, s: Scope = scope, sessionId = "s1") =>
    p.observe({ ...s, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });

  test("the index answers while the poll is held; what the poll brings is looked up again and queued", async () => {
    const { p, src, warm, advance, now } = setup({ syncPollBehind: true });
    await warm(scope);
    advance(5 * HOUR); // Stale: the lookup polls.
    src.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", now());
    src.hold();
    const lists = src.lists;
    const r = await say(p, "When is the Dana Lee budget review?", now());
    // Answered from the index as it stood, with the listing call still open.
    expect(src.lists - lists).toBe(1);
    expect(ids([r.injection])).toEqual([itemId("mail", "old")]);
    expect(p.takePending({ ...scope, sessionId: "s1" })).toEqual([]);
    src.release();
    await Bun.sleep(10);
    expect(ids(p.takePending({ ...scope, sessionId: "s1" }))).toContain(itemId("mail", "new"));
    expect(p.sync!.current(scope, "mail")).toBe(true);
  });

  test("off by default: the lookup waits for the poll and answers from what it brought", async () => {
    const { p, src, warm, advance, now } = setup();
    await warm(scope);
    advance(5 * HOUR);
    src.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", now());
    src.hold();
    const pending = say(p, "When is the Dana Lee budget review?", now());
    let done = false;
    void pending.then(() => (done = true));
    await Bun.sleep(10);
    expect(done).toBe(false);
    src.release();
    const r = await pending;
    expect(ids([r.injection, ...p.takePending({ ...scope, sessionId: "s1" })])).toContain(itemId("mail", "new"));
  });

  test("the agent's ask still waits for the poll", async () => {
    const { p, src, warm, advance, now } = setup({ syncPollBehind: true });
    await warm(scope);
    advance(5 * HOUR);
    src.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", now());
    src.hold();
    await say(p, "When is the Dana Lee budget review?", now());
    const asked = p.ask({ ...scope, sessionId: "s1", question: "Dana Lee budget review cancelled?" });
    let done = false;
    void asked.then(() => (done = true));
    await Bun.sleep(10);
    expect(done).toBe(false);
    src.release();
    expect((await asked).citations.map((c) => c.itemId)).toContain(itemId("mail", "new"));
  });

  test("isolation: one user's poll and follow-up never reach another user's session, nor a forgotten one", async () => {
    const { p, src, warm, advance, now } = setup({ syncPollBehind: true });
    const other = { tenantId: "t1", userId: "u2" };
    await warm(scope);
    await warm(other);
    advance(5 * HOUR);
    src.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", now());
    src.hold();
    await say(p, "When is the Dana Lee budget review?", now());
    await say(p, "Any lunch orders note?", now(), other, "s2");
    // The first user is forgotten while their poll is held: nothing lands in any session afterwards.
    p.forget(scope);
    src.release();
    await Bun.sleep(10);
    expect(p.takePending({ ...scope, sessionId: "s1" })).toEqual([]);
    expect(ids(p.takePending({ ...other, sessionId: "s2" }))).not.toContain(itemId("mail", "new"));
  });

  test("syncOnDemand off: no poll runs, so a stale copy does not answer the lookup (the flag needs the poll)", async () => {
    const run = async (config: Record<string, unknown>) => {
      const { p, src, warm, advance, now } = setup({ syncOnDemand: false, ...config });
      await warm(scope);
      advance(5 * HOUR);
      const searches = src.searches;
      const r = await say(p, "When is the Dana Lee budget review?", now());
      return { searched: src.searches - searches, ids: ids([r.injection]) };
    };
    const off = await run({});
    // Without the poll that would bring it current, the stale source is searched live, flag on or off.
    expect(off.searched).toBeGreaterThan(0);
    expect(await run({ syncPollBehind: true })).toEqual(off);
  });
});

// The synthesis's dynamic-world test: the simulated worlds are static, so no benchmark poll ever stored anything and
// the follow-up lookup never ran there. Here the world changes while the lookup's poll is held open: an item that
// arrives during the background poll must reach the agent through the follow-up delivery (its next request), not
// only through `ask_context`.
describe("syncPollBehind in a changing world: an item arriving during the background poll", () => {
  const setup = () => {
    let clock = T0;
    const src = new SlowListSource("mail");
    src.add("old", "Dana Lee: budget", "Dana Lee says the budget review moved to Friday", T0 - 2 * HOUR);
    for (let i = 0; i < 4; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * HOUR);
    const traces: Trace[] = [];
    const p = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      onTrace: (t) => traces.push(t),
      config: {
        sync: true,
        syncPollBehind: true,
        syncPageSize: 2,
        syncCallsPerMin: 600,
        syncMaxStaleMs: 4 * HOUR,
      },
    });
    const warm = async () => {
      p.sync!.track(scope);
      while (!p.sync!.warm(scope)) await p.sync!.tick();
    };
    return { p, src, traces, warm, advance: (ms: number) => (clock += ms), now: () => clock };
  };
  const say = (p: ContextPartner, text: string, at: number, sessionId = "s1") =>
    p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  /** Waits for the work the session's lookup left behind (the poll and its follow-up), as the funnel does. */
  const settle = async (p: ContextPartner) => {
    const table = (p as unknown as { sessions: Map<string, { inflight: unknown; behind?: unknown }> }).sessions;
    for (let k = 0; k < 500 && [...table.values()].some((x) => x.inflight || x.behind); k++) await Bun.sleep(1);
  };

  test("after silence: the item arrives mid-poll, the follow-up decides on it and the next request carries it", async () => {
    const { p, src, warm, advance, now } = setup();
    await warm();
    advance(5 * HOUR);
    src.hold();
    const r = await say(p, "Is the Priya Raman offsite still on?", now());
    // Nothing in the index answers it, and the listing is still open: the first answer is silence, at once.
    expect(r.injection).toBeNull();
    // The world changes while the poll is out: the listing returns what is there when it answers.
    src.add("offsite", "Priya Raman: offsite cancelled", "Priya Raman cancelled the offsite on Friday", now());
    src.release();
    await settle(p);
    // Not left for `ask_context`: the follow-up queued it, and the agent's next request carries it.
    const next = await say(p, "thanks", now() + 1);
    expect(ids([next.injection])).toContain(itemId("mail", "offsite"));
  });

  test("after a delivery: the follow-up adds the arriving item and never repeats the first delivery", async () => {
    const { p, src, warm, advance, now } = setup();
    await warm();
    advance(5 * HOUR);
    src.hold();
    const r = await say(p, "When is the Dana Lee budget review?", now());
    expect(ids([r.injection])).toEqual([itemId("mail", "old")]);
    src.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", now());
    src.release();
    await settle(p);
    const later = ids(p.takePending({ ...scope, sessionId: "s1" }));
    expect(later).toContain(itemId("mail", "new"));
    expect(later).not.toContain(itemId("mail", "old"));
  });

  test("precision: an unrelated item arriving mid-poll is stored but delivered by no follow-up", async () => {
    const { p, src, traces, warm, advance, now } = setup();
    await warm();
    advance(5 * HOUR);
    src.hold();
    await say(p, "When is the Dana Lee budget review?", now());
    src.add("noise", "Gym schedule", "The gym is closed for cleaning on Sunday", now());
    src.release();
    await settle(p);
    // The poll stored it (the source is current again), so a follow-up lookup ran; it found nothing new to say.
    expect(p.sync!.current(scope, "mail")).toBe(true);
    expect(traces.filter((t) => t.event === "user_message" && t.decision !== "skipped").length).toBeGreaterThan(1);
    expect(ids(p.takePending({ ...scope, sessionId: "s1" }))).toEqual([]);
  });

  test("two requests made while one poll is out: each gets its follow-up on the fresh index", async () => {
    const { p, src, warm, advance, now } = setup();
    await warm();
    advance(5 * HOUR);
    src.hold();
    await say(p, "When is the Dana Lee budget review?", now());
    // A second request while the same poll is out: it waits on that poll too, and answered from the old index.
    const r = await say(p, "Is the Priya Raman offsite still on?", now() + 1);
    expect(r.injection).toBeNull();
    src.add("offsite", "Priya Raman: offsite cancelled", "Priya Raman cancelled the offsite on Friday", now());
    src.release();
    await settle(p);
    expect(ids(p.takePending({ ...scope, sessionId: "s1" }))).toContain(itemId("mail", "offsite"));
  });
});

// D66 with D65: a source that pushes its changes (`syncPush`) is current while quiet, so a lookup polls it neither on
// the path nor behind; poll-behind applies only to a source that is not current: one with an unread notice, or one
// whose watch has gone quiet past `syncPushMaxStaleMs` (a lapsed watch), which falls back to poll-behind, never to an
// on-path poll.
describe("syncPollBehind with syncPush", () => {
  const setup = (config: Record<string, unknown> = {}) => {
    let clock = T0;
    const src = new SlowListSource("mail");
    src.add("old", "Dana Lee: budget", "Dana Lee says the budget review moved to Friday", T0 - 2 * HOUR);
    for (let i = 0; i < 4; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * HOUR);
    const p = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: {
        sync: true,
        syncPush: true,
        syncPollBehind: true,
        syncPageSize: 2,
        syncCallsPerMin: 600,
        syncMaxStaleMs: 4 * HOUR,
        ...config,
      },
    });
    const warm = async () => {
      p.sync!.track(scope);
      while (!p.sync!.warm(scope)) await p.sync!.tick();
      p.sourcePushes(scope, "mail");
    };
    return { p, src, warm, advance: (ms: number) => (clock += ms), now: () => clock };
  };
  /** The observe, and whether it answered within 20 ms (an on-path poll held open would keep it waiting). */
  const timed = async (p: ContextPartner, text: string, at: number) => {
    let done = false;
    const r = p
      .observe({ ...scope, sessionId: "s1", at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 })
      .then((x) => ((done = true), x));
    await Bun.sleep(20);
    return { quick: done, r };
  };
  const settle = async (p: ContextPartner) => {
    const table = (p as unknown as { sessions: Map<string, { inflight: unknown; behind?: unknown }> }).sessions;
    for (let k = 0; k < 500 && [...table.values()].some((x) => x.inflight || x.behind); k++) await Bun.sleep(1);
  };
  const arrive = (src: SlowListSource, now: number) =>
    src.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", now);

  test("a quiet pushed source is current past syncMaxStaleMs: no poll, on the path or behind", async () => {
    const { p, src, warm, advance, now } = setup();
    await warm();
    advance(5 * HOUR); // Past syncMaxStaleMs: without the watch, the lookup would poll.
    const lists = src.lists;
    src.hold();
    const { quick, r } = await timed(p, "When is the Dana Lee budget review?", now());
    expect(quick).toBe(true);
    expect(ids([(await r).injection])).toEqual([itemId("mail", "old")]);
    src.release();
    await settle(p);
    expect(src.lists).toBe(lists);
  });

  test("an unread notice: the lookup answers from the index and the poll runs behind it", async () => {
    const { p, src, warm, advance, now } = setup();
    await warm();
    // Past syncMaxStaleMs, so the fast path does not answer from the copy it read: the lookup reaches the index.
    advance(5 * HOUR);
    arrive(src, now());
    p.sourceChanged(scope, "mail");
    expect(p.sync!.current(scope, "mail")).toBe(false);
    src.hold();
    const lists = src.lists;
    const { quick, r } = await timed(p, "When is the Dana Lee budget review?", now());
    expect(quick).toBe(true);
    expect(ids([(await r).injection])).toEqual([itemId("mail", "old")]);
    expect(src.lists - lists).toBe(1);
    src.release();
    await settle(p);
    expect(ids(p.takePending({ ...scope, sessionId: "s1" }))).toContain(itemId("mail", "new"));
    expect(p.sync!.current(scope, "mail")).toBe(true);
  });

  test("a lapsed watch falls back to poll-behind, not to an on-path poll", async () => {
    const { p, src, warm, advance, now } = setup();
    await warm();
    // No notice and no poll for longer than syncPushMaxStaleMs: the watch is not trusted any more.
    advance(DEFAULT_CONFIG.syncPushMaxStaleMs + HOUR);
    expect(p.sync!.current(scope, "mail")).toBe(false);
    arrive(src, now());
    src.hold();
    const lists = src.lists;
    const { quick, r } = await timed(p, "When is the Dana Lee budget review?", now());
    expect(quick).toBe(true);
    expect(ids([(await r).injection])).toEqual([itemId("mail", "old")]);
    expect(src.lists - lists).toBe(1);
    src.release();
    await settle(p);
    expect(ids(p.takePending({ ...scope, sessionId: "s1" }))).toContain(itemId("mail", "new"));
    // Polled now, the pushed source is current again until its next notice.
    expect(p.sync!.current(scope, "mail")).toBe(true);
  });

  test("without syncPollBehind, the lapsed watch's poll is on the path (D57's on-demand poll)", async () => {
    const { p, src, warm, advance, now } = setup({ syncPollBehind: false });
    await warm();
    advance(DEFAULT_CONFIG.syncPushMaxStaleMs + HOUR);
    arrive(src, now());
    src.hold();
    const { quick, r } = await timed(p, "When is the Dana Lee budget review?", now());
    expect(quick).toBe(false);
    src.release();
    const got = await r;
    expect(ids([got.injection, ...p.takePending({ ...scope, sessionId: "s1" })])).toContain(itemId("mail", "new"));
  });
});
