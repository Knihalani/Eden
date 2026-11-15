import {
  clearNumbers,
  firstRegionReadsBytes,
  lastElementReads,
  lastElementReadsBytes,
  NOT_JSON,
  NOT_NUMBERS,
  numbersRead,
  numbersStop,
  readNumbers,
  TOO_MANY,
  UNESCAPE_MOST,
  unescapeText,
} from "./readers";

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
 * `bodyShapeWithin` that gives up (`STOPPED`) on reaching what the long-reply path reads faster from the decoded text
 * (`json.ts`, D1904): a string crossed `LONG_REPLY.guessAfter` bytes with escaped quotes every few dozen bytes (tool
 * output, JSON written as text: the search per escaped quote costs this scan as much as the parse), or an array that
 * has gone `2 * LONG_REPLY.numbers - 2` bytes past its bracket with nothing but numbers' characters, commas and spaces,
 * whose next `]` is far enough and whose last element the reader reads (D1919). Otherwise its answer is
 * `bodyShapeWithin`'s, at its cost: the reply is mostly structure or plain strings, which the text path would only
 * scan again. With `stop` off it never gives up, and notes in `byteSawRead` whether it met such a string or such an
 * array (any that has gone that far: the checks are not made); `byteLongString` notes a string long enough for the
 * text path to slice or guess (D1909: a body with neither is parsed as main parses it, as is a multi-byte one with no
 * such place).
 */
export function byteShapeOrStop(bytes: Uint8Array, maxDepth: number, maxValues: number, stop = true): number {
  const n = bytes.length;
  let depth = 0;
  let values = 0;
  // The bracket of the array that may be a number array; `n` for none, so one compare a comma tests it. The values
  // counted at it, so the commas since are known.
  let cand = n;
  let candValues = 0;
  const reach = 2 * LONG_REPLY.numbers - 2;
  byteSawRead = byteLongString = false;
  nextClose = nextQuote = nextBracket = -1;
  // A string this long may be sliced or have its end guessed by the text path: shorter ones it only crosses.
  const long = Math.min(LONG_REPLY.string, LONG_REPLY.guessAfter + 1);
  for (let i = 0; i < n; i++) {
    let k = BYTE_KIND[bytes[i]!]!;
    if (k === 0) {
      // Digits, letters and spaces, in a loop of their own: with `continue` instead, JSC ran this scan at 1.4-2 ns a
      // byte of numbers against main's 0.95 (D1919: the bytes path cost 1.15-1.3x main on long number arrays).
      while (++i < n && (k = BYTE_KIND[bytes[i]!]!) === 0);
      if (i >= n) break;
    }
    if (k === QUOTE) {
      // Once a place is noted, the plain `stringEnd`; a string first crossed to its stop is crossed again from its
      // start, once a body, so at most twice.
      const end = byteSawRead ? stringEnd(bytes, i + 1) : stringEndOrStop(bytes, i + 1);
      if (end < 0) {
        if (stop) return STOPPED;
        byteSawRead = true;
        i = stringEnd(bytes, i + 1);
      } else {
        if (end - i > long) byteLongString = true;
        i = end;
      }
      cand = n;
    } else if (k === COMMA) {
      if (++values > maxValues) return OVER;
      if (i - cand >= reach) {
        if (stop && readsAt(bytes, cand, values - candValues, i)) return STOPPED;
        if (!stop) byteSawRead = true;
        cand = n;
      }
    } else if (k === CLOSE) {
      depth--;
      cand = n;
    } else {
      if (++depth > maxDepth || ++values > maxValues) return OVER;
      cand = k === OPEN ? i : n;
      candValues = values;
    }
  }
  return WITHIN;
}

/**
 * Whether the text path would read the number array opened at `from` (`numberArrayAt`'s checks, on bytes), having
 * met `commas` commas up to `at`: the byte scan stops only there, since elsewhere the text scan would cross what it
 * crosses for less (D1919: an array the reader gave up cost the bytes path 1.1-1.2x main). Its first region is read
 * too (`firstRegionReadsBytes`), which the text check leaves to the reader itself: an array of computed doubles ends
 * in one the reader reads, but it gives the array up at its third (stopping there cost 16 MiB of 16-digit floats nested
 * 200 deep 1.1-1.2x main). Asked only of a body the scan may stop on: a longer one is scanned whole, and there the
 * searches for the `]` and the quote crossed a 16 MiB flood twice before it was refused (1.3x main). Kept out of
 * `byteShapeOrStop`, whose size sets how soon JSC compiles it (inline, a refused depth bomb cost 0.3-0.5 µs more).
 */
function readsAt(bytes: Uint8Array, from: number, commas: number, at: number): boolean {
  if (nextClose < from) nextClose = indexOfByte(bytes, 0x5d, from) >>> 0;
  if (nextQuote < from) nextQuote = indexOfByte(bytes, 0x22, from) >>> 0;
  if (nextBracket <= from) nextBracket = indexOfByte(bytes, 0x5b, from + 1) >>> 0;
  return (
    nextClose < bytes.length &&
    nextClose - from >= 2 * LONG_REPLY.numbers - 1 &&
    nextQuote > nextClose &&
    nextBracket > nextClose &&
    enoughElements(commas, from, at, nextClose) &&
    lastElementReadsBytes(bytes, from, nextClose) &&
    firstRegionReadsBytes(bytes, from)
  );
}

/**
 * Whether an array opened at `open` that has met `commas` commas up to `at`, and whose next `]` is at `close`, holds
 * `LONG_REPLY.numbers` elements or more at that rate: a shorter one is crossed by the scans and parsed, since reading
 * it, keeping none of it, cost more than crossing it (D1919: 1 MB of arrays of 202 twelve-digit numbers cost the
 * bytes path 1.4x main, stopping at the first for the text path).
 */
function enoughElements(commas: number, open: number, at: number, close: number): boolean {
  return commas * (close - open) >= LONG_REPLY.numbers * (at - open);
}
/**
 * The next `]`, quote and `[` (past its own) at or after the last array `readsAt` checked (2^32 - 1 for none), -1
 * before: each searched for again only once the scan has passed it, so each search crosses a body once.
 */
let nextClose = -1;
let nextQuote = -1;
let nextBracket = -1;

/** Whether the last `byteShapeOrStop` with `stop` off met a place where it would have stopped. */
export let byteSawRead = false;
/** Whether the last `byteShapeOrStop` crossed a string the text path may slice or guess the end of. */
export let byteLongString = false;

/** `SHAPE_BYTE` with `{` apart from `[` (`OPEN`). */
const BRACE = 5;
const BYTE_KIND = SHAPE_BYTE.slice();
BYTE_KIND[0x7b] = BRACE;

/** `stringEnd`, or -1 once the string has run `LONG_REPLY.guessAfter` bytes with more than 8 escaped quotes. */
function stringEndOrStop(bytes: Uint8Array, i: number): number {
  const n = bytes.length;
  const start = i;
  let run = 32;
  let hops = 0;
  for (;;) {
    const stop = i + run < n ? i + run : n;
    for (; i < stop; i++) {
      const s = bytes[i]!;
      if (s === 0x5c) i++;
      else if (s === 0x22) return i;
    }
    if (i >= n) return n;
    if (hops > 8 && i - start > LONG_REPLY.guessAfter) return -1;
    const q = indexOfByte(bytes, 0x22, i);
    if (q < 0) return n;
    let b = q - 1;
    while (b >= i && bytes[b]! === 0x5c) b--;
    if (((q - 1 - b) & 1) === 0) return q;
    hops++;
    run = q - i < 4 ? Math.min(Math.max(run * 2, 16), 4096) : 0;
    i = q + 1;
  }
}

/**
 * `bodyShapeWithin` over a string, code unit by code unit: a character outside ASCII is never structure, as a byte of
 * a multi-byte character never is. Strings are crossed with the string's native `indexOf`, as `stringEnd` does.
 */
export function textShapeWithin(text: string, maxDepth: number, maxValues: number): boolean {
  return plainScan(text, 0, 0, 0, maxDepth, maxValues);
}

/** `textShapeWithin` from `from`, with `depth` and `values` counted before it. */
export function plainScan(
  text: string,
  from: number,
  depth: number,
  values: number,
  maxDepth: number,
  maxValues: number,
) {
  const n = text.length;
  // Kept apart from `scanText`, with nothing but the check in its loop: short replies and the plain path pay for no
  // reading, and the JIT compiles this loop alone (sharing it cost short replies 4-20%, D1900's review).
  for (let i = from; i < n; i++) {
    const c = text.charCodeAt(i);
    const k = c < 128 ? SHAPE_BYTE[c]! : 0;
    if (k === 0) continue;
    if (k === QUOTE) i = plainStringEnd(text, i + 1);
    else if (k === OPEN) {
      if (++depth > maxDepth || ++values > maxValues) return false;
    } else if (k === CLOSE) depth--;
    else if (++values > maxValues) return false;
  }
  return true;
}

/** `stringEnd` over a string. */
function plainStringEnd(text: string, i: number): number {
  const n = text.length;
  let run = 32;
  for (;;) {
    const stop = i + run < n ? i + run : n;
    for (; i < stop; i++) {
      const s = text.charCodeAt(i);
      if (s === 0x5c) i++;
      else if (s === 0x22) return i;
    }
    if (i >= n) return n;
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

/** `scanText`'s answers. */
export const WITHIN = 0;
export const OVER = 1;
/** The scan spent its step budget outside strings and stopped; `scanText` again goes on from where it stopped. */
export const STOPPED = 2;
/**
 * The reply is not JSON: a number array holds what no JSON array does (`NOT_JSON`), so `JSON.parse` would throw
 * (D1919). The plain scan's answer may be either; the reply's is undefined both ways.
 */
export const NOT_JSON_REPLY = 3;

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
  /**
   * Whether a long string with no escape may be recorded to be sliced (`PLAIN_STRING`): off for a body the bytes path
   * decoded from multi-byte UTF-8 (D1909), where the check for a backslash or control character over a string of
   * two-byte characters costs as much as the copy `JSON.parse` would make (0.7 against 0.8 ms for 1.2 M characters).
   */
  slices: boolean;
  /** Each piece's range: from its opening quote or bracket to past its closing one. */
  pieces: number[];
  /** Each piece's value as read, or `PLAIN_STRING` for a long string to be checked and sliced when spliced. */
  found: unknown[];
  /** Values counted inside the pieces (a number array's). */
  inPieces: number;
  /** Whether a long string may still have its end guessed: once a reply. */
  guess: boolean;
  /**
   * Whether the byte scan has already found the reply within its bounds (`json.ts`): a long string read apart is
   * then the only thing left to gain, and the rest is never bounded again (D1909).
   */
  known: boolean;
  /** Where the rest was bounded from (`restWithin`), once a reply; -1 before. */
  restFrom: number;
  /** The next `[` past the last array the scan asked about (2^32 - 1 for none), -1 before. */
  bracket: number;
  /** The `[` of an array that may be a number array, -1 for none, and the values counted at it (`scanText`). */
  cand: number;
  candValues: number;
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
    known: false,
    slices: true,
    restFrom: -1,
    bracket: -1,
    cand: -1,
    candValues: 0,
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
 * The scan behind `textShapeWithin`, from where `seen` stopped (D1860, D1870, D1900): its answer is the plain scan's,
 * or `NOT_JSON_REPLY` for a reply that is not JSON (D1919). With `seen.read` on, a long reply is also read on the way
 * where `JSON.parse` would read it slowly or the scan would cost as much as the parse:
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
  // The `[` of the array that may be a number array, and the values counted when the scan passed it.
  let cand = seen.cand;
  let candValues = seen.candValues;
  // How far past its bracket a candidate must go before it is read: as far as `LONG_REPLY.numbers` elements reach.
  const reach = 2 * LONG_REPLY.numbers - 2;
  for (; i < stop; i++) {
    const c = text.charCodeAt(i);
    const k = c < 128 ? SHAPE_BYTE[c]! : 0;
    if (k === 0) continue;
    if (k === QUOTE) {
      const start = i + 1;
      const pieces = seen.pieces.length;
      let end = textStringEnd(text, start, seen);
      if (end === ASK_REST) {
        if (seen.known) {
          // Already within (the byte scan): bounding the rest again, then crossing the string quote by quote, cost
          // an escaped string past 4 MiB 1.21-1.27x main's CPU (D1909). The scan ends here, with the rest's length
          // as a bound on its values, so the parse that follows takes the whole reply unless the pieces read pay.
          seen.values = values + (n - i);
          seen.at = n;
          return WITHIN;
        }
        const rest = restWithin(text, seen.restFrom, maxDepth - depth, maxValues - values);
        if (rest >= 0) {
          // Whatever the rest holds, it cannot pass the bounds: the scan ends here.
          seen.values = values + rest;
          seen.at = n;
          return WITHIN;
        }
        end = textStringEnd(text, start, seen);
      }
      if (
        seen.read &&
        seen.slices &&
        seen.pieces.length === pieces &&
        pieces < 2 * MAX_PIECES &&
        end - start >= LONG_REPLY.string
      ) {
        // Perhaps its own characters: `json.ts` checks it holds no backslash or control character before slicing it.
        if (end < n) push(seen, i, end + 1, PLAIN_STRING);
      }
      // Strings are crossed by search, not counted against the budget: move the stop on by what was crossed.
      if (stop < n) stop = Math.min(n, stop + (end - i));
      i = end;
      cand = -1;
    } else if (k === OPEN) {
      if (++depth > maxDepth || ++values > maxValues) return OVER;
      // An array is a candidate number array: it is scanned as usual until it has gone on far enough to be worth
      // reading, and any quote, bracket or brace on the way drops it (`readNumbers` checks what it starts with).
      cand = c === 0x5b ? i : -1;
      candValues = values;
    } else if (k === CLOSE) {
      depth--;
      cand = -1;
    } else {
      if (++values > maxValues) return OVER;
      if (cand < 0 || i - cand < reach || !seen.read || seen.pieces.length >= 2 * MAX_PIECES) continue;
      // A candidate this long with nothing but numbers' characters, commas and spaces so far: read it whole from its
      // bracket, counting its commas as the scan counts them; when it is not a number array, the scan goes on here,
      // or from where the reader stopped.
      const from = cand;
      cand = -1;
      const end = numberArrayAt(text, from, maxValues - candValues, seen, values - candValues, i);
      if (end === NOT_NUMBERS) {
        // Everything from the array's first element to where the reader stopped is numbers, `null`, `true`, `false`,
        // commas and spaces, in which the scan only counts the commas: it goes on from there with them counted (D1919),
        // rather than crossing again what the reader read.
        const at = numbersStop.at;
        if (at > i) {
          values = candValues + numbersStop.commas;
          if (stop < n) stop = Math.min(n, stop + (at - i));
          i = at - 1;
        }
        continue;
      }
      if (end === TOO_MANY) return OVER;
      if (end === NOT_JSON) return NOT_JSON_REPLY;
      const read = numbersRead;
      clearNumbers();
      values = candValues + read.length - 1;
      depth--;
      if (read.length >= LONG_REPLY.numbers) {
        push(seen, from, end + 1, read);
        seen.inPieces += read.length;
      }
      if (stop < n) stop = Math.min(n, stop + (end - i));
      i = end;
    }
  }
  seen.depth = depth;
  seen.values = values;
  seen.cand = cand;
  seen.candValues = candValues;
  if (i < n) {
    seen.at = i;
    seen.budget = 0;
    return STOPPED;
  }
  seen.at = n;
  return WITHIN;
}

/**
 * `readNumbers` at the `[` at `open`, asked only of a candidate that has gone on far enough to be worth reading
 * (D1902's review: a call for every `[` before a digit cost a `[[1,2,3],...]` matrix 2.7-2.9 times main's scan), and
 * only when the next `]` (where a number array closes) is far enough for `LONG_REPLY.numbers` elements and no quote
 * or `[` comes before it (a string is not a number; a nested array makes no number array). The next `[` is kept and
 * searched for again only once the scan has passed it, the `]` only up to that `[`, and the quote only between the
 * brackets, so each search covers a stretch no other call's does: together they cross the reply once, however deep
 * its arrays nest, and never past the array a refused reply is refused in. An array whose commas so far, at the same
 * rate up to that `]`, make fewer than `LONG_REPLY.numbers` elements is left to the scan (read, it would not be kept:
 * `enoughElements`), and the last element is read first (`lastElementReads`), so an array that ends in what the
 * reader leaves to `JSON.parse` is left to the scan at once (D1919). Where more elements could fit than the room
 * left, the reader counts the commas once its first region has read (`commasIn`), so a flood is refused with at most
 * a region's numbers kept, and an array that fits is made its exact length; an array that is not numbers from its
 * first element is neither counted nor allocated. A reader's `NOT_JSON` ends the scan (`NOT_JSON_REPLY`).
 *
 * Linear (D1909, D1919): `commasIn` and `readNumbers` read each character of a reply a bounded number of times. Both
 * read from `open` and stop at the next `]` or sooner: `commasIn` at any character no number array holds before its
 * `]`, `readNumbers` at the first element that is not a number it reads, a `null`, a `true` or a `false`. So what
 * either reads, `R`, holds no bracket, brace or quote. The scan asks here only once it is `reach` (1,022) characters
 * past `open`, and goes on, with the candidate dropped, from the `]` read to, or from where the reader stopped when
 * that is further (`numbersStop`: the last element of `R` or the character just past it, or the `]` once `commasIn`
 * has counted up to it, which `R` then reaches), or else from where it
 * asked. The next candidate is a later `[`, so past `R`: the `R` of successive calls do not overlap, and calls are at
 * least `reach` apart. The scan crosses again at most the element the reader stopped in. Each reader encodes regions
 * that double from 512 characters, so encodes at most twice what it reads plus 512: in all at most about 2.5 encodes
 * and reads of each character by each, and `lastElementReads` at most 130 characters a call. The array `readNumbers`
 * makes is at most one longer than `R`'s commas. Before D1909 `commasIn` counted on past a nested `[` to the innermost
 * `]`, which every level shares, so every nested candidate counted the rest of the reply (12x main's CPU at 16 MiB);
 * before D1919 the scan went on from where it asked, crossing again everything the reader read (1.3-1.6x main on a
 * long series with a gap near its end).
 */
function numberArrayAt(text: string, open: number, room: number, seen: TextShape, commas: number, at: number): number {
  // Every answer here that is not the reader's leaves the scan where it is (two placements further down went stale).
  numbersStop.at = -1;
  // A nested `[` before the `]` makes it no number array: the `]` is looked for only up to the next `[` (D1919: nested
  // levels of numbers were each read up to the next level's `[`, a region and a count of commas apiece, and the search
  // for the innermost `]` crossed a refused reply past where main's scan refuses it).
  if (seen.bracket <= open) seen.bracket = text.indexOf("[", open + 1) >>> 0;
  const window = seen.bracket < text.length ? text.slice(open, seen.bracket) : text.slice(open);
  const close = open + window.indexOf("]");
  if (close < open || close - open < 2 * LONG_REPLY.numbers - 1) return NOT_NUMBERS;
  if (!enoughElements(commas, open, at, close)) return NOT_NUMBERS;
  // No quote before it either (a string is no number): searched for up to the next `[` (the windows never overlap, so
  // the searches stay linear), and a quote past the `]` is not counted. A `{` the reader meets
  // as it would a `[`, where the scan goes on (a search for it too would cross a reply that holds none once more).
  const quote = window.indexOf('"');
  if ((quote >= 0 && quote < close - open) || !lastElementReads(text, open, close)) return NOT_NUMBERS;
  // k elements take at least 2k - 1 characters between the brackets, and k - 1 commas: where more could fit than the
  // room left, the reader counts the commas once its first region reads (counting them up to a nested `[` is what
  // keeps nested candidates linear: sizing the array from the byte scan's count instead made one that long at every
  // level: 1.05-1.19x main on the bytes path at 6-12.6 MB, against 0.92-0.97 counting).
  return readNumbers(text, open, room, (close - open) >> 1 <= room ? -1 : close);
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
  // A string past 4 MiB is left in the parse: reading it apart held a second copy of it at the peak (D1900's review).
  if (end < 0 || end - start > UNESCAPE_MOST) return -1;
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
