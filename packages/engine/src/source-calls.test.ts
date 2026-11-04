import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { QueryPlanner, reachedSource, SourceFanout, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { AskReader, type ReaderMaker } from "./reader";
import type { Trace } from "./trace";
import { CORE_CONFIG } from "./parts";

/**
 * Trace `sourceCalls` are the calls a connector received (audit 2026-11-03, finding 18). With `readerPush`, the push's
 * lookup runs beside the event's slow path over the same words: a search that joins the other's call in flight, or is
 * answered by the fan-out's cache, is no call; a source only the push asked is one. The lab sums these as calls per
 * task, so the sum over a session's traces must equal what the connectors counted.
 */

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const REQUEST = "Pay the Harlow invoice for the venue deposit today.";
const SOURCES = ["mail", "docs", "chat", "crm"];

const itemsOf = (sourceId: string): ContextItem[] =>
  [0, 1, 2].map((i) => ({
    id: `${sourceId}:${i}`,
    sourceId,
    ref: String(i),
    title: `Harlow invoice ${i}`,
    text: `Harlow venue deposit invoice note ${i} from ${sourceId}.`,
    updatedAt: NOW - (i + 1) * 3_600_000,
  }));

/** Searches started and not yet answered, across every `counting` connector of a run. */
type Flights = { n: number };

/** A connector that counts every search it receives and answers after `delayMs`, so lookups overlap in flight. */
const counting = (id: string, sent: Map<string, number>, delayMs: number, flights: Flights = { n: 0 }): Source => ({
  id,
  kind: "test",
  description: id,
  search: async () => {
    sent.set(id, (sent.get(id) ?? 0) + 1);
    flights.n++;
    try {
      await Bun.sleep(delayMs);
    } finally {
      flights.n--;
    }
    return itemsOf(id);
  },
});

/** One turn of the event loop. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Waits until everything a request started (slow path, push, probes) has finished: no search in flight, and no new
 * search or trace over `quietTurns` event-loop turns in a row. A search in flight is waited for, so this waits for the
 * connectors' own delay and no more, instead of a fixed sleep past it.
 */
async function settled(flights: Flights, traces: Trace[], sent: Map<string, number>, quietTurns = 50) {
  const mark = () => `${flights.n}/${traces.length}/${total(sent)}`;
  let calm = 0;
  for (let i = 0; i < 100_000 && calm < quietTurns; i++) {
    const before = mark();
    await turn();
    calm = flights.n === 0 && mark() === before ? calm + 1 : 0;
  }
  if (calm < quietTurns) throw new Error("the request's work never settled");
}

/** Flags nothing; answers at once at no cost. */
const quiet: ReaderMaker = { read: async () => ({ bears: [], costUsd: 0 }) };

const total = (sent: Map<string, number>) => [...sent.values()].reduce((a, b) => a + b, 0);
const traced = (traces: Trace[]) => traces.reduce((n, t) => n + t.sourceCalls + (t.anticipateCalls ?? 0), 0);

async function run(
  config: Record<string, unknown>,
  opts: { delayMs?: number; planner?: boolean; requests?: number } = {},
): Promise<{ traces: Trace[]; sent: Map<string, number> }> {
  const sent = new Map<string, number>();
  const flights: Flights = { n: 0 };
  const sources = SOURCES.map((id) => counting(id, sent, opts.delayMs ?? 20, flights));
  const traces: Trace[] = [];
  const p = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...CORE_CONFIG, askReader: true, askReaderWaitMs: 1_000, ...config },
    reader: new AskReader({ maker: quiet, budget: new Budget(), now: () => NOW }),
    ...(opts.planner ? { planner: new QueryPlanner({ seed: 7 }) } : {}),
    onTrace: (t) => traces.push(t),
  });
  const scope = { tenantId: "t", userId: "u1" };
  for (let k = 0; k < (opts.requests ?? 1); k++) {
    const sessionId = `s${k}`;
    await p.observe({ ...scope, sessionId, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, {
      waitMs: 2_000,
    });
    // Everything the request started (slow path, push, probes past their grace) has finished before it is counted.
    await settled(flights, traces, sent);
  }
  return { traces, sent };
}

describe("trace sourceCalls are the calls connectors received", () => {
  test("readerPush: push and slow path search the same query; the sum of sourceCalls is the connector's count", async () => {
    // The slow path asks 2 sources, the push 4: the two it shares join (or are cached), the other two are the push's.
    const { traces, sent } = await run({ readerPush: true, lookupSources: 2, askSources: 4 });
    const pushed = traces.filter((t) => t.decision === "reader-push");
    expect(pushed.length).toBe(1);
    // Each source was searched once: the overlap was shared, not sent twice.
    expect([...sent.values()]).toEqual([1, 1, 1, 1]);
    expect(traced(traces)).toBe(total(sent));
    // The push's own sources are its calls, on its trace (not 0, and not counted again on the slow path's).
    expect(pushed[0]!.sourceCalls).toBeGreaterThanOrEqual(2);
  });

  test("a repeat request answered by the fan-out's cache counts no call", async () => {
    const { traces, sent } = await run({ readerPush: true, lookupSources: 2, askSources: 4 }, { requests: 2 });
    expect(total(sent)).toBe(4);
    expect(traced(traces)).toBe(4);
  });

  test("push off: unchanged, the slow path's calls are the connector's", async () => {
    const { traces, sent } = await run({ readerPush: false, lookupSources: 2, askSources: 4 });
    expect(total(sent)).toBe(2);
    expect(traced(traces)).toBe(2);
  });

  test("with the query planner serving, its calls are counted where they reach the connector", async () => {
    const { traces, sent } = await run({ readerPush: true, lookupSources: 2, askSources: 4 }, { planner: true });
    expect(total(sent)).toBeGreaterThan(0);
    expect(traced(traces)).toBe(total(sent));
  });

  test("with probes on, the probes' calls that joined or were cached are not counted either", async () => {
    const { traces, sent } = await run(
      { readerPush: true, lookupSources: 2, askSources: 4, probes: true, probeGraceMs: 1_000 },
      { requests: 2 },
    );
    expect(total(sent)).toBeGreaterThan(4);
    expect(traced(traces)).toBe(total(sent));
  });
});

describe("reachedSource: which fan-out outcomes were calls", () => {
  test("a joined flight and a cache hit are not calls; the leader's call is", async () => {
    const sent = new Map<string, number>();
    const f = new SourceFanout({ sanitize: (x) => x });
    const src = counting("mail", sent, 20);
    const q = { scope: { tenantId: "t", userId: "u" }, text: "harlow invoice", entities: [], limit: 8 };
    const [a, b] = await Promise.all([
      f.search([src], q, { timeoutMs: 1_000 }),
      f.search([src], q, { timeoutMs: 1_000 }),
    ]);
    const [c] = await f.search([src], q, { timeoutMs: 1_000 });
    expect(sent.get("mail")).toBe(1);
    expect([a[0]!, b[0]!].filter(reachedSource).length).toBe(1);
    expect([a[0]!, b[0]!].filter((o) => o.joined).length).toBe(1);
    expect(c!.status).toBe("cached");
    expect(reachedSource(c!)).toBe(false);
  });

  test("a guard's refusal is no call, even when a stale result stands in for it", () => {
    const o = { sourceId: "mail", items: [], latencyMs: 0 };
    expect(reachedSource({ ...o, status: "busy" })).toBe(false);
    expect(reachedSource({ ...o, status: "stale", error: "limited" })).toBe(false);
    expect(reachedSource({ ...o, status: "stale", error: "Error: 500 Internal Server Error" })).toBe(true);
    expect(reachedSource({ ...o, status: "timeout" })).toBe(true);
  });
});
