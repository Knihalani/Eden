import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { FACT_NAMES, type Facts } from "./decide";
import { ContextPartner } from "./partner";
import { RANK_MODEL, rankAnswer, rankScore, type RankModel } from "./rank";

/** `askRank` and `rankTies` (D82, docs/research/smart-rank.md): a learned no-model ranker over `decide.ts` facts. */
const facts = (over: Partial<Facts> = {}): Facts =>
  ({ ...Object.fromEntries(FACT_NAMES.map((n) => [n, 0])), ...over }) as Facts;

describe("rank model", () => {
  test("the shipped weights read known facts, one finite weight each", () => {
    expect(RANK_MODEL.names.length).toBeGreaterThan(10);
    expect(RANK_MODEL.weights).toHaveLength(RANK_MODEL.names.length);
    for (const n of RANK_MODEL.names) expect(FACT_NAMES).toContain(n);
    for (const w of RANK_MODEL.weights) expect(Number.isFinite(w)).toBe(true);
  });

  test("a score is the weighted sum of the facts it reads", () => {
    const m: RankModel = { names: ["conflict", "clear"], weights: [2, -3] };
    expect(rankScore(facts({ conflict: 1 }), m)).toBe(2);
    expect(rankScore(facts({ conflict: 1, clear: 1 }), m)).toBe(-1);
    expect(rankScore(facts({ score: 9 }), m)).toBe(0);
  });

  test("the shipped ranker puts a conflict above a clearance of the same words", () => {
    const base = { score: 0.8, matched: 2, about: 1, beyondName: 1, entity: 1, mentions: 1 };
    expect(rankScore(facts({ ...base, conflict: 1, conflictHit: 1 }))).toBeGreaterThan(
      rankScore(facts({ ...base, clear: 1 })),
    );
  });

  test("scoring stays in microseconds per candidate", () => {
    const f = facts({ score: 0.7, matched: 2, conflict: 1, walked: 1, walkScore: 0.4 });
    const n = 100_000;
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < n; i++) sink += rankScore(f);
    const us = ((performance.now() - t0) * 1_000) / n;
    expect(Number.isFinite(sink)).toBe(true);
    expect(us).toBeLessThan(5);
  });
});

describe("rankAnswer", () => {
  const score = (v: Record<string, number>) => (x: string) => v[x];

  test("orders the pool by score, cut to the limit; equal scores keep the pool's order", () => {
    const got = rankAnswer(["a", "b", "c", "d"], [], 3, 5, score({ a: 1, b: 3, c: 1, d: 2 }));
    expect(got).toEqual(["b", "d", "a"]);
  });

  test("the best outside candidate takes the weakest seat only past the margin, and the answer never grows", () => {
    const pool = ["a", "b"];
    expect(rankAnswer(pool, ["x"], 5, 5, score({ a: 4, b: 1, x: 5 }))).toEqual(["a", "b"]);
    expect(rankAnswer(pool, ["x"], 5, 5, score({ a: 4, b: 1, x: 7 }))).toEqual(["x", "a"]);
    // An empty pool stays empty: the ranker never makes an answer out of nothing.
    expect(rankAnswer([], ["x"], 5, 0, score({ x: 9 }))).toEqual([]);
  });

  test("a candidate with no facts ranks behind those with them", () => {
    expect(rankAnswer(["u", "a"], [], 2, 5, score({ a: -10 }))).toEqual(["a", "u"]);
  });
});

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `chat:${id}`,
  sourceId: "chat",
  ref: id,
  title,
  text,
});
const source = (items: ContextItem[]): Source => ({
  id: "chat",
  kind: "test",
  description: "Team chat",
  search: async (q) => {
    const words = q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  },
});

// Four notes the question's words find, in the lexical ranking's order.
const notes = [
  item("n1", "Orchard launch plan", "Orchard launch plan: owners and the copy review."),
  item("n2", "Orchard launch budget", "Orchard launch budget: agency fees and print."),
  item("n3", "Orchard launch venue", "Orchard launch venue: the riverside hall is booked."),
  item("n4", "Orchard launch rehearsal", "Orchard launch rehearsal on Tuesday 3 November 2026, 10:00-11:00."),
];
/** A ranker that prefers what the lexical ranking put last: a test double for the fitted weights. */
const LATER: RankModel = { names: ["rank"], weights: [10] };

function partner(config: Record<string, unknown>, rankModel?: RankModel, items = notes) {
  return new ContextPartner({
    sources: async () => [source(items)],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config,
    ...(rankModel ? { rankModel } : {}),
  });
}

async function askIds(config: Record<string, unknown>, rankModel?: RankModel, userId = "u1") {
  const p = partner(config, rankModel);
  const scope = { tenantId: "t", userId };
  const warm = { ...scope, sessionId: "s1", at: NOW, kind: "user_message", text: "Orchard launch?" };
  await p.observe(warm as AgentEvent, { waitMs: 1_000 });
  const a = await p.ask({ ...scope, sessionId: "s2", question: "What is the plan for the Orchard launch?" });
  return a.citations.map((c) => c.itemId);
}

describe("askRank", () => {
  test("flag off: the ranker is not read; on, the same items in its order", async () => {
    const off = await askIds({}, LATER);
    const plain = await askIds({});
    expect(off).toEqual(plain);
    const on = await askIds({ askRank: true }, LATER);
    expect(off.length).toBeGreaterThan(1);
    expect(on).toEqual([...off].reverse());
  }, 30_000);

  test("the answer never holds more items than the limit or than the flag-off answer", async () => {
    const off = await askIds({});
    const on = await askIds({ askRank: true, askRankMargin: -100 }, LATER);
    expect(on.length).toBeLessThanOrEqual(off.length);
    expect(on.length).toBeLessThanOrEqual(5);
  });

  test("stateless across users: each user's answer is ranked from their own cache only", async () => {
    const a = await askIds({ askRank: true }, LATER, "u1");
    const b = await askIds({ askRank: true }, LATER, "u2");
    expect(a).toEqual(b);
    for (const id of a) expect(notes.map((n) => n.id)).toContain(id);
  });
});

describe("rankTies", () => {
  // Five sure items that score alike; three may be delivered (`confidentItems`). The test ranker prefers the later.
  const tied = [1, 2, 3, 4, 5].map((n) =>
    item(
      `t${n}`,
      `Kestrel cutover checklist ${n}`,
      n === 5
        ? "Kestrel cutover checklist: rehearsal on Tuesday 3 November 2026, 10:00-11:00."
        : `Kestrel cutover checklist: step ${["alpha", "bravo", "charlie", "delta"][n - 1]} for the database team.`,
    ),
  );

  async function delivered(config: Record<string, unknown>, rankModel?: RankModel) {
    const p = partner(config, rankModel, tied);
    const scope = { tenantId: "t", userId: "u1" };
    const ev = {
      ...scope,
      sessionId: "s1",
      at: NOW,
      kind: "user_message",
      text: "Send me the Kestrel cutover checklist",
    };
    const r = await p.observe(ev as AgentEvent, { waitMs: 1_000 });
    const ids = r.injection?.citations.map((c) => c.itemId) ?? [];
    for (const x of p.takePending(scope as never)) ids.push(...x.citations.map((c) => c.itemId));
    return ids;
  }

  test("which of equals is kept follows the ranker; how many does not change", async () => {
    const off = await delivered({}, LATER);
    const on = await delivered({ rankTies: true }, LATER);
    expect(off).toHaveLength(3);
    expect(on).toHaveLength(3);
    expect(off).not.toContain("chat:t5");
    expect(on).toContain("chat:t5");
  }, 30_000);
});
