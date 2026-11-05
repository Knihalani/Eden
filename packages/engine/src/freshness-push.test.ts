import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderMaker } from "./reader";

// D126 on the reader's push: the reader's likely picks are re-read beside its call (`checkAhead`), the delivery shares
// that re-read, and a packet whose re-read outlasts a newer user message is not queued.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const HOLD = itemId("mail", "hold");
const cited = (xs: Injection[]) => xs.flatMap((x) => x.citations.map((c) => c.itemId));
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A notifying mail source whose fetch can be held open. */
class Mail implements Source {
  readonly id = "mail";
  readonly kind = "test";
  readonly description = "mail";
  readonly notifies = true;
  readonly fetchReportsGone = true;
  fetches = 0;
  items = new Map<string, ContextItem>();
  private held: Promise<void> | null = null;
  private free: (() => void) | null = null;
  add(ref: string, title: string, text: string, at: number): void {
    this.items.set(ref, { id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  hold(): void {
    this.held = new Promise((r) => (this.free = r));
  }
  release(): void {
    this.free?.();
    this.held = null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    // An index that lags the mailbox: it answers with nothing new, so only the held copy or a fetch can answer.
    return [...this.items.values()].filter(
      (i) => i.ref !== "hold" && words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)),
    );
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const sorted = [...this.items.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    if (this.held) await this.held;
    return this.items.get(ref) ?? null;
  }
}

/** Flags HOLD whenever its pool holds it. */
class PickHold implements ReaderMaker {
  calls: ReaderInput[] = [];
  async read(input: ReaderInput) {
    this.calls.push(input);
    const i = input.items.findIndex((x) => x.id === HOLD);
    return {
      bears: i >= 0 ? [{ i, kind: "blocks" as const, why: "the Harlow payment depends on it" }] : [],
      costUsd: 0.0002,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    };
  }
}

async function setup() {
  let clock = T0;
  const src = new Mail();
  // The oldest item, so a poll's newest page does not read it again: only a fetch can.
  src.add(
    "hold",
    "Harlow invoice on hold",
    "Harlow invoice payments are on hold until the dispute ends",
    T0 - 9 * HOUR,
  );
  for (let i = 0; i < 3; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (1 + i) * HOUR);
  const maker = new PickHold();
  const p = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    reader: new AskReader({ maker, budget: new Budget(), now: () => clock }),
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: true,
      syncPageSize: 1,
      syncPollPageSize: 1,
      syncCallsPerMin: 600,
      verifyDelivery: true,
      askReader: true,
      readerPush: true,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
    },
  });
  const user = { tenantId: "t1", userId: "u1" };
  p.sync!.track(user, clock);
  while (!p.sync!.warm(user)) await p.sync!.tick();
  clock += 10 * 60_000;
  const say = (text: string) =>
    p.observe({ ...user, sessionId: "s1", at: clock, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return { p, src, maker, user, say, advance: (ms: number) => (clock += ms) };
}

describe("verifyDelivery on the reader's push", () => {
  test("a signalled copy is re-read once, beside the reader, and the push delivers the current one", async () => {
    const { p, src, maker, user, say } = await setup();
    src.add("hold", "Harlow invoice on hold", "Harlow dispute settled: the invoice may be paid now", T0 - 9 * HOUR);
    expect(p.sourceChanged(user, "mail")).toBe(true);
    await say("Pay the Harlow invoice today");
    expect(maker.calls.length).toBeGreaterThanOrEqual(1);
    const packets = p.takePending({ ...user, sessionId: "s1" });
    expect(cited(packets)).toContain(HOLD);
    const text = packets.map((x) => x.text).join("\n");
    expect(text).toContain("dispute settled");
    expect(text).not.toContain("on hold until");
    expect(src.fetches).toBe(1); // Started ahead and shared with the delivery.
  });

  test("a re-read that outlasts a newer user message: the stale push is not queued, and stays deliverable", async () => {
    const { p, src, user, say, advance } = await setup();
    expect(p.sourceChanged(user, "mail")).toBe(true);
    src.hold();
    const first = say("Pay the Harlow invoice today");
    for (let n = 0; src.fetches === 0 && n < 2_000; n++) await tick();
    expect(src.fetches).toBeGreaterThanOrEqual(1);
    advance(1_000);
    const second = say("thanks");
    src.release();
    await Promise.all([first, second]);
    expect(cited(p.takePending({ ...user, sessionId: "s1" }))).not.toContain(HOLD);
    // Not marked delivered: a later request that needs it still gets it.
    advance(60_000);
    await say("Pay the Harlow invoice today");
    expect(cited(p.takePending({ ...user, sessionId: "s1" }))).toContain(HOLD);
  });
});
