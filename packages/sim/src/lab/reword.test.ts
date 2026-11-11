import { describe, expect, test } from "bun:test";
import { isImperative, isOpenRequest, MORE_VERBS, pushStart } from "@eden/engine";
import { buildWorld } from "../world";
import { formOf, REWORD_FORMS, rewordOf } from "./reword";
import { parseSuites, SUITES } from "./suites";

// P2 (D820): the reworded train keeps every world, fact and decoy; only the request's words change.

describe("reword.ts and train-rw", () => {
  test("each form wraps the imperative; questions end in a question mark", () => {
    const t = "Book the Golf in for its MOT at Kwik Lane Garage, Saturday morning.";
    expect(rewordOf(t, "need")).toBe("I need to book the Golf in for its MOT at Kwik Lane Garage, Saturday morning.");
    expect(rewordOf(t, "should-i")).toBe(
      "Should I book the Golf in for its MOT at Kwik Lane Garage, Saturday morning?",
    );
    expect(rewordOf("Can you message Mum about Theo?", "we-should")).toBe("We should message Mum about Theo?");
    expect(rewordOf("RSVP yes to Tilly's wedding.", "lets")).toBe("Let's RSVP yes to Tilly's wedding.");
    expect(rewordOf("Dan's last day was Friday, please remove access.", "need")).toBeNull();
    expect(rewordOf("When you do Mum's order, add ibuprofen.", "need")).toBeNull();
  });

  test("a template's form is fixed, and train uses every form", () => {
    expect(formOf("calendar-clash")).toBe(formOf("calendar-clash"));
    const forms = new Set<string>();
    for (const s of parseSuites("train"))
      for (const t of SUITES[s]!(buildWorld({ seed: 41_000 }), 41, "hidden")) forms.add(formOf(t.template));
    expect(forms.size).toBe(REWORD_FORMS.length);
  });

  test("the same world and tasks as train, ids marked, text reworded", () => {
    for (const variant of ["hidden", "control", "neutral"] as const) {
      const a = buildWorld({ seed: 42_000 });
      const b = buildWorld({ seed: 42_000 });
      const orig = SUITES.train3!(a, 42, variant);
      const rw = SUITES.train3rw!(b, 42, variant);
      expect(b.items.map((x) => x.id)).toEqual(a.items.map((x) => x.id));
      expect(rw.map((t) => t.template)).toEqual(orig.map((t) => t.template));
      expect(rw.map((t) => t.detail)).toEqual(orig.map((t) => t.detail));
      for (const [i, t] of rw.entries()) {
        expect(t.id).toBe(orig[i]!.id.replace(":train3", ":train3rw"));
        expect(t.text).toBe(rewordOf(orig[i]!.text, formOf(t.template)) ?? orig[i]!.text);
      }
    }
  });

  test("train-rw is its own group and not in all", () => {
    expect(parseSuites("train-rw")).toEqual(parseSuites("train").map((s) => `${s}rw`));
    expect(parseSuites("all").some((s) => s.endsWith("rw"))).toBe(false);
  });

  test("pushStart (D820): off is the old gate on every train request; on, train's requests start as before", () => {
    for (const seed of [41, 42, 43, 44])
      for (const s of parseSuites("train"))
        for (const t of SUITES[s]!(buildWorld({ seed: seed * 1_000 }), seed, "hidden")) {
          const old = isImperative(t.text, MORE_VERBS) ? "listed" : isOpenRequest(t.text) ? "opened" : null;
          const off = pushStart(t.text, { open: true, indirect: false });
          expect(off?.how ?? null).toBe(old);
          if (off) expect(off.request).toBe(t.text);
          expect(pushStart(t.text, { open: true, indirect: true })?.how ?? null).toBe(old);
        }
  });
});
