/**
 * Readers for what `JSON.parse` reads slowly, used by the shape scan on its way through a long reply (`shape.ts`,
 * D1900): a long string with dense escapes (JSON written as text) and a long array of numbers (with nulls, D1919).
 * Each gives exactly `JSON.parse`'s value or says it cannot (`long-reply.test.ts` compares them on seeded inputs), and
 * each is bounded by the bytes it reads. They read UTF-8 bytes: a region of the reply's string is encoded into a reused
 * buffer first (about 0.06 ns a byte), since a loop over a typed array costs JSC about a nanosecond a byte where
 * `charCodeAt` costs more, and `JSON.parse` takes about 16 ns an escape and 23 a number.
 */
/** Decodes as `TextDecoder` does but keeps a byte-order mark: a range that is not the body's start has none to drop. */
const keepMark = new TextDecoder("utf-8", { ignoreBOM: true });
const stripMark = new TextDecoder();
/** Node's and Bun's `Buffer.prototype.latin1Slice`: one byte a character, which ASCII decodes to as UTF-8 does. */
type Slice = (this: Uint8Array, start: number, end: number) => string;
const latin1Slice = (globalThis as { Buffer?: { prototype?: { latin1Slice?: Slice } } }).Buffer?.prototype?.latin1Slice;
/**
 * `node:buffer`'s `isAscii` (simdutf on both runtimes), looked up at run time rather than imported, so a bundle for
 * another platform pulls in no `Buffer` polyfill; without it every range is decoded by `TextDecoder`.
 */
const isAscii = (
  globalThis as { process?: { getBuiltinModule?: (id: string) => { isAscii?: (b: Uint8Array) => boolean } } }
).process?.getBuiltinModule?.("node:buffer")?.isAscii;

/**
 * `bytes[start, end)` decoded as UTF-8, with replacement, as `TextDecoder` decodes it; a byte-order mark is dropped
 * only at the body's start (`atStart`). ASCII is copied one byte a character (`latin1Slice`, where the runtime has it),
 * which is what UTF-8 decodes it to: on Bun the string `TextDecoder` makes from the same bytes costs `JSON.parse` about
 * 40% more to read (938 against 674 µs a MiB of tool output, D1900); the ASCII check costs 15 µs a MiB.
 */
export function decodeRange(bytes: Uint8Array, start: number, end: number, atStart = false): string {
  const sub = start === 0 && end === bytes.length ? bytes : bytes.subarray(start, end);
  decodedAscii = latin1Slice !== undefined && isAscii?.(sub) === true;
  if (decodedAscii) return latin1Slice!.call(sub, 0, sub.length);
  return (atStart ? stripMark : keepMark).decode(sub);
}
/** Whether the last `decodeRange` copied ASCII one byte a character (its string is then one byte a character too). */
export let decodedAscii = false;

const encoder = new TextEncoder();
/**
 * The buffers regions are encoded into, kept between replies: `scratch` for numbers and short strings, `wide` (grown
 * as needed, up to `UNESCAPE_MOST` characters' worth) for a long string with dense escapes. What a reply wrote into
 * either is zeroed when the reply is done (`releaseScratch`, from `json.ts`), so no reply's text stays in memory
 * after the call that read it; allocating `wide` afresh for each reply instead cost a 64 KB reply 18% of its read.
 */
const scratch = new Uint8Array(64 * 1024);
let wide = new Uint8Array(0);
/** How far into `scratch` and `wide` the reply being read has written. */
let scratchUsed = 0;
let wideUsed = 0;
/** The longest string `unescapeText` reads, in characters: a longer one stays in the parse, which needs no buffer. */
export const UNESCAPE_MOST = 4 << 20;
/** The buffer the last region went into: `scratch` or `wide`. */
let encoded: Uint8Array = scratch;
/** Node's and Bun's `Buffer.byteLength`: a string's UTF-8 length, so multi-byte text gets the room it needs. */
const byteLength = (globalThis as { Buffer?: { byteLength?: (s: string, e: string) => number } }).Buffer?.byteLength;

/**
 * `text[start, end)` as UTF-8 in `encoded`, followed by a zero byte; its length in bytes. ASCII, the common case, is
 * tried in a buffer of one byte a character; only text that does not fit is encoded again with the room it needs.
 */
function encodeRegion(text: string, start: number, end: number): number {
  const region = text.slice(start, end);
  for (let room = region.length; ; room = byteLength ? byteLength(region, "utf8") : 3 * region.length) {
    let into = scratch;
    if (room >= scratch.length) {
      if (room >= wide.length) wide = new Uint8Array(Math.max(room + 1, 2 * wide.length));
      into = wide;
    }
    const { read, written } = encoder.encodeInto(region, into.subarray(0, room));
    if (read === region.length) {
      into[written] = 0;
      if (into === scratch) scratchUsed = Math.max(scratchUsed, written + 1);
      else wideUsed = Math.max(wideUsed, written + 1);
      encoded = into;
      return written;
    }
    // A failed ASCII try wrote too.
    if (into === scratch) scratchUsed = Math.max(scratchUsed, written);
    else wideUsed = Math.max(wideUsed, written);
  }
}

/** Whether the buffers hold nothing but zeroes (the tests check no reply's text stays in them). */
export function scratchIsClear(): boolean {
  return scratch.every((b) => b === 0) && wide.every((b) => b === 0);
}

/** Zeroes what the reply just read wrote into the buffers and lets go of the numbers it read. */
export function releaseScratch(): void {
  if (scratchUsed > 0) scratch.fill(0, 0, scratchUsed);
  // Kept up to 4 MiB: more (multi-byte text) is let go.
  if (wide.length > UNESCAPE_MOST + 1) wide = new Uint8Array(0);
  else if (wideUsed > 0) wide.fill(0, 0, wideUsed);
  scratchUsed = wideUsed = 0;
  encoded = scratch;
  numbersRead = [];
}

/** What each escape's second byte stands for; 0 for none (`u` is read apart). */
const UNESCAPE = new Uint8Array(256);
UNESCAPE[0x22] = 0x22;
UNESCAPE[0x5c] = 0x5c;
UNESCAPE[0x2f] = 0x2f;
UNESCAPE[0x62] = 0x08;
UNESCAPE[0x66] = 0x0c;
UNESCAPE[0x6e] = 0x0a;
UNESCAPE[0x72] = 0x0d;
UNESCAPE[0x74] = 0x09;
/** The value of each hex digit, -1 for any other byte. */
const HEX = new Int8Array(256).fill(-1);
for (let d = 0; d < 10; d++) HEX[0x30 + d] = d;
for (let d = 0; d < 6; d++) HEX[0x41 + d] = HEX[0x61 + d] = 10 + d;

/** What each byte is inside a string: 0 for itself, 1 for a backslash, 2 for a raw quote or control character. */
const IN_STRING = new Uint8Array(256);
IN_STRING.fill(2, 0, 0x20);
IN_STRING[0x22] = 2;
IN_STRING[0x5c] = 1;

/**
 * The value of the JSON string whose text (between its quotes) is `text[start, end)`, or undefined when that text is
 * not one valid string's or holds what this reader leaves to `JSON.parse`: a raw quote (the string ended earlier), a
 * raw control character, a bad escape, a `\u` escape of a lone surrogate (UTF-8 cannot carry one), or a lone surrogate
 * in the text itself (`encodeInto` would replace it). The text is encoded as UTF-8 and unescaped in place, each escape
 * written as the bytes it stands for (a `\u` escape as its UTF-8, a surrogate pair as its code point's), then decoded:
 * the same string `JSON.parse` makes of it. A byte loop with one table load a byte: on Bun 1.9-2.1 ms for 1.3 MB of
 * JSON written as text, where `JSON.parse` takes 3.5-4.3 (16 ns an escape); on Node 22 V8's parse is the faster (2.3
 * against 2.1-2.9), so `shape.ts` reads with it only on Bun (D1900).
 */
export function unescapeText(text: string, start: number, end: number): string | undefined {
  const region = text.slice(start, end) as string & { isWellFormed?: () => boolean };
  if (region.isWellFormed?.() !== true) return undefined;
  const n = encodeRegion(text, start, end);
  // Unescaped in place: an escape is never shorter than what it stands for, so the output never overtakes the input.
  const b = encoded;
  const out = b;
  let o = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    const kind = IN_STRING[c]!;
    if (kind === 0) {
      out[o++] = c;
      continue;
    }
    if (kind === 2 || i + 1 >= n) return undefined;
    const e = b[++i]!;
    const plain = UNESCAPE[e]!;
    if (plain !== 0) {
      out[o++] = plain;
      continue;
    }
    if (e !== 0x75 || i + 4 >= n) return undefined;
    let cp = hex4(b, i + 1);
    if (cp < 0) return undefined;
    i += 4;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      // Only a high surrogate's escape followed at once by a low one's makes a code point.
      if (cp > 0xdbff || i + 6 >= n || b[i + 1] !== 0x5c || b[i + 2] !== 0x75) return undefined;
      const low = hex4(b, i + 3);
      if (low < 0xdc00 || low > 0xdfff) return undefined;
      cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
      i += 6;
    }
    if (cp < 0x80) out[o++] = cp;
    else if (cp < 0x800) {
      out[o++] = 0xc0 | (cp >> 6);
      out[o++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      out[o++] = 0xe0 | (cp >> 12);
      out[o++] = 0x80 | ((cp >> 6) & 0x3f);
      out[o++] = 0x80 | (cp & 0x3f);
    } else {
      out[o++] = 0xf0 | (cp >> 18);
      out[o++] = 0x80 | ((cp >> 12) & 0x3f);
      out[o++] = 0x80 | ((cp >> 6) & 0x3f);
      out[o++] = 0x80 | (cp & 0x3f);
    }
  }
  return decodeRange(out, 0, o);
}

function hex4(b: Uint8Array, i: number): number {
  const w = HEX[b[i]!]!;
  const x = HEX[b[i + 1]!]!;
  const y = HEX[b[i + 2]!]!;
  const z = HEX[b[i + 3]!]!;
  return (w | x | y | z) < 0 ? -1 : (w << 12) | (x << 8) | (y << 4) | z;
}

/** `readNumbers`' answers besides an end index. */
export const NOT_NUMBERS = -1;
export const TOO_MANY = -2;
/** `numbersIn`'s answer when its region ended inside the array: go on from `resumeAt`. */
const MORE = -3;
/** Exact powers of ten: a double holds each exactly up to 1e22. */
const POW10 = new Float64Array(23).map((_, k) => 10 ** k);
const isSpaceByte = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
/** An element `readNumbers` reads: a number, or a `null`, `true` or `false` among them (D1919). */
export type Element = number | boolean | null;
/** The elements the last `readNumbers` read. */
export let numbersRead: Element[] = [];
/** Where, in the region `numbersIn` last read, the element it could not finish starts. */
let resumeAt = 0;
/** Where, in the region `numbersIn` last read, the element it refused starts. */
let failAt = 0;
/**
 * Where the last `readNumbers` that answered `NOT_NUMBERS` stopped (D1919): `at`, the index in `text` of the
 * character it stopped at, and `commas`, the commas before it. Everything from the array's first element up to `at`
 * is numbers' characters, commas and spaces, in which the shape scan only counts the commas, so the scan goes on from
 * `at` with them counted rather than crossing them again. `at` is -1 when it stopped at no such place; every
 * `readNumbers` sets it.
 */
export const numbersStop = { at: -1, commas: 0 };
/**
 * The first region `readNumbers` encodes, in characters, and the most it encodes at once (within the scratch buffer,
 * so reading numbers never takes a buffer of its own); the tests make them tiny to cut numbers at every place.
 */
export const NUMBER_REGION = { first: 512, most: 32 * 1024 };

/**
 * The index in `text` of the `]` that closes the array opened at `open`, when every element is a JSON number of at most
 * 15 significant digits whose power of ten (its exponent less its decimal places) is within 22, or a `null`, `true` or
 * `false` (a metrics series with gaps, D1919): `numbersRead` then holds them. `NOT_NUMBERS` for any other array (the
 * scan reads it as usual, from `numbersStop`), and `TOO_MANY` past `room` commas, where the scan would refuse it.
 * Such a number is an integer under 2^53 times or divided by an exact power of ten, which one IEEE operation rounds
 * correctly (Clinger's fast path), so it is the double `JSON.parse` gives. The array is encoded a region at a time
 * from its first element, each twice the last up to `NUMBER_REGION.most`, so a reader that gives up has cost about
 * what it read (an array of arrays nested a thousand deep costs no more than one pass), and every region goes into the
 * scratch buffer. 2.6-2.9 ms a MiB of numbers against `JSON.parse`'s 3.0-3.6 (D1900).
 *
 * `close`, when given, is the next `]`, with more elements possible before it than `room`: once the first region has
 * read as numbers, the commas up to `close` are counted (`commasIn`), so a flood is refused with no more than a
 * region's numbers kept, and an array that fits is made its exact length (grown by pushes, 900,000 numbers peaked at
 * 30 MB against 13, D1908). Counting only after the first region keeps an array that is not numbers from both the
 * count and the array (D1919: 16 MiB of 17-digit floats peaked 38 MB against main's 24 when both came first).
 */
export function readNumbers(text: string, open: number, room: number, close = -1): number {
  numbersStop.at = -1;
  let i = open + 1;
  let c = text.charCodeAt(i);
  while (isSpaceByte(c)) c = text.charCodeAt(++i);
  if (!((c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x6e || c === 0x74 || c === 0x66)) return NOT_NUMBERS;
  let out: Element[] = [];
  filled = 0;
  for (let size = NUMBER_REGION.first; ; size = Math.min(2 * size, NUMBER_REGION.most)) {
    const length = encodeNumbers(text, i, Math.min(text.length, i + size));
    const r = numbersIn(encoded, length, out, room);
    if (r >= 0) {
      if (out.length !== filled) out.length = filled;
      numbersRead = out;
      // Every character before the `]` was a number's, a separator or a space, so ASCII: bytes and characters line up.
      return i + r;
    }
    if (r === TOO_MANY) return r;
    if (r === NOT_NUMBERS) return stopped(i + failAt, filled);
    // The array runs on past the end of the text, or (no progress) holds an element longer than the largest region,
    // so longer than any number this reads.
    if (i + encodedChars === text.length || (resumeAt === 0 && (size === NUMBER_REGION.most || encodedChars === 0))) {
      return stopped(i + resumeAt, filled);
    }
    i += resumeAt;
    if (close >= 0) {
      // The first region read as numbers: count the rest's commas, then make the array its length.
      const commas = commasIn(text, i, close, room - filled);
      if (commas === -1) return TOO_MANY;
      if (commas === -2) return stopped(numbersStop.at, filled + numbersStop.commas);
      const sized: Element[] = new Array(filled + commas + 1);
      for (let k = 0; k < filled; k++) sized[k] = out[k]!;
      out = sized;
      close = -1;
    }
  }
}

function stopped(at: number, commas: number): number {
  numbersStop.at = at;
  numbersStop.commas = commas;
  return NOT_NUMBERS;
}

/**
 * Whether the last element of the array opened at `open`, whose next `]` is at `close`, is one `readNumbers` reads,
 * when the last comma is within 64 characters of the `]` (else true: an element that long is left to `readNumbers`).
 * Asked before reading, so an array that ends in a number of more than 15 digits, or in anything else the reader
 * leaves to `JSON.parse`, is left to the scan at once: read up to its last element first, then scanned and parsed, it
 * cost 1.6-2.1x main (D1919).
 */
export function lastElementReads(text: string, open: number, close: number): boolean {
  const lo = Math.max(open, close - 64);
  let p = close - 1;
  while (p > lo && text.charCodeAt(p) !== 0x2c) p--;
  if (p <= lo) return true;
  return lastElementIn(encodeNumbers(text, p + 1, close + 1));
}

/**
 * `lastElementReads` over the reply's bytes, for the byte scan (`byteShapeOrStop`): it stops for the text path only
 * where the reader would read (D1919: stopping at `[1,1,...,12345678901234567]` cost the bytes path 1.1-1.2x main, the
 * text scan where the byte scan would have done). Its distances are in bytes, never shorter than the text's in
 * characters, and a byte outside ASCII is no number's: so where this answers false, `lastElementReads` does too.
 */
export function lastElementReadsBytes(bytes: Uint8Array, open: number, close: number): boolean {
  const lo = Math.max(open, close - 64);
  let p = close - 1;
  while (p > lo && bytes[p] !== 0x2c) p--;
  if (p <= lo) return true;
  const length = close + 1 - (p + 1);
  scratch.set(bytes.subarray(p + 1, close + 1));
  scratch[length] = 0;
  if (length >= scratchUsed) scratchUsed = length + 1;
  return lastElementIn(length);
}

/** Whether the `length` bytes in the scratch buffer are one element `numbersIn` reads and the `]` after it. */
function lastElementIn(length: number): boolean {
  filled = 0;
  const r = numbersIn(scratch, length, lastElement, 1);
  lastElement.length = 0;
  return r >= 0;
}
const lastElement: Element[] = [];

/**
 * The commas in `text[from, to)`, which holds no quote: -1 past `room` (each is a value the scan would count, so the
 * scan refuses), -2 at a character no number array holds before its `]` (anything but digits, `-+.eE`, commas and
 * spaces), with `numbersStop` set to it and the commas before it. Counted with one table load a character (about
 * 1 ns a character, half the scan's). The regions double from `NUMBER_REGION.first`, as `readNumbers`' do, so stopping
 * costs about what was counted before it, not a whole region (D1909: with `to` a `]` deep inside, a count over
 * everything up to it at every level cost 12x main; D1919: a `null` or `true` early in a long array was counted past).
 */
export function commasIn(text: string, from: number, to: number, room: number): number {
  let commas = 0;
  for (
    let p = from, size = NUMBER_REGION.first;
    p < to;
    p += encodedChars, size = Math.min(2 * size, NUMBER_REGION.most)
  ) {
    const n = encodeNumbers(text, p, Math.min(to, p + size));
    const b = scratch;
    for (let j = 0; j < n; j++) {
      const c = b[j]!;
      if (c === 0x2c) {
        if (++commas > room) return -1;
      } else if (NOT_IN_NUMBERS[c] === 1) {
        // Every byte before it was ASCII, so `j` counts characters.
        numbersStop.at = p + j;
        numbersStop.commas = commas;
        return -2;
      }
    }
    if (encodedChars === 0) {
      numbersStop.at = p;
      numbersStop.commas = commas;
      return -2;
    }
  }
  return commas;
}
/** 1 for each byte no number array holds before its `]`: all but digits, `-+.eE`, commas and spaces. */
const NOT_IN_NUMBERS = new Uint8Array(256).fill(1);
for (const ch of "0123456789-+.eE, nultrfas\t\n\r") NOT_IN_NUMBERS[ch.charCodeAt(0)] = 0;

/** Elements `numbersIn` has put in the array being read. */
let filled = 0;

/** Characters the last `encodeNumbers` encoded. */
let encodedChars = 0;

/**
 * As many characters of `text[start, end)` as fit one byte a character in the scratch buffer, encoded there and
 * followed by a zero byte (`encodedChars` of them); the bytes written. A character outside ASCII may stop it early, and
 * one that fits is never a number's, so `numbersIn` stops at it: bytes and characters line up up to where it stops.
 */
function encodeNumbers(text: string, start: number, end: number): number {
  const room = Math.min(end - start, scratch.length - 1);
  const r = encoder.encodeInto(text.slice(start, start + room), scratch.subarray(0, room));
  encodedChars = r.read;
  scratch[r.written] = 0;
  if (r.written >= scratchUsed) scratchUsed = r.written + 1;
  encoded = scratch;
  return r.written;
}

/**
 * The elements of the encoded region `b[0, length)` added to `out`, up to its closing `]`: that `]`'s index, or
 * `MORE` (with `resumeAt`) when the region ends first. The region is followed by a zero byte, which no number,
 * separator or space is, so every loop stops there.
 */
function numbersIn(b: Uint8Array, length: number, out: Element[], room: number): number {
  // Kept local in the loop (a module variable written for every number cost the reader 5-10%), stored at each exit.
  let f = filled;
  let i = 0;
  let c = b[0]!;
  // A region may start inside the spaces before an element.
  while (isSpaceByte(c)) c = b[++i]!;
  for (;;) {
    const element = i;
    let v: number | boolean | null;
    if (c >= 0x61) {
      // `null`, `true` and `false` are kept as they are: a series with gaps is a number array too (D1919).
      const len = literalLength(b, i, length, c);
      if (len <= 0) return len < 0 ? more(element, f) : fail(element, f);
      v = c === 0x6e ? null : c === 0x74;
      i += len;
      c = b[i]!;
      // The region may have cut it short of what follows.
      if (i >= length) return more(element, f);
    } else {
      const neg = c === 0x2d;
      if (neg) c = b[++i]!;
      // Digits are counted from positions, and a digit test is one unsigned compare: this loop is the reader's cost.
      const first = i;
      let m = 0;
      if (c === 0x30) c = b[++i]!;
      else if ((c - 0x31) >>> 0 < 9) {
        do {
          m = m * 10 + (c - 0x30);
          c = b[++i]!;
        } while ((c - 0x30) >>> 0 < 10);
      } else return i >= length ? more(element, f) : fail(element, f);
      // A leading zero is not significant.
      let digits = m === 0 ? 0 : i - first;
      let p = 0;
      if (c === 0x2e) {
        const dot = ++i;
        c = b[i]!;
        if ((c - 0x30) >>> 0 >= 10) return i >= length ? more(element, f) : fail(element, f);
        do {
          m = m * 10 + (c - 0x30);
          c = b[++i]!;
        } while ((c - 0x30) >>> 0 < 10);
        p = dot - i;
        digits -= p;
      }
      if ((c | 0x20) === 0x65) {
        c = b[++i]!;
        const negative = c === 0x2d;
        if (negative || c === 0x2b) c = b[++i]!;
        if ((c - 0x30) >>> 0 >= 10) return i >= length ? more(element, f) : fail(element, f);
        let e = 0;
        do {
          if (e < 10_000) e = e * 10 + (c - 0x30);
          c = b[++i]!;
        } while ((c - 0x30) >>> 0 < 10);
        p += negative ? -e : e;
      }
      // A number the region cut may have more digits after the cut.
      if (i >= length) return more(element, f);
      // Past 15 digits the integer may not be exact; past 1e22 the power of ten is not.
      if (digits > 15 || p > 22 || p < -22) return fail(element, f);
      const x = p === 0 ? m : p > 0 ? m * POW10[p]! : m / POW10[-p]!;
      v = neg ? -x : x;
    }
    // A comma right after the element is the common case: whitespace is looked for only when it is not.
    if (c !== 0x2c) {
      while (isSpaceByte(c)) c = b[++i]!;
      if (c === 0x5d) {
        out[f++] = v;
        filled = f;
        return i;
      }
      if (c !== 0x2c) return i >= length ? more(element, f) : fail(element, f);
    }
    out[f++] = v;
    if (f > room) return TOO_MANY;
    c = b[++i]!;
    if (c <= 0x20) while (isSpaceByte(c)) c = b[++i]!;
    if (i >= length) return more(i, f);
  }
}

const LITERALS = [
  new TextEncoder().encode("null"),
  new TextEncoder().encode("true"),
  new TextEncoder().encode("false"),
];

/**
 * The length of the `null`, `true` or `false` at `b[i]` (whose first byte is `c`), 0 for none, -1 when the region
 * (`length` bytes, then a zero byte) ends inside what could still be one.
 */
function literalLength(b: Uint8Array, i: number, length: number, c: number): number {
  const lit = c === 0x6e ? LITERALS[0]! : c === 0x74 ? LITERALS[1]! : c === 0x66 ? LITERALS[2]! : undefined;
  if (lit === undefined) return 0;
  for (let k = 1; k < lit.length; k++) if (b[i + k] !== lit[k]) return i + k >= length ? -1 : 0;
  return lit.length;
}

function more(at: number, f: number): number {
  resumeAt = at;
  filled = f;
  return MORE;
}

/** `numbersIn` refusing the element at `at`, with `f` elements before it (each followed by a comma). */
function fail(at: number, f: number): number {
  failAt = at;
  filled = f;
  return NOT_NUMBERS;
}

/** Lets go of the last numbers read, once they are kept or dropped. */
export function clearNumbers(): void {
  numbersRead = [];
}
