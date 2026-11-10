/**
 * `sourceYield` at the partner (D505, N1; docs/research/n1-calls.md): a source whose live reads go unused is not
 * read live, an ask names it "unsearched", and a request with evidence for it reads it again.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import type { SourceYield } from "./source-yield";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 9);
const u1 = { tenantId: "t1", userId: "u1" };
const u2 = { tenantId: "t1", userId: "u2" };

/** A recent-first listing source that counts its searches and matches any word of the query. */
class Counting implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
  lists = 0;
  /** An outage: every search fails. */
  down = false;
  constructor(
    readonly id: string,
    readonly items: ContextItem[],
  ) {}
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    if (this.down) throw new Error("down");
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return this.items
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)))
      .slice(0, q.limit);
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** 4 sources of 10 items for a cap of 20: every copy is cut. Source 0's oldest item, past the cut, is the fact. */
function world(sizes: number[]): { sources: Counting[]; fact: ContextItem } {
  const sources = sizes.map(
    (size, k) =>
      new Counting(
        `src${k}`,
        Array.from({ length: size }, (_, i) => ({
          id: itemId(`src${k}`, `i${i}`),
          sourceId: `src${k}`,
          ref: `i${i}`,
          title: `Item ${k}-${i}`,
          text: `filler words for source ${k} item ${i}`,
          updatedAt: T0 - (k + 4 * i) * HOUR,
        })),
      ),
  );
  const fact = sources[0]!.items.at(-1)!;
  fact.title = "Zed Quinn contract on hold";
  fact.text = "Do not pay Zed Quinn: the Globex renewal payment is on hold until legal signs off";
  return { sources, fact };
}

async function partnerOf(
  config: Record<string, unknown>,
  scopes: Scope[] = [u1],
  sizes = [10, 10, 10, 10],
  /** Changes the world before anything is synced. */
  tweak: (sources: Counting[]) => void = () => {},
) {
  const { sources, fact } = world(sizes);
  tweak(sources);
  let clock = T0;
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      sync: true,
      syncOnDemand: true,
      syncPollBehind: true,
      syncLocalComplete: true,
      pushCutBehind: true,
      askBehind: true,
      syncPageSize: 10,
      syncMaxItems: 20,
      syncCallsPerMin: 6_000,
      probes: false,
      // On in the default (D509): each test turns it on itself.
      sourceYield: false,
      ...config,
    },
  });
  for (const scope of scopes) {
    partner.sync!.track(scope);
    for (let i = 0; i < 200 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
    for (const s of sources) if (s.items.length === 10) expect(partner.sync!.complete(scope, s.id)).toBe(false);
  }
  const settle = async (scope: Scope, sessionId: string) => {
    const key = `${scope.tenantId}/${scope.userId}#${sessionId}`;
    const table = (partner as unknown as { sessions: Map<string, { inflight: unknown; behind: unknown }> }).sessions;
    for (let n = 0; n < 2_000; n++) {
      const s = table.get(key);
      if (!s?.inflight && !s?.behind) break;
      await Bun.sleep(2);
    }
  };
  let n = 0;
  /** One request in a session of its own: the searches the connectors received for it, and what was handed over. */
  const request = async (scope: Scope, text: string) => {
    const ref = { ...scope, sessionId: `s${n++}` };
    // Past the fan-out's minute of page reuse: each request's reads reach the connectors.
    clock += 120_000;
    const before = sources.map((s) => s.searches);
    const r = await partner.observe({ ...ref, at: clock, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
    await settle(scope, ref.sessionId);
    const got = [...(r.injection ? [r.injection] : []), ...partner.takePending(ref)];
    return {
      ref,
      searched: sources.map((s, k) => s.searches - before[k]!),
      handed: got.flatMap((x) => x.citations.map((c) => c.itemId)),
    };
  };
  const ask = async (ref: { tenantId: string; userId: string; sessionId: string }, question: string) => {
    const before = sources.map((s) => s.searches);
    const a = await partner.ask({ ...ref, question });
    await settle(ref, ref.sessionId);
    return { answer: a, searched: sources.map((s, k) => s.searches - before[k]!) };
  };
  return { partner, sources, fact, request, ask, advance: (ms: number) => (clock += ms) };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** A request that shares no word with any item: no source has evidence for it. */
const BLIND = "Arrange the quarterly offsite catering";

describe("sourceYield (D505)", () => {
  test("off: every request searches the cut copies it routes to", async () => {
    const p = await partnerOf({});
    const first = await p.request(u1, BLIND);
    const fifth = await (async () => {
      let last = first;
      for (let i = 0; i < 4; i++) last = await p.request(u1, BLIND);
      return last;
    })();
    expect(sum(first.searched)).toBeGreaterThan(0);
    expect(sum(fifth.searched)).toBe(sum(first.searched));
  });

  test("a source whose run of unused reads is spent is not searched again; one whose item is used is", async () => {
    const p = await partnerOf({ sourceYield: true, sourceYieldRun: 2, sourceYieldFloor: 0 });
    const a = await p.request(u1, BLIND);
    const b = await p.request(u1, BLIND);
    expect(sum(a.searched)).toBeGreaterThan(0);
    expect(sum(b.searched)).toBeGreaterThan(0);
    // Two reads of each routed source with nothing used: spent.
    for (let i = 0; i < 3; i++) await p.request(u1, BLIND);
    const spent = await p.request(u1, BLIND);
    expect(sum(spent.searched)).toBe(0);
    // An ask names the copies it did not search, and is not an all-clear.
    const asked = await p.ask(spent.ref, "Is the offsite catering arranged?");
    expect(sum(asked.searched)).toBe(0);
    expect(asked.answer.answer).toContain("Not searched past what is held of");
    expect(asked.answer.answer).toContain("not an all-clear");
    expect(asked.answer.sources?.some((x) => x.status === "unsearched")).toBe(true);
  });

  test("a spent source is read again for a request that has evidence for it, and a use ends its run", async () => {
    const p = await partnerOf({ sourceYield: true, sourceYieldRun: 2, sourceYieldFloor: 0 });
    for (let i = 0; i < 6; i++) await p.request(u1, BLIND);
    expect(sum((await p.request(u1, BLIND)).searched)).toBe(0);
    // The request's words are in source 0's sketch (its fact is past the cut): evidence, so it is searched.
    const named = await p.request(u1, "Pay Zed Quinn for the Globex renewal today");
    expect(named.searched[0]).toBeGreaterThan(0);
    expect(named.handed).toContain(p.fact.id);
    // The fact reached the agent: source 0's run is over, and it is searched again on no evidence.
    const after = await p.request(u1, BLIND);
    expect(after.searched[0]).toBeGreaterThan(0);
    expect(sum(after.searched.slice(1))).toBe(0);
  });

  test("runs are per user: another user's sources are still searched; forget drops a source's run or the user's", async () => {
    const p = await partnerOf({ sourceYield: true, sourceYieldRun: 2, sourceYieldFloor: 0 }, [u1, u2]);
    for (let i = 0; i < 6; i++) await p.request(u1, BLIND);
    expect(sum((await p.request(u1, BLIND)).searched)).toBe(0);
    expect(sum((await p.request(u2, BLIND)).searched)).toBeGreaterThan(0);
    const yields = (p.partner as unknown as { yields: SourceYield }).yields;
    const read = p.sources.filter((s) => yields.run(u1, s.id, T0) > 0).map((s) => s.id);
    expect(read.length).toBeGreaterThan(1);
    p.partner.forget(u1, read[0]!);
    expect(yields.run(u1, read[0]!, T0)).toBe(0);
    expect(yields.run(u1, read[1]!, T0)).toBeGreaterThan(0);
    expect(yields.size(u2)).toBeGreaterThan(0);
    p.partner.forget(u1);
    expect(yields.size(u1)).toBe(0);
    expect(yields.size(u2)).toBeGreaterThan(0);
  });

  test("with the probes on, a spent source gets no probe either", async () => {
    const p = await partnerOf({ sourceYield: true, sourceYieldRun: 2, sourceYieldFloor: 0, probes: true });
    const first = await p.request(u1, "Ask Zed Quinn about the offsite catering");
    expect(sum(first.searched)).toBeGreaterThan(0);
    for (let i = 0; i < 6; i++) await p.request(u1, BLIND);
    expect(sum((await p.request(u1, BLIND)).searched)).toBe(0);
  });

  test("an outage is not a run of unused reads: a source that failed is searched again when it is back", async () => {
    const p = await partnerOf({ sourceYield: true, sourceYieldRun: 2, sourceYieldFloor: 0 });
    for (const s of p.sources) s.down = true;
    for (let i = 0; i < 6; i++) expect(sum((await p.request(u1, BLIND)).searched)).toBeGreaterThan(0);
    for (const s of p.sources) s.down = false;
    expect(sum((await p.request(u1, BLIND)).searched)).toBeGreaterThan(0);
  });

  test("one request books one read of a source, however many lookups joined its call", async () => {
    const p = await partnerOf({ sourceYield: true, sourceYieldRun: 99, sourceYieldFloor: 0 });
    const r = await p.request(u1, BLIND);
    const yields = (p.partner as unknown as { yields: SourceYield }).yields;
    for (const [k, s] of p.sources.entries()) {
      expect(yields.run(u1, s.id, T0 + 120_000)).toBeCloseTo(Math.min(1, r.searched[k]!), 3);
    }
  });

  test("a whole copy keeps its poll: an ask never calls a spent whole copy failed or still being read", async () => {
    // Source 3 has two items: its copy is whole, the others are cut.
    const cfg = { sourceYield: true, sourceYieldRun: 99, sourceYieldFloor: 0.05, sourceYieldHalfLifeMs: 1e15 };
    const p = await partnerOf(cfg, [u1], [10, 10, 10, 2]);
    expect(p.partner.sync!.complete(u1, "src3")).toBe(true);
    let last = await p.request(u1, BLIND);
    for (let i = 0; i < 60; i++) last = await p.request(u1, BLIND);
    expect(sum(last.searched)).toBe(0);
    // Days on, every copy is stale.
    p.advance(3 * 24 * HOUR);
    const lists = p.sources[3]!.lists;
    const asked = await p.ask({ ...u1, sessionId: "late" }, "Is the offsite catering arranged?");
    const whole = asked.answer.sources?.find((x) => x.sourceId === "src3");
    if (whole) {
      expect(["local", "ok", "cached", "stale"]).toContain(whole.status);
      expect(p.sources[3]!.lists).toBeGreaterThan(lists);
    }
    expect(asked.answer.answer).not.toContain("Could not reach");
    expect(asked.answer.sources?.some((x) => x.status === "error")).toBe(false);
  });

  test("the pooled rule: once the user's reads on no evidence do not pay, unused sources are not read on none", async () => {
    // The run alone would never skip (99); the pool does after its warm-up.
    const p = await partnerOf({ sourceYield: true, sourceYieldRun: 99, sourceYieldFloor: 0.05 });
    let last = await p.request(u1, BLIND);
    expect(sum(last.searched)).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) last = await p.request(u1, BLIND);
    expect(sum(last.searched)).toBe(0);
    // Evidence still gets its read, and the fact still arrives.
    const named = await p.request(u1, "Pay Zed Quinn for the Globex renewal today");
    expect(named.searched[0]).toBeGreaterThan(0);
    expect(named.handed).toContain(p.fact.id);
  });
});

describe("sourceYieldEarn (D600, a trial)", () => {
  const EARN = { sourceYield: true, sourceYieldEarn: true };
  const FACT = "Pay Zed Quinn for the Globex renewal today";

  test("a new user's source with nothing used is not read live on no evidence, from the first request", async () => {
    const p = await partnerOf(EARN);
    const first = await p.request(u1, BLIND);
    expect(sum(first.searched)).toBe(0);
    // The ask names what it did not search, and is not an all-clear (D127).
    const asked = await p.ask(first.ref, "Is the offsite catering arranged?");
    expect(sum(asked.searched)).toBe(0);
    expect(asked.answer.answer).toContain("Not searched past what is held of");
    expect(asked.answer.answer).toContain("not an all-clear");
  });

  test("a word only one source's sketch holds is read there, and a use earns the source its reads", async () => {
    const p = await partnerOf(EARN);
    const named = await p.request(u1, FACT);
    expect(named.searched[0]).toBeGreaterThan(0);
    expect(sum(named.searched.slice(1))).toBe(0);
    expect(named.handed).toContain(p.fact.id);
    // Source 0 has had an item used: it is read on no evidence now, the others still are not.
    const after = await p.request(u1, BLIND);
    expect(after.searched[0]).toBeGreaterThan(0);
    expect(sum(after.searched.slice(1))).toBe(0);
  });

  test("a word most sources hold is weak evidence: nothing is read for it", async () => {
    const p = await partnerOf(EARN);
    // "filler" and "words" are in every source's items.
    expect(sum((await p.request(u1, "Tidy the filler words in the report")).searched)).toBe(0);
  });

  test("what a source earned is per user", async () => {
    const p = await partnerOf(EARN, [u1, u2]);
    await p.request(u1, FACT);
    expect((await p.request(u1, BLIND)).searched[0]).toBeGreaterThan(0);
    expect(sum((await p.request(u2, BLIND)).searched)).toBe(0);
  });

  test("off (the default): a new user's first request on no evidence is read live", async () => {
    const p = await partnerOf({ sourceYield: true });
    expect(sum((await p.request(u1, BLIND)).searched)).toBeGreaterThan(0);
  });
});

describe("sourceYieldNames, sourceYieldEngage (D601, trials)", () => {
  const EARN = { sourceYield: true, sourceYieldEarn: true };
  /**
   * Sources 1 to 3 each listed an old item naming Dana Reyes, past the cut: the source map has her in three sources
   * and no held item names her (one that did would be handed over, and its source would have had an item used).
   */
  const dana = (sources: Counting[]) => {
    for (const s of sources.slice(1)) s.items.at(-1)!.text = "Dana Reyes left a comment on the rollout plan";
  };
  const NAMED = "Please email Dana Reyes about lunch";

  test("a name more sources mention than sourceYieldNames is weak evidence for a source with nothing used", async () => {
    const off = await partnerOf(EARN, [u1], [10, 10, 10, 10], dana);
    expect(sum((await off.request(u1, NAMED)).searched.slice(1))).toBeGreaterThan(0);
    const on = await partnerOf({ ...EARN, sourceYieldNames: 2 }, [u1], [10, 10, 10, 10], dana);
    expect(sum((await on.request(u1, NAMED)).searched)).toBe(0);
    // Within the bound the name is still strong evidence.
    const wide = await partnerOf({ ...EARN, sourceYieldNames: 3 }, [u1], [10, 10, 10, 10], dana);
    expect(sum((await wide.request(u1, NAMED)).searched.slice(1))).toBeGreaterThan(0);
  });

  test("a common name still reads a source that has had an item used", async () => {
    const p = await partnerOf({ ...EARN, sourceYieldNames: 2 }, [u1], [10, 10, 10, 10], (sources) => {
      dana(sources);
      // Source 0's fact, past the cut, names her too.
      sources[0]!.items.at(-1)!.text += " (Dana Reyes has the details)";
    });
    const fact = await p.request(u1, "Pay Zed Quinn for the Globex renewal today");
    expect(fact.handed).toContain(p.fact.id);
    const named = await p.request(u1, NAMED);
    expect(named.searched[0]).toBeGreaterThan(0);
    expect(sum(named.searched.slice(1))).toBe(0);
  });

  test("a source the request reads nothing live of is not marked used by it", async () => {
    const off = await partnerOf({ ...EARN, sourceYieldNames: 2 }, [u1], [10, 10, 10, 10], dana);
    await off.request(u1, NAMED);
    expect(off.partner.sync!.engaged(u1, "src1")).toBe(true);
    const on = await partnerOf({ ...EARN, sourceYieldNames: 2, sourceYieldEngage: true }, [u1], [10, 10, 10, 10], dana);
    await on.request(u1, NAMED);
    expect(on.partner.sync!.engaged(u1, "src1")).toBe(false);
    // A source it does read is used as before.
    await on.request(u1, "Pay Zed Quinn for the Globex renewal today");
    expect(on.partner.sync!.engaged(u1, "src0")).toBe(true);
    expect(on.partner.sync!.engaged(u1, "src1")).toBe(false);
  });
});

describe("syncDormantMs (D602, a trial)", () => {
  const DAY = 24 * HOUR;
  const CFG = { sourceYield: true, sourceYieldEarn: true, syncDormantMs: 2 * DAY, syncDormantRefreshMs: 10 * DAY };
  const held = (p: Awaited<ReturnType<typeof partnerOf>>, id: string) => [...p.partner.sync!.syncedIds(u1, id)].length;

  test("a source no lookup uses drops its copy, is not swept, and is refreshed for its sketch alone", async () => {
    const p = await partnerOf(CFG);
    expect(held(p, "src1")).toBeGreaterThan(0);
    // Two days on, the user active again: every source is unused, so every copy goes.
    p.advance(2 * DAY);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    for (const s of p.sources) expect(held(p, s.id)).toBe(0);
    // Days of ticks with the user active: no sweep, no poll.
    const lists = p.sources.map((s) => s.lists);
    for (let d = 0; d < 4; d++) {
      p.advance(DAY);
      await p.request(u1, BLIND);
      await p.partner.sync!.tick();
    }
    expect(p.sources.map((s) => s.lists)).toEqual(lists);
    // Past the refresh interval: one page a source, and still nothing held.
    p.advance(6 * DAY);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    expect(p.sources.map((s) => s.lists)).toEqual(lists.map((n) => n + 1));
    for (const s of p.sources) expect(held(p, s.id)).toBe(0);
  });

  test("a dormant source is still searched on strong evidence, and its fact arrives", async () => {
    const p = await partnerOf(CFG);
    p.advance(2 * DAY);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    expect(held(p, "src0")).toBe(0);
    const named = await p.request(u1, "Pay Zed Quinn for the Globex renewal today");
    expect(named.searched[0]).toBeGreaterThan(0);
    expect(named.handed).toContain(p.fact.id);
  });

  test("dormancy is per user, and a lookup that uses a dormant source wakes it", async () => {
    const p = await partnerOf(CFG, [u1, u2]);
    const heldBy = (scope: Scope, id: string) => [...p.partner.sync!.syncedIds(scope, id)].length;
    p.advance(2 * DAY);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    expect(heldBy(u1, "src0")).toBe(0);
    // u2 was not active: nothing of theirs was dropped.
    expect(heldBy(u2, "src0")).toBeGreaterThan(0);
    // u1's request with strong evidence for source 0 uses it: its copy is read again from the top.
    await p.request(u1, "Pay Zed Quinn for the Globex renewal today");
    for (let i = 0; i < 5; i++) await p.partner.sync!.tick();
    expect(p.partner.sync!.engaged(u1, "src0")).toBe(true);
    expect(heldBy(u1, "src0")).toBeGreaterThan(0);
    expect(heldBy(u1, "src1")).toBe(0);
  });

  test("a dormant source is not polled on demand: one request lists nothing of it", async () => {
    const p = await partnerOf(CFG);
    p.advance(2 * DAY);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    const lists = p.sources.map((s) => s.lists);
    await p.request(u1, "Pay Zed Quinn for the Globex renewal today");
    // Sources 1 to 3 are not listed at all; source 0, now used, is listed only by the ticks that read it again.
    expect(p.sources.slice(1).map((s) => s.lists)).toEqual(lists.slice(1));
    expect(p.sources[0]!.lists).toBe(lists[0]!);
  });

  test("a source that notifies is never dormant", async () => {
    const p = await partnerOf({ ...CFG, syncPush: true }, [u1], [10, 10, 10, 10], (sources) => {
      (sources[2] as unknown as { notifies: boolean }).notifies = true;
    });
    p.advance(2 * DAY);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    expect(held(p, "src1")).toBe(0);
    expect(held(p, "src2")).toBeGreaterThan(0);
  });

  test("a restored user's dormant sources stay dormant: no listing at the first tick", async () => {
    const p = await partnerOf(CFG);
    p.advance(2 * DAY);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    const snap = p.partner.sync!.snapshot(u1);
    p.partner.forget(u1);
    expect(p.partner.sync!.restore(u1, JSON.parse(JSON.stringify(snap)))).toBe(true);
    const lists = p.sources.map((s) => s.lists);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    expect(p.sources.map((s) => s.lists)).toEqual(lists);
    for (const s of p.sources) expect(held(p, s.id)).toBe(0);
  });

  test("off (the default): copies are kept", async () => {
    const p = await partnerOf({ sourceYield: true, sourceYieldEarn: true });
    p.advance(2 * DAY);
    await p.request(u1, BLIND);
    await p.partner.sync!.tick();
    expect(held(p, "src1")).toBeGreaterThan(0);
  });
});
