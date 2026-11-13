/**
 * The request glossary (`requestGloss`, in the default since D1153, part `gloss`; F1,
 * docs/research/f1-intent-bridge.md): a request written in another language is given the English words its own words
 * mean, with no model and no call, so the lexical search and the intent index (whose requests the card model writes in
 * English) can meet it.
 *
 * On heldout19 the non-English requests reached 0 of 16 planted facts in the funnel (h19-diagnosis.md): the card call
 * anticipated the right request ("move money out of the fixed saver") and the user wrote "spostare 5.000 sterline dai
 * risparmi". A word-for-word gloss ("move", "pound", "saving") is crude as translation and enough for retrieval, which
 * matches words, not sentences.
 *
 * `gloss.bin` (beside this file) holds, per language, its function words and its glossed words with up to three
 * English words each, written once in the lab by Haiku subagents and packed by `packages/sim/src/lab/gloss-pack.ts`
 * through `packGlossary`. A file that cannot be read, or reads wrong, leaves every request as written (fail open).
 *
 * Since D1710 the glossary is answered from the file's bytes (version 2, below), not from strings: each language's
 * glossed words are sorted UTF-8 keys searched by binary search, compared with the request's word code point by code
 * point (nothing is encoded or allocated for a miss), and a gloss is decoded only when found. Version 1 (gzip of JSON)
 * held 86,441 lines as strings and 8,749 English words in a Set, and its parse's garbage left a process +15.7 MB RSS.
 * The file is read in two parts: `warmGlossary` (when the partner is built) reads only the function words, which every
 * request needs to tell its language (about 48 KB of the file); the lexicons (the other 2.3 MB) are read the first
 * time a request passes a language's function-word test, so a process that only ever sees English never holds them.
 *
 * Layout (all integers u32 little-endian, every section 4-aligned):
 *   0 "EDGL", 4 version (2), 8 byte length, 12 language count L, 16 where the lexicons start (the prefix's end),
 *   20 codes table, 24 English table, 28 + 12 i: language i's function-word, key and gloss tables.
 * The codes and function-word tables lie before the lexicons' start; the English, key and gloss tables after it (a
 * gloss table has its key table's count). A table at T: count n, then n + 1 offsets into its arena (the first 0,
 * never decreasing), then the arena. Keys and English words are strictly increasing by bytes (checked when read: the
 * binary search relies on it).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isStopword } from "./text";

/** A string table over a glossary's bytes: entry i is `bytes[base + offs[i] .. base + offs[i + 1])`. */
interface Table {
  n: number;
  offs: Uint32Array;
  base: number;
}
interface Lang {
  /** Where the language is in the file's order, which is its index in the lexicons. */
  at: number;
  /** Function words: a Set, since every request (English ones too) reads them for each language. */
  fn: Set<string>;
}
/** The lexicons: every language's sorted keys and their glosses, and the English words the glosses use. */
interface Lexicon {
  bytes: Buffer;
  english: Table;
  keys: Table[];
  glosses: Table[];
}
/** A loaded glossary: its languages with their function words, and its lexicons, read on first need. */
export interface Glossary {
  langs: Map<string, Lang>;
  /** The lexicons once read; null when they could not be read or read wrong (nothing is glossed then). */
  lex?: Lexicon | null;
  readLex: () => Lexicon | null;
}

/** Characters of a request read: the head says what it asks, and the gloss stays bounded. */
const GLOSS_CHARS = 400;
/**
 * English words a gloss gives at most. They are searched ahead of the request's own words (the cue keeps 16 terms),
 * and the request's names reach the search as entities whatever the gloss holds.
 */
export const MAX_GLOSS_WORDS = 12;
/** Words of one language a request must hold, past the English ones, to be read as that language. */
const MIN_HITS = 2;
/** Languages that write compounds as one word: an unknown word may be two known ones ("telefoon|rekening"). */
const COMPOUNDING = new Set(["de", "nl", "sv", "da", "no"]);
const LINKS = ["", "s", "e", "en", "n", "er"];

const MAGIC = 0x4c474445; // "EDGL" read as a little-endian u32
const VERSION = 2;
const HEADER = 28;
/** More languages than any glossary will hold: a count past it is a corrupt file, not a big one. */
const MAX_LANGS = 1_024;
/** Larger than the glossary will grow (2.4 MB in 2026-11): a length past it is a corrupt file, never allocated. */
const MAX_BYTES = 64 * 2 ** 20;

let loaded: Glossary | null | undefined;

/** One language as the lab's packer gives it: function words, and each glossed word with its English. */
export interface GlossLang {
  code: string;
  fn: readonly string[];
  glosses: ReadonlyMap<string, string> | readonly (readonly [string, string])[];
}

const utf8 = (s: string) => Buffer.from(s, "utf8");
const pad4 = (n: number) => (n + 3) & ~3;

/** A table's bytes: count, offsets, arena, padded to 4. */
function tableBytes(items: readonly Buffer[]): Buffer {
  const out = Buffer.alloc(pad4(4 + 4 * (items.length + 1) + items.reduce((s, b) => s + b.length, 0)));
  out.writeUInt32LE(items.length, 0);
  let at = 0;
  let p = 4 + 4 * (items.length + 1);
  items.forEach((b, i) => {
    out.writeUInt32LE(at, 4 + 4 * i);
    b.copy(out, p);
    p += b.length;
    at += b.length;
  });
  out.writeUInt32LE(at, 4 + 4 * items.length);
  return out;
}

/**
 * The packed glossary (version 2) for `langs`, in their order (the order tied languages are glossed in). Keys are
 * sorted by their UTF-8 bytes; a key given twice throws. The English table is every word of every gloss, split on
 * spaces.
 */
export function packGlossary(langs: readonly GlossLang[]): Buffer {
  const english = new Set<string>();
  const fns: Buffer[] = [];
  const lexicons: Buffer[] = [];
  for (const l of langs) {
    const entries = [...l.glosses].map(([w, e]) => [utf8(w), utf8(e)] as const);
    entries.sort((a, b) => Buffer.compare(a[0], b[0]));
    for (let i = 1; i < entries.length; i++)
      if (Buffer.compare(entries[i - 1]![0], entries[i]![0]) === 0) throw new Error(`gloss: ${l.code} repeats a key`);
    for (const [, e] of entries) for (const x of e.toString("utf8").split(" ")) if (x) english.add(x);
    fns.push(tableBytes(l.fn.map(utf8)));
    lexicons.push(tableBytes(entries.map(([w]) => w)), tableBytes(entries.map(([, e]) => e)));
  }
  const codes = tableBytes(langs.map((l) => utf8(l.code)));
  const en = tableBytes([...english].map(utf8).sort(Buffer.compare));
  const head = Buffer.alloc(HEADER + 12 * langs.length);
  // The prefix (header, codes, function words) first, then the lexicons.
  let at = head.length;
  const place = (t: Buffer) => {
    const w = at;
    at += t.length;
    return w;
  };
  head.writeUInt32LE(place(codes), 20);
  fns.forEach((t, i) => head.writeUInt32LE(place(t), HEADER + 12 * i));
  const lexStart = at;
  head.writeUInt32LE(place(en), 24);
  lexicons.forEach((t, j) => head.writeUInt32LE(place(t), HEADER + 12 * (j >> 1) + 4 + 4 * (j & 1)));
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(VERSION, 4);
  head.writeUInt32LE(at, 8);
  head.writeUInt32LE(langs.length, 12);
  head.writeUInt32LE(lexStart, 16);
  return Buffer.concat([head, codes, ...fns, en, ...lexicons]);
}

/** A Buffer over `raw` whose start is 4-aligned (copied when it is not), and its u32 words. */
function aligned(raw: Uint8Array): { bytes: Buffer; words: Uint32Array } {
  const bytes = raw.byteOffset % 4 === 0 ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.from(raw);
  return { bytes, words: new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >>> 2) };
}

/**
 * The table at `at`, or null unless all of it lies within `[lo, hi)` (and within `words`) and its offsets never run
 * backwards. The count is bounded by the room left before anything is made from it.
 */
function tableAt(words: Uint32Array, at: number, lo: number, hi: number): Table | null {
  if (at % 4 !== 0 || at < lo || at + 4 > hi || hi > words.length * 4) return null;
  const n = words[at >>> 2]!;
  if (n > (hi - at - 4) / 4 - 1) return null;
  const offs = words.subarray((at >>> 2) + 1, (at >>> 2) + 2 + n);
  const base = at + 4 + 4 * (n + 1);
  if (offs[0] !== 0) return null;
  for (let i = 0; i < n; i++) if (offs[i + 1]! < offs[i]!) return null;
  if (base + offs[n]! > hi) return null;
  return { n, offs, base };
}

/** Whether every entry of `t` sorts strictly after the one before it, by bytes. */
function ascending(b: Buffer, t: Table): boolean {
  for (let i = 1; i < t.n; i++) {
    let p = t.base + t.offs[i - 1]!;
    const pe = t.base + t.offs[i]!;
    let q = pe;
    const qe = t.base + t.offs[i + 1]!;
    while (p < pe && q < qe && b[p] === b[q]) {
      p++;
      q++;
    }
    // Strictly after: the previous entry differs with a smaller byte, or is a proper prefix of this one.
    if (p < pe ? q >= qe || b[p]! > b[q]! : q >= qe) return false;
  }
  return true;
}

const entry = (b: Buffer, t: Table, i: number) => b.toString("utf8", t.base + t.offs[i]!, t.base + t.offs[i + 1]!);

/** The header's fields, or null when the first bytes are not a version 2 glossary of a sane size. */
function header(words: Uint32Array): { length: number; count: number; lexStart: number } | null {
  if (words.length < HEADER / 4 || words[0] !== MAGIC || words[1] !== VERSION) return null;
  const [length, count, lexStart] = [words[2]!, words[3]!, words[4]!];
  if (length > MAX_BYTES || length % 4 !== 0 || count > MAX_LANGS) return null;
  if (lexStart < HEADER + 12 * count || lexStart > length || lexStart % 4 !== 0) return null;
  return { length, count, lexStart };
}

/** The languages and their function words from the prefix (`words` holds at least `lexStart` bytes), or null. */
function readPrefix(raw: Uint8Array): { langs: Map<string, Lang>; length: number; lexStart: number } | null {
  const { bytes, words } = aligned(raw);
  const h = header(words);
  if (!h || bytes.length < h.lexStart) return null;
  const codes = tableAt(words, words[5]!, HEADER, h.lexStart);
  if (!codes || codes.n !== h.count) return null;
  const langs = new Map<string, Lang>();
  for (let i = 0; i < h.count; i++) {
    const fn = tableAt(words, words[(HEADER >>> 2) + 3 * i]!, HEADER, h.lexStart);
    const code = entry(bytes, codes, i);
    if (!fn || langs.has(code)) return null;
    langs.set(code, { at: i, fn: new Set(Array.from({ length: fn.n }, (_, j) => entry(bytes, fn, j))) });
  }
  return { langs, length: h.length, lexStart: h.lexStart };
}

/** The lexicons of a whole file's `raw` bytes, or null when any table is out of place, out of bounds or unsorted. */
function readLexicon(raw: Uint8Array, count: number): Lexicon | null {
  const { bytes, words } = aligned(raw);
  const h = header(words);
  if (!h || h.length !== bytes.length || h.count !== count) return null;
  const table = (at: number) => tableAt(words, at, h.lexStart, h.length);
  const english = table(words[6]!);
  if (!english || !ascending(bytes, english)) return null;
  const keys: Table[] = [];
  const glosses: Table[] = [];
  for (let i = 0; i < count; i++) {
    const k = table(words[(HEADER >>> 2) + 3 * i + 1]!);
    const g = table(words[(HEADER >>> 2) + 3 * i + 2]!);
    if (!k || !g || g.n !== k.n || !ascending(bytes, k)) return null;
    keys.push(k);
    glosses.push(g);
  }
  return { bytes, english, keys, glosses };
}

const guarded =
  <A extends unknown[], R>(f: (...a: A) => R | null) =>
  (...a: A): R | null => {
    try {
      return f(...a);
    } catch {
      return null;
    }
  };

/**
 * The glossary in packed `raw` bytes, read whole now, or null when they are not one: every offset, count and length is
 * checked against the bytes before it is read, and keys must be strictly increasing, so a corrupt or crafted file is
 * refused whole, never read past its end.
 */
export const readGlossary = guarded((raw: Uint8Array): Glossary | null => {
  const p = readPrefix(raw);
  const lex = p ? readLexicon(raw, p.langs.size) : null;
  return p && lex ? { langs: p.langs, lex, readLex: () => lex } : null;
});

/** Fills `buf` from the start of the file: false at an early end (a read may return less than asked). */
function readExactly(fd: number, buf: Buffer): boolean {
  let at = 0;
  while (at < buf.length) {
    const n = readSync(fd, buf, at, buf.length - at, at);
    if (n <= 0) return false;
    at += n;
  }
  return true;
}

/**
 * The glossary in `file`: its prefix read now (null when it cannot be read or is not one), its lexicons the first
 * time a request needs them. That later read must find the same prefix (a file replaced in between reads wrong) and
 * a whole, valid file, or nothing is glossed for the rest of the process (fail open).
 */
export const loadGlossary = guarded((file: string | URL): Glossary | null => {
  const fd = openSync(file, "r");
  let prefix: Buffer;
  try {
    const head = Buffer.alloc(HEADER);
    if (!readExactly(fd, head)) return null;
    const h = header(aligned(head).words);
    if (!h || fstatSync(fd).size !== h.length) return null;
    prefix = Buffer.alloc(h.lexStart);
    if (!readExactly(fd, prefix)) return null;
  } finally {
    closeSync(fd);
  }
  const p = readPrefix(prefix);
  if (!p) return null;
  const readLex = guarded((): Lexicon | null => {
    // Exactly the length the prefix's header gave, never what the file has grown to since: a file replaced by a
    // larger one is refused by its size, not read into memory.
    const fd = openSync(file, "r");
    try {
      if (fstatSync(fd).size !== p.length) return null;
      const whole = Buffer.alloc(p.length);
      if (!readExactly(fd, whole)) return null;
      if (!whole.subarray(0, p.lexStart).equals(prefix)) return null;
      return readLexicon(whole, p.langs.size);
    } finally {
      closeSync(fd);
    }
  });
  return { langs: p.langs, readLex };
});

/** Reads the shipped glossary's function words now (once a process), so a request does not wait for them. */
export function warmGlossary(): Glossary | null {
  if (loaded === undefined) loaded = loadGlossary(new URL("./gloss.bin", import.meta.url));
  return loaded;
}

/** The lexicons, read the first time they are needed. */
function lexicon(g: Glossary): Lexicon | null {
  if (g.lex === undefined) g.lex = g.readLex();
  return g.lex;
}

/**
 * The bytes at `[s, e)` against `w`'s UTF-8 (negative when the bytes sort first, 0 when equal), made one code point
 * at a time: a lookup encodes nothing and allocates nothing. A lone surrogate reads as U+FFFD, as `Buffer.from` writes
 * it; `\p{L}` never matches one.
 */
function cmpWord(b: Buffer, s: number, e: number, w: string): number {
  let p = s;
  for (let i = 0; i < w.length; i++) {
    let c = w.charCodeAt(i);
    if (c < 0x80) {
      if (p >= e) return -1;
      const d = b[p++]! - c;
      if (d !== 0) return d;
      continue;
    }
    if (c >= 0xd800 && c < 0xe000) {
      const lo = i + 1 < w.length ? w.charCodeAt(i + 1) : 0;
      if (c < 0xdc00 && lo >= 0xdc00 && lo < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      } else c = 0xfffd;
    }
    let n: number;
    let lead: number;
    if (c < 0x800) {
      n = 1;
      lead = 0xc0 | (c >> 6);
    } else if (c < 0x10000) {
      n = 2;
      lead = 0xe0 | (c >> 12);
    } else {
      n = 3;
      lead = 0xf0 | (c >> 18);
    }
    if (p >= e) return -1;
    let d = b[p++]! - lead;
    if (d !== 0) return d;
    for (let k = n - 1; k >= 0; k--) {
      if (p >= e) return -1;
      d = b[p++]! - (0x80 | ((c >> (6 * k)) & 0x3f));
      if (d !== 0) return d;
    }
  }
  return p < e ? 1 : 0;
}

/** Where `w` is in `t` (sorted by bytes), or -1. */
function find(b: Buffer, t: Table, w: string): number {
  let lo = 0;
  let hi = t.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const d = cmpWord(b, t.base + t.offs[mid]!, t.base + t.offs[mid + 1]!, w);
    if (d === 0) return mid;
    if (d < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** A word's English in language `at` ("" when it has none). */
function lookup(x: Lexicon, at: number, w: string): string {
  const i = find(x.bytes, x.keys[at]!, w);
  return i < 0 ? "" : entry(x.bytes, x.glosses[at]!, i);
}

const isCapital = (w: string) => w !== w.toLowerCase();

/**
 * The words that tell a request's language: lowercased, without the names. A capitalised word past the first, and a
 * word just before one ("van der Berg", "di Napoli", "la Gare"), is taken as part of a name: an English request about
 * Café du Monde or Pieter van den Heuvel is still English. German nouns are capitalised too; its other words decide.
 */
function telling(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (i > 0 && isCapital(w)) continue;
    if (i > 0 && i + 1 < words.length && isCapital(words[i + 1]!)) continue;
    out.push(w.toLowerCase());
  }
  return out;
}

/**
 * The languages a request is written in: a language counts the request's telling words it knows (a function word or a
 * glossed word) that are not English, English counts those it knows that the language does not; the language wins
 * with at least `MIN_HITS` and more than English. The most first; ties all kept (Spanish and Portuguese share many).
 * None when the lexicons are needed and cannot be read.
 */
export function languagesOf(words: readonly string[], g: Glossary): string[] {
  const told = telling(words);
  let best = 0;
  let out: string[] = [];
  for (const [code, l] of g.langs) {
    // A language none of whose function words the request holds is not it: set lookups first, so an English
    // request never searches (or reads) the lexicons.
    if (!told.some((w) => l.fn.has(w) && !isStopword(w))) continue;
    const x = lexicon(g);
    if (!x) return [];
    let mine = 0;
    let english = 0;
    for (const w of told) {
      const known = l.fn.has(w) || find(x.bytes, x.keys[l.at]!, w) >= 0;
      const en = isStopword(w) || find(x.bytes, x.english, w) >= 0;
      if (known && !en) mine++;
      else if (en && !known) english++;
    }
    if (mine < MIN_HITS || mine <= english || mine < best) continue;
    if (mine > best) out = [];
    best = mine;
    out.push(code);
  }
  return out;
}

/** A compound's English: two known words, with a linking letter or two between them; "" when none splits it. */
function compound(x: Lexicon, at: number, w: string): string {
  for (let i = w.length - 3; i >= 3; i--) {
    const tail = lookup(x, at, w.slice(i));
    if (!tail) continue;
    for (const link of LINKS) {
      const head = w.slice(0, i);
      if (!head.endsWith(link) || head.length - link.length < 3) continue;
      const h = lookup(x, at, head.slice(0, head.length - link.length));
      if (h) return `${h} ${tail}`;
    }
  }
  return "";
}

/**
 * The English words a request's words mean when it is written in a language the glossary holds, space-separated,
 * at most `MAX_GLOSS_WORDS`; "" for an English request, an unknown language or no glossary. Pure apart from the
 * one-time loads; no model, no call. Never throws: a glossary that reads wrong glosses nothing.
 */
export function glossOf(text: string, g: Glossary | null = warmGlossary()): string {
  if (!g || g.langs.size === 0) return "";
  try {
    const words =
      text
        .slice(0, GLOSS_CHARS)
        .normalize("NFC")
        .match(/\p{L}+/gu) ?? [];
    const codes = languagesOf(words, g);
    const x = codes.length === 0 ? null : lexicon(g);
    if (!x) return "";
    const out: string[] = [];
    for (const raw of words) {
      const w = raw.toLowerCase();
      for (const code of codes) {
        const l = g.langs.get(code)!;
        if (l.fn.has(w)) continue;
        const e = lookup(x, l.at, w) || (COMPOUNDING.has(code) && w.length >= 7 ? compound(x, l.at, w) : "");
        for (const y of e.split(" ")) if (y && !out.includes(y)) out.push(y);
      }
      if (out.length >= MAX_GLOSS_WORDS) break;
    }
    return out.slice(0, MAX_GLOSS_WORDS).join(" ");
  } catch {
    return "";
  }
}

const byUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every word a glossary holds (the lexicons read if they were not), for the differential test and the bench:
 * languages in file order, function words as written, keys and English words in code-unit order.
 */
export function glossWords(g: Glossary): {
  langs: { code: string; fn: string[]; keys: string[] }[];
  english: string[];
} {
  const x = lexicon(g);
  const all = (t: Table | undefined) => (x && t ? Array.from({ length: t.n }, (_, i) => entry(x.bytes, t, i)) : []);
  return {
    langs: [...g.langs].map(([code, l]) => ({ code, fn: [...l.fn], keys: all(x?.keys[l.at]).sort(byUnits) })),
    english: all(x?.english).sort(byUnits),
  };
}

/** A language's glossed words with their English, in code-unit order (version 1's line order). */
export function glossEntries(g: Glossary, code: string): [string, string][] {
  const x = lexicon(g);
  const l = g.langs.get(code);
  if (!x || !l) return [];
  const [k, e] = [x.keys[l.at]!, x.glosses[l.at]!];
  const out = Array.from({ length: k.n }, (_, i): [string, string] => [entry(x.bytes, k, i), entry(x.bytes, e, i)]);
  return out.sort(([a], [b]) => byUnits(a, b));
}
