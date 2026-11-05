import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderMaker } from "./reader";

// D140: an explicit ask has one deadline for its whole lookup. The on-demand sync poll, the live search and the probes
// share it, so a source whose listing and search both hang holds the reader back about `sourceTimeoutMs`, not twice
// that (the poll's own 1.5 s, then a fresh 1.5 s for the search).

const scope: Scope = { tenantId: "t", userId: "u" };
const TIMEOUT = 1_500;

/** A notifying source that answers until `hang` is set; then its listing and its search never answer. */
class Hanging implements Source {
  readonly id = "notes";
  readonly kind = "test";
  readonly description = "notes";
  readonly notifies = true;
  hang = false;
  lists = 0;
  searches = 0;
  private readonly items: ContextItem[] = [
    {
      id: itemId("notes", "q1"),
      sourceId: "notes",
      ref: "q1",
      title: "Quarterly offsite",
      text: "The quarterly offsite is in Lisbon on 12 November; book the train before Friday.",
      updatedAt: Date.now() - 3_600_000,
    },
  ];
  private never(signal?: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
    });
  }
  async list(_s: Scope, cursor: string | undefined, limit: number, signal?: AbortSignal): Promise<ListPage> {
    this.lists++;
    if (this.hang) return this.never(signal);
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
  async search(q: SearchQuery, signal?: AbortSignal): Promise<ContextItem[]> {
    this.searches++;
    if (this.hang) return this.never(signal);
    const words = q.text.toLowerCase().split(/\W+/);
    return this.items.filter((i) => words.some((w) => w.length > 3 && i.text.toLowerCase().includes(w)));
  }
}

async function setup(config: Record<string, unknown> = {}) {
  const src = new Hanging();
  let readerAt: number[] = [];
  // The engine's clock (the sync's poll window runs on it), movable ahead of the wall clock.
  let skew = 0;
  const now = () => Date.now() + skew;
  const maker: ReaderMaker = {
    read: async () => {
      readerAt.push(performance.now());
      return { bears: [], costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
    },
  };
  const partner = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now,
    reader: new AskReader({ maker, budget: new Budget(), now }),
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: true,
      syncOnDemand: true,
      syncPageSize: 100,
      probes: true,
      askReader: true,
      askReaderWaitMs: 200,
      sourceTimeoutMs: TIMEOUT,
      ...config,
    },
  });
  partner.sync!.track(scope, now());
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  // The source says it changed, then stops answering: the ask's poll and its live search both hang.
  partner.sourceChanged(scope, "notes");
  src.hang = true;
  const ask = async (sessionId: string) => {
    readerAt = [];
    const t0 = performance.now();
    const r = await partner.ask({ ...scope, sessionId, question: "Book the train to the quarterly offsite" });
    return { r, beforeReader: readerAt.length > 0 ? readerAt[0]! - t0 : null, totalMs: performance.now() - t0 };
  };
  return { partner, src, ask, advance: (ms: number) => (skew += ms) };
}

describe("D140: one deadline for an ask's poll, live search and probes", () => {
  test("a source whose listing and search both hang holds the reader back one sourceTimeoutMs, not two", async () => {
    const { src, ask } = await setup();
    const listsBefore = src.lists;
    const { r, beforeReader } = await ask("s1");
    expect(src.lists).toBeGreaterThan(listsBefore); // The poll was made (and hung) ...
    expect(beforeReader).not.toBeNull(); // ... and the reader still read the held copy.
    expect(beforeReader!).toBeLessThan(TIMEOUT + 250);
    // The source that did not answer is named: an empty or partial answer is not an all-clear (D127).
    expect(r.sources?.find((x) => x.sourceId === "notes")?.status).not.toBe("ok");
  }, 10_000);

  test("an ask just after a poll that timed out does not poll that source again: it is searched live", async () => {
    const { src, ask } = await setup();
    await ask("s1");
    const lists = src.lists;
    const searches = src.searches;
    const { beforeReader } = await ask("s2");
    expect(src.lists).toBe(lists);
    expect(src.searches).toBeGreaterThan(searches);
    expect(beforeReader!).toBeLessThan(TIMEOUT + 250);
  }, 10_000);

  test("once sourceTimeoutMs has passed since that poll gave up, the source is polled again", async () => {
    const { src, ask, advance } = await setup();
    await ask("s1");
    const lists = src.lists;
    advance(TIMEOUT);
    await ask("s2");
    expect(src.lists).toBeGreaterThan(lists);
  }, 10_000);
});
