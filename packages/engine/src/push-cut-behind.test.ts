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

/** A recent-first listing source whose searches take `SEARCH_MS`, as a connector's do. */
class SlowSearch implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
  constructor(
    readonly id: string,
    readonly items: ContextItem[],
    /** Every search any source of the run received, as "source query", in the order sent. */
    readonly log: string[],
  ) {}
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    this.log.push(`${this.id} ${q.text}`);
    await Bun.sleep(SEARCH_MS);
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
function world(): { sources: SlowSearch[]; fact: ContextItem; log: string[] } {
  const log: string[] = [];
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
      ),
  );
  const fact = sources[0]!.items.at(-1)!;
  fact.title = "Zed Quinn contract on hold";
  fact.text = "Do not pay Zed Quinn: the Globex renewal payment is on hold until legal signs off";
  return { sources, fact, log };
}

async function run(config: Record<string, unknown>) {
  const { sources, fact, log } = world();
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
  const t0 = performance.now();
  const r = await partner.observe({ ...ref, at: T0, kind: "user_message", text: REQUEST } as AgentEvent, {
    waitMs: 5_000,
  });
  const pathMs = performance.now() - t0;
  const got: Injection[] = r.injection ? [r.injection] : [];
  // What arrives behind the reply, until nothing is left running.
  for (let n = 0; n < 2_000; n++) {
    got.push(...partner.takePending(ref));
    const s = (partner as unknown as { sessions: Map<string, { inflight: unknown; behind: unknown }> }).sessions.get(
      `t1/u1#s1`,
    );
    if (!s?.inflight && !s?.behind) break;
    await Bun.sleep(5);
  }
  got.push(...partner.takePending(ref));
  const searches = sources.reduce((n, s) => n + s.searches, 0);
  // The loop above can end between two phases of the push's work (a moment with nothing in flight before the probes
  // start), so `searches` and `pushed` may miss its last searches; the assertions below hold wherever it ended.
  const pushed = log.slice();
  const delivered = got.flatMap((x) => x.citations.map((c) => c.itemId));
  const ask = await partner.ask({ ...ref, question: "Is the Zed Quinn Globex renewal payment on hold?" });
  return {
    pathMs,
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
    const on = await run({ pushCutBehind: true });
    // D264 on the push: it waits for the connector.
    expect(off.pathMs).toBeGreaterThanOrEqual(SEARCH_MS * 0.9);
    // The trial: the push answers from what is held.
    expect(on.pathMs).toBeLessThan(SEARCH_MS / 2);
    // The search behind found the fact and stored it, and it reached the agent as with D264 on the push.
    expect(on.cached).toBe(true);
    expect(on.delivered).toBe(off.delivered);
    expect(on.delivered).toBe(true);
    // No more connector calls: the follow-up reads what the search stored and searches nothing again. Compared as
    // sets of (source, query), not as counts at the moment the push looked idle: under load that moment fell between
    // two phases of one run and not the other (12 searches against 10). Every search the push sent with the switch
    // on, the run with it off sent too, and no source was sent the same query twice.
    // `off.log` holds the off run's ask too: where its push ended cannot be read from the log (the same race), and
    // the ask's question is another text, so its searches stand for none of the push's. What keeps a repeated
    // (source, query) from a second call may be the fan-out's held page as well as the follow-up's own guard.
    const sentOff = new Set(off.log);
    expect(on.pushed.filter((q) => !sentOff.has(q))).toEqual([]);
    expect(new Set(on.log).size).toBe(on.log.length);
    // Its calls are traced, so traces still sum to what the connectors received.
    expect(on.behindTraces.reduce((n, t) => n + t.sourceCalls, 0)).toBeGreaterThan(0);
    expect(off.behindTraces).toHaveLength(0);
    // An explicit ask keeps D264 (a cut copy is searched live; it finds the fact either way).
    expect(on.asked).toBe(true);
    expect(on.askSearches).toBeGreaterThan(0);
    expect(off.asked).toBe(true);
  });
});
