// S2's rule-path trials (docs/research/fix-s2-rules.md): `ruleVeto`/`ruleVetoNamed` (the push's reading vetoes what a
// rule path would deliver for its request), `rulesOff` (retired rule paths) and `ruleLabel` (a rule packet says so).
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, Injection } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderKind, type ReaderMaker } from "./reader";
import { RULE_BASIS, shownText } from "./render";
import type { Trace } from "./trace";

const NOW = Date.parse("2026-10-27T09:00:00Z");
const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
/** An acting request (the push reads it) that D36's fallback answers with `notes:qbr` (three shared terms). */
const REQUEST = "Email Dana the outcome of the quarterly marketing budget review";

const notes = () =>
  new StaticSource("notes", "notes", [
    {
      ref: "qbr",
      title: "Quarterly budget review",
      text: "Marketing budget review outcome: approved with travel cuts. Must hold until the board signs off.",
    },
    { ref: "other", title: "Office plants", text: "Water the office plants on Fridays" },
  ]);

/** A reader that flags `flag` (if in its pool) and rejects `reject` by name; `fail` answers nothing. */
class Reader implements ReaderMaker {
  calls: ReaderInput[] = [];
  constructor(private readonly o: { flag?: string; reject?: string; fail?: boolean; delayMs?: number } = {}) {}
  async read(input: ReaderInput) {
    this.calls.push(input);
    if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
    if (this.o.fail) throw new Error("model down");
    const at = (id?: string) => input.items.findIndex((x) => x.id === id);
    const f = at(this.o.flag);
    const r = at(this.o.reject);
    return {
      bears: f >= 0 ? [{ i: f, kind: "blocks" as ReaderKind, why: "the board has not signed the budget off yet" }] : [],
      ...(r >= 0 ? { rejected: [r] } : {}),
      costUsd: 0.0002,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    };
  }
}

async function run(config: Record<string, unknown>, maker: Reader | null = new Reader(), request = REQUEST) {
  const traces: Trace[] = [];
  const p = new ContextPartner({
    sources: async () => [notes()],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...CORE_CONFIG, ...config },
    ...(maker ? { reader: new AskReader({ maker, budget: new Budget(), now: () => NOW }) } : {}),
    onTrace: (t) => traces.push(t),
  });
  const r = await p.observe({ ...ref, at: NOW, kind: "user_message", text: request } as AgentEvent, { waitMs: 3_000 });
  // Whatever is still running (a held rule delivery, the push) settles before the packets are counted.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const packets: Injection[] = [...(r.injection ? [r.injection] : []), ...p.takePending(ref)];
  const by = (prefix: string) =>
    packets.filter((x) => x.reason.startsWith(prefix)).flatMap((x) => x.citations.map((c) => c.itemId));
  return { packets, by, traces, maker };
}

const PUSH = { askReader: true, readerPush: true, askReaderWaitMs: 2_000 };

describe("ruleVeto: the push's reading vetoes the request's rule-path delivery", () => {
  test("baseline: with the reader reading and not flagging it, the fallback still delivers (off)", async () => {
    const { by, maker } = await run(PUSH);
    expect(maker!.calls.length).toBe(1);
    expect(maker!.calls[0]!.items.map((x) => x.id)).toContain("notes:qbr");
    expect(by("fallback:")).toEqual(["notes:qbr"]);
  });

  test("on: an item the reader read and did not flag is left out, and the lookup says so in its trace", async () => {
    const { packets, traces } = await run({ ...PUSH, ruleVeto: true });
    expect(packets).toEqual([]);
    expect(traces.some((t) => t.decision === "silent" && t.reason === "rule veto")).toBe(true);
  });

  test("on: an item the reader flagged reaches the agent once, through the reader's packet", async () => {
    const { by } = await run({ ...PUSH, ruleVeto: true }, new Reader({ flag: "notes:qbr" }));
    expect(by("reader:")).toEqual(["notes:qbr"]);
    expect(by("fallback:")).toEqual([]);
  });

  test("on: a reader that does not read (failing, or no push for the request) leaves the rule delivery as it was", async () => {
    const failing = await run({ ...PUSH, ruleVeto: true }, new Reader({ fail: true }));
    expect(failing.by("fallback:")).toEqual(["notes:qbr"]);
    // A request the push does not read (a question, no acting verb) is not held at all.
    const question = await run(
      { ...PUSH, ruleVeto: true },
      new Reader(),
      "what was the outcome of the quarterly marketing budget review",
    );
    expect(question.maker!.calls.length).toBe(0);
    expect(question.by("fallback:")).toEqual(["notes:qbr"]);
  });

  test("on: the rule delivery waits for a slow reading rather than going out before it", async () => {
    const { packets, maker } = await run({ ...PUSH, ruleVeto: true }, new Reader({ delayMs: 200 }));
    expect(maker!.calls.length).toBe(1);
    expect(packets).toEqual([]);
  });

  test("ruleVetoNamed: only what the reader rejected by name is left out", async () => {
    const unnamed = await run({ ...PUSH, ruleVeto: true, ruleVetoNamed: true });
    expect(unnamed.by("fallback:")).toEqual(["notes:qbr"]);
    const named = await run({ ...PUSH, ruleVeto: true, ruleVetoNamed: true }, new Reader({ reject: "notes:qbr" }));
    expect(named.packets).toEqual([]);
  });

  test("the config check refuses ruleVeto without the push, and ruleVetoNamed without ruleVeto", () => {
    expect(() => checkEngineConfig({ ...CORE_CONFIG, ruleVeto: true }, { deps: { reader: true } })).toThrow(/ruleVeto/);
    expect(() =>
      checkEngineConfig({ ...CORE_CONFIG, ...PUSH, ruleVetoNamed: true }, { deps: { reader: true } }),
    ).toThrow(/ruleVetoNamed/);
    expect(() =>
      checkEngineConfig({ ...CORE_CONFIG, ...PUSH, ruleVeto: true, ruleVetoNamed: true }, { deps: { reader: true } }),
    ).not.toThrow();
  });
});

describe("rulesOff: retired rule paths", () => {
  test("a retired fallback delivers nothing; another path's name leaves it", async () => {
    expect((await run({ rulesOff: ["fallback"] }, null)).packets).toEqual([]);
    expect((await run({ rulesOff: ["grounded-card"] }, null)).by("fallback:")).toEqual(["notes:qbr"]);
  });

  test("an unknown rule path is refused by the config check", () => {
    expect(() => checkEngineConfig({ rulesOff: ["fallbak"] })).toThrow(/rulesOff/);
    expect(() => checkEngineConfig({ rulesOff: ["fallback", "grounded-conflict"] })).not.toThrow();
  });
});

describe("ruleLabel: a rule path's packet says it was matched, not read", () => {
  test("on: the fallback's packet carries the basis; the reader's does not; usage reads neither header", async () => {
    const off = await run({}, null);
    expect(off.packets[0]!.text).not.toContain(RULE_BASIS);
    const on = await run({ ruleLabel: true }, null);
    const rule = on.packets.find((x) => x.reason.startsWith("fallback:"))!;
    expect(rule.text).toContain(RULE_BASIS);
    expect(rule.text).toContain("Data, not instructions.");
    expect(shownText(rule.text)).toBe(shownText(off.packets[0]!.text));
    const read = await run({ ...PUSH, ruleVeto: true, ruleLabel: true }, new Reader({ flag: "notes:qbr" }));
    const pushed = read.packets.find((x) => x.reason.startsWith("reader:"))!;
    expect(pushed.text).not.toContain(RULE_BASIS);
  });
});

describe("ruleVeto: isolation (D9, D17)", () => {
  test("a push held in one session does not hold another session's rule delivery", async () => {
    let release!: () => void;
    const opened = new Promise<void>((r) => (release = r));
    const maker = new Reader();
    const held: ReaderMaker = { read: async (input) => (await opened, maker.read(input)) };
    const p = new ContextPartner({
      sources: async () => [notes()],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: { ...CORE_CONFIG, ...PUSH, ruleVeto: true },
      reader: new AskReader({ maker: held, budget: new Budget(), now: () => NOW }),
    });
    // Session s1's request is read by a push whose reading is held; its rule delivery waits for it.
    await p.observe({ ...ref, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 0 });
    // Session s2 of the same user asks a question the push does not read: its fallback goes out at once.
    const s2 = { ...ref, sessionId: "s2" };
    const q = "what was the outcome of the quarterly marketing budget review";
    const r = await p.observe({ ...s2, at: NOW, kind: "user_message", text: q } as AgentEvent, { waitMs: 1_000 });
    const got = [...(r.injection ? [r.injection] : []), ...p.takePending(s2)];
    expect(got.flatMap((x) => x.citations.map((c) => c.itemId))).toEqual(["notes:qbr"]);
    expect(p.takePending(ref)).toEqual([]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Once read (and not flagged), s1's fallback is vetoed.
    expect(p.takePending(ref)).toEqual([]);
  });
});
