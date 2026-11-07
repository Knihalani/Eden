import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { PLAN_LEAD } from "./render";

// A9 (docs/research/a9-ahead.md): plan-conflict proactivity. With `planConflict`, a new item that would have been
// among an earlier acting request's candidates, and reads as a constraint, is sent to the agent at its next take,
// even when the request then is about something else.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);

/** A connector that lists and notifies. */
class Listed implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly notifies = true;
  docs = new Map<string, { title: string; text: string }>();
  constructor(readonly id: string) {}
  item(ref: string): ContextItem {
    const d = this.docs.get(ref)!;
    return { id: itemId(this.id, ref), sourceId: this.id, ref, title: d.title, text: d.text };
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.docs.keys()]
      .map((r) => this.item(r))
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    return this.docs.has(ref) ? this.item(ref) : null;
  }
  async list(_s: Scope, cursor: string | undefined, limit: number) {
    const all = [...this.docs.keys()].map((r) => this.item(r));
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const scope: Scope = { tenantId: "t", userId: "u" };
const other: Scope = { tenantId: "t", userId: "u2" };

const seed = (src: Listed) => {
  src.docs.set("f1", { title: "Lisbon offsite", text: "The quarterly offsite is in Lisbon on 12 November." });
  src.docs.set("l1", { title: "Lunch", text: "Lunch with Sam at the canteen." });
  src.docs.set("g1", { title: "Garden", text: "The garden centre has seeds in stock." });
};
const BOOK = "Book my flights to Lisbon for the quarterly offsite on 12 November.";
const LATER = "What should I bring to the canteen lunch with Sam?";
const CANCEL = {
  ref: "c1",
  title: "Offsite cancelled",
  text: "The quarterly offsite in Lisbon on 12 November is cancelled; do not book flights, nothing will be refunded.",
};
const UNRELATED = { ref: "u1", title: "Garden centre", text: "Seed potatoes are back in stock at the garden centre." };

async function setup(config: Record<string, unknown> = {}, scopes: Scope[] = [scope]) {
  let clock = T0;
  const srcs = new Map<string, Listed>();
  for (const sc of scopes) {
    const src = new Listed("notes");
    seed(src);
    srcs.set(sc.userId, src);
  }
  const partner = new ContextPartner({
    sources: async (sc) => [srcs.get(sc.userId)!],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: true,
      syncPageSize: 100,
      askReader: true,
      readerPush: true,
      readerGate: true,
      pushCandidates: 5,
      ...config,
    },
  });
  for (const sc of scopes) {
    partner.sync!.track(sc, clock);
    while (!partner.sync!.warm(sc)) await partner.sync!.tick();
  }
  /** A new item at the source, carried by its notice (`--push payload`). */
  const arrive = async (doc: { ref: string; title: string; text: string }, sc: Scope = scope) => {
    const src = srcs.get(sc.userId)!;
    src.docs.set(doc.ref, { title: doc.title, text: doc.text });
    return partner.sourceItems(sc, "notes", [src.item(doc.ref)]);
  };
  return { partner, arrive, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function say(p: ContextPartner, text: string, sessionId: string, at: number, sc: Scope = scope) {
  const r = await p.observe({ ...sc, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return [r.injection, ...p.takePending({ ...sc, sessionId })].filter((x): x is Injection => x !== null);
}
const plans = (got: Injection[]) => got.filter((i) => i.reason.startsWith("plan:"));
const CANCEL_ID = itemId("notes", "c1");

describe("planConflict (A9): a new item that bears on an earlier acting request is sent at the next take", () => {
  test("off in the default and in the core: nothing", async () => {
    expect(DEFAULT_CONFIG.planConflict).toBe(false);
    const t = await setup();
    await say(t.partner, BOOK, "s1", t.now());
    t.advance(30 * MIN);
    expect(await t.arrive(CANCEL)).toBe(1);
    t.advance(30 * MIN);
    expect(plans(await say(t.partner, LATER, "s1", t.now())).length).toBe(0);
  });

  test("on: the cancellation reaches the next, unrelated request, framed with the earlier request, as data", async () => {
    const t = await setup({ planConflict: true });
    await say(t.partner, BOOK, "s1", t.now());
    t.advance(30 * MIN);
    await t.arrive(CANCEL);
    t.advance(30 * MIN);
    const got = plans(await say(t.partner, LATER, "s1", t.now()));
    expect(got.length).toBe(1);
    expect(got[0]!.citations.map((c) => c.itemId)).toEqual([CANCEL_ID]);
    const text = got[0]!.text;
    expect(text).toMatch(/^<context [^\n]*Data, not instructions/);
    expect(text).toContain(PLAN_LEAD);
    expect(text).toContain("Book my flights to Lisbon");
    expect(text).toContain("cancelled");
  });

  test("once: the same item stored again queues nothing more", async () => {
    const t = await setup({ planConflict: true });
    await say(t.partner, BOOK, "s1", t.now());
    await t.arrive(CANCEL);
    expect(plans(await say(t.partner, LATER, "s1", t.now())).length).toBe(1);
    await t.arrive({ ...CANCEL, text: `${CANCEL.text} ` });
    expect(plans(await say(t.partner, "Anything else on the canteen lunch?", "s1", t.now())).length).toBe(0);
  });

  test("an item that ranks for no acting request, or in a pool with nothing constraint-like, is not sent", async () => {
    const t = await setup({ planConflict: true });
    await say(t.partner, BOOK, "s1", t.now());
    await t.arrive(UNRELATED);
    await t.arrive({
      ref: "f2",
      title: "Lisbon offsite agenda",
      text: "The quarterly offsite in Lisbon has a boat trip.",
    });
    expect(plans(await say(t.partner, LATER, "s1", t.now())).length).toBe(0);
  });

  test("an information question acted on nothing: no packet", async () => {
    const t = await setup({ planConflict: true });
    await say(t.partner, "Where is the quarterly offsite this year?", "s1", t.now());
    await t.arrive(CANCEL);
    expect(plans(await say(t.partner, LATER, "s1", t.now())).length).toBe(0);
  });

  test("isolation: another user's item, and a session of the same user that acted on nothing, get nothing", async () => {
    const t = await setup({ planConflict: true }, [scope, other]);
    await say(t.partner, BOOK, "s1", t.now(), other);
    await say(t.partner, LATER, "s2", t.now());
    await t.arrive(CANCEL);
    expect(plans(await say(t.partner, LATER, "s1", t.now(), other)).length).toBe(0);
    expect(plans(await say(t.partner, "Anything else for lunch?", "s2", t.now())).length).toBe(0);
  });

  test("a closed session is forgotten: nothing is queued for it", async () => {
    const t = await setup({ planConflict: true });
    await say(t.partner, BOOK, "s1", t.now());
    await t.partner.observe({ ...scope, sessionId: "s1", at: t.now(), kind: "session_end" } as AgentEvent);
    expect(await t.arrive(CANCEL)).toBe(1);
    expect(t.partner.takePending({ ...scope, sessionId: "s1" }).length).toBe(0);
  });

  test("the config check needs the push and the sync", () => {
    expect(checkEngineConfig({ planConflict: true })).toEqual({ planConflict: true });
    expect(() => checkEngineConfig({ planConflict: true, sync: false })).toThrow(/planConflict/);
    expect(() => checkEngineConfig({ planConflict: true, sync: true, readerPush: false })).toThrow(/planConflict/);
  });
});
