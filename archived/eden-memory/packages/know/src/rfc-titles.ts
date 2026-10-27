/** Frozen RFC titles. RT11 blob — vocab lives in the blob, not a sidecar table. */
import { readFileSync } from "node:fs";
import { brotliDecompressSync, zstdDecompressSync } from "node:zlib";
import { RFC_TITLE_HOT } from "./rfc-hot";

const TD = new TextDecoder();
const CAP = 64;
const AL = /^[A-Za-z0-9]+$/;

export type Rt11 = {
  max: number;
  nTitle: number;
  packN: number;
  bits: Uint8Array;
  pay: Uint8Array;
  off: Uint32Array;
  vOff: Uint32Array;
  vLen: Uint8Array;
  vBytes: Uint8Array;
  rankToVocab: Uint16Array;
};

let fileIdx: Rt11 | undefined;
const fileCache = new Map<number, string>();
let pack: string[] | undefined;

function pc(x: number) {
  x &= 255;
  x -= (x >>> 1) & 0x55;
  x = (x & 0x33) + ((x >>> 2) & 0x33);
  return (x + (x >>> 4)) & 15;
}

function vb(pay: Uint8Array, i: { o: number }) {
  let x = 0;
  let s = 0;
  for (;;) {
    const b = pay[i.o++]!;
    x |= (b & 127) << s;
    if (b < 128) return x >>> 0;
    s += 7;
  }
}

function tokAt(t: Rt11, vi: number) {
  const a = t.vOff[vi]!;
  return TD.decode(t.vBytes.subarray(a, a + t.vLen[vi]!));
}

function rankOf(t: Rt11, n: number) {
  let r = 0;
  const e = n >> 3;
  for (let i = 0; i < e; i++) r += pc(t.bits[i]!);
  return r + pc(t.bits[e]! & ((1 << (n & 7)) - 1));
}

/** Parse an RT11 buffer. Used by the pack (embedded) and by rfcTitleOf (shipped blob). */
export function parseRt11(f: Uint8Array): Rt11 | undefined {
  if (f.byteLength < 9 || TD.decode(f.subarray(0, 4)) !== "RT11") return;
  const kind = f[4]!;
  const n = new DataView(f.buffer, f.byteOffset + 5, 4).getUint32(0, true);
  let body = f.subarray(9, 9 + n);
  if (kind === 1) body = new Uint8Array(zstdDecompressSync(body));
  else if (kind === 2) body = new Uint8Array(brotliDecompressSync(body));
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let o = 0;
  const packN = dv.getUint16(o, true);
  o += 2;
  const nV = dv.getUint16(o, true);
  o += 2;
  const max = dv.getUint16(o, true);
  o += 2;
  const nB = dv.getUint16(o, true);
  o += 2;
  const bits = body.subarray(o, o + nB);
  o += nB;
  const vOff = new Uint32Array(nV);
  const vLen = new Uint8Array(nV);
  const buf = new Uint8Array(nV * 24);
  let w = 0;
  let prevOff = 0;
  for (let i = 0; i < nV; i++) {
    const pfx = body[o++]!;
    const slen = body[o++]!;
    vOff[i] = w;
    if (pfx) buf.set(buf.subarray(prevOff, prevOff + pfx), w);
    if (slen) buf.set(body.subarray(o, o + slen), w + pfx);
    o += slen;
    vLen[i] = pfx + slen;
    prevOff = w;
    w += pfx + slen;
  }
  const vBytes = buf.subarray(0, w);
  const counts = new Uint16Array(nV);
  const cr = { o };
  for (let i = 0; i < nV; i++) counts[i] = vb(body, cr);
  o = cr.o;
  const order = new Uint16Array(nV);
  for (let i = 0; i < nV; i++) order[i] = i;
  order.sort((a, b) => counts[b]! - counts[a]! || a - b);
  const pay = body.subarray(o);
  let nTitle = 0;
  for (let i = 0; i <= max; i++) if ((bits[i >> 3]! >> (i & 7)) & 1) nTitle++;
  const off = new Uint32Array(nTitle);
  const p = { o: 0 };
  for (let k = 0; k < nTitle; k++) {
    off[k] = p.o;
    while (vb(pay, p) !== 0) {}
  }
  return { max, nTitle, packN, bits, pay, off, vOff, vLen, vBytes, rankToVocab: order };
}

export function titleFromRt11(t: Rt11, n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > t.max) return;
  if (!((t.bits[n >> 3]! >> (n & 7)) & 1)) return;
  const p = { o: t.off[rankOf(t, n)]! };
  let s = "";
  let prevAl = false;
  for (;;) {
    const id = vb(t.pay, p);
    if (id === 0) break;
    const tok = tokAt(t, t.rankToVocab[id - 1]!);
    const al = AL.test(tok);
    if (s && prevAl && al) s += " ";
    s += tok;
    prevAl = al;
  }
  return s;
}

/** Titles in RFC-number order of set bits — same order as a complete rfcIs column. */
export function titlesFromRt11(f: Uint8Array): string[] {
  const t = parseRt11(f);
  if (!t) return [];
  const out: string[] = [];
  for (let n = 0; n <= t.max; n++) {
    const s = titleFromRt11(t, n);
    if (s !== undefined) out.push(s);
  }
  return out;
}

function loadFile() {
  if (fileIdx) return fileIdx;
  fileIdx = parseRt11(new Uint8Array(readFileSync(new URL("./rfc-titles.bin", import.meta.url))));
  if (!fileIdx) throw new Error("rfc-titles.bin");
  return fileIdx;
}

export function rfcTitleOf(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0) return;
  const hot = RFC_TITLE_HOT[n];
  if (hot) return hot;
  const t = loadFile();
  const hit = fileCache.get(n);
  if (hit !== undefined) {
    fileCache.delete(n);
    fileCache.set(n, hit);
    return hit;
  }
  const s = titleFromRt11(t, n);
  if (s === undefined) return;
  if (fileCache.size >= CAP) fileCache.delete(fileCache.keys().next().value as number);
  fileCache.set(n, s);
  return s;
}

/** Prefix of the blob vocab — frozen BV09 table, interned only when pack asks. */
export function rfcPackVocab(): readonly string[] {
  const t = loadFile();
  if (!pack) {
    pack = new Array(t.packN);
    for (let i = 0; i < t.packN; i++) pack[i] = tokAt(t, i);
  }
  return pack;
}
