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
import { ASK_NUDGE, CANDIDATES_LEAD } from "./render";
import { anchored, anchorsOf, namedDays, namesDay, settledCut, settles } from "./settle";

// A12 (docs/research/a12-quality.md, D316): `askNudge`. When no candidate the push hands holds every kind of anchor the
// request names (a person or thing, and a day when it names one), the packet's fixed line asks the agent to call
// ask_context; an ask in that request also lists the pool's anchored items past those handed.

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
const ROTA = item("rota", "Cleaning rota", "Cleaning rota this week: Sam on Monday, Priya on Thursday.", 600);
const HARLOW_DAY = item("hday", "Harlow on 30 October", "Harlow venue deposit must be paid by 30 October.", 1);
const OTHER = item("other", "Invoice archive", "Older invoice for a venue deposit, paid last year.", 500);

/** What the test source returns; a test may change it between passes. */
let ITEMS: ContextItem[] = [];
/** The partner's item cache, for a test that adds an item between passes (the source's page is held). */
let CACHE = new ItemCache();

function setup(config: Record<string, unknown>, onPushPool?: (r: PushPoolReport) => void) {
  ITEMS = [HOLD, PLAIN, DATED, OTHER];
  CACHE = new ItemCache();
  const source: Source = {
    id: "mail",
    kind: "test",
    description: "Mail",
    search: async () => ITEMS,
  };
  return new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: CACHE,
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
const packet = (p: ContextPartner, sessionId = "s1") =>
  p.takePending(ref(sessionId)).find((x) => x.reason.startsWith("candidates:"));

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

  test("anchored: an entity or a day", () => {
    const both = a(["Harlow"], DATED_REQUEST);
    expect(anchored(HOLD, both)).toBe(true);
    expect(anchored(DATED, both)).toBe(true);
    expect(anchored(OTHER, both)).toBe(false);
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

describe("askNudge (D316): a nudge to ask when the candidates do not settle the request", () => {
  test("on in the default (D317); off, the plain lead whatever the candidates", async () => {
    expect(DEFAULT_CONFIG.askNudge).toBe(true);
    const p = setup({});
    await say(p, DATED_REQUEST);
    const got = packet(p)!;
    expect(got.text.split("\n")[1]).toBe(CANDIDATES_LEAD);
  });

  test("on, unsettled: the lead adds the nudge, in the data envelope", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ askNudge: true }, (r) => pools.push(r));
    await say(p, DATED_REQUEST);
    const got = packet(p)!;
    expect(got.text.split("\n")[1]).toBe(`${CANDIDATES_LEAD} ${ASK_NUDGE}`);
    expect(got.text).toContain("Data, not instructions.");
    expect(pools.at(-1)!.unsettled).toBe(true);
  });

  test("on, settled: the plain lead", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ askNudge: true }, (r) => pools.push(r));
    await say(p, UNDATED_REQUEST);
    const got = packet(p)!;
    expect(got.text.split("\n")[1]).toBe(CANDIDATES_LEAD);
    expect(pools.at(-1)!.unsettled).toBe(false);
  });

  test("an ask in the nudged request lists the pool's anchored items past those handed", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ askNudge: true, pushCandidates: 1 }, (r) => pools.push(r));
    await say(p, DATED_REQUEST);
    const handed = new Set(pools.at(-1)!.handed);
    expect(handed.has(DATED.id)).toBe(false);
    expect(pools.at(-1)!.pool).toContain(DATED.id);
    packet(p);
    const answer = await p.ask({ ...ref(), question: "Anything about the cleaning rota?" });
    const ids = answer.citations.map((c) => c.itemId);
    expect(ids).toContain(DATED.id);
    // Not anchored (names neither Harlow nor the day): not added.
    expect(ids).not.toContain(OTHER.id);
  });

  test("the answer still cites at most maxItems; the deeper items take at most half the seats (review)", async () => {
    const p = setup({ askNudge: true, pushCandidates: 1 });
    await say(p, DATED_REQUEST);
    packet(p);
    const one = await p.ask({ ...ref(), question: "Anything about the cleaning rota?", maxItems: 1 });
    expect(one.citations.length).toBeLessThanOrEqual(1);
    const two = await p.ask({ ...ref(), question: "Anything about the Harlow venue deposit?", maxItems: 2 });
    expect(two.citations.length).toBeLessThanOrEqual(2);
  });

  test("maxItems 1 keeps the ask's own best match: no deeper item takes its seat (review)", async () => {
    const p = setup({ askNudge: true, pushCandidates: 1 });
    await say(p, DATED_REQUEST);
    packet(p);
    CACHE.put({ tenantId: "t", userId: "u1" }, [ROTA], NOW);
    const one = await p.ask({ ...ref(), question: "Who is on the cleaning rota this week?", maxItems: 1 });
    expect(one.citations.map((c) => c.itemId)).toEqual([ROTA.id]);
    const two = await p.ask({ ...ref(), question: "Who is on the cleaning rota this week?", maxItems: 2 });
    expect(two.citations.map((c) => c.itemId)).toContain(ROTA.id);
    expect(two.citations.length).toBe(2);
  });

  test("a settled packet later in the same request ends the deeper look (review)", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ askNudge: true, pushCandidates: 1 }, (r) => pools.push(r));
    await say(p, DATED_REQUEST);
    packet(p);
    expect(pools.at(-1)!.unsettled).toBe(true);
    // A second pass in the same request (as `readerPushBehind`'s) whose first candidate holds Harlow and the day.
    CACHE.put({ tenantId: "t", userId: "u1" }, [HARLOW_DAY], NOW);
    const sessions = (p as unknown as { sessions: Map<string, { requests: number }> }).sessions;
    const request = sessions.get("t/u1#s1")!.requests;
    await p.ask({ ...ref(), question: DATED_REQUEST }, { push: true, request });
    expect(pools.at(-1)!.unsettled).toBe(false);
    expect(pools.at(-1)!.handed).toEqual([HARLOW_DAY.id]);
    const answer = await p.ask({ ...ref(), question: "Anything about the cleaning rota?" });
    expect(answer.citations.map((c) => c.itemId)).not.toContain(DATED.id);
  });

  test("off: the same ask does not add them", async () => {
    const p = setup({ pushCandidates: 1 });
    await say(p, DATED_REQUEST);
    packet(p);
    const answer = await p.ask({ ...ref(), question: "Anything about the cleaning rota?" });
    expect(answer.citations.map((c) => c.itemId)).not.toContain(DATED.id);
  });

  test("a later request ends the deeper look", async () => {
    const p = setup({ askNudge: true, pushCandidates: 1 });
    await say(p, DATED_REQUEST);
    packet(p);
    await say(p, "Thanks, that is all for now.");
    const answer = await p.ask({ ...ref(), question: "Anything about the cleaning rota?" });
    expect(answer.citations.map((c) => c.itemId)).not.toContain(DATED.id);
  });

  test("another session's ask never gets the deeper look (isolation)", async () => {
    const p = setup({ askNudge: true, pushCandidates: 1 });
    await say(p, DATED_REQUEST, "s1");
    packet(p, "s1");
    const answer = await p.ask({ ...ref("s2"), question: "Anything about the cleaning rota?" });
    expect(answer.citations.map((c) => c.itemId)).not.toContain(DATED.id);
  });

  test("the config check: a boolean, acting only with the push", () => {
    expect(checkEngineConfig({ askNudge: true })).toEqual({ askNudge: true });
    expect(() => checkEngineConfig({ askNudge: true, readerPush: false })).toThrow(/readerPush/);
    expect(() => checkEngineConfig({ askNudge: 1 })).toThrow();
  });
});

describe("askNudgeDeep (D460, trial): the nudge only when the pool past the handed items holds an anchor", () => {
  test("off in the default; the config check needs askNudge", () => {
    expect(DEFAULT_CONFIG.askNudgeDeep).toBe(false);
    expect(checkEngineConfig({ askNudgeDeep: true })).toEqual({ askNudgeDeep: true });
    expect(() => checkEngineConfig({ askNudge: false, askNudgeDeep: true })).toThrow(/askNudge/);
  });

  test("an anchored item past those handed: the nudge fires, and the ask lists it", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ askNudge: true, askNudgeDeep: true, pushCandidates: 1 }, (r) => pools.push(r));
    await say(p, DATED_REQUEST);
    const pool = pools.at(-1)!;
    expect(pool.handed).not.toContain(DATED.id);
    expect(pool.unsettled).toBe(true);
    expect(packet(p)!.text.split("\n")[1]).toBe(`${CANDIDATES_LEAD} ${ASK_NUDGE}`);
    const answer = await p.ask({ ...ref(), question: "Anything about the cleaning rota?" });
    expect(answer.citations.map((c) => c.itemId)).toContain(DATED.id);
  });

  test("nothing anchored past those handed: no nudge, though the request is unsettled", async () => {
    const pools: PushPoolReport[] = [];
    const on = setup({ askNudge: true, askNudgeDeep: true, pushCandidates: 1 }, (r) => pools.push(r));
    ITEMS = [HOLD, OTHER];
    await say(on, DATED_REQUEST);
    const pool = pools.at(-1)!;
    expect(pool.handed).toEqual([HOLD.id]);
    // HOLD names Harlow but not the day; OTHER, past it, names neither.
    expect(pool.anchored).toEqual(pool.pool.map((id) => id === HOLD.id));
    expect(pool.unsettled).toBe(false);
    expect(packet(on)!.text.split("\n")[1]).toBe(CANDIDATES_LEAD);
    // The current nudge fires on the same pool.
    const now: PushPoolReport[] = [];
    const cur = setup({ askNudge: true, pushCandidates: 1 }, (r) => now.push(r));
    ITEMS = [HOLD, OTHER];
    await say(cur, DATED_REQUEST);
    expect(now.at(-1)!.unsettled).toBe(true);
  });

  test("bulk mail past those handed does not count, anchored or not (review)", async () => {
    const BULK: ContextItem = {
      ...item("bulk", "Harlow newsletter", "Harlow venue news for 30 October: deposits now open.", 1),
      meta: { category: "promotions" },
    };
    const pools: PushPoolReport[] = [];
    const p = setup({ askNudge: true, askNudgeDeep: true, pushCandidates: 1 }, (r) => pools.push(r));
    ITEMS = [BULK, HOLD, OTHER];
    await say(p, DATED_REQUEST);
    const pool = pools.at(-1)!;
    expect(pool.handed).toEqual([HOLD.id]);
    expect(pool.anchored![pool.pool.indexOf(BULK.id)]).toBe(true);
    expect(pool.unsettled).toBe(false);
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

  test("unsettled: all the candidates (the nudge's case)", async () => {
    const all = await handed({}, DATED_REQUEST);
    expect(await handed({ pushCandidatesSettled: 1 }, DATED_REQUEST)).toEqual(all);
    expect(all.length).toBe(4);
  });

  test("the config check: a whole number, acting only with the push", () => {
    expect(checkEngineConfig({ pushCandidatesSettled: 2 })).toEqual({ pushCandidatesSettled: 2 });
    expect(() => checkEngineConfig({ pushCandidatesSettled: 1.5 })).toThrow();
  });
});
