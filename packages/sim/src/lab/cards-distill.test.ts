import { describe, expect, test } from "bun:test";
import { cardKey, cardMessages, parseCards, parseRequests, type Card } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import {
  buildRows,
  DISTILL_TODAY,
  guardedSuites,
  heldOut,
  maxTokensFor,
  overlap,
  scoreBatch,
  scoreRows,
  targetText,
} from "./cards-distill";

const item = (id: string, title: string, text: string): ContextItem => ({
  id,
  ref: id,
  sourceId: "mail",
  title,
  text,
  updatedAt: Date.parse("2026-10-20T09:00:00Z"),
});
const FREEZE: Card = {
  kind: "freeze",
  actions: ["deploy"],
  entities: ["production"],
  start: "2026-11-04",
  end: "2026-11-09",
  statement: "production change freeze 4-9 Nov",
};

/** Twenty items: even ones state a constraint (the prefilter passes them), odd ones are chatter. */
function corpus() {
  const items = new Map<string, ContextItem>();
  const cards = new Map<string, Card | null>();
  const requests = new Map<string, string[]>();
  for (let i = 0; i < 20; i++) {
    const it =
      i % 2 === 0
        ? item(`c${i}`, `Change freeze ${i}`, `Do not deploy to production from 4 to 9 November. Ref ${i}.`)
        : item(`n${i}`, `Lunch ${i}`, `Fancy a sandwich at noon? Ref ${i}.`);
    const h = cardKey(it);
    items.set(h, it);
    cards.set(h, i % 2 === 0 ? FREEZE : null);
    requests.set(h, [`deploy the migration ${i}`]);
  }
  return { items, cards, requests };
}

describe("the distillation set (cards-distill export)", () => {
  test("the prompt is Eden's own card call, the target what Eden's parsers read back", () => {
    const { items, cards, requests } = corpus();
    const res = buildRows(items, cards, requests, new Set(), {
      intent: true,
      batchSizes: [4],
      holdout: 0,
      seed: 1,
    });
    expect(res.heldout).toEqual([]);
    expect(res.train.length).toBe(5);
    for (const row of res.train) {
      const batch = row.keys.map((h) => items.get(h)!);
      // Byte for byte what `ModelCardMaker` sends for this batch on the day the caches were made.
      expect(row.messages.slice(0, 2)).toEqual(cardMessages(batch, DISTILL_TODAY, true));
      expect(row.maxTokens).toBe(maxTokensFor(batch.length, true));
      const target = row.messages[2]!.content;
      const got = parseCards(target, batch.length);
      row.keys.forEach((h, i) => {
        const want = cards.get(h) ?? null;
        expect(got[i]!.kind).toBe(want ? want.kind : "none");
        if (want) expect(got[i]).toEqual(want);
      });
      expect(parseRequests(target, batch.length)).toEqual(row.keys.map((h) => requests.get(h)!));
    }
  });

  test("an item the prefilter rejects targets a none card whatever was cached (read for requests only)", () => {
    const { items, cards, requests } = corpus();
    // A cached constraint card on chatter: the enricher would keep none for it.
    for (const [h, it] of items) if (it.id.startsWith("n")) cards.set(h, FREEZE);
    const res = buildRows(items, cards, requests, new Set(), { intent: true, batchSizes: [20], holdout: 0, seed: 1 });
    expect(res.stats.constraint).toBe(10);
    const row = res.train[0]!;
    const got = parseCards(row.messages[2]!.content, row.keys.length);
    row.keys.forEach((h, i) => expect(got[i]!.kind).toBe(items.get(h)!.id.startsWith("c") ? "freeze" : "none"));
  });

  test("held-out items never share a batch with training items, and excluded keys are in neither", () => {
    const { items, cards, requests } = corpus();
    const keys = [...items.keys()];
    const exclude = new Set(keys.slice(0, 3));
    const res = buildRows(items, cards, requests, exclude, { intent: true, batchSizes: [3], holdout: 0.5, seed: 1 });
    const train = res.train.flatMap((r) => r.keys);
    const held = res.heldout.flatMap((r) => r.keys);
    expect(res.stats.excluded).toBe(3);
    expect(train.length + held.length).toBe(17);
    for (const h of exclude) expect([...train, ...held]).not.toContain(h);
    for (const h of train) expect(heldOut(h, 0.5)).toBe(false);
    for (const h of held) expect(heldOut(h, 0.5)).toBe(true);
  });

  test("more train batchings re-cut the train items only; the first batching and held-out rows are unchanged", () => {
    const { items, cards, requests } = corpus();
    const o = { intent: true, batchSizes: [3], holdout: 0.3, seed: 1 };
    const one = buildRows(items, cards, requests, new Set(), o);
    const three = buildRows(items, cards, requests, new Set(), { ...o, trainBatchings: 3 });
    expect(three.heldout).toEqual(one.heldout);
    expect(three.train.slice(0, one.train.length)).toEqual(one.train);
    const keys = (rows: typeof one.train) => rows.flatMap((r) => r.keys).sort();
    expect(keys(three.train)).toEqual([...keys(one.train), ...keys(one.train), ...keys(one.train)].sort());
    expect(new Set(three.train.map((r) => r.id)).size).toBe(three.train.length);
    const held = new Set(keys(one.heldout));
    for (const h of keys(three.train)) expect(held.has(h)).toBe(false);
  });

  test("items with no target are left out; the split is stable", () => {
    const { items, cards, requests } = corpus();
    const [first, second] = [...items.keys()];
    cards.delete(first!);
    requests.delete(second!);
    const res = buildRows(items, cards, requests, new Set(), { intent: true, batchSizes: [5], holdout: 0.1, seed: 1 });
    expect(res.stats.noRequests).toBe(1);
    // `first` is an even (constraint) item with no cached card: no target.
    expect(res.stats.noCard).toBe(1);
    expect(res.stats.kept).toBe(18);
    expect(heldOut("abc", 0.1)).toBe(heldOut("abc", 0.1));
  });

  test("without intent the prompt and target carry no requests", () => {
    const { items, cards, requests } = corpus();
    const res = buildRows(items, cards, requests, new Set(), { intent: false, batchSizes: [10], holdout: 0, seed: 1 });
    expect(res.train[0]!.messages[0]!.content).not.toContain('"requests"');
    expect(JSON.parse(res.train[0]!.messages[2]!.content)).not.toHaveProperty("requests");
  });

  test("every non-train suite's planted items are guarded", () => {
    const guarded = guardedSuites();
    expect(guarded).toContain("heldout13");
    expect(guarded).toContain("heldout17");
    expect(guarded.some((s) => s.startsWith("train"))).toBe(false);
  });
});

describe("the scorer (cards-distill score)", () => {
  const target = targetText([FREEZE, null, null], [["a b"], [], ["c"]]);

  test("an output equal to the target agrees on every field", () => {
    const s = scoreBatch(target, target, 3, true);
    expect(s.every((x) => x.parsed && x.kind && x.actions && x.span && x.limit && x.entities === 1)).toBe(true);
    expect(s.map((x) => x.requests)).toEqual([1, 1, 1]);
  });

  test("unparseable output is unparsed and calls nothing a constraint", () => {
    const s = scoreBatch(target, "I cannot help", 3, true);
    expect(s.map((x) => x.parsed)).toEqual([false, false, false]);
    expect(s[0]!.flagRef).toBe(true);
    expect(s[0]!.flagOut).toBe(false);
    expect(s.map((x) => x.requests)).toEqual([null, null, null]);
  });

  test("a wrong span, a missed card and a false card are each counted", () => {
    const out = targetText([{ ...FREEZE, end: "2026-11-10" }, { ...FREEZE }, null], [["a b"], [], []]);
    const s = scoreBatch(target, out, 3, true);
    expect(s[0]!.span).toBe(false);
    expect(s[0]!.actions).toBe(true);
    expect(s[1]!.flagRef).toBe(false);
    expect(s[1]!.flagOut).toBe(true);
    const rows = [
      {
        id: "r0",
        keys: ["a", "b", "c"],
        messages: [
          { role: "system" as const, content: '"requests"' },
          { role: "user" as const, content: "" },
          { role: "assistant" as const, content: target },
        ],
        maxTokens: 3000,
      },
    ];
    const sum = scoreRows(rows, new Map([["r0", out]]), true);
    expect(sum.flagPrecision).toBe(0.5);
    expect(sum.flagRecall).toBe(1);
    expect(sum.onBoth.span).toBe(0);
    expect(sum.batchParseRate).toBe(1);
    expect(scoreRows(rows, new Map(), true).batchParseRate).toBe(0);
  });

  test("kept counts the flag only on items whose card the shipped default keeps", () => {
    const ref = targetText([FREEZE, null], null);
    // The model flags item 1 too; when the row says the strict prefilter rejects it, its card is never kept.
    const out = targetText([FREEZE, FREEZE], null);
    const row = (carded?: boolean[]) => ({
      id: "r",
      keys: ["a", "b"],
      messages: [
        { role: "system" as const, content: "" },
        { role: "user" as const, content: "" },
        { role: "assistant" as const, content: ref },
      ],
      maxTokens: 2000,
      ...(carded ? { carded } : {}),
    });
    const all = scoreRows([row()], new Map([["r", out]]), false);
    expect(all.flagPrecision).toBe(0.5);
    expect(all.kept.flagPrecision).toBe(0.5);
    const kept = scoreRows([row([true, false])], new Map([["r", out]]), false);
    expect(kept.flagPrecision).toBe(0.5);
    expect(kept.kept).toEqual({ items: 1, constraintRef: 1, constraintOut: 1, flagPrecision: 1, flagRecall: 1 });
  });

  test("overlap is the Jaccard of words", () => {
    expect(overlap([], [])).toBe(1);
    expect(overlap(["Production systems"], ["production"])).toBe(0.5);
  });
});
