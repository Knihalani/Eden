import { describe, expect, test } from "bun:test";
import { mayConstrain } from "@eden/engine";
import { worldOf } from "./ab-common";
import { requestNames } from "./dress-entities";

// A6 (D287): dressed worlds give each person or firm a request names (that no item names) one ordinary message,
// and change nothing else.
const LIMITS = { maxTasks: 1e9, maxOffworld: 0 };
const texts = (w: { world: { items: { title: string; text: string }[] } }) =>
  w.world.items.map((i) => `${i.title}\n${i.text}`.toLowerCase());
const names = requestNames;

describe("dressed worlds (A6, D287; lab only)", () => {
  test("requestNames: people and firms, a leading verb and a possessive taken off", () => {
    expect(names("Send Priya Raman the renewal terms for Vandelay Industries.")).toEqual([
      "Priya Raman",
      "Vandelay Industries",
    ]);
    expect(names("Pay Ethan Brooks's first invoice, £6,200.")).toEqual(["Ethan Brooks"]);
    expect(names("Book the Golf in at Kwik Lane Garage and add it to my FreshCart order.")).toEqual([
      "Kwik Lane Garage",
      "FreshCart",
    ]);
  });

  test("requestNames: ids, acronyms, places, holidays, products and lone words are not dressed (review of D287)", () => {
    expect(names("Pay Corran Print's invoice CP-2210 before the TLS renewal.")).toEqual(["Corran Print"]);
    expect(names("Book me a hotel in Leeds near King's Cross for Bonfire Night.")).toEqual([]);
    expect(names("Order the MacBook Pro for Callum before Christmas, and ask Matt.")).toEqual([]);
    expect(names("Send the IAM review and the SDK notes to the Thames Valley office.")).toEqual([]);
    expect(names("Fly me to New York, then the Corn Exchange via Temple Meads.")).toEqual([]);
  });

  test("off by default: the world is the undressed one, item for item", () => {
    for (const v of ["hidden", "control", "neutral"] as const) {
      const a = worldOf(41, "train4", v, LIMITS);
      const b = worldOf(41, "train4", v, LIMITS, {});
      expect(b.world.items.map((i) => i.id)).toEqual(a.world.items.map((i) => i.id));
    }
  });

  // train6 and train2 have calendar slots `clearSlot` empties (23 and 14 items on seed 41); train4 has none.
  for (const suite of ["train4", "train6", "train2"]) {
    test(`dressed (${suite}): the names covered, tasks and the undressed items unchanged, no constraint`, () => {
      for (const v of ["hidden", "control", "neutral"] as const) {
        const plain = worldOf(41, suite, v, LIMITS);
        const w = worldOf(41, suite, v, LIMITS, { dress: true });
        expect(w.tasks).toEqual(plain.tasks);
        const all = texts(w);
        for (const t of w.tasks) {
          for (const n of requestNames(t.text)) expect(all.some((x) => x.includes(n.toLowerCase()))).toBe(true);
        }
        // The undressed world is an exact prefix: the planted items (read off its end) and `clearSlot`'s work stand,
        // and dressing items come after `clearSlot` ran, so none of them is filtered by it.
        expect(w.world.items.slice(0, plain.world.items.length).map((i) => i.id)).toEqual(
          plain.world.items.map((i) => i.id),
        );
        const added = w.world.items.slice(plain.world.items.length);
        expect(added.length).toBeGreaterThan(0);
        for (const it of added) {
          expect(it.id.startsWith("gmail:dress-")).toBe(true);
          expect(it.kind).toBe("mail");
          expect(it.facts).toEqual([]);
          // Not constraint-like by `readerGate`'s own test: a dressing item cannot be a hidden fact or a decoy.
          expect(mayConstrain(`${it.title}. ${it.text}`.toLowerCase())).toBe(false);
        }
      }
    });
  }

  test("the same names are dressed in every variant (the base world decides, not the planted item)", () => {
    const ids = (v: "hidden" | "control" | "neutral") =>
      worldOf(42, "train6", v, LIMITS, { dress: true })
        .world.items.filter((i) => i.id.startsWith("gmail:dress-"))
        .map((i) => `${i.title}|${i.text}`);
    expect(ids("hidden")).toEqual(ids("neutral"));
    expect(ids("control")).toEqual(ids("neutral"));
  });
});
