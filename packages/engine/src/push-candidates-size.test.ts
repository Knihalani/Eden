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

// CL8 (docs/research/cl-cl8.md, D258): the candidates' packet is most of what Eden adds to the agent's input. Two
// trial switches cut it: the excerpt size, and an item a rule path delivered in the same request (a score floor on the
// weak tail was screened at $0 and deleted: it dropped planted items).

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

const REQUEST = "Pay the Harlow invoice for the venue deposit today.";
const WORDS = "The venue deposit invoice for Harlow covers the hall, the bar and the late licence. ".repeat(8);
const HOLD = item(
  "hold",
  "Harlow venue",
  `Payments to Harlow are on hold until the deposit dispute ends. ${WORDS}`,
  200,
);
const PLAIN = [
  item("n0", "Harlow invoice one", `Harlow invoice for the venue deposit, reference HV-1042. ${WORDS}`, 2),
  item("n1", "Harlow invoice two", `Venue deposit at Harlow: the invoice covers the hall. ${WORDS}`, 3),
];

function setup(config: Record<string, unknown>, items: ContextItem[] = [HOLD, ...PLAIN]) {
  const maker = new Reader();
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
      pushCandidates: 5,
      ...config,
    },
    reader: new AskReader({ maker, budget: new Budget(), now: () => NOW }),
  });
  return { p, maker };
}

const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
const say = (p: ContextPartner) =>
  p.observe({ ...ref, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
const quiet = { confidentScore: 99, fallbackMatchedTerms: 99 };
const itemLines = (text: string) => text.split("\n").filter((l) => l.startsWith("- ["));

describe("pushCandidateBytes (D258 trial): the candidates' excerpt size", () => {
  test("cuts each candidate's excerpt, not other packets' (compactItemBytes stays)", async () => {
    const run = async (bytes: number) => {
      const { p } = setup({ ...quiet, pushCandidateBytes: bytes });
      const o = await say(p);
      const got = [...(o.injection ? [o.injection] : []), ...p.takePending(ref)];
      const cand = got.filter((x) => x.reason.startsWith("candidates:"));
      expect(cand.length).toBe(1);
      return cand[0]!.text;
    };
    const full = await run(0);
    const cut = await run(100);
    const size = (t: string) => itemLines(t).reduce((n, l) => n + Buffer.byteLength(l), 0);
    expect(size(cut)).toBeLessThan(size(full));
    for (const line of itemLines(cut)) expect(Buffer.byteLength(line)).toBeLessThan(100 + 60);
    expect(itemLines(cut).length).toBe(itemLines(full).length);
  });
});

describe("pushCandidateDedup (D258 trial): no candidate a rule path delivered in the request", () => {
  // The rule path (`confidentScore` low) delivers the hold in the observe's own reply while the push looks.
  const run = async (dedup: boolean) => {
    const { p } = setup({ confidentScore: 0.1, pushCandidateDedup: dedup });
    const o = await say(p);
    const packets = [...(o.injection ? [o.injection] : []), ...p.takePending(ref)];
    return packets.map((x) => ({ why: x.reason.split(":")[0]!, ids: x.citations.map((c) => c.itemId) }));
  };
  test("off, an item can be in both packets; on, never twice", async () => {
    const twice = (ps: { ids: string[] }[]) => {
      const all = ps.flatMap((x) => x.ids);
      return all.length - new Set(all).size;
    };
    const on = await run(true);
    expect(twice(on)).toBe(0);
    expect(on.some((x) => x.why === "candidates")).toBe(true);
    const off = await run(false);
    expect(twice(off)).toBeGreaterThan(0);
  });
});

test("the config check: bytes a whole count, each switch acting only with the push", () => {
  const deps = { reader: true, cards: true };
  expect(() => checkEngineConfig({ pushCandidateBytes: 160, pushCandidateDedup: true }, { deps })).not.toThrow();
  expect(() => checkEngineConfig({ pushCandidateBytes: 1.5 }, { deps })).toThrow();
  expect(() => checkEngineConfig({ pushCandidateDedup: true, readerPush: false }, { deps })).toThrow(/readerPush/);
});
