/**
 * The packed glossary (D1710) against the version 1 reader it replaced: the same glossary, rebuilt from the shipped
 * file into version 1's JSON (checked against the hash of the JSON version 1 shipped), glossed by both on every glossed
 * word, function word and English word, and on fuzzed requests in its 26 languages (10,000 here, 50,000 with
 * `GLOSS_FUZZ=50000`); then corrupt, truncated and
 * crafted files, which must read as no glossary (or gloss nothing), never throw, read out of bounds or allocate by a
 * count they claim.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGLISH, fuzzCorpus, rng, sweepCorpus } from "../bench/gloss-corpus";
import {
  type Glossary,
  glossEntries,
  glossOf,
  glossWords,
  languagesOf,
  loadGlossary,
  packGlossary,
  readGlossary,
  warmGlossary,
} from "./gloss";
import { isStopword } from "./text";

// ---- Version 1, as gloss.ts read it before D1710 (commit eaaa784d9), kept here as the reference. ----

interface V1Lang {
  fn: Set<string>;
  tsv: string;
  starts?: Uint32Array;
}
interface V1 {
  langs: Map<string, V1Lang>;
  english: Set<string>;
}
const V1_COMPOUNDING = new Set(["de", "nl", "sv", "da", "no"]);
const V1_LINKS = ["", "s", "e", "en", "n", "er"];

function v1Load(packed: { langs: Record<string, { fn: string[]; tsv: string }> }): V1 {
  const langs = new Map<string, V1Lang>();
  const english = new Set<string>();
  for (const [code, l] of Object.entries(packed.langs)) {
    langs.set(code, { fn: new Set(l.fn), tsv: l.tsv });
    for (const m of l.tsv.matchAll(/\t([^\n]*)/g)) for (const e of m[1]!.split(" ")) if (e) english.add(e);
  }
  return { langs, english };
}

function v1Lookup(l: V1Lang, w: string): string {
  if (!l.starts) {
    const at = [0];
    for (let i = l.tsv.indexOf("\n"); i >= 0; i = l.tsv.indexOf("\n", i + 1)) at.push(i + 1);
    l.starts = Uint32Array.from(at);
  }
  const { tsv, starts } = l;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const start = starts[mid]!;
    const tab = tsv.indexOf("\t", start);
    const key = tsv.slice(start, tab);
    if (key === w) {
      const end = tsv.indexOf("\n", tab);
      return tsv.slice(tab + 1, end < 0 ? tsv.length : end);
    }
    if (key < w) lo = mid + 1;
    else hi = mid - 1;
  }
  return "";
}

const isCapital = (w: string) => w !== w.toLowerCase();

function v1Telling(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (i > 0 && isCapital(w)) continue;
    if (i > 0 && i + 1 < words.length && isCapital(words[i + 1]!)) continue;
    out.push(w.toLowerCase());
  }
  return out;
}

function v1LanguagesOf(words: readonly string[], g: V1): string[] {
  const told = v1Telling(words);
  let best = 0;
  let out: string[] = [];
  for (const [code, l] of g.langs) {
    if (!told.some((w) => l.fn.has(w) && !isStopword(w))) continue;
    let mine = 0;
    let english = 0;
    for (const w of told) {
      const known = l.fn.has(w) || v1Lookup(l, w) !== "";
      const en = isStopword(w) || g.english.has(w);
      if (known && !en) mine++;
      else if (en && !known) english++;
    }
    if (mine < 2 || mine <= english || mine < best) continue;
    if (mine > best) out = [];
    best = mine;
    out.push(code);
  }
  return out;
}

function v1Compound(w: string, l: V1Lang): string {
  for (let i = w.length - 3; i >= 3; i--) {
    const tail = v1Lookup(l, w.slice(i));
    if (!tail) continue;
    for (const link of V1_LINKS) {
      const head = w.slice(0, i);
      if (!head.endsWith(link) || head.length - link.length < 3) continue;
      const h = v1Lookup(l, head.slice(0, head.length - link.length));
      if (h) return `${h} ${tail}`;
    }
  }
  return "";
}

function v1GlossOf(text: string, g: V1): string {
  const words =
    text
      .slice(0, 400)
      .normalize("NFC")
      .match(/\p{L}+/gu) ?? [];
  const codes = v1LanguagesOf(words, g);
  if (codes.length === 0) return "";
  const out: string[] = [];
  for (const raw of words) {
    const w = raw.toLowerCase();
    for (const code of codes) {
      const l = g.langs.get(code)!;
      if (l.fn.has(w)) continue;
      const e = v1Lookup(l, w) || (V1_COMPOUNDING.has(code) && w.length >= 7 ? v1Compound(w, l) : "");
      for (const x of e.split(" ")) if (x && !out.includes(x)) out.push(x);
    }
    if (out.length >= 12) break;
  }
  return out.slice(0, 12).join(" ");
}

// ---- The shipped glossary, both ways. ----

/** sha256 of the version 1 `gloss.bin`'s JSON as shipped before D1710 (gunzipped, 1,836,821 characters). */
const V1_JSON_SHA256 = "9dce2046f3df41151ce568bee9a025aee27bc69fb46ebdc4acc98274ec746208";

const shipped = warmGlossary()!;
const v1Json = JSON.stringify({
  v: 1,
  langs: Object.fromEntries(
    [...shipped.langs].map(([code, l]) => [
      code,
      {
        fn: [...l.fn],
        tsv: glossEntries(shipped, code)
          .map(([w, e]) => `${w}\t${e}`)
          .join("\n"),
      },
    ]),
  ),
});
const v1 = v1Load(JSON.parse(v1Json));
const words = glossWords(shipped);

describe("the packed glossary against version 1", () => {
  test("the shipped file holds exactly version 1's glossary", () => {
    expect(createHash("sha256").update(v1Json).digest("hex")).toBe(V1_JSON_SHA256);
    expect(shipped.langs.size).toBe(26);
    expect(words.langs.reduce((s, l) => s + l.keys.length, 0)).toBe(86_441);
  });

  test("the same gloss for every glossed word, function word and English word", () => {
    const sweep = sweepCorpus(words.langs, words.english);
    let differ = 0;
    let glossed = 0;
    for (const text of sweep) {
      const got = glossOf(text, shipped);
      if (got !== v1GlossOf(text, v1)) differ++;
      if (got) glossed++;
    }
    expect(differ).toBe(0);
    // The sweep reaches the lexicons: most of its requests are read as their language and glossed.
    expect(glossed).toBeGreaterThan(sweep.length / 2);
  });

  // 10,000 by default (about 2 s); `GLOSS_FUZZ=50000` runs D1710's full set (0 differences there).
  const FUZZ = Number(process.env.GLOSS_FUZZ ?? 10_000);
  test(`the same gloss and languages on ${FUZZ} fuzzed requests in the 26 languages, and on English`, () => {
    const corpus = [...fuzzCorpus(words.langs, words.english, FUZZ), ...ENGLISH];
    const differ: string[] = [];
    let glossed = 0;
    for (const text of corpus) {
      const got = glossOf(text, shipped);
      if (got !== v1GlossOf(text, v1)) differ.push(text);
      if (got) glossed++;
      const ws =
        text
          .slice(0, 400)
          .normalize("NFC")
          .match(/\p{L}+/gu) ?? [];
      if (languagesOf(ws, shipped).join() !== v1LanguagesOf(ws, v1).join()) differ.push(text);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    // The fuzz reads as its language most of the time (9,030 of the first 10,000 are glossed).
    expect(glossed).toBeGreaterThan(FUZZ * 0.8);
  }, 60_000);
});

// ---- Corrupt, truncated and crafted files. ----

const small = packGlossary([
  {
    code: "it",
    fn: ["voglio", "dai", "al", "il"],
    glosses: [
      ["conto", "account"],
      ["spostare", "move shift"],
    ],
  },
  {
    code: "nl",
    fn: ["ik", "een", "naar", "wil"],
    glosses: [
      ["rekening", "bill account"],
      ["telefoon", "phone"],
    ],
  },
  {
    code: "ü",
    fn: ["ß"],
    glosses: [
      ["日本", "japan"],
      ["𐐨𐐩", "smile"],
    ],
  },
]);
const ITALIAN = "Voglio spostare il conto";
const tmp = mkdtempSync(join(tmpdir(), "gloss-packed-"));
let files = 0;
const write = (bytes: Uint8Array) => {
  const f = join(tmp, `g${files++}.bin`);
  writeFileSync(f, bytes);
  return f;
};
/** Never throws and gives a string, whatever the glossary. */
const safe = (g: Glossary | null) => {
  for (const t of [ITALIAN, "Ik wil een telefoonrekening", "ß 日本 𐐨𐐩 ß", ...ENGLISH.slice(0, 2)]) {
    expect(typeof glossOf(t, g)).toBe("string");
  }
};

describe("readGlossary and loadGlossary on bad bytes", () => {
  test("the small file reads, from memory and from disk, on an unaligned view too", () => {
    expect(glossOf(ITALIAN, readGlossary(small))).toBe("move shift account");
    expect(glossOf(ITALIAN, loadGlossary(write(small)))).toBe("move shift account");
    const odd = new Uint8Array(small.length + 1);
    odd.set(small, 1);
    expect(glossOf(ITALIAN, readGlossary(odd.subarray(1)))).toBe("move shift account");
    // A word outside the BMP and one in CJK are found by their UTF-8 bytes.
    expect(glossOf("ß ß 日本 𐐨𐐩", readGlossary(small))).toBe("japan smile");
  });

  test("every truncation reads as no glossary", () => {
    for (let n = 0; n < small.length; n++) {
      expect(readGlossary(small.subarray(0, n))).toBeNull();
      if (n % 7 === 0) expect(loadGlossary(write(small.subarray(0, n)))).toBeNull();
    }
  });

  test("a version 1 file, an empty file and no file read as no glossary", () => {
    expect(loadGlossary(write(Bun.gzipSync(JSON.stringify({ v: 1, langs: {} }))))).toBeNull();
    expect(loadGlossary(write(new Uint8Array(0)))).toBeNull();
    expect(loadGlossary(join(tmp, "absent.bin"))).toBeNull();
  });

  test("crafted counts, offsets and pointers are refused before anything is made from them", () => {
    const at = (bytes: Buffer, word: number, value: number) => {
      const b = Buffer.from(bytes);
      b.writeUInt32LE(value >>> 0, word * 4);
      return b;
    };
    const codes = small.readUInt32LE(20);
    const english = small.readUInt32LE(24);
    const itKeys = small.readUInt32LE(28 + 4);
    const crafted = [
      at(small, 0, 0x4c474446), // magic
      at(small, 1, 3), // version
      at(small, 2, small.length + 4), // length
      at(small, 3, 0xffffffff), // language count
      at(small, 3, 2), // count against the codes table's
      at(small, 4, small.length + 8), // lexicons past the end
      at(small, 4, 4), // lexicons inside the header
      at(small, 5, small.length - 4), // codes table past the prefix
      at(small, 5, 22), // misaligned codes table
      at(small, codes / 4, 0xffffffff), // codes count: 16 GB of offsets claimed
      at(small, codes / 4 + 1, 4), // first offset not 0
      at(small, english / 4 + 2, 0xffffff), // an English offset past the arena
      at(small, 6, codes), // English table inside the prefix
      at(small, 8, english), // keys table: the English one (counts differ from the glosses')
      at(small, itKeys / 4 + 2, 100), // offsets running backwards
    ];
    for (const b of crafted) {
      const t = performance.now();
      expect(readGlossary(b)).toBeNull();
      expect(performance.now() - t).toBeLessThan(50);
    }
  });

  test("keys out of order, or repeated, read as no glossary (the binary search relies on order)", () => {
    const swapped = Buffer.from(small);
    // "conto" and "spostare" are the Italian keys: swap their first letters, so "sonto" sorts after "cpostare".
    const it = swapped.indexOf("contospostare");
    swapped[it] = 0x73;
    swapped[it + 5] = 0x63;
    expect(readGlossary(swapped)).toBeNull();
    const dup = Buffer.from(small);
    dup.write("rekening", dup.indexOf("telefoon"));
    expect(readGlossary(dup)).toBeNull();
    expect(() =>
      packGlossary([
        {
          code: "x",
          fn: [],
          glosses: [
            ["a", "b"],
            ["a", "c"],
          ],
        },
      ]),
    ).toThrow();
  });

  test("2,000 random corruptions: no glossary, or one that glosses without throwing", () => {
    const r = rng(17);
    let refused = 0;
    for (let i = 0; i < 2_000; i++) {
      const b = Buffer.from(small);
      const flips = 1 + Math.floor(r() * 4);
      for (let k = 0; k < flips; k++) {
        const p = Math.floor(r() * b.length);
        b[p] = r() < 0.5 ? b[p]! ^ (1 << Math.floor(r() * 8)) : Math.floor(r() * 256);
      }
      const g = readGlossary(b);
      if (!g) refused++;
      safe(g);
    }
    // Most flips land in counts, offsets, pointers or key order; a flip in an arena may read on.
    expect(refused).toBeGreaterThan(200);
  });

  test("lexicons that read wrong, or a file replaced or cut after the prefix was read, gloss nothing", () => {
    // The prefix is valid and the lexicons are not: the load succeeds, the first request that needs them fails open.
    const badLex = Buffer.from(small);
    badLex.writeUInt32LE(0xffffffff, small.readUInt32LE(24));
    const g = loadGlossary(write(badLex))!;
    expect(g).not.toBeNull();
    expect(glossOf(ENGLISH[0]!, g)).toBe("");
    expect(glossOf(ITALIAN, g)).toBe("");
    expect(glossOf(ITALIAN, g)).toBe("");

    const f = write(small);
    const replaced = loadGlossary(f)!;
    writeFileSync(f, packGlossary([{ code: "it", fn: ["voglio", "il"], glosses: [["conto", "bill"]] }]));
    expect(glossOf(ITALIAN, replaced)).toBe("");

    const g2 = write(small);
    const cut = loadGlossary(g2)!;
    truncateSync(g2, small.length - 8);
    expect(glossOf(ITALIAN, cut)).toBe("");

    // Grown past the length its header gave: refused by its size, not read in.
    const g3 = write(small);
    const grown = loadGlossary(g3)!;
    appendFileSync(g3, new Uint8Array(1 << 20));
    expect(glossOf(ITALIAN, grown)).toBe("");
  });

  test("an English request never reads the lexicons", () => {
    const g = loadGlossary(write(small))!;
    for (const t of ENGLISH) expect(glossOf(t, g)).toBe("");
    expect(g.lex).toBeUndefined();
    expect(glossOf(ITALIAN, g)).toBe("move shift account");
    expect(g.lex).not.toBeNull();
  });
});
