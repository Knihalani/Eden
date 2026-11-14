import { bodyShapeUnder, MAX_JSON_DEPTH, MAX_JSON_VALUES, textShapeWithin, type TextShape } from "./shape";

const decoder = new TextDecoder();

/**
 * JSON from a peer's bytes, or undefined when it is not JSON or is shaped to make the parse costly: nested past
 * ~1,000 levels or holding more than ~1,000,000 values, counted by a byte scan before `JSON.parse` (`shape.ts`, D100's
 * bound, reused). The caller has already capped the byte count. Never throws.
 */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  if (!bodyShapeUnder(bytes)) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * `parseJsonBytes` for a body the runtime already decoded (D1860): the same shape check, on the string, before any
 * parse. A long string value that holds no escape and no control character is taken out of the parse (D1870): its
 * value is exactly the characters between its quotes, so it is a slice of the reply (no copy in JSC or V8) where
 * `JSON.parse` would read it again and copy it (172-306 µs a MiB, against 61 for the check below), and the rest is
 * parsed with a placeholder in its place. Same result as `JSON.parse(text)` (`json.test.ts` compares them).
 */
export function parseJsonText(text: string): unknown {
  const seen: TextShape = { values: 0, longs: [] };
  if (!textShapeWithin(text, MAX_JSON_DEPTH, MAX_JSON_VALUES, seen)) return undefined;
  try {
    const fast = seen.longs.length > 0 ? spliced(text, seen) : PLAIN;
    return fast === PLAIN ? JSON.parse(text) : fast;
  } catch {
    return undefined;
  }
}

/**
 * The placeholder's prefix: random per process and never sent anywhere (every placeholder is replaced before a value
 * is returned), so a server cannot write a string equal to it on purpose; one it hits by chance is caught by the
 * count below, and the plain parse is used instead.
 */
const MARK = `\u0001${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("")}:`;
/** Placeholders as the skeleton holds them: escaped, so the skeleton stays ASCII where the reply was. */
const MARK_JSON = JSON.stringify(MARK).slice(1, -1);
/** A raw control character, a backslash: a string holding either is not its characters between quotes. */
const NOT_PLAIN = /[\x00-\x1f\\]/;
/** Values past which the walk that puts the strings back would cost more than the copy it saves. */
const MAX_WALK = 4_096;

/**
 * The parse with the long plain string values spliced out, or `PLAIN` when there are none worth it or a placeholder
 * went astray (the caller parses the whole text). Taken only when the long strings are at least half the reply, so
 * a slice never holds alive more than as much again of the reply around it.
 */
function spliced(text: string, seen: TextShape): unknown {
  if (seen.values > MAX_WALK) return PLAIN;
  const spans: number[] = [];
  let taken = 0;
  for (let k = 0; k < seen.longs.length; k += 2) {
    const start = seen.longs[k]!;
    const end = seen.longs[k + 1]!;
    // A key (followed by a colon) stays in the parse: the walk puts back values only.
    let j = end + 1;
    while (j < text.length && isSpace(text.charCodeAt(j))) j++;
    if (text.charCodeAt(j) === 0x3a) continue;
    if (NOT_PLAIN.test(text.slice(start, end))) continue;
    spans.push(start, end);
    taken += end - start;
  }
  if (spans.length === 0 || taken * 2 < text.length) return PLAIN;
  let skeleton = text.slice(0, spans[0]!);
  for (let k = 0; k < spans.length; k += 2) {
    skeleton += `${MARK_JSON}${k >> 1}${text.slice(spans[k + 1]!, spans[k + 2] ?? text.length)}`;
  }
  const value = JSON.parse(skeleton) as unknown;
  const strings = spans.length >> 1;
  const found = new Uint8Array(strings);
  let placed = 0;
  const put = (s: unknown): unknown => {
    if (typeof s !== "string" || !s.startsWith(MARK)) return undefined;
    const k = Number(s.slice(MARK.length));
    if (!Number.isInteger(k) || k < 0 || k >= strings || found[k]) return null;
    found[k] = 1;
    placed++;
    return text.slice(spans[2 * k]!, spans[2 * k + 1]!);
  };
  // The top level may be the string itself.
  const top = put(value);
  if (top === null) return PLAIN;
  if (top !== undefined) return placed === strings ? top : PLAIN;
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
  // A placeholder dropped (a duplicate key's later value wins) or found twice: the plain parse decides.
  return placed === strings ? value : PLAIN;
}

/** `spliced`'s answer when the plain parse should decide. */
const PLAIN = Symbol("plain");

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
