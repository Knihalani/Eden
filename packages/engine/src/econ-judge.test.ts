import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type Model } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import type { Trace } from "./trace";
import { CORE_CONFIG } from "./parts";

// docs/research/econ-judge.md: a lookup that does not wait for the sync's on-demand poll (`syncPollBehind`).

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const scope = { tenantId: "t1", userId: "u1" };
const ids = (xs: (Injection | null)[]) => xs.flatMap((x) => x?.citations.map((c) => c.itemId) ?? []);

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
      config: {
        ...CORE_CONFIG,
        sync: true,
        syncPageSize: 2,
        syncCallsPerMin: 600,
        syncMaxStaleMs: 4 * HOUR,
        ...config,
      },
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

  test("off (the core): the lookup waits for the poll and answers from what it brought", async () => {
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
        ...CORE_CONFIG,
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

// Review of D65 (PR 2): a corrected copy reaches the agent, `pending` covers work left behind, and a follow-up never
// makes a second judge call.
describe("syncPollBehind: review regressions", () => {
  const mk = (config: Record<string, unknown>, model: Model | null = null) => {
    let clock = T0;
    const src = new SlowListSource("mail");
    src.add("old", "Dana Lee: budget", "Dana Lee says the budget review moved to Friday", T0 - 2 * HOUR);
    for (let i = 0; i < 4; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * HOUR);
    const p = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model,
      now: () => clock,
      config: {
        ...CORE_CONFIG,
        sync: true,
        syncPageSize: 2,
        syncCallsPerMin: 600,
        syncMaxStaleMs: 4 * HOUR,
        ...config,
      },
    });
    const warm = async () => {
      p.sync!.track(scope);
      while (!p.sync!.warm(scope)) await p.sync!.tick();
    };
    return { p, src, warm, advance: (ms: number) => (clock += ms), now: () => clock };
  };
  const say = (p: ContextPartner, text: string, at: number) =>
    p.observe({ ...scope, sessionId: "s1", at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  const settle = async (p: ContextPartner) => {
    const table = (p as unknown as { sessions: Map<string, { inflight: unknown; behind?: unknown }> }).sessions;
    for (let k = 0; k < 500 && [...table.values()].some((x) => x.inflight || x.behind); k++) await Bun.sleep(1);
  };
  /** Edits the warm item `old` in place at its source: same ref and id, new words. */
  const edit = (src: SlowListSource, at: number) => {
    src.items = src.items.filter((i) => i.ref !== "old");
    src.add("old", "Dana Lee: budget", "Dana Lee says the budget review is CANCELLED", at);
  };

  test("an item edited in place during the poll: the corrected copy follows the superseded one (D40)", async () => {
    for (const on of [false, true]) {
      const { p, src, warm, advance, now } = mk({ syncPollBehind: on });
      await warm();
      advance(5 * HOUR);
      edit(src, now());
      src.hold();
      const asked = say(p, "When is the Dana Lee budget review?", now());
      // Flag on, the answer is out before the release; off, it waits for it.
      await Bun.sleep(5);
      src.release();
      const r = await asked;
      await settle(p);
      const all = [r.injection, ...p.takePending({ ...scope, sessionId: "s1" })];
      const texts = all.map((x) => x?.text ?? "");
      // Flag off, the lookup waited for the poll: only the current copy. On, the index answered with the old copy at
      // once, and the follow-up delivers the edit as it now reads; nothing stale is left standing.
      expect(texts.at(-1)).toContain("CANCELLED");
      if (!on) expect(texts.join()).not.toContain("moved to Friday");
      expect(ids(all).filter((id) => id === itemId("mail", "old")).length).toBe(on ? 2 : 1);
    }
  });

  test("an unchanged item the follow-up meets again is still not repeated", async () => {
    const { p, src, warm, advance, now } = mk({ syncPollBehind: true });
    await warm();
    advance(5 * HOUR);
    src.hold();
    await say(p, "When is the Dana Lee budget review?", now());
    // The poll stores something (so a follow-up runs) but `old` is listed with the same words.
    src.add("noise", "Gym schedule", "The gym is closed for cleaning on Sunday", now());
    src.release();
    await settle(p);
    expect(ids(p.takePending({ ...scope, sessionId: "s1" }))).not.toContain(itemId("mail", "old"));
  });

  test("observe reports pending while a poll-behind follow-up may still queue an injection", async () => {
    const { p, src, warm, advance, now } = mk({ syncPollBehind: true });
    await warm();
    advance(5 * HOUR);
    src.hold();
    const r = await say(p, "Is the Priya Raman offsite still on?", now());
    expect(r.injection).toBeNull();
    expect(r.pending).toBe(true);
    src.add("offsite", "Priya Raman: offsite cancelled", "Priya Raman cancelled the offsite on Friday", now());
    src.release();
    await settle(p);
    expect(p.takePending({ ...scope, sessionId: "s1" }).length).toBe(1);
  });

  test("with a model, the follow-up makes no judge call", async () => {
    const counts: number[] = [];
    for (const on of [false, true]) {
      const model = new FakeModel(() => '{"pick": []}');
      // Nothing is sure (confidentScore out of reach): the lookup itself asks the judge, once.
      const { p, src, warm, advance, now } = mk({ syncPollBehind: on, confidentScore: 99 }, model);
      await warm();
      advance(5 * HOUR);
      src.hold();
      const asked = say(p, "When is the Dana Lee budget review?", now());
      await Bun.sleep(5);
      src.add("new", "Dana Lee: budget review notes", "Dana Lee budget review agenda draft", now());
      src.release();
      await asked;
      await settle(p);
      counts.push(model.calls.length);
    }
    expect(counts).toEqual([1, 1]);
  });

  test("with a model, a follow-up after a silent judge adds a sure arrival without asking the judge again", async () => {
    const model = new FakeModel(() => '{"pick": []}');
    const { p, src, warm, advance, now } = mk({ syncPollBehind: true }, model);
    await warm();
    advance(5 * HOUR);
    src.hold();
    await say(p, "Is the Priya Raman offsite still on?", now());
    const before = model.calls.length;
    src.add("offsite", "Priya Raman: offsite cancelled", "Priya Raman cancelled the offsite on Friday", now());
    src.release();
    await settle(p);
    expect(model.calls.length).toBe(before);
    expect(ids(p.takePending({ ...scope, sessionId: "s1" }))).toContain(itemId("mail", "offsite"));
  });

  test("follow-ups run one at a time", async () => {
    {
      const { p, src, warm, advance, now } = mk({ syncPollBehind: true });
      await warm();
      advance(5 * HOUR);
      const open = p as unknown as { slowPath: (...a: unknown[]) => Promise<unknown> };
      const orig = open.slowPath.bind(p);
      let live = 0;
      let max = 0;
      src.hold();
      await say(p, "When is the Dana Lee budget review?", now());
      await say(p, "Is the Priya Raman offsite still on?", now() + 1);
      open.slowPath = async (...a: unknown[]) => {
        live++;
        max = Math.max(max, live);
        try {
          await Bun.sleep(5);
          return await orig(...a);
        } finally {
          live--;
        }
      };
      src.add("offsite", "Priya Raman: offsite cancelled", "Priya Raman cancelled the offsite on Friday", now());
      src.release();
      await settle(p);
      expect(max).toBe(1);
    }
  });
});

// Audit 2026-11-03b (corr-poll-behind-calls-untraced): a lookup that does not wait for its on-demand poll leaves the
// poll's listing calls out of its own trace, so the poll gets a "skipped" trace of its own when it settles. Summed over
// the traces, the calls are what the connector received, flag on or off.
describe("syncPollBehind: the poll's calls are traced", () => {
  const settle = async (p: ContextPartner) => {
    const table = (p as unknown as { sessions: Map<string, { inflight: unknown; behind?: unknown }> }).sessions;
    for (let k = 0; k < 500 && [...table.values()].some((x) => x.inflight || x.behind); k++) await Bun.sleep(1);
  };
  const run = async (config: Record<string, unknown>, closeEarly = false) => {
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
        ...CORE_CONFIG,
        sync: true,
        syncPageSize: 2,
        syncCallsPerMin: 600,
        syncMaxStaleMs: 4 * HOUR,
        ...config,
      },
    });
    p.sync!.track(scope);
    while (!p.sync!.warm(scope)) await p.sync!.tick();
    const received = () => src.lists + src.searches;
    const before = received();
    const say = (text: string, sessionId = "s1") =>
      p.observe({ ...scope, sessionId, at: clock, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
    clock += 5 * HOUR; // Stale: the first lookup polls (and stores nothing).
    src.hold();
    const first = say("When is the Dana Lee budget review?");
    if (closeEarly) {
      await Bun.sleep(5);
      await p.observe({ ...scope, sessionId: "s1", at: clock, kind: "session_end" } as AgentEvent);
    }
    src.release();
    await first;
    await settle(p);
    if (!closeEarly) {
      clock += 5 * HOUR; // Stale again; this poll stores the new item, and its follow-up is traced too.
      src.add("new", "Dana Lee: budget review cancelled", "Dana Lee cancelled the budget review entirely", clock);
      src.hold();
      const second = say("Is the Dana Lee budget review cancelled?", "s2");
      await Bun.sleep(5);
      src.release();
      await second;
      await settle(p);
    }
    await Bun.sleep(5);
    const traced = traces.reduce((n, t) => n + t.sourceCalls, 0);
    return { received: received() - before, traced, traces };
  };

  for (const on of [false, true]) {
    test(`syncPollBehind ${on ? "on" : "off"}: the traces sum to the calls the connector received`, async () => {
      const { received, traced, traces } = await run({ syncPollBehind: on });
      expect(received).toBeGreaterThan(0);
      expect(traced).toBe(received);
      const polls = traces.filter((t) => t.reason === "sync poll behind");
      if (!on) expect(polls).toEqual([]);
      else {
        // One per lookup that left a poll running, whether or not it stored anything; never a decision to be silent.
        expect(polls.length).toBe(2);
        for (const t of polls) {
          expect(t.decision).toBe("skipped");
          expect(t.syncCalls).toBe(t.sourceCalls);
          expect(t.itemIds).toEqual([]);
        }
      }
    });
  }

  test("a session closed while its poll is out still gets the poll's trace: the calls were made", async () => {
    const { received, traced, traces } = await run({ syncPollBehind: true }, true);
    expect(received).toBeGreaterThan(0);
    expect(traced).toBe(received);
    expect(traces.filter((t) => t.reason === "sync poll behind")).toHaveLength(1);
  });
});
