import { describe, expect, test } from "bun:test";
import { datedText } from "./days";
import { RANGE_MAX_DAYS, timeWindow } from "./grounding";

// D1773: a range a request writes is every day in it, not its last day (or its two ends).
// Thursday 29 October 2026, noon UTC.
const NOW = Date.parse("2026-10-29T12:00:00Z");
const days = (text: string) => [...(timeWindow(text, NOW)?.days ?? [])].sort();
/** `n` days from `start` (YYYY-MM-DD), as `days` lists them. */
const span = (start: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
  );

describe("timeWindow reads a range whole (D1773)", () => {
  test("one month, a dash, an en dash, an em dash, spaced or not", () => {
    expect(days("Book me a hotel in Edinburgh for 12–14 November.")).toEqual(span("2026-11-12", 3));
    expect(days("a hotel for 12-14 November")).toEqual(span("2026-11-12", 3));
    expect(days("a hotel for 12 — 14 November")).toEqual(span("2026-11-12", 3));
    expect(days("a hotel for 12th–14th Nov")).toEqual(span("2026-11-12", 3));
    expect(days("Book Biscuit into the kennels for 19–23 November while we're away")).toEqual(span("2026-11-19", 5));
  });

  test("'to', 'through', 'until', 'till' and 'from X until Y'", () => {
    expect(days("a hire car for Monday 30 November to Friday 4 December")).toEqual(span("2026-11-30", 5));
    expect(days("the course runs 2 November through 6 November")).toEqual(span("2026-11-02", 5));
    expect(days("from 2 November until 9 November")).toEqual(span("2026-11-02", 8));
    expect(days("from Mon 2 Nov till Wed 4 Nov")).toEqual(span("2026-11-02", 3));
    expect(days("cover 9 to 11 November please")).toEqual(span("2026-11-09", 3));
    expect(days("leave between 3 and 5 December")).toEqual(span("2026-12-03", 3));
  });

  test("month first, and across months and years", () => {
    expect(days("in Lisbon November 12–14")).toEqual(span("2026-11-12", 3));
    expect(days("Nov 30 to Dec 2")).toEqual(span("2026-11-30", 3));
    expect(days("off 28 December to 3 January")).toEqual(span("2026-12-28", 7));
    expect(days("off 30 December 2026 – 2 January 2027")).toEqual(span("2026-12-30", 4));
    expect(days("the 21–23 December holiday club")).toEqual(span("2026-12-21", 3));
    expect(days("12–14 November 2027")).toEqual(span("2027-11-12", 3));
    // The end is not read again on its own in the nearest year.
    expect(days("12 November 2027 to 14 November")).toEqual(span("2027-11-12", 3));
    expect(days("from 30 Dec to 2 Jan")).toEqual(span("2026-12-30", 4));
  });

  test("inside other text, beside other days", () => {
    expect(days("Before we fly, on 2 November, book the hotel for 12–14 November; thanks")).toEqual([
      "2026-11-02",
      ...span("2026-11-12", 3),
    ]);
    expect(days("Put Zoë on primary on-call for next week, 2–8 Nov.")).toEqual(span("2026-11-02", 7));
  });

  test("a range longer than the cap reads as its two ends, as before", () => {
    expect(RANGE_MAX_DAYS).toBe(14);
    expect(days("approve leave 1–31 December")).toEqual(["2026-12-01", "2026-12-31"]);
    expect(days("from 1 November until 30 November")).toEqual(["2026-11-01", "2026-11-30"]);
    expect(days("14-27 November")).toEqual(span("2026-11-14", 14));
  });

  test("not ranges: scores, times, ids, versions and backwards spans stay what they were", () => {
    expect(days("we won 3-1 on 12 November")).toEqual(["2026-11-12"]);
    expect(days("the 10-11am slot on 12 November")).toEqual(["2026-11-12"]);
    expect(days("call 10:00-11:00 on 12 November")).toEqual(["2026-11-12"]);
    expect(days("ticket INV-12-14 November batch")).toEqual(["2026-11-14"]);
    expect(days("release v2-14 November")).toEqual(["2026-11-14"]);
    expect(days("pages 2-3 may be late")).toEqual([]);
    expect(days("14–12 November")).toEqual(["2026-11-12"]);
    expect(days("31 November to 2 December")).toEqual(["2026-12-02"]);
    // "May" and "March" are verbs too: a range in them needs a preposition before it, as a single date does.
    expect(days("3–5 May")).toEqual([]);
    expect(days("for 3–5 May")).toEqual(span("2026-05-03", 3));
  });

  test("datedText leaves a range for timeWindow to read", () => {
    const read = (text: string) => [...(timeWindow(datedText(text, NOW), NOW)?.days ?? [])].sort();
    expect(read("Book me a hotel in Edinburgh for 12–14 November.")).toEqual(span("2026-11-12", 3));
    expect(read("Book Maya into the holiday club for 21–23 December, £38 a day.")).toEqual(span("2026-12-21", 3));
  });
});
