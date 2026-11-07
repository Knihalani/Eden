/**
 * `syncCutLive` (D390, trial): over `syncPollWidth` sources, a warm copy the user's cap cut (D264) is searched
 * live, and polled, only if routing has evidence for it (a name it mentioned, `routeLocalHits`, `routeSketch`); the
 * prior's draw alone no longer sends a lookup to hundreds of cut noise copies (docs/research/a28-scale.md).
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const scope = { tenantId: "t1", userId: "u1" };

class ListSource implements Source {
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
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
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

/** 200 noise sources (cut by the cap) and a bank whose recent statements share the request's words. */
function world(other = "") {
  const noise = Array.from(
    { length: 200 },
    (_, k) =>
      new ListSource(
        `src${k}`,
        Array.from({ length: 2 }, (_, i) => ({
          id: itemId(`src${k}`, `i${i}`),
          sourceId: `src${k}`,
          ref: `i${i}`,
          title: `Item ${k}-${i}${other}`,
          text: `filler words for source ${k} item ${i}`,
          updatedAt: T0 - (k + 200 * i) * HOUR,
        })),
      ),
  );
  const words = ["isa allowance tax year", "pension contribution", "savings rate isa", "allowance letter"];
  const bank = new ListSource(
    "bank",
    Array.from({ length: 25 }, (_, i) => ({
      id: itemId("bank", `b${i}`),
      sourceId: "bank",
      ref: `b${i}`,
      title: `Statement ${i}`,
      text: i < 3 ? `Your ${words[i]} update number ${i}` : `Monthly statement ${i} for your current account`,
      updatedAt: T0 - (i < 3 ? i : 400 + i) * HOUR,
    })),
  );
  bank.items[24]!.text = "You have used your full ISA allowance for this tax year";
  return { noise, bank, sources: [...noise, bank] as ListSource[] };
}

async function run(config: Record<string, unknown>, sc: Scope = scope) {
  const { noise, bank, sources } = world();
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => T0,
    config: {
      sync: true,
      syncPageSize: 10,
      syncPollPageSize: 2,
      syncCallsPerMin: 6_000,
      syncMaxItems: 300,
      syncStaleChance: 0.99,
      syncMaxStaleMs: 24 * HOUR,
      syncLocalComplete: true,
      syncOnDemand: true,
      syncPollWidth: 8,
      routeLocalHits: true,
      routeSketch: false,
      syncEngagedDeep: false,
      syncKeepCut: false,
      cardsSourceAware: false,
      ...config,
    },
  });
  partner.sync!.track(sc);
  for (let i = 0; i < 400 && !partner.sync!.warm(sc); i++) await partner.sync!.tick();
  expect(partner.sync!.complete(sc, "bank")).toBe(false);
  const cut = noise.filter((x) => !partner.sync!.complete(sc, x.id)).length;
  const before = noise.reduce((n, s) => n + s.lists, 0);
  const res = await partner.ask({ ...sc, sessionId: "s1", question: "Have I used my ISA allowance this tax year?" });
  return {
    cut,
    cited: res.citations.map((c) => c.itemId).includes(bank.items[24]!.id),
    bankSearched: bank.searches > 0,
    noiseSearches: noise.reduce((n, s) => n + s.searches, 0),
    noisePolls: noise.reduce((n, s) => n + s.lists, 0) - before,
  };
}

describe("syncCutLive (D390)", () => {
  test("a cut copy with evidence is still searched live; cut copies routed on the draw alone are not", async () => {
    const off = await run({});
    const on = await run({ syncCutLive: 1 });
    expect(off.cut).toBeGreaterThan(50);
    expect(on.cut).toBe(off.cut);
    // Off: the ask's other seats and the probes go to cut noise copies the draw picked, each one a live search.
    expect(off.noiseSearches).toBeGreaterThan(0);
    expect(off).toMatchObject({ bankSearched: true, cited: true });
    // On: the bank (its synced statements share the request's words) is searched and cited; the noise is not.
    expect(on).toMatchObject({ bankSearched: true, cited: true, noiseSearches: 0, noisePolls: 0 });
  });

  test("at 0 the trial is off: the same calls as without the key", async () => {
    const a = await run({});
    const b = await run({ syncCutLive: 0 });
    expect(b).toEqual(a);
  });

  test("one user's warm cut copies gate nothing for another user, whose copies are not synced", async () => {
    const { noise, sources } = world();
    const other = { tenantId: "t1", userId: "u2" };
    const partner = new ContextPartner({
      sources: async () => sources,
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => T0,
      config: { sync: true, syncPageSize: 10, syncMaxItems: 300, syncCallsPerMin: 6_000, syncCutLive: 1 },
    });
    partner.sync!.track(scope);
    for (let i = 0; i < 400 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
    // u2 is not synced: every source of theirs is searched live as D264 says, whatever u1's copies hold.
    await partner.ask({ ...other, sessionId: "s2", question: "Have I used my ISA allowance this tax year?" });
    expect(noise.reduce((n, s) => n + s.searches, 0)).toBeGreaterThan(0);
  });
});
