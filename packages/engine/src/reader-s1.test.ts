import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { ContextPartner, type ReaderReport } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderKind, type ReaderMaker } from "./reader";
import type { Trace } from "./trace";

// The S1 reader trials (D190-D193, docs/research/fix-s1-reader.md): the evidence gate, no observe wait on a weak pool,
// re-reads after the reader names an item (freshness-push.test.ts), and the ask reusing the push's reading. The short
// output schema (D194) was measured and deleted.

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

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const until = async (cond: () => boolean, turns = 1_000) => {
  for (let n = 0; !cond(); n++) {
    if (n >= turns) throw new Error("condition never held");
    await tick();
  }
};

/** Flags `mail:hold` whenever its pool holds it; counts calls; can be held until released. */
class Reader implements ReaderMaker {
  calls: ReaderInput[] = [];
  /** The first call fails (a provider error): its read gives no verdict. */
  failFirst = false;
  release!: () => void;
  private readonly gate: Promise<void> | null;
  constructor(held = false) {
    this.gate = held ? new Promise<void>((resolve) => (this.release = resolve)) : null;
  }
  async read(input: ReaderInput) {
    this.calls.push(input);
    if (this.gate) await this.gate;
    if (this.failFirst && this.calls.length === 1) throw new Error("model down");
    const i = input.items.findIndex((x) => x.id === "mail:hold");
    const bears: { i: number; kind: ReaderKind; why: string }[] =
      i >= 0 ? [{ i, kind: "blocks", why: "payments to Harlow are on hold" }] : [];
    // Every other item it read is a lookalike.
    const rejected = input.items.map((_, k) => k).filter((k) => k !== i);
    return { bears, rejected, costUsd: 0.0002, usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 } };
  }
}

const REQUEST = "Pay the Harlow invoice for the venue deposit today.";
const ITEMS = [
  item("n0", "Harlow invoice one", "Harlow invoice for the venue deposit: the PDF is attached, reference HV-1042.", 2),
  item("n1", "Harlow invoice two", "Venue deposit at Harlow: the invoice covers the hall and the bar.", 3),
  item("n2", "Harlow invoice three", "The Harlow venue sent a revised invoice with the deposit in two parts.", 4),
  item("hold", "Harlow venue", "Payments to Harlow are on hold until the dispute over their numbers ends.", 200),
];

const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };

function partner(config: Record<string, unknown>, maker: Reader) {
  const reports: ReaderReport[] = [];
  const traces: Trace[] = [];
  const reader = new AskReader({ maker, budget: new Budget(), now: () => NOW });
  const p = new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...CORE_CONFIG, askReader: true, askReaderWaitMs: 2_000, ...config },
    reader,
    onReader: (r) => reports.push(r),
    onTrace: (t) => traces.push(t),
  });
  return { p, reports, traces, reader };
}

const ref = (sessionId = "s1", userId = "u1") => ({ tenantId: "t", userId, sessionId });
const say = (p: ContextPartner, text: string, waitMs = 2_000, sessionId = "s1") =>
  p.observe({ ...ref(sessionId), at: NOW, kind: "user_message", text } as AgentEvent, { waitMs });

describe("readerEvidence (D190): the reader reads only when the request's evidence clears a bar", () => {
  test("below the bar: no call, the ask answers as gated; at the bar: one call", async () => {
    const quiet = new Reader();
    const below = partner({ readerEvidence: true, readerEvidenceScore: 1_000, readerEvidenceCoverage: 1 }, quiet);
    const a = await below.p.ask({ ...ref(), question: REQUEST, maxItems: 3 });
    expect(quiet.calls.length).toBe(0);
    expect(below.reports.map((r) => r.outcome)).toEqual(["gated"]);
    expect(a.usedModel).toBe(false);
    const loud = new Reader();
    const above = partner({ readerEvidence: true, readerEvidenceScore: 0, readerEvidenceTop: 10 }, loud);
    const b = await above.p.ask({ ...ref(), question: REQUEST, maxItems: 3 });
    expect(loud.calls.length).toBe(1);
    expect(b.citations[0]!.itemId).toBe("mail:hold");
  });

  test("only the pool's first readerEvidenceTop candidates count", async () => {
    // The pool is ranked; with a top of 1, only its first item can clear the bar (here it is the deposit PDF, whose
    // wording constrains nothing), so the score floor of 0 alone does not open the gate.
    const maker = new Reader();
    const { reports, p } = partner({ readerEvidence: true, readerEvidenceScore: 0, readerEvidenceTop: 1 }, maker);
    await p.ask({ ...ref(), question: REQUEST, maxItems: 3 });
    const first = reports[0]!.pool[0]!;
    const opened = maker.calls.length === 1;
    // Whichever way it went, it went by the first item alone.
    expect(opened).toBe(first === "mail:hold");
  });

  test("the config check takes its keys only with a reader and askReader on", () => {
    expect(() => checkEngineConfig({ readerEvidence: true }, { deps: { reader: false } })).toThrow();
    expect(() => checkEngineConfig({ askReader: false, readerEvidence: true }, { deps: { reader: true } })).toThrow();
    expect(() => checkEngineConfig({ readerEvidenceTop: 0 }, { deps: { reader: true } })).toThrow();
    expect(() => checkEngineConfig({ readerEvidence: true }, { deps: { reader: true } })).not.toThrow();
  });
});

describe("readerPushWeakNoWait (D191): no blocking wait when the push's pool is weak", () => {
  test("a weak pool: observe returns at once; the reading runs on and its packet is queued for the next request", async () => {
    const maker = new Reader(true);
    const { p } = partner(
      { readerPush: true, readerPushWeakNoWait: true, readerEvidenceScore: 1_000, readerEvidenceCoverage: 1 },
      maker,
    );
    const t0 = performance.now();
    const r = await say(p, REQUEST, 3_000);
    // The reading is held: observe returning at all shows it did not wait for it.
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(r.pending).toBe(true);
    await until(() => maker.calls.length === 1);
    maker.release();
    await until(() => p.takePending(ref()).some((x) => x.reason.startsWith("reader:")));
  });

  test("a pool that clears the bar is waited for, as without the flag", async () => {
    const maker = new Reader(true);
    const { p } = partner(
      { readerPush: true, readerPushWeakNoWait: true, readerEvidenceScore: 0, readerEvidenceTop: 10 },
      maker,
    );
    let done = false;
    const observing = say(p, REQUEST, 3_000).then(() => (done = true));
    await until(() => maker.calls.length === 1);
    for (let k = 0; k < 20; k++) await tick();
    expect(done).toBe(false);
    maker.release();
    await observing;
    expect(p.takePending(ref()).some((x) => x.reason.startsWith("reader:"))).toBe(true);
  });
});

describe("readerReuse (D193): an ask in the push's request reads the push's verdict", () => {
  const QUESTION = "Anything about Harlow I should know before paying?";
  /** An ask that acts on its own, so it is read whatever the session's latest request was. */
  const ACTS = "Pay Harlow's venue deposit invoice now.";

  test("one reader call for the turn: the ask's answer leads with what the push flagged, at no cost", async () => {
    const maker = new Reader();
    const { p, traces } = partner({ readerPush: true, readerReuse: true }, maker);
    await say(p, REQUEST);
    expect(maker.calls.length).toBe(1);
    const a = await p.ask({ ...ref(), question: QUESTION, maxItems: 3 });
    expect(maker.calls.length).toBe(1);
    expect(a.citations[0]!.itemId).toBe("mail:hold");
    expect(a.answer).toContain("Eden's reader: blocks");
    expect(a.usedModel).toBe(false);
    expect(a.costUsd).toBe(0);
    const total = traces.reduce((n, t) => n + (t.readerCalls ?? 0), 0);
    expect(total).toBe(1);
  });

  test("without the flag the same ask makes a call of its own", async () => {
    const maker = new Reader();
    const { p } = partner({ readerPush: true }, maker);
    await say(p, REQUEST);
    await p.ask({ ...ref(), question: QUESTION, maxItems: 3 });
    expect(maker.calls.length).toBe(2);
  });

  test("a newer user message, or another session, reads anew", async () => {
    const maker = new Reader();
    const { p } = partner({ readerPush: true, readerReuse: true }, maker);
    await say(p, REQUEST);
    // Another session of the same user: its own push, nothing shared.
    await p.ask({ ...ref("s2"), question: ACTS, maxItems: 3 });
    expect(maker.calls.length).toBe(2);
    // A newer message in s1 that starts no push of its own (not an action): the ask is not the push's request.
    await say(p, "thanks, what time is it there?");
    await p.ask({ ...ref(), question: ACTS, maxItems: 3 });
    expect(maker.calls.length).toBe(3);
  });

  test("an ask that acts on its own, in the push's request, is another request: it reads anew", async () => {
    const maker = new Reader();
    const { p } = partner({ readerPush: true, readerReuse: true }, maker);
    await say(p, REQUEST);
    await p.ask({ ...ref(), question: "Book the Harlow venue hall for the bar party on Friday.", maxItems: 3 });
    expect(maker.calls.length).toBe(2);
    // A question about the request itself (no action of its own) is read against the push's request: reused.
    await p.ask({ ...ref(), question: QUESTION, maxItems: 3 });
    expect(maker.calls.length).toBe(2);
  });

  test("a push that gave no verdict (its call failed) leaves the ask to read as usual", async () => {
    const maker = new Reader();
    maker.failFirst = true;
    const { p } = partner({ readerPush: true, readerReuse: true }, maker);
    await say(p, REQUEST);
    const a = await p.ask({ ...ref(), question: QUESTION, maxItems: 3 });
    expect(maker.calls.length).toBe(2);
    expect(a.citations[0]!.itemId).toBe("mail:hold");
  });

  test("the push still in flight: the ask waits for its verdict within its own wait, and makes no call", async () => {
    const maker = new Reader(true);
    const { p } = partner({ readerPush: true, readerReuse: true, readerPushWaitMs: 0 }, maker);
    await say(p, REQUEST, 0);
    await until(() => maker.calls.length === 1);
    const asking = p.ask({ ...ref(), question: QUESTION, maxItems: 3 });
    for (let k = 0; k < 5; k++) await tick();
    maker.release();
    const a = await asking;
    expect(maker.calls.length).toBe(1);
    expect(a.citations[0]!.itemId).toBe("mail:hold");
  });

  test("a push still out past the ask's wait: the ask answers without the reader, and makes no call", async () => {
    const maker = new Reader(true);
    const { p, reports } = partner(
      { readerPush: true, readerReuse: true, readerPushWaitMs: 0, askReaderWaitMs: 20 },
      maker,
    );
    await say(p, REQUEST, 0);
    await until(() => maker.calls.length === 1);
    const a = await p.ask({ ...ref(), question: QUESTION, maxItems: 3 });
    expect(maker.calls.length).toBe(1);
    expect(reports.at(-1)!.outcome).toBe("late");
    expect(a.usedModel).toBe(false);
    maker.release();
  });
});
