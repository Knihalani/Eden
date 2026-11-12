import { describe, expect, test } from "bun:test";
import { buildWorld } from "../world";
import { applyEdits, noiseEdits, plantBefore } from "./silent";
import { parseSuites, SUITES } from "./suites";

// F3 (D1123): silent edits. A hidden task's planted item starts at its source as `before`; the edit lands, with no
// notice, after the backfill. `+silent` gives train's hidden tasks a `before` by revision.ts's fixed rule.

describe("+silent", () => {
  test("hidden tasks carry a `before` one detail off their fact; the world, controls and bases are unchanged", () => {
    for (const base of ["train1", "train6r"]) {
      const name = `${base}+silent`;
      expect(parseSuites(name)).toEqual([name]);
      const plain = buildWorld({ seed: 41_000 });
      const baseTasks = SUITES[base]!(plain, 41, "hidden");
      const w = buildWorld({ seed: 41_000 });
      const n0 = w.items.length;
      const tasks = SUITES[name]!(w, 41, "hidden");
      expect(tasks.map(({ before: _, ...t }) => t)).toEqual(baseTasks);
      expect(w.items).toEqual(plain.items);
      for (const [k, t] of tasks.entries()) {
        const fact = w.items[n0 + k]!;
        if (!t.before) continue; // The rule left this fact's text as it was: no edit.
        expect(`${t.before!.title}\n${t.before!.text}`).not.toBe(`${fact.title}\n${fact.text}`);
      }
      const c1 = buildWorld({ seed: 41_000 });
      const c2 = buildWorld({ seed: 41_000 });
      expect(SUITES[name]!(c1, 41, "control")).toEqual(SUITES[base]!(c2, 41, "control"));
    }
  });

  test("only train and its rewordings take it", () => {
    expect(() => parseSuites("heldout19+silent")).toThrow();
    expect(() => parseSuites("longtail+silent")).toThrow();
  });
});

describe("plantBefore and applyEdits", () => {
  test("the earlier version is at the source until the edit lands, then the edited one, newest", () => {
    const w = buildWorld({ seed: 41_000 });
    const n0 = w.items.length;
    parseSuites("train5+silent"); // Registers it.
    const tasks = SUITES["train5+silent"]!(w, 41, "hidden");
    const planted = w.items.slice(n0);
    const edited = planted.map((it) => ({ ...it }));
    const held = plantBefore(
      w,
      tasks,
      planted.map((it) => it.id),
    );
    expect(held.size).toBe(tasks.filter((t) => t.before).length);
    for (const [k, t] of tasks.entries()) {
      if (!t.before) continue;
      const now = w.items.find((x) => x.id === planted[k]!.id)!;
      expect(now.title).toBe(t.before!.title);
      expect(now.updatedAt).toBe(edited[k]!.updatedAt - 3 * 86_400_000);
    }
    const at = w.now + 1;
    const touched = applyEdits(w, held, at);
    expect(touched.size).toBeGreaterThan(0);
    expect(held.size).toBe(0);
    for (const e of edited) {
      const now = w.items.find((x) => x.id === e.id)!;
      expect({ ...now, updatedAt: 0 }).toEqual({ ...e, updatedAt: 0 });
      expect(now.updatedAt).toBe(at);
    }
  });

  test("a task without `before` (or without a planted item) is left as it is", () => {
    const w = buildWorld({ seed: 41_000 });
    const items = w.items.map((i) => ({ ...i }));
    expect(plantBefore(w, [{}, { before: { title: "x", text: "y" } }], [w.items[0]!.id, undefined]).size).toBe(0);
    expect(w.items).toEqual(items);
  });
});

describe("noiseEdits (D1125)", () => {
  test("N unrelated items start one detail earlier, the same picks for a seed in every variant, never a planted one", () => {
    const pick = (variant: "hidden" | "control") => {
      const w = buildWorld({ seed: 41_000 });
      const n0 = w.items.length;
      SUITES.train5!(w, 41, variant);
      const planted = new Set(w.items.slice(n0).map((x) => x.id));
      const held = new Map();
      noiseEdits(w, 41, 6, planted, held);
      for (const id of held.keys()) expect(planted.has(id)).toBe(false);
      return { w, held: held as Map<string, { id: string; text: string; title: string }> };
    };
    const h = pick("hidden");
    const c = pick("control");
    expect(h.held.size).toBe(6);
    expect([...h.held.keys()]).toEqual([...c.held.keys()]);
    for (const [id, edited] of h.held) {
      const now = h.w.items.find((x) => x.id === id)!;
      expect(`${now.title}\n${now.text}`).not.toBe(`${edited.title}\n${edited.text}`);
    }
    applyEdits(h.w, h.held as never, h.w.now);
    expect(h.held.size).toBe(0);
  });
});
