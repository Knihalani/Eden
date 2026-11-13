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
    expect(days("cover from 9 to 11 November please")).toEqual(span("2026-11-09", 3));
    expect(days("cover the 10th to 16th of November")).toEqual(span("2026-11-10", 7));
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
    // "May" and "March" are verbs too: a range in them needs a firm cue, as a single date does.
    expect(days("3–5 May")).toEqual([]);
    expect(days("from 3rd to 5th May")).toEqual(span("2026-05-03", 3));
  });

  // The review of D1773 (REQUEST_CHANGES): each input it found misread, as main reads it or as the range it is.
  test("review 1: a mixed order across months is read date by date, as main reads it", () => {
    expect(days("from Nov 12 to 14 December")).toEqual(["2026-11-12", "2026-12-14"]);
    expect(days("Nov 2 - 4 Dec")).toEqual(["2026-11-02"]);
    expect(days("between Nov 12 and 14 December")).toEqual(["2026-11-12", "2026-12-14"]);
  });

  test("review 2: an ordinal range through datedText stays in its own month and year", () => {
    const read = (text: string) => [...(timeWindow(datedText(text, NOW), NOW)?.days ?? [])].sort();
    expect(read("Book a room for the 12th–14th November")).toEqual(span("2026-11-12", 3));
    expect(read("cover the 10th to 16th of November")).toEqual(span("2026-11-10", 7));
    expect(read("for 12th–14th Nov")).toEqual(span("2026-11-12", 3));
    // A bare ordinal not followed by a dated day is still given its month.
    expect(read("book it for the 12th")).toEqual(["2026-11-12"]);
  });

  test("review 3: amounts, scores and chapters before a date are no range, and the date survives", () => {
    expect(days("budget $10-20 Nov 12")).toEqual(["2026-11-12"]);
    expect(days("tickets £12-14 November 20")).toEqual(["2026-11-14", "2026-11-20"]);
    expect(days("we drew 1-2 Nov 12")).toEqual(["2026-11-12"]);
    expect(days("lost 1–3 Nov 12")).toEqual(["2026-11-12"]);
    expect(days("chapters 5-6 Nov 12")).toEqual(["2026-11-12"]);
    expect(days("costs €5-8 November 3")).toEqual(["2026-11-03", "2026-11-08"]);
  });

  test("review 4: hours after a month-first day are no range", () => {
    expect(days("Nov 10-11 am")).toEqual(["2026-11-10"]);
    expect(days("Nov 3 to 5 pm")).toEqual(["2026-11-03"]);
    expect(days("Nov 3 until 5 pm")).toEqual(["2026-11-03"]);
    expect(days("Nov 3 - 5h")).toEqual(["2026-11-03"]);
  });

  test("review 5: a version or a count before a separator word is no range", () => {
    expect(days("upgrade Postgres 12 to 14 November")).toEqual(["2026-11-14"]);
    expect(days("bump node 18 to 20 November")).toEqual(["2026-11-20"]);
    expect(days("PostgreSQL 13 to 30 November")).toEqual(["2026-11-30"]);
  });

  test("review 6: 'for' and 'between' are no firm cue for May, March or a short month after its day", () => {
    expect(days("Plan for 3-5 may change")).toEqual([]);
    expect(days("sections 3-4 dec ideas")).toEqual([]);
    expect(days("between 3 and 5 dec")).toEqual([]);
  });

  test("review 7: a New Year range said in early January is the days just gone and tomorrow", () => {
    const jan = Date.parse("2027-01-02T12:00:00Z");
    const read = (text: string) => [...(timeWindow(text, jan)?.days ?? [])].sort();
    expect(read("off 28 December to 3 January")).toEqual(span("2026-12-28", 7));
    // As a lone date reads in January: this year's November.
    expect(read("12–14 November")).toEqual(span("2027-11-12", 3));
  });

  test("review 8: a reschedule names its two days, not the days between", () => {
    expect(days("Move my dentist from 10 to 12 November")).toEqual(["2026-11-12"]);
    expect(days("Reschedule the review from 10 November to 12 November")).toEqual(["2026-11-10", "2026-11-12"]);
    expect(days("push the offsite from Nov 10 to Nov 12")).toEqual(["2026-11-10", "2026-11-12"]);
    // Not a move: the range is read.
    expect(days("I'm away from 10 to 12 November")).toEqual(span("2026-11-10", 3));
  });

  test("datedText leaves a range for timeWindow to read", () => {
    const read = (text: string) => [...(timeWindow(datedText(text, NOW), NOW)?.days ?? [])].sort();
    expect(read("Book me a hotel in Edinburgh for 12–14 November.")).toEqual(span("2026-11-12", 3));
    expect(read("Book Maya into the holiday club for 21–23 December, £38 a day.")).toEqual(span("2026-12-21", 3));
  });
});
