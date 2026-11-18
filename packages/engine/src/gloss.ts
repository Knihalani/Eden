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
 *
 * The file is read in two parts. `warmGlossary` (when the partner is built) reads the prefix: the function words, the
 * English words the glosses use, and a Bloom filter of each language's keys (about 0.3 MB). The lexicons (keys and
 * glosses, 2.2 MB) are read the first time a request could be read as a language: until then a language is ruled out
 * from the prefix alone when even the most its words could count (a function word, or a word its filter may hold,
 * that is not English) cannot reach `MIN_HITS` or beat the fewest English could count (English words its filter
 * certainly lacks). That bound is exact, so the gloss is the same, and English traffic ("What's", "I've", "Sarah's",
 * whose clitics are function words elsewhere) leaves the lexicons unread.
 *
 * Layout (all integers u32 little-endian, every section 4-aligned):
 *   0 "EDGL", 4 version (2), 8 byte length, 12 language count L, 16 where the lexicons start (the prefix's end),
 *   20 CRC-32 of bytes [28, lexicons' start), 24 CRC-32 of bytes [lexicons' start, length),
 *   28 codes table, 32 English table, 36 + 16 i: language i's function-word table, filter, key and gloss tables.
 * The codes, English, function-word tables and filters lie before the lexicons' start; the key and gloss tables after
 * it (a gloss table has its key table's count). A table at T: count n, then n + 1 offsets into its arena (the first 0,
 * never decreasing), then the arena. Keys and English words are strictly increasing by bytes (checked when read: the
 * binary search relies on it). A filter at T: its size in bits (a power of two), its hash count, then the bits.
 */
import { closeSync, fstatSync, openSync, readSync, readFileSync, statSync } from "node:fs";
import glossaryFile from "./gloss.bin" with { type: "file" };
import { isStopword } from "./text";

/** A string table over a glossary's bytes: entry i is `bytes[base + offs[i] .. base + offs[i + 1])`. */
interface Table {
  n: number;
  offs: Uint32Array;
  base: number;
}
/** A Bloom filter of a language's keys: `bits` bits (a power of two) at `base`, `k` probes a word. */
interface Filter {
  bits: number;
  k: number;
  base: number;
}
interface Lang {
  /** Where the language is in the file's order, which is its index in the lexicons. */
  at: number;
  /** Function words: a Set, since every request (English ones too) reads them for each language. */
  fn: Set<string>;
  filter: Filter;
}
/** The lexicons: every language's sorted keys and their glosses. */
interface Lexicon {
  bytes: Buffer;
  keys: Table[];
  glosses: Table[];
}
/** A loaded glossary: its prefix (languages, English words, filters) and its lexicons, read on first need. */
export interface Glossary {
  langs: Map<string, Lang>;
  /** The prefix's bytes, which the English table and the filters point into. */
  head: Buffer;
  english: Table;
  /** The lexicons once read; null when they read wrong (nothing is glossed then). */
  lex?: Lexicon | null;
  /** Reads the lexicons: undefined when they could not be read now (I/O), so a later request tries again. */
  readLex: () => Lexicon | null | undefined;
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
const HEADER = 36;
/** Where the CRC-covered prefix starts: everything past the fixed fields (which are checked one by one). */
const CHECKED_FROM = 28;
/** More languages than any glossary will hold: a count past it is a corrupt file, not a big one. */
const MAX_LANGS = 1_024;
/** Function words in all (4,438 in 2026-11): past it a file is corrupt, and no Set is built from its count. */
const MAX_FN = 100_000;
/** Larger than the glossary will grow (2.4 MB in 2026-11): a length past it is a corrupt file, never allocated. */
const MAX_BYTES = 64 * 2 ** 20;
/** A filter's bits a key (about 1% false positives at 7 probes) and its probes. */
const FILTER_BITS_A_KEY = 10;
const FILTER_K = 7;

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
 * Two 32-bit hashes of `w`'s UTF-8 bytes (FNV-1a from two seeds), made a code point at a time as `cmpWord` makes them,
 * into `hashes`: the filter's probes are `h1 + i * h2`.
 */
const hashes = new Uint32Array(2);
function hashWord(w: string): void {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  const add = (b: number) => {
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x01000193) ^ (h2 >>> 15);
  };
  for (let i = 0; i < w.length; i++) {
    let c = w.charCodeAt(i);
    if (c >= 0xd800 && c < 0xe000) {
      const lo = i + 1 < w.length ? w.charCodeAt(i + 1) : 0;
      if (c < 0xdc00 && lo >= 0xdc00 && lo < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      } else c = 0xfffd;
    }
    if (c < 0x80) add(c);
    else if (c < 0x800) {
      add(0xc0 | (c >> 6));
      add(0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      add(0xe0 | (c >> 12));
      add(0x80 | ((c >> 6) & 0x3f));
      add(0x80 | (c & 0x3f));
    } else {
      add(0xf0 | (c >> 18));
      add(0x80 | ((c >> 12) & 0x3f));
      add(0x80 | ((c >> 6) & 0x3f));
      add(0x80 | (c & 0x3f));
    }
  }
  hashes[0] = h1;
  hashes[1] = h2 | 1;
}

/** A filter's bytes for `keys`: bits, probes, then the bits, about `FILTER_BITS_A_KEY` a key (a power of two). */
function filterBytes(keys: readonly string[]): Buffer {
  let bits = 64;
  while (bits < keys.length * FILTER_BITS_A_KEY) bits *= 2;
  const out = Buffer.alloc(8 + bits / 8);
  out.writeUInt32LE(bits, 0);
  out.writeUInt32LE(FILTER_K, 4);
  for (const w of keys) {
    hashWord(w);
    for (let i = 0; i < FILTER_K; i++) {
      const bit = (hashes[0]! + Math.imul(i, hashes[1]!)) & (bits - 1);
      out[8 + (bit >>> 3)]! |= 1 << (bit & 7);
    }
  }
  return out;
}

/** Whether `l`'s filter may hold `w` (false: `w` is certainly not one of its keys). */
function mayHold(head: Buffer, f: Filter, w: string): boolean {
  hashWord(w);
  for (let i = 0; i < f.k; i++) {
    const bit = (hashes[0]! + Math.imul(i, hashes[1]!)) & (f.bits - 1);
    if ((head[f.base + (bit >>> 3)]! & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

/**
 * The packed glossary (version 2) for `langs`, in their order (the order tied languages are glossed in). Keys are
 * sorted by their UTF-8 bytes; a key given twice throws. The English table is every word of every gloss, split on
 * spaces.
 */
export function packGlossary(langs: readonly GlossLang[]): Buffer {
  const english = new Set<string>();
  const fns: Buffer[] = [];
  const filters: Buffer[] = [];
  const lexicons: Buffer[] = [];
  for (const l of langs) {
    const entries = [...l.glosses].map(([w, e]) => [utf8(w), utf8(e)] as const);
    entries.sort((a, b) => Buffer.compare(a[0], b[0]));
    for (let i = 1; i < entries.length; i++)
      if (Buffer.compare(entries[i - 1]![0], entries[i]![0]) === 0) throw new Error(`gloss: ${l.code} repeats a key`);
    for (const [, e] of entries) for (const x of e.toString("utf8").split(" ")) if (x) english.add(x);
    fns.push(tableBytes(l.fn.map(utf8)));
    filters.push(filterBytes(entries.map(([w]) => w.toString("utf8"))));
    lexicons.push(tableBytes(entries.map(([w]) => w)), tableBytes(entries.map(([, e]) => e)));
  }
  const codes = tableBytes(langs.map((l) => utf8(l.code)));
  const en = tableBytes([...english].map(utf8).sort(Buffer.compare));
  const head = Buffer.alloc(HEADER + 16 * langs.length);
  // The prefix (header, codes, English words, function words, filters) first, then the lexicons.
  let at = head.length;
  const place = (t: Buffer) => {
    const w = at;
    at += t.length;
    return w;
  };
  head.writeUInt32LE(place(codes), 28);
  head.writeUInt32LE(place(en), 32);
  fns.forEach((t, i) => head.writeUInt32LE(place(t), HEADER + 16 * i));
  filters.forEach((t, i) => head.writeUInt32LE(place(t), HEADER + 16 * i + 4));
  const lexStart = at;
  lexicons.forEach((t, j) => head.writeUInt32LE(place(t), HEADER + 16 * (j >> 1) + 8 + 4 * (j & 1)));
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(VERSION, 4);
  head.writeUInt32LE(at, 8);
  head.writeUInt32LE(langs.length, 12);
  head.writeUInt32LE(lexStart, 16);
  const out = Buffer.concat([head, codes, en, ...fns, ...filters, ...lexicons]);
  return seal(out);
}

/** Writes the two CRC-32s into a packed glossary's header (the packer's last step; tests reseal crafted files). */
export function seal(b: Buffer): Buffer {
  const lexStart = b.readUInt32LE(16);
  b.writeUInt32LE(Bun.hash.crc32(b.subarray(CHECKED_FROM, lexStart)) >>> 0, 20);
  b.writeUInt32LE(Bun.hash.crc32(b.subarray(lexStart)) >>> 0, 24);
  return b;
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

/** The filter at `at`, or null unless it lies within `[lo, hi)`, its size is a power of two and its probes sane. */
function filterAt(words: Uint32Array, at: number, lo: number, hi: number): Filter | null {
  if (at % 4 !== 0 || at < lo || at + 8 > hi || hi > words.length * 4) return null;
  const bits = words[at >>> 2]!;
  const k = words[(at >>> 2) + 1]!;
  if (bits < 8 || bits > 2 ** 30 || (bits & (bits - 1)) !== 0 || k < 1 || k > 16) return null;
  if (at + 8 + bits / 8 > hi) return null;
  return { bits, k, base: at + 8 };
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

interface Header {
  length: number;
  count: number;
  lexStart: number;
  prefixCrc: number;
  lexCrc: number;
}

/** The header's fields, or null when the first bytes are not a version 2 glossary of a sane size. */
function header(words: Uint32Array): Header | null {
  if (words.length < HEADER / 4 || words[0] !== MAGIC || words[1] !== VERSION) return null;
  const [length, count, lexStart] = [words[2]!, words[3]!, words[4]!];
  if (length > MAX_BYTES || length % 4 !== 0 || count > MAX_LANGS) return null;
  if (lexStart < HEADER + 16 * count || lexStart > length || lexStart % 4 !== 0) return null;
  return { length, count, lexStart, prefixCrc: words[5]!, lexCrc: words[6]! };
}

/** The prefix's contents (`raw` holds at least its bytes), or null when its CRC or any table or filter is wrong. */
function readPrefix(raw: Uint8Array): (Omit<Glossary, "readLex" | "lex"> & { h: Header }) | null {
  const { bytes, words } = aligned(raw);
  const h = header(words);
  if (!h || bytes.length < h.lexStart) return null;
  if (Bun.hash.crc32(bytes.subarray(CHECKED_FROM, h.lexStart)) >>> 0 !== h.prefixCrc) return null;
  const codes = tableAt(words, words[7]!, HEADER, h.lexStart);
  const english = tableAt(words, words[8]!, HEADER, h.lexStart);
  if (!codes || codes.n !== h.count || !english || !ascending(bytes, english)) return null;
  const langs = new Map<string, Lang>();
  let fnWords = 0;
  for (let i = 0; i < h.count; i++) {
    const fn = tableAt(words, words[(HEADER >>> 2) + 4 * i]!, HEADER, h.lexStart);
    const filter = filterAt(words, words[(HEADER >>> 2) + 4 * i + 1]!, HEADER, h.lexStart);
    const code = entry(bytes, codes, i);
    if (!fn || !filter || langs.has(code)) return null;
    // Bounded before the Sets are built: a crafted count must not cost memory by itself.
    fnWords += fn.n;
    if (fnWords > MAX_FN) return null;
    langs.set(code, { at: i, fn: new Set(Array.from({ length: fn.n }, (_, j) => entry(bytes, fn, j))), filter });
  }
  return { langs, head: bytes, english, h };
}

/** The lexicons of a whole file's `raw` bytes, or null when their CRC or any table is out of place or unsorted. */
function readLexicon(raw: Uint8Array, h: Header): Lexicon | null {
  const { bytes, words } = aligned(raw);
  if (bytes.length !== h.length) return null;
  if (Bun.hash.crc32(bytes.subarray(h.lexStart)) >>> 0 !== h.lexCrc) return null;
  const table = (at: number) => tableAt(words, at, h.lexStart, h.length);
  const keys: Table[] = [];
  const glosses: Table[] = [];
  for (let i = 0; i < h.count; i++) {
    const k = table(words[(HEADER >>> 2) + 4 * i + 2]!);
    const g = table(words[(HEADER >>> 2) + 4 * i + 3]!);
    if (!k || !g || g.n !== k.n || !ascending(bytes, k)) return null;
    keys.push(k);
    glosses.push(g);
  }
  return { bytes, keys, glosses };
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
 * checked against the bytes before it is read, both CRC-32s must match and keys must be strictly increasing, so a
 * corrupt or crafted file is refused whole, never read past its end.
 */
export const readGlossary = guarded((raw: Uint8Array): Glossary | null => {
  const p = readPrefix(raw);
  const lex = p ? readLexicon(raw, p.h) : null;
  return p && lex ? { langs: p.langs, head: p.head, english: p.english, lex, readLex: () => lex } : null;
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
 * time a request needs them. That later read must find the file at the length the header gave (else it is I/O: told
 * once, and tried again by a later request), then the same prefix, the lexicons' CRC and valid tables (else nothing is
 * glossed for the rest of the process, told once). Either way the request in hand is left as written (fail open).
 */
export const loadGlossary = guarded((file: string | URL): Glossary | null => {
  // Bun's immutable embedded files support readFileSync, but not file descriptors.
  const embedded = typeof file === "string" && file.startsWith("/$bunfs/");
  const fd = embedded ? null : openSync(file, "r");
  let prefix: Buffer;
  try {
    const head = Buffer.alloc(HEADER);
    const raw = embedded ? readFileSync(file) : null;
    if (raw) raw.copy(head, 0, 0, HEADER);
    else if (!readExactly(fd!, head)) return null;
    const h = header(aligned(head).words);
    if (!h || (raw ? raw.length : fstatSync(fd!).size) !== h.length) return null;
    prefix = Buffer.alloc(h.lexStart);
    if (raw) raw.copy(prefix, 0, 0, h.lexStart);
    else if (!readExactly(fd!, prefix)) return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const p = readPrefix(prefix);
  if (!p) return null;
  let told = false;
  const tell = (why: string) => {
    // Content-free: the reason only, once a glossary.
    if (!told) console.error(`eden: the request glossary's lexicons ${why}; requests in other languages go unglossed`);
    told = true;
  };
  const readLex = (): Lexicon | null | undefined => {
    let whole: Buffer;
    try {
      // Exactly the length the prefix's header gave, never what the file has grown to since: a file replaced by a
      // larger one is refused by its size, not read into memory.
      if (embedded) {
        if (statSync(file).size !== p.h.length) throw new Error("size");
        whole = readFileSync(file);
        if (whole.length !== p.h.length) throw new Error("size");
      } else {
        const fd = openSync(file, "r");
        try {
          if (fstatSync(fd).size !== p.h.length) throw new Error("size");
          whole = Buffer.alloc(p.h.length);
          if (!readExactly(fd, whole)) throw new Error("short read");
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      tell("could not be read (tried again on a later request)");
      return undefined;
    }
    const lex = whole.subarray(0, p.h.lexStart).equals(prefix) ? (guarded(readLexicon)(whole, p.h) ?? null) : null;
    if (!lex) tell("read wrong (a changed or corrupt file)");
    return lex;
  };
  return { langs: p.langs, head: p.head, english: p.english, readLex };
});

/** Reads the shipped glossary's prefix now (once a process), so a request does not wait for it. */
export function warmGlossary(): Glossary | null {
  if (loaded === undefined) loaded = loadGlossary(glossaryFile);
  return loaded;
}

/** The lexicons, read the first time they are needed; null while they cannot be (tried again after an I/O failure). */
function lexicon(g: Glossary): Lexicon | null {
  if (g.lex !== undefined) return g.lex;
  const x = g.readLex();
  if (x !== undefined) g.lex = x;
  return x ?? null;
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

/** Whether lower-casing changes `w`; an ASCII word is read by its codes with no new string (D1891). */
function isCapital(w: string): boolean {
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    if (c >= 0x80) return w !== w.toLowerCase();
    if (c >= 65 && c <= 90) return true;
  }
  return false;
}

/**
 * Each function word's languages as a bitmask over `g.langs` in order, built once a glossary (D1891): a request's
 * candidate languages are one lookup a word instead of a Set lookup a word a language. Null past 31 languages.
 */
type FnIndex = { masks: Map<string, number>; langs: [string, Lang][] };
// Keyed by the language map, which is all the index reads (a copy of a glossary with its lexicons unread shares it).
const fnIndexes = new WeakMap<Map<string, Lang>, FnIndex | null>();
function fnIndexOf(g: Glossary): FnIndex | null {
  let x = fnIndexes.get(g.langs);
  if (x !== undefined) return x;
  x = null;
  if (g.langs.size <= 31) {
    const masks = new Map<string, number>();
    const langs = [...g.langs];
    langs.forEach(([, l], k) => {
      for (const w of l.fn) masks.set(w, (masks.get(w) ?? 0) | (1 << k));
    });
    x = { masks, langs };
  }
  fnIndexes.set(g.langs, x);
  return x;
}

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
 * Whether `l` could pass the count below with the lexicons read, from the prefix alone: the most its words could count
 * (a function word, or a word its filter may hold, that is not English) and the fewest English could (English words
 * that are not function words and that its filter certainly lacks). A filter has no false negatives, so a language this
 * rules out is one the count rules out too.
 */
function couldWin(told: readonly string[], en: readonly boolean[], g: Glossary, l: Lang, best: number): boolean {
  let most = 0;
  let english = 0;
  for (let i = 0; i < told.length; i++) {
    const may = l.fn.has(told[i]!) || mayHold(g.head, l.filter, told[i]!);
    if (may && !en[i]) most++;
    else if (en[i] && !may) english++;
  }
  return most >= MIN_HITS && most > english && most >= best;
}

/**
 * The languages a request is written in: a language counts the request's telling words it knows (a function word or a
 * glossed word) that are not English, English counts those it knows that the language does not; the language wins
 * with at least `MIN_HITS` and more than English. The most first; ties all kept (Spanish and Portuguese share many).
 * None when the lexicons are needed and cannot be read. Before they are read, a language is first bounded from the
 * prefix (`couldWin`): one that cannot win is passed over exactly as the count would pass it over, unread.
 */
export function languagesOf(words: readonly string[], g: Glossary): string[] {
  const told = telling(words);
  let best = 0;
  let out: string[] = [];
  // A language none of whose function words the request holds is not it: set lookups first, so an English request
  // never searches (or reads) the lexicons. One mask lookup a word where the glossary has an index (D1891).
  const idx = fnIndexOf(g);
  let cands: [string, Lang][];
  if (idx) {
    let held = 0;
    for (const w of told) {
      const m = idx.masks.get(w);
      if (m !== undefined && !isStopword(w)) held |= m;
    }
    cands = [];
    for (let b = held; b !== 0; b &= b - 1) cands.push(idx.langs[31 - Math.clz32(b & -b)]!);
  } else cands = [...g.langs].filter(([, l]) => told.some((w) => l.fn.has(w) && !isStopword(w)));
  if (cands.length === 0) return out;
  // Whether each word is English, read once a request (the same for every language).
  const en = told.map((w) => isStopword(w) || find(g.head, g.english, w) >= 0);
  for (const [code, l] of cands) {
    if (g.lex === undefined && !couldWin(told, en, g, l, best)) continue;
    const x = lexicon(g);
    if (!x) return [];
    let mine = 0;
    let english = 0;
    for (let i = 0; i < told.length; i++) {
      const w = told[i]!;
      const known = l.fn.has(w) || find(x.bytes, x.keys[l.at]!, w) >= 0;
      if (known && !en[i]) mine++;
      else if (en[i] && !known) english++;
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
  const all = (b: Buffer, t: Table | undefined) => (t ? Array.from({ length: t.n }, (_, i) => entry(b, t, i)) : []);
  return {
    langs: [...g.langs].map(([code, l]) => ({
      code,
      fn: [...l.fn],
      keys: x ? all(x.bytes, x.keys[l.at]).sort(byUnits) : [],
    })),
    english: all(g.head, g.english).sort(byUnits),
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
