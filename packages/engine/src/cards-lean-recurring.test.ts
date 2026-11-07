import { expect, test } from "bun:test";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { CardEnricher, type Card, type CardMaker } from "./cards";

// Audit A5, fixed (D244 `cardsLeanDays`, D125 `cardsLean`): the lean decision depends on an item's DATE
// (`readForIntent`), but its outcome is cached by CONTENT hash (`cardKey`: title + text). An old item that the lean
// window skips stores a `card: null` under its hash; a later item with the same title and text but an upcoming date
// (the next occurrence of a recurring event: same summary and description, another `meta.start`) is then "known" and
// reused, so it is never read for its requests, though `readForIntent` says it should be.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const DAY = 86_400_000;
const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };

class Maker implements CardMaker {
  read: string[] = [];
  async make(items: ContextItem[], _today: string, _signal: AbortSignal, _retry?: boolean, intent?: boolean) {
    for (const i of items) this.read.push(i.id);
    return {
      cards: items.map(() => NONE),
      ...(intent ? { requests: items.map(() => ["book the quarterly planning offsite room"]) } : {}),
      costUsd: 0.001,
    };
  }
}

const occurrence = (ref: string, start: number): ContextItem => ({
  id: `cal:${ref}`,
  sourceId: "cal",
  ref,
  title: "Quarterly planning with Dana",
  text: "Agenda: roadmap review and offsite logistics",
  updatedAt: start - 30 * DAY,
  meta: { start: new Date(start).toISOString() },
});

test("an upcoming occurrence is read for its requests even when an old one with the same content was lean-skipped", async () => {
  const maker = new Maker();
  const e = new CardEnricher({ maker, budget: new Budget(), now: () => NOW });
  e.intend();
  e.lean(7);
  const scope = { tenantId: "t", userId: "u" };
  const old = occurrence("old", NOW - 90 * DAY);
  const next = occurrence("next", NOW + 2 * DAY);
  e.enqueue(scope, [old]);
  await e.idle();
  e.enqueue(scope, [next]);
  await e.idle();
  // Control on its own: a fresh enricher reads `next` for its requests.
  const fresh = new Maker();
  const f = new CardEnricher({ maker: fresh, budget: new Budget(), now: () => NOW });
  f.intend();
  f.lean(7);
  f.enqueue(scope, [next]);
  await f.idle();
  expect(fresh.read).toContain("cal:next");
  expect(f.requestsOf(scope, "cal:next", NOW + 1).length).toBeGreaterThan(0);
  // Bug: after the old occurrence, the upcoming one is never read.
  expect(maker.read).toContain("cal:next");
  expect(e.requestsOf(scope, "cal:next", NOW + 1).length).toBeGreaterThan(0);
});
