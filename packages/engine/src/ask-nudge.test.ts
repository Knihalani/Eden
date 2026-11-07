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
import { anchored, anchorsOf, namedDays, namesDay, settles } from "./settle";

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
const OTHER = item("other", "Invoice archive", "Older invoice for a venue deposit, paid last year.", 500);

function setup(config: Record<string, unknown>, onPushPool?: (r: PushPoolReport) => void) {
  const source: Source = {
    id: "mail",
    kind: "test",
    description: "Mail",
    search: async () => [HOLD, PLAIN, DATED, OTHER],
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
