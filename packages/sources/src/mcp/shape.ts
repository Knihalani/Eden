/**
 * The shape check that runs before every `JSON.parse` of a peer's JSON: how deep it nests and how many values it
 * holds, counted outside strings (each `[`, `{` and `,`), so a body padded to make the parse costly (4 M small numbers
 * took 106-134 ms, 4 M nested arrays 453-665 ms, where an 8 MB string took 4-7 ms) is refused before the parse.
 *
 * `bodyShapeWithin` and `stringEnd` are vendored from Eden's `@eden/protocol` (`validate.ts`, D100, D1840), so this
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
  const at: StringScan = { nextQuote: -1, nextEscape: -1 };
  for (let i = 0; i < n; i++) {
    // Most bytes outside strings are digits, letters and whitespace: one table load passes them.
    const k = SHAPE_BYTE[bytes[i]!]!;
    if (k === 0) continue;
    if (k === QUOTE) i = stringEnd(bytes, i + 1, at);
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
 * The next quote and the next backslash at or after the string scan's position (`length` when there is none), each
 * found once and moved only forward, so each byte is read by at most one search for each (D1840): searching again
 * from every run made a body of escapes quadratic.
 */
interface StringScan {
  nextQuote: number;
  nextEscape: number;
}

/**
 * The index of the quote that ends the string whose text starts at `i`, or `bytes.length` when it does not end (an
 * unended string holds no structure). A backslash escapes the next byte (a quote among them). UTF-8 never puts 0x22
 * or 0x5c inside a multi-byte character, so a byte scan cannot misread one. Strings are most of a reply's bytes, and a
 * byte loop over them cost six times the parse (113 µs a 64 KB result against 19), so a long run is crossed with the
 * native `indexOf`; a short run, or a run dense in escapes, is read byte by byte, where a call per escape would cost
 * more than the loop.
 */
function stringEnd(bytes: Uint8Array, i: number, at: StringScan): number {
  const n = bytes.length;
  for (;;) {
    const stop = i + 32 < n ? i + 32 : n;
    for (; i < stop; i++) {
      const s = bytes[i]!;
      if (s === 0x5c) i++;
      else if (s === 0x22) return i;
    }
    if (i >= n) return n;
    if (at.nextQuote < i) {
      at.nextQuote = bytes.indexOf(0x22, i);
      if (at.nextQuote < 0) at.nextQuote = n;
    }
    if (at.nextQuote === n) return n;
    if (at.nextEscape < i) {
      at.nextEscape = bytes.indexOf(0x5c, i);
      if (at.nextEscape < 0) at.nextEscape = n;
    }
    if (at.nextQuote < at.nextEscape) return at.nextQuote;
    i = at.nextEscape + 2;
  }
}

// ---- end of the vendored copy ----

/**
 * `bodyShapeWithin` over a string, code unit by code unit: a character outside ASCII is never structure, as a byte of
 * a multi-byte character never is. Strings are crossed with the string's native `indexOf`, as `stringEnd` does.
 */
export function textShapeWithin(text: string, maxDepth: number, maxValues: number): boolean {
  const n = text.length;
  let depth = 0;
  let values = 0;
  const at: StringScan = { nextQuote: -1, nextEscape: -1 };
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    const k = c < 128 ? SHAPE_BYTE[c]! : 0;
    if (k === 0) continue;
    if (k === QUOTE) i = textStringEnd(text, i + 1, at);
    else if (k === OPEN) {
      if (++depth > maxDepth || ++values > maxValues) return false;
    } else if (k === CLOSE) depth--;
    else if (++values > maxValues) return false;
  }
  return true;
}

/** `stringEnd` over a string. */
function textStringEnd(text: string, i: number, at: StringScan): number {
  const n = text.length;
  for (;;) {
    const stop = i + 32 < n ? i + 32 : n;
    for (; i < stop; i++) {
      const s = text.charCodeAt(i);
      if (s === 0x5c) i++;
      else if (s === 0x22) return i;
    }
    if (i >= n) return n;
    if (at.nextQuote < i) {
      at.nextQuote = text.indexOf('"', i);
      if (at.nextQuote < 0) at.nextQuote = n;
    }
    if (at.nextQuote === n) return n;
    if (at.nextEscape < i) {
      at.nextEscape = text.indexOf("\\", i);
      if (at.nextEscape < 0) at.nextEscape = n;
    }
    if (at.nextQuote < at.nextEscape) return at.nextQuote;
    i = at.nextEscape + 2;
  }
}
