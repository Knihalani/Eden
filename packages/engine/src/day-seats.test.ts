import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem, Injection, ObserveResult } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { DEFAULT_CONFIG } from "./config";

/*
 * D1978: the lookup seats the day's items too — `rank` took its day candidates from `timed` (an item's `meta.start`
 * day), which an item whose day lives only in its text ("every weekday 09:30", "Thursday 16:15") never has. With the
 * seats read through `dated` (covers, names, recurrence), an availability ask on a named day hands what the day
 * holds, however the item writes it.
 *
 * Items only reach the ItemCache once a lookup has searched their source, so each test opens with a priming turn
 * that pulls the fixture in, then drops anything it pushed.
 */

/** Wednesday 18 November 2026, 09:00 UTC. */
const NOW = Date.parse("2026-11-18T09:00:00Z");
const HOUR = 3_600_000;

const item = (id: string, title: string, text: string, ageH = 24, start?: string): ContextItem => ({
  id: `cal:${id}`,
  sourceId: "cal",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
  ...(start ? { meta: { start } } : {}),
});

function setup(items: ContextItem[], config: Record<string, unknown> = {}) {
  const source: Source = {
    id: "cal",
    kind: "test",
    description: "Calendar",
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
const ids = (p: ContextPartner, result: ObserveResult, sessionId = "s1") => {
  const all: Injection[] = result.injection
    ? [result.injection, ...p.takePending(ref(sessionId))]
    : p.takePending(ref(sessionId));
  return all.flatMap((x) => x.citations.map((c) => c.itemId));
};

/** A repeating morning standup whose day exists only in its text: no `meta.start`, no named date. */
const STANDUP = item("standup", "Standup", "Team standup, every weekday 9:30-9:45.");
/** An event that starts, for contrast: `timed` already seats this one. */
const REVIEW = item("review", "Design review", "Design review with the team.", 24, "2026-11-19T14:00:00");

describe("day seats (D1978): the lookup seats the items a named day holds", () => {
  test('"is Thursday free?" hands the recurring weekday standup (its day lives only in its text)', async () => {
    const p = setup([STANDUP, REVIEW]);
    // Priming turn pulls the fixture into the cache.
    await say(p, "what meetings do I have?");
    const o = await say(p, "is Thursday morning free?");
    expect(ids(p, o)).toContain("cal:standup");
    expect(ids(p, o)).toContain("cal:review");
  });

  test("an item naming a different day stays out of the free-ask", async () => {
    const WEEKEND = item("market", "Farmers market", "Farmers market, every Saturday 8:00-13:00.");
    const p = setup([STANDUP, WEEKEND]);
    await say(p, "what meetings do I have?");
    // Thursday 2026-11-19 is not a Saturday: only the standup covers it.
    const o = await say(p, "am I free on Thursday?");
    expect(ids(p, o)).toContain("cal:standup");
    expect(ids(p, o)).not.toContain("cal:market");
  });

  test("a day nothing holds stays silent on the free-ask", async () => {
    const p = setup([STANDUP]);
    await say(p, "what meetings do I have?");
    // Sunday 2026-11-22: the weekday standup does not cover it.
    const o = await say(p, "is Sunday free?");
    expect(ids(p, o)).toHaveLength(0);
  });
});

const hear = (p: ContextPartner, text: string, sessionId = "s1") =>
  p.observe({ ...ref(sessionId), at: NOW, kind: "agent_message", text } as AgentEvent, { waitMs: 2_000 });

/** The recurring weekday pickup that named 16:30 in the last turn — not itself the clash. */
const PICKUP = item(
  "pickup",
  "School pick-up: Leo",
  "Weekdays 15:15, St Mary's Primary. Thursday: football club until 16:30.",
);
/** A one-off 1:1 whose day and time live only in a bare weekday and a written clock. */
const ONE_ON_ONE = item("oneonone", "1:1 with manager", "1:1 with manager, Thursday 16:15-17:00.");

describe("clash carry (D1979): a clash at the time just said hands the bare-weekday event it hits", () => {
  test('"a clash at that time?" resolves the span from the last turn and hands the overlapping item', async () => {
    const p = setup([PICKUP, ONE_ON_ONE]);
    // `ids` drains pending injections, so earlier turns' pushes are flushed here.
    ids(p, await say(p, "can I pick Leo up on Thursday?"));
    ids(p, await hear(p, "Football club runs until 16:30 on Thursday."));
    const o = await say(p, "do I have a clash at that time?");
    expect(ids(p, o)).toContain("cal:oneonone");
    // The pickup's own clock (15:15–16:30) ends at the asked time, not inside it.
    expect(ids(p, o)).not.toContain("cal:pickup");
  });

  test("a bare-weekday item whose clock misses the asked time stays silent", async () => {
    const LATE = item("gym", "Gym", "Gym with Sam, Thursday 19:15-20:00.");
    const p = setup([PICKUP, LATE]);
    ids(p, await say(p, "can I pick Leo up on Thursday?"));
    ids(p, await hear(p, "Football club runs until 16:30 on Thursday."));
    const o = await say(p, "do I have a clash at that time?");
    expect(ids(p, o)).toHaveLength(0);
  });

  test("a free-ask still does not list a bare-weekday item (class 3 stays out of the day listing)", async () => {
    const p = setup([ONE_ON_ONE]);
    await say(p, "what meetings do I have?");
    const o = await say(p, "is Thursday morning free?");
    expect(ids(p, o)).toHaveLength(0);
  });
});
