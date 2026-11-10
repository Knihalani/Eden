/**
 * `TermSketch` with four probes (`sourceYieldEarn`, D600; the review of O1): `Sync.sketchRare` asks which few of a
 * user's thousand sketches hold a word, so the sketches' false matches must be rare across all of them.
 */
import { describe, expect, test } from "bun:test";
import { TermSketch, termHashes } from "./sketch";

/** `sources` sketches of `terms` words each, every word its source's own. */
function sketches(probes: 2 | 4, sources: number, terms: number): TermSketch[] {
  return Array.from({ length: sources }, (_, k) => {
    const s = new TermSketch(probes);
    for (let i = 0; i < terms; i++) s.add(...termHashes(`w${k}x${i}`));
    s.fold();
    return s;
  });
}
const holders = (all: TermSketch[], term: string) => {
  const [a, b] = termHashes(term);
  return all.filter((s) => s.has(a, b)).length;
};

describe("TermSketch probes", () => {
  test("four probes: a word one of 1,000 sources holds is held by at most two sketches, nearly always", () => {
    for (const terms of [50, 300, 1_000]) {
      const all = sketches(4, 1_000, terms);
      let rare = 0;
      for (let k = 0; k < 200; k++) if (holders(all, `w${k}x7`) <= 2) rare++;
      expect(rare).toBeGreaterThanOrEqual(190);
    }
  });

  test("two probes (the default) cannot say so at that size: what the four are for", () => {
    const all = sketches(2, 1_000, 300);
    let rare = 0;
    for (let k = 0; k < 200; k++) if (holders(all, `w${k}x7`) <= 2) rare++;
    expect(rare).toBeLessThan(20);
  });

  test("a term added is always held, folded or not, and a dump loads only with its own number of probes", () => {
    for (const probes of [2, 4] as const) {
      const s = new TermSketch(probes);
      for (let i = 0; i < 400; i++) s.add(...termHashes(`t${i}`));
      s.fold();
      for (let i = 0; i < 400; i++) expect(s.has(...termHashes(`t${i}`))).toBe(true);
      const back = TermSketch.load(JSON.parse(JSON.stringify(s.dump())), probes);
      expect(back?.has(...termHashes("t7"))).toBe(true);
      expect(TermSketch.load(s.dump(), probes === 2 ? 4 : 2)).toBeNull();
    }
    // The default's dump is what it always was: no `probes` key.
    expect(Object.keys(new TermSketch().dump()).sort()).toEqual(["bits", "set"]);
  });

  test("full: says when one more term would restart the sketch", () => {
    const s = new TermSketch(4);
    expect(s.full).toBe(false);
    for (let i = 0; i < 20_000 && !s.full; i++) s.add(...termHashes(`t${i}`));
    expect(s.full).toBe(true);
  });
});
