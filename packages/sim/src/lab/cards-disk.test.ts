import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardKey, type Card, type CardMaker } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { DiskCardMaker, loadCards, samePath } from "./cards-disk";

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
    const b = new DiskCardMaker(replay, second.maker, { out, shared: a });
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

  test("makers sharing one map make a card once when they miss it at the same time (pi-ab's paired arms)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    const out = join(dir, "new.jsonl");
    // A slow live maker, so both streams miss the item before either has its card.
    const asked: string[] = [];
    const slow: CardMaker = {
      async make(items) {
        asked.push(...items.map((i) => i.id));
        await Bun.sleep(5);
        return { cards: items.map((i) => card(Number(i.id.slice(1)))), costUsd: 0.001 * items.length };
      },
    };
    const a = new DiskCardMaker(replay, slow, { out });
    const b = new DiskCardMaker(replay, slow, { out, shared: a });
    const [x, y] = await Promise.all([
      a.make([item(5)], "2026-10-31", signal),
      b.make([item(5), item(6), item(5)], "2026-10-31", signal),
    ]);
    // Asked once per item; the stream that waited on the other's card pays nothing for it, and both get the same card.
    expect(asked.sort()).toEqual(["i5", "i6"]);
    expect(x.cards.map((c) => c?.statement)).toEqual(["s5"]);
    expect(y.cards.map((c) => c?.statement)).toEqual(["s5", "s6", "s5"]);
    expect(x.costUsd + y.costUsd).toBeCloseTo(0.002);
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a live maker that fails leaves the waiting streams uncovered, and a later call asks again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    let calls = 0;
    const flaky: CardMaker = {
      async make(items) {
        calls++;
        await Bun.sleep(2);
        if (calls === 1) throw new Error("down");
        return { cards: items.map((i) => card(Number(i.id.slice(1)))), costUsd: 0 };
      },
    };
    const a = new DiskCardMaker(join(dir, "c.jsonl"), flaky);
    const b = new DiskCardMaker(join(dir, "c.jsonl"), flaky, { shared: a });
    const [x, y] = await Promise.allSettled([
      a.make([item(7)], "2026-10-31", signal),
      b.make([item(7)], "2026-10-31", signal),
    ]);
    expect(x.status).toBe("rejected");
    expect(y.status === "fulfilled" && y.value.cards).toEqual([null]);
    expect((await b.make([item(7)], "2026-10-31", signal)).cards.map((c) => c?.statement)).toEqual(["s7"]);
    expect(calls).toBe(2);
  });
});

describe("samePath", () => {
  test("two spellings of one file are the same path, whether or not it exists yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const file = join(dir, "a.cards.jsonl");
    writeFileSync(file, "");
    expect(samePath(file, join(dir, ".", "a.cards.jsonl"))).toBe(true);
    expect(samePath(file, join(dir, "sub", "..", "a.cards.jsonl"))).toBe(true);
    const link = join(dir, "link.jsonl");
    symlinkSync(file, link);
    expect(samePath(link, file)).toBe(true);
    mkdirSync(join(dir, "d"));
    symlinkSync(join(dir, "d"), join(dir, "dl"));
    expect(samePath(join(dir, "d", "new.jsonl"), join(dir, "dl", "new.jsonl"))).toBe(true);
    expect(samePath(file, join(dir, "b.cards.jsonl"))).toBe(false);
    // Relative to the working directory, as the command line gives them.
    expect(samePath("./x.jsonl", "x.jsonl")).toBe(true);
  });
});
