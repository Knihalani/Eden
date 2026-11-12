import { describe, expect, test } from "bun:test";
import { coversDay, datedText } from "./days";
import { timeWindow } from "./grounding";

// Tuesday 27 October 2026, 09:00 UTC.
const NOW = Date.UTC(2026, 9, 27, 9, 0);
const days = (text: string) => [...(timeWindow(datedText(text, NOW), NOW)?.days ?? [])].sort();

describe("datedText (pushDaySeats, D1400)", () => {
  test("a bare day of the month is the next such date", () => {
    expect(days("Should I say yes to the alumni dinner on the 20th?")).toEqual(["2026-11-20"]);
    expect(days("What time should I leave for the airport on the 3rd?")).toEqual(["2026-11-03"]);
    expect(days("I'm hosting book club at mine on the 29th.")).toEqual(["2026-10-29"]);
  });

  test("a weekday with a day of the month is that date, not the coming weekday", () => {
    expect(days("Let's run the sprint demo for everyone on Monday the 9th.")).toEqual(["2026-11-09"]);
    expect(days("Planning drinks with the uni lot on Friday the 6th")).toEqual(["2026-11-06"]);
  });

  test("other languages' ordinals", () => {
    expect(days("Ska jag tacka ja till offsiten i Berlin den 12:e?")).toEqual(["2026-11-12"]);
    expect(days("Wir treffen uns am 12. im Büro")).toEqual(["2026-11-12"]);
  });

  test("a date already written, or an ordinal that counts something else, is left alone", () => {
    for (const t of [
      "Book the room for the 20th of November",
      "Move it to November 20th",
      "It's on the 5th floor",
      "Plan Ruth's 65th",
      "This is the 3rd time I've asked",
      "Our 20th anniversary dinner",
      "Send the invoice to Carl",
    ])
      expect(datedText(t, NOW)).toBe(t);
  });

  test("a day past the month's end is no date; input with many ordinals is bounded", () => {
    expect(datedText("on the 45th", NOW)).toBe("on the 45th");
    const many = Array.from({ length: 40 }, (_, i) => `the ${(i % 28) + 1}th`).join(", ");
    expect(datedText(many, NOW).match(/October|November/g)?.length).toBe(8);
  });
});

describe("coversDay (pushDaySeats, D1400)", () => {
  const on = (d: string) => new Set([d]);

  test("a range across months spans the days between", () => {
    const jury = "When: Mon 26 Oct – Fri 6 Nov 2026, weekdays, report 09:15";
    expect(coversDay(jury, on("2026-10-30"))).toBe(true);
    expect(coversDay(jury, on("2026-11-09"))).toBe(false);
    expect(coversDay("out of service from Fri 30 Oct to Fri 6 Nov for refurbishment", on("2026-10-31"))).toBe(true);
    expect(coversDay("Doxycycline 100mg: 26 Oct → 8 Nov", on("2026-11-02"))).toBe(true);
  });

  test("the range's own ends are not its inside (the text writes them: `namesDay` finds those)", () => {
    expect(coversDay("Mon 26 Oct – Fri 6 Nov", on("2026-11-06"))).toBe(false);
  });

  test("an open range runs from the item's own day", () => {
    const text = "visiting is suspended until at least Monday 2 November";
    expect(coversDay(text, on("2026-10-31"), Date.UTC(2026, 9, 25))).toBe(true);
    expect(coversDay(text, on("2026-11-05"), Date.UTC(2026, 9, 25))).toBe(false);
    expect(coversDay(text, on("2026-10-31"))).toBe(false);
  });

  test("two separate dates, a long span and a year's end", () => {
    expect(coversDay("Invoice of 3 Oct. Next review on 20 Nov.", on("2026-10-30"))).toBe(false);
    expect(coversDay("1 Jan – 30 Jun", on("2026-03-01"))).toBe(false);
    expect(coversDay("closed 20 Dec – 5 Jan", on("2026-12-28"))).toBe(true);
  });

  test("nothing to read", () => {
    expect(coversDay("no dates here to see", on("2026-10-30"))).toBe(false);
    expect(coversDay("Mon 26 Oct – Fri 6 Nov", new Set())).toBe(false);
  });
});
