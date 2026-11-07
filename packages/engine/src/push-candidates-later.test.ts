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

// CL8 (docs/research/cl-cl8.md, D259): an agent keeps a session's packets in its transcript and re-reads them on every
// later model request, so a later request's candidates cost more than the first's. `pushCandidatesLater` sends fewer
// after a session's first request.

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;

const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - 24 * HOUR,
});

class Reader implements ReaderMaker {
  calls = 0;
  async read(input: ReaderInput) {
    this.calls++;
    return {
      bears: [],
      rejected: input.items.map((_, k) => k),
      costUsd: 0,
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    };
  }
}

// Two requests about different things, each with a pool of five, one item worded as a hold (`readerGate`'s test).
const HARLOW = "Pay the Harlow invoice for the venue deposit today.";
const KESTREL = "Book the Kestrel van hire for the Saturday move.";
const NOTES = [
  "the quote came in from the supplier on Monday morning",
  "Priya asked who signs off and whether the budget covers it",
  "the calendar holds a call about it on Thursday afternoon",
  "a reminder to file the receipt with the accounts team",
];
const pool = (topic: string, words: string) => [
  item(`${topic}-hold`, `${topic} hold`, `Payments for ${words} are on hold until the dispute ends.`),
  ...NOTES.map((note, k) => item(`${topic}-${k}`, `${topic} note ${k}`, `About ${words}: ${note}.`)),
];
const ITEMS = [...pool("harlow", "the Harlow venue deposit invoice"), ...pool("kestrel", "the Kestrel van hire move")];

function setup(config: Record<string, unknown>) {
  const maker = new Reader();
  const source: Source = {
    id: "mail",
    kind: "test",
    description: "Mail",
    search: async (q) => {
      const words = q.text.toLowerCase();
      return ITEMS.filter((x) => words.includes(x.ref.split("-")[0]!));
    },
  };
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
      pushCandidates: 5,
      ...config,
    },
    reader: new AskReader({ maker, budget: new Budget(), now: () => NOW }),
  });
  return { p, maker };
}

const ref = (sessionId: string) => ({ tenantId: "t", userId: "u1", sessionId });
async function candidates(p: ContextPartner, text: string, sessionId = "s1") {
  await p.observe({ ...ref(sessionId), at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return p
    .takePending(ref(sessionId))
    .filter((x) => x.reason.startsWith("candidates:"))
    .flatMap((x) => x.citations.map((c) => c.itemId));
}

describe("pushCandidatesLater (D259 trial): fewer candidates after a session's first request", () => {
  test("off (0), every request gets pushCandidates", async () => {
    const { p } = setup({});
    expect((await candidates(p, HARLOW)).length).toBe(5);
    expect((await candidates(p, KESTREL)).length).toBe(5);
  });

  test("on, the first request keeps pushCandidates, later ones get the later count, with no reader call", async () => {
    const { p, maker } = setup({ pushCandidatesLater: 3 });
    expect((await candidates(p, HARLOW)).length).toBe(5);
    const later = await candidates(p, KESTREL);
    expect(later.length).toBe(3);
    expect(later.every((id) => id.startsWith("mail:kestrel"))).toBe(true);
    expect(maker.calls).toBe(0);
  });

  test("counted per session: another session's first request keeps pushCandidates (isolation)", async () => {
    const { p } = setup({ pushCandidatesLater: 3 });
    await candidates(p, HARLOW, "s1");
    expect((await candidates(p, KESTREL, "s2")).length).toBe(5);
  });

  test("never more than pushCandidates", async () => {
    const { p } = setup({ pushCandidates: 2, pushCandidatesLater: 4 });
    await candidates(p, HARLOW);
    expect((await candidates(p, KESTREL)).length).toBe(2);
  });

  test("the config check: a whole count up to 40, acting only with the push", () => {
    const deps = { reader: true, cards: true };
    expect(() => checkEngineConfig({ pushCandidatesLater: 3 }, { deps })).not.toThrow();
    expect(() => checkEngineConfig({ pushCandidatesLater: 2.5 }, { deps })).toThrow();
    expect(() => checkEngineConfig({ pushCandidatesLater: 41 }, { deps })).toThrow();
    expect(() => checkEngineConfig({ pushCandidatesLater: 3, readerPush: false }, { deps })).toThrow(/readerPush/);
  });
});
