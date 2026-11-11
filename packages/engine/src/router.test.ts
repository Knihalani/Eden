/**
 * M8's connector router (`routerGate`, D940; `router.ts`): the features the lab's trainer reads (golden numbers from
 * packages/sim/lab/m8/train_router.py, so the two cannot drift apart), the weights file, the probabilities, and the
 * gate at the partner: an unlikely warm copy gets no live read, a likely one does, the router fails open, and it holds
 * no state of its own (its inputs are each user's own).
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import {
  conjBucket,
  encodeRouterWeights,
  parseRouterWeights,
  requestFeatures,
  routeProbabilities,
  ROUTER_FEATURES,
  ROUTER_NF,
  ROUTER_NULL_NF,
  routerNames,
  routerTerms,
  sourceKeys,
  type RouterWeights,
} from "./router";
import type { SourceYield } from "./source-yield";

describe("router features", () => {
  test("terms are the shared tokenizer's, folded, possessives and one-letter terms dropped", () => {
    const a = routerTerms("Dana's café — A RÉSUMÉ, x");
    const b = routerTerms("dana cafe resume");
    expect(a).toEqual(b);
    expect(routerTerms("")).toEqual([]);
  });

  test("names are capitalised terms that do not open a sentence", () => {
    expect(routerNames("Ask Dana about it. Then email Raj.")).toEqual(routerTerms("dana raj"));
    expect(routerNames("nothing here")).toEqual([]);
  });

  test("request features and buckets match the trainer's golden numbers", () => {
    expect([...requestFeatures([1, 2, 3, 0xdeadbeef])]).toEqual([
      1364076727, 821347078, 2247144487, 233162409, 2117216093, 2902783164, 467630783,
    ]);
    expect(conjBucket(12345, 678910, (1 << 18) - 1)).toBe(165635);
  });

  test("a source's keys: its kind without a trailing number, then distinct description terms", () => {
    const a = sourceKeys("jira-3", "Issue tracker tickets");
    const b = sourceKeys("jira-7", "Issue tracker tickets");
    expect([...a]).toEqual([...b]);
    expect(a.length).toBeLessThanOrEqual(13);
    expect(sourceKeys("gmail", "")[0]).not.toBe(a[0]!);
  });
});

function weights(over: Partial<RouterWeights> = {}): RouterWeights {
  return {
    buckets: 4,
    conj: new Int8Array(4),
    conjScale: 0,
    hidden: 1,
    mu: new Float32Array(ROUTER_NF),
    sd: new Float32Array(ROUTER_NF).fill(1),
    w1: new Float32Array(ROUTER_NF),
    b1: new Float32Array(1),
    w2: new Float32Array([1]),
    b2: 0,
    nullBias: 0,
    nullW: new Float32Array(ROUTER_NULL_NF),
    temperature: 1,
    floor: 0.05,
    ...over,
  };
}

/** A network whose one hidden unit is `k` times the named inputs (all others ignored), minus 1; "nothing" at 3. */
function onInputs(names: (typeof ROUTER_FEATURES)[number][], k = 10, over: Partial<RouterWeights> = {}) {
  const w1 = new Float32Array(ROUTER_NF);
  for (const n of names) w1[ROUTER_FEATURES.indexOf(n)] = k;
  return weights({ w1, b1: new Float32Array([0]), b2: -1, nullBias: 3, ...over });
}

describe("router weights and probabilities", () => {
  test("the weights file round-trips and a bad one is refused", () => {
    const w = weights({ buckets: 8, conj: Int8Array.from([1, -2, 3, -4, 5, -6, 7, -127]), conjScale: 0.5 });
    const back = parseRouterWeights(encodeRouterWeights(w));
    expect([...back.conj]).toEqual([...w.conj]);
    expect(back.floor).toBe(0.05);
    expect(() => parseRouterWeights(new Uint8Array(16))).toThrow();
  });

  test("probabilities over the sources and 'nothing needed' sum to one; evidence raises a source", () => {
    const w = onInputs(["local"]);
    const x = new Float64Array(3 * ROUTER_NF);
    x[ROUTER_NF + 1] = 2; // source 1 holds two of the request's best local matches
    const out = new Float64Array(3);
    const pNull = routeProbabilities(w, x, 3, new Float64Array(ROUTER_NULL_NF), out);
    expect(pNull + out[0]! + out[1]! + out[2]!).toBeCloseTo(1, 10);
    expect(out[1]!).toBeGreaterThan(0.9);
    expect(out[0]!).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// At the partner: four cut copies, as source-yield-partner.test.ts builds them.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 9);
const u1 = { tenantId: "t1", userId: "u1" };
const u2 = { tenantId: "t1", userId: "u2" };

class Counting implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
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
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

async function partnerOf(
  router: RouterWeights | null,
  gate = true,
  scopes: Scope[] = [u1],
  more: Record<string, unknown> = {},
) {
  const sources = [0, 1, 2, 3].map(
    (k) =>
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
  let clock = T0;
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    router,
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
      sourceYield: true,
      sourceYieldEarn: false,
      sourceYieldNames: 0,
      sourceYieldEngage: false,
      routerGate: gate,
      ...more,
    },
  });
  for (const scope of scopes) {
    partner.sync!.track(scope);
    for (let i = 0; i < 200 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
  }
  const table = (partner as unknown as { sessions: Map<string, { inflight: unknown; behind: unknown }> }).sessions;
  let n = 0;
  const request = async (scope: Scope, text: string) => {
    const ref = { ...scope, sessionId: `s${n++}` };
    clock += 120_000;
    const before = sources.map((s) => s.searches);
    const r = await partner.observe({ ...ref, at: clock, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
    for (let k = 0; k < 2_000; k++) {
      const s = table.get(`${scope.tenantId}/${scope.userId}#${ref.sessionId}`);
      if (!s?.inflight && !s?.behind) break;
      await Bun.sleep(2);
    }
    const got = [...(r.injection ? [r.injection] : []), ...partner.takePending(ref)];
    return {
      searched: sources.map((s, k) => s.searches - before[k]!),
      handed: got.flatMap((x) => x.citations.map((c) => c.itemId)),
    };
  };
  const yields = (partner as unknown as { yields: SourceYield }).yields;
  return { partner, sources, fact, request, yields, now: () => clock };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const BLIND = "Arrange the quarterly offsite catering";
const NAMED = "Pay Zed Quinn for the Globex renewal today";

describe("routerGate at the partner (D940)", () => {
  test("off, the cut copies a request routes to are searched; on, those it finds unlikely are not", async () => {
    const off = await partnerOf(onInputs(["sketch", "local"]), false);
    expect(sum((await off.request(u1, BLIND)).searched)).toBeGreaterThan(0);
    const on = await partnerOf(onInputs(["sketch", "local"]));
    expect(sum((await on.request(u1, BLIND)).searched)).toBe(0);
  });

  test("a source with evidence for the request is still read live, and its fact reaches the agent", async () => {
    const p = await partnerOf(onInputs(["sketch", "local"]));
    const r = await p.request(u1, NAMED);
    expect(r.searched[0]).toBeGreaterThan(0);
    expect(sum(r.searched.slice(1))).toBe(0);
    expect(r.handed).toContain(p.fact.id);
  });

  test("a source a rare word of the request points to is read live even when the router finds it unlikely", async () => {
    // The network weighs only local matches; "Globex" is a word only source 0 holds (its fact).
    const off = await partnerOf(onInputs(["local"], 10, { nullBias: 8 }), true, [u1], { sourceYieldEarn: true });
    const r = await off.request(u1, "Globex");
    expect(r.searched[0]).toBeGreaterThan(0);
    expect(sum(r.searched.slice(1))).toBe(0);
  });

  test("it fails open: weights that throw leave the lookup as it was without the gate", async () => {
    const broken = new Proxy(weights(), {
      get(target, key) {
        if (key === "w1") throw new Error("corrupt");
        return Reflect.get(target, key);
      },
    });
    const p = await partnerOf(broken);
    const q = await partnerOf(null, false);
    expect((await p.request(u1, BLIND)).searched).toEqual((await q.request(u1, BLIND)).searched);
  });

  test("no weights: inert", async () => {
    const p = await partnerOf(null);
    const q = await partnerOf(null, false);
    expect((await p.request(u1, BLIND)).searched).toEqual((await q.request(u1, BLIND)).searched);
  });

  test("the router keeps nothing of its own: a source one user has used is read for that user only", async () => {
    const p = await partnerOf(onInputs(["used"]), true, [u1, u2]);
    p.yields.used(u1, ["src2"], p.now());
    const a = await p.request(u1, BLIND);
    const b = await p.request(u2, BLIND);
    expect(a.searched[2]).toBeGreaterThan(0);
    expect(b.searched[2]).toBe(0);
  });
});
