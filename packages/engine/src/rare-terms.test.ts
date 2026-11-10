/**
 * `RareTerms` (`sourceYieldEarn`, D600): one table a user of which few sources hold a word, in place of a wider
 * sketch per source (docs/research/o1-earn.md §2c).
 */
import { describe, expect, test } from "bun:test";
import { MAX_SEGMENTS, RareTerms } from "./rare-terms";
import { termHashes } from "./sketch";

const h = (word: string) => termHashes(word);

describe("RareTerms", () => {
  test("names the one or two sources that hold a word, and none for a word three hold or none holds", () => {
    const t = new RareTerms();
    t.add("mail", ...h("vitalis"));
    t.add("docs", ...h("globex"));
    t.add("crm", ...h("globex"));
    for (const s of ["mail", "docs", "crm"]) t.add(s, ...h("invoice"));
    expect(t.holders(...h("vitalis"), 2)).toEqual(["mail"]);
    expect(t.holders(...h("globex"), 2).sort()).toEqual(["crm", "docs"]);
    // Two hold it: more than one.
    expect(t.holders(...h("globex"), 1)).toEqual([]);
    expect(t.holders(...h("invoice"), 2)).toEqual([]);
    expect(t.holders(...h("unseen"), 2)).toEqual([]);
    // A fourth source, or the same source again, changes nothing.
    t.add("chat", ...h("invoice"));
    t.add("mail", ...h("vitalis"));
    expect(t.holders(...h("invoice"), 2)).toEqual([]);
    expect(t.holders(...h("vitalis"), 2)).toEqual(["mail"]);
  });

  test("1,000 sources of 150 words of their own: each word names its source, an unseen word names none", () => {
    const t = new RareTerms();
    for (let k = 0; k < 1_000; k++) for (let i = 0; i < 150; i++) t.add(`s${k}`, ...h(`w${k}x${i}`));
    expect(t.dropped).toBe(0);
    // Four bytes a word and at most a segment (16 KB) of slack a growth step.
    expect(t.bytes).toBeLessThan(150_000 * 4 * 1.25);
    let right = 0;
    let wrong = 0;
    for (let k = 0; k < 500; k++) {
      const got = t.holders(...h(`w${k}x7`), 2);
      if (got.length === 1 && got[0] === `s${k}`) right++;
      wrong += t.holders(...h(`unseen-${k}`), 2).length;
    }
    expect(right).toBeGreaterThanOrEqual(495);
    expect(wrong).toBeLessThanOrEqual(2);
  });

  test("bounded: past its last segment a word is not added, and the table stays at 1 MB", () => {
    const t = new RareTerms();
    for (let i = 0; i < 400_000; i++) t.add(`s${i % 50}`, ...h(`w${i}`));
    expect(t.bytes).toBeLessThanOrEqual(1 << 20);
    expect(t.dropped).toBeGreaterThan(0);
    // A handful of words meet another's tag in their reach and read as that word (a false holder at worst).
    expect(t.size + t.dropped).toBeGreaterThan(399_900);
    // What was added first is still read.
    expect(t.holders(...h("w7"), 2)).toEqual(["s7"]);
    expect(MAX_SEGMENTS).toBe(67);
  });

  test("a small user's table is small", () => {
    const t = new RareTerms();
    for (let k = 0; k < 5; k++) for (let i = 0; i < 100; i++) t.add(`s${k}`, ...h(`w${k}x${i}`));
    expect(t.bytes).toBeLessThanOrEqual(4_096);
  });

  test("dump and load keep every answer; a wrong shape loads as nothing", () => {
    const t = new RareTerms();
    for (let k = 0; k < 40; k++) for (let i = 0; i < 300; i++) t.add(`s${k}`, ...h(`w${k}x${i}`));
    t.add("s1", ...h("w0x0"));
    const back = RareTerms.load(JSON.parse(JSON.stringify(t.dump())))!;
    expect(back.size).toBe(t.size);
    expect(back.bytes).toBe(t.bytes);
    for (let k = 0; k < 40; k++) expect(back.holders(...h(`w${k}x9`), 2)).toEqual([`s${k}`]);
    expect(back.holders(...h("w0x0"), 2).sort()).toEqual(["s0", "s1"]);
    // It goes on taking words, with the same source numbers.
    back.add("s2", ...h("later"));
    expect(back.holders(...h("later"), 2)).toEqual(["s2"]);
    expect(RareTerms.load(null)).toBeNull();
    expect(RareTerms.load({ ids: ["a"], segments: ["AAAA"] })).toBeNull();
    expect(RareTerms.load({ ids: [1], segments: [] })).toBeNull();
  });
});
