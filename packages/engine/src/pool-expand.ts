/**
 * M12 (D1000–D1009, trial `poolExpand`; docs/research/m12-pool.md): a request's expansion into item vocabulary,
 * learned offline from a teacher's scores (packages/sim/lab/m12/train.py) and served as a table: each request term
 * has at most a few item terms with a weight. No vectors, no model call: a request's expansion is the sum of its
 * terms' rows, read in microseconds.
 *
 * The file (`EM12`, version 1, little-endian):
 *   magic "EM12", u32 version, f32 scale, u32 item terms, u32 request terms, u32 item bytes, u32 request bytes,
 *   the item terms and the request terms (UTF-8, each list joined by "\n"),
 *   per request term: u8 k, k × u16 item term index, k × u8 weight (weight = q × scale / 255).
 * Request terms are the shared tokenizer's (`tokenizeInto`), so a request is read exactly as the index reads text.
 */
import { tokenizeInto, Vocab } from "@eden/primitives";

const MAGIC = 0x32314d45; // "EM12"

export interface PoolExpansion {
  /** The model's item terms by index (what `expand` returns indexes into). */
  readonly itemTerms: readonly string[];
  /** The request's expansion: at most `max` item term indexes, best first, with their summed weights. */
  expand(text: string, max: number): { terms: Uint16Array; weights: Float32Array; n: number };
  /** Bytes the model holds (its table and term strings, about). */
  readonly bytes: number;
}

/** Reads an `EM12` file. Throws on a malformed one: a model that does not load is a deploy error, not a request's. */
export function loadPoolExpansion(buf: Uint8Array): PoolExpansion {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 28 || view.getUint32(0, true) !== MAGIC) throw new Error("pool expansion: not an EM12 file");
  if (view.getUint32(4, true) !== 1) throw new Error("pool expansion: unknown version");
  const scale = view.getFloat32(8, true);
  const nItem = view.getUint32(12, true);
  const nReq = view.getUint32(16, true);
  const itemBytes = view.getUint32(20, true);
  const reqBytes = view.getUint32(24, true);
  let at = 28;
  const dec = new TextDecoder();
  const itemTerms = nItem > 0 ? dec.decode(buf.subarray(at, at + itemBytes)).split("\n") : [];
  at += itemBytes;
  const reqTerms = nReq > 0 ? dec.decode(buf.subarray(at, at + reqBytes)).split("\n") : [];
  at += reqBytes;
  if (itemTerms.length !== nItem || reqTerms.length !== nReq) throw new Error("pool expansion: term lists differ");
  // Request terms in a vocabulary of their own: a request is tokenized straight to row ids (no strings made).
  const vocab = new Vocab(Math.max(1_024, nReq * 2));
  const rowOf = new Int32Array(nReq).fill(-1);
  const start = new Uint32Array(nReq + 1);
  const cols: number[] = [];
  const ws: number[] = [];
  for (let r = 0; r < nReq; r++) {
    const id = vocab.intern(reqTerms[r]!);
    if (id >= rowOf.length) throw new Error("pool expansion: request vocabulary ids out of range");
    rowOf[id] = r;
    const k = buf[at++]!;
    start[r] = cols.length;
    for (let j = 0; j < k; j++) cols.push(view.getUint16(at + 2 * j, true));
    at += 2 * k;
    for (let j = 0; j < k; j++) ws.push((buf[at + j]! * scale) / 255);
    at += k;
  }
  start[nReq] = cols.length;
  if (at !== buf.byteLength) throw new Error("pool expansion: trailing bytes");
  const col = Uint16Array.from(cols);
  const wt = Float32Array.from(ws);
  for (const c of col) if (c >= nItem) throw new Error("pool expansion: item index out of range");
  // Scratch, reused per call (the engine is single-threaded per process): sums over item terms and the touched list.
  const acc = new Float32Array(nItem);
  const touched = new Uint16Array(nItem);
  const seen = new Uint8Array(nReq);
  let ids = new Uint32Array(256);
  const outTerms = new Uint16Array(256);
  const outW = new Float32Array(256);
  return {
    itemTerms,
    bytes: col.byteLength + wt.byteLength + start.byteLength + itemBytes + reqBytes,
    expand(text: string, max: number) {
      if (ids.length < text.length) ids = new Uint32Array(Math.max(text.length, ids.length * 2));
      const n = tokenizeInto(text, vocab, false, ids, null);
      let t = 0;
      const rows: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = rowOf[ids[i]!] ?? -1;
        if (r < 0 || seen[r]) continue;
        seen[r] = 1;
        rows.push(r);
        for (let j = start[r]!; j < start[r + 1]!; j++) {
          const c = col[j]!;
          if (acc[c] === 0) touched[t++] = c;
          acc[c]! += wt[j]!;
        }
      }
      for (const r of rows) seen[r] = 0;
      // The best `max`, by weight, then by item term index (deterministic on ties).
      const m = Math.min(max, 256);
      let k = 0;
      for (let i = 0; i < t; i++) {
        const c = touched[i]!;
        const w = acc[c]!;
        acc[c] = 0;
        let p = k < m ? k++ : m;
        if (p === m && !(w > outW[m - 1]! || (w === outW[m - 1]! && c < outTerms[m - 1]!))) continue;
        if (p === m) p = m - 1;
        while (p > 0 && (outW[p - 1]! < w || (outW[p - 1]! === w && outTerms[p - 1]! > c))) {
          outW[p] = outW[p - 1]!;
          outTerms[p] = outTerms[p - 1]!;
          p--;
        }
        outW[p] = w;
        outTerms[p] = c;
      }
      return { terms: outTerms.slice(0, k), weights: outW.slice(0, k), n: k };
    },
  };
}
