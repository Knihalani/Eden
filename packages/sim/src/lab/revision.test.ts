import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
import { stale } from "./revision";
import { parseSuites, SUITES } from "./suites";

// M3b (D914): `+revision` plants a stale earlier version beside each hidden fact of train5-6 and 5r-6r; the base suites
// and the other variants are unchanged.

describe("+revision", () => {
  test("the rule changes one detail: a date (weekday with it), a time, an amount, a count, else a draft mark", () => {
    expect(stale("t", "Dinner on Thursday 29 October at 19:00.")).toMatchObject({
      text: "Dinner on Tuesday 27 October at 19:00.",
      rule: "date",
      days: -2,
    });
    expect(stale("t", "Strike on 05/11, plan ahead").text).toBe("Strike on 07/11, plan ahead");
    expect(stale("t", "rooms from the 12th").text).toBe("rooms from the 14th");
    expect(stale("t", "Call at 09:30 [10:00] ok").text).toBe("Call at 08:30 [10:00] ok");
    expect(stale("t", "[07:00] Ana: the fee is £1,200.").text).toBe("[07:00] Ana: the fee is £1,500.");
    expect(stale("t", "Ref IN-EV-22758488: 2 nights").text).toBe("Ref IN-EV-22758488: 3 nights");
    expect(stale("t", "No detail here.")).toMatchObject({ text: "Draft: No detail here.", rule: "draft" });
    // A mail's own header block is not content.
    const mail = "From: A <a@x.co>\nTo: B <b@x.co>\nDate: Mon, 26 Oct 2026 05:00\n\nLeave at 18:30.";
    expect(stale("t", mail).text).toBe(
      "From: A <a@x.co>\nTo: B <b@x.co>\nDate: Mon, 26 Oct 2026 05:00\n\nLeave at 17:30.",
    );
  });

  test("hidden tasks get a stale version in place of a noise item; planted items, controls and bases unchanged", () => {
    for (const base of ["train5", "train6", "train5r", "train6r"]) {
      const name = `${base}+revision`;
      expect(parseSuites(name)).toEqual([name]);
      const plain = buildWorld({ seed: 41_000 });
      const n0 = plain.items.length;
      const baseTasks = SUITES[base]!(plain, 41, "hidden");
      const w = buildWorld({ seed: 41_000 });
      const tasks = SUITES[name]!(w, 41, "hidden");
      // Same tasks (but `stale`), same planted items at the end, same item count.
      expect(tasks.map(({ stale: _, ...t }) => t)).toEqual(baseTasks);
      expect(w.items.length).toBe(plain.items.length);
      expect(w.items.slice(n0)).toEqual(plain.items.slice(n0));
      const byId = new Map(w.items.map((i) => [i.id, i]));
      for (const [k, t] of tasks.entries()) {
        const old = byId.get(t.stale!)!;
        const fact = w.items[n0 + k]!;
        expect(old.sourceId).toBe(fact.sourceId);
        expect(old.updatedAt).toBe(fact.updatedAt - 3 * 86_400_000);
        expect(old.text).not.toBe(fact.text);
        expect(old.noise).toBe(false);
      }
      // Exactly one noise item per task was replaced.
      const replaced = plain.items.slice(0, n0).filter((it, i) => w.items[i]!.id !== it.id);
      expect(replaced.length).toBe(tasks.length);
      // Controls plant nothing more.
      const c1 = buildWorld({ seed: 41_000 });
      const c2 = buildWorld({ seed: 41_000 });
      expect(SUITES[name]!(c1, 41, "control")).toEqual(SUITES[base]!(c2, 41, "control"));
      expect(c1.items).toEqual(c2.items);
    }
  });

  test("only train5-6 and 5r-6r take it", () => {
    expect(() => parseSuites("train1+revision")).toThrow();
    expect(() => parseSuites("heldout13+revision")).toThrow();
  });
});
