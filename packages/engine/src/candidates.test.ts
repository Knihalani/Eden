import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { liftCandidates, namedDays, namesDay } from "./candidates";

const item = (id: string, title: string, text = ""): { item: ContextItem } => ({
  item: { id, sourceId: "gmail", title, text, url: "" } as ContextItem,
});
const ids = (xs: { item: ContextItem }[]) => xs.map((x) => x.item.id);

describe("namedDays", () => {
  test("day-month, month-day, ranges and ordinals", () => {
    expect(namedDays("Book court 3 on Sunday 1 November at 10am")).toEqual([{ day: 1, month: 10 }]);
    expect(namedDays("a hotel in Edinburgh for 12–14 November")).toEqual([
      { day: 12, month: 10 },
      { day: 13, month: 10 },
      { day: 14, month: 10 },
    ]);
    expect(namedDays("flights on Nov 5th and the 3rd of January")).toEqual([
      { day: 3, month: 0 },
      { day: 5, month: 10 },
    ]);
  });

  test("no explicit date names none (weekdays and 'next week' are not dates here)", () => {
    expect(namedDays("Book me a GP appointment next week")).toEqual([]);
    expect(namedDays("Move my physio on Wednesday at 8:30")).toEqual([]);
  });
});

describe("namesDay", () => {
  const nov20 = [{ day: 20, month: 10 }];
  test("the day with its month, an ordinal alone, or figures", () => {
    expect(namesDay("Friday 20th: can't babysit after all", nov20)).toBe(true);
    expect(namesDay("Fri 20 Nov, 7pm", nov20)).toBe(true);
    expect(namesDay("on November 20 we are away", nov20)).toBe(true);
    expect(namesDay("due 20/11", nov20)).toBe(true);
  });

  test("another day does not count", () => {
    expect(namesDay("Friday 21st: can't babysit", nov20)).toBe(false);
    expect(namesDay("Fri 20 Oct", nov20)).toBe(false);
    expect(namesDay("120 seats, 20 people", nov20)).toBe(false);
    expect(namesDay("Fri 20th", [])).toBe(false);
  });
});

describe("liftCandidates", () => {
  test("a repeated title takes no second seat", () => {
    const pool = [
      item("a", "Focus time"),
      item("b", "Expense policy"),
      item("c", "Re: Expense policy"),
      item("d", "focus time"),
      item("e", "Gym"),
      item("f", "Lunch"),
    ];
    expect(ids(liftCandidates(pool, "Move my physio to Monday")).slice(0, 5)).toEqual(["a", "b", "e", "f"]);
  });

  test("untitled items are never repeats of one another", () => {
    const pool = [item("a", ""), item("b", ""), item("c", "")];
    expect(ids(liftCandidates(pool, "x"))).toEqual(["a", "b", "c"]);
  });

  test("the first three keep their places; up to two items naming the request's date move up", () => {
    const pool = [
      item("a", "Maya pickup", "Friday 20 Nov 2026, 15:30"),
      item("b", "Hold"),
      item("c", "Lunch"),
      item("d", "Gym"),
      item("e", "All hands"),
      item("f", "Friday 20th", "so sorry, I can't do the 20th after all"),
      item("g", "Dates", "I'm away 20 November"),
      item("h", "Also", "the 20th"),
    ];
    const got = ids(liftCandidates(pool, "Accept the housewarming invite for Friday 20 November at 8pm"));
    expect(got).toEqual(["a", "b", "c", "f", "g", "d", "e", "h"]);
  });

  test("a request with no date keeps the pool's order (repeats aside)", () => {
    const pool = [item("a", "One"), item("b", "Two"), item("c", "Three"), item("d", "Four", "the 20th")];
    expect(ids(liftCandidates(pool, "Send Priya the renewal terms"))).toEqual(["a", "b", "c", "d"]);
  });
});
