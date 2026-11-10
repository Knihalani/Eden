import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";
import { anchorsOf, namedDays, namesDay, settledCut, settles } from "./settle";

// `settle.ts`: whether the push's candidates settle a request (one holds every kind of anchor it names: a person or
// thing, and a day when it names one), and `pushCandidatesSettled` (D400, D404), which hands fewer when they do.
// `askNudge` (D316, D317), the nudge to ask when they did not, was deleted by D455 (M4).

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;

const item = (id: string, title: string, text: string, ageH = 24): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
});

// Constraint wording (`readerGate`'s test) so the pool hands candidates.
const HOLD = item("hold", "Harlow venue", "Payments to Harlow are on hold until the venue deposit dispute ends.", 2);
const PLAIN = item("plain", "Harlow invoice", "Harlow invoice for the venue deposit: the PDF is attached.", 3);
const DATED = item(
  "dated",
  "Caretaker away",
  "The caretaker is away on Friday 30th October, so the venue deposit",
  400,
);
const OTHER = item("other", "Invoice archive", "Older invoice for a venue deposit, paid last year.", 500);

/** What the test source returns. */
let ITEMS: ContextItem[] = [];

function setup(config: Record<string, unknown>, onPushPool?: (r: PushPoolReport) => void) {
  ITEMS = [HOLD, PLAIN, DATED, OTHER];
  const source: Source = {
    id: "mail",
    kind: "test",
    description: "Mail",
    search: async () => ITEMS,
  };
  return new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: {
      ...CORE_CONFIG,
      askReader: true,
      readerPush: true,
      readerGate: true,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      pushCandidates: 2,
      ...config,
    },
    ...(onPushPool ? { onPushPool } : {}),
  });
}

const ref = (sessionId = "s1") => ({ tenantId: "t", userId: "u1", sessionId });
const say = (p: ContextPartner, text: string, sessionId = "s1") =>
  p.observe({ ...ref(sessionId), at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
const DATED_REQUEST = "Pay the Harlow venue deposit invoice on Friday 30 October.";
const UNDATED_REQUEST = "Pay the Harlow venue deposit invoice.";

describe("settle.ts: the no-model test of whether candidates settle a request", () => {
  const a = (entities: string[], raw: string, days: string[] | null = null) =>
    anchorsOf(entities, days ? new Set(days) : null, raw, 0);

  test("written dates are read, ranges included", () => {
    expect(namedDays("on 30 October and Nov 2nd")).toEqual([
      { day: 30, month: 9 },
      { day: 2, month: 10 },
    ]);
    expect(namedDays("12–14 November").length).toBe(3);
    expect(namesDay("away Fri 30th", [{ day: 30, month: 9 }])).toBe(true);
    expect(namesDay("due 30/10", [{ day: 30, month: 9 }])).toBe(true);
    expect(namesDay("due 31/10", [{ day: 30, month: 9 }])).toBe(false);
  });

  test("a request with no anchor is settled (nothing to pin down)", () => {
    expect(settles([OTHER], a([], "pay the invoice"))).toBe(true);
  });

  test("an entity alone: some item naming it settles", () => {
    expect(settles([OTHER, PLAIN], a(["Harlow"], UNDATED_REQUEST))).toBe(true);
    expect(settles([OTHER], a(["Harlow"], UNDATED_REQUEST))).toBe(false);
  });

  test("an entity and a day: one item must hold both", () => {
    const both = a(["Harlow"], DATED_REQUEST);
    // HOLD names Harlow, DATED the day: neither alone settles.
    expect(settles([HOLD, DATED], both)).toBe(false);
    const harlowDay = item("hd", "Harlow", "Harlow closes on 30 October.");
    expect(settles([HOLD, harlowDay], both)).toBe(true);
  });

  test("the time window's days count, and an event on the day", () => {
    const anchors = a([], "Book it for Friday", ["2026-10-30"]);
    const event: ContextItem = { ...OTHER, id: "cal:e", meta: { start: "2026-10-30T10:00:00Z" } };
    expect(settles([OTHER], anchors)).toBe(false);
    expect(settles([event], anchors)).toBe(true);
    expect(settles([DATED], anchors)).toBe(true);
  });

  test("an entity matches as a whole word, not inside another", () => {
    const x = item("w", "Harlowe Lane", "Harlowe Lane's invoice.");
    expect(settles([x], a(["Harlow"], UNDATED_REQUEST))).toBe(false);
  });

  test("an entity at a sentence's end or before a hyphen still matches (review)", () => {
    const end = item("e", "Deposit", "The deposit invoice was sent by Harlow.");
    const hyphen = item("h", "Venue", "A Harlow-based venue confirmed the booking.");
    expect(settles([end], a(["Harlow"], UNDATED_REQUEST))).toBe(true);
    expect(settles([hyphen], a(["Harlow"], UNDATED_REQUEST))).toBe(true);
  });
});

describe("pushCandidatesSettled (D400, D404): fewer candidates when they settle the request", () => {
  const handed = async (config: Record<string, unknown>, request: string) => {
    const pools: PushPoolReport[] = [];
    const p = setup({ pushCandidates: 4, ...config }, (r) => pools.push(r));
    await say(p, request);
    return pools.at(-1)!.handed;
  };

  test("2 in the default; settled: the first ones through the first that settles it", async () => {
    expect(DEFAULT_CONFIG.pushCandidatesSettled).toBe(2);
    const all = await handed({}, UNDATED_REQUEST);
    expect(all.length).toBe(4);
    expect(await handed({ pushCandidatesSettled: DEFAULT_CONFIG.pushCandidatesSettled }, UNDATED_REQUEST)).toEqual(
      all.slice(0, 2),
    );
    const few = await handed({ pushCandidatesSettled: 1 }, UNDATED_REQUEST);
    expect(few.length).toBeGreaterThanOrEqual(1);
    expect(few.length).toBeLessThan(4);
    expect(few).toEqual(all.slice(0, few.length));
    // The last one kept settles the request (it names Harlow).
    const kept = [HOLD, PLAIN, DATED, OTHER].find((x) => x.id === few.at(-1));
    expect(kept!.title + kept!.text).toContain("Harlow");
  });

  test("settledCut: the first item that settles it is kept past the cut; no anchor or unsettled keeps all", () => {
    const named = anchorsOf(["Harlow"], null, UNDATED_REQUEST, 0);
    // Only items naming Harlow settle (HOLD, PLAIN); DATED and OTHER do not.
    expect(settledCut([DATED, OTHER, HOLD, PLAIN], named, 1)).toBe(3);
    expect(settledCut([DATED, OTHER, HOLD, PLAIN], named, 2)).toBe(3);
    expect(settledCut([HOLD, DATED, OTHER, PLAIN], named, 2)).toBe(2);
    expect(settledCut([DATED, OTHER], named, 1)).toBe(2);
    expect(settledCut([HOLD, DATED, OTHER], named, 0)).toBe(3);
    const none = anchorsOf([], null, "Pay the venue deposit invoice.", 0);
    expect(settledCut([HOLD, DATED, OTHER, PLAIN], none, 1)).toBe(4);
  });

  test("a request with no anchor keeps every candidate", async () => {
    const request = "Pay the venue deposit invoice.";
    const all = await handed({}, request);
    expect(all.length).toBe(4);
    expect(await handed({ pushCandidatesSettled: 1 }, request)).toEqual(all);
  });

  test("unsettled: all the candidates", async () => {
    const all = await handed({}, DATED_REQUEST);
    expect(await handed({ pushCandidatesSettled: 1 }, DATED_REQUEST)).toEqual(all);
    expect(all.length).toBe(4);
  });

  test("the config check: a whole number, acting only with the push", () => {
    expect(checkEngineConfig({ pushCandidatesSettled: 2 })).toEqual({ pushCandidatesSettled: 2 });
    expect(() => checkEngineConfig({ pushCandidatesSettled: 1.5 })).toThrow();
  });
});
