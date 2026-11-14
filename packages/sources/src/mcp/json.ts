import { decodeRange } from "./readers";
import {
  bodyShapeWithin,
  LONG_REPLY,
  MAX_JSON_DEPTH,
  MAX_JSON_VALUES,
  newTextShape,
  PLAIN_STRING,
  scanText,
  STOPPED,
  textBoundWithin,
  WITHIN,
  type TextShape,
} from "./shape";

/**
 * JSON from a peer's bytes, or undefined when it is not JSON or is shaped to make the parse costly: nested past
 * ~1,000 levels or holding more than ~1,000,000 values, counted by a scan before `JSON.parse` (`shape.ts`, D100's
 * bound, reused). The caller has already capped the byte count. Never throws. The same answer as
 * `JSON.parse(new TextDecoder().decode(bytes))` where the check passes (`long-reply.test.ts` compares them). A long
 * body is decoded first and read as `parseJsonText` reads a reply (D1900): the scan over the string gives the byte
 * scan's answer (`shape.test.ts`), and the decode is one the parse needs anyway. Node's JSON replies, the capped
 * stream read, each SSE event and each stdio line read through here; Bun's native JSON read takes `parseJsonText` on
 * its `text()`.
 */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  return parseJsonBytesWithin(bytes, MAX_JSON_DEPTH, MAX_JSON_VALUES);
}

/** `parseJsonBytes` with its bounds given: the tests drive refusals with small ones (`json.test.ts`). */
export function parseJsonBytesWithin(bytes: Uint8Array, maxDepth: number, maxValues: number): unknown {
  if (bytes.length >= LONG_REPLY.body) {
    return parseJsonTextWithin(decodeRange(bytes, 0, bytes.length, true), maxDepth, maxValues);
  }
  if (!bodyShapeWithin(bytes, maxDepth, maxValues)) return undefined;
  return parseOrUndefined(decodeRange(bytes, 0, bytes.length, true));
}

/**
 * `parseJsonBytes` for a body the runtime already decoded (D1860): the same shape check, on the string, before any
 * parse, and the same answer as `JSON.parse(text)` where the check passes (`json.test.ts` compares them). A long reply
 * is also read on the way where `JSON.parse` reads it slowly (`scanText`, D1870, D1900): a long string with no escape
 * becomes a slice of the reply, a long string with dense escapes and a long array of plain numbers are read by the
 * scan, and each is spliced into the parse of the rest (`spliced`). A reply that is mostly structure stops the scan
 * after a budget of steps and is bounded by counting brackets and commas with `indexOf` instead (`textBoundWithin`);
 * when that bound does not hold, the scan goes on from where it stopped.
 */
export function parseJsonText(text: string): unknown {
  return parseJsonTextWithin(text, MAX_JSON_DEPTH, MAX_JSON_VALUES);
}

/** `parseJsonText` with its bounds given: the tests drive refusals with small ones (`json.test.ts`). */
export function parseJsonTextWithin(text: string, maxDepth: number, maxValues: number): unknown {
  const long = text.length >= LONG_REPLY.body;
  const seen = newTextShape(text, long, long ? LONG_REPLY.steps + (text.length >>> 8) : Infinity);
  let shape = scanText(text, maxDepth, maxValues, seen);
  if (shape === STOPPED) {
    if (seen.pieces.length === 0 && textBoundWithin(text, maxDepth, maxValues)) return parseOrUndefined(text);
    seen.budget = Infinity;
    shape = scanText(text, maxDepth, maxValues, seen);
  }
  if (shape !== WITHIN) return undefined;
  if (seen.pieces.length === 0) return parseOrUndefined(text);
  try {
    const fast = spliced(text, seen);
    return fast === PLAIN ? JSON.parse(text) : fast;
  } catch {
    return undefined;
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
  let hex = "";
  for (const b of crypto.getRandomValues(new Uint8Array(8))) hex += (b < 16 ? "0" : "") + b.toString(16);
  return `\u0001${hex}:`;
}
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
  const quoted = JSON.stringify(mark).slice(0, -1);
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
