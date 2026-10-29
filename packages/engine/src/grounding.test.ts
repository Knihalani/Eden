import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { namesParticipant, sharesTitleName, startDay, timeWindow } from "./grounding";

// Thursday 29 October 2026, noon UTC.
const NOW = Date.parse("2026-10-29T12:00:00Z");
const days = (text: string) => [...(timeWindow(text, NOW)?.days ?? [])].sort();
const item = (title: string, meta: Record<string, string> = {}): ContextItem => ({
  id: `x:${title}`,
  sourceId: "x",
  ref: title,
  title,
  text: "",
  meta,
});

describe("timeWindow", () => {
  test("relative days resolve against the event's clock", () => {
    expect(days("what's on today?")).toEqual(["2026-10-29"]);
    expect(days("dinner tomorrow")).toEqual(["2026-10-30"]);
    expect(days("what's on my calendar this Sunday?")).toEqual(["2026-11-01"]);
    expect(days("on Thursday")).toEqual(["2026-10-29"]);
    expect(days("next Thursday")).toEqual(["2026-11-05"]);
    expect(days("book a call next week")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
    expect(days("this weekend")).toEqual(["2026-10-31", "2026-11-01"]);
  });

  test("explicit dates, either order, the nearest year", () => {
    expect(days("our call on 12 November")).toEqual(["2026-11-12"]);
    expect(days("Nov 5th at 4pm")).toEqual(["2026-11-05"]);
    expect(days("back on the 3rd of January")).toEqual(["2027-01-03"]);
  });

  test("'the next X' asks for the earliest upcoming; no time named is null", () => {
    expect(timeWindow("When is the next Priya Raman talk?", NOW)).toEqual({ days: new Set(), next: true });
    expect(timeWindow("next week", NOW)!.next).toBe(false);
    expect(timeWindow("Write a haiku about autumn leaves", NOW)).toBeNull();
    expect(timeWindow("What's 15% of 240?", NOW)).toBeNull();
  });
});

describe("namesParticipant", () => {
  test("a full name matches a participant's display name or email address, not one word of it", () => {
    const event = item("Robin / Dana", { people: "dana@danalee.io", start: "2026-11-05T16:00:00Z" });
    expect(namesParticipant("Dana Lee", event)).toBe(true);
    expect(namesParticipant("Dana", event)).toBe(false); // One name is too common to stand for a person.
    expect(namesParticipant("Dana Smith", event)).toBe(false);
    const mail = item("Re: plans", { people: "Sam Ortiz <sortiz@globex.example>" });
    expect(namesParticipant("Sam Ortiz", mail)).toBe(true);
    expect(namesParticipant("sortiz@globex.example", mail)).toBe(true);
    expect(namesParticipant("Sam Patel", mail)).toBe(false);
  });

  test("an event's title naming the person counts; a message's title does not", () => {
    const event = item("Robin Hale and Priya Raman", { start: "2026-10-26T14:00:00Z" });
    expect(namesParticipant("Priya Raman", event)).toBe(true);
    expect(namesParticipant("Priya Raman", item("Notes on Priya Raman's paper"))).toBe(false);
  });

  test("helpers: start day from the item's own timestamp, and shared title names", () => {
    expect(startDay(item("a", { start: "2026-11-01T17:00:00+01:00" }))).toBe("2026-11-01");
    expect(startDay(item("a"))).toBeNull();
    expect(sharesTitleName(["Globex Ventures"], item("Globex <> Robin"))).toBe(true);
    expect(sharesTitleName(["Initech Capital"], item("Globex <> Robin"))).toBe(false);
  });
});
