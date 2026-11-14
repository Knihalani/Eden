/**
 * The turn gate (D1890) against the code it replaced (commit 60712533a), kept here as the reference: the same feature
 * ids, the same normalised text and the same verdict to the bit (logit, kind, needs) on the shipped weights and on
 * small generated weights that reach the other paths (a float table, the rule's ids, the clause gate, a skeleton,
 * masks of 12 and 22 bits). Fuzzed turns mix ASCII, every white space the normaliser folds, typographic punctuation,
 * accents, combining marks, ligatures, full-width forms, Turkish İ, Devanagari, CJK, emoji, lone surrogates and
 * turns past the 1,200 and 2,400 unit cuts. `GATE_FUZZ=200000` runs more.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gateFeatures, gateNorm, type RuleReading, TurnGate } from "./turn-gate";

// ---- The reference: turn-gate.ts before D1890, verbatim except names. ----

const FNV0 = 2166136261;
const FNVP = 16777619;
const MAXCP = 300;
const WS = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;
const WORDS = /[\p{L}\p{M}\p{N}'’]+/gu;

function oldNorm(s: string): string {
  const head = Array.from(s.slice(0, 8 * MAXCP))
    .slice(0, 4 * MAXCP)
    .join("");
  const t = head
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[0-9]/g, "0")
    .replace(WS, " ")
    .replace(/^ +| +$/g, "");
  return Array.from(t).slice(0, MAXCP).join("");
}

function oldHash(salt: number, cps: ArrayLike<number>, from = 0, to = cps.length): number {
  let x = Math.imul(FNV0 ^ salt, FNVP) >>> 0;
  for (let i = from; i < to; i++) x = Math.imul(x ^ cps[i]!, FNVP) >>> 0;
  return x;
}

function oldGrams(cps: Int32Array, from: number, to: number, lo: number, hi: number, salt: number, out: OldIds) {
  const seed = Math.imul(FNV0 ^ salt, FNVP) >>> 0;
  for (let i = from; i < to; i++) {
    let x = seed;
    const top = Math.min(hi, to - i);
    for (let k = 1; k <= top; k++) {
      x = Math.imul(x ^ cps[i + k - 1]!, FNVP) >>> 0;
      if (k >= lo) out.add(Math.imul(x ^ (k + 0x5bd1), FNVP) >>> 0);
    }
  }
}

class OldIds {
  buf = new Int32Array(4096);
  n = 0;
  constructor(readonly mask: number) {}
  add(x: number): void {
    if (this.n === this.buf.length) {
      const b = new Int32Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.n++] = x & this.mask;
  }
  done(): number[] {
    const s = this.buf.subarray(0, this.n).sort();
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) out.push(s[i]!);
    return out;
  }
}

function oldCps(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0)!);
  return out;
}

const oldWords = (t: string): string[] => t.match(WORDS) ?? [];

function oldFeatures(text: string, bits: number, skeleton?: ReadonlySet<string>): number[] {
  const out = new OldIds((1 << bits) - 1);
  const t = oldNorm(text);
  const cps = new Int32Array(t.length + 2);
  let n = 0;
  cps[n++] = 2;
  for (const ch of t) cps[n++] = ch.codePointAt(0)!;
  cps[n++] = 3;
  oldGrams(cps, 0, n, 1, 4, 100, out);
  oldGrams(cps, 0, Math.min(20, n - 1), 2, 4, 200, out);
  oldGrams(cps, Math.max(1, n - 10), n, 1, 3, 300, out);
  const ws = oldWords(t);
  const wc = ws.map(oldCps);
  for (const w of wc) out.add(oldHash(400, w));
  for (let i = 0; i + 1 < wc.length; i++) out.add(oldHash(401, [...wc[i]!, 32, ...wc[i + 1]!]));
  for (let i = 0; i < Math.min(3, wc.length); i++) out.add(oldHash(500 + i, wc[i]!));
  if (wc.length) out.add(oldHash(510, wc[wc.length - 1]!));
  out.add(oldHash(520, [Math.min(wc.length, 20)]));
  if (skeleton) {
    const seq: number[][] = [[2]];
    for (const w of ws.slice(0, 40)) seq.push(oldCps(skeleton.has(w) ? w : w.includes("0") ? "0" : "x"));
    seq.push([3]);
    for (let k = 1; k <= 3; k++)
      for (let i = 0; i + k <= seq.length; i++) {
        const g: number[] = [];
        for (const w of seq.slice(i, i + k)) g.push(...w, 32);
        out.add(oldHash(700 + k + (i === 0 ? 10 : 0), g));
      }
  }
  return out.done();
}

const RULE_IDS = { listed: 1, opened: 2, none: 3 } as const;
const CLAUSE = /(?<=[,;:.!?¿¡—–])\s+|\s+(?=(?:but|so|and then|anyway|also)\s)/i;
function oldClauses(text: string): string[] {
  const parts = text
    .slice(0, 8 * MAXCP)
    .split(CLAUSE)
    .filter((p) => p && p.trim());
  return parts.length > 1 ? parts.slice(0, 6) : [];
}

/** The old forward over the same parsed file (the parse itself did not change). */
class OldGate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly h: any;
  private readonly emb: Int8Array | Float32Array;
  private readonly arr = new Map<string, Float32Array>();
  private readonly skel: ReadonlySet<string> | undefined;
  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(4, true);
    this.h = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
    const base = bytes.byteOffset + 8 + len;
    let emb: Int8Array | Float32Array | null = null;
    for (const a of this.h.arrays) {
      const n = a.shape.reduce((x: number, y: number) => x * y, 1);
      if (a.dtype === "int8") emb = new Int8Array(bytes.buffer, base + a.offset, n);
      else {
        const f = new Float32Array(n);
        f.set(new Float32Array(bytes.slice(8 + len + a.offset, 8 + len + a.offset + 4 * n).buffer));
        if (a.name === "emb") emb = f;
        else this.arr.set(a.name, f);
      }
    }
    this.emb = emb!;
    this.skel = this.h.skel.length ? new Set(this.h.skel) : undefined;
  }
  private encode(text: string, rule?: RuleReading): number[] {
    const { dim, bits, hidden } = this.h;
    const ids = oldFeatures(text, bits, this.skel);
    if (this.h.rule && rule) {
      const mask = (1 << bits) - 1;
      const extra = [oldHash(600, [RULE_IDS[rule.how]]) & mask, oldHash(601, [rule.rest ? 2 : 1]) & mask];
      for (const e of extra) if (!ids.includes(e)) ids.push(e);
    }
    const x = new Float64Array(dim + (this.h.rule2 ? 4 : 0));
    const ids2 = ids.length ? ids : [0];
    for (const f of ids2) for (let d = 0; d < dim; d++) x[d]! += this.emb[f * dim + d]!;
    const scale = this.arr.get("scale");
    for (let d = 0; d < dim; d++) x[d] = (x[d]! * (scale ? scale[d]! : 1)) / ids2.length;
    if (this.h.rule2) {
      x[dim] = rule?.how === "listed" ? 1 : 0;
      x[dim + 1] = rule?.how === "opened" ? 1 : 0;
      x[dim + 2] = rule?.how === "none" ? 1 : 0;
      x[dim + 3] = rule?.rest ? 1 : 0;
    }
    if (!hidden) return [...x];
    const W = this.arr.get("hidW")!;
    const B = this.arr.get("hidB")!;
    const y: number[] = [];
    for (let j = 0; j < hidden; j++) {
      let s = B[j]!;
      for (let d = 0; d < x.length; d++) s += W[j * x.length + d]! * x[d]!;
      y.push(s > 0 ? s : 0);
    }
    return y;
  }
  private dot(name: string, row: number, v: number[]): number {
    const W = this.arr.get(name)!;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += W[row * v.length + i]! * v[i]!;
    return s;
  }
  read(text: string, rule?: RuleReading) {
    const v = this.encode(text, rule);
    let logit = this.dot("needsW", 0, v) + this.arr.get("needsB")![0]!;
    let best = 0;
    let top = -Infinity;
    const kb = this.arr.get("kindB")!;
    for (let k = 0; k < kb.length; k++) {
      const s = this.dot("kindW", k, v) + kb[k]!;
      if (s > top) [top, best] = [s, k];
    }
    if (this.h.arch === "mil")
      for (const c of oldClauses(text))
        logit = Math.max(logit, this.dot("needsW", 0, this.encode(c)) + this.arr.get("needsB")![0]!);
    const started = rule !== undefined && rule.how !== "none";
    const ruled = started && this.h.veto !== null && logit >= this.h.veto;
    const adds = logit >= this.h.logit && (started || oldWords(oldNorm(text)).length >= 3);
    return { needs: adds || ruled, kind: this.h.kinds[best], logit };
  }
}

// ---- Fuzzed turns. ----

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

const PIECES = [
  "book",
  "Cancel",
  "the",
  "MOT",
  "at",
  "Kwik",
  "Lane",
  "Saturday",
  "it's",
  "don’t",
  "I've",
  "O'Neil",
  "3pm",
  "10:30",
  "2026-11-14",
  "#42",
  "e-mail",
  "a.m.",
  "Zahnarzttermin",
  "Freitag",
  "verschieben",
  "sábado",
  "degustação",
  "İstanbul'a",
  "uçak",
  "lütfen",
  "ΣΊΣΥΦΟΣ",
  "straße",
  "ǅemal",
  "कृपया",
  "अपॉइंटमेंट",
  "明天下午三点",
  "帮我订餐厅",
  "🍣",
  "👍🏽",
  "👨‍👩‍👧",
  "ﬁle",
  "Ｆｕｌｌ",
  "①②",
  "½",
  "™",
  "…",
  "e\u0301",
  "n\u0303o",
  "\ud800",
  "\udc00x",
  "x\ud83c",
  "‘q’",
  "“q”",
  "–",
  "—",
  "-",
  "'",
  "’",
  "?",
  "!",
  ",",
  ".",
  "¿",
  "¡",
  "Ⅻ",
  "ℌ",
  "ｶﾞ",
  "가나다",
  "عربي",
  "١٢٣",
  "İ",
  "K",
  "ß",
  "ŉ",
];
const SPACES = [
  " ",
  " ",
  " ",
  "  ",
  "\t",
  "\n",
  "\r\n",
  "\v",
  "\f",
  "\u00a0",
  "\u2003",
  "\u3000",
  "\ufeff",
  "\u2028",
  "\u0085",
  "\u200b",
  "\u1680",
  "",
];

function turn(r: () => number): string {
  const k = r();
  if (k < 0.04) return "";
  const n = k < 0.9 ? 1 + Math.floor(r() * 25) : 300 + Math.floor(r() * 1400);
  let s = r() < 0.2 ? SPACES[Math.floor(r() * SPACES.length)]! : "";
  const ascii = r() < 0.5;
  for (let i = 0; i < n; i++) {
    const p = PIECES[Math.floor(r() * (ascii ? 17 : PIECES.length))]!;
    s += r() < 0.1 ? p.toUpperCase() : p;
    s += SPACES[Math.floor(r() * (ascii ? 9 : SPACES.length))]!;
  }
  if (r() < 0.05) s += String.fromCharCode(Math.floor(r() * 0x10000));
  return s;
}

const RULES: (RuleReading | undefined)[] = [
  undefined,
  { how: "none", rest: false },
  { how: "listed", rest: false },
  { how: "listed", rest: true },
  { how: "opened", rest: true },
];

const N = Number(process.env.GATE_FUZZ ?? 4000);
const SHIPPED = new Uint8Array(readFileSync(new URL("./turn-gate.bin", import.meta.url)));

describe("D1890: the turn gate against its earlier code", () => {
  test(`normalised text and feature ids on ${N} fuzzed turns (masks 16, 12, 22, a skeleton)`, () => {
    const r = rng(1890);
    const skel = new Set(["book", "the", "0", "it's", "cancel", "明天下午三点"]);
    for (let i = 0; i < N; i++) {
      const t = turn(r);
      expect(gateNorm(t)).toBe(oldNorm(t));
      expect(gateFeatures(t, 16)).toEqual(oldFeatures(t, 16));
      if (i % 4 === 0) {
        expect(gateFeatures(t, 12, skel)).toEqual(oldFeatures(t, 12, skel));
        expect(gateFeatures(t, 22)).toEqual(oldFeatures(t, 22));
      }
    }
  });

  test.each([
    `a${" ".repeat(1198)}bc`,
    `a${" ".repeat(1199)}b`,
    `${" ".repeat(1200)}b`,
    `a${"\u00a0".repeat(1198)}bc`,
    `${"x ".repeat(299)}y z`,
    `${"x ".repeat(300)}`,
    `${"😀".repeat(1199)}ab`,
    `${"a".repeat(2399)}😀b`,
    `${"é".repeat(1199)}ab`,
    "  \t\n ",
    "’’ ‘a’ “b” c–d—e",
  ])("the cuts: %#", (t) => {
    expect(gateNorm(t)).toBe(oldNorm(t));
    expect(gateFeatures(t, 16)).toEqual(oldFeatures(t, 16));
  });

  test(`the shipped gate's verdicts to the bit on ${N} fuzzed turns`, () => {
    const r = rng(1891);
    const now = new TurnGate(SHIPPED);
    const old = new OldGate(SHIPPED);
    // The same file a byte off 4-alignment: the table is copied, not viewed.
    const shifted = new Uint8Array(SHIPPED.length + 1);
    shifted.set(SHIPPED, 1);
    const copied = new TurnGate(shifted.subarray(1));
    for (let i = 0; i < N; i++) {
      const t = turn(r);
      const rule = RULES[i % RULES.length];
      const a = now.read(t, rule);
      const b = old.read(t, rule);
      expect(Object.is(a.logit, b.logit)).toBe(true);
      expect(a).toEqual(b);
      if (i % 8 === 0) expect(copied.read(t, rule)).toEqual(b);
    }
  });

  // Small weights that reach the paths the shipped file does not: a float table, the rule's ids, clauses, a skeleton.
  function weights(over: Record<string, unknown>, floatEmb: boolean, hidden: number, dim: number): Uint8Array {
    const r = rng(7 + hidden);
    const bits = 10;
    const width = dim + (over.rule2 === false ? 0 : 4);
    const out = hidden || width;
    const arrays: [string, "int8" | "float32", number[]][] = [
      ["emb", floatEmb ? "float32" : "int8", [1 << bits, dim]],
      ...(floatEmb ? [] : [["scale", "float32", [dim]] as [string, "float32", number[]]]),
      ...(hidden
        ? [
            ["hidW", "float32", [hidden, width]] as [string, "float32", number[]],
            ["hidB", "float32", [hidden]] as [string, "float32", number[]],
          ]
        : []),
      ["needsW", "float32", [out]],
      ["needsB", "float32", [1]],
      ["kindW", "float32", [5, out]],
      ["kindB", "float32", [5]],
    ];
    const blobs: Uint8Array[] = [];
    const meta: { name: string; dtype: string; shape: number[]; offset: number }[] = [];
    let off = 0;
    for (const [name, dtype, shape] of arrays) {
      const n = shape.reduce((x, y) => x * y, 1);
      let b: Uint8Array;
      if (dtype === "int8") b = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      else b = new Uint8Array(Float32Array.from({ length: n }, () => (r() - 0.5) * 3).buffer);
      meta.push({ name, dtype, shape, offset: off });
      blobs.push(b);
      off += b.length + ((4 - (b.length % 4)) % 4);
      if (b.length % 4) blobs.push(new Uint8Array((4 - (b.length % 4)) % 4));
    }
    const head = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        arch: "bag",
        bits,
        dim,
        hidden,
        quant: floatEmb ? "none" : "int8",
        rule: false,
        rule2: true,
        logit: 0,
        veto: -1,
        kinds: ["act", "qact", "ask", "chatter", "statement"],
        skel: [],
        arrays: meta,
        ...over,
      }),
    );
    const pad = (4 - ((8 + head.length) % 4)) % 4;
    const total = 8 + head.length + pad + off;
    const file = new Uint8Array(total);
    file.set(new TextEncoder().encode("EDG1"));
    new DataView(file.buffer).setUint32(4, head.length + pad, true);
    file.set(head, 8);
    file.fill(32, 8 + head.length, 8 + head.length + pad);
    let at = 8 + head.length + pad;
    for (const b of blobs) {
      file.set(b, at);
      at += b.length;
    }
    return file;
  }

  test.each([
    [
      "int8 by words, hidden, the rule's ids, clauses, a skeleton",
      { rule: true, arch: "mil", skel: ["book"] },
      false,
      7,
      8,
    ],
    ["int8 by bytes, the rule's ids, clauses", { rule: true, arch: "mil" }, false, 3, 6],
    ["float table, the rule's ids, no hidden layer", { rule: true }, true, 0, 6],
    ["float table, clauses, hidden", { arch: "mil", rule2: false }, true, 5, 6],
  ] as const)("generated weights: %s", (_name, over, floatEmb, hidden, dim) => {
    const bytes = weights(over as Record<string, unknown>, floatEmb, hidden, dim);
    const now = new TurnGate(bytes);
    const old = new OldGate(bytes);
    const r = rng(hidden + 11);
    for (let i = 0; i < Math.max(400, N / 4); i++) {
      const t = turn(r);
      const rule = RULES[i % RULES.length];
      const a = now.read(t, rule);
      const b = old.read(t, rule);
      expect(Object.is(a.logit, b.logit)).toBe(true);
      expect(a).toEqual(b);
    }
  });
});
