/**
 * The long-reply path (D1900): `parseJsonText` and `parseJsonBytes` read what `JSON.parse` reads slowly on the way
 * through the shape scan (`shape.ts`, `readers.ts`). Whatever the input, the answer must be the plain path's: main's
 * shape check (the vendored `bodyShapeWithin`, which `shape.test.ts` holds identical to `@eden/protocol`'s) on the
 * bytes, then `JSON.parse` of the decoded text; the same value, key order, own `__proto__` keys and `-0`, or
 * undefined. The path's thresholds are lowered so that small bodies drive every branch (a guessed end proven by
 * unescaping or by parsing the literal, a wrong guess, the rest bounded, the step budget and the bound, number arrays,
 * plain slices), and the bounds are small so that refusals are common: nothing the plain check refuses may come back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseJsonBytes, parseJsonBytesWithin, parseJsonText, parseJsonTextWithin } from "./json";
import { NOT_NUMBERS, NUMBER_REGION, numbersRead, readNumbers, TOO_MANY, unescapeText } from "./readers";
import { bodyShapeWithin, LONG_REPLY, newTextShape, PLAIN_STRING, scanText, WITHIN } from "./shape";

const DEFAULTS = { ...LONG_REPLY };
afterEach(() => {
  Object.assign(LONG_REPLY, DEFAULTS);
  NUMBER_REGION.first = 512;
});
const SMALL = { body: 24, string: 12, numbers: 3, guessAfter: 8, tailSteps: 48, steps: 6 };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
/** main's path for bytes: the byte scan, then `JSON.parse` of the decoded text. */
const plainBytes = (bytes: Uint8Array, d: number, v: number) =>
  bodyShapeWithin(bytes, d, v) ? tryParse(decoder.decode(bytes)) : undefined;
/** main's path for text: the same scan on the text's bytes (a lone surrogate encodes as U+FFFD: never structure). */
const plainText = (text: string, d: number, v: number) =>
  bodyShapeWithin(encoder.encode(text), d, v) ? tryParse(text) : undefined;

/** Deep equality that also sees `-0`, key order, own `__proto__` keys and prototypes. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    same(Object.getOwnPropertyDescriptor(a, k)?.value, Object.getOwnPropertyDescriptor(b, k)?.value),
  );
}

/** Pieces of a JSON string's text, valid and not: escapes, surrogates, quotes, controls, multi-byte text. */
const STRING_BITS = [
  "a",
  "plain words ",
  "x".repeat(20),
  '\\"',
  '\\"',
  "\\\\",
  "\\n",
  "\\t",
  "\\/",
  "\\b\\f\\r",
  "\\u00e9",
  "\\u6771",
  "\\ud83d\\ude00",
  "\\uD83D\\uDE00",
  "\\ud83d",
  "\\ude00",
  "\\udc00\\ud800",
  "\\ud83dx",
  "\\ud83d\\u0041",
  "\\u0000",
  "\\u001f",
  "\\uFEFF",
  "\\u12",
  "\\x",
  "\\",
  '\\\\\\"',
  '\\\\"',
  '"',
  "\u0001",
  "\n",
  "é",
  "東京",
  "😀",
  "\uFEFF",
  "\ud800",
  "\udfff",
  '{\\"k\\":[1,2,{\\"x\\":\\"y\\"}]}',
  "[[[[",
  "]]}}",
  ",,,,",
  ":",
];

function stringText(r: () => number, long: boolean): string {
  const parts = long ? 4 + Math.floor(r() * 60) : Math.floor(r() * 6);
  // Mostly one family of bits per string, so dense and sparse escapes both occur.
  const dense = r() < 0.5;
  let s = '"';
  for (let i = 0; i < parts; i++) {
    const pick = dense || r() < 0.15 ? Math.floor(r() * STRING_BITS.length) : Math.floor(r() * 3);
    s += STRING_BITS[pick];
  }
  return `${s}"`;
}

const NUMBER_BITS = [
  "0",
  "-0",
  "7",
  "-12",
  "3.25",
  "-0.5",
  "0.1",
  "123456789012345",
  "1234567890123456",
  "12345678901234567",
  "0.30000000000000004",
  "1e22",
  "1e23",
  "1E-22",
  "1.5e-23",
  "2.5e+3",
  "-4.2E2",
  "9007199254740993",
  "100000000000000000000000",
  "0.0000000000000001",
  "1e400",
  "01",
  "1.",
  ".5",
  "-",
  "1e",
  "1e+",
  "+1",
  "--1",
  "1.2.3",
  '"n"',
  "[1]",
  "true",
];

function numberArray(r: () => number): string {
  const n = Math.floor(r() * 12);
  const bad = r() < 0.2;
  const ws = () => (r() < 0.15 ? [" ", "\n", "\t ", "\r\n"][Math.floor(r() * 4)]! : "");
  const items: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = bad ? NUMBER_BITS[Math.floor(r() * NUMBER_BITS.length)]! : NUMBER_BITS[Math.floor(r() * 20)]!;
    items.push(ws() + v + ws());
  }
  const trailing = r() < 0.05 ? "," : "";
  return `[${ws()}${items.join(",")}${trailing}]`;
}

function value(r: () => number, depth: number): string {
  const x = r();
  if (depth > 10 || x < 0.25) return stringText(r, r() < 0.6);
  if (x < 0.4) return numberArray(r);
  if (x < 0.45) return ["true", "false", "null", "-0", "1e2"][Math.floor(r() * 5)]!;
  if (x < 0.5) return "[".repeat(1 + Math.floor(r() * 14)) + "]".repeat(Math.floor(r() * 15));
  if (x < 0.75) {
    const n = Math.floor(r() * 5);
    const keys = ["a", "__proto__", "content", "text", "a", "\\u0061", "x".repeat(14)];
    const members: string[] = [];
    for (let i = 0; i < n; i++) {
      const key = r() < 0.1 ? stringText(r, true) : JSON.stringify(keys[Math.floor(r() * keys.length)]);
      members.push(`${key}${r() < 0.1 ? " : " : ":"}${value(r, depth + 1)}`);
    }
    return `{${members.join(",")}}`;
  }
  const n = Math.floor(r() * 5);
  const items: string[] = [];
  for (let i = 0; i < n; i++) items.push(value(r, depth + 1));
  return `[${items.join(r() < 0.1 ? " , " : ",")}]`;
}

/** A reply-shaped body, then perhaps broken: truncated, a character put in, a run repeated. */
function body(r: () => number): string {
  let text = r() < 0.6 ? `{"result":{"content":[{"type":"text","text":${value(r, 0)}}]},"id":1}` : value(r, 0);
  if (r() < 0.3) text = `${text.slice(0, -1)},"tail":${value(r, 3)}${text.slice(-1)}`;
  const m = r();
  if (m < 0.08) text = text.slice(0, Math.floor(r() * text.length));
  else if (m < 0.14) {
    const at = Math.floor(r() * text.length);
    text = text.slice(0, at) + '"\\[{,:]}'[Math.floor(r() * 8)] + text.slice(at);
  } else if (m < 0.18) {
    const at = Math.floor(r() * text.length);
    text = text.slice(0, at) + text.slice(at, at + 20) + text.slice(at);
  }
  return text;
}

/** Bytes that a decoder must repair or keep: byte-order marks, broken and truncated sequences. */
function mangle(r: () => number, bytes: Uint8Array): Uint8Array {
  const extra = [[0xef, 0xbb, 0xbf], [0xff], [0xc3], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0xed, 0xa0, 0x80], [0x80]];
  const out: number[] = Array.from(bytes);
  if (r() < 0.2) out.unshift(0xef, 0xbb, 0xbf);
  const k = Math.floor(r() * 3);
  for (let i = 0; i < k; i++) out.splice(Math.floor(r() * out.length), 0, ...extra[Math.floor(r() * extra.length)]!);
  return Uint8Array.from(out);
}

describe("the long-reply path against the plain path", () => {
  test("text: 70,000 seeded bodies, small thresholds and bounds, the same answer", () => {
    Object.assign(LONG_REPLY, SMALL);
    NUMBER_REGION.first = 2;
    const r = rng(1900);
    let differ = 0;
    let refused = 0;
    const kinds = { dense: 0, literal: 0, numbers: 0, plain: 0, rest: 0 };
    for (let i = 0; i < 70_000; i++) {
      const text = body(r);
      const d = 2 + Math.floor(r() * 12);
      const v = 4 + Math.floor(r() * 120);
      const want = plainText(text, d, v);
      const got = parseJsonTextWithin(text, d, v);
      if (!same(got, want)) {
        differ++;
        if (differ <= 3) console.log(JSON.stringify(text), d, v, got, want);
      }
      if (want === undefined) refused++;
      // Which paths the body took, for the counts below.
      const seen = newTextShape(text, true);
      if (scanText(text, d, v, seen) === WITHIN) {
        if (seen.restFrom >= 0 && seen.at === text.length && seen.found.length === 0) kinds.rest++;
        for (let k = 0; k < seen.found.length; k++) {
          const f = seen.found[k];
          const from = seen.pieces[2 * k]!;
          if (f === PLAIN_STRING) kinds.plain++;
          else if (Array.isArray(f)) kinds.numbers++;
          else if (text.slice(from, seen.pieces[2 * k + 1]).split("\\").length * 12 > 2 * LONG_REPLY.guessAfter)
            kinds.dense++;
          else kinds.literal++;
        }
      }
    }
    expect(differ).toBe(0);
    // Both answers are common, and every reader ran.
    expect(refused).toBeGreaterThan(5_000);
    expect(refused).toBeLessThan(65_000);
    for (const n of Object.values(kinds)) expect(n).toBeGreaterThan(200);
  });

  test("bytes: 40,000 seeded bodies with byte-order marks and broken UTF-8, the same answer", () => {
    Object.assign(LONG_REPLY, SMALL);
    const r = rng(19001);
    let differ = 0;
    for (let i = 0; i < 40_000; i++) {
      const bytes = mangle(r, encoder.encode(body(r)));
      const d = 2 + Math.floor(r() * 12);
      const v = 4 + Math.floor(r() * 120);
      if (!same(parseJsonBytesWithin(bytes, d, v), plainBytes(bytes, d, v))) differ++;
    }
    expect(differ).toBe(0);
  });

  test("the real bounds and thresholds on long replies: tool output, JSON as text, numbers, traps", () => {
    const r = rng(19002);
    const line = 'a line of tool output, with "quoted" words, and some more words to fill it to eighty\n';
    const rows = JSON.stringify(
      Array.from({ length: 3_000 }, (_, i) => ({ id: i, t: `Row "${i}"`, p: `C:\\d\\${i}` })),
    );
    const nums = Array.from({ length: 30_000 }, (_, i) => (i % 3 ? Math.round(Math.sin(i) * 1e6) / 100 : i));
    const texts = [
      line.repeat(2_000),
      rows,
      "é東😀\n".repeat(20_000),
      rows + line.repeat(500),
      "x".repeat(70_000),
      `${"\\".repeat(5_000)}"`,
    ];
    const bodies: string[] = [];
    for (const t of texts) {
      bodies.push(JSON.stringify({ result: { content: [{ type: "text", text: t }] }, id: 1 }));
      // Two long strings: the first's guessed end is the second's, and is wrong.
      bodies.push(JSON.stringify({ result: { content: [{ text: t }, { text: t }] }, id: 1 }));
      // A long tail after it: no end is guessed.
      bodies.push(JSON.stringify({ result: { content: [{ text: t }], structuredContent: { nums } }, id: 1 }));
    }
    bodies.push(JSON.stringify({ result: { structuredContent: { nums } }, id: 1 }));
    // A depth bomb after a long string, and inside the reading's reach.
    bodies.push(`{"a":${JSON.stringify(line.repeat(2_000))},"b":${"[".repeat(2_000)}${"]".repeat(2_000)}}`);
    bodies.push(`{"a":${JSON.stringify(rows)},"b":${"[".repeat(1_100)}1${"]".repeat(1_100)}}`);
    // A string whose last quote is escaped: the guess must not take it.
    bodies.push(`{"a":"${'\\"'.repeat(30_000)}\\"}`);
    // Too many values in one number array, and just enough.
    bodies.push(`[${"1,".repeat(1_010_001)}1]`);
    bodies.push(`[${"1,".repeat(1_009_998)}1]`);
    let differ = 0;
    for (const text of bodies) {
      const broken = [text, text.slice(0, Math.floor(r() * text.length)), `${text.slice(0, -2)}x${text.slice(-2)}`];
      for (const t of broken) {
        if (!same(parseJsonText(t), plainText(t, 1_008, 1_010_000))) differ++;
        const b = encoder.encode(t);
        if (!same(parseJsonBytes(b), plainBytes(b, 1_008, 1_010_000))) differ++;
      }
    }
    expect(differ).toBe(0);
  });
});

describe("the long-reply path stays linear", () => {
  test("nested number runs, many long strings without escapes, many long strings with them", () => {
    const run = "1,".repeat(2_000);
    const cases = [
      // Each level's numbers run to the next level's bracket: a reader that encoded up to the first `]` would read
      // the rest of the reply again at every level.
      `${`[${run}`.repeat(1_000)}1${"]".repeat(1_000)}`,
      // 500 long strings and no backslash anywhere: each search for one must not cross the reply again.
      JSON.stringify(Array.from({ length: 500 }, () => "x".repeat(33_000))),
      JSON.stringify(Array.from({ length: 200 }, () => 'a "b" c\n'.repeat(5_000))),
    ];
    for (const text of cases) {
      const t0 = performance.now();
      const got = parseJsonText(text);
      const ms = performance.now() - t0;
      expect(same(got, plainText(text, 1_008, 1_010_000))).toBe(true);
      // About 2-20 ms each here; the quadratic versions took seconds.
      expect(ms).toBeLessThan(1_500);
    }
  });
});

describe("the readers against JSON.parse", () => {
  test("readNumbers: 30,000 seeded arrays, cut into regions anywhere, the same numbers or a refusal to read", () => {
    const r = rng(19003);
    let read = 0;
    for (let i = 0; i < 30_000; i++) {
      NUMBER_REGION.first = 1 + Math.floor(r() * 24);
      const text = numberArray(r);
      const end = readNumbers(text, 0, 1_000);
      const want = tryParse(text);
      if (end === NOT_NUMBERS || end === TOO_MANY) continue;
      read++;
      expect(end).toBe(text.length - 1);
      expect(Array.isArray(want)).toBe(true);
      expect(numbersRead.length).toBe((want as number[]).length);
      for (let k = 0; k < numbersRead.length; k++) expect(Object.is(numbersRead[k], (want as number[])[k])).toBe(true);
    }
    expect(read).toBeGreaterThan(2_500);
  });

  test("readNumbers: random digits, decimals and exponents round as JSON.parse rounds", () => {
    const r = rng(19004);
    for (let i = 0; i < 20_000; i++) {
      const digits = Array.from({ length: 1 + Math.floor(r() * 15) }, () => Math.floor(r() * 10)).join("");
      const dot = Math.floor(r() * (digits.length + 1));
      let n = dot < digits.length ? `${digits.slice(0, dot) || "0"}.${digits.slice(dot)}` : digits;
      if (!n.includes(".")) n = n.replace(/^0+(?=\d)/, "");
      if (r() < 0.4) n += `e${r() < 0.5 ? "-" : ""}${Math.floor(r() * 23)}`;
      const text = `[${r() < 0.5 ? "-" : ""}${n}]`;
      const want = tryParse(text) as number[] | undefined;
      const end = readNumbers(text, 0, 10);
      if (want === undefined) {
        expect(end).toBe(NOT_NUMBERS);
        continue;
      }
      if (end === NOT_NUMBERS) continue;
      expect(Object.is(numbersRead[0], want[0])).toBe(true);
    }
  });

  test("unescapeText: 30,000 seeded strings, the same string or a refusal to read", () => {
    const r = rng(19005);
    let read = 0;
    for (let i = 0; i < 30_000; i++) {
      const lit = stringText(r, true);
      const got = unescapeText(lit, 1, lit.length - 1);
      const want = tryParse(lit);
      if (got === undefined) continue;
      read++;
      expect(got).toBe(want as string);
    }
    expect(read).toBeGreaterThan(3_000);
  });

  test("unescapeText leaves lone surrogates, raw quotes and controls to JSON.parse", () => {
    for (const s of ["\\ud800", "\\udc00", "\\ud800\\ud800", '"', "\u0001", "\ud800", "\\x", "\\u12"]) {
      expect(unescapeText(`"a${s}b"`, 1, s.length + 3)).toBeUndefined();
    }
    const pair = '"\\ud83d\\ude00\\u00e9\\\\\\"\\n"';
    expect(unescapeText(pair, 1, pair.length - 1)).toBe('😀é\\"\n');
    // A byte-order mark inside a string is kept, as decoding the whole reply keeps it.
    const mark = '"\\uFEFFx\\n"';
    expect(unescapeText(mark, 1, mark.length - 1)).toBe("\uFEFFx\n");
  });
});
