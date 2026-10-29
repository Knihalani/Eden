import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { namesParticipant, startDay, timeWindow, titleNames, userOffset } from "./grounding";

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
    const event = item("Robin / Dana", { people: "dana@danalee.example", start: "2026-11-05T16:00:00Z" });
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
    expect(titleNames(["Priya Raman"], item("Priya Raman talk"))).toBe("whole");
    expect(titleNames(["Globex Ventures"], item("Globex <> Robin"))).toBe("word");
    expect(titleNames(["Initech Capital"], item("Globex <> Robin"))).toBeNull();
    // Common title words name no event: "Weekly Report" is not "Weekly mentoring".
    expect(titleNames(["Weekly Report"], item("Weekly mentoring"))).toBeNull();
    expect(titleNames(["The Team"], item("Team all hands"))).toBeNull();
  });
});

describe("review negatives (D44)", () => {
  test("names never match inside an address or its domain", () => {
    const with_ = (people: string) => item("x", { people });
    expect(namesParticipant("Mark Hall", with_("marketing@townhall.example"))).toBe(false);
    expect(namesParticipant("Ann Lee", with_("Annabel Leeds <hello@annleeds.example>"))).toBe(false);
    expect(namesParticipant("Sam Ross", with_("samantha@rossi.example"))).toBe(false);
    for (const address of ["dana.lee@globex.example", "dlee@globex.example", "danalee@globex.example"]) {
      expect(namesParticipant("Dana Lee", with_(address))).toBe(true);
    }
  });

  test("past references are the last such day; 'next' that names no event, and 'may' as a verb, are no time", () => {
    expect(days("I met them last Friday")).toEqual(["2026-10-23"]);
    expect(days("what happened on Monday?")).toEqual(["2026-10-26"]);
    expect(days("lunch on Monday")).toEqual(["2026-11-02"]);
    expect(timeWindow("what are the next steps?", NOW)).toBeNull();
    expect(timeWindow("see you next time", NOW)).toBeNull();
    expect(timeWindow("the cafe next to the station", NOW)).toBeNull();
    expect(timeWindow("the 2 may be late", NOW)).toBeNull();
    expect(days("on 2 May")).toEqual(["2026-05-02"]); // 180 days ago: within half a year, so this year's
    expect(days("on 2 March")).toEqual(["2027-03-02"]); // over half a year gone: next year's
  });

  test("'next' asks for an event only when one follows it; past verbs move only the weekday they govern", () => {
    for (const text of [
      "your next payment is due",
      "what's next for our product",
      "who's next in the queue",
      "what's next quarter's plan",
      "next round of funding",
    ]) {
      expect(timeWindow(text, NOW)).toBeNull();
    }
    expect(timeWindow("my upcoming meetings", NOW)?.next).toBe(true);
    expect(timeWindow("what's next on my calendar?", NOW)?.next).toBe(true);
    expect(days("Was the meeting moved to Friday?")).toEqual(["2026-10-30"]);
    expect(days("Has Dana sent the slides for Friday?")).toEqual(["2026-10-30"]);
    expect(days("Did Dana confirm Friday's dinner?")).toEqual(["2026-10-30"]);
    expect(days("I met them Friday")).toEqual(["2026-10-23"]);
  });

  test("impossible days, explicit years, short months after a number, next weekend", () => {
    expect(timeWindow("the 31st of February", NOW)).toBeNull();
    expect(days("12 November 2025")).toEqual(["2025-11-12"]);
    expect(timeWindow("I had 2 dec ideas", NOW)).toBeNull();
    expect(days("on 2 Dec")).toEqual(["2026-12-02"]);
    expect(days("next weekend")).toEqual(["2026-11-07", "2026-11-08"]);
  });

  test("days are the user's days: a UTC-7 evening is still that day, not tomorrow", () => {
    const evening = Date.parse("2026-10-30T03:00:00Z"); // Thursday 20:00 at UTC-7
    expect([...timeWindow("what's on tonight?", evening, -420)!.days]).toEqual(["2026-10-29"]);
    expect([...timeWindow("what's on tonight?", evening, 0)!.days]).toEqual(["2026-10-30"]);
    expect(userOffset(["2026-11-01T09:00:00-07:00", "2026-11-02T09:00:00-07:00", "2026-11-03T09:00:00Z"])).toBe(-420);
    expect(userOffset([])).toBe(0);
  });
});
