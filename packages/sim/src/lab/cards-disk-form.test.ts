import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_FORM_REQUESTS, cardKey, type CardBatch, type CardMakeOptions, type CardMaker } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { DiskCardMaker, formKey, harnessCoverage, loadCards, loadRequests, shippedUncovered } from "./cards-disk";

// D1060: a replay file may hold the shipped prompt's lines (keyed by `cardKey`) and `cardsRequestsFix`'s (keyed
// `<hash>:f3`), and each form must replay only its own: a card or request made by one prompt never answers the other.

const it1: ContextItem = { id: "mail:1", sourceId: "mail", ref: "1", title: "Fitters", text: "Fitters on Thursday." };
const it2: ContextItem = { id: "mail:2", sourceId: "mail", ref: "2", title: "Worktops", text: "Worktops are late." };
const signal = new AbortController().signal;
const F = { form: CARD_FORM_REQUESTS };

function file(): string {
  const f = join(mkdtempSync(join(tmpdir(), "eden-form-")), "cards.jsonl");
  const lines = [
    { h: cardKey(it1), c: null, r: ["old request"] },
    { h: formKey(it1, CARD_FORM_REQUESTS), c: null, r: ["new request"] },
    { h: formKey(it2, CARD_FORM_REQUESTS), r: ["new only"] },
  ];
  writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return f;
}

test("each prompt form replays only its own lines", async () => {
  const disk = new DiskCardMaker(file());
  const old = await disk.make([it1, it2], "2026-10-27", signal, false, true);
  const fixed = await disk.make([it1, it2], "2026-10-27", signal, false, true, F);
  expect(old.requests).toEqual([["old request"], null]);
  expect(fixed.requests).toEqual([["new request"], ["new only"]]);
  // Readers keyed by the content hash alone see only the shipped form.
  expect(loadRequests(file()).get(cardKey(it2))).toBeUndefined();
  expect(loadCards(file()).has(cardKey(it2))).toBe(false);
});

test("a requests-only re-ask replays the form's requests, and asks the live maker for the rest under the form's key", async () => {
  const f = file();
  const asked: CardMakeOptions[] = [];
  const live: CardMaker = {
    async make(items: ContextItem[], _t, _s, _r, _i, options: CardMakeOptions = {}): Promise<CardBatch> {
      asked.push(options);
      return { cards: items.map(() => null), requests: items.map(() => ["made live"]), costUsd: 0.0002 };
    },
  };
  const third: ContextItem = { id: "mail:3", sourceId: "mail", ref: "3", title: "Sink", text: "The sink is back." };
  const disk = new DiskCardMaker(f, live);
  const got = await disk.make([it1, third], "2026-10-27", signal, false, true, { ...F, requestsOnly: true });
  expect(got.cards).toEqual([null, null]);
  expect(got.requests).toEqual([["new request"], ["made live"]]);
  expect(asked).toEqual([{ ...F, requestsOnly: true }]);
  // Appended under the form's key: the shipped form still has nothing for it.
  expect(readFileSync(f, "utf8")).toContain(
    JSON.stringify({ h: formKey(third, CARD_FORM_REQUESTS), r: ["made live"] }),
  );
  expect(loadRequests(f).has(cardKey(third))).toBe(false);
});

test("a file with no line of the form replays as recorded (the full index predates it); one with any does not mix", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "eden-form-")), "old.jsonl");
  writeFileSync(f, `${JSON.stringify({ h: cardKey(it1), c: null, r: ["old request"] })}\n`);
  const old = await new DiskCardMaker(f).make([it1, it2], "2026-10-27", signal, false, true, F);
  expect(old.requests).toEqual([["old request"], null]);
  // `file()` holds form-3 lines: an item with only a shipped-form line is a miss under the form.
  const both = join(mkdtempSync(join(tmpdir(), "eden-form-")), "both.jsonl");
  writeFileSync(
    both,
    [
      { h: cardKey(it1), c: null, r: ["old request"] },
      { h: formKey(it2, CARD_FORM_REQUESTS), r: ["new only"] },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const got = await new DiskCardMaker(both).make([it1, it2], "2026-10-27", signal, false, true, F);
  expect(got.requests).toEqual([null, ["new only"]]);
});

test("shipped coverage under form 3 covers only the shards holding form-3 lines (not heldout19)", () => {
  expect(shippedUncovered(["train1", "train1r", "longtail"], [41, 44], CARD_FORM_REQUESTS)).toEqual([]);
  // The shipped form still covers heldout19; form 3 does not (D1063), so a run asking in it is not covered there.
  expect(shippedUncovered(["heldout19"], [41], 0)).toEqual([]);
  expect(shippedUncovered(["heldout19"], [41], CARD_FORM_REQUESTS)).toEqual(["heldout19 seed 41"]);
  expect(() =>
    harnessCoverage({ coverage: "shipped", cards: "", intent: "default", suites: ["heldout19"], seeds: [41], form: 3 }),
  ).toThrow(/does not cover heldout19 seed 41/);
});

test("the cards and the requests choose their replay form apart (a form-3 cards file beside a shipped-form intent file)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eden-form-"));
  const cards = join(dir, "cards.jsonl");
  const intent = join(dir, "intent.jsonl");
  writeFileSync(cards, `${JSON.stringify({ h: formKey(it1, CARD_FORM_REQUESTS), c: null })}\n`);
  writeFileSync(intent, `${JSON.stringify({ h: cardKey(it1), r: ["shipped-form request"] })}\n`);
  const disk = new DiskCardMaker(cards, undefined, { requests: [intent] });
  const got = await disk.make([it1], "2026-10-27", signal, false, true, F);
  expect(got.requests).toEqual([["shipped-form request"]]);
  expect(disk.requestKey(it1, CARD_FORM_REQUESTS)).toBe(cardKey(it1));
  expect(disk.cardKeyFor(it1, CARD_FORM_REQUESTS)).toBe(formKey(it1, CARD_FORM_REQUESTS));
});
