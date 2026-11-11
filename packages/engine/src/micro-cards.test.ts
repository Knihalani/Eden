import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { CardEnricher, type Card, type CardMaker } from "./cards";
import { MICRO_CARDS_PATH, microCardNet, microCardOf, readText } from "./micro-cards";

// `cardsMicro` (M10, D960): the micro card tagger. Its reader (dates and amounts resolved to values), its network's
// parity with the trainer (`packages/sim/lab/m10/export_h1.py` writes the rows), and the enricher's use of it: a card at
// enqueue, the model's card for that item ignored, its requests kept, per user, failing open.

const ANCHOR = Date.parse("2026-10-23T12:00:00Z");
const days = (s: string) =>
  readText("t", s, ANCHOR)
    .dates.filter((d) => d.from >= 0)
    .map((d) => d.day);

describe("readText: dates and amounts", () => {
  test("ranges, months, weekdays, ordinals and relative days resolve against the item's date", () => {
    expect(days("Freeze 4–9 Nov 2026")).toEqual(["2026-11-04", "2026-11-09"]);
    expect(days("for all of November while")).toEqual(["2026-11-01", "2026-11-30"]);
    expect(days("staging is down until Thursday")).toEqual(["2026-10-29"]);
    // Written on a Friday, "by Friday" is a week on.
    expect(days("Confirmations by Friday")).toEqual(["2026-10-30"]);
    expect(days("the scan on the 20th")).toEqual(["2026-11-20"]);
    expect(days("out on Thursday 3rd")).toEqual(["2026-11-03"]);
    expect(days("within 7 days")).toEqual(["2026-10-30"]);
    expect(days("dated January 2021 onwards")).toEqual(["2021-01-01", "2021-01-31"]);
  });

  test("words that start like a month are not months", () => {
    expect(days("the marketing decision is final")).toEqual([]);
  });

  test("amounts: currency, thousands, k and percent", () => {
    const a = readText("t", "£50k over 10% and $1,200", ANCHOR).amounts.map((x) => [x.value, x.unit]);
    expect(a).toEqual([
      [50_000, "£"],
      [10, "%"],
      [1_200, "$"],
    ]);
  });

  test("the item's own date is always a mention (from -1)", () => {
    expect(readText("t", "no dates here", ANCHOR).dates).toEqual([
      { from: -1, to: -1, day: "2026-10-23", form: 4, range: 0 },
    ]);
  });
});

describe("MicroCardNet", () => {
  const net = microCardNet();

  test("the shipped weights load once, within 4 MB", () => {
    expect(net).not.toBeNull();
    expect(net!.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(microCardNet()).toBe(net);
  });

  test("parity with the trainer's quantised forward on 64 items (reader and card)", () => {
    const path = join(import.meta.dir, "..", "models", "micro-cards-v1.parity.jsonl");
    let n = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { row, card } = JSON.parse(line) as { row: Record<string, unknown>; card: Card };
      const dated = (row.dated as string) || (row.now as string);
      const read = readText(row.title as string, row.own as string, Date.parse(`${dated}T12:00:00Z`));
      expect(read.toks.map((t) => [t.w, t.s])).toEqual(row.toks as [string, number][]);
      expect(read.dates).toEqual(row.dates as never);
      expect(read.amounts).toEqual(row.amounts as never);
      const got = net!.card(read, dated, row.source as string);
      expect({ ...got, unit: got.limit !== undefined ? got.unit : undefined }).toEqual({
        ...card,
        unit: card.limit !== undefined ? card.unit : undefined,
      });
      n++;
    }
    expect(n).toBe(64);
  });

  test("a missing or bad weights file is no network (fail open), never a throw", () => {
    expect(microCardNet("/nonexistent/micro-cards.bin")).toBeNull();
    expect(MICRO_CARDS_PATH.endsWith("micro-cards-v1.bin")).toBe(true);
  });

  test("a card's text is the item's own, redacted", () => {
    const item: ContextItem = {
      id: "mail:1",
      sourceId: "mail",
      ref: "1",
      title: "Deploy freeze",
      text: "Production change freeze 4-9 Nov. No deploys. Call me on sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      updatedAt: Date.parse("2026-10-26T09:00:00Z"),
    };
    const card = microCardOf(net!, item, "2026-10-26");
    expect(JSON.stringify(card)).not.toContain("sk-ant-api03");
  });
});

describe("CardEnricher with a micro tagger", () => {
  const NOW = Date.parse("2026-10-27T09:00:00Z");
  const MICRO: Card = { kind: "freeze", actions: ["deploy"], entities: ["production"], statement: "production freeze" };
  const MODEL: Card = { kind: "limit", actions: ["purchase"], entities: [], statement: "the freeze holds (model)" };
  const item = (ref: string): ContextItem => ({
    id: `mail:${ref}`,
    sourceId: "mail",
    ref,
    title: `Freeze ${ref}`,
    text: "From: ops@corp.example\n\nThe production freeze holds, do not deploy.",
    updatedAt: NOW,
  });
  class Maker implements CardMaker {
    calls = 0;
    async make(items: ContextItem[], _t: string, _s: AbortSignal, _r?: boolean, intent?: boolean) {
      this.calls++;
      return {
        cards: items.map(() => MODEL),
        ...(intent ? { requests: items.map(() => ["deploy the release"]) } : {}),
        costUsd: 0,
      };
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 5));

  test("the micro card is kept at enqueue, before any call, and stands over the model's", async () => {
    const maker = new Maker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.intend();
    e.micro = () => MICRO;
    const scope = { tenantId: "t", userId: "u" };
    e.enqueue(scope, [item("a")]);
    expect(e.cardsOf(scope, ["mail:a"], NOW + 1).get("mail:a")).toEqual(MICRO);
    await settle();
    await e.idle();
    // The call still ran for the item's requests; its card for the item is ignored.
    expect(maker.calls).toBe(1);
    expect(e.cardsOf(scope, ["mail:a"], NOW + 1).get("mail:a")).toEqual(MICRO);
    expect(e.requestsOf(scope, "mail:a", NOW + 1)).toEqual(["deploy the release"]);
    expect(e.stats.micro).toBe(1);
  });

  test("without intent, a micro-carded item makes no call at all", async () => {
    const maker = new Maker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
    e.micro = () => MICRO;
    e.enqueue({ tenantId: "t", userId: "u" }, [item("a"), item("b")]);
    await settle();
    await e.idle();
    expect(maker.calls).toBe(0);
  });

  test("a tagger that cannot read (null or a throw) leaves the item to the model, as before", async () => {
    for (const micro of [
      () => null,
      () => {
        throw new Error("boom");
      },
    ]) {
      const maker = new Maker();
      const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
      e.micro = micro;
      const scope = { tenantId: "t", userId: "u" };
      e.enqueue(scope, [item("a")]);
      await settle();
      await e.idle();
      expect(maker.calls).toBe(1);
      expect(e.cardsOf(scope, ["mail:a"], NOW + 1).get("mail:a")).toEqual(MODEL);
    }
  });

  test("isolation: one user's micro card is never another's", () => {
    const e = new CardEnricher({ maker: new Maker(), budget: new Budget(), now: () => NOW });
    e.micro = () => MICRO;
    e.enqueue({ tenantId: "t", userId: "u1" }, [item("a")]);
    expect(e.cardsOf({ tenantId: "t", userId: "u2" }, ["mail:a"], NOW + 1).size).toBe(0);
    expect(e.cardsOf({ tenantId: "t2", userId: "u1" }, ["mail:a"], NOW + 1).size).toBe(0);
    expect(e.cardsOf({ tenantId: "t", userId: "u1" }, ["mail:a"], NOW + 1).size).toBe(1);
  });
});
