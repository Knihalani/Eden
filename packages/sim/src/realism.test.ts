import { describe, expect, test } from "bun:test";
import { RARE_SOURCE_IDS } from "./rare-sources";
import { addRealism, REALISM_IDS } from "./realism";
import { IDEAL, profileFor, REALISTIC } from "./sources";
import { buildWorld } from "./world";
import { preparedWorld, setRealism, SUITES } from "./lab/suites";

describe("realism (F8, D1103): a heavy real user's sources", () => {
  test("twenty connectors, ~600 items that never apply, deterministic and idempotent", () => {
    const a = buildWorld({ seed: 41_000 });
    const b = buildWorld({ seed: 41_000 });
    const added = addRealism(a, 41);
    expect(addRealism(b, 41).map((it) => [it.id, it.title, it.text])).toEqual(
      added.map((it) => [it.id, it.title, it.text]),
    );
    expect(addRealism(a, 41)).toEqual([]);
    expect(Object.keys(a.sources).length).toBe(20);
    for (const id of [...REALISM_IDS, ...RARE_SOURCE_IDS]) expect(id in a.sources).toBe(true);
    expect(added.length).toBe(600);
    expect(added.every((it) => it.noise && it.facts.length === 0 && it.updatedAt < a.now)).toBe(true);
    // Rule-worded, other languages and copies of the world's own threads, each present.
    const text = added.map((it) => `${it.title}\n${it.text}`).join("\n");
    for (const w of ["Offer valid until", "Terms:", "cancelled", "Oferta válida", "Wartungsfenster", "Forwarded"])
      expect(text.includes(w)).toBe(true);
    // Refs of the base world's shape and unique ids.
    expect(new Set(a.items.map((it) => it.id)).size).toBe(a.items.length);
    expect(added.every((it) => /^[a-z]+-\d+$/.test(it.ref))).toBe(true);
  });

  test("every connector has a profile; prepareWorld adds the same items to every suite's world", () => {
    for (const id of [...REALISM_IDS, ...RARE_SOURCE_IDS]) {
      expect(profileFor(REALISTIC, id)).toBeDefined();
      expect(profileFor(IDEAL, id)).toBeDefined();
    }
    setRealism("heavy");
    try {
      const of = (suite: string) => preparedWorld(suite, 42).items.map((it) => `${it.id}|${it.title}`);
      const train = of("train1");
      expect(of("dev20a")).toEqual(train);
      expect(of("longtail")).toEqual(train);
      const world = preparedWorld("train1", 42);
      const n = world.items.length;
      expect(SUITES.train1!(world, 42, "hidden").length).toBeGreaterThan(0);
      expect(world.items.length).toBeGreaterThan(n);
    } finally {
      setRealism("off");
    }
    expect(preparedWorld("train1", 42).items.length).toBeLessThan(1_800);
    expect(() => setRealism("extreme")).toThrow(/off or heavy/);
  });
});
