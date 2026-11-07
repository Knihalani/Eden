import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderInput, type ReaderMaker } from "./reader";
import type { Trace } from "./trace";

// Repro: `readerPushBehind`'s second pass (pushCandidates) withdraws the untaken first packet BEFORE it awaits
// `verifyItems`. A take during that re-read finds neither packet: the push's context misses the agent's next request.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 27, 9);
const REQUEST = "Pay the Harlow invoice today";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const until = async (cond: () => boolean, turns = 4_000) => {
  for (let n = 0; !cond(); n++) {
    if (n >= turns) throw new Error("condition never held");
    await tick();
  }
};
const cited = (xs: Injection[]) => xs.flatMap((x) => x.citations.map((c) => c.itemId));

class Mail implements Source {
  readonly id = "mail";
  readonly kind = "test";
  readonly description = "mail";
  readonly notifies = true;
  readonly fetchReportsGone = true;
  fetches = 0;
  items: ContextItem[] = [];
  private listHeld: Promise<void> | null = null;
  private listFree: (() => void) | null = null;
  private fetchHeld: Promise<void> | null = null;
  private fetchFree: (() => void) | null = null;
  add(ref: string, title: string, text: string, at: number): void {
    this.items.push({ id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  holdList(): void {
    this.listHeld = new Promise((r) => (this.listFree = r));
  }
  releaseList(): void {
    this.listFree?.();
    this.listHeld = null;
  }
  holdFetch(): void {
    this.fetchHeld = new Promise((r) => (this.fetchFree = r));
  }
  releaseFetch(): void {
    this.fetchFree?.();
    this.fetchHeld = null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    if (this.listHeld) await this.listHeld;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    if (this.fetchHeld) await this.fetchHeld;
    return this.items.find((i) => i.ref === ref) ?? null;
  }
}

class NoReader implements ReaderMaker {
  calls: ReaderInput[] = [];
  async read(input: ReaderInput) {
    this.calls.push(input);
    return { bears: [], costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
  }
}

const HOLD = itemId("mail", "hold");
const user = { tenantId: "t1", userId: "u1" };

describe("audit A5: candidates second pass leaves a gap", () => {
  test("a take while the second pass re-reads still gets the push's packet", async () => {
    let clock = T0;
    const src = new Mail();
    src.add(
      "hold",
      "Harlow invoice on hold",
      "Harlow invoice payments are on hold until the dispute ends",
      T0 - 2 * HOUR,
    );
    for (let i = 0; i < 4; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (3 + i) * HOUR);
    const traces: Trace[] = [];
    const p = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      reader: new AskReader({ maker: new NoReader(), budget: new Budget(), now: () => clock }),
      onTrace: (t) => traces.push(t),
      config: {
        ...CORE_CONFIG,
        sync: true,
        syncPush: true,
        syncPageSize: 2,
        syncCallsPerMin: 600,
        syncMaxStaleMs: 4 * HOUR,
        syncOnDemand: true,
        syncPollBehind: true,
        askReader: true,
        readerPush: true,
        readerPushBehind: true,
        readerGate: true,
        verifyDelivery: true,
        pushCandidates: 2,
        confidentScore: 99,
        fallbackMatchedTerms: 99,
      },
    });
    p.sync!.track(user);
    while (!p.sync!.warm(user)) await p.sync!.tick();
    clock += 5 * HOUR;
    // New mail arrives: a notice makes the copy behind (the push's poll runs behind), and doubts what was read.
    src.add("lunch", "Lunch orders", "Note about lunch orders for Friday", clock);
    p.sourceNotice(user, "mail");
    src.holdList();
    await p.observe({ ...user, sessionId: "s1", at: clock, kind: "user_message", text: REQUEST } as AgentEvent, {
      waitMs: 2_000,
    });
    await until(() => traces.filter((t) => t.decision === "reader-push").length >= 1);
    const firstFetches = src.fetches;
    // The first pass queued HOLD (untaken).
    expect(traces.find((t) => t.decision === "reader-push")!.itemIds).toContain(HOLD);
    // Another notice while the poll is on the wire: the second pass must re-read HOLD again.
    p.sourceNotice(user, "mail");
    src.holdFetch();
    src.releaseList();
    await until(() => src.fetches > firstFetches);
    // The agent's next model request takes its pending context now, while the second pass waits on the re-read.
    const taken = p.takePending({ ...user, sessionId: "s1" });
    src.releaseFetch();
    await until(() => traces.filter((t) => t.decision === "reader-push").length >= 2);
    const later = p.takePending({ ...user, sessionId: "s1" });
    // Sanity: the push did deliver HOLD, one take late.
    expect(cited(later).concat(cited(taken))).toContain(HOLD);
    expect(cited(taken)).toContain(HOLD);
  });
});
