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
import {
  firstRegionReadsBytes,
  lastElementReads,
  lastElementReadsBytes,
  NOT_JSON,
  NOT_NUMBERS,
  NUMBER_REGION,
  numbersCalls,
  numbersRead,
  numbersStop,
  readNumbers,
  releaseScratch,
  scratchIsClear,
  TOO_MANY,
  unescapeText,
} from "./readers";
import {
  bodyShapeWithin,
  byteShapeOrStop,
  LONG_REPLY,
  newTextShape,
  NOT_JSON_REPLY,
  PLAIN_STRING,
  scanText,
  STOPPED,
  WITHIN,
} from "./shape";

const DEFAULTS = { ...LONG_REPLY };
afterEach(() => {
  Object.assign(LONG_REPLY, DEFAULTS);
  NUMBER_REGION.first = 512;
  NUMBER_REGION.most = 32 * 1024;
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
/** Process CPU in milliseconds: a bound on work, not on a wait (D811). */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1_000;
};

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
  "null",
  "false",
  "nul",
  "tru",
  "nulll",
  "falsee",
  "true1",
  "n",
];
/** What a series with gaps holds besides numbers: elements `readNumbers` reads too (D1919). */
const LITERALS = ["null", "true", "false"];

function numberArray(r: () => number): string {
  const n = Math.floor(r() * 12);
  const bad = r() < 0.2;
  const ws = () => (r() < 0.15 ? [" ", "\n", "\t ", "\r\n"][Math.floor(r() * 4)]! : "");
  const items: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = bad
      ? NUMBER_BITS[Math.floor(r() * NUMBER_BITS.length)]!
      : r() < 0.1
        ? LITERALS[Math.floor(r() * 3)]!
        : NUMBER_BITS[Math.floor(r() * 20)]!;
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
    NUMBER_REGION.most = 16;
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
    const r = rng(19001);
    let differ = 0;
    for (let i = 0; i < 40_000; i++) {
      // A quarter at the real thresholds: these small bodies take the short path, its decode included.
      Object.assign(LONG_REPLY, i % 4 === 0 ? DEFAULTS : SMALL);
      const bytes = mangle(r, encoder.encode(body(r)));
      const d = 2 + Math.floor(r() * 12);
      // Half the bounds leave room for twice the body's length in values: the byte scan that stops (D1908) runs on
      // those, the plain byte scan on the rest.
      const v = r() < 0.5 ? 4 + Math.floor(r() * 120) : Math.ceil(bytes.length / 2) + Math.floor(r() * 120);
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
    // A depth bomb, or too many values, after a number array the byte scan stops at.
    bodies.push(`{"nums":${JSON.stringify(nums)},"b":${"[".repeat(1_100)}1${"]".repeat(1_100)}}`);
    bodies.push(`{"nums":${JSON.stringify(nums)},"b":[${"[],".repeat(505_000)}1]}`);
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
      // 500 long strings and no backslash anywhere: each is checked for one once, when spliced.
      JSON.stringify(Array.from({ length: 500 }, () => "x".repeat(33_000))),
      JSON.stringify(Array.from({ length: 200 }, () => 'a "b" c\n'.repeat(5_000))),
    ];
    for (const text of cases) {
      const t0 = cpuMs();
      const got = parseJsonText(text);
      const ms = cpuMs() - t0;
      expect(same(got, plainText(text, 1_008, 1_010_000))).toBe(true);
      // 5-60 ms of CPU each here (as much as `JSON.parse` of the same text); the quadratic versions took seconds.
      expect(ms).toBeLessThan(1_500);
    }
  });

  /** Least CPU ms of `f` over runs taken in turn with `g`'s, so load hits both alike. The minimum, not the
   * median: a few-millisecond run's median swings with GC the way its minimum does not. */
  function minimums(f: () => unknown, g: () => unknown, runs: number): [number, number] {
    const a: number[] = [];
    const b: number[] = [];
    for (let k = 0; k < runs; k++) {
      let t = cpuMs();
      f();
      a.push(cpuMs() - t);
      t = cpuMs();
      g();
      b.push(cpuMs() - t);
    }
    return [Math.min(...a), Math.min(...b)];
  }

  test("short number arrays cost what the plain path costs (D1900's review: a reader call for each was 2.7-4x)", () => {
    const shapes = [
      JSON.stringify({ result: Array.from({ length: 60_000 }, (_, i) => [i % 100, 2, 3]) }),
      `[${"[1],".repeat(150_000)}[1]]`,
    ];
    for (const text of shapes) {
      const plain = () => {
        LONG_REPLY.body = Infinity;
        parseJsonText(text);
        LONG_REPLY.body = DEFAULTS.body;
      };
      for (let k = 0; k < 3; k++) [parseJsonText(text), plain()];
      const [long, short] = minimums(() => parseJsonText(text), plain, 9);
      // About 1.0 here; 2.7-4 with a reader call for every `[` before a digit.
      expect(long).toBeLessThan(short * 1.5 + 2);
    }
  });

  test("nested candidates whose next `]` is deep inside cost what the plain path costs (D1909: 6-12x)", () => {
    // Each level runs past `reach` with numbers, then opens the next: every level's next `]` is the innermost one, so
    // its span is past twice the room the commas may take, and the commas are counted before reading. Counting on to
    // that `]` at every level read the rest of the reply once a level, as many levels as the step budget reached.
    const level = `[${"1234567890123,".repeat(80)}`;
    const text = `${level.repeat(160)}[${"1234567890123,".repeat(280_000)}1${"]".repeat(161)}`;
    const plain = () => {
      LONG_REPLY.body = Infinity;
      parseJsonText(text);
      LONG_REPLY.body = DEFAULTS.body;
    };
    expect(same(parseJsonText(text), plainText(text, 1_008, 1_010_000))).toBe(true);
    for (let k = 0; k < 2; k++) [parseJsonText(text), plain()];
    const [long, short] = minimums(() => parseJsonText(text), plain, 7);
    // About 1.0 here; 4-6x at this size when every level counted to the innermost `]`.
    expect(long).toBeLessThan(short * 1.5 + 2);
  });

  /**
   * `minimums` with a full collection before each timed call, so neither side pays for garbage the other (or the fuzz
   * tests before it) left: without it this ratio read 0.87 against 0.85 once in a loaded gate (D1965). The process
   * clock, not `process.threadCpuUsage()`: on Bun 1.4.4 that steps by up to 4 ms and under-reads, and with D1919's
   * regression planted it let the ratio through (D1965's review); with the process clock and the collections the
   * regression reads 0.96-1.47 and the reader 0.48-0.72.
   */
  function settledMinimums(f: () => unknown, g: () => unknown, runs: number): [number, number] {
    const a: number[] = [];
    const b: number[] = [];
    for (let k = 0; k < runs; k++) {
      Bun.gc(true);
      let t = cpuMs();
      f();
      a.push(cpuMs() - t);
      Bun.gc(true);
      t = cpuMs();
      g();
      b.push(cpuMs() - t);
    }
    return [Math.min(...a), Math.min(...b)];
  }

  const plainOf = (text: string) => () => {
    LONG_REPLY.body = Infinity;
    parseJsonText(text);
    LONG_REPLY.body = DEFAULTS.body;
  };

  test("a series with a gap late in it is read, for less than the plain path (D1919: 1.3-1.6x before)", () => {
    // A metrics series with one missing value near its end: the reader read up to the `null`, gave up, and the scan
    // crossed the array again from where it had asked, so the array was crossed twice and then parsed.
    const values = Array.from({ length: 400_000 }, (_, k) => String(Math.round(Math.sin(k) * 1e5) / 100));
    values[values.length - 3] = "null";
    const text = `{"result":{"structuredContent":{"values":[${values.join(",")}]}}}`;
    expect(same(parseJsonText(text), JSON.parse(text))).toBe(true);
    expect(same(parseJsonBytes(encoder.encode(text)), JSON.parse(text))).toBe(true);
    const plain = plainOf(text);
    for (let k = 0; k < 2; k++) [parseJsonText(text), plain()];
    const [long, short] = settledMinimums(() => parseJsonText(text), plain, 9);
    // About 0.4 here; 1.3-1.6x when the reader gave up at the `null`.
    expect(long).toBeLessThan(short * 0.85);
  });

  test("a refused number flood on the bytes path costs what the byte scan costs, and is never decoded", () => {
    const flood = encoder.encode(`[${"1,".repeat(2_000_000)}1]`);
    expect(parseJsonBytes(flood)).toBeUndefined();
    for (let k = 0; k < 2; k++) bodyShapeWithin(flood, 1_008, 1_010_000);
    const [ours, scan] = minimums(
      () => parseJsonBytes(flood),
      () => bodyShapeWithin(flood, 1_008, 1_010_000),
      7,
    );
    // About 1.0; 9.5x when the body was decoded and read as text first.
    expect(ours).toBeLessThan(scan * 1.5 + 2);
  });

  test("no reply's text stays in the readers' buffers after the call", () => {
    const nums = JSON.stringify({ r: Array.from({ length: 5_000 }, (_, i) => i * 1.5) });
    const dense = JSON.stringify({ t: '{"k":"v","n":[1,2]}\n'.repeat(5_000) });
    for (const text of [nums, dense, `${nums.slice(0, -1)},"x":${dense}}`]) {
      expect(parseJsonText(text)).toEqual(JSON.parse(text));
      expect(scratchIsClear()).toBe(true);
      expect(parseJsonBytes(encoder.encode(text))).toEqual(JSON.parse(text));
      expect(scratchIsClear()).toBe(true);
    }
  });
});

describe("the readers against JSON.parse", () => {
  test("readNumbers: 30,000 seeded arrays, cut into regions anywhere, the same numbers or a refusal to read", () => {
    const r = rng(19003);
    let read = 0;
    let notJson = 0;
    for (let i = 0; i < 30_000; i++) {
      NUMBER_REGION.first = 1 + Math.floor(r() * 24);
      NUMBER_REGION.most = NUMBER_REGION.first * (1 + Math.floor(r() * 4));
      const text = numberArray(r);
      const end = readNumbers(text, 0, 1_000);
      const want = tryParse(text);
      if (end === NOT_JSON) {
        // Only where `JSON.parse` throws.
        expect(want).toBeUndefined();
        notJson++;
        continue;
      }
      if (end === NOT_NUMBERS || end === TOO_MANY) continue;
      read++;
      expect(end).toBe(text.length - 1);
      expect(Array.isArray(want)).toBe(true);
      expect(numbersRead.length).toBe((want as number[]).length);
      for (let k = 0; k < numbersRead.length; k++) expect(Object.is(numbersRead[k], (want as number[])[k])).toBe(true);
    }
    expect(read).toBeGreaterThan(2_500);
    expect(notJson).toBeGreaterThan(2_500);
  });

  test("readNumbers: random digits, decimals and exponents round as JSON.parse rounds, past the fast path too", () => {
    const r = rng(19004);
    let slow = 0;
    for (let i = 0; i < 40_000; i++) {
      // Up to 22 digits and exponents up to 400: past 15 digits or 1e22 the reader hands the text to `Number` (D1919).
      const digits = Array.from({ length: 1 + Math.floor(r() * 22) }, () => Math.floor(r() * 10)).join("");
      const dot = Math.floor(r() * (digits.length + 1));
      let n = dot < digits.length ? `${digits.slice(0, dot) || "0"}.${digits.slice(dot)}` : digits;
      if (!n.includes(".")) n = n.replace(/^0+(?=\d)/, "");
      if (r() < 0.4) {
        const sign = ["-", "+", ""][Math.floor(r() * 3)];
        n += `${r() < 0.5 ? "e" : "E"}${sign}${Math.floor(r() * (r() < 0.8 ? 30 : 400))}`;
      }
      // Two numbers, so the second's text is found from where its region starts.
      const text = `[${r() < 0.5 ? "-" : ""}${n}, ${r() < 0.5 ? "-" : ""}${n}]`;
      const want = tryParse(text) as number[] | undefined;
      const end = readNumbers(text, 0, 10);
      if (want === undefined) {
        expect([NOT_NUMBERS, NOT_JSON]).toContain(end);
        continue;
      }
      // Two in the first region are read whatever they are.
      expect(end).toBe(text.length - 1);
      if (digits.length > 15 || n.includes("e") || n.includes("E")) slow++;
      expect(Object.is(numbersRead[0], want[0])).toBe(true);
      expect(Object.is(numbersRead[1], want[1])).toBe(true);
    }
    expect(slow).toBeGreaterThan(10_000);
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

  test("an array's last element is checked before reading, on text and on bytes (D1919)", () => {
    const head = `[${"12,".repeat(400)}`;
    const cases: [string, boolean][] = [
      ["7]", true],
      ["  -3.25e2 ]", true],
      ["null]", true],
      ["true]", true],
      ["false ]", true],
      ["12345678901234567]", true],
      ["1e23]", true],
      ["{}]", false],
      ["nul]", false],
      ["1 2]", false],
      ["]", false],
      ["é]", false],
      [`1e${"0".repeat(80)}1]`, true],
    ];
    for (const [tail, reads] of cases) {
      const text = head + tail;
      expect(lastElementReads(text, 0, text.length - 1)).toBe(reads);
      // The text path's reply releases the buffer; the byte scan's check zeroes what it wrote itself.
      releaseScratch();
      const bytes = encoder.encode(text);
      expect(lastElementReadsBytes(bytes, 0, bytes.length - 1)).toBe(reads);
      expect(scratchIsClear()).toBe(true);
    }
    // The byte scan stops for the text path only at an array it would read.
    const body = (tail: string) => encoder.encode(`{"v":[${"12,".repeat(20_000)}${tail}]}`);
    expect(byteShapeOrStop(body("12"), 1_008, 1_010_000)).toBe(STOPPED);
    expect(byteShapeOrStop(body("null"), 1_008, 1_010_000)).toBe(STOPPED);
    expect(byteShapeOrStop(body("12345678901234567"), 1_008, 1_010_000)).toBe(STOPPED);
    expect(byteShapeOrStop(body("{}"), 1_008, 1_010_000)).toBe(WITHIN);
    expect(scratchIsClear()).toBe(true);
  });

  test("the text path never enters the reader for an array whose last element it would refuse (D1919)", () => {
    // Read up to its last element first, then scanned and parsed, such an array cost 1.6-2.1x main.
    const head = "12,".repeat(2_000);
    for (const tail of ["{}", "nul", "1 2", "{ }"]) {
      const text = `{"v":[${head}${tail}]}`;
      const before = numbersCalls.count;
      const seen = newTextShape(text, true);
      scanText(text, 1_008, 1_010_000, seen);
      expect(numbersCalls.count).toBe(before);
      expect(seen.found.length).toBe(0);
      releaseScratch();
    }
    // With a number past the fast path last or late (where giving up cost 1.3-2.1x main), the same array enters it
    // once and is read whole.
    for (const tail of ["12345678901234567", "12345678901234567,12,12", "1e400,0.30000000000000004,12"]) {
      const text = `{"v":[${head}${tail}]}`;
      const before = numbersCalls.count;
      const seen = newTextShape(text, true);
      expect(scanText(text, 1_008, 1_010_000, seen)).toBe(WITHIN);
      expect(numbersCalls.count).toBe(before + 1);
      expect(same(seen.found, [JSON.parse(text).v])).toBe(true);
      releaseScratch();
    }
  });

  test("the byte scan stops only where the reader reads the first region too (D1919)", () => {
    // Computed doubles end in one the reader reads, but it gives the array up at its third: the byte scan goes on.
    const doubles = Array.from({ length: 3_000 }, (_, k) => String(Math.sin(k + 1) * 100));
    const floats = encoder.encode(`{"v":[${doubles.join(",")},1]}`);
    expect(byteShapeOrStop(floats, 1_008, 1_010_000)).toBe(WITHIN);
    // A rounded series with two of them early is still read.
    const series = Array.from({ length: 3_000 }, (_, k) => String(Math.round(Math.sin(k) * 1e4) / 100));
    series[3] = doubles[0]!;
    series[9] = "1e400";
    const mixed = `{"v":[${series.join(",")}]}`;
    expect(byteShapeOrStop(encoder.encode(mixed), 1_008, 1_010_000)).toBe(STOPPED);
    expect(same(parseJsonBytes(encoder.encode(mixed)), JSON.parse(mixed))).toBe(true);
    const reads = (text: string) => firstRegionReadsBytes(encoder.encode(text), 0);
    expect(reads(`[ ${series.join(",")}]`)).toBe(true);
    expect(reads(`[${doubles.join(",")}]`)).toBe(false);
    expect(reads(`[1,2,nn,${series.join(",")}]`)).toBe(false);
    expect(scratchIsClear()).toBe(true);
  });

  test("an array with a nested array or object before its next `]` is neither read nor stopped at (D1919)", () => {
    // Every level ran past `reach` with numbers and shared the innermost `]`: each was read up to the next level.
    const level = `[${"1,".repeat(600)}`;
    const cases: [string, number][] = [
      // Only the innermost level is read.
      [`${level.repeat(50)}1${"]".repeat(50)}`, 1],
      [`[${level}{}],${"2,".repeat(600)}2]`, 0],
    ];
    for (const [text, reads] of cases) {
      const before = numbersCalls.count;
      const seen = newTextShape(text, true);
      expect(scanText(text, 1_008, 1_010_000, seen)).toBe(WITHIN);
      expect(numbersCalls.count).toBe(before + reads);
      expect(same(parseJsonText(text), JSON.parse(text))).toBe(true);
      releaseScratch();
    }
    const bytes = encoder.encode(`[${"1,".repeat(600)}[${"1,".repeat(10)}1],1]`);
    expect(byteShapeOrStop(bytes, 1_008, 1_010_000)).toBe(WITHIN);
  });

  test("an array with fewer elements than the text path keeps is neither read nor stopped at (D1919)", () => {
    // 202 twelve-digit numbers each: past `reach` in characters, short of `LONG_REPLY.numbers` in elements.
    const text = `[${`[${"123456789012,".repeat(201)}1],`.repeat(300)}1]`;
    expect(byteShapeOrStop(encoder.encode(text), 1_008, 1_010_000)).toBe(WITHIN);
    const before = numbersCalls.count;
    const seen = newTextShape(text, true);
    expect(scanText(text, 1_008, 1_010_000, seen)).toBe(WITHIN);
    expect(numbersCalls.count).toBe(before);
    // 600 of them, the same length each: read.
    const long = `[${`[${"123456789012,".repeat(599)}1],`.repeat(3)}1]`;
    expect(byteShapeOrStop(encoder.encode(long), 1_008, 1_010_000)).toBe(STOPPED);
    expect(same(parseJsonText(long), JSON.parse(long))).toBe(true);
    expect(numbersCalls.count).toBe(before + 3);
    expect(scratchIsClear()).toBe(true);
  });

  test("where readNumbers gives up, it says where, with the commas before it (D1919)", () => {
    for (const [text, at, commas] of [
      ["[1,2,3,0.30000000000000004,1e400,12345678901234567,4]", 33, 5],
      ["[1, 2 ,[3]]", 7, 2],
      ["[1,2,{}]", 5, 2],
      ['[null,true,"x"]', 11, 2],
    ] as [string, number, number][]) {
      expect(readNumbers(text, 0, 100)).toBe(NOT_NUMBERS);
      expect([numbersStop.at, numbersStop.commas]).toEqual([at, commas]);
    }
    expect(readNumbers("[1,null,true,false,-0]", 0, 100)).toBe(21);
    expect(numbersRead).toEqual([1, null, true, false, -0]);
    expect(Object.is(numbersRead[4], -0)).toBe(true);
    // Two such numbers, and one in eight elements past that, are read: giving up at one cost what had been read before
    // it (1.2-1.6x main).
    NUMBER_REGION.first = 4;
    const late = `[${"1,".repeat(8)}0.30000000000000004,${"2,".repeat(8)}1e400,${"3,".repeat(8)}1234567890123456789,4]`;
    expect(readNumbers(late, 0, 100)).toBe(late.length - 1);
    expect(same(numbersRead, JSON.parse(late))).toBe(true);
    // Once 4,096 elements have read, every number past the fast path is read: a series that turned into computed
    // doubles half way was given up near its end and parsed whole, at 1.1-1.3x main and up to 1.9x its memory.
    const doubles = Array.from({ length: 3_000 }, (_, k) => String(k / 7 + 0.1));
    const turned = `[${"12,".repeat(4_100)}${doubles.join(",")}]`;
    expect(readNumbers(turned, 0, 1_010_000)).toBe(turned.length - 1);
    expect(same(numbersRead, JSON.parse(turned))).toBe(true);
    // Before then the rule holds: the same doubles after 1,000 rounded values are given up.
    expect(readNumbers(`[${"12,".repeat(1_000)}${doubles.join(",")}]`, 0, 1_010_000)).toBe(NOT_NUMBERS);
    // What no JSON array holds: the reply is not JSON.
    for (const bad of [
      "[1,2,nn,3]",
      "[1,--1]",
      "[1,1.2.3]",
      "[1,2,]",
      "[1,nul,2]",
      "[1,2x]",
      "[1,+1]",
      "[1,.5]",
      "[01]",
    ]) {
      expect(readNumbers(bad, 0, 100)).toBe(NOT_JSON);
      expect(tryParse(bad)).toBeUndefined();
    }
  });

  test("a counted array that stops after its count goes on from its `]`, with every comma counted (D1919)", () => {
    // The commas up to the `]` were counted, so the scan has nothing to count again there.
    NUMBER_REGION.first = 2;
    NUMBER_REGION.most = 16;
    const text = `[1,2,3,4,5,6,${"9".repeat(40)},7,8]`;
    expect(readNumbers(text, 0, 100, text.length - 1)).toBe(NOT_NUMBERS);
    expect([numbersStop.at, numbersStop.commas]).toEqual([text.length - 1, 8]);
  });

  test("a long reply whose number array is not JSON is refused at it, as JSON.parse refuses it (D1919)", () => {
    const ids = Array.from({ length: 300_000 }, (_, k) => String(100_000 + ((k * 7919) % 900_000)));
    for (const bad of ["nn", "--1", "1.2.3", "nul", "1e"]) {
      for (const at of [170, 150_000, 299_000]) {
        const xs = ids.slice();
        xs[at] = bad;
        const text = `{"ids":[${xs.join(",")}]}`;
        expect(parseJsonText(text)).toBeUndefined();
        expect(parseJsonBytes(encoder.encode(text))).toBeUndefined();
        const seen = newTextShape(text, true);
        expect(scanText(text, 1_008, 1_010_000, seen)).toBe(NOT_JSON_REPLY);
        releaseScratch();
      }
    }
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
