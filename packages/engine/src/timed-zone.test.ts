/**
 * The day an event is on is the user's day (candidate `timed-utc-start-day`). A connector can write an event's start
 * in UTC ("…Z") while the user's other events carry their own offset: 23:30Z on Friday 6 November is 00:30 on
 * Saturday 7 November for a user at +01:00, so an ask about the 7th must find it and one about the 6th must not. A
 * start that carries a non-zero offset is on its own day, whatever the user's offset.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { startDay } from "./grounding";
import { CORE_CONFIG, PARTS } from "./parts";
import { ContextPartner } from "./partner";

// Thursday 5 November 2026, 10:00 UTC (11:00 at +01:00).
const NOW = Date.parse("2026-11-05T10:00:00Z");

/** The default's grounds part on the core: each of its switches as `DEFAULT_CONFIG` has it (on). */
const GROUNDS = Object.fromEntries(Object.keys(PARTS.grounds).map((k) => [k, true]));

type Doc = { ref: string; title: string; text: string; meta: { start: string } };
const ev = (ref: string, title: string, start: string): Doc => ({ ref, title, text: `${title}.`, meta: { start } });

/** A user at +01:00: most of their calendar carries it. */
const LOCAL = [
  ev("a", "Dentist check-up", "2026-11-05T15:00:00+01:00"),
  ev("b", "Team planning", "2026-11-06T09:30:00+01:00"),
  ev("c", "Lunch with Priya", "2026-11-06T12:30:00+01:00"),
  ev("d", "Climbing session", "2026-11-07T10:00:00+01:00"),
  ev("e", "Book club", "2026-11-09T19:00:00+01:00"),
];

async function cited(docs: Doc[], question: string, userId = "u1"): Promise<string[]> {
  const cache = new ItemCache();
  const scope = { tenantId: "t", userId };
  const p = new ContextPartner({
    sources: async () => [new StaticSource("cal", "Calendar", docs)],
    sourceMap: new SourceMap(),
    cache,
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...CORE_CONFIG, ...GROUNDS },
  });
  // The calendar is already synced: the user's offset comes from what the cache holds.
  cache.put(
    scope,
    docs.map((d) => ({ ...d, id: `cal:${d.ref}`, sourceId: "cal" })),
    NOW,
  );
  const r = await p.ask({ ...scope, sessionId: "s", question });
  return r.citations.map((c) => c.itemId).sort();
}

describe("an event's day is the user's day (timed-utc-start-day)", () => {
  test("a start in UTC is on the user's local day: 23:30Z on the 6th is the 7th at +01:00", async () => {
    const docs = [...LOCAL, ev("z", "Late call with Sydney office", "2026-11-06T23:30:00Z")];
    const on7 = await cited(docs, "What is on my calendar on 7 November?");
    expect(on7).toContain("cal:z");
    expect(on7).toContain("cal:d");
    const on6 = await cited(docs, "What is on my calendar on 6 November?");
    expect(on6).not.toContain("cal:z");
    expect(on6).toContain("cal:b");
  });

  test("a start carrying a non-zero offset keeps its own day, even when it is not the user's offset", async () => {
    // 23:30 at -05:00 on the 6th is 05:30 on the 7th at +01:00, but the event says the 6th: it stays there.
    const docs = [...LOCAL, ev("w", "Call with New York", "2026-11-06T23:30:00-05:00")];
    const on6 = await cited(docs, "What is on my calendar on 6 November?");
    expect(on6).toContain("cal:w");
    const on7 = await cited(docs, "What is on my calendar on 7 November?");
    expect(on7).not.toContain("cal:w");
  });

  test("a user whose events are all in UTC reads UTC days, as before", async () => {
    const docs = [ev("x", "Standup", "2026-11-06T09:00:00Z"), ev("y", "Late deploy", "2026-11-06T23:30:00Z")];
    expect(await cited(docs, "What is on my calendar on 6 November?")).toEqual(["cal:x", "cal:y"]);
    expect(await cited(docs, "What is on my calendar on 7 November?")).toEqual([]);
  });

  test("isolation: one user's offset never moves another user's days", async () => {
    // u2 has only UTC events; u1's +01:00 calendar lives in another cache entry and cannot shift u2's late event.
    const cache = new ItemCache();
    const put = (userId: string, docs: Doc[]) =>
      cache.put(
        { tenantId: "t", userId },
        docs.map((d) => ({ ...d, id: `cal:${d.ref}`, sourceId: "cal" })),
        NOW,
      );
    put("u1", LOCAL);
    put("u2", [ev("y", "Late deploy", "2026-11-06T23:30:00Z")]);
    const days = (userId: string, day: string) =>
      cache.timed({ tenantId: "t", userId }, new Set([day]), NOW).map((h) => h.item.id);
    expect(days("u2", "2026-11-06")).toEqual(["cal:y"]);
    expect(days("u2", "2026-11-07")).toEqual([]);
    // The same UTC event in u1's cache is on u1's day, the 7th.
    put("u1", [...LOCAL, ev("y", "Late deploy", "2026-11-06T23:30:00Z")]);
    expect(days("u1", "2026-11-07")).toEqual(["cal:y", "cal:d"]);
  });

  test("timed reads days at the offset it is given (the request's), not one the cache settles on later", () => {
    const cache = new ItemCache();
    const scope = { tenantId: "t", userId: "u1" };
    const docs = [...LOCAL, ev("z", "Late call", "2026-11-06T23:30:00Z")];
    cache.put(
      scope,
      docs.map((d) => ({ ...d, id: `cal:${d.ref}`, sourceId: "cal" })),
      NOW,
    );
    const on = (day: string, offset?: number) =>
      cache.timed(scope, new Set([day]), NOW, 30, offset).map((h) => h.item.id);
    expect(on("2026-11-07")).toEqual(["cal:z", "cal:d"]); // The cache's own reading: +01:00.
    expect(on("2026-11-07", 0)).toEqual(["cal:d"]); // A request resolved at UTC reads the UTC day.
    expect(on("2026-11-06", 0)).toEqual(["cal:b", "cal:c", "cal:z"]);
  });

  test("startDay: a start's own day; with the user's offset, a UTC start moves and an offset start does not", () => {
    const item = (start: string): ContextItem => ({
      id: "i",
      sourceId: "c",
      ref: "i",
      title: "x",
      text: "x",
      meta: { start },
    });
    expect(startDay(item("2026-11-06T23:30:00Z"))).toBe("2026-11-06");
    expect(startDay(item("2026-11-06T23:30:00Z"), 60)).toBe("2026-11-07");
    expect(startDay(item("2026-11-06T23:30:00z"), 60)).toBe("2026-11-07");
    expect(startDay(item("2026-11-06T23:30:00+00:00"), 60)).toBe("2026-11-07");
    expect(startDay(item("2026-11-06T00:30:00Z"), -480)).toBe("2026-11-05");
    expect(startDay(item("2026-11-06T23:30:00-05:00"), 60)).toBe("2026-11-06");
    expect(startDay(item("2026-11-06T23:30:00+01:00"), 0)).toBe("2026-11-06");
    expect(startDay(item("2026-11-06T23:30:00Z"), 0)).toBe("2026-11-06");
    // A bare date is a day, not an instant; a zone-less date-time is wall-clock, left as written.
    expect(startDay(item("2026-11-06"), 60)).toBe("2026-11-06");
    expect(startDay(item("2026-11-06T23:30:00"), 60)).toBe("2026-11-06");
    expect(startDay(item("not a date"), 60)).toBeNull();
  });
});
