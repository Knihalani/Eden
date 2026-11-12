import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_FORM_REQUESTS, cardMessages, parseCards, parseRequests, requestMessages } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { promptItems, queueModel, readAnswers } from "./card-queue";

const item = (id: string, title: string, text: string): ContextItem =>
  ({ id, sourceId: "gmail", ref: id, kind: "mail", title, text, updatedAt: Date.UTC(2026, 9, 20) }) as ContextItem;
const items = [
  item("a", "Council tax", "Your instalment of £120 is due on 2 November."),
  item("b", "Lunch?", "Fancy lunch on Friday?"),
];

describe("card-queue (F8, D1101): the subagent card transport", () => {
  test("a miss writes each item pending and fails; answered, the reply parses as the model's would", async () => {
    const dir = mkdtempSync(join(tmpdir(), "card-queue-"));
    const req = { messages: cardMessages(items, "2026-10-27", true, CARD_FORM_REQUESTS), maxTokens: 3000 };
    await expect(queueModel(dir).chat(req)).rejects.toThrow(/2 of 2 items unanswered/);
    const pending = readdirSync(join(dir, "pending"));
    expect(pending.length).toBe(2);
    const keys = promptItems(req).map((p) => p.key);
    expect(pending.sort()).toEqual(keys.map((k) => `${k}.json`).sort());
    // The key is the item's block (index dropped) and the day: the same item in another batch position matches.
    const swapped = { ...req, messages: cardMessages([items[1]!, items[0]!], "2026-10-27", true, CARD_FORM_REQUESTS) };
    expect(promptItems(swapped).map((p) => p.key)).toEqual([keys[1], keys[0]]);
    mkdirSync(join(dir, "answers"), { recursive: true });
    const card = { kind: "deadline", actions: ["pay"], entities: ["council tax"], end: "2026-11-02", statement: "due" };
    writeFileSync(
      join(dir, "answers", "b-0000.jsonl"),
      [
        JSON.stringify({ key: keys[0], card, q: ["pay the council tax"] }),
        JSON.stringify({ key: keys[1], card: null, q: ["book lunch Friday"] }),
      ].join("\n"),
    );
    const model = queueModel(dir, readAnswers(dir));
    const res = await model.chat(swapped);
    const cards = parseCards(res.text, 2);
    expect(cards[1]).toMatchObject({ kind: "deadline", actions: ["pay"], end: "2026-11-02" });
    expect(cards[0]).toMatchObject({ kind: "none" });
    expect(parseRequests(res.text, 2)).toEqual([["book lunch Friday"], ["pay the council tax"]]);
    // The requests-only re-ask gets the same requests and no cards.
    const ask = await model.chat({ messages: requestMessages(items, "2026-10-27"), maxTokens: 3000 });
    expect(JSON.parse(ask.text)).toEqual({
      requests: [
        { i: 0, q: ["pay the council tax"] },
        { i: 1, q: ["book lunch Friday"] },
      ],
    });
    expect(res.costUsd).toBe(0);
  });

  test("cold-start records on the world's clock: the card prompt's day is the world's (F5's finding)", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-queue-cs-"));
    const r = Bun.spawnSync(
      ["bun", join(import.meta.dir, "cold-start.ts"), "--users", "train1:41", "--queue-dir", dir],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).toBe(0);
    const system = readFileSync(join(dir, "system-cards-intent.txt"), "utf8");
    // world.ts's NOW is Tuesday 27 October 2026; the wall clock would say another day.
    expect(system).toContain("Today is 2026-10-27.");
    expect(readdirSync(join(dir, "pending")).length).toBeGreaterThan(50);
  }, 60_000);
});
