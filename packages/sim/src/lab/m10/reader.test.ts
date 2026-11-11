import { describe, expect, test } from "bun:test";
import { readText } from "./reader";

// M10's reader (D962): the dates and amounts an item mentions, resolved to values, as the lab's tagger reads them.

const ANCHOR = Date.parse("2026-10-23T12:00:00Z");
const days = (s: string) =>
  readText("t", s, ANCHOR)
    .dates.filter((d) => d.from >= 0)
    .map((d) => d.day);

describe("readText: dates and amounts", () => {
  test("ranges, months, weekdays, ordinals and relative days resolve against the item's date", () => {
    expect(days("Freeze 4–9 Nov 2026")).toEqual(["2026-11-04", "2026-11-09"]);
    // A hyphenated range is read as one written with a dash.
    expect(days("Production change freeze 4-9 Nov.")).toEqual(["2026-11-04", "2026-11-09"]);
    expect(days("for all of November while")).toEqual(["2026-11-01", "2026-11-30"]);
    expect(days("staging is down until Thursday")).toEqual(["2026-10-29"]);
    // Written on a Friday, "by Friday" is a week on.
    expect(days("Confirmations by Friday")).toEqual(["2026-10-30"]);
    expect(days("the scan on the 20th")).toEqual(["2026-11-20"]);
    expect(days("out on Thursday 3rd")).toEqual(["2026-11-03"]);
    expect(days("within 7 days")).toEqual(["2026-10-30"]);
    expect(days("dated January 2021 onwards")).toEqual(["2021-01-01", "2021-01-31"]);
  });

  test("words that start like a month are not months; a phone number is not a range", () => {
    expect(days("the marketing decision is final")).toEqual([]);
    expect(days("call 555-1234 later")).toEqual([]);
  });

  test("amounts: currency, thousands, k and percent", () => {
    const a = readText("t", "£50k over 10% and $1,200", ANCHOR).amounts.map((x) => [x.value, x.unit]);
    expect(a).toEqual([
      [50_000, "£"],
      [10, "%"],
      [1_200, "$"],
    ]);
  });

  test("the item's own date is always a mention (from -1)", () => {
    expect(readText("t", "no dates here", ANCHOR).dates).toEqual([
      { from: -1, to: -1, day: "2026-10-23", form: 4, range: 0 },
    ]);
  });
});
