import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type ChatResponse, type Model } from "@eden/llm";
import { itemId, type AgentEvent, type Injection } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import type { Trace } from "./trace";

// `slowPathQueue`: a request that arrives while the session's slow path is busy is kept (one slot, the latest wins)
// and looked up once that slow path settles, instead of being dropped.

const T0 = Date.UTC(2026, 9, 20, 9);

/** A judge that takes `ms` to answer, and picks its first candidate. */
class SlowJudge implements Model {
  readonly id = "slow";
  readonly calls: ChatRequest[] = [];
  private readonly inner = new FakeModel(() => '{"pick": [0]}');
  constructor(private readonly ms: number) {}
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Counted when made, not when answered.
    this.calls.push(request);
    await Bun.sleep(this.ms);
    return this.inner.chat(request);
  }
}

const notes = new StaticSource("notes", "notes", [
  { ref: "globex", title: "Globex renewal", text: "The Globex renewal is due in March at the current price" },
  { ref: "initech", title: "Initech contact", text: "Bill Lumbergh is the Initech contact for the TPS project" },
]);
const INITECH = itemId("notes", "initech");
const FIRST = "anything about the Globex renewal?";
const SECOND = "Who is the contact at Initech, Bill Lumbergh?";

function make(config: Record<string, unknown>) {
  let clock = T0;
  const traces: Trace[] = [];
  const model = new SlowJudge(300);
  const p = new ContextPartner({
    sources: async () => [notes],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model,
    now: () => clock,
    // Nothing is sure enough to skip the judge: every lookup makes its call.
    config: { confidentScore: 5, ...config },
    onTrace: (t) => traces.push(t),
  });
  return { p, traces, model, advance: (ms: number) => (clock += ms), now: () => clock };
}

const ev = (sessionId: string, text: string, userId = "u1") =>
  ({ tenantId: "t1", userId, sessionId, at: T0, kind: "user_message", text }) as AgentEvent;
const cited = (xs: (Injection | null | undefined)[]) => xs.flatMap((x) => x?.citations.map((c) => c.itemId) ?? []);

/**
 * Waits until the judge has had `calls` calls (at most 1 s), then for one more judge call's length and a margin: a
 * second lookup that was going to run has made its call and finished by then.
 */
async function settle(model: SlowJudge, calls: number) {
  for (let i = 0; i < 100 && model.calls.length < calls; i++) await Bun.sleep(10);
  await Bun.sleep(450);
}

describe("slowPathQueue", () => {
  test("on: a request made during the slow path is looked up after it settles, and its context is pending", async () => {
    const { p, traces, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    const r2 = await p.observe(ev("s1", SECOND), { waitMs: 0 });
    expect(r2.injection).toBeNull();
    expect(r2.pending).toBe(true);
    expect(traces.at(-1)?.reason).toBe("slow path busy: queued");
    await first;
    // The second request waits for the first's judge (300 ms); it is not run beside it.
    await Bun.sleep(150);
    expect(model.calls.length).toBe(1);
    await settle(model, 2);
    expect(model.calls.length).toBe(2);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).toContain(INITECH);
  });

  test("off: the request is dropped as before (traced 'slow path busy'), and nothing is delivered for it", async () => {
    const { p, traces, model } = make({});
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    const before = traces.length;
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    expect(traces.slice(before).map((t) => [t.decision, t.reason])).toEqual([["silent", "slow path busy"]]);
    await first;
    await settle(model, 1);
    expect(model.calls.length).toBe(1);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).not.toContain(INITECH);
  });

  test("the latest request wins the slot: an earlier queued one is never looked up", async () => {
    const { p, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    await p.observe(ev("s1", "What did the Hooli procurement team say?"), { waitMs: 0 });
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    await first;
    await settle(model, 2);
    // Two judge calls (first, then the latest), not three.
    expect(model.calls.length).toBe(2);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).toContain(INITECH);
  });

  test("a queued request that waited past the staleness bound is dropped, traced", async () => {
    const { p, traces, model, advance } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    advance(11_000);
    await first;
    await settle(model, 1);
    expect(model.calls.length).toBe(1);
    expect(traces.some((t) => t.reason === "queued cue: stale")).toBe(true);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "s1" }))).not.toContain(INITECH);
  });

  test("a queued request whose session closes is never looked up", async () => {
    const { p, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("s1", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    await p.observe(ev("s1", SECOND), { waitMs: 0 });
    await p.observe({ ...ev("s1", ""), kind: "session_end" } as AgentEvent);
    await first;
    await settle(model, 1);
    expect(model.calls.length).toBe(1);
  });

  test("isolation: a request queued in one session never runs or delivers in another", async () => {
    const { p, traces, model } = make({ slowPathQueue: true });
    const first = p.observe(ev("a", FIRST), { waitMs: 0 });
    await Bun.sleep(20);
    await p.observe(ev("a", SECOND), { waitMs: 0 });
    // Same tenant, another user; and the same user in another session: neither is busy, neither holds a queued cue.
    await p.observe(ev("b", "thanks, sounds good", "u2"), { waitMs: 0 });
    await p.observe(ev("c", "thanks, sounds good"), { waitMs: 0 });
    await first;
    await settle(model, 2);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "a" }))).toContain(INITECH);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u2", sessionId: "b" }))).toEqual([]);
    expect(cited(p.takePending({ tenantId: "t1", userId: "u1", sessionId: "c" }))).toEqual([]);
    const elsewhere = traces.filter((t) => t.sessionId !== "a");
    expect(elsewhere.some((t) => t.itemIds.includes(INITECH))).toBe(false);
    expect(elsewhere.some((t) => t.reason.startsWith("queued cue"))).toBe(false);
  });
});
