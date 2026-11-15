import { decodedAscii, decodeRange, releaseScratch } from "./readers";
import {
  bodyShapeWithin,
  byteLongString,
  byteSawRead,
  byteShapeOrStop,
  LONG_REPLY,
  MAX_JSON_DEPTH,
  MAX_JSON_VALUES,
  newTextShape,
  OVER,
  PLAIN_STRING,
  plainScan,
  scanText,
  STOPPED,
  textBoundWithin,
  textShapeWithin,
  WITHIN,
  type TextShape,
} from "./shape";

/**
 * JSON from a peer's bytes, or undefined when it is not JSON or is shaped to make the parse costly: nested past
 * ~1,000 levels or holding more than ~1,000,000 values, counted by a scan before `JSON.parse` (`shape.ts`, D100's
 * bound, reused). The caller has already capped the byte count. Never throws. The same answer as
 * `JSON.parse(new TextDecoder().decode(bytes))` where the check passes (`long-reply.test.ts` compares them). A long
 * body is scanned as bytes first, then decoded and read as `parseJsonText` reads a reply (D1904, D1908): from its start
 * when the byte scan stopped short of what the text path reads faster, else with only long strings left to find.
 * Node's JSON replies, the capped stream read, each SSE event and each stdio line read through here; Bun's native
 * JSON read takes `parseJsonText` on its `text()`.
 */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  return parseJsonBytesWithin(bytes, MAX_JSON_DEPTH, MAX_JSON_VALUES);
}

/** `parseJsonBytes` with its bounds given: the tests drive refusals with small ones (`json.test.ts`). */
export function parseJsonBytesWithin(bytes: Uint8Array, maxDepth: number, maxValues: number): unknown {
  if (bytes.length < LONG_REPLY.body) {
    return bodyShapeWithin(bytes, maxDepth, maxValues)
      ? parseOrUndefined(decodeRange(bytes, 0, bytes.length, true))
      : undefined;
  }
  // A long body is scanned as bytes first, as main scans every body, so one the scan refuses (a 16 MiB number flood, a
  // depth bomb) never becomes a string. The scan gives up where the text path reads faster (escaped strings, number
  // arrays), and the body is then decoded and read as text from its start (the scan over the string gives the byte
  // scan's answer, `shape.test.ts`): only a body that cannot hold more values than the bound, since giving up costs
  // a refused body its decode. A longer body is scanned whole, noting whether it holds what the text path reads.
  const stop = bytes.length <= 2 * maxValues;
  const shape = byteShapeOrStop(bytes, maxDepth, maxValues, stop);
  if (shape === OVER) return undefined;
  const known = shape === WITHIN;
  const text = decodeRange(bytes, 0, bytes.length, true);
  // Nothing the text path would read or slice, or multi-byte text, whose plain strings cost as much to check as to
  // parse: main's parse (D1909; the text scan cost a 64 KB reply of short strings 10-20% for nothing).
  if (known && !byteSawRead && (!byteLongString || !decodedAscii)) return parseOrUndefined(text);
  return readLong(text, maxDepth, maxValues, known, decodedAscii);
}

/**
 * `parseJsonBytes` for a body the runtime already decoded (D1860): the same shape check, on the string, before any
 * parse, and the same answer as `JSON.parse(text)` where the check passes (`json.test.ts` compares them). A long reply
 * is also read on the way where `JSON.parse` reads it slowly (`scanText`, D1870, D1900): a long string with no escape
 * becomes a slice of the reply, a long string with dense escapes and a long array of plain numbers are read by the
 * scan, and each is spliced into the parse of the rest (`spliced`). A reply that is mostly structure stops the scan
 * after a budget of steps and is bounded by counting brackets and commas with `indexOf` instead (`textBoundWithin`);
 * when that bound does not hold, or would not pay, the plain scan checks the rest (D1908).
 */
export function parseJsonText(text: string): unknown {
  return parseJsonTextWithin(text, MAX_JSON_DEPTH, MAX_JSON_VALUES);
}

/** `parseJsonText` with its bounds given: the tests drive refusals with small ones (`json.test.ts`). */
export function parseJsonTextWithin(text: string, maxDepth: number, maxValues: number): unknown {
  if (text.length >= LONG_REPLY.body) return readLong(text, maxDepth, maxValues, false, true);
  return textShapeWithin(text, maxDepth, maxValues) ? parseOrUndefined(text) : undefined;
}

/**
 * The long-reply path (D1900): `known` when the byte scan has already found the reply within its bounds, so a reply
 * that is mostly structure is parsed as soon as the scan's budget is spent; `slices` off for a body the bytes path
 * decoded from multi-byte UTF-8, whose long plain strings stay in the parse, as main parses them (D1909).
 */
function readLong(text: string, maxDepth: number, maxValues: number, known: boolean, slices: boolean): unknown {
  // Known within, the scan only looks for long strings to slice: a reply whose structure outlasts a short budget is
  // parsed whole at once.
  const seen = newTextShape(text, true, known ? LONG_REPLY.steps >>> 2 : LONG_REPLY.steps + (text.length >>> 8));
  seen.known = known;
  seen.slices = slices;
  try {
    let shape = scanText(text, maxDepth, maxValues, seen);
    if (shape === STOPPED) {
      // Known within, the byte scan found no number array to read: the reply is parsed whole.
      if (known && seen.pieces.length === 0) return parseOrUndefined(text);
      // Nothing read yet (an array that may be numbers, met just before the stop, is checked as any other is).
      if (seen.pieces.length === 0) {
        // The bound counts every comma it needs with a search each: where the scan met a value every 16 characters
        // or closer, it would give up after costing as much as the scan it saves (rows of objects: 5% of the call).
        if (seen.values * 16 <= seen.at && textBoundWithin(text, maxDepth, maxValues)) {
          return parseOrUndefined(text);
        }
        // Mostly structure: the rest is checked by the plain scan, which reads nothing.
        const within = plainScan(text, seen.at, seen.depth, seen.values, maxDepth, maxValues);
        return within ? parseOrUndefined(text) : undefined;
      }
      seen.budget = Infinity;
      shape = scanText(text, maxDepth, maxValues, seen);
    }
    if (shape !== WITHIN) return undefined;
    if (seen.pieces.length === 0) return parseOrUndefined(text);
    const fast = spliced(text, seen);
    return fast === PLAIN ? JSON.parse(text) : fast;
  } catch {
    return undefined;
  } finally {
    releaseScratch();
  }
}

function parseOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A placeholder's prefix: 16 hex digits from `getRandomValues`, new for each reply spliced and never sent anywhere
 * (every placeholder is replaced before a value is returned), so a server cannot write a string equal to one on
 * purpose, even having seen the client's other replies; one it hits by chance is caught by the count below, and the
 * plain parse is used instead. The control character keeps it apart from anything a reply holds unescaped.
 */
function newMark(): string {
  // Drawn from a pool of random bytes filled 4 KiB at a time, each byte used once: one `getRandomValues` call a
  // reply cost as much as the rest of splicing a 64 KB reply's string.
  if (poolAt + 8 > pool.length) {
    crypto.getRandomValues(pool);
    poolAt = 0;
  }
  let hex = "";
  for (let k = poolAt; k < poolAt + 8; k++) hex += HEX_BYTE[pool[k]!];
  pool.fill(0, poolAt, poolAt + 8);
  poolAt += 8;
  return `\u0001${hex}:`;
}
const pool = new Uint8Array(4096);
let poolAt = pool.length;
const HEX_BYTE = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));
/** A raw control character, a backslash: a string holding either is not its characters between quotes. */
const NOT_PLAIN = /[\x00-\x1f\\]/;
/** Values past which the walk that puts the pieces back would cost more than the parse it saves. */
const MAX_WALK = 4_096;

/**
 * The parse with the scan's pieces spliced out: each is replaced by a placeholder string, the rest parsed, and the
 * pieces put back; `PLAIN` when none is worth it or a placeholder went astray (the caller parses the whole text). A
 * long string with no escape or control character is put back as a slice of the reply (no copy in JSC or V8), taken
 * only when such strings are at least half the reply, so a slice never holds alive more than as much again of the
 * reply around it. What the scan read (a long string with escapes, a number array) is always taken: parsing it again
 * would cost what reading it did.
 */
function spliced(text: string, seen: TextShape): unknown {
  const spans: number[] = [];
  const values: unknown[] = [];
  const plain: number[] = [];
  let plainChars = 0;
  let readChars = 0;
  for (let k = 0; k < seen.pieces.length; k += 2) {
    const from = seen.pieces[k]!;
    const to = seen.pieces[k + 1]!;
    const value = seen.found[k >> 1];
    if (text.charCodeAt(from) === 0x22) {
      // A key (followed by a colon) stays in the parse: the walk puts back values only.
      let j = to;
      while (j < text.length && isSpace(text.charCodeAt(j))) j++;
      if (text.charCodeAt(j) === 0x3a) continue;
    }
    if (value === PLAIN_STRING) {
      if (NOT_PLAIN.test(text.slice(from + 1, to - 1))) continue;
      plain.push(spans.length);
      plainChars += to - from;
    } else readChars += to - from;
    spans.push(from, to);
    values.push(value);
  }
  if (plainChars * 2 < text.length) {
    // Too little to be worth holding the reply alive for: those strings stay in the parse.
    for (let p = plain.length - 1; p >= 0; p--) {
      spans.splice(plain[p]!, 2);
      values.splice(plain[p]! >> 1, 1);
    }
  }
  // The walk costs about as much a value as a parse does about eight characters of what the pieces keep out of it.
  if (spans.length === 0 || seen.values - seen.inPieces > MAX_WALK + (readChars >>> 3)) return PLAIN;
  const mark = newMark();
  // The mark as the start of a JSON string, its control character escaped: the skeleton stays ASCII where the reply
  // was.
  const quoted = `"\\u0001${mark.slice(1)}`;
  let skeleton = text.slice(0, spans[0]!);
  for (let k = 0; k < spans.length; k += 2) {
    skeleton += `${quoted}${k >> 1}"${text.slice(spans[k + 1]!, spans[k + 2] ?? text.length)}`;
  }
  return putBack(JSON.parse(skeleton), mark, spans.length >> 1, (k) => {
    const value = values[k];
    return value === PLAIN_STRING ? text.slice(spans[2 * k]! + 1, spans[2 * k + 1]! - 1) : value;
  });
}

/**
 * The parsed skeleton with each placeholder (`mark` and its number) replaced by `valueOf` its number, or `PLAIN` when
 * one is missing or found twice (a duplicate key's later value wins, or a string the server wrote matched): the plain
 * parse then decides.
 */
function putBack(value: unknown, mark: string, count: number, valueOf: (k: number) => unknown): unknown {
  const found = new Uint8Array(count);
  let placed = 0;
  const put = (s: unknown): unknown => {
    if (typeof s !== "string" || !s.startsWith(mark)) return undefined;
    const k = Number(s.slice(mark.length));
    if (!Number.isInteger(k) || k < 0 || k >= count || found[k]) return null;
    found[k] = 1;
    placed++;
    return valueOf(k);
  };
  // The top level may be a piece itself.
  const top = put(value);
  if (top === null) return PLAIN;
  if (top !== undefined) return placed === count ? top : PLAIN;
  // Iterative, so a nested value costs no stack; the shape check bounded the nesting already.
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "object" && v !== null) stack.push(v);
        else {
          const s = put(v);
          if (s === null) return PLAIN;
          if (s !== undefined) node[i] = s;
        }
      }
    } else if (typeof node === "object" && node !== null) {
      for (const key of Object.keys(node)) {
        const v = (node as Record<string, unknown>)[key];
        if (typeof v === "object" && v !== null) stack.push(v);
        else {
          const s = put(v);
          if (s === null) return PLAIN;
          // Defined, not assigned: a `__proto__` key is an own property of a parsed object, as JSON.parse made it.
          if (s !== undefined)
            Object.defineProperty(node, key, { value: s, writable: true, enumerable: true, configurable: true });
        }
      }
    }
  }
  return placed === count ? value : PLAIN;
}

/** `spliced`'s answer when the plain parse should decide. */
const PLAIN = Symbol("plain");

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
