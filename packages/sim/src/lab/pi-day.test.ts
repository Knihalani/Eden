import { describe, expect, test } from "bun:test";
import type { Task } from "./ab-common";
import {
  DayLog,
  dayId,
  isRecap,
  placePackets,
  poolDays,
  RECAP_TEXT,
  shiftClocks,
  shiftMeta,
  withRecaps,
} from "./pi-day";

const task = (id: string, planted?: string): Task => ({
  id,
  suite: "heldout14",
  kind: "hidden",
  type: id.split(":")[2]!,
  event: "user_message",
  text: `request ${id}`,
  must: [{ id: "f", detail: "d" }],
  secrets: [],
  ...(planted ? { planted } : {}),
});

describe("pi-ab --day (fix-s3b)", () => {
  test("shiftClocks moves every distinct time once, never onto another time in the text", () => {
    expect(shiftClocks("Lunch 12:30, then 14:30 call; 12:30 again")).toEqual({
      // 12:30 + 2 h is 14:30, already in the text: it goes one hour further.
      text: "Lunch 15:30, then 16:30 call; 15:30 again",
      moves: [
        { from: "12:30", to: "15:30" },
        { from: "14:30", to: "16:30" },
      ],
    });
    expect(shiftClocks("Flight 23:15").text).toBe("Flight 01:15");
    expect(shiftClocks("no time here")).toEqual({ text: "no time here", moves: [] });
  });

  test("withRecaps adds one ungraded recap per day and after a short last day", () => {
    const ts = ["a", "b", "c", "d", "e"].map((t) => task(`w41:heldout14:${t}`, `item-${t}`));
    const out = withRecaps(ts, 2);
    expect(out.map((t) => t.id)).toEqual([
      "w41:heldout14:a",
      "w41:heldout14:b",
      "w41:heldout14:day0:recap",
      "w41:heldout14:c",
      "w41:heldout14:d",
      "w41:heldout14:day1:recap",
      "w41:heldout14:e",
      "w41:heldout14:day2:recap",
    ]);
    const recap = out[2]!;
    expect([isRecap(recap), recap.must, recap.text, "planted" in recap]).toEqual([true, [], RECAP_TEXT, false]);
    expect(isRecap(out[0]!)).toBe(false);
    expect(withRecaps(ts, 0)).toEqual(ts);
    expect(dayId("w41:heldout14-control:x", 3)).toBe("w41:heldout14-control:day3");
  });

  test("DayLog counts repeats, changed repeats, shown marks, stale deliveries and the recap", () => {
    const log = new DayLog("d", "eden");
    log.turn(); // 0
    log.packet(["A", "B"], "A at 12:30; B");
    log.turn(); // 1
    log.changed("A", [{ from: "12:30", to: "14:30" }]); // at the turn's start, before its deliveries
    log.packet(["A"], "A at 12:30"); // repeat, changed since, and stale
    log.packet(["B"], "B (shown above)"); // repeat, unchanged
    log.answer(["B"], "B again"); // ask repeat
    log.turn(); // 2: the recap
    log.answer(["A"], "A now at 14:30"); // fresh, not stale
    log.recap("Watch the 12:30 slot for A.");
    expect(log.summary()).toEqual({
      day: "d",
      condition: "eden",
      turns: 3,
      delivered: 4,
      repeatDelivered: 2,
      repeatChanged: 1,
      shownMarks: 1,
      askRepeat: 2, // the turn-1 ask of B and the recap-turn ask of A
      changed: 1,
      staleDeliveries: 1,
      staleRecap: 1,
      freshRecap: 0,
      recapAnswered: true,
    });
    const other = new DayLog("e", "eden");
    other.turn();
    other.changed("C", [{ from: "09:00", to: "11:00" }]);
    other.changed("D", []); // no clock time: not a change
    other.recap("C moved to 11:00");
    const pooled = poolDays([log.summary(), other.summary()]).eden!;
    expect([pooled.changed, pooled.freshRecap, pooled.staleRecap, pooled.turns]).toEqual([2, 1, 1, 4]);
  });

  test("placePackets puts each earlier turn's packets before its own user turn and today's before the last", () => {
    const m = (role: string, c: string) => ({ role, c });
    const msgs = [m("user", "u0"), m("assistant", "a0"), m("user", "u1"), m("toolResult", "t"), m("user", "u2")];
    const out = placePackets(msgs, [["p0"], []], ["p2a", "p2b"], (t) => m("system", t));
    expect(out.map((x) => x.c)).toEqual(["p0", "u0", "a0", "u1", "t", "p2a", "p2b", "u2"]);
  });
});

describe("pi-ab --day, review fixes", () => {
  test("the recap is a user's turn even after an arriving message, and shiftMeta moves a start with its text", () => {
    const arrival = { ...task("w41:s7:2", "x"), event: "external" as const };
    expect(withRecaps([arrival], 4)[1]!.event).toBe("user_message");
    const meta = { start: "2026-10-30T14:30:00.000Z", people: "a" };
    expect(shiftMeta(meta, [{ from: "14:30", to: "16:30" }])).toEqual({
      start: "2026-10-30T16:30:00.000Z",
      people: "a",
    });
    // Past midnight the date moves too; a start no move names stays.
    expect(shiftMeta({ start: "2026-10-30T23:15:00.000Z" }, [{ from: "23:15", to: "01:15" }]).start).toBe(
      "2026-10-31T01:15:00.000Z",
    );
    expect(shiftMeta({ start: "2026-10-30T09:00:00.000Z" }, [{ from: "14:30", to: "16:30" }]).start).toBe(
      "2026-10-30T09:00:00.000Z",
    );
  });
});
