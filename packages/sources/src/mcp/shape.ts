/**
 * The shape check that runs before every `JSON.parse` of a peer's JSON: how deep it nests and how many values it
 * holds, counted outside strings (each `[`, `{` and `,`), so a body padded to make the parse costly (4 M small numbers
 * took 106-134 ms, 4 M nested arrays 453-665 ms, where an 8 MB string took 4-7 ms) is refused before the parse.
 *
 * `bodyShapeWithin` and `stringEnd` are vendored from Eden's `@eden/protocol` (`validate.ts`, D100, D1840, D1870), so this
 * directory imports nothing from outside it; `shape.test.ts` fails when the two copies differ. `textShapeWithin` is the
 * same scan over a decoded string, for a reply read natively as text (D1860): it gives the byte scan's answer on the
 * bytes the string was decoded from (structure is ASCII, and UTF-8 never puts a quote or a backslash inside a
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
    const q = bytes.indexOf(0x22, i);
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
export function textShapeWithin(text: string, maxDepth: number, maxValues: number, seen?: TextShape): boolean {
  const n = text.length;
  let depth = 0;
  let values = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    const k = c < 128 ? SHAPE_BYTE[c]! : 0;
    if (k === 0) continue;
    if (k === QUOTE) {
      const start = i + 1;
      i = textStringEnd(text, start);
      if (seen && i - start >= LONG_STRING && i < n && seen.longs.length < 2 * MAX_LONGS) seen.longs.push(start, i);
    } else if (k === OPEN) {
      if (++depth > maxDepth || ++values > maxValues) return false;
    } else if (k === CLOSE) depth--;
    else if (++values > maxValues) return false;
  }
  if (seen) seen.values = values;
  return true;
}

/** What `textShapeWithin` saw besides its answer, for the parse that follows it (`json.ts`, D1870). */
export interface TextShape {
  /** Values counted (each `[`, `{` and `,` outside strings). */
  values: number;
  /** The start and the closing quote's index of each string at least `LONG_STRING` long, at most `MAX_LONGS` of them. */
  longs: number[];
}

/** A string this long costs more to parse than to splice out of the parse (D1870). */
export const LONG_STRING = 32 * 1024;
export const MAX_LONGS = 8;

/** `stringEnd` over a string. */
function textStringEnd(text: string, i: number): number {
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
