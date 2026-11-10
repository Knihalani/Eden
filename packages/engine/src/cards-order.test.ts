import { expect, test } from "bun:test";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { CardEnricher, orderQueue, type Card, type CardMaker } from "./cards";

// Trial `cardsOrder` (D482): a user's waiting items are read best first. Constraint wording (the prefilter passed
// the item) counts most; then an event ahead, a sender the user writes to, and the last three days; then the newer
// date; then the order the items came in.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const DAY = 86_400_000;
const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };
const USER = "jamie@example.com";

const mail = (ref: string, from: string, to: string, body: string, ageDays: number): ContextItem => ({
  id: `mail:${ref}`,
  sourceId: "mail",
  ref,
  title: `Note ${ref}`,
  text: `From: ${from}\nTo: ${to}\n\n${body} (${ref})`,
  updatedAt: NOW - ageDays * DAY,
});
const event = (ref: string, startInDays: number): ContextItem => ({
  id: `cal:${ref}`,
  sourceId: "cal",
  ref,
  title: `Coffee ${ref}`,
  text: `A catch-up over coffee (${ref})`,
  updatedAt: NOW - 20 * DAY,
  meta: { start: new Date(NOW + startInDays * DAY).toISOString() },
});

const old = mail("old", "sam@elsewhere.org", USER, "Lovely to see you last month", 20);
const recent = mail("recent", "sam@elsewhere.org", USER, "Lovely to see you yesterday", 1);
const sent = mail("sent", USER, "dana@globex.com", "See you at the offsite", 30);
const fromDana = mail("dana", "dana@globex.com", USER, "Lovely to hear from you", 20);
const ahead = event("ahead", 2);
const past = event("past", -10);
const worded = mail("worded", "sam@elsewhere.org", USER, "Spending over £5,000 must have a second signature", 40);

test("orderQueue: worded first, then the count of signs, then the newer date, then arrival", () => {
  const queue = [old, past, sent, fromDana, recent, ahead, worded].map((item) =>
    item === worded ? { item } : { item, only: true as const },
  );
  const ids = orderQueue(queue, NOW).map((q) => q.item.ref);
  expect(ids[0]).toBe("worded");
  // One sign each: ahead (an event that starts after now), recent (dated yesterday), dana (a sender Jamie wrote to);
  // newer date first (the event's start counts as its date).
  expect(ids.slice(1, 4)).toEqual(["ahead", "recent", "dana"]);
  // No sign: by date, newest first.
  expect(ids.slice(4)).toEqual(["past", "old", "sent"]);
  // Nothing is dropped or doubled, and the input is left as it was.
  expect([...ids].sort()).toEqual(queue.map((q) => q.item.ref).sort());
  expect(queue[0]!.item).toBe(old);
});

test("orderQueue: the user's own address is not a correspondent, and a body's To line is not a header", () => {
  const body = mail("body", "sam@elsewhere.org", USER, "Earlier:\nTo: zed@faraway.net", 30);
  const fromZed = mail("zed", "zed@faraway.net", USER, "Hello again", 20);
  const queue = [body, fromZed, sent, mail("self", USER, USER, "A note to self", 20)].map((item) => ({
    item,
    only: true as const,
  }));
  // No item has a sign: zed was only named in a body, and Jamie writing to Jamie makes no correspondent.
  expect(orderQueue(queue, NOW).map((q) => q.item.ref)).toEqual(["zed", "self", "body", "sent"]);
});

class Maker implements CardMaker {
  batches: string[][] = [];
  async make(items: ContextItem[], _today: string, _signal: AbortSignal, _retry?: boolean, intent?: boolean) {
    this.batches.push(items.map((i) => i.ref));
    return {
      cards: items.map(() => NONE),
      ...(intent ? { requests: items.map(() => ["approve the order"]) } : {}),
      costUsd: 0,
    };
  }
}

const run = async (order: boolean, items: ContextItem[], limits = {}) => {
  const maker = new Maker();
  const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW }, { batch: 2, ...limits });
  e.intend();
  if (order) e.order();
  e.enqueue({ tenantId: "t", userId: "u" }, items);
  await e.idle();
  return maker.batches;
};

test("the enricher reads the queue as it filled without the trial, best first with it", async () => {
  const items = [old, sent, fromDana, worded, ahead];
  expect(await run(false, items)).toEqual([["old", "sent"], ["dana", "worded"], ["ahead"]]);
  expect(await run(true, items)).toEqual([["worded", "ahead"], ["dana", "old"], ["sent"]]);
});

test("over the queue's bound the trial drops the last in its order, not the next to be read", async () => {
  const items = [old, sent, fromDana, worded, ahead];
  // Without the trial the oldest in the queue go: the worded item is read only because it came late.
  expect((await run(false, items, { maxQueue: 2 })).flat()).toEqual(["worded", "ahead"]);
  const first = [worded, ahead, old, sent, fromDana];
  expect((await run(false, first, { maxQueue: 2 })).flat()).toEqual(["sent", "dana"]);
  expect((await run(true, first, { maxQueue: 2 })).flat()).toEqual(["worded", "ahead"]);
});

test("each user's queue is ordered on its own items", async () => {
  const maker = new Maker();
  const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW }, { batch: 5 });
  e.intend();
  e.order();
  // Only user a wrote to Dana: for user b her mail has no sign and keeps its place by date.
  e.enqueue({ tenantId: "t", userId: "a" }, [old, sent, fromDana]);
  e.enqueue({ tenantId: "t", userId: "b" }, [fromDana, mail("newer", "sam@elsewhere.org", USER, "Hello", 10)]);
  await e.idle();
  expect(maker.batches).toContainEqual(["dana", "old", "sent"]);
  expect(maker.batches).toContainEqual(["newer", "dana"]);
});
