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
  slowPathQueue: true,
  probes: true,
  compactInjection: true,
  probeGraceMs: 0,
  probeTopicAlone: true,
  probeFresh: true,
  probeYield: true,
  consequenceProbe: true,
  probeRoles: true,
  probeShare: true,
  graph: true,
  graphMerge: true,
  anticipate: true,
  judgeContested: true,
  judgeTied: true,
  judgeItemBytes: 200,
  quietSettled: true,
  groundAway: true,
  groundConflict: true,
  quietClear: true,
  densePacket: true,
  groundOccasion: true,
  quietNameOnly: true,
  conflictVocab: true,
  sync: true,
  syncPollPageSize: 5,
  syncPollBehind: true,
  syncPush: true,
  verifyDelivery: true,
  revisionNotice: true,
  cards: true,
  cardsEconomy: true,
  askVerdicts: true,
  compactAsk: true,
  askDedup: true,
  compactParts: true,
  intent: true,
  cardsLean: true,
  askReader: true,
  askReaderPool: 15,
  askReaderDrop: true,
  readerPush: true,
  askReaderItemChars: 240,
  readerPushBehind: true,
  readerGate: true,
  readerGateVisits: true,
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
    expect(differ.length).toBe(47);
    // Each of them is some part's, and the core has the part's value.
    const partKeys = new Set(Object.values(PARTS).flatMap((settings) => Object.keys(settings)));
    for (const key of differ) expect(partKeys.has(key)).toBe(true);
    expect(partKeys.size).toBe(47);
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
