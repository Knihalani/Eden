import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache, sanitizedId, sanitizeItem } from "./cache";
import { ContextPartner, type PartnerDeps, type ReaderReport } from "./partner";
import { CORE_CONFIG } from "./parts";
import { AskReader, type ReaderMaker } from "./reader";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);

/** A connector whose items can change or vanish between calls; counts searches and fetches. */
class Mutable implements Source {
  readonly kind = "test";
  readonly description = "notes";
  searches = 0;
  fetches = 0;
  failFetch = false;
  failSearch = false;
  /** Search and listing answer with nothing, as an index that has not caught up would (no failure, no breaker). */
  blind = false;
  docs = new Map<string, { title: string; text: string }>();
  constructor(
    readonly id: string,
    readonly fetchReportsGone = true,
  ) {}
  item(ref: string): ContextItem | null {
    const d = this.docs.get(ref);
    return d ? { id: itemId(this.id, ref), sourceId: this.id, ref, title: d.title, text: d.text } : null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    if (this.failSearch) throw new Error("503 Service Unavailable");
    if (this.blind) return [];
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.docs.keys()]
      .map((r) => this.item(r)!)
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    if (this.failFetch) throw new Error("500 Internal Server Error");
    return this.item(ref);
  }
}

function setup(source: Source, config: Record<string, unknown> = {}, deps: Partial<PartnerDeps> = {}) {
  let clock = T0;
  const cache = new ItemCache();
  const traces: { decision: string; sourceCalls: number }[] = [];
  const partner = new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { ...CORE_CONFIG, confidentScore: 0.1, minMatchedTerms: 1, ...config },
    onTrace: (t) => traces.push(t),
    ...deps,
  });
  return { partner, cache, traces, advance: (ms: number) => (clock += ms), now: () => clock };
}

const scope: Scope = { tenantId: "t", userId: "u" };
const say = async (p: ContextPartner, text: string, sessionId: string, at: number) => {
  const r = await p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return [r.injection, ...p.takePending({ ...scope, sessionId })].filter((x) => x !== null);
};
/** A source that lists and notifies (`syncPush`): a signal says only that something changed. */
class Listed extends Mutable {
  readonly notifies = true;
  async list(_s: Scope, cursor: string | undefined, limit: number) {
    if (this.failSearch) throw new Error("503 Service Unavailable");
    if (this.blind) return { items: [], next: null };
    const all = [...this.docs.keys()].map((r) => this.item(r)!);
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const PUSH = { sync: true, syncPush: true, syncPageSize: 100, verifyDelivery: true };

/** A partner whose sync has read every item of `src` once. */
async function synced(src: Listed, config: Record<string, unknown> = {}, deps: Partial<PartnerDeps> = {}) {
  const t = setup(src, { ...PUSH, ...config }, deps);
  t.partner.sync!.track(scope, t.now());
  while (!t.partner.sync!.warm(scope)) await t.partner.sync!.tick();
  return t;
}

const seed = (src: Mutable) =>
  src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite is in Lisbon on 12 November." });

describe("verifyDelivery: a copy read before its source signalled a change is re-read before it is delivered", () => {
  test("changed at the source, and the source is down for search and listing: the re-read brings the current copy", async () => {
    const src = new Listed("notes");
    seed(src);
    const { partner, cache, advance, now } = await synced(src);
    advance(5 * MIN);
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." });
    expect(partner.sourceChanged(scope, "notes")).toBe(true);
    src.failSearch = true; // Only the held copy can answer: without a re-read it would say Lisbon.
    advance(1 * MIN);
    const got = await say(partner, "Remind me where the quarterly offsite is", "s2", now());
    const text = got.map((i) => i.text).join("\n");
    expect(text).toContain("Porto");
    expect(text).not.toContain("Lisbon");
    expect(src.fetches).toBeGreaterThanOrEqual(1);
    expect(cache.get(scope, itemId("notes", "q1"), now())?.text).toContain("Porto");
  });

  test("deleted at the source: not delivered, dropped from the cache, every re-read traced", async () => {
    const src = new Listed("notes");
    seed(src);
    const { partner, cache, advance, now, traces } = await synced(src);
    advance(5 * MIN);
    src.docs.delete("q1");
    partner.sourceChanged(scope, "notes");
    src.failSearch = true;
    advance(1 * MIN);
    const got = await say(partner, "Remind me where the quarterly offsite is", "s2", now());
    expect(got.flatMap((i) => i.citations.map((c) => c.itemId))).not.toContain(itemId("notes", "q1"));
    expect(cache.get(scope, itemId("notes", "q1"), now())).toBeFalsy();
    const verifyCalls = traces.filter((t) => t.decision === "verify").reduce((n, t) => n + t.sourceCalls, 0);
    expect(src.fetches).toBeGreaterThanOrEqual(1);
    expect(verifyCalls).toBe(src.fetches);
  });

  test("no signal: an old copy is delivered with no re-read; the part taken out never re-reads", async () => {
    const quiet = new Listed("notes");
    seed(quiet);
    const q = await synced(quiet);
    q.advance(3 * 60 * MIN); // Age alone is no doubt (D126).
    quiet.failSearch = true;
    const got = await say(q.partner, "Where is the quarterly offsite?", "s1", q.now());
    expect(got.flatMap((i) => i.citations.map((c) => c.itemId))).toContain(itemId("notes", "q1"));
    expect(quiet.fetches).toBe(0);

    const off = new Listed("notes");
    seed(off);
    const o = await synced(off, { verifyDelivery: false });
    o.advance(5 * MIN);
    o.partner.sourceChanged(scope, "notes");
    off.failSearch = true;
    await say(o.partner, "Where is the quarterly offsite?", "s1", o.now());
    expect(off.fetches).toBe(0);
  });

  test("a re-read that fails, or a source whose null proves nothing: delivered as held", async () => {
    for (const src of [new Listed("notes"), new Listed("notes", false)]) {
      seed(src);
      const { partner, advance, now } = await synced(src);
      advance(5 * MIN);
      partner.sourceChanged(scope, "notes");
      src.failSearch = true;
      if (src.fetchReportsGone) src.failFetch = true;
      else src.docs.delete("q1"); // A null from a source that does not say null means gone.
      advance(1 * MIN);
      // The ask path: what it cites is checked too.
      const r = await partner.ask({ ...scope, sessionId: "s2", question: "Where is the quarterly offsite?" });
      expect(r.citations.map((c) => c.itemId)).toContain(itemId("notes", "q1"));
      expect(src.fetches).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("sourceRemoved: a deletion notification drops the items at once", () => {
  test("dropped from the cache for that user only; push off does nothing", async () => {
    const src = new Mutable("notes");
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite is in Lisbon on 12 November." });
    const { partner, cache, now } = setup(src, { sync: true, syncPush: true });
    const other = { tenantId: "t", userId: "v" };
    await say(partner, "Where is the quarterly offsite?", "s1", now());
    await partner.observe(
      {
        ...other,
        sessionId: "s9",
        at: now(),
        kind: "user_message",
        text: "Where is the quarterly offsite?",
      } as AgentEvent,
      { waitMs: 2_000 },
    );
    expect(partner.sourceRemoved(scope, "notes", ["q1", "never-held"])).toBe(1);
    expect(cache.get(scope, itemId("notes", "q1"), now())).toBeFalsy();
    expect(cache.get(other, itemId("notes", "q1"), now())).toBeTruthy();
    const off = setup(src, { sync: true, syncPush: false });
    await say(off.partner, "Where is the quarterly offsite?", "s1", off.now());
    expect(off.partner.sourceRemoved(scope, "notes", ["q1"])).toBe(0);
    expect(off.cache.get(scope, itemId("notes", "q1"), off.now())).toBeTruthy();
  });
});

describe("review regressions (D126)", () => {
  test("an item removed by notification is not brought back by a held search page", async () => {
    const src = new Mutable("notes");
    seed(src);
    const { partner, cache, advance, now } = setup(src, { sync: true, syncPush: true });
    await say(partner, "Where is the quarterly offsite?", "s1", now()); // The fan-out now holds the page with q1.
    src.docs.delete("q1");
    expect(partner.sourceRemoved(scope, "notes", ["q1"])).toBe(1);
    advance(5_000); // Inside the fan-out's 60 s fresh window.
    const got = await say(partner, "Where is the quarterly offsite?", "s2", now());
    expect(got.flatMap((i) => i.citations.map((c) => c.itemId))).not.toContain(itemId("notes", "q1"));
    expect(cache.get(scope, itemId("notes", "q1"), now())).toBeFalsy();
  });

  test("a held copy read before the deletion is not stored again; one the source carries again is", () => {
    const c = new ItemCache();
    const q1 = { id: itemId("notes", "q1"), sourceId: "notes", ref: "q1", title: "Offsite", text: "Lisbon" };
    c.put(scope, [q1], T0);
    expect(c.removeItems(scope, [q1.id], T0, 10 * MIN)).toBe(1);
    c.put(scope, [q1], T0 + MIN);
    expect(c.get(scope, q1.id, T0 + MIN)).toBeFalsy();
    c.put(scope, [q1], T0 + 11 * MIN); // The hold has ended.
    expect(c.get(scope, q1.id, T0 + 11 * MIN)).toBeTruthy();
    c.removeItems(scope, [q1.id], T0 + 12 * MIN, 10 * MIN);
    c.revive(scope, [q1.id]);
    c.put(scope, [q1], T0 + 13 * MIN);
    expect(c.get(scope, q1.id, T0 + 13 * MIN)).toBeTruthy();
    // Per user: another user's copy is untouched by the hold.
    const other = { tenantId: "t", userId: "v" };
    c.removeItems(scope, [q1.id], T0 + 14 * MIN, 10 * MIN);
    c.put(other, [q1], T0 + 14 * MIN);
    expect(c.get(other, q1.id, T0 + 14 * MIN)).toBeTruthy();
  });

  test("a deletion notification finds an item whose ref the gate redacted", async () => {
    const ref = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const src = new Mutable("notes");
    src.docs.set(ref, { title: "Quarterly offsite", text: "The quarterly offsite is in Lisbon on 12 November." });
    const { partner, cache, now } = setup(src, { sync: true, syncPush: true });
    await say(partner, "Where is the quarterly offsite?", "s1", now());
    const id = sanitizedId({ id: itemId("notes", ref), sourceId: "notes", ref, title: "", text: "" });
    expect(id).not.toBe(itemId("notes", ref)); // Keyed by the ref's hash.
    expect(cache.get(scope, id, now())).toBeTruthy();
    expect(partner.sourceRemoved(scope, "notes", [ref])).toBe(1);
  });

  test("a second signal after a re-read is read again, not answered from the first", async () => {
    const src = new Listed("notes");
    seed(src);
    const { partner, advance, now } = await synced(src);
    advance(5 * MIN);
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." });
    partner.sourceChanged(scope, "notes");
    src.blind = true;
    advance(MIN);
    const first = await say(partner, "Remind me where the quarterly offsite is", "s2", now());
    expect(first.map((i) => i.text).join("\n")).toContain("Porto");
    const fetches = src.fetches;
    advance(5_000); // Inside the re-read's 30 s reuse.
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Madrid on 26 November." });
    partner.sourceChanged(scope, "notes");
    advance(1_000);
    const r = await partner.ask({ ...scope, sessionId: "s2", question: "Where is the quarterly offsite now?" });
    expect(src.fetches).toBeGreaterThan(fetches);
    expect(r.answer).toContain("Madrid");
  });

  test("a failed re-read is not reused: the next delivery tries again", async () => {
    const src = new Listed("notes");
    seed(src);
    const { partner, advance, now } = await synced(src);
    advance(5 * MIN);
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." });
    partner.sourceChanged(scope, "notes");
    src.blind = true;
    src.failFetch = true;
    advance(MIN);
    await partner.ask({ ...scope, sessionId: "s2", question: "Where is the quarterly offsite?" });
    const fetches = src.fetches;
    expect(fetches).toBeGreaterThanOrEqual(1);
    src.failFetch = false;
    advance(2_000);
    const r = await partner.ask({ ...scope, sessionId: "s2", question: "Where is the quarterly offsite now?" });
    expect(src.fetches).toBeGreaterThan(fetches);
    expect(r.answer).toContain("Porto");
  });
});

describe("D133: a signal that lands while a read is on the wire doubts the copy it stores, and no other", () => {
  /** A listed source whose fetch takes its snapshot, then runs `during` (a change and its signal), then answers. */
  class SlowFetch extends Listed {
    during: (() => void) | null = null;
    override async fetch(ref: string): Promise<ContextItem | null> {
      this.fetches++;
      const snapshot = this.item(ref);
      await Promise.resolve();
      const hook = this.during;
      this.during = null;
      hook?.();
      return snapshot;
    }
  }

  test("the verify fetch returns the copy from before the signal: the next delivery re-reads and has the new text", async () => {
    const src = new SlowFetch("notes");
    seed(src);
    const { partner, cache, advance, now } = await synced(src);
    advance(5 * MIN);
    partner.sourceChanged(scope, "notes"); // A change elsewhere: q1 is only doubted.
    src.failSearch = true;
    src.during = () => {
      advance(1_000);
      src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." });
      partner.sourceChanged(scope, "notes");
    };
    advance(MIN);
    const first = await say(partner, "Remind me where the quarterly offsite is", "s1", now());
    expect(first.map((i) => i.text).join("\n")).toContain("Lisbon"); // What the read returned.
    const fetchesBefore = src.fetches;
    advance(MIN);
    const r = await partner.ask({ ...scope, sessionId: "s2", question: "Where is the quarterly offsite?" });
    expect(src.fetches).toBeGreaterThan(fetchesBefore);
    expect(r.answer).toContain("Porto");
    expect(cache.get(scope, itemId("notes", "q1"), now())?.text).toContain("Porto");
  });

  test("a removal notification that lands while the re-read is on the wire wins: the item is not revived", async () => {
    const src = new SlowFetch("notes");
    seed(src);
    const { partner, cache, advance, now } = await synced(src);
    advance(5 * MIN);
    partner.sourceChanged(scope, "notes"); // q1 is doubted: the delivery re-reads it.
    src.failSearch = true;
    let removed = -1;
    src.during = () => {
      // The fetch has its snapshot (q1 still there); the deletion and its notification land before it answers.
      src.docs.delete("q1");
      removed = partner.sourceRemoved(scope, "notes", ["q1"]);
    };
    advance(MIN);
    const got = await say(partner, "Remind me where the quarterly offsite is", "s1", now());
    expect(removed).toBe(1);
    expect(src.fetches).toBeGreaterThanOrEqual(1);
    const cited = got.flatMap((i) => i.citations.map((c) => c.itemId));
    expect(cited).not.toContain(itemId("notes", "q1"));
    expect(cache.get(scope, itemId("notes", "q1"), now())).toBeFalsy();
    expect(cache.isHeldGone(scope, itemId("notes", "q1"), now())).toBe(true); // The gone-hold stands.
  });

  test("a signal in the same millisecond as a read's start, after it began, doubts the copy; one before does not", async () => {
    const src = new Listed("notes");
    seed(src);
    const { partner, cache, now } = await synced(src);
    const sync = partner.sync!;
    const readMark = sync.mark(); // A read begins ...
    partner.sourceChanged(scope, "notes"); // ... and a signal lands in the same millisecond, before it answers.
    cache.put(scope, [src.item("q1")!], now(), false, true, readMark);
    expect(sync.signalledSince(scope, "notes", cache.readMark(scope, itemId("notes", "q1"))!)).toBe(true);
    // A read that began after that signal, in the same millisecond still: not in doubt.
    cache.put(scope, [src.item("q1")!], now(), false, true, sync.mark());
    expect(sync.signalledSince(scope, "notes", cache.readMark(scope, itemId("notes", "q1"))!)).toBe(false);
    // An unchanged copy from a read begun earlier does not move the mark back.
    cache.put(scope, [src.item("q1")!], now(), false, true, readMark);
    expect(sync.signalledSince(scope, "notes", cache.readMark(scope, itemId("notes", "q1"))!)).toBe(false);
  });

  test("items a notification carried are not re-read at the next delivery", async () => {
    const src = new Listed("notes");
    seed(src);
    const { partner, advance, now } = await synced(src);
    advance(5 * MIN);
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." });
    partner.sourceChanged(scope, "notes"); // The signal and the items it carried, at the same instant.
    await partner.sourceItems(scope, "notes", [src.item("q1")!]);
    src.failSearch = true;
    advance(MIN);
    const before = src.fetches;
    const got = await say(partner, "Remind me where the quarterly offsite is", "s2", now());
    expect(src.fetches).toBe(before);
    expect(got.map((i) => i.text).join("\n")).toContain("Porto");
  });

  test("copies the poll a signal causes stores within the next moments are not re-read", async () => {
    const src = new Listed("notes");
    seed(src);
    const { partner, advance, now } = await synced(src);
    advance(5 * MIN);
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." });
    partner.sourceChanged(scope, "notes");
    advance(200); // A lookup 200 ms after the signal polls the source and stores the new copy.
    await say(partner, "Remind me where the quarterly offsite is", "s1", now());
    const before = src.fetches;
    advance(MIN);
    src.failSearch = true;
    const got = await say(partner, "What about the quarterly offsite plan", "s2", now());
    expect(src.fetches).toBe(before);
    expect(got.map((i) => i.text).join("\n")).not.toContain("Lisbon");
  });
});

describe("review regressions (D126), second round", () => {
  test("a poll whose listing predates a deletion neither stores the item nor counts it as synced", async () => {
    const src = new Listed("notes");
    seed(src);
    src.docs.set("q2", { title: "Lunch", text: "Lunch orders are due by noon." });
    const { partner, cache, advance, now } = await synced(src);
    const before = cache.syncedCount(scope);
    // The notification lands before the source's listing reflects the deletion: the listing still has q1.
    expect(partner.sourceRemoved(scope, "notes", ["q1"])).toBe(1);
    advance(MIN);
    partner.sourceChanged(scope, "notes"); // A poll follows, reading the stale listing.
    await say(partner, "Where is the quarterly offsite?", "s1", now());
    expect(cache.get(scope, itemId("notes", "q1"), now())).toBeFalsy();
    expect(cache.syncedCount(scope)).toBe(before - 1);
    const ids = (
      partner.sync as unknown as { users: Map<string, { sources: Map<string, { ids: Set<string> }> }> }
    ).users
      .get("t/u")
      ?.sources.get("notes")?.ids;
    expect(ids?.has(itemId("notes", "q1"))).toBe(false);
  });
});

describe("checkAhead waits for the reader's gate (D134)", () => {
  test("a gated ask (no reader call) re-reads no doubted pool item it does not deliver", async () => {
    // Two sources: a calendar that never notifies (its copy is never doubted) leads the ask; notes, which signalled a
    // change, has a doubted item that is in the reader's pool but not delivered.
    const notes = new Listed("notes");
    seed(notes);
    const cal = new Mutable("cal");
    cal.docs.set("t1", {
      title: "Train to the quarterly offsite",
      text: "Train to the quarterly offsite in Lisbon: the 08:10 train, seat 42.",
    });
    let calls = 0;
    const reports: ReaderReport[] = [];
    const maker: ReaderMaker = {
      read: async () => {
        calls++;
        return { bears: [], costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
      },
    };
    const clock = T0;
    const partner = new ContextPartner({
      sources: async () => [cal, notes],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      reader: new AskReader({ maker, budget: new Budget(), now: () => clock }),
      onReader: (r) => reports.push(r),
      config: {
        ...CORE_CONFIG,
        ...PUSH,
        confidentScore: 0.1,
        minMatchedTerms: 1,
        askReader: true,
        askReaderWaitMs: 200,
        readerGate: true,
      },
    });
    partner.sync!.track(scope, clock);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    partner.sourceChanged(scope, "notes"); // q1 is doubted from here on.
    notes.blind = true; // The poll and the search bring nothing: only the held (doubted) copy is in the pool.
    const before = notes.fetches;
    const r = await partner.ask({
      ...scope,
      sessionId: "s1",
      question: "Book the train to the quarterly offsite",
      maxItems: 1,
    });
    expect(reports.map((x) => x.outcome)).toEqual(["gated"]);
    expect(reports[0]!.pool).toContain(itemId("notes", "q1"));
    expect(r.citations.map((c) => c.itemId)).toEqual([itemId("cal", "t1")]);
    expect(calls).toBe(0);
    expect(notes.fetches - before).toBe(0);
  });
});

describe("D160: a removal that lands while sourceItems is redacting wins", () => {
  /** A gate pool whose redaction resolves on a later macrotask, as a worker's reply does (`EDEN_GATE_WORKERS` > 0). */
  const slowPool: PartnerDeps["gatePool"] = {
    runOrInline: <T>(_task: string, input: unknown) =>
      new Promise<T>((resolve) => {
        const { item, maxTextChars } = input as { item: ContextItem; maxTextChars: number };
        setTimeout(() => resolve(sanitizeItem(item, maxTextChars) as T), 5);
      }),
  };
  const edit = (src: Listed) =>
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." });
  const arms: [string, Partial<PartnerDeps>][] = [
    ["an async gate pool", { gatePool: slowPool }],
    ["the inline sanitizer", {}],
  ];

  for (const [arm, deps] of arms) {
    test(`an edit pushed, then removed before its redaction resolves (${arm}): not cached, still held gone`, async () => {
      const src = new Listed("notes");
      seed(src);
      const { partner, cache, advance, now } = await synced(src, {}, deps);
      advance(5 * MIN);
      edit(src);
      const p = partner.sourceItems(scope, "notes", [src.item("q1")!]); // Not awaited: a request still in flight.
      src.docs.delete("q1");
      expect(partner.sourceRemoved(scope, "notes", ["q1"])).toBe(1);
      expect(await p).toBe(0);
      expect(cache.get(scope, itemId("notes", "q1"), now())).toBeFalsy();
      expect(cache.isHeldGone(scope, itemId("notes", "q1"), now())).toBe(true);
    });

    test(`an id already held gone, removed again before the push's redaction resolves (${arm}): the removal wins`, async () => {
      // Delete, re-push, delete (an undo then a second delete): the second removal comes after the push (D176).
      const src = new Listed("notes");
      seed(src);
      const { partner, cache, advance, now } = await synced(src, {}, deps);
      advance(5 * MIN);
      expect(partner.sourceRemoved(scope, "notes", ["q1"])).toBe(1);
      advance(MIN);
      edit(src);
      const p = partner.sourceItems(scope, "notes", [src.item("q1")!]); // Not awaited: a request still in flight.
      src.docs.delete("q1");
      partner.sourceRemoved(scope, "notes", ["q1"]);
      expect(await p).toBe(0);
      expect(cache.get(scope, itemId("notes", "q1"), now())).toBeFalsy();
      expect(cache.isHeldGone(scope, itemId("notes", "q1"), now())).toBe(true);
    });
  }

  test("a push that arrives after a completed removal still revives the item: the source sent it again", async () => {
    const src = new Listed("notes");
    seed(src);
    const { partner, cache, advance, now } = await synced(src, {}, { gatePool: slowPool });
    advance(5 * MIN);
    expect(partner.sourceRemoved(scope, "notes", ["q1"])).toBe(1);
    expect(cache.isHeldGone(scope, itemId("notes", "q1"), now())).toBe(true);
    advance(MIN);
    edit(src);
    expect(await partner.sourceItems(scope, "notes", [src.item("q1")!])).toBe(1);
    expect(cache.isHeldGone(scope, itemId("notes", "q1"), now())).toBe(false);
    expect(cache.get(scope, itemId("notes", "q1"), now())?.text).toContain("Porto");
  });
});
