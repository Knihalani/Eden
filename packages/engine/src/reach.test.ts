/**
 * Trial `pushReach` (D330, docs/research/a15-retrieval.md): the push adds up to two items its pool did not hold, the
 * best intent hit holding two of the request's terms and the best lexical match whose stated span covers a day the
 * request names. Unit tests start from the core and turn the candidates on.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, type Card, type CardMaker } from "./cards";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";
import { coversDay, textSpans } from "./reach";

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
const spans = (text: string) =>
  textSpans(text, NOW).map(([a, b]) => [
    new Date(a).toISOString().slice(0, 10),
    new Date(b).toISOString().slice(0, 10),
  ]);

describe("textSpans: the day spans an item's text states", () => {
  test("ranges in one month and across months, weekdays between", () => {
    expect(spans("LCY will be closed from Saturday 14 to Sunday 22 November.")).toEqual([["2026-11-14", "2026-11-22"]]);
    expect(spans("Runway resurfacing: closed 14–22 November")).toEqual([["2026-11-14", "2026-11-22"]]);
    expect(spans("I've got jury duty 28 Oct – 3 Nov")).toEqual([["2026-10-28", "2026-11-03"]]);
  });

  test("a date after until or before ends a span from today; after from or effective, starts an open one", () => {
    expect(spans("International trips are paused until 1 Dec.")).toEqual([["2026-10-27", "2026-12-01"]]);
    expect(spans("Not free on any Friday or Saturday night before 13 November")).toEqual([
      ["2026-10-27", "2026-11-13"],
    ]);
    const [from] = spans("From Monday 2 November, children will only be released to named adults.");
    expect(from![0]).toBe("2026-11-02");
    expect(day(from![1]!) - day(from![0]!)).toBe(60 * 24 * HOUR);
  });

  test("single dates, either order; a date long past is next year's", () => {
    expect(spans("Your flight SK482 on Sun 08 Nov has been retimed")).toEqual([["2026-11-08", "2026-11-08"]]);
    expect(spans("Dinner on Nov 5th")).toEqual([["2026-11-05", "2026-11-05"]]);
    expect(spans("Booked for 9 January")).toEqual([["2027-01-09", "2027-01-09"]]);
  });

  test("no dates, impossible dates, and the bounds: nothing, at most 24 spans, read from the head only", () => {
    expect(spans("Thanks, see you soon")).toEqual([]);
    expect(spans("31 February")).toEqual([]);
    expect(textSpans(Array.from({ length: 40 }, (_, i) => `${(i % 28) + 1} March`).join(", "), NOW).length).toBe(24);
    expect(spans(`${"x".repeat(1_300)} 5 November`)).toEqual([]);
  });

  test("coversDay: a span covers a request's day, inclusive at both ends", () => {
    const s = textSpans("closed 14–22 November", NOW);
    expect(coversDay(s, ["2026-11-18"])).toBe(true);
    expect(coversDay(s, ["2026-11-14"])).toBe(true);
    expect(coversDay(s, ["2026-11-22"])).toBe(true);
    expect(coversDay(s, ["2026-11-23", "2026-11-13"])).toBe(false);
    expect(coversDay([], ["2026-11-18"])).toBe(false);
  });
});

const item = (id: string, title: string, text: string, ageH = 24): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
});

const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };

/** A maker answering requests from a table by title; every card none. */
class TableMaker implements CardMaker {
  constructor(private readonly requests: Record<string, string[]>) {}
  async make(items: ContextItem[], _t: string, _s: AbortSignal, _r?: boolean, intent?: boolean) {
    return {
      cards: items.map(() => NONE),
      ...(intent ? { requests: items.map((i) => this.requests[i.title] ?? []) } : {}),
      costUsd: 0,
    };
  }
}

const REQUEST = "Book me a morning flight from London City to Dublin on Wednesday 18 November.";
// The pool: two items sharing most of the request's words, one with constraint wording so the push hands candidates.
const POOL = [
  item("p0", "Dublin flight options", "Morning flight options London City to Dublin: must book by Friday.", 2),
  item("p1", "Dublin trip", "The Dublin morning flight from London City is the cheapest.", 3),
];
// Shares one word ("November") with the request and states a span covering the 18th.
const CLOSED = item("closed", "Runway works", "LCY closed 14–22 November while the runway is resurfaced.", 300);
// Shares one word too, but its day is another.
const OTHER = item("other", "Gas meter", "Engineer visit on 3 November to read the meter.", 300);
// Its text shares no word with the request; its requests share two ("flight", "Dublin").
const TRIP = item("trip", "Passport", "Your passport renewal is being processed; expect it within ten weeks.", 300);

function setup(config: Record<string, unknown>, onPushPool?: (r: PushPoolReport) => void) {
  let clock = NOW;
  const source: Source = {
    id: "mail",
    kind: "test",
    description: "Mail",
    search: async () => [...POOL, CLOSED, OTHER, TRIP],
  };
  const cards = new CardEnricher({
    maker: new TableMaker({ Passport: ["fly to Dublin next month", "take a flight abroad"] }),
    budget: new Budget(),
    now: () => clock,
  });
  const p = new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      cards: true,
      intent: true,
      // No intent hit counts on its own (it needs three request terms): only the reach slot (two) adds the passport.
      intentMinMatched: 3,
      askReader: true,
      readerPush: true,
      readerGate: true,
      pushCandidates: 2,
      askReaderPool: 2,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      ...config,
    },
    cards,
    ...(onPushPool ? { onPushPool } : {}),
  });
  const ref = (sessionId: string) => ({ tenantId: "t", userId: "u1", sessionId });
  const say = async (sessionId: string, text: string) => {
    await p.observe({ ...ref(sessionId), at: clock, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
    return p.takePending(ref(sessionId)).filter((x) => x.reason.startsWith("candidates:"));
  };
  return {
    // Warm the cache and the intent index on another session first, an hour before the request.
    run: async () => {
      await say("warm", "Any news on the runway, the gas meter or my passport?");
      await cards.idle();
      clock += HOUR;
      return say("s1", REQUEST);
    },
  };
}

const cited = (packets: { citations: { itemId: string }[] }[]) =>
  packets.flatMap((x) => x.citations.map((c) => c.itemId));

describe("pushReach (D330) in the partner", () => {
  test("off: the push hands its pool's candidates only", async () => {
    const got = cited(await setup({}).run());
    expect(got).toEqual(expect.arrayContaining([POOL[0]!.id]));
    expect(got).not.toContain(CLOSED.id);
    expect(got).not.toContain(TRIP.id);
  });

  test("on: after them, the dated item covering the request's day and the two-term intent hit; not the other day", async () => {
    const reports: PushPoolReport[] = [];
    const got = cited(await setup({ pushReach: true }, (r) => reports.push(r)).run());
    expect(got).toContain(CLOSED.id);
    expect(got).toContain(TRIP.id);
    expect(got).not.toContain(OTHER.id);
    // The lab hook says what the slots added, and counts them as handed.
    const last = reports.at(-1)!;
    expect(last.reached).toEqual(expect.arrayContaining([CLOSED.id, TRIP.id]));
    expect(last.handed).toEqual(expect.arrayContaining([CLOSED.id, TRIP.id]));
  });

  test("on, with no candidates handed (no constraint-like item in the pool): nothing is added", async () => {
    const plain = POOL.map((x) => ({ ...x, text: x.text.replace(": must book by Friday", "") }));
    let clock = NOW;
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => [...plain, CLOSED] };
    const p = new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { ...CORE_CONFIG, readerPush: true, readerGate: true, pushCandidates: 2, askReaderPool: 2 },
    });
    const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
    clock += HOUR;
    await p.observe({ ...ref, at: clock, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
    expect(p.takePending(ref).filter((x) => x.reason.startsWith("candidates:"))).toEqual([]);
  });

  test("off in the default; the config checker takes it", () => {
    expect(DEFAULT_CONFIG.pushReach).toBe(false);
    expect(checkEngineConfig({ pushReach: true }, { deps: { cards: true, reader: true } })).toMatchObject({
      pushReach: true,
    });
  });
});
