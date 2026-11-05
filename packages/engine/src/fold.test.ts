import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { foldEchoes } from "./fold";

const x = (id: string, title: string, text: string): { item: ContextItem } => ({
  item: { id, sourceId: "s", ref: id, title, text },
});

const EVENT = x("e", "Lunch with Nadia Petrova", "When: Wednesday 4 Nov 2026, 10:30–12:00\nWhere: Padella, London");
const BOOKED = x("r", "Re: Lunch?", "From: Nadia Petrova\n\nPerfect, booked Padella for Wednesday 10:30.");
const OTHER = x("o", "Dentist", "When: Thursday 5 Nov 2026, 09:00–09:30\nWhere: Smile Dental");
const NOTE = x("n", "Shopping list", "Milk, eggs, flour and a birthday card for Sam.");

describe("foldEchoes: the anchor early exit", () => {
  test("a packet with no anchor on two items is returned as it is, its words never read", () => {
    let asked = 0;
    const rare = () => (asked++, false);
    const xs = [EVENT, OTHER, NOTE, x("e2", "Lunch with Nadia", "Wednesday 4 Nov at 12:30, Padella")];
    // The same array: nothing is copied, and no word is weighed (`rare` is the words' test).
    expect(foldEchoes(xs, { focus: new Set(), year: 2026, rare })).toBe(xs);
    expect(asked).toBe(0);
    // No anchor at all.
    const plain = [NOTE, x("n2", "Notes", "Call the bank about the card.")];
    expect(foldEchoes(plain, { focus: new Set(), year: 2026, rare })).toBe(plain);
    expect(asked).toBe(0);
  });

  test("a packet with a repeated anchor folds as before", () => {
    const xs = [EVENT, OTHER, BOOKED, NOTE];
    const kept = foldEchoes(xs, { focus: new Set(["lunch"]), year: 2026, self: "Robin Carter", rare: () => false });
    expect(kept.map((y) => y.item.id)).toEqual(["e", "o", "n"]);
    expect(kept).not.toBe(xs);
    // A repeated anchor whose item adds a change is kept: the words are read, and nothing is folded.
    const moved = x("m", "Re: Lunch?", "Wednesday 10:30 is cancelled, sorry.");
    expect(
      foldEchoes([EVENT, moved], { focus: new Set(), year: 2026, rare: () => false }).map((y) => y.item.id),
    ).toEqual(["e", "m"]);
  });

  test("an item read before is read again when its text, title or the user's name changes", () => {
    const event = x("e", EVENT.item.title, EVENT.item.text);
    const reply = x("r", BOOKED.item.title, BOOKED.item.text);
    const ids = (self?: string) =>
      foldEchoes([event, reply], { focus: new Set(), year: 2026, self, rare: () => false }).map((y) => y.item.id);
    expect(ids()).toEqual(["e"]);
    // Changed in place: the reply now says the lunch is cancelled, and is no echo.
    reply.item.text = "From: Nadia Petrova\n\nPerfect, but Wednesday 10:30 is cancelled.";
    expect(ids()).toEqual(["e", "r"]);
    reply.item.text = BOOKED.item.text;
    expect(ids()).toEqual(["e"]);
    // The event's anchor only in its title: still the same occurrence.
    event.item.title = "Lunch with Nadia Petrova @ Wednesday 10:30";
    event.item.text = "Where: Padella, London";
    expect(ids()).toEqual(["e"]);
    // Its anchor gone from both: the reply has nothing to echo.
    event.item.title = "Lunch with Nadia Petrova";
    expect(ids()).toEqual(["e", "r"]);
    // The user's own name read out of the parts: an entry read for another name is not reused.
    expect(ids("Nadia Petrova")).toEqual(ids());
  });
});
