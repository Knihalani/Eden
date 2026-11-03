import { describe, expect, test } from "bun:test";
import { Xoshiro128 } from "./random";
import { Vocab } from "./vocab";

describe("Vocab.release", () => {
  test("a released term is gone, its id is reused, and the others are still found", () => {
    const v = new Vocab(16);
    const a = v.intern("renewal");
    const b = v.intern("quentavious");
    const c = v.intern("globex");
    const heard: number[] = [];
    v.onRelease((id) => heard.push(id));
    v.release(b);
    expect(heard).toEqual([b]);
    expect(v.lookup("quentavious")).toBe(-1);
    expect(v.term(b)).toBe("");
    expect([v.size, v.live]).toEqual([3, 2]);
    expect([v.lookup("renewal"), v.lookup("globex")]).toEqual([a, c]);
    v.release(b); // twice: ignored
    v.release(99); // unknown: ignored
    expect(heard).toEqual([b]);
    const d = v.intern("initech");
    expect(d).toBe(b); // the free id, not a new one
    expect([v.size, v.live, v.term(d), v.lookup("initech")]).toEqual([3, 3, "initech", d]);
    expect(v.lookup("quentavious")).toBe(-1);
  });

  test("random interns and releases agree with a Map, through rehashes and wrapped probe runs", () => {
    const rnd = new Xoshiro128(7);
    const v = new Vocab(16);
    const model = new Map<string, number>();
    for (let step = 0; step < 40_000; step++) {
      // A small universe, so terms come back after release and probe runs crowd and wrap the table.
      const w = `w${Math.floor(rnd.uniform() * 3_000)}`;
      if (rnd.uniform() < 0.45 && model.has(w)) {
        v.release(model.get(w)!);
        model.delete(w);
      } else {
        const id = v.intern(w);
        if (model.has(w)) expect(id).toBe(model.get(w)!);
        model.set(w, id);
      }
      if (step % 4_000 === 0 || step === 39_999) {
        for (const [t, id] of model) {
          expect(v.lookup(t)).toBe(id);
          expect(v.term(id)).toBe(t);
        }
        expect(v.live).toBe(model.size);
        // Ids are reused: the capacity stays near the most terms ever held at once, not the terms ever seen.
        expect(v.size).toBeLessThanOrEqual(3_000);
      }
    }
    for (let i = 0; i < 3_000; i++) if (!model.has(`w${i}`)) expect(v.lookup(`w${i}`)).toBe(-1);
  });
});
