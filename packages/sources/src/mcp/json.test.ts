/**
 * `parseJsonText` (D1870): long plain string values are spliced out of the parse as slices of the reply. Whatever the
 * text, the answer is `JSON.parse`'s behind the shape check: the same value, prototype and own keys, or undefined.
 */
import { describe, expect, test } from "bun:test";
import { parseJsonText } from "./json";
import { LONG_STRING, textShapeUnder } from "./shape";

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

/** What the plain path gives: the shape check, then `JSON.parse`. */
function plain(text: string): unknown {
  if (!textShapeUnder(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Deep equality that also sees own `__proto__` keys and prototypes, which `toEqual` would not tell apart. */
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

describe("parseJsonText", () => {
  test("equals the plain parse on 6,000 seeded replies with long strings, keys, duplicates and broken text", () => {
    const r = rng(1870);
    const long = () => {
      const n = LONG_STRING + Math.floor(r() * 3_000) - 1_500;
      const base = "y".repeat(n);
      const odd = ["é", "😀", "\\n", '\\"', "\u0001", "\t", "\\u0041", "\\\\"][Math.floor(r() * 8)]!;
      return r() < 0.6 ? base : base.slice(0, n >> 1) + odd + base.slice(n >> 1);
    };
    let differ = 0;
    let spliced = 0;
    for (let i = 0; i < 6_000; i++) {
      let t: string;
      if (r() < 0.75) {
        const parts = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, j) =>
          r() < 0.5 ? `S${j}` : { [`K${j}`]: `S${j}`, n: j },
        );
        t = JSON.stringify(r() < 0.1 ? "S0" : { result: { content: parts }, jsonrpc: "2.0", id: 1 });
        t = t.replace(/S(\d)/g, () => long());
        if (r() < 0.2) t = t.replace('"K0"', '"__proto__"');
        if (r() < 0.15) t = t.replace(/^\{/, `{"K0":"${long()}",`).replace(/\}$/, ',"K0":"dup"}');
        if (r() < 0.1) t = t.replace('"n"', `"${long()}"`); // a long key
        if (r() < 0.1) t = t.replace(" ", "").replace(":", " :\n\t");
        if (r() < 0.1) t = t.slice(0, Math.floor(r() * t.length));
      } else {
        const p = ['"k"', '"__proto__"', "1", "[", "]", "{", "}", ",", ":", " ", "null", `"${long()}"`, '"a"'];
        t = Array.from({ length: Math.floor(r() * 12) }, () => p[Math.floor(r() * p.length)]).join("");
      }
      const got = parseJsonText(t);
      if (!same(got, plain(t))) differ++;
      if (typeof got === "object" && got !== null && t.length > 2 * LONG_STRING) spliced++;
    }
    expect(differ).toBe(0);
    expect(spliced).toBeGreaterThan(1_000);
  });

  test("an own __proto__ key keeps its value and leaves the prototype alone", () => {
    const text = `{"__proto__":"${"x".repeat(LONG_STRING)}","a":{"__proto__":["${"y".repeat(LONG_STRING)}"]}}`;
    const got = parseJsonText(text) as Record<string, unknown>;
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(got, "__proto__")?.value).toBe("x".repeat(LONG_STRING));
    expect(same(got, JSON.parse(text))).toBe(true);
  });

  test("a later duplicate key wins, as in JSON.parse, where the dropped value was spliced out", () => {
    const text = `{"t":"${"x".repeat(LONG_STRING * 2)}","t":"short"}`;
    expect(parseJsonText(text)).toEqual({ t: "short" });
  });

  test("a string that is a key, or holds an escape or a control character, is parsed as JSON.parse would", () => {
    const x = "x".repeat(LONG_STRING);
    for (const t of [`{"${x}":1}`, `["${x}\\n"]`, `["${x}\u0001"]`, `["${x}\\u0041"]`, `"${x}`]) {
      expect(same(parseJsonText(t), plain(t))).toBe(true);
    }
    expect(parseJsonText(`["${x}\u0001"]`)).toBeUndefined();
  });

  test("the shape check still runs first: a deep body with a long string is refused before any parse", () => {
    const deep = `[{"t":"${"x".repeat(LONG_STRING * 4)}"},${"[".repeat(5_000)}${"]".repeat(5_000)}]`;
    expect(parseJsonText(deep)).toBeUndefined();
    expect(JSON.parse(deep)).toBeDefined(); // it was JSON: only the bound refused it
  });

  test("a long plain value is a slice of the reply, not a copy: JSC shows it as a substring of it", async () => {
    const { describe: jsc } = await import("bun:jsc");
    const text = `{"result":{"content":[{"type":"text","text":"${"x".repeat(LONG_STRING * 2)}"}]},"id":1}`;
    const value = parseJsonText(text) as { result: { content: { text: string }[] } };
    expect(jsc(value.result.content[0]!.text)).toStartWith("String (rope)");
    expect(jsc(JSON.parse(text).result.content[0].text)).not.toStartWith("String (rope)");
  });

  test("the value is the reply's characters, also outside ASCII and past the BMP", () => {
    const text = `{"a":"${"é😀z".repeat(LONG_STRING)}","b":2}`;
    expect(parseJsonText(text)).toEqual(JSON.parse(text));
  });
});
