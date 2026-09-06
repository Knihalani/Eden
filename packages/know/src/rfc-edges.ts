/** Frozen RFC obsoletes/updates. RE09 blob — load only when search needs an edge. */
import { readFileSync } from "node:fs";
import { brotliDecompressSync, zstdDecompressSync } from "node:zlib";

const TD = new TextDecoder();

export type RfcEdgeRow = { src: number; dests: number[] };

let file: Uint8Array | undefined;
let hdr: { obsN: number; updN: number; kind: number; body: Uint8Array } | undefined;
let rows: { obs: RfcEdgeRow[]; upd: RfcEdgeRow[] } | undefined;

function vb(p: { o: number; b: Uint8Array }) {
  let x = 0;
  let s = 0;
  for (;;) {
    const b = p.b[p.o++]!;
    x |= (b & 127) << s;
    if (b < 128) return x >>> 0;
    s += 7;
  }
}

function header() {
  if (hdr) return hdr;
  file = new Uint8Array(readFileSync(new URL("./rfc-edges.bin", import.meta.url)));
  if (TD.decode(file.subarray(0, 4)) !== "RE09") throw new Error("rfc-edges.bin");
  const kind = file[4]!;
  const n = new DataView(file.buffer, file.byteOffset + 5, 4).getUint32(0, true);
  const obsN = new DataView(file.buffer, file.byteOffset + 9, 2).getUint16(0, true);
  const updN = new DataView(file.buffer, file.byteOffset + 11, 2).getUint16(0, true);
  hdr = { obsN, updN, kind, body: file.subarray(13, 13 + n) };
  return hdr;
}

function takeEg09(p: { o: number; b: Uint8Array }): RfcEdgeRow[] {
  const single = p.b[p.o++] === 1;
  const n = p.b[p.o]! | (p.b[p.o + 1]! << 8) | (p.b[p.o + 2]! << 16) | (p.b[p.o + 3]! << 24);
  p.o += 4;
  const srcs: number[] = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += vb(p);
    srcs.push(prev);
  }
  const out: RfcEdgeRow[] = [];
  for (const src of srcs) {
    const k = single ? 1 : vb(p);
    const dests: number[] = [];
    let pd = 0;
    for (let j = 0; j < k; j++) {
      pd += vb(p);
      dests.push(pd);
    }
    out.push({ src, dests });
  }
  return out;
}

function load() {
  if (rows) return rows;
  const h = header();
  let body = h.body;
  if (h.kind === 1) body = new Uint8Array(zstdDecompressSync(body));
  else if (h.kind === 2) body = new Uint8Array(brotliDecompressSync(body));
  if (TD.decode(body.subarray(0, 4)) !== "EG09") throw new Error("rfc-edges EG09");
  const p = { o: 4, b: body };
  const obs = takeEg09(p);
  const upd = takeEg09(p);
  if (obs.length !== h.obsN || upd.length !== h.updN) throw new Error("rfc-edges count");
  rows = { obs, upd };
  return rows;
}

export function rfcEdgeCounts(): { obs: number; upd: number } {
  const h = header();
  return { obs: h.obsN, upd: h.updN };
}

export function loadRfcEdges(): { obs: RfcEdgeRow[]; upd: RfcEdgeRow[] } {
  return load();
}

function norm(m: Map<number, number[]>): string {
  return [...m.keys()]
    .sort((a, b) => a - b)
    .map((k) => `${k}:${[...new Set(m.get(k)!)].sort((a, b) => a - b).join(",")}`)
    .join("|");
}

function rowsToMap(rows: RfcEdgeRow[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const e of rows) m.set(e.src, e.dests.slice());
  return m;
}

/** True when packed obs/upd are exactly the frozen sidecar (live 8299-fact graph). */
export function rfcEdgesMatch(obs: Map<number, number[]>, upd: Map<number, number[]>): boolean {
  const c = rfcEdgeCounts();
  if (obs.size !== c.obs || upd.size !== c.upd) return false;
  const u = load();
  return norm(obs) === norm(rowsToMap(u.obs)) && norm(upd) === norm(rowsToMap(u.upd));
}
