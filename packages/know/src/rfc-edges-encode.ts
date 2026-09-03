/** Rebuild rfc-edges.bin (RE09 / EG09 + brotli-11). bun packages/know/src/rfc-edges-encode.ts */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, zstdCompressSync, constants as Z } from "node:zlib";
import { allFacts, decodePack, rfcNum } from "./pack";

function destNums(o: string): number[] | undefined {
  const parts = o.split(/\s*,\s*/).filter(Boolean);
  const nums: number[] = [];
  for (const p of parts) {
    const n = rfcNum(p);
    if (n === undefined) return;
    nums.push(n);
  }
  return nums.length ? nums : undefined;
}

function uniqueSorted(m: Map<number, number[]>, src: number): number[] {
  return [...new Set(m.get(src)!)].sort((a, b) => a - b);
}

function vbyte(n: number, out: number[]) {
  n >>>= 0;
  while (n >= 128) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
}

function encodeEg09(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const out: number[] = [69, 71, 48, 57];
  const put = (m: Map<number, number[]>, preferSingle: boolean) => {
    const keys = [...m.keys()].sort((a, b) => a - b);
    const allSingle = preferSingle && keys.every((k) => uniqueSorted(m, k).length === 1);
    out.push(allSingle ? 1 : 0);
    const n = keys.length;
    out.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
    let prev = 0;
    for (const src of keys) {
      vbyte(src - prev, out);
      prev = src;
    }
    for (const src of keys) {
      const dests = uniqueSorted(m, src);
      if (!allSingle) vbyte(dests.length, out);
      let pd = 0;
      for (const d of dests) {
        vbyte(d - pd, out);
        pd = d;
      }
    }
  };
  put(obs, true);
  put(upd, false);
  return Uint8Array.from(out);
}

function br11(buf: Uint8Array): Uint8Array {
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

function zs19(buf: Uint8Array): Uint8Array {
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

const paths = [
  new URL("../../../.gauntlet/refs/graph.kpk", import.meta.url),
  "/Users/kaiavnihalani/.eden/know/graph.kpk",
];
let live: Uint8Array | undefined;
for (const p of paths) {
  const loc = typeof p === "string" ? p : p.pathname;
  if (existsSync(loc)) {
    live = new Uint8Array(readFileSync(loc));
    break;
  }
}
if (!live) throw new Error("no live graph.kpk");

const obs = new Map<number, number[]>();
const upd = new Map<number, number[]>();
const add = (m: Map<number, number[]>, src: number, dests: number[]) => {
  const prev = m.get(src);
  if (prev) prev.push(...dests);
  else m.set(src, dests.slice());
};
for (const f of allFacts(decodePack(live))) {
  if (f.p !== "obsoletes" && f.p !== "updates") continue;
  const n = rfcNum(f.s);
  const dests = destNums(f.o);
  if (n === undefined || !dests) continue;
  add(f.p === "obsoletes" ? obs : upd, n, dests);
}

const raw = encodeEg09(obs, upd);
const b = br11(raw);
const z = zs19(raw);
const useBr = b.length <= z.length;
const body = useBr ? b : z;
const blob = new Uint8Array(13 + body.length);
blob[0] = 82;
blob[1] = 69;
blob[2] = 48;
blob[3] = 57;
blob[4] = useBr ? 2 : 1;
new DataView(blob.buffer).setUint32(5, body.length, true);
new DataView(blob.buffer).setUint16(9, obs.size, true);
new DataView(blob.buffer).setUint16(11, upd.size, true);
blob.set(body, 13);
const dest = new URL("./rfc-edges.bin", import.meta.url);
writeFileSync(dest, blob);
console.log(
  JSON.stringify({
    obs: obs.size,
    upd: upd.size,
    raw: raw.length,
    brotli: b.length,
    zstd: z.length,
    kind: useBr ? "brotli" : "zstd",
    bin: blob.length,
  }),
);
