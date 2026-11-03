import { describe, expect, test } from "bun:test";
import { Ledger } from "./ledger";

describe("Ledger", () => {
  test("an item is not fresh within its cooldown, and is after it", () => {
    const l = new Ledger(3);
    l.mark(["a"], 1);
    expect(l.isFresh("a", 2)).toBe(false);
    expect(l.isFresh("a", 4)).toBe(true);
  });

  test("revised: delivered within the cooldown with other words, never without a recorded version", () => {
    const l = new Ledger(3);
    l.mark(["a", "b"], 1, [10, 20]);
    l.mark(["c"], 1);
    expect(l.revised("a", 10, 2)).toBe(false);
    expect(l.revised("a", 11, 2)).toBe(true);
    expect(l.revised("c", 99, 2)).toBe(false);
    expect(l.revised("z", 1, 2)).toBe(false);
    // Past the cooldown it is fresh anyway: not a revision.
    expect(l.revised("a", 11, 4)).toBe(false);
    // Marked again without versions: the old version no longer counts.
    l.mark(["b"], 2);
    expect(l.revised("b", 21, 3)).toBe(false);
  });

  test("versions are dropped with their entries, so a long session stays bounded", () => {
    const l = new Ledger(2);
    for (let t = 0; t < 100; t++) l.mark([`i${t}`], t, [t]);
    expect(l.size).toBeLessThanOrEqual(2);
    expect((l as unknown as { versions: Map<string, number> }).versions.size).toBeLessThanOrEqual(2);
  });

  // `readerPushBehind` (audit 2026-11-03b): a withdrawn packet's marks are undone by restoring what each entry was,
  // not by forgetting it: an item the agent already held an older copy of keeps that delivery and its version.
  test("restore: an entry goes back to what it was, its version included, or away if there was none", () => {
    const l = new Ledger(10);
    l.mark(["a"], 1, [10]);
    const a = l.entry("a");
    const b = l.entry("b");
    expect(a).toEqual({ turn: 1, version: 10 });
    expect(b).toBeUndefined();
    l.mark(["a", "b"], 3, [11, 20]);
    l.restore("a", a);
    l.restore("b", b);
    expect(l.entry("a")).toEqual({ turn: 1, version: 10 });
    expect(l.isFresh("a", 4)).toBe(false);
    // The agent holds version 10: version 11 is still a revision to it.
    expect(l.revised("a", 11, 4)).toBe(true);
    expect(l.entry("b")).toBeUndefined();
    expect(l.isFresh("b", 4)).toBe(true);
    // A restored entry without a version keeps none.
    l.mark(["c"], 2);
    const c = l.entry("c");
    l.mark(["c"], 3, [5]);
    l.restore("c", c);
    expect(l.entry("c")).toEqual({ turn: 2 });
    expect(l.revised("c", 6, 4)).toBe(false);
  });

  test("restore keeps the ledger bounded: a restored old entry still expires", () => {
    const l = new Ledger(2);
    l.mark(["a"], 0, [1]);
    const a = l.entry("a");
    l.mark(["a"], 1, [2]);
    l.restore("a", a);
    for (let t = 2; t < 50; t++) l.mark([`i${t}`], t, [t]);
    expect(l.size).toBeLessThanOrEqual(2);
    expect(l.entry("a")).toBeUndefined();
  });
});
