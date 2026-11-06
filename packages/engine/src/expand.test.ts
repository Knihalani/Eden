import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderMaker } from "./reader";
import { expandAsk, EXPAND_HITS } from "./expand";
import { termIds } from "./text";

const scope = { tenantId: "t", userId: "u" };
const NOW = Date.UTC(2026, 10, 6, 12);

const item = (ref: string, title: string, text: string): ContextItem => ({
  id: `mail:${ref}`,
  sourceId: "mail",
  ref,
  title,
  text,
  updatedAt: NOW - 3_600_000,
});

/** A user's items: the request's own topic, a planted item sharing none of its words, and unrelated filler. */
function filled(extra: ContextItem[] = []): ItemCache {
  const cache = new ItemCache();
  const items = [
    item(
      "q1",
      "Harbourside renewal quote",
      "Your contents insurance renewal: home cover for belongings, policy premium £212.",
    ),
    item(
      "q2",
      "Harbourside reminder",
      "Contents insurance renews soon. Your home cover policy keeps belongings protected.",
    ),
    item(
      "q3",
      "Insurance comparison",
      "Contents insurance quotes compared: home cover, belongings, excess and premium.",
    ),
    // Planted: no word of "Accept the renewal quote for my contents insurance", but the feedback's words.
    item("p1", "Welcome to Brightcover", "Your home cover policy starts Wednesday. Belongings covered, premium paid."),
    ...extra,
  ];
  for (let i = 0; i < 200; i++) {
    items.push(item(`f${i}`, `Weekly update ${i}`, `Team lunch on Friday ${i}, the quarterly report and parking.`));
  }
  cache.put(scope, items, NOW);
  return cache;
}

function queryOf(cache: ItemCache, text: string, sc = scope): number[] {
  const vocab = cache.peekVocab(sc);
  if (!vocab) return [];
  const t = termIds(text, vocab, false);
  return Array.from(t.ids.subarray(0, t.n));
}

describe("expandAsk (askExpand, pseudo-relevance feedback over the user's own index)", () => {
  test("reaches an item that shares no word with the request through the words its top matches share", () => {
    const cache = filled();
    const q = queryOf(cache, "Accept the renewal quote for my contents insurance");
    const direct = cache.search(scope, q, q.length, 12, NOW).map((h) => h.item.ref);
    expect(direct).not.toContain("p1");
    const found = expandAsk(cache, scope, q, new Set(direct.map((r) => `mail:${r}`)), NOW);
    expect(found.map((h) => h.item.ref)).toContain("p1");
  });

  test("never returns what the ask already holds, and at most EXPAND_HITS items", () => {
    const cache = filled([
      item("p2", "Home cover add-on", "Home cover for belongings away from home, premium rises."),
      item("p3", "Home cover claim", "Belongings claim on your home cover policy: premium unchanged."),
      item("p4", "Home cover review", "Annual home cover review: belongings and policy premium."),
      item("p5", "Home cover note", "A note on your home cover policy for belongings and premium."),
    ]);
    const q = queryOf(cache, "Accept the renewal quote for my contents insurance");
    const held = new Set(["mail:p1"]);
    const found = expandAsk(cache, scope, q, held, NOW);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(EXPAND_HITS);
    expect(found.some((h) => held.has(h.item.id))).toBe(false);
  });

  test("a request with no match in the index expands to nothing", () => {
    const cache = filled();
    expect(expandAsk(cache, scope, queryOf(cache, "zebra crossing"), new Set(), NOW)).toEqual([]);
    expect(expandAsk(cache, scope, [], new Set(), NOW)).toEqual([]);
  });

  test("words common to most of the user's items are not expansion terms", () => {
    // Only the filler shares the request's word "report"; its other words are on most items, so nothing is added.
    const cache = filled();
    const q = queryOf(cache, "Send the quarterly report");
    expect(expandAsk(cache, scope, q, new Set(), NOW)).toEqual([]);
  });

  test("one user's items never expand another user's request (isolation)", () => {
    const cache = filled();
    const other = { tenantId: "t", userId: "v" };
    cache.put(other, [item("x1", "Lunch", "Team lunch on Friday.")], NOW);
    const ask = "Accept the renewal quote for my contents insurance";
    expect(expandAsk(cache, other, queryOf(cache, ask, other), new Set(), NOW)).toEqual([]);
    const t2 = { tenantId: "t2", userId: "u" };
    expect(expandAsk(cache, t2, queryOf(cache, ask, t2), new Set(), NOW)).toEqual([]);
    expect(expandAsk(cache, scope, queryOf(cache, ask), new Set(), NOW).map((h) => h.item.ref)).toContain("p1");
  });
});

describe("askExpand in the ask (D177)", () => {
  /** A reader that flags nothing and keeps what it was shown. */
  class Recording implements ReaderMaker {
    pools: string[][] = [];
    async read(input: ReaderInput) {
      this.pools.push(input.items.map((x) => x.id));
      return { bears: [], costUsd: 0 };
    }
  }

  const run = async (askExpand: boolean) => {
    const items = [
      item(
        "q1",
        "Harbourside renewal quote",
        "Your contents insurance renewal: home cover for belongings, premium £212.",
      ),
      item(
        "q2",
        "Harbourside reminder",
        "Contents insurance renews soon. Your home cover policy keeps belongings safe.",
      ),
      item("q3", "Insurance comparison", "Contents insurance quotes compared: home cover, belongings and premium."),
      item(
        "p1",
        "Welcome to Brightcover",
        "Your home cover policy starts Wednesday. Belongings covered, premium paid.",
      ),
    ];
    for (let i = 0; i < 200; i++) items.push(item(`f${i}`, `Weekly update ${i}`, `Team lunch on Friday ${i}.`));
    const maker = new Recording();
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => items };
    const p = new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: { ...CORE_CONFIG, askReader: true, askReaderWaitMs: 1_000, askExpand },
      reader: new AskReader({ maker, budget: new Budget(), now: () => NOW }),
    });
    const scope = { ...scope0, sessionId: "s1" };
    const request = "Accept the renewal quote for my contents insurance";
    await p.observe({ ...scope, at: NOW, kind: "user_message", text: request } as AgentEvent, { waitMs: 1_000 });
    await p.ask({ ...scope, question: request, maxItems: 3 });
    return maker.pools.at(-1) ?? [];
  };
  const scope0 = { tenantId: "t", userId: "u" };

  test("off: the reader never sees an item sharing no word with the request", async () => {
    const pool = await run(false);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool).not.toContain("mail:p1");
  });

  test("on: the expansion's find joins the reader's pool after every candidate the ask found itself", async () => {
    const off = await run(false);
    const on = await run(true);
    expect(on).toContain("mail:p1");
    expect(on.slice(0, off.length)).toEqual(off);
    expect(on.length).toBeLessThanOrEqual(15);
  });
});
