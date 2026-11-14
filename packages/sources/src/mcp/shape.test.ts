/**
 * The vendored shape check (`shape.ts`) stays Eden's (`@eden/protocol`'s `validate.ts`): the same source, the same
 * bounds; and its string form gives the byte scan's answer on the bytes a string was decoded from (D1860).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { bodyShapeUnder, bodyShapeWithin, textShapeWithin } from "./shape";

/** The scan's source in `validate.ts`: from `bodyShapeWithin`'s doc comment to the end of `stringEnd`. */
function edenSource(): string {
  const text = readFileSync(EDEN, "utf8");
  const start = text.indexOf("/** `bodyShapeUnder` with its bounds given");
  const end = text.indexOf("\n}\n", text.indexOf("function stringEnd(")) + 3;
  return text.slice(start, end);
}

/** The vendored copy in `shape.ts`, between its markers. */
function vendoredSource(): string {
  const text = readFileSync(new URL("./shape.ts", import.meta.url), "utf8");
  const start = text.indexOf("\n", text.indexOf("// ---- vendored from")) + 2;
  const end = text.indexOf("\n// ---- end of the vendored copy");
  return text.slice(start, end);
}

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

/** Eden's copy; absent when this directory is used on its own, where the sync tests are skipped. */
const EDEN = new URL("../../../protocol/src/validate.ts", import.meta.url);

describe.skipIf(!existsSync(EDEN))("the vendored copy", () => {
  test("is Eden's source, character for character", () => {
    const eden = edenSource();
    expect(eden.length).toBeGreaterThan(2_000);
    expect(vendoredSource()).toBe(eden);
  });

  test("has Eden's bounds: the same answers at and past them", async () => {
    const { bodyShapeUnder: edenShapeUnder } = (await import(EDEN.href)) as typeof import("./shape");
    const enc = new TextEncoder();
    const bodies = [
      `{"x":${"[".repeat(1_007)}${"]".repeat(1_007)}}`,
      `{"x":${"[".repeat(1_008)}${"]".repeat(1_008)}}`,
      `${"[".repeat(1_008)}${"]".repeat(1_008)}`,
      `[${"0,".repeat(1_009_998)}0]`,
      `[${"0,".repeat(1_009_999)}0]`,
      `[${"0,".repeat(1_010_000)}0]`,
      `{"a":"${"\\\\".repeat(5_000)}"}`,
    ];
    let differ = 0;
    for (const b of bodies) {
      const bytes = enc.encode(b);
      expect(bodyShapeUnder(bytes)).toBe(edenShapeUnder(bytes));
      differ += bodyShapeUnder(bytes) ? 0 : 1;
    }
    expect(differ).toBeGreaterThanOrEqual(2); // both answers are reached
  });
});

describe("textShapeWithin", () => {
  const PIECES = ['"', "\\", "[", "]", "{", "}", ",", ":", "a", "1", " ", "é", "😀", " "];
  const BYTES = [0xef, 0xbb, 0xbf, 0xc3, 0xe2, 0x80, 0xf0, 0x9f, 0xff, 0xfe, 0x5c, 0x22, 0x5b, 0x2c];

  /** Seeded random bodies: JSON-ish text, with stray bytes (invalid UTF-8, byte-order marks) mixed in. */
  function body(r: () => number): Uint8Array {
    const enc = new TextEncoder();
    const parts: number[] = [];
    const n = Math.floor(r() * (r() < 0.1 ? 3_000 : 120));
    for (let i = 0; i < n; i++) {
      if (r() < 0.15) parts.push(BYTES[Math.floor(r() * BYTES.length)]!);
      else {
        const p = PIECES[Math.floor(r() * PIECES.length)]!;
        const run = r() < 0.05 ? 40 + Math.floor(r() * 60) : 1;
        for (const b of enc.encode(p.repeat(run))) parts.push(b);
      }
    }
    return Uint8Array.from(parts);
  }

  test("gives the byte scan's answer on what the bytes decode to, on 20,000 seeded bodies at small bounds", () => {
    const r = rng(1860);
    const dec = new TextDecoder();
    let refused = 0;
    for (let i = 0; i < 20_000; i++) {
      const bytes = body(r);
      const depth = 1 + Math.floor(r() * 6);
      const values = 1 + Math.floor(r() * 40);
      const want = bodyShapeWithin(bytes, depth, values);
      expect(textShapeWithin(dec.decode(bytes), depth, values)).toBe(want);
      if (!want) refused++;
    }
    expect(refused).toBeGreaterThan(5_000);
    expect(refused).toBeLessThan(15_000);
  });

  test("is linear on a string of escapes and on long strings (the quadratic case D1840 caught)", () => {
    const t0 = performance.now();
    expect(textShapeWithin(`"${"\\".repeat(4 * 1024 * 1024)}`, 1_008, 1_010_000)).toBe(true);
    expect(textShapeWithin(`["${"x".repeat(4 * 1024 * 1024)}"]`, 1_008, 1_010_000)).toBe(true);
    expect(textShapeWithin(`"${'\\"'.repeat(2 * 1024 * 1024)}"`, 1_008, 1_010_000)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});
