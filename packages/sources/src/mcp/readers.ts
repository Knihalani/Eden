/**
 * Readers for what `JSON.parse` reads slowly, used by the shape scan on its way through a long reply (`shape.ts`,
 * D1900): a long string with dense escapes (JSON written as text) and a long array of plain numbers. Each gives
 * exactly `JSON.parse`'s value or says it cannot (`long-reply.test.ts` compares them on seeded inputs), and each is
 * bounded by the bytes it reads. They read UTF-8 bytes: a region of the reply's string is encoded into a reused buffer
 * first (about 0.06 ns a byte), since a loop over a typed array costs JSC about a nanosecond a byte where `charCodeAt`
 * costs more, and `JSON.parse` takes about 16 ns an escape and 23 a number.
 */
import { isAscii } from "node:buffer";

/** Decodes as `TextDecoder` does but keeps a byte-order mark: a range that is not the body's start has none to drop. */
const keepMark = new TextDecoder("utf-8", { ignoreBOM: true });
const stripMark = new TextDecoder();
/** Node's and Bun's `Buffer.prototype.latin1Slice`: one byte a character, which ASCII decodes to as UTF-8 does. */
type Slice = (this: Uint8Array, start: number, end: number) => string;
const latin1Slice = (globalThis as { Buffer?: { prototype?: { latin1Slice?: Slice } } }).Buffer?.prototype?.latin1Slice;

/**
 * `bytes[start, end)` decoded as UTF-8, with replacement, as `TextDecoder` decodes it; a byte-order mark is dropped
 * only at the body's start (`atStart`). ASCII is copied one byte a character (`latin1Slice`, where the runtime has it),
 * which is what UTF-8 decodes it to: on Bun the string `TextDecoder` makes from the same bytes costs `JSON.parse` about
 * 40% more to read (938 against 674 µs a MiB of tool output, D1900); the ASCII check costs 15 µs a MiB.
 */
export function decodeRange(bytes: Uint8Array, start: number, end: number, atStart = false): string {
  const sub = start === 0 && end === bytes.length ? bytes : bytes.subarray(start, end);
  if (latin1Slice && isAscii(sub)) return latin1Slice.call(sub, 0, sub.length);
  return (atStart ? stripMark : keepMark).decode(sub);
}

const encoder = new TextEncoder();
/** The buffer regions are encoded into, kept while it is no larger than this (a reply's long string is often 1 MB). */
let scratch: Uint8Array = new Uint8Array(64 * 1024);
const KEEP_SCRATCH = 4 << 20;
/** The buffer the last region went into: `scratch`, or a larger one used once. */
let encoded: Uint8Array = scratch;

/**
 * `text[start, end)` as UTF-8 in `encoded`, followed by a zero byte; its length in bytes. ASCII, the common case, is
 * tried in a buffer of one byte a character; only text that does not fit is encoded again with room for three.
 */
function encodeRegion(text: string, start: number, end: number): number {
  const region = text.slice(start, end);
  for (let room = region.length; ; room = 3 * region.length) {
    const into = scratch.length > room ? scratch : new Uint8Array(room + 1);
    if (into.length <= KEEP_SCRATCH) scratch = into;
    const { read, written } = encoder.encodeInto(region, into.subarray(0, room));
    if (read === region.length) {
      into[written] = 0;
      encoded = into;
      return written;
    }
  }
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
/** The numbers the last `readNumbers` read. */
export let numbersRead: number[] = [];
/** Where, in the region `numbersIn` last read, the element it could not finish starts. */
let resumeAt = 0;
/** The first region `readNumbers` encodes, in characters; the tests make it tiny to cut numbers at every place. */
export const NUMBER_REGION = { first: 512 };

/**
 * The index in `text` of the `]` that closes the array opened at `open`, when every element is a JSON number of at most
 * 15 significant digits whose power of ten (its exponent less its decimal places) is within 22: `numbersRead` then
 * holds them. `NOT_NUMBERS` for any other array (the scan reads it as usual), and `TOO_MANY` past `room` commas, where
 * the scan would refuse it. Such a number is an integer under 2^53 times or divided by an exact power of ten, which
 * one IEEE operation rounds correctly (Clinger's fast path), so it is the double `JSON.parse` gives. The array is
 * encoded a region at a time, each twice the last, from its first element, so a reader that gives up has cost about
 * what it read (an array of arrays nested a thousand deep costs no more than one pass). 2.6-2.9 ms a MiB of numbers
 * against `JSON.parse`'s 3.0-3.6 (D1900).
 */
export function readNumbers(text: string, open: number, room: number): number {
  let i = open + 1;
  let c = text.charCodeAt(i);
  while (isSpaceByte(c)) c = text.charCodeAt(++i);
  if (!((c >= 0x30 && c <= 0x39) || c === 0x2d)) return NOT_NUMBERS;
  const out: number[] = [];
  for (let size = NUMBER_REGION.first; ; size *= 2) {
    const end = Math.min(text.length, i + size);
    const length = encodeRegion(text, i, end);
    const r = numbersIn(encoded, length, out, room);
    if (r >= 0) {
      numbersRead = out;
      // A number array is ASCII, so its bytes and its characters line up.
      return i + r;
    }
    if (r !== MORE || end === text.length) return r === MORE ? NOT_NUMBERS : r;
    i += resumeAt;
  }
}

/**
 * The elements of the encoded region `b[0, length)` added to `out`, up to its closing `]`: that `]`'s index, or
 * `MORE` (with `resumeAt`) when the region ends first. The region is followed by a zero byte, which no number,
 * separator or space is, so every loop stops there.
 */
function numbersIn(b: Uint8Array, length: number, out: number[], room: number): number {
  let i = 0;
  let c = b[0]!;
  // A region may start inside the spaces before an element.
  while (isSpaceByte(c)) c = b[++i]!;
  for (;;) {
    const element = i;
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
    } else return i >= length ? more(element) : NOT_NUMBERS;
    // A leading zero is not significant.
    let digits = m === 0 ? 0 : i - first;
    let p = 0;
    if (c === 0x2e) {
      const dot = ++i;
      c = b[i]!;
      if ((c - 0x30) >>> 0 >= 10) return i >= length ? more(element) : NOT_NUMBERS;
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
      if ((c - 0x30) >>> 0 >= 10) return i >= length ? more(element) : NOT_NUMBERS;
      let e = 0;
      do {
        if (e < 10_000) e = e * 10 + (c - 0x30);
        c = b[++i]!;
      } while ((c - 0x30) >>> 0 < 10);
      p += negative ? -e : e;
    }
    // A number the region cut may have more digits after the cut.
    if (i >= length) return more(element);
    // Past 15 digits the integer may not be exact; past 1e22 the power of ten is not.
    if (digits > 15 || p > 22 || p < -22) return NOT_NUMBERS;
    const v = p === 0 ? m : p > 0 ? m * POW10[p]! : m / POW10[-p]!;
    // A comma right after the number is the common case: whitespace is looked for only when it is not.
    if (c !== 0x2c) {
      while (isSpaceByte(c)) c = b[++i]!;
      if (c === 0x5d) {
        out.push(neg ? -v : v);
        return i;
      }
      if (c !== 0x2c) return i >= length ? more(element) : NOT_NUMBERS;
    }
    out.push(neg ? -v : v);
    if (out.length > room) return TOO_MANY;
    c = b[++i]!;
    if (c <= 0x20) while (isSpaceByte(c)) c = b[++i]!;
    if (i >= length) return more(i);
  }
}

function more(at: number): number {
  resumeAt = at;
  return MORE;
}

/** Lets go of the last numbers read, once they are kept or dropped. */
export function clearNumbers(): void {
  numbersRead = [];
}
