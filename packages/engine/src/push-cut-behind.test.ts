/**
 * `pushCutBehind` (D405, D406: on in the default; docs/research/b1-scale-path.md): on the push, a synced copy the
 * user's cap cut answers from the index as it stands and its live search (D264) runs behind; what that search stores
 * reaches the agent through the lookup's follow-up and the push's second reading. An explicit ask keeps D264.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import type { Trace } from "./trace";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 7, 9);
const SEARCH_MS = 300;
const scope = { tenantId: "t1", userId: "u1" };
const REQUEST = "Pay Zed Quinn for the Globex renewal today";

/**
 * While set, every search waits for it instead of `SEARCH_MS`: whether the push waited for its cut copies' searches is
 * read from the searches still running when it returns (neither answered nor called off by a deadline), not from a
 * wall-clock bound (one at SEARCH_MS / 2 failed at 197 ms under load, D1965).
 */
let searchesHeld: Promise<void> | null = null;
/** Long enough that a push waiting for held searches is caught, short enough to end the test well inside its limit. */
const HOLD_MS = 3_000;

/** A recent-first listing source whose searches take `SEARCH_MS`, as a connector's do. */
class SlowSearch implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
  /** Searches that have answered. */
  answered = 0;
  /** The signals of the searches still out: neither answered nor failed. */
  readonly out = new Set<AbortSignal | undefined>();
  constructor(
    readonly id: string,
    readonly items: ContextItem[],
    /** Every search any source of the run received, as "source query", in the order sent. */
    readonly log: string[],
    /** When any source of the run last started a search (`performance.now()`). */
    readonly clock: { last: number },
  ) {}
  async search(q: SearchQuery, signal?: AbortSignal): Promise<ContextItem[]> {
    this.searches++;
    this.log.push(`${this.id} ${q.text}`);
    this.clock.last = performance.now();
    // A fresh object per search, so two searches without a signal are two entries.
    const mine = signal ?? (new AbortController().signal as AbortSignal | undefined);
    this.out.add(mine);
    await (searchesHeld ?? Bun.sleep(SEARCH_MS)).finally(() => this.out.delete(mine));
    this.answered++;
    this.clock.last = performance.now();
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return this.items
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)))
      .slice(0, q.limit);
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** 4 sources of 10 items for a cap of 20: every copy is cut. Source 0's oldest item, far past the cut, is the fact. */
function world(): { sources: SlowSearch[]; fact: ContextItem; log: string[]; clock: { last: number } } {
  const log: string[] = [];
  const clock = { last: 0 };
  const sources = Array.from(
    { length: 4 },
    (_, k) =>
      new SlowSearch(
        `src${k}`,
        Array.from({ length: 10 }, (_, i) => ({
          id: itemId(`src${k}`, `i${i}`),
          sourceId: `src${k}`,
          ref: `i${i}`,
          title: `Item ${k}-${i}`,
          text: `filler words for source ${k} item ${i}`,
          updatedAt: T0 - (k + 4 * i) * HOUR,
        })),
        log,
        clock,
      ),
  );
  const fact = sources[0]!.items.at(-1)!;
  fact.title = "Zed Quinn contract on hold";
  fact.text = "Do not pay Zed Quinn: the Globex renewal payment is on hold until legal signs off";
  return { sources, fact, log, clock };
}

/** One push and one ask. `hold`: the push's searches stay unanswered until it has returned (or `HOLD_MS` passes). */
async function run(config: Record<string, unknown>, hold = false) {
  const { sources, fact, log, clock } = world();
  const cache = new ItemCache();
  const traces: Trace[] = [];
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => T0,
    onTrace: (t) => traces.push(t),
    config: {
      sync: true,
      syncOnDemand: true,
      syncPollBehind: true,
      syncLocalComplete: true,
      syncPageSize: 10,
      syncMaxItems: 20,
      syncCallsPerMin: 6_000,
      ...config,
    },
  });
  partner.sync!.track(scope);
  for (let i = 0; i < 200 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
  for (const s of sources) expect(partner.sync!.complete(scope, s.id)).toBe(false);
  const ref = { ...scope, sessionId: "s1" };
  let release = () => {};
  if (hold) searchesHeld = new Promise((r) => (release = r));
  const fallback = setTimeout(() => release(), HOLD_MS);
  const t0 = performance.now();
  const r = await partner
    .observe({ ...ref, at: T0, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 5_000 })
    .finally(() => {
      clearTimeout(fallback);
      searchesHeld = null;
    });
  const pathMs = performance.now() - t0;
  const answeredAtReply = sources.reduce((n, s) => n + s.answered, 0);
  const readingAtReply = sources.reduce((n, s) => n + [...s.out].filter((x) => !x?.aborted).length, 0);
  release();
  const got: Injection[] = r.injection ? [r.injection] : [];
  // What arrives behind the reply, until nothing is left running and no search has started for 2 x SEARCH_MS: the
  // session can look idle between two phases of the push's work (a moment with nothing in flight before the probes
  // start), and a snapshot taken there missed the push's last searches under load. A search started after a quiet
  // period that long would follow no search of the push's (each ends within SEARCH_MS of its start).
  for (let n = 0; n < 2_000; n++) {
    got.push(...partner.takePending(ref));
    const s = (partner as unknown as { sessions: Map<string, { inflight: unknown; behind: unknown }> }).sessions.get(
      `t1/u1#s1`,
    );
    if (!s?.inflight && !s?.behind && performance.now() - clock.last >= 2 * SEARCH_MS) break;
    await Bun.sleep(5);
  }
  got.push(...partner.takePending(ref));
  const searches = sources.reduce((n, s) => n + s.searches, 0);
  // Every search the push sent, and none of the ask's below.
  const pushed = log.slice();
  const delivered = got.flatMap((x) => x.citations.map((c) => c.itemId));
  const ask = await partner.ask({ ...ref, question: "Is the Zed Quinn Globex renewal payment on hold?" });
  return {
    pathMs,
    answeredAtReply,
    readingAtReply,
    searches,
    cached: cache.get(scope, fact.id, T0) !== null,
    delivered: delivered.includes(fact.id),
    asked: ask.citations.some((c) => c.itemId === fact.id),
    askSearches: sources.reduce((n, s) => n + s.searches, 0) - searches,
    pushed,
    log,
    behindTraces: traces.filter((t) => t.reason === "cut search behind"),
  };
}

describe("pushCutBehind (D405)", () => {
  test("the push stops waiting on a cut copy's live search; its find still reaches the agent", async () => {
    const off = await run({ pushCutBehind: false });
    const on = await run({ pushCutBehind: true }, true);
    // D264 on the push: it waits for the connector.
    expect(off.pathMs).toBeGreaterThanOrEqual(SEARCH_MS * 0.9);
    expect(off.answeredAtReply).toBeGreaterThan(0);
    // The trial: the push answers from what is held, with no search answered and its searches behind still being
    // read: it waited neither for them nor for their deadline.
    expect(on.answeredAtReply).toBe(0);
    expect(on.readingAtReply).toBeGreaterThan(0);
    expect(on.pathMs).toBeLessThan(HOLD_MS);
    // The search behind found the fact and stored it, and it reached the agent as with D264 on the push.
    expect(on.cached).toBe(true);
    expect(on.delivered).toBe(off.delivered);
    expect(on.delivered).toBe(true);
    // No more connector calls: the follow-up reads what the search stored and searches nothing again. Compared as
    // sets of (source, query): every search the push sent with the switch on, the push with it off sent too (push
    // against push: the off run's ask searches are left out, so a push that adds an ask-like query fails here), and
    // no source was sent the same query twice. What keeps a repeated (source, query) from a second call may be the
    // fan-out's held page as well as the follow-up's own guard.
    const sentOff = new Set(off.pushed);
    expect(on.pushed.filter((q) => !sentOff.has(q))).toEqual([]);
    expect(new Set(on.log).size).toBe(on.log.length);
    // Its calls are traced, so traces still sum to what the connectors received.
    expect(on.behindTraces.reduce((n, t) => n + t.sourceCalls, 0)).toBeGreaterThan(0);
    expect(off.behindTraces).toHaveLength(0);
    // An explicit ask keeps D264 (a cut copy is searched live; it finds the fact either way).
    expect(on.asked).toBe(true);
    expect(on.askSearches).toBeGreaterThan(0);
    expect(off.asked).toBe(true);
  }, 30_000);
});
