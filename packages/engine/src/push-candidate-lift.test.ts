import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderMaker } from "./reader";

// A2 (docs/research/a2-quality.md): two trials on the candidates' path. `pushCandidateLift` (D266) re-orders the
// push's pool with no model (one item per title; items naming the request's date move up); `askPastShown` (D267)
// lets an ask go past the candidates the agent already holds. Unit tests start from the core and turn them on.

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

class Reader implements ReaderMaker {
  calls: ReaderInput[] = [];
  async read(input: ReaderInput) {
    this.calls.push(input);
    return { bears: [], rejected: [], costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
  }
}

function setup(config: Record<string, unknown>, items: ContextItem[]) {
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => items };
  const p = new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: {
      ...CORE_CONFIG,
      askReader: true,
      askReaderWaitMs: 2_000,
      readerPush: true,
      readerGate: true,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      ...config,
    },
    reader: new AskReader({ maker: new Reader(), budget: new Budget(), now: () => NOW }),
  });
  return p;
}

const ref = (sessionId = "s1") => ({ tenantId: "t", userId: "u1", sessionId });
const say = (p: ContextPartner, text: string, sessionId = "s1") =>
  p.observe({ ...ref(sessionId), at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
const handed = (p: ContextPartner, sessionId = "s1") =>
  p
    .takePending(ref(sessionId))
    .filter((x) => x.reason.startsWith("candidates:"))
    .flatMap((x) => x.citations.map((c) => c.itemId));

const REQUEST = "Book the Harlow venue for the party on Saturday 31 October, the deposit invoice is fine.";
// Many words of the request, one title three times (a series), and the hold last: it names the request's date.
const SERIES = [1, 2, 3].map((k) =>
  item(`s${k}`, "Harlow venue party", `Harlow venue party deposit invoice booking, week ${k}. The venue must confirm.`),
);
const OTHERS = [
  item("o1", "Harlow invoice", "Harlow venue deposit invoice for the party booking, reference HV-1042."),
  item("o2", "Venue party notes", "Harlow venue party: deposit invoice, booking and the bar."),
];
const DATED = item("dated", "Sorry!", "Harlow party: the hall is closed for repairs on the 31st, sorry.", 5);
const POOL = [...SERIES, ...OTHERS, DATED];

describe("pushCandidateLift (D266): one item per title, the request's date moves up", () => {
  test("off: a repeated title takes seats and the dated item is not handed", async () => {
    const p = setup({ pushCandidates: 3 }, POOL);
    await say(p, REQUEST);
    const got = handed(p);
    expect(got.length).toBe(3);
    expect(got).not.toContain("mail:dated");
  });

  test("on: the series has one seat, and the item naming the 31st is handed", async () => {
    const p = setup({ pushCandidates: 4, pushCandidateLift: true }, POOL);
    await say(p, REQUEST);
    const got = handed(p);
    expect(got.filter((x) => x.startsWith("mail:s")).length).toBe(1);
    expect(got).toContain("mail:dated");
  });

  test("the config check: acting only with the push", () => {
    const deps = { reader: true, cards: true };
    expect(() => checkEngineConfig({ pushCandidateLift: true }, { deps })).not.toThrow();
    expect(() => checkEngineConfig({ pushCandidateLift: true, readerPush: false }, { deps })).toThrow();
  });
});

describe("askPastShown (D267): an ask goes past the candidates the agent holds", () => {
  const QUESTION = "Harlow venue party deposit invoice booking";

  test("off: the ask's answer repeats the handed candidates", async () => {
    const p = setup({ pushCandidates: 2 }, POOL);
    await say(p, REQUEST);
    const shown = handed(p);
    const a = await p.ask({ ...ref(), question: QUESTION, maxItems: 2 });
    expect(a.citations.map((c) => c.itemId).sort()).toEqual([...shown].sort());
  });

  test("on: the held candidates stay and `maxItems` new ones follow", async () => {
    const p = setup({ pushCandidates: 2, askPastShown: true, askDedup: true }, POOL);
    await say(p, REQUEST);
    const shown = handed(p);
    expect(shown.length).toBe(2);
    const a = await p.ask({ ...ref(), question: QUESTION, maxItems: 2 });
    const cited = a.citations.map((c) => c.itemId);
    // The held ones stay (said by title), and what the pool has beyond them follows, up to `maxItems` of it.
    for (const x of shown) expect(cited).toContain(x);
    expect(cited.filter((x) => !shown.includes(x)).length).toBeGreaterThan(0);
    expect(cited.length).toBeLessThanOrEqual(4);
  });

  test("the config check: acting only with the push and askDedup", () => {
    const deps = { reader: true, cards: true };
    expect(() => checkEngineConfig({ askPastShown: true }, { deps })).not.toThrow();
    expect(() => checkEngineConfig({ askPastShown: true, askDedup: false }, { deps })).toThrow();
  });

  test("on, nothing shown yet: the ask is as before", async () => {
    const off = setup({ pushCandidates: 2, askDedup: true }, POOL);
    const on = setup({ pushCandidates: 2, askPastShown: true, askDedup: true }, POOL);
    const a = await off.ask({ ...ref(), question: QUESTION, maxItems: 2 });
    const b = await on.ask({ ...ref(), question: QUESTION, maxItems: 2 });
    expect(b.citations).toEqual(a.citations);
  });

  test("what one session was shown does not move another's ask (isolation)", async () => {
    const p = setup({ pushCandidates: 2, askPastShown: true, askDedup: true }, POOL);
    await say(p, REQUEST, "s1");
    handed(p, "s1");
    const a = await p.ask({ ...ref("s2"), question: QUESTION, maxItems: 2 });
    expect(a.citations.length).toBe(2);
  });
});

describe("pushCandidateStress (D268): a cut excerpt keeps the rule first", () => {
  const RULE = item(
    "terms",
    "Harlow venue key terms",
    [
      "Harlow venue party bookings: the deposit invoice is HV-1042 for the party.",
      "The bar tab for the party is settled on the night, as last time.",
      "Cancellation: the hall may not be released unless notice is given 30 days before.",
      "The car park opens at six for the party, with spaces kept by the door.",
    ].join("\n"),
  );

  const excerpt = async (stress: boolean) => {
    const p = setup({ pushCandidates: 1, compactItemBytes: 175, pushCandidateStress: stress }, [RULE]);
    await say(p, REQUEST);
    const got = p.takePending(ref()).filter((x) => x.reason.startsWith("candidates:"));
    expect(got.length).toBe(1);
    return got[0]!.text;
  };

  test("off: the parts with the request's words fill the excerpt", async () => {
    expect(await excerpt(false)).not.toContain("may not be released");
  });

  test("on: the part that states a constraint is kept", async () => {
    expect(await excerpt(true)).toContain("may not be released");
  });
});
