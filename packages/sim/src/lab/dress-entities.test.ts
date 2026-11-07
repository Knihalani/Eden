import { describe, expect, test } from "bun:test";
import { mayConstrain } from "@eden/engine";
import { worldOf } from "./ab-common";
import { requestNames } from "./dress-entities";

// A6 (D287): dressed worlds give each name a request uses one ordinary message, and change nothing else.
const LIMITS = { maxTasks: 1e9, maxOffworld: 0 };
const texts = (w: { world: { items: { title: string; text: string }[] } }) =>
  w.world.items.map((i) => `${i.title}\n${i.text}`.toLowerCase());

describe("dressed worlds (A6, D287; lab only)", () => {
  test("requestNames drops a leading verb and a possessive", () => {
    expect(requestNames("Send Priya Raman the renewal terms for Vandelay Industries.")).toEqual([
      "Priya Raman",
      "Vandelay Industries",
    ]);
    expect(requestNames("Pay Ethan Brooks's first invoice, £6,200.")).toEqual(["Ethan Brooks"]);
  });

  test("off by default: the world is the undressed one, item for item", () => {
    for (const v of ["hidden", "control", "neutral"] as const) {
      const a = worldOf(41, "train4", v, LIMITS);
      const b = worldOf(41, "train4", v, LIMITS, {});
      expect(b.world.items.map((i) => i.id)).toEqual(a.world.items.map((i) => i.id));
    }
  });

  test("dressed: every request's names are named by some item; tasks and planted items unchanged", () => {
    for (const v of ["hidden", "control", "neutral"] as const) {
      const plain = worldOf(41, "train4", v, LIMITS);
      const w = worldOf(41, "train4", v, LIMITS, { dress: true });
      expect(w.tasks).toEqual(plain.tasks);
      const all = texts(w);
      for (const t of w.tasks)
        for (const n of requestNames(t.text)) expect(all.some((x) => x.includes(n.toLowerCase()))).toBe(true);
      const added = w.world.items.slice(plain.world.items.length);
      expect(added.length).toBeGreaterThan(0);
      expect(w.world.items.slice(0, plain.world.items.length).map((i) => i.id)).toEqual(
        plain.world.items.map((i) => i.id),
      );
      for (const it of added) {
        expect(it.id.startsWith("gmail:dress-")).toBe(true);
        expect(it.facts).toEqual([]);
        // Not constraint-like by `readerGate`'s own test: a dressing item cannot be a hidden fact or a decoy.
        expect(mayConstrain(`${it.title}. ${it.text}`.toLowerCase())).toBe(false);
      }
    }
  });

  test("the same names are dressed in every variant (the base world decides, not the planted item)", () => {
    const ids = (v: "hidden" | "control" | "neutral") =>
      worldOf(42, "train6", v, LIMITS, { dress: true })
        .world.items.filter((i) => i.id.startsWith("gmail:dress-"))
        .map((i) => `${i.title}|${i.text}`);
    expect(ids("hidden")).toEqual(ids("neutral"));
    expect(ids("control")).toEqual(ids("neutral"));
  });
});
