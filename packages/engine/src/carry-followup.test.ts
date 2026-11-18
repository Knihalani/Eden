import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem, Injection, ObserveResult } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { DEFAULT_CONFIG } from "./config";

/*
 * D1973 probes: `carry` widens a question-shaped sparse follow-up with the previous request's topic; `wd` facts make
 * a recurring item cover a day it recurs on (through `ASKS_FREE`'s day listing); `sameRef` keeps near-duplicate
 * suppression honest about identifier numbers; the asks' name check yields for questions only.
 *
 * Items only reach the ItemCache once a lookup has searched their source, so each test opens with a priming turn
 * that pulls the fixture in, then drops anything it pushed.
 */

/** Wednesday 18 November 2026, 09:00 UTC. */
const NOW = Date.parse("2026-11-18T09:00:00Z");
const HOUR = 3_600_000;

const item = (id: string, title: string, text: string, ageH = 24, start?: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
  ...(start ? { meta: { start } } : {}),
});

function setup(items: ContextItem[], config: Record<string, unknown> = {}) {
  const source: Source = {
    id: "mail",
    kind: "test",
    description: "Mail",
    search: async () => items,
  };
  return new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...DEFAULT_CONFIG, ...config },
  });
}

const ref = (sessionId = "s1") => ({ tenantId: "t", userId: "u1", sessionId });
const say = (p: ContextPartner, text: string, sessionId = "s1") =>
  p.observe({ ...ref(sessionId), at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
// A delivery comes back on the observe result's `injection`; work left in flight queues packets on takePending.
const ids = (p: ContextPartner, result: ObserveResult, sessionId = "s1") => {
  const all: Injection[] = result.injection
    ? [result.injection, ...p.takePending(ref(sessionId))]
    : p.takePending(ref(sessionId));
  return all.flatMap((x) => x.citations.map((c) => c.itemId));
};
const drain = (p: ContextPartner) => p.takePending(ref());

const O881 = item("o881", "Order 881: keyboard", "Your order 881 (keyboard) has shipped and arrives Friday.", 2);
const O874 = item("o874", "Order 874: cable", "Your order 874 (cable) has shipped and arrives Thursday.", 2);

describe("carry (D1973): a sparse question follow-up reads the previous request's topic", () => {
  test('"and the cable?" finds order 874 after a request about order 881', async () => {
    const p = setup([O881, O874]);
    var o = await say(p, "did the keyboard order ship?");
    expect(ids(p, o)).toContain("mail:o881");
    // One own term ("cable") plus the carried topic (order/ship…) reaches the other order; without `carry`
    // "and the cable?" shares at most one term with it and stays silent.
    var o2 = await say(p, "and the cable?");
    expect(ids(p, o2)).toContain("mail:o874");
  });

  test("a sparse non-question gets no carry", async () => {
    const p = setup([O881, O874]);
    await say(p, "did the keyboard order ship?");
    p.takePending(ref());
    var o = await say(p, "the cable");
    expect(ids(p, o)).toEqual([]);
  });
});

describe("sameRef (D1973): near-duplicates that disagree on identifiers are not old news", () => {
  test("order 874 still delivers beside the already-shown order 881", async () => {
    const p = setup([O881, O874]);
    var first = await say(p, "did the keyboard order ship?");
    expect(ids(p, first)).toContain("mail:o881");
    // Order 881 is old news (same identifiers), order 874's own number keeps it fresh.
    var o = await say(p, "and the cable order?");
    var got = ids(p, o);
    expect(got).toContain("mail:o874");
    expect(got).not.toContain("mail:o881");
  });
});

describe("ASKS_FREE (D1973): a question about being free on a day lists its timed items", () => {
  const STANDUP = item("standup", "Team standup", "Every weekday 09:00, 15 minutes.", 1, "2026-11-19T09:00:00Z");
  const PIANO = item("piano", "Piano lesson", "Weekly on Thursdays 17:00.", 1, "2026-11-19T17:00:00Z");

  test('"is Thursday free?" hands Thursday\'s timed items', async () => {
    const p = setup([STANDUP, PIANO]);
    await say(p, "what is on this week?"); // prime the cache
    drain(p);
    var o = await say(p, "is Thursday free?");
    var got = ids(p, o);
    expect(got).toContain("mail:piano");
    expect(got).toContain("mail:standup"); // recurring on weekdays: Thursday is one
  });

  // The question gate is what opens the day listing to clash/conflict words (ASKS_FREE); a statement about a
  // clash stays outside it, unlike "my Thursday is free", which the older calendar-listing branch already reads.
  test("a statement mentioning a clash fires nothing", async () => {
    const p = setup([STANDUP, PIANO]);
    await say(p, "what is on this week?");
    drain(p);
    var o = await say(p, "no clash on Thursday");
    expect(ids(p, o)).toEqual([]);
  });
});

describe("asks' name check (D1973): a question's subject item is not refused for lacking a name", () => {
  const REST = item(
    "rest",
    "Restaurants for the anniversary",
    "Shortlist for an anniversary dinner: Caro's, The Quay, Linden House. Caro's does the tasting menu.",
    3,
  );

  test("a question about the subject hands the item although it names nobody", async () => {
    const p = setup([REST]);
    var o = await say(p, "where for the anniversary dinner with Maya?");
    expect(ids(p, o)).toContain("mail:rest");
  });
});
