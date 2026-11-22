import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem, Scope } from "@eden/protocol";
import { StaticSource, type ListPage, type SearchQuery, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG, PARTS, withoutParts, type Part } from "./parts";
import type { Trace } from "./trace";

/** Every setting where the default and the core differ, with its value in the default (D112). */
const DEFAULT_PARTS_ON: Partial<EngineConfig> = {
  fallbackAsks: true,
  probes: true,
  compactInjection: true,
  probeGraceMs: 0,
  probeTopicAlone: true,
  probeFresh: true,
  probeYield: true,
  consequenceProbe: true,
  probeRoles: true,
  probeShare: true,
  quietSettled: true,
  groundAway: true,
  groundSubject: true,
  groundConflict: true,
  quietClear: true,
  densePacket: true,
  groundOccasion: true,
  quietNameOnly: true,
  conflictVocab: true,
  sync: true,
  syncPollPageSize: 5,
  // D262–D265 (A1 scale): a user with many sources.
  syncPollWidth: 8,
  syncBackfillLanes: 8,
  syncLocalComplete: true,
  // D751, D753, D755 (O4, O5): a new user's backfill starts with their first event.
  syncKick: true,
  // D405, D406 (B1): the push answers a cut copy from the index and searches it live behind; D430, D431 (C4): the ask.
  pushCutBehind: true,
  pushDaySeats: 3,
  pushConstraintStemSeats: true,
  pushPartyOrgLink: true,
  askBehind: true,
  routeLocalHits: true,
  // D320–D323 (A13 scale): cards, the cap and routing for a user with many sources.
  syncKeepCut: true,
  routeSketch: true,
  syncEngagedDeep: true,
  syncKeepRules: true,
  cardsSourceAware: true,
  cardsOrder: true,
  // D521, D522 (N4): a new user's backfill is read by up to four card calls at once.
  cardsLanes: 4,
  cardsRequestsFix: true,
  // D1193 (F2): the card says whether its constraint still holds; the push's pool leaves out what cleared.
  cardsState: true,
  pushStateFilter: true,
  // D328, D370 (A24): background pages stored one per loop turn; the card drain gathers them.
  syncIngestTurns: true,
  // D356 (A21): sources the user does not use are swept weekly; their unswept copies are re-read before delivery.
  syncUnusedSweepMs: 7 * 24 * 3_600_000,
  syncActivePollMs: 7_200_000,
  syncActivePollBackoff: true,
  syncActivePollCap: 40,
  // D505, D509 (N1): a source whose live reads go unused is not read live again (its own run).
  sourceYield: true,
  // D600, D601, D603 (O1): a source with nothing used is read live only on a name or a rare word; a name many
  // sources mention is weak; a source a request reads nothing live of is not marked used.
  sourceYieldEarn: true,
  sourceYieldNames: 4,
  sourceYieldEngage: true,
  sourceKindPrior: 20,
  syncPollBehind: true,
  syncPush: true,
  verifyDelivery: true,
  revisionNotice: true,
  cards: true,
  cardsEconomy: true,
  compactAsk: true,
  askDedup: true,
  compactParts: true,
  intent: true,
  cardsLean: true,
  intentByKind: true,
  askReader: true,
  askReaderPool: 15,
  askReaderDrop: true,
  readerPush: true,
  askReaderItemChars: 240,
  readerPushBehind: true,
  readerReuse: true,
  readerStopEarly: true,
  readerVerifyAfter: true,
  readerGate: true,
  readerGateVisits: true,
  // D237 (CL6): the push's candidates for the agent to judge, no reader call.
  pushCandidates: 5,
  // D301 (A9): an item stored after an acting request that would have been among its candidates is sent at the take.
  planConflict: true,
  // D317 (A12): a nudge to ask when the candidates do not settle the request.
  askNudge: true,
  // D461 (M5): only when the pool past the handed candidates holds an anchored item.
  askNudgeDeep: true,
  pushCandidatesSettled: 2,
  // D710 (O3): the candidates' push also starts for a request that opens like an instruction on an unlisted verb.
  pushOpen: true,
  pushCheck: true,
  // D1450 (G2): a rule path's packet the request's check turned down is not handed.
  packetHeedsCheck: true,
  pushIndirect: true,
  // D1014 (M13): the turn gate decides the push's start beside `pushStart`, in any language.
  pushGate: true,
  // D1985: a turn that asks starts the push when nothing started it (the benchmark's ask-path gap).
  pushAsk: true,
  // D342 (A17): updates name the times they drop.
  revisionDiff: true,
  // D376 (A25): checkAction holds a party only Eden's packets showed.
  partyCheck: true,
  requestGloss: true,
  // D1180 (F5): the push check reads the user's rule sheet, pool items on it sent as pointers.
  pushCheckSheet: 80,
  pushCheckSheetRefs: true,
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("the unified default and its parts (D112)", () => {
  test("CORE_CONFIG is the default with every part taken out; every part's key is a setting it changes", () => {
    const all = Object.keys(PARTS) as Part[];
    expect(CORE_CONFIG).toEqual(withoutParts(...all));
    for (const part of all) {
      const settings = PARTS[part] as Partial<EngineConfig>;
      expect(Object.keys(settings).length).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(settings)) {
        expect(Object.hasOwn(DEFAULT_CONFIG, key)).toBe(true);
        // A part's setting that equals the default would take nothing out.
        expect(same(value, DEFAULT_CONFIG[key as keyof EngineConfig])).toBe(false);
        expect(typeof value).toBe(typeof DEFAULT_CONFIG[key as keyof EngineConfig]);
      }
      // Taking one part out changes exactly its own settings.
      const without = withoutParts(part);
      for (const key of Object.keys(DEFAULT_CONFIG) as (keyof EngineConfig)[]) {
        const expected = Object.hasOwn(settings, key) ? settings[key] : DEFAULT_CONFIG[key];
        expect(same(without[key], expected)).toBe(true);
      }
    }
  });

  test("the switches on in the default: a change to the default is a change to this list", () => {
    const differ = (Object.keys(DEFAULT_CONFIG) as (keyof EngineConfig)[]).filter(
      (key) => !same(DEFAULT_CONFIG[key], CORE_CONFIG[key]),
    );
    expect(Object.fromEntries(differ.map((key) => [key, DEFAULT_CONFIG[key]]))).toEqual(DEFAULT_PARTS_ON);
    expect(differ.length).toBe(90);
    // Each of them is some part's, and the core has the part's value.
    const partKeys = new Set(Object.values(PARTS).flatMap((settings) => Object.keys(settings)));
    for (const key of differ) expect(partKeys.has(key)).toBe(true);
    expect(partKeys.size).toBe(90);
  });
});

/** A connector with a recent-first list call, so the default's background sync has something to read. */
class ListedSource implements Source {
  readonly kind = "test";
  readonly description = "Deals and accounts";
  lists = 0;
  private readonly inner: StaticSource;
  private readonly items: ContextItem[];
  constructor(readonly id: string) {
    const docs = [
      {
        ref: "deal-9",
        title: "Globex renewal",
        text: "Globex renewal due 2026-11-30, Dana Lee is the champion, wants 12% off",
        updatedAt: Date.UTC(2026, 9, 20),
      },
      {
        ref: "acct-2",
        title: "Initech account",
        text: "Initech pays annually, contact Bill Lumbergh",
        updatedAt: Date.UTC(2026, 9, 19),
      },
    ];
    this.inner = new StaticSource(id, this.description, docs);
    this.items = docs.map((d) => ({ ...d, id: `${id}:${d.ref}`, sourceId: id }));
  }
  search(query: SearchQuery): Promise<ContextItem[]> {
    return this.inner.search(query);
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const at = cursor ? Number(cursor) : 0;
    const page = this.items.slice(at, at + limit);
    return { items: page, next: at + limit < this.items.length ? String(at + limit) : null };
  }
}

describe("the default with no model and no partner dependencies", () => {
  test("observes, checks and asks on the no-model path: nothing throws and no model call is made", async () => {
    const traces: Trace[] = [];
    const crm = new ListedSource("crm");
    const calendar = new StaticSource("calendar", "The user's calendar", [
      { ref: "evt-1", title: "Call with Dana Lee", text: "Thursday 3pm, Globex renewal check-in" },
    ]);
    const budget = new Budget();
    // No model, no cards, no reader, no judge: every part that is a model role is inert (D112).
    const p = new ContextPartner({
      sources: async () => [crm, calendar],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget,
      model: null,
      onTrace: (t) => traces.push(t),
    });
    expect(p.config).toEqual(DEFAULT_CONFIG);
    const scope = { tenantId: "t1", userId: "u1", sessionId: "s1" };
    let at = Date.UTC(2026, 9, 20, 9);
    const ev = (e: Record<string, unknown>) => ({ ...scope, at: at++, ...e }) as AgentEvent;

    const first = await p.observe(ev({ kind: "user_message", text: "Prep me for the Globex renewal with Dana Lee" }), {
      waitMs: 2_000,
    });
    const second = await p.observe(
      ev({ kind: "user_message", text: "Draft a reply to Dana Lee about the Globex renewal discount" }),
      { waitMs: 2_000 },
    );
    const delivered = [first.injection, second.injection, ...p.takePending(scope)].flatMap(
      (i) => i?.citations.map((c) => c.itemId) ?? [],
    );
    expect(delivered).toContain("crm:deal-9");

    const check = await p.checkAction(
      ev({ kind: "tool_call", tool: "gmail.send", input: { body: "Hi Dana, Globex renewal at 20% off" } }),
    );
    expect(check.verdict).toBeDefined();

    const answer = await p.ask({ ...scope, question: "When is the Globex renewal due?" });
    expect(answer.usedModel).toBe(false);
    expect(answer.costUsd).toBe(0);
    expect(answer.citations.map((c) => c.itemId)).toContain("crm:deal-9");

    expect(traces.length).toBeGreaterThan(0);
    for (const t of traces) {
      expect(t.modelCalls).toBe(0);
      expect(t.costUsd).toBe(0);
    }
    p.stopSync();
  });
});

/** A searchable source whose searches wait for `release`, and that counts every call. */
class GatedSource implements Source {
  readonly kind = "test";
  readonly description = "Gated notes";
  calls = 0;
  readonly queries: string[] = [];
  private open!: () => void;
  readonly gate = new Promise<void>((r) => (this.open = r));
  constructor(readonly id: string) {}
  release(): void {
    this.open();
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.calls++;
    this.queries.push(JSON.stringify(q));
    await this.gate;
    return [];
  }
}

// Anticipation (D227) and the slow-path queue (D228) were deleted; what the default does in their place is pinned
// here, so a later change to the draft branch or the busy branch fails a test.
describe("the default after D227 and D228", () => {
  const scope = { tenantId: "t1", userId: "u1", sessionId: "s1" };
  const at = Date.UTC(2026, 9, 20, 9);
  // The push's candidates (D237) run with no reader since D276 and search the request at observe; these tests are
  // about the event's own lookup, so they take the push out.
  const build = (source: Source, traces: Trace[]) =>
    new ContextPartner({
      config: { pushCandidates: 0 },
      sources: async () => [source],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => at,
      onTrace: (t) => traces.push(t),
    });

  test("a draft the user is still typing is ignored: no source call, no trace, no session", async () => {
    const traces: Trace[] = [];
    const notes = new GatedSource("notes");
    notes.release();
    const p = build(notes, traces);
    const draft = { ...scope, at, kind: "user_message", text: "Ask Dana Lee about the Globex renewal", draft: true };
    const r = await p.observe(draft as AgentEvent);
    expect(r.injection).toBeNull();
    expect(notes.calls).toBe(0);
    expect(traces).toEqual([]);
    expect(p.takePending(scope)).toEqual([]);
    p.stopSync();
  });

  test("a request that finds the slow path busy is traced 'slow path busy' and not looked up later", async () => {
    const traces: Trace[] = [];
    const notes = new GatedSource("notes");
    const p = build(notes, traces);
    const ev = (text: string, n: number) => ({ ...scope, at: at + n, kind: "user_message", text }) as AgentEvent;
    await p.observe(ev("Prep me for the Globex renewal with Dana Lee", 0));
    const busy = await p.observe(ev("Book the Lisbon flights for the Acme offsite", 1));
    expect(busy.injection).toBeNull();
    expect(traces.some((t) => t.decision === "silent" && t.reason === "slow path busy")).toBe(true);
    notes.release();
    // Let the first lookup settle: nothing then looks the busy request up.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    expect(traces.some((t) => t.reason?.startsWith("queued cue"))).toBe(false);
    expect(notes.calls).toBeGreaterThan(0);
    expect(notes.queries.filter((q) => /lisbon|acme/i.test(q))).toEqual([]);
    p.stopSync();
  });
});
