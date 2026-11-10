/**
 * N1's trial switches at the partner (docs/research/n1-calls.md): `sourceYield` (D505: a source whose live reads go
 * unused is not read live), `pushLazy` (D506: the push sends no live search of a cut copy; the ask does).
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";

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
  constructor(
    readonly id: string,
    readonly items: ContextItem[],
  ) {}
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
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
function world(): { sources: Counting[]; fact: ContextItem } {
  const sources = Array.from(
    { length: 4 },
    (_, k) =>
      new Counting(
        `src${k}`,
        Array.from({ length: 10 }, (_, i) => ({
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

async function partnerOf(config: Record<string, unknown>, scopes: Scope[] = [u1]) {
  const { sources, fact } = world();
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
      ...config,
    },
  });
  for (const scope of scopes) {
    partner.sync!.track(scope);
    for (let i = 0; i < 200 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
    for (const s of sources) expect(partner.sync!.complete(scope, s.id)).toBe(false);
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
  return { partner, sources, fact, request, ask };
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

  test("runs are per user: another user's sources are still searched, and forget starts a user again", async () => {
    const p = await partnerOf({ sourceYield: true, sourceYieldRun: 2, sourceYieldFloor: 0 }, [u1, u2]);
    for (let i = 0; i < 6; i++) await p.request(u1, BLIND);
    expect(sum((await p.request(u1, BLIND)).searched)).toBe(0);
    expect(sum((await p.request(u2, BLIND)).searched)).toBeGreaterThan(0);
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

describe("pushLazy (D506)", () => {
  test("the push sends no live search of a cut copy; the ask still searches and finds the fact", async () => {
    const off = await partnerOf({});
    const on = await partnerOf({ pushLazy: 1 });
    const REQUEST = "Pay Zed Quinn for the Globex renewal today";
    const pushed = await off.request(u1, REQUEST);
    const lazy = await on.request(u1, REQUEST);
    expect(sum(pushed.searched)).toBeGreaterThan(0);
    expect(pushed.handed).toContain(off.fact.id);
    expect(sum(lazy.searched)).toBe(0);
    expect(lazy.handed).not.toContain(on.fact.id);
    const asked = await on.ask(lazy.ref, "Is the Zed Quinn Globex renewal payment on hold?");
    expect(sum(asked.searched)).toBeGreaterThan(0);
    // The ask's search runs behind (D430): its find is cited or follows as a packet.
    const later = on.partner.takePending(lazy.ref).flatMap((x) => x.citations.map((c) => c.itemId));
    const cited = asked.answer.citations.map((c) => c.itemId);
    expect([...cited, ...later]).toContain(on.fact.id);
  });

  test("level 2 starts no on-demand poll on the push either", async () => {
    const one = await partnerOf({ pushLazy: 1, syncStaleChance: 0 });
    const two = await partnerOf({ pushLazy: 2, syncStaleChance: 0 });
    const lists = (p: typeof one) => p.sources.reduce((n, s) => n + s.lists, 0);
    const b1 = lists(one);
    const b2 = lists(two);
    await one.request(u1, BLIND);
    await two.request(u1, BLIND);
    expect(lists(two) - b2).toBe(0);
    expect(lists(one) - b1).toBeGreaterThanOrEqual(lists(two) - b2);
  });
});
