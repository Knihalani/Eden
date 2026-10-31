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
});
