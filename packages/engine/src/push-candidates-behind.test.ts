import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { AskReader, type ReaderInput, type ReaderKind, type ReaderMaker } from "./reader";
import { CANDIDATES_NONE } from "./render";
import type { Trace } from "./trace";
import { CORE_CONFIG } from "./parts";

// `pushCandidates` (D236) under `readerPushBehind`: the poll's second pass re-picks the candidates; its packet replaces
// an untaken first one only when it has candidates of its own (review of CL6: a second pass with nothing
// constraint-like withdrew the first packet and left the agent with none).

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 27, 9);
const REQUEST = "Pay the Harlow invoice today";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const until = async (cond: () => boolean, turns = 2_000) => {
  for (let n = 0; !cond(); n++) {
    if (n >= turns) throw new Error("condition never held");
    await tick();
  }
};
const cited = (xs: Injection[]) => xs.flatMap((x) => x.citations.map((c) => c.itemId));

/** A connector with a recent-first list call that can be held open (`hold`), to see what a lookup waits for. */
class SlowListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  items: ContextItem[] = [];
  private held: Promise<void> | null = null;
  private free: (() => void) | null = null;
  constructor(readonly id: string) {}
  add(ref: string, title: string, text: string, at: number): void {
    this.items.push({ id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  hold(): void {
    this.held = new Promise((r) => (this.free = r));
  }
  release(): void {
    this.free?.();
    this.held = null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    if (this.held) await this.held;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** Flags the first of `ids` its pool holds; counts the calls that reached it. */
class PickReader implements ReaderMaker {
  calls: ReaderInput[] = [];
  constructor(public ids: string[]) {}
  async read(input: ReaderInput) {
    this.calls.push(input);
    const i = this.ids.map((id) => input.items.findIndex((x) => x.id === id)).find((k) => k >= 0) ?? -1;
    const kind: ReaderKind = "blocks";
    return {
      bears: i >= 0 ? [{ i, kind, why: "the Harlow payment depends on it" }] : [],
      costUsd: 0.0002,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    };
  }
}

const NEW = itemId("mail", "new");
const HOLD = itemId("mail", "hold");

function setup(config: Record<string, unknown> = {}, reads = [NEW, HOLD]) {
  let clock = T0;
  const src = new SlowListSource("mail");
  src.add(
    "hold",
    "Harlow invoice on hold",
    "Harlow invoice payments are on hold until the dispute ends",
    T0 - 2 * HOUR,
  );
  for (let i = 0; i < 4; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * HOUR);
  const maker = new PickReader(reads);
  const traces: Trace[] = [];
  const p = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    reader: new AskReader({ maker, budget: new Budget(), now: () => clock }),
    onTrace: (t) => traces.push(t),
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPageSize: 2,
      syncCallsPerMin: 600,
      syncMaxStaleMs: 4 * HOUR,
      syncPollBehind: true,
      askReader: true,
      readerPush: true,
      readerPushBehind: true,
      // The event's own lookup delivers nothing with no model here, so every packet is the push's.
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      ...config,
    },
  });
  const warm = async (s: Scope) => {
    p.sync!.track(s);
    while (!p.sync!.warm(s)) await p.sync!.tick();
  };
  return { p, src, maker, traces, warm, advance: (ms: number) => (clock += ms), now: () => clock };
}

const user = { tenantId: "t1", userId: "u1" };
const say = (p: ContextPartner, at: number, s: Scope = user, sessionId = "s1", text = REQUEST) =>
  p.observe({ ...s, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });

describe("pushCandidates under readerPushBehind (D236)", () => {
  test("a second pass with the same constraint item re-delivers it once, with no reader call", async () => {
    const { p, src, maker, traces, warm, advance, now } = setup({ pushCandidates: 2, readerGate: true });
    await warm(user);
    advance(5 * HOUR);
    src.add("lunch", "Lunch orders", "Note about lunch orders for Friday", now());
    src.hold();
    await say(p, now());
    src.release();
    await until(() => traces.filter((t) => t.decision === "reader-push").length >= 2);
    await Bun.sleep(20);
    const packets = p.takePending({ ...user, sessionId: "s1" }).filter((x) => x.reason.startsWith("candidates:"));
    expect(packets.length).toBe(1);
    expect(cited(packets)).toContain(HOLD);
    expect(maker.calls.length).toBe(0);
  });

  test("a second pass with nothing constraint-like keeps the untaken first packet", async () => {
    const { p, src, traces, warm, advance, now } = setup({ pushCandidates: 2, askReaderPool: 1, readerGate: true });
    await warm(user);
    advance(5 * HOUR);
    for (let i = 0; i < 3; i++) {
      src.add(`inv${i}`, `Harlow invoice ${i}`, `Harlow invoice today: pay the Harlow invoice ${i} PDF`, now());
    }
    src.hold();
    await say(p, now());
    src.release();
    await until(() => traces.filter((t) => t.decision === "reader-push").length >= 2, 5_000);
    await Bun.sleep(20);
    const packets = p.takePending({ ...user, sessionId: "s1" });
    expect(cited(packets)).toContain(HOLD);
  });

  test("pushCandidateNone: a pool with nothing constraint-like gets the note, citing nothing", async () => {
    const { p, src, warm, advance, now } = setup({ pushCandidates: 2, pushCandidateNone: true, readerGate: true });
    src.items = src.items.filter((x) => x.id !== HOLD);
    await warm(user);
    advance(5 * HOUR);
    await say(p, now());
    await Bun.sleep(20);
    const got = p.takePending({ ...user, sessionId: "s1" });
    expect(got.length).toBe(1);
    expect(got[0]!.citations).toEqual([]);
    expect(got[0]!.reason.startsWith("checked:")).toBe(true);
    expect(got[0]!.text).toContain(CANDIDATES_NONE);
  });

  test("a candidates push is traced with no model call", async () => {
    const { p, traces, warm, advance, now } = setup({ pushCandidates: 2, readerGate: true });
    await warm(user);
    advance(5 * HOUR);
    await say(p, now());
    await until(() => traces.some((t) => t.decision === "reader-push"));
    for (const t of traces.filter((x) => x.decision === "reader-push")) expect(t.modelCalls).toBe(0);
  });
});
