import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

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

function setup(source: Source, config: Record<string, unknown> = {}) {
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
  });
  return { partner, cache, traces, advance: (ms: number) => (clock += ms), now: () => clock };
}

const scope: Scope = { tenantId: "t", userId: "u" };
const say = async (p: ContextPartner, text: string, sessionId: string, at: number) => {
  const r = await p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return [r.injection, ...p.takePending({ ...scope, sessionId })].filter((x) => x !== null);
};
const VERIFY = { verifyDelivery: true, verifyAfterMs: 10 * MIN, packetAge: true };

describe("verifyDelivery: an old copy is re-read before it is delivered", () => {
  const seed = (src: Mutable) =>
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite is in Lisbon on 12 November." });

  test("changed at the source since it was cached, and the search is down: the re-read brings the current copy", async () => {
    const src = new Mutable("notes");
    seed(src);
    const { partner, cache, advance, now } = setup(src, VERIFY);
    await say(partner, "Where is the quarterly offsite?", "s1", now()); // caches the copy
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." });
    src.failSearch = true; // Only the cached copy can answer: without a re-read it would say Lisbon.
    advance(30 * MIN);
    const got = await say(partner, "Remind me where the quarterly offsite is", "s2", now());
    const text = got.map((i) => i.text).join("\n");
    expect(text).toContain("Porto");
    expect(text).not.toContain("Lisbon");
    expect(src.fetches).toBeGreaterThanOrEqual(1);
    expect(cache.get(scope, itemId("notes", "q1"), now())?.text).toContain("Porto");
  });

  test("deleted at the source: not delivered, and dropped from the cache", async () => {
    const src = new Mutable("notes");
    seed(src);
    const { partner, cache, advance, now, traces } = setup(src, VERIFY);
    await say(partner, "Where is the quarterly offsite?", "s1", now());
    src.docs.delete("q1");
    advance(30 * MIN);
    const searches = src.searches;
    const got = await say(partner, "Remind me where the quarterly offsite is", "s2", now());
    // The live search no longer finds it; what the cache held is re-read, found gone and left out.
    expect(got.flatMap((i) => i.citations.map((c) => c.itemId))).not.toContain(itemId("notes", "q1"));
    expect(cache.get(scope, itemId("notes", "q1"), now())).toBeFalsy();
    expect(src.searches).toBeGreaterThan(searches);
    // Every re-read is traced as a connector call.
    const verifyCalls = traces.filter((t) => t.decision === "verify").reduce((n, t) => n + t.sourceCalls, 0);
    expect(verifyCalls).toBe(src.fetches);
  });

  test("a fresh copy is delivered with no re-read; off (the default) never re-reads", async () => {
    const src = new Mutable("notes");
    seed(src);
    const { partner, advance, now } = setup(src, VERIFY);
    await say(partner, "Where is the quarterly offsite?", "s1", now());
    advance(2 * MIN);
    await say(partner, "Remind me where the quarterly offsite is", "s2", now());
    expect(src.fetches).toBe(0);

    const off = new Mutable("notes");
    seed(off);
    const o = setup(off);
    await say(o.partner, "Where is the quarterly offsite?", "s1", o.now());
    o.advance(30 * MIN);
    await say(o.partner, "Remind me where the quarterly offsite is", "s2", o.now());
    expect(off.fetches).toBe(0);
  });

  test("a re-read that fails, or a source whose null proves nothing: delivered as held, labelled with its age", async () => {
    for (const src of [new Mutable("notes"), new Mutable("notes", false)]) {
      seed(src);
      const { partner, advance, now } = setup(src, VERIFY);
      await say(partner, "Where is the quarterly offsite?", "s1", now());
      src.failSearch = true; // The cached copy answers.
      if (src.fetchReportsGone) src.failFetch = true;
      else src.docs.delete("q1"); // A null from a source that does not say null means gone.
      advance(3 * 60 * MIN);
      // The ask path: what it cites is checked too.
      const r = await partner.ask({ ...scope, sessionId: "s2", question: "Where is the quarterly offsite?" });
      expect(r.citations.map((c) => c.itemId)).toContain(itemId("notes", "q1"));
      expect(r.answer).toMatch(/\[notes · as of 3 h ago\]/);
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

describe("verifyDelivery and syncPush: a notifying source's copy needs no re-read", () => {
  class Listed extends Mutable {
    readonly notifies = true;
    async list(_s: Scope, cursor: string | undefined, limit: number) {
      const all = [...this.docs.keys()].map((r) => this.item(r)!);
      const at = cursor ? Number(cursor) : 0;
      return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
    }
  }
  test("current by its notifications: delivered with no fetch and no age label", async () => {
    const src = new Listed("notes");
    src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite is in Lisbon on 12 November." });
    const { partner, advance, now } = setup(src, { ...VERIFY, sync: true, syncPush: true, syncPageSize: 100 });
    partner.sync!.track(scope, now());
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    advance(3 * 60 * MIN);
    src.failSearch = true;
    const quiet = await say(partner, "Where is the quarterly offsite?", "s1", now());
    expect(quiet.flatMap((i) => i.citations.map((c) => c.itemId))).toContain(itemId("notes", "q1"));
    expect(quiet.map((i) => i.text).join("\n")).not.toContain("as of");
    expect(src.fetches).toBe(0);
  });
});
