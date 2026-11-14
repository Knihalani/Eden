import { clearNumbers, NOT_NUMBERS, numbersRead, readNumbers, TOO_MANY, unescapeText } from "./readers";

/**
 * The shape check that runs before every `JSON.parse` of a peer's JSON: how deep it nests and how many values it
 * holds, counted outside strings (each `[`, `{` and `,`), so a body padded to make the parse costly (4 M small numbers
 * took 106-134 ms, 4 M nested arrays 453-665 ms, where an 8 MB string took 4-7 ms) is refused before the parse.
 *
 * `bodyShapeWithin` and `stringEnd` are vendored from Eden's `@eden/protocol` (`validate.ts`, D100, D1840, D1870), so
 * this directory imports nothing from outside it; `shape.test.ts` fails when the two copies differ. `textShapeWithin`
 * is the same scan over a decoded string, for a reply read natively as text (D1860): it gives the byte scan's answer
 * on the bytes the string was decoded from (structure is ASCII, and UTF-8 never puts a quote or a backslash inside a
 * multi-byte character, nor does decoding with replacement swallow an ASCII byte), which `shape.test.ts` checks on
 * seeded random bodies.
 */

/** The bounds Eden's server uses (D100's 1,000 levels and 1,000,000 values, plus room for an envelope). */
export const MAX_JSON_DEPTH = 1_008;
export const MAX_JSON_VALUES = 1_010_000;

/** Whether a JSON body's bytes are within `MAX_JSON_DEPTH` and `MAX_JSON_VALUES`. Not a JSON check. */
export function bodyShapeUnder(bytes: Uint8Array): boolean {
  return bodyShapeWithin(bytes, MAX_JSON_DEPTH, MAX_JSON_VALUES);
}

/** `bodyShapeUnder` over a decoded string: the same answer as on the bytes it was decoded from. */
export function textShapeUnder(text: string): boolean {
  return textShapeWithin(text, MAX_JSON_DEPTH, MAX_JSON_VALUES);
}

// ---- vendored from packages/protocol/src/validate.ts: keep identical (shape.test.ts) ----

/** `bodyShapeUnder` with its bounds given: the tests compare it with the plain byte loop at small bounds. */
export function bodyShapeWithin(bytes: Uint8Array, maxDepth: number, maxValues: number): boolean {
  const n = bytes.length;
  let depth = 0;
  let values = 0;
  for (let i = 0; i < n; i++) {
    // Most bytes outside strings are digits, letters and whitespace: one table load passes them.
    const k = SHAPE_BYTE[bytes[i]!]!;
    if (k === 0) continue;
    if (k === QUOTE) i = stringEnd(bytes, i + 1);
    else if (k === OPEN) {
      if (++depth > maxDepth || ++values > maxValues) return false;
    } else if (k === CLOSE) depth--;
    else if (++values > maxValues) return false;
  }
  return true;
}

const QUOTE = 1;
const OPEN = 2;
const CLOSE = 3;
const COMMA = 4;
/** What each byte is to the shape scan outside strings: 0 for nothing. */
const SHAPE_BYTE = new Uint8Array(256);
SHAPE_BYTE[0x22] = QUOTE;
SHAPE_BYTE[0x5b] = SHAPE_BYTE[0x7b] = OPEN;
SHAPE_BYTE[0x5d] = SHAPE_BYTE[0x7d] = CLOSE;
SHAPE_BYTE[0x2c] = COMMA;

/**
 * The next `byte` at or after `from`, or -1. On V8 (Node), `Uint8Array.prototype.indexOf` reads a byte at a time (627
 * µs a MiB) where `Buffer`'s searches natively (16 µs); on JSC (Bun) the typed array's own is the native one (13-16
 * µs), so it is kept there (D1870).
 */
type ByteSearch = (this: Uint8Array, byte: number, from: number) => number;
/** Node's `Buffer.prototype.indexOf`, off Bun only; it searches any `Uint8Array` it is called on. */
const bufferIndexOf: ByteSearch | undefined =
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
    ? (globalThis as { Buffer?: { prototype?: { indexOf?: ByteSearch } } }).Buffer?.prototype?.indexOf
    : undefined;
const indexOfByte = bufferIndexOf
  ? (bytes: Uint8Array, byte: number, from: number) => bufferIndexOf.call(bytes, byte, from)
  : (bytes: Uint8Array, byte: number, from: number) => bytes.indexOf(byte, from);

/**
 * The index of the quote that ends the string whose text starts at `i`, or `bytes.length` when it does not end (an
 * unended string holds no structure). A backslash escapes the next byte (a quote among them), so a quote ends the
 * string when the run of backslashes right before it is even. UTF-8 never puts 0x22 or 0x5c inside a multi-byte
 * character, so a byte scan cannot misread one. Strings are most of a reply's bytes, and a byte loop over them cost
 * six times the parse (113 µs a 64 KB result against 19): past a short run read byte by byte (most strings are short),
 * the next quote is found with the native `indexOf` and only the backslashes right before it are read. D1840 searched
 * for the next backslash too and read on byte by byte from each one, so text with an escaped newline or quote every
 * few dozen bytes, as tool output is, cost 0.8-1.0 ms a MiB, as much as its parse; this reads it in 0.3 (D1870). Where
 * escaped quotes come less than 4 bytes apart (JSON written as text, a run of `\"`) a search each would cost more than
 * the loop, so the loop reads a window that doubles while they stay that close. Each search starts past the last quote
 * and each byte is read at most twice, so the scan stays linear.
 */
function stringEnd(bytes: Uint8Array, i: number): number {
  const n = bytes.length;
  let run = 32;
  for (;;) {
    const stop = i + run < n ? i + run : n;
    for (; i < stop; i++) {
      const s = bytes[i]!;
      if (s === 0x5c) i++;
      else if (s === 0x22) return i;
    }
    if (i >= n) return n;
    // No escape is open at `i`, so the run of backslashes before the next quote starts at or after it.
    const q = indexOfByte(bytes, 0x22, i);
    if (q < 0) return n;
    let b = q - 1;
    while (b >= i && bytes[b]! === 0x5c) b--;
    if (((q - 1 - b) & 1) === 0) return q;
    run = q - i < 4 ? Math.min(Math.max(run * 2, 16), 4096) : 0;
    i = q + 1;
  }
}

// ---- end of the vendored copy ----

/**
 * `bodyShapeWithin` over a string, code unit by code unit: a character outside ASCII is never structure, as a byte of
 * a multi-byte character never is. Strings are crossed with the string's native `indexOf`, as `stringEnd` does.
 */
export function textShapeWithin(text: string, maxDepth: number, maxValues: number): boolean {
  return scanText(text, maxDepth, maxValues, newTextShape(text, false)) === WITHIN;
}

/** `scanText`'s answers. */
export const WITHIN = 0;
export const OVER = 1;
/** The scan spent its step budget outside strings and stopped; `scanText` again goes on from where it stopped. */
export const STOPPED = 2;

/** What the scan saw besides its answer, for the parse that follows it (`json.ts`, D1870, D1900). */
export interface TextShape {
  /** Values counted (each `[`, `{` and `,` outside strings); after `rest`, a bound on them. */
  values: number;
  depth: number;
  /** Where the scan goes on from. */
  at: number;
  /** Steps outside strings and pieces left before the scan stops (`STOPPED`); `Infinity` for none. */
  budget: number;
  /** Whether the scan may read what `JSON.parse` reads slowly (`readers.ts`) and bound a rest (`restWithin`). */
  read: boolean;
  /** Each piece's range: from its opening quote or bracket to past its closing one. */
  pieces: number[];
  /** Each piece's value as read, or `PLAIN_STRING` for a long string to be checked and sliced when spliced. */
  found: unknown[];
  /** Values counted inside the pieces (a number array's). */
  inPieces: number;
  /** Whether a long string may still have its end guessed: once a reply. */
  guess: boolean;
  /** Where the rest was bounded from (`restWithin`), once a reply; -1 before. */
  restFrom: number;
  /** The next backslash at or after the last long string's start (2^32 - 1 for none), -1 before any. */
  slash: number;
}

export function newTextShape(text: string, read: boolean, budget = Infinity): TextShape {
  return {
    values: 0,
    depth: 0,
    at: 0,
    budget,
    read,
    pieces: [],
    found: [],
    inPieces: 0,
    guess: read && text.length > LONG_REPLY.guessAfter,
    restFrom: -1,
    slash: -1,
  };
}

/** A long string with no escape may be its own value: a slice of the reply, checked when spliced. */
export const PLAIN_STRING = Symbol("plain string");
/** A string this long costs more to parse than to splice out of the parse (D1870). */
export const LONG_STRING = 32 * 1024;
const MAX_PIECES = 16;

/**
 * Where the long-reply path starts (D1900); the tests lower them to drive every path with small bodies, and put them
 * back (`json.test.ts`).
 */
export const LONG_REPLY = {
  /** A reply this long takes the long-reply path (`json.ts`); shorter ones cost too little for it to pay. */
  body: 16 * 1024,
  /** A string this long with no escape is spliced in as a slice. */
  string: LONG_STRING,
  /** A number array this long is read by `readNumbers` and kept out of `JSON.parse`. */
  numbers: 512,
  /** A string crossed this far by searching quote by quote has its end guessed. */
  guessAfter: 4_096,
  /** Steps outside strings, and strings, the backward read of a reply's tail takes before it gives up. */
  tailSteps: 4_096,
  /** Steps outside strings and pieces the scan takes, plus one for every 256 characters, before it tries the bound. */
  steps: 4_096,
};
/** Whether a string with dense escapes is read by `unescapeText`: on JSC (Bun); V8's `JSON.parse` reads it faster. */
export const UNESCAPE_DENSE = { on: typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" };
/** `textStringEnd`'s answer when the scan should try `restWithin` from `restFrom` before going on. */
const ASK_REST = -3;

/**
 * The scan behind `textShapeWithin`, from where `seen` stopped (D1860, D1870, D1900): its answer is the plain scan's.
 * With `seen.read` on, a long reply is also read on the way where `JSON.parse` would read it slowly or the scan would
 * cost as much as the parse:
 *
 * - a long string whose escapes would cost a search each (tool output's lines, JSON written as text) has its end
 *   guessed from the back of the reply and proven by reading it whole (`readLongString`): on Bun with `unescapeText`
 *   when its escapes are a dozen bytes apart or closer, else by parsing that one literal; when no end can be guessed
 *   or the guess is wrong, the rest of the reply from there is bounded without lexing it (`restWithin`);
 * - an array of plain numbers is read as it is scanned (`readNumbers`), for less than scanning and then parsing it;
 * - a long string with no escape is recorded, to be spliced in as a slice of the reply.
 *
 * Every read is bounded by what it reads and counted against the scan's bounds as the scan counts: a number array's
 * commas as they are read, and a string holds no values. With a finite `seen.budget` it stops after that many steps
 * outside strings and pieces, so a reply that is mostly structure can be bounded more cheaply (`textBoundWithin`).
 */
export function scanText(text: string, maxDepth: number, maxValues: number, seen: TextShape): number {
  const n = text.length;
  let depth = seen.depth;
  let values = seen.values;
  // Each step outside strings costs about a nanosecond and a half; a reply that is mostly structure costs the scan
  // as much as its parse.
  let stop = seen.budget < n - seen.at ? seen.at + seen.budget : n;
  let i = seen.at;
  for (; i < stop; i++) {
    const c = text.charCodeAt(i);
    const k = c < 128 ? SHAPE_BYTE[c]! : 0;
    if (k === 0) continue;
    if (k === QUOTE) {
      const start = i + 1;
      const pieces = seen.pieces.length;
      let end = textStringEnd(text, start, seen);
      if (end === ASK_REST) {
        const rest = restWithin(text, seen.restFrom, maxDepth - depth, maxValues - values);
        if (rest >= 0) {
          // Whatever the rest holds, it cannot pass the bounds: the scan ends here.
          seen.values = values + rest;
          seen.at = n;
          return WITHIN;
        }
        end = textStringEnd(text, start, seen);
      }
      if (seen.read && seen.pieces.length === pieces && pieces < 2 * MAX_PIECES && end - start >= LONG_REPLY.string) {
        // Only one with no backslash can be its own characters (`json.ts` checks for control characters). The next
        // backslash is kept, and searched for again only once passed, so these searches cross the reply once.
        if (seen.slash < start) seen.slash = text.indexOf("\\", start) >>> 0;
        if (seen.slash > end && end < n) push(seen, i, end + 1, PLAIN_STRING);
      }
      // Strings are crossed by search, not counted against the budget: move the stop on by what was crossed.
      if (stop < n) stop = Math.min(n, stop + (end - i));
      i = end;
    } else if (k === OPEN) {
      if (++depth > maxDepth || ++values > maxValues) return OVER;
      if (c !== 0x5b || !seen.read || seen.pieces.length >= 2 * MAX_PIECES) continue;
      const end = readNumbers(text, i, maxValues - values);
      if (end === NOT_NUMBERS) continue;
      if (end === TOO_MANY) return OVER;
      // The array's commas, as the scan counts them, and its closing bracket.
      const read = numbersRead;
      clearNumbers();
      values += read.length - 1;
      depth--;
      if (read.length >= LONG_REPLY.numbers) {
        push(seen, i, end + 1, read);
        seen.inPieces += read.length;
      }
      if (stop < n) stop = Math.min(n, stop + (end - i));
      i = end;
    } else if (k === CLOSE) depth--;
    else if (++values > maxValues) return OVER;
  }
  seen.depth = depth;
  seen.values = values;
  if (i < n) {
    seen.at = i;
    seen.budget = 0;
    return STOPPED;
  }
  seen.at = n;
  return WITHIN;
}

function push(seen: TextShape, from: number, to: number, value: unknown): void {
  seen.pieces.push(from, to);
  seen.found.push(value);
}

/** `stringEnd` over a string; with `seen.read`, a long string whose escapes cost a search each is read apart. */
function textStringEnd(text: string, start: number, seen: TextShape): number {
  const n = text.length;
  let i = start;
  let run = 32;
  for (;;) {
    const stop = i + run < n ? i + run : n;
    for (; i < stop; i++) {
      const s = text.charCodeAt(i);
      if (s === 0x5c) i++;
      else if (s === 0x22) return i;
    }
    if (i >= n) return n;
    if (seen.guess && i - start > LONG_REPLY.guessAfter) {
      // On Bun, escapes a dozen bytes apart or closer cost `JSON.parse` more than reading them here does.
      const sample = LONG_REPLY.guessAfter;
      let escapes = 0;
      if (UNESCAPE_DENSE.on) for (let j = start; j < start + sample; j++) if (text.charCodeAt(j) === 0x5c) escapes++;
      const end = readLongString(text, start, i, seen, escapes * 12 >= sample && escapes > 0);
      if (end >= 0) return end;
      // No end guessed (a long tail) or a wrong one: the rest of the reply is bounded instead, where it can be.
      seen.restFrom = i;
      return ASK_REST;
    }
    // No escape is open at `i`, so the run of backslashes before the next quote starts at or after it.
    const q = text.indexOf('"', i);
    if (q < 0) return n;
    let b = q - 1;
    while (b >= i && text.charCodeAt(b) === 0x5c) b--;
    if (((q - 1 - b) & 1) === 0) return q;
    run = q - i < 4 ? Math.min(Math.max(run * 2, 16), 4096) : 0;
    i = q + 1;
  }
}

/**
 * The end of the long string whose text starts at `start`, crossed as far as `at` with no end found, read without a
 * search per escaped quote (D1900); -1 when it cannot be (the scan then goes on quote by quote, and no other string of
 * this reply is tried). Tool output is mostly one long string near the reply's end with a short tail after it, so its
 * closing quote is guessed from the back (`guessEnd`) and the guess proven by reading the string whole: a dense one by
 * `unescapeText`, a sparse one by `JSON.parse` of that one literal. Either fails on a raw quote before the guessed end,
 * so it succeeds exactly when the guess is the string's end. A string literal cannot nest or hold values, so reading
 * it is bounded by its length, as the shape check requires of any parse before it. Its value is kept for the parse
 * that follows (`json.ts` splices it in), so this read replaces that string's share of the reply's parse. A wrong
 * guess costs at most one read of the string's text, once a reply.
 */
function readLongString(text: string, start: number, at: number, seen: TextShape, dense: boolean): number {
  seen.guess = false;
  const end = guessEnd(text, at);
  if (end < 0) return -1;
  let value: string | undefined;
  if (dense) value = unescapeText(text, start, end);
  if (value === undefined) {
    try {
      const v: unknown = JSON.parse(text.slice(start - 1, end + 1));
      if (typeof v === "string") value = v;
    } catch {
      return -1;
    }
  }
  if (value === undefined) return -1;
  push(seen, start - 1, end + 1, value);
  return end;
}

/**
 * The closing quote of the long string being crossed, guessed by reading the reply backward from its end, or -1.
 * Read backward outside strings, the first quote met closes a string, and its opening quote is the nearest quote before
 * it with an even run of backslashes before that (whether a quote is escaped depends only on the backslashes right
 * before it). A closing quote whose opening quote is not found after `at`, or only past four escaped quotes, is taken
 * as the long string's end. Only a guess: `readLongString` proves it.
 */
function guessEnd(text: string, at: number): number {
  let i = text.length - 1;
  let steps = 0;
  while (i > at) {
    if (++steps > LONG_REPLY.tailSteps) return -1;
    if (text.charCodeAt(i) !== 0x22) {
      i--;
      continue;
    }
    let j = i;
    for (let hops = 0; ; hops++) {
      j = text.lastIndexOf('"', j - 1);
      // At or before `at` lies only the long string itself.
      if (j <= at) return i;
      let b = j - 1;
      while (text.charCodeAt(b) === 0x5c) b--;
      if (((j - 1 - b) & 1) === 0) break;
      if (hops === 4) return i;
    }
    i = j - 1;
  }
  return -1;
}

/**
 * A bound on what the scan would count in `text[from, n)` that does not lex it (D1900): every `[` and `{` there,
 * inside strings or not, bounds the depth it adds, and those with every `,` the values. The values bound when it is
 * within `maxDepth` and `maxValues`, else -1, so `>= 0` means the scan's answer from `from` on is "within" too. Each
 * count is the string's native `indexOf`, a few nanoseconds a hit, where the scan steps over every character outside
 * strings and searches for every escaped quote in one; the commas are counted only as far as they must be: once the
 * commas found plus every character not yet searched fit in the room left, the rest cannot pass the bound, and past a
 * hit for every sixteen characters it gives up.
 */
function restWithin(text: string, from: number, maxDepth: number, maxValues: number): number {
  let opens = 0;
  for (let i = text.indexOf("[", from); i >= 0; i = text.indexOf("[", i + 1)) if (++opens > maxDepth) return -1;
  for (let i = text.indexOf("{", from); i >= 0; i = text.indexOf("{", i + 1)) if (++opens > maxDepth) return -1;
  const room = maxValues - opens;
  const n = text.length;
  const hits = (n - from) >>> 4;
  let commas = 0;
  let p = from;
  while (commas + (n - p) > room) {
    const q = text.indexOf(",", p);
    if (q < 0) return commas <= room ? opens + commas : -1;
    if (++commas > room || commas > hits) return -1;
    p = q + 1;
  }
  return opens + commas + (n - p);
}

/** `restWithin` over the whole text, as a yes or no: `true` means `textShapeWithin` is `true` too. */
export function textBoundWithin(text: string, maxDepth: number, maxValues: number): boolean {
  return restWithin(text, 0, maxDepth, maxValues) >= 0;
}
