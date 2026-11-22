/**
 * `askBehind` (D430, trial; docs/research/c4-ask-path.md): an explicit ask's lookup runs behind as the push's does
 * (D405), waiting at most `askBehindWaitMs`. Done in time, the answer is D264's; not, it answers from what is held,
 * names the sources still being read (never an all-clear, D127), and what they then find goes out at the next take.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG } from "./config";
import { CORE_CONFIG, PARTS } from "./parts";
import { ContextPartner } from "./partner";
import { AskReader, type ReaderInput, type ReaderMaker } from "./reader";
import type { Trace } from "./trace";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 9);
const SEARCH_MS = 300;
const QUESTION = "Is the Zed Quinn Globex renewal payment on hold?";

/**
 * While set, every search waits for it instead of `SEARCH_MS`: a test that asks whether an answer waited for the
 * searches reads it from the searches still running at the answer (neither answered nor called off), not from a
 * wall-clock bound (one at SEARCH_MS / 2 failed at 192 ms under load, D1965).
 */
let searchesHeld: Promise<void> | null = null;

/** A recent-first listing source whose searches take `SEARCH_MS`, as a connector's do. */
class SlowSearch implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
  /** The signals of the searches still out: neither answered nor failed. */
  readonly out = new Set<AbortSignal | undefined>();
  /** Set: the connector is down (no search, listing or re-read can confirm what a signal doubted). */
  down = false;
  /** Set: the source sends change notices (D125), so a signal doubts its held copies (D126). */
  notifies = false;
  constructor(
    readonly id: string,
    readonly items: ContextItem[],
  ) {}
  async search(q: SearchQuery, signal?: AbortSignal): Promise<ContextItem[]> {
    this.searches++;
    // A fresh object per search, so two searches without a signal are two entries.
    const mine = signal ?? (new AbortController().signal as AbortSignal | undefined);
    this.out.add(mine);
    await (searchesHeld ?? Bun.sleep(SEARCH_MS)).finally(() => this.out.delete(mine));
    if (this.down) throw new Error("503 upstream down");
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return this.items
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)))
      .slice(0, q.limit);
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    if (this.down) throw new Error("503 upstream down");
    return this.items.find((i) => i.ref === ref) ?? null;
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    if (this.down) throw new Error("503 upstream down");
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** 4 sources of 10 items for a cap of 20: every copy is cut. Source 0's oldest item, far past the cut, is the fact. */
function world(user: string): { sources: SlowSearch[]; fact: ContextItem } {
  const sources = Array.from(
    { length: 4 },
    (_, k) =>
      new SlowSearch(
        `src${k}`,
        Array.from({ length: 10 }, (_, i) => ({
          id: itemId(`src${k}`, `${user}-i${i}`),
          sourceId: `src${k}`,
          ref: `${user}-i${i}`,
          title: `Item ${k}-${i}`,
          text: `filler words for source ${k} item ${i}`,
          updatedAt: T0 - (k + 4 * i) * HOUR,
        })),
      ),
  );
  const fact = sources[0]!.items.at(-1)!;
  fact.title = "Zed Quinn contract on hold";
  fact.text = "Do not pay Zed Quinn: the Globex renewal payment is on hold until legal signs off";
  return { sources, fact };
}

const SYNC_PART = Object.fromEntries(
  Object.keys(PARTS.sync).map((k) => [k, DEFAULT_CONFIG[k as keyof typeof DEFAULT_CONFIG]]),
);

/** Set while a test's ask runs: its slow listings sleep only then, so the sync warms at once. */
let partnerReady = false;
/** The partner's clock: T0, moved past the staleness bound by a test that needs its copies polled. */
let clockAt = T0;

/** Counts its calls and binds nothing. */
class CountingReader implements ReaderMaker {
  calls = 0;
  async read(input: ReaderInput) {
    this.calls++;
    return {
      bears: [],
      rejected: input.items.map((_, k) => k),
      costUsd: 0.0002,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    };
  }
}

async function partnerFor(
  config: Record<string, unknown>,
  users: string[],
  maker?: ReaderMaker,
  prep?: (w: { sources: SlowSearch[] }) => void,
) {
  const worlds = new Map(users.map((u) => [u, world(u)]));
  if (prep) for (const w of worlds.values()) prep(w);
  const cache = new ItemCache();
  const traces: Trace[] = [];
  const partner = new ContextPartner({
    sources: async (scope) => worlds.get(scope.userId)!.sources,
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clockAt,
    onTrace: (t) => traces.push(t),
    ...(maker ? { reader: new AskReader({ maker, budget: new Budget(), now: () => T0 }) } : {}),
    config: {
      ...CORE_CONFIG,
      // The core plus the default's `sync` part, which this trial belongs to (with the core's sync, copies come whole).
      ...SYNC_PART,
      // These tests are about an ask whose cut copies ARE searched; the earn rule (D603) reads none of a new
      // user's copies on the question's words alone (`source-yield-partner.test.ts` has that side).
      sourceYieldEarn: false,
      syncPageSize: 10,
      syncMaxItems: 20,
      syncKeepRules: false,
      syncCallsPerMin: 6_000,
      ...config,
    },
  });
  for (const u of users) {
    const scope = { tenantId: "t1", userId: u };
    partner.sync!.track(scope);
    for (let i = 0; i < 200 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
    for (const s of worlds.get(u)!.sources) expect(partner.sync!.complete(scope, s.id)).toBe(false);
  }
  return { partner, worlds, cache, traces };
}

/** What the session has queued until nothing is left running behind it. */
async function drain(partner: ContextPartner, ref: Scope & { sessionId: string }) {
  const got = [];
  const key = `${ref.tenantId}/${ref.userId}#${ref.sessionId}`;
  for (let n = 0; n < 2_000; n++) {
    got.push(...partner.takePending(ref));
    const s = (partner as unknown as { sessions: Map<string, { inflight: unknown; behind: unknown }> }).sessions.get(
      key,
    );
    if (!s?.inflight && !s?.behind) break;
    await Bun.sleep(5);
  }
  got.push(...partner.takePending(ref));
  return got;
}

/** Long enough that an ask waiting for held searches is caught, short enough to end the test well inside its limit. */
const HOLD_MS = 3_000;

/**
 * One ask. `hold`: its searches stay unanswered until the ask has returned (or `HOLD_MS` passes, which only an ask
 * that waited for them reaches), so `readingAtAnswer` (searches neither answered nor called off by a deadline) says
 * whether it waited, on a loaded machine as on a quiet one.
 */
async function ask(config: Record<string, unknown>, hold = false) {
  const { partner, worlds, traces } = await partnerFor(config, ["u1"]);
  const { sources, fact } = worlds.get("u1")!;
  // An ask-only session (an MCP client): no push has searched anything for it.
  const ref = { tenantId: "t1", userId: "u1", sessionId: "s1" };
  let release = () => {};
  if (hold) searchesHeld = new Promise((r) => (release = r));
  const fallback = setTimeout(() => release(), HOLD_MS);
  const t0 = performance.now();
  const r = await partner.ask({ ...ref, question: QUESTION }).finally(() => {
    clearTimeout(fallback);
    searchesHeld = null;
  });
  const askMs = performance.now() - t0;
  const readingAtAnswer = sources.reduce((n, s) => n + [...s.out].filter((x) => !x?.aborted).length, 0);
  release();
  const late = await drain(partner, ref);
  return {
    r,
    askMs,
    readingAtAnswer,
    cited: r.citations.some((c) => c.itemId === fact.id),
    late,
    lateFact: late.some((x) => x.citations.some((c) => c.itemId === fact.id)),
    searches: sources.reduce((n, s) => n + s.searches, 0),
    traces,
  };
}

describe("askBehind (D430)", () => {
  test("off: the ask waits for its cut copies' live searches (D264) and cites the fact", async () => {
    const off = await ask({ askBehind: false });
    expect(off.askMs).toBeGreaterThanOrEqual(SEARCH_MS * 0.9);
    expect(off.cited).toBe(true);
    expect(off.late).toHaveLength(0);
  });

  test("on, short wait: the ask answers from what is held, says it is still reading, and the fact follows", async () => {
    const on = await ask({ askBehind: true, askBehindWaitMs: 20 }, true);
    // It answered with its searches still being read: it waited for none of them, nor for their deadline.
    expect(on.readingAtAnswer).toBeGreaterThan(0);
    expect(on.askMs).toBeLessThan(HOLD_MS);
    expect(on.cited).toBe(false);
    // Never an all-clear while sources are still being read (D127).
    expect(on.r.answer).toContain("Still reading");
    expect(on.r.answer).toContain("not an all-clear");
    expect(on.r.sources?.some((x) => x.status === "searching")).toBe(true);
    // The search behind found it; the follow-up hands it over at the next take, framed as found after the answer.
    expect(on.lateFact).toBe(true);
    const packet = on.late.find((x) => x.reason.startsWith("ask-behind:"))!;
    expect(packet.text).toContain("found after your last ask_context answer");
    // The follow-up searched nothing again: as many connector searches as the ask with D264 (one per cut copy).
    const off = await ask({ askBehind: false });
    expect(on.searches).toBeLessThanOrEqual(off.searches);
    // The searches behind are traced, so traces still sum to what the connectors received.
    expect(on.traces.some((t) => t.reason === "cut search behind" && t.sourceCalls > 0)).toBe(true);
  }, 30_000);

  test("on, the work done within the wait: the answer is D264's, with no follow-up", async () => {
    const on = await ask({ askBehind: true, askBehindWaitMs: 5_000 });
    expect(on.cited).toBe(true);
    expect(on.r.answer).not.toContain("Still reading");
    expect(on.r.sources?.every((x) => x.status !== "searching")).toBe(true);
    expect(on.late.filter((x) => x.reason.startsWith("ask-behind:"))).toHaveLength(0);
  });

  test("the follow-up is dropped once the user sends another request", async () => {
    const { partner, worlds } = await partnerFor({ askBehind: true, askBehindWaitMs: 20 }, ["u1"]);
    const ref = { tenantId: "t1", userId: "u1", sessionId: "s1" };
    await partner.ask({ ...ref, question: QUESTION });
    await partner.observe({ ...ref, at: T0, kind: "user_message", text: "Thanks, that is all for today" });
    const late = await drain(partner, ref);
    const fact = worlds.get("u1")!.fact;
    expect(late.some((x) => x.reason.startsWith("ask-behind:") && x.citations.some((c) => c.itemId === fact.id))).toBe(
      false,
    );
  });

  test("a follow-up still queued at the user's next request is withdrawn, never handed with it (review of D430)", async () => {
    const { partner, worlds } = await partnerFor({ askBehind: true, askBehindWaitMs: 20 }, ["u1"]);
    const ref = { tenantId: "t1", userId: "u1", sessionId: "s1" };
    await partner.ask({ ...ref, question: QUESTION });
    // The work behind settles and queues the follow-up; the agent takes nothing before the user's next request.
    const key = "t1/u1#s1";
    const live = () =>
      (partner as unknown as { sessions: Map<string, { inflight: unknown; behind: unknown }> }).sessions.get(key);
    for (let n = 0; n < 2_000 && (live()?.inflight || live()?.behind); n++) await Bun.sleep(5);
    const fact = worlds.get("u1")!.fact;
    const queued = (live() as unknown as { pending: Injection[] }).pending;
    expect(queued.some((x) => x.reason.startsWith("ask-behind:"))).toBe(true);
    const r = await partner.observe({ ...ref, at: T0, kind: "user_message", text: "Book a dentist slot on Monday" });
    const handed = [...(r.injection ? [r.injection] : []), ...(await drain(partner, ref))];
    expect(handed.some((x) => x.reason.startsWith("ask-behind:"))).toBe(false);
    // Withdrawn, not spent: the session's ledger holds the fact as fresh again (what the delivery marked is undone).
    const s = live() as unknown as { ledger: { isFresh(id: string, turn: number): boolean }; turn: number };
    expect(s.ledger.isFresh(fact.id, s.turn)).toBe(true);
  });

  test("the follow-up makes no model call: a wired reader is called by the answer only (review of D430)", async () => {
    const maker = new CountingReader();
    const config = { askBehind: true, askBehindWaitMs: 20, askReader: true, pushCandidates: 0, readerGate: false };
    const { partner, worlds, traces } = await partnerFor(config, ["u1"], maker);
    const ref = { tenantId: "t1", userId: "u1", sessionId: "s1" };
    await partner.ask({ ...ref, question: "Pay Zed Quinn the Globex renewal payment today" });
    const atAnswer = maker.calls;
    const late = await drain(partner, ref);
    // The follow-up ran (the fact came in it) and read nothing: every reader call is the answer's, and traced.
    expect(late.some((x) => x.citations.some((c) => c.itemId === worlds.get("u1")!.fact.id))).toBe(true);
    expect(maker.calls).toBe(atAnswer);
    expect(traces.find((t) => t.reason === "ask behind")?.modelCalls).toBe(0);
  });

  test("the follow-up never hands over an item the answer left out as not re-checked (D211)", async () => {
    const { partner, worlds } = await partnerFor({ askBehind: true, askBehindWaitMs: 20 }, ["u1"], undefined, (w) => {
      w.sources[1]!.notifies = true;
    });
    const scope = { tenantId: "t1", userId: "u1" };
    const ref = { ...scope, sessionId: "s1" };
    // A held item of a cut copy that matches the question; its source signals a change and then fails every re-read.
    const src = worlds.get("u1")!.sources[1]!;
    const held = src.items[0]!;
    held.title = "Globex renewal note";
    held.text = "Zed Quinn asked about the Globex renewal payment schedule";
    await partner.sourceItems(scope, src.id, [held]);
    expect(partner.sourceChanged(scope, src.id)).toBe(true);
    src.down = true;
    const r = await partner.ask({ ...ref, question: QUESTION });
    expect(r.citations.some((c) => c.itemId === held.id)).toBe(false);
    expect(r.answer).toContain("could not be re-checked");
    const late = await drain(partner, ref);
    expect(late.some((x) => x.citations.some((c) => c.itemId === held.id))).toBe(false);
  });

  test("a cut copy no search was sent for is 'timeout' at once, never 'searching' (review of D430)", async () => {
    // A deadline under `MIN_SEARCH_MS` (D148): no live search goes out; slow listings keep the poll running.
    const { partner } = await partnerFor(
      { askBehind: true, askBehindWaitMs: 0, sourceTimeoutMs: 40 },
      ["u1"],
      undefined,
      (w) => {
        for (const x of w.sources) {
          const list = x.list.bind(x);
          x.list = async (...a: Parameters<SlowSearch["list"]>) => (
            await Bun.sleep(partnerReady ? 100 : 0),
            list(...a)
          );
        }
      },
    );
    // Past the staleness bound every copy is polled, and the slow listings keep that poll running at the answer.
    partnerReady = true;
    clockAt = T0 + DEFAULT_CONFIG.syncMaxStaleMs + HOUR;
    const r = await partner.ask({ tenantId: "t1", userId: "u1", sessionId: "s1", question: QUESTION }).finally(() => {
      partnerReady = false;
      clockAt = T0;
    });
    expect(r.sources?.length).toBeGreaterThan(0);
    expect(r.sources?.every((x) => x.status === "timeout")).toBe(true);
    expect(r.answer).not.toContain("Still reading");
    expect(r.answer).toContain("not an all-clear");
  });

  test("isolation: one user's follow-up never reaches another user's session", async () => {
    const { partner, worlds } = await partnerFor({ askBehind: true, askBehindWaitMs: 20 }, ["u1", "u2"]);
    const a = { tenantId: "t1", userId: "u1", sessionId: "s1" };
    const b = { tenantId: "t1", userId: "u2", sessionId: "s1" };
    await Promise.all([partner.ask({ ...a, question: QUESTION }), partner.ask({ ...b, question: QUESTION })]);
    const [lateA, lateB] = await Promise.all([drain(partner, a), drain(partner, b)]);
    const idsA = lateA.flatMap((x) => x.citations.map((c) => c.itemId));
    const idsB = lateB.flatMap((x) => x.citations.map((c) => c.itemId));
    expect(idsA).toContain(worlds.get("u1")!.fact.id);
    expect(idsB).toContain(worlds.get("u2")!.fact.id);
    expect(idsA).not.toContain(worlds.get("u2")!.fact.id);
    expect(idsB).not.toContain(worlds.get("u1")!.fact.id);
  });
});
