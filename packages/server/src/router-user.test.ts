/**
 * D1925: the router's `userOf` scans the body instead of parsing it. Its oracle is the parse it replaced, kept here
 * verbatim (`userOfByParse`): over random bodies (escaped and duplicate keys, nested userIds, BOMs, invalid JSON and
 * UTF-8, non-string ids, control characters, truncations) and the large and padded ones, the two must route alike.
 */
import { describe, expect, test } from "bun:test";
import { bodyShapeUnder } from "@eden/protocol";
import { userOf } from "./router";

const decoder = new TextDecoder();
/** The router's `userOf` before D1925, verbatim. */
function userOfByParse(body: Uint8Array): string {
  if (body.byteLength === 0 || !bodyShapeUnder(body)) return "";
  try {
    const parsed: unknown = JSON.parse(decoder.decode(body));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const user = (parsed as Record<string, unknown>).userId;
      if (typeof user === "string") return user;
    }
  } catch {
    // Not JSON, or nested past the parser's depth.
  }
  return "";
}

/** Mulberry32: the same bodies every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const enc = new TextEncoder();
const concat = (...parts: (Uint8Array | number[])[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Random JSON text with userId keys sprinkled at every level, written with odd but valid spellings. */
function body(r: () => number): string {
  const long = () => longText(r);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const ws = () => pick(["", "", "", " ", "\n", "\t", "\r\n ", "  "]);
  const key = (): string => {
    if (r() < 0.45) {
      // userId, sometimes with some characters escaped, sometimes near-misses
      const k = pick(["userId", "userId", "userId", "userid", "userId ", "user", "userIdx", "useRId", "\u0000userId"]);
      let out = "";
      for (const ch of k) {
        const code = ch.charCodeAt(0);
        out +=
          r() < 0.15 ? `\\u${code.toString(16).padStart(4, "0")[r() < 0.5 ? "toUpperCase" : "toLowerCase"]()}` : ch;
      }
      return out.replace(/\u0000/g, "\\u0000");
    }
    return pick(["text", "sessionId", "kind", "meta", "items", "__proto__", "id", "é", "😀", 'a\\"b']);
  };
  const str = (): string => {
    if (r() < 0.25) return `"${long()}"`;
    const s = pick(["u1", "u-ü1", "", "user 2", "😀", "\\n", '\\"q\\"', "\\ud800", "\\u00e9", "a\\/b", "x".repeat(40)]);
    return `"${s}"`;
  };
  const value = (d: number): string => {
    const t = r();
    if (d > 4 || t < 0.4) return pick([str(), str(), "5", "-0.5e+3", "0", "true", "false", "null", "1E9", "-12"]);
    if (t < 0.7) {
      const n = Math.floor(r() * 4);
      const members = Array.from({ length: n }, () => `${ws()}"${key()}"${ws()}:${ws()}${value(d + 1)}${ws()}`);
      return `{${members.join(",")}${n === 0 ? ws() : ""}}`;
    }
    const n = Math.floor(r() * 4);
    return `[${Array.from({ length: n }, () => `${ws()}${value(d + 1)}${ws()}`).join(",")}]`;
  };
  // At the top level a userId key mostly holds a string, so many bodies route.
  const member = () => {
    const k = key();
    const v = /^user/i.test(k) && r() < 0.7 ? str() : value(1);
    return `${ws()}"${k}"${ws()}:${ws()}${v}${ws()}`;
  };
  const members = Array.from({ length: Math.floor(r() * 5) }, member);
  return `${ws()}{${members.join(",")}}${ws()}`;
}

/**
 * A long string's characters (up to 1,500 bytes), so the scan's searches, its doubling run and its four-byte control
 * test are reached: plain runs of random length with escapes, non-ASCII and the odd raw control byte between them.
 */
function longText(r: () => number): string {
  const parts = ["\\n", '\\"', "\\\\", "\\u00e9", "é", "😀", "\t", "\u001f", "\\/"];
  let out = "";
  const target = Math.floor(r() * 1_500);
  while (out.length < target) {
    out += "abcdefghij klmnopqrstuvwxyz".slice(0, Math.floor(r() * 27)).repeat(Math.floor(r() * (r() < 0.3 ? 40 : 3)));
    // Raw tabs and control bytes are rare, so most long strings stay valid.
    const p = parts[Math.floor(r() * parts.length)]!;
    out += (p === "\t" || p === "\u001f") && r() < 0.9 ? "\\t" : p;
  }
  return out;
}

/** One random change of a byte, or none: a structural byte, a control byte, invalid UTF-8, a cut. */
function mutate(bytes: Uint8Array, r: () => number): Uint8Array {
  const t = r();
  if (t < 0.4 || bytes.length === 0) return bytes;
  const at = Math.floor(r() * bytes.length);
  const junk = [0x22, 0x5c, 0x7b, 0x7d, 0x5b, 0x5d, 0x2c, 0x3a, 0x00, 0x1f, 0x7f, 0x80, 0xc3, 0xff, 0x20, 0x30, 0x2d];
  const byte = junk[Math.floor(r() * junk.length)]!;
  if (t < 0.6) return concat(bytes.subarray(0, at), [byte], bytes.subarray(at + 1));
  if (t < 0.75) return concat(bytes.subarray(0, at), [byte], bytes.subarray(at));
  if (t < 0.9) return concat(bytes.subarray(0, at), bytes.subarray(at + 1));
  return bytes.subarray(0, at);
}

const BOM = [0xef, 0xbb, 0xbf];

describe("userOf against the parse it replaced (D1925)", () => {
  test("random bodies: escaped and duplicate keys, nesting, BOMs, invalid JSON and UTF-8, non-string ids", () => {
    const r = rng(1925);
    let differ = 0;
    let routed = 0;
    const N = 60_000;
    for (let k = 0; k < N; k++) {
      let bytes: Uint8Array = enc.encode(body(r));
      const lead = r();
      if (lead < 0.08) bytes = concat(BOM, bytes);
      else if (lead < 0.1) bytes = concat(BOM, BOM, bytes);
      else if (lead < 0.11) bytes = concat([0xef, 0xbb], bytes);
      bytes = mutate(bytes, r);
      if (r() < 0.2) bytes = mutate(bytes, r);
      // At any offset in a larger buffer, as a pooled Buffer's view is: the four-byte test aligns itself.
      const offset = Math.floor(r() * 8);
      const room = new Uint8Array(bytes.length + offset + Math.floor(r() * 4));
      room.fill(0x22);
      room.set(bytes, offset);
      bytes = room.subarray(offset, offset + bytes.length);
      const want = userOfByParse(bytes);
      if (want !== "") routed++;
      if (userOf(bytes) !== want) {
        differ++;
        if (differ <= 5) console.error("differs:", JSON.stringify(decoder.decode(bytes)), want, userOf(bytes));
      }
    }
    expect(differ).toBe(0);
    // The bodies exercise both answers.
    expect(routed).toBeGreaterThan(N / 30);
    console.error(`userOf fuzz: ${N} bodies, ${routed} routed, ${differ} differ`);
  });

  test("hand-picked spellings", () => {
    const cases = [
      `{"userId":"a","userId":"b"}`,
      `{"userId":"a","userId":5}`,
      `{"userId":5,"userId":"a"}`,
      `{"\\u0075serId":"esc"}`,
      `{"user\\u0049d":"esc","userId":"plain"}`,
      `{"userId":"plain","\\u0075\\u0073\\u0065\\u0072\\u0049\\u0064":"all"}`,
      `{"userId":"\\ud83d\\ude00"}`,
      `{"userId":"\\ud800"}`,
      `{"userId":"a\\u0000b"}`,
      `{"userId":"a"} x`,
      `{"userId":"a"}}`,
      `{"userId":"a",}`,
      `{"userId":"a"`,
      `{"userId" : "a" }`,
      `{"userId":{"userId":"inner"}}`,
      `{"x":{"userId":"inner"},"y":[{"userId":"deeper"}]}`,
      `{"userId":01}`,
      `{"userId":"a","n":01}`,
      `{"userId":"a","n":-}`,
      `{"userId":"a","n":1.}`,
      `{"userId":"a","n":1e}`,
      `{"userId":"a","n":tru}`,
      `{"userId":"a","n":"\\x"}`,
      `{"userId":"a","n":"\\u12G4"}`,
      `{"userId":"a","n":"tab\there"}`,
      `{"userId":null}`,
      `{"userId":["a"]}`,
      `{"userId":""}`,
      `{}`,
      ` \t\r\n{"userId":"ws"} \n`,
      `{"userId":"a"} `,
      `{"userId":"a"}﻿`,
      `﻿{"userId":"bom"}`,
      `﻿﻿{"userId":"bom2"}`,
      `{"userId":"a","__proto__":{"userId":"p"}}`,
      `{"__proto__":{"userId":"p"}}`,
      `[{"userId":"arr"}]`,
      `"userId"`,
      `{"userId":"a"}{"userId":"b"}`,
    ];
    for (const c of cases) expect([c, userOf(enc.encode(c))]).toEqual([c, userOfByParse(enc.encode(c))]);
    const bytes = [
      concat(enc.encode(`{"userId":"a`), [0xc3], enc.encode(`"}`)),
      concat(enc.encode(`{"userId":"a`), [0xff, 0xfe], enc.encode(`"}`)),
      concat(enc.encode(`{"userId":"a"`), [0xc3], enc.encode(`}`)),
      concat(enc.encode(`{"userId":"a`), [0xe2, 0x82], enc.encode(`"}`)),
    ];
    for (const b of bytes) expect(userOf(b)).toBe(userOfByParse(b));
  });

  test("large, deep and padded bodies", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ ref: `r${i}`, text: 'x\n"é'.repeat(500), meta: { i } }));
    const cases: Uint8Array[] = [
      enc.encode(JSON.stringify({ userId: "user-1", sourceId: "crm", items })),
      enc.encode(JSON.stringify({ items, userId: "late" })),
      enc.encode(JSON.stringify({ items: [items, { userId: "nested" }] })),
      enc.encode(`{"userId":"d","a":${"[".repeat(1007)}${"]".repeat(1007)}}`), // within the depth bound
      enc.encode(`{"userId":"d","a":${"[".repeat(1008)}${"]".repeat(1008)}}`), // one past it
      enc.encode(`{"userId":"d","a":${"[".repeat(60_000)}`),
      enc.encode(`{"userId":"v","a":[${"0,".repeat(1_009_990)}0]}`), // at the values bound
      enc.encode(`{"userId":"v","a":[${"0,".repeat(1_010_000)}0]}`), // past it
      enc.encode(`{"userId":"s","a":"${"\\u00e9".repeat(200_000)}"}`),
    ];
    for (const c of cases) expect(userOf(c)).toBe(userOfByParse(c));
    expect(userOf(cases[0]!)).toBe("user-1");
    expect(userOf(cases[3]!)).toBe("d");
    expect(userOf(cases[4]!)).toBe("");
  });
});
