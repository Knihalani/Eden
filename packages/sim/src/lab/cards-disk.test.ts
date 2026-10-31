import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardKey, type Card, type CardMaker } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { DiskCardMaker, loadCards } from "./cards-disk";

const item = (n: number): ContextItem => ({
  id: `i${n}`,
  sourceId: "gmail",
  ref: `r${n}`,
  title: `t${n}`,
  text: `x${n}`,
});
const card = (n: number): Card => ({ kind: "absence", actions: [], entities: [`P${n}`], statement: `s${n}` });

/** A live maker that cards every item it is given and counts what it was asked for. */
const liveMaker = () => {
  const asked: string[] = [];
  const maker: CardMaker = {
    async make(items) {
      asked.push(...items.map((i) => i.id));
      return { cards: items.map((i) => card(Number(i.id.slice(1)))), costUsd: 0.001 * items.length };
    },
  };
  return { maker, asked };
};

const signal = new AbortController().signal;

describe("DiskCardMaker", () => {
  test("a replay with an output file never writes the replay file (a run cannot mutate its own input)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    writeFileSync(replay, `${JSON.stringify({ h: cardKey(item(1)), c: card(1) })}\n`);
    const before = readFileSync(replay, "utf8");
    const out = join(dir, "new.jsonl");
    const { maker, asked } = liveMaker();
    const disk = new DiskCardMaker(replay, maker, { out });
    const got = await disk.make([item(1), item(2)], "2026-10-31", signal);
    expect(got.cards.map((c) => c?.statement)).toEqual(["s1", "s2"]);
    expect(asked).toEqual(["i2"]);
    expect(got.costUsd).toBeCloseTo(0.001);
    expect(readFileSync(replay, "utf8")).toBe(before);
    expect([...loadCards(out).keys()]).toEqual([cardKey(item(2))]);
    // A later run with both files replays both, and asks the live maker for nothing.
    const again = liveMaker();
    const next = new DiskCardMaker(replay, again.maker, { out });
    expect((await next.make([item(1), item(2)], "2026-10-31", signal)).cards.map((c) => c?.statement)).toEqual([
      "s1",
      "s2",
    ]);
    expect(again.asked).toEqual([]);
  });

  test("makers sharing one map read the file once and see each other's new cards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    const out = join(dir, "new.jsonl");
    const first = liveMaker();
    const a = new DiskCardMaker(replay, first.maker, { out });
    const second = liveMaker();
    const b = new DiskCardMaker(replay, second.maker, { out, shared: a.cards });
    await a.make([item(3)], "2026-10-31", signal);
    await b.make([item(3)], "2026-10-31", signal);
    expect([first.asked, second.asked]).toEqual([["i3"], []]);
    expect(existsSync(replay)).toBe(false);
  });

  test("with no output file, new cards are appended to the cache itself (cards-enrich builds its file so)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const file = join(dir, "cards.jsonl");
    const { maker } = liveMaker();
    await new DiskCardMaker(file, maker).make([item(4)], "2026-10-31", signal);
    expect([...loadCards(file).keys()]).toEqual([cardKey(item(4))]);
  });
});
