/** Rebuild rfc-titles.bin (RT11). bun packages/know/src/rfc-titles-encode.ts */
import { writeFileSync } from "node:fs";
import { brotliCompressSync, zstdCompressSync, constants as Z } from "node:zlib";
import { rfcPackVocab, rfcTitleOf } from "./rfc-titles";

const TE = new TextEncoder();
const PART = /([^A-Za-z0-9]+)/;
const AL = /^[A-Za-z0-9]+$/;

function nospace(t: string): string[] {
  return t.split(PART).filter((x) => x.length > 0 && x !== " ");
}

function reconstruct(ps: string[]): string {
  let s = "";
  let prevAl = false;
  for (const p of ps) {
    const al = AL.test(p);
    if (s && prevAl && al) s += " ";
    s += p;
    prevAl = al;
  }
  return s;
}

function vbyte(n: number, out: number[]) {
  n >>>= 0;
  while (n >= 128) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
}

function pfc(strs: string[]): Uint8Array {
  const out: number[] = [];
  let prev = new Uint8Array(0);
  for (const s of strs) {
    const b = TE.encode(s);
    let k = 0;
    while (k < prev.length && k < b.length && prev[k] === b[k] && k < 255) k++;
    const slen = b.length - k;
    if (slen > 255) throw new Error("suffix");
    out.push(k, slen);
    for (let i = k; i < b.length; i++) out.push(b[i]!);
    prev = b;
  }
  return Uint8Array.from(out);
}

function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function wrap(kind: number, body: Uint8Array): Uint8Array {
  const o = new Uint8Array(9 + body.length);
  o[0] = 82;
  o[1] = 84;
  o[2] = 49;
  o[3] = 49; // RT11
  o[4] = kind;
  new DataView(o.buffer).setUint32(5, body.length, true);
  o.set(body, 9);
  return o;
}

function br(buf: Uint8Array): Uint8Array {
  return new Uint8Array(
    brotliCompressSync(buf, {
      params: {
        [Z.BROTLI_PARAM_QUALITY]: 11,
        [Z.BROTLI_PARAM_SIZE_HINT]: buf.length,
        [Z.BROTLI_PARAM_LGWIN]: 24,
      },
    }),
  );
}

function zs(buf: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(
      zstdCompressSync(buf, {
        params: { [Z.ZSTD_c_compressionLevel]: 22, [Z.ZSTD_c_windowLog]: 23 },
      }),
    );
  } catch {
    return new Uint8Array(zstdCompressSync(buf, { params: { [Z.ZSTD_c_compressionLevel]: 19 } }));
  }
}

const rows: { n: number; t: string }[] = [];
for (let i = 0; i <= 10038; i++) {
  const t = rfcTitleOf(i);
  if (t !== undefined) rows.push({ n: i, t });
}
if (rows.length !== 5227) throw new Error(`rows ${rows.length}`);

const packVocab = [...rfcPackVocab()];
if (packVocab.length !== 4568 || packVocab[0] !== " ") throw new Error("pack vocab");

const packSet = new Set(packVocab);
const titleTok = new Set<string>();
for (const r of rows) for (const p of nospace(r.t)) titleTok.add(p);
const extra = [...titleTok].filter((w) => !packSet.has(w)).sort();
const vocab = [...packVocab, ...extra];

const freq = new Map<string, number>();
for (const r of rows) for (const p of nospace(r.t)) freq.set(p, (freq.get(p) ?? 0) + 1);

const order = [...vocab.keys()].sort((a, b) => {
  const d = (freq.get(vocab[b]!) ?? 0) - (freq.get(vocab[a]!) ?? 0);
  return d || a - b;
});
const freqId = new Map<string, number>();
order.forEach((idx, r) => freqId.set(vocab[idx]!, r + 1));

const max = rows[rows.length - 1]!.n;
const bits = new Uint8Array((max + 8) >> 3);
for (const r of rows) bits[r.n >> 3]! |= 1 << (r.n & 7);

const counts: number[] = [];
for (const w of vocab) vbyte(freq.get(w) ?? 0, counts);

const stream: number[] = [];
let bad = 0;
for (const r of rows) {
  const ps = nospace(r.t);
  if (reconstruct(ps) !== r.t) bad++;
  for (const p of ps) vbyte(freqId.get(p)!, stream);
  stream.push(0);
}
if (bad) throw new Error(`reconstruct ${bad}`);

const parts = [
  u16le(packVocab.length),
  u16le(vocab.length),
  u16le(max),
  u16le(bits.length),
  bits,
  pfc(vocab),
  Uint8Array.from(counts),
  Uint8Array.from(stream),
];
let innerLen = 0;
for (const p of parts) innerLen += p.length;
const inner = new Uint8Array(innerLen);
let o = 0;
for (const p of parts) {
  inner.set(p, o);
  o += p.length;
}

const b = br(inner);
const z = zs(inner);
const useBr = b.length <= z.length;
const blob = wrap(useBr ? 2 : 1, useBr ? b : z);
const dest = new URL("./rfc-titles.bin", import.meta.url);
writeFileSync(dest, blob);
console.log(
  JSON.stringify({
    rows: rows.length,
    vocab: vocab.length,
    extra: extra.length,
    inner: inner.length,
    brotli: b.length,
    zstd: z.length,
    kind: useBr ? "brotli" : "zstd",
    bin: blob.length,
  }),
);
