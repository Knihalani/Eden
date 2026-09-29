// Minimal Model2Vec static-embedding inference in Bun/TS.
// BERT WordPiece tokenizer (BertNormalizer lowercase+strip accents, BertPreTokenizer) -> row lookup -> mean -> L2 normalize.
// Reads vocab.txt (fast) and mmaps model.safetensors (float32 "embeddings").
import { readFileSync } from "node:fs";

export type M2V = { vocab: Map<string, number>; emb: Float32Array; dim: number; unk: number; embed(text: string): Float32Array; tokenize(text: string): number[] };

function isPunct(cp: number): boolean {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return cp > 127 && /\p{P}/u.test(String.fromCodePoint(cp));
}
function isCjk(cp: number) { return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f); }

export function preTokenize(text: string): string[] {
  // clean_text + chinese chars + lowercase + strip accents
  let s = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || (/\p{Cc}|\p{Cf}/u.test(ch) && ch !== "\t" && ch !== "\n" && ch !== "\r")) continue;
    if (/\s/u.test(ch)) { s += " "; continue; }
    if (isCjk(cp)) { s += ` ${ch} `; continue; }
    s += ch;
  }
  s = s.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
  const out: string[] = [];
  for (const w of s.split(" ")) {
    if (!w) continue;
    let cur = "";
    for (const ch of w) { if (isPunct(ch.codePointAt(0)!)) { if (cur) out.push(cur); out.push(ch); cur = ""; } else cur += ch; }
    if (cur) out.push(cur);
  }
  return out;
}

export function loadM2V(dir: string): M2V {
  const vocab = new Map<string, number>();
  const lines = readFileSync(`${dir}/vocab.txt`, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) if (lines[i] !== "" || i < lines.length - 1) vocab.set(lines[i]!, i);
  const { existsSync } = require("node:fs");
  if (existsSync(`${dir}/emb.f32`) && existsSync(`${dir}/emb.shape`)) { // sleep-prepared aligned raw matrix: zero-copy mmap
    const [rows, dim] = readFileSync(`${dir}/emb.shape`, "utf8").trim().split(" ").map(Number) as [number, number];
    const b: Uint8Array = (globalThis as any).Bun.mmap(`${dir}/emb.f32`);
    return finish(vocab, new Float32Array(b.buffer, b.byteOffset, rows * dim), dim);
  }
  const buf: Uint8Array = (globalThis as any).Bun?.mmap ? (globalThis as any).Bun.mmap(`${dir}/model.safetensors`) : readFileSync(`${dir}/model.safetensors`);
  const hlen = Number(new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hlen)));
  const t = header.embeddings; if (t.dtype !== "F32") throw new Error("dtype " + t.dtype);
  const [rows, dim] = t.shape; const off = 8 + hlen + t.data_offsets[0];
  const emb = (off + buf.byteOffset) % 4 === 0 ? new Float32Array(buf.buffer, buf.byteOffset + off, rows * dim) : new Float32Array(buf.slice(off, off + rows * dim * 4).buffer);
  if ((off + buf.byteOffset) % 4 !== 0 && process.env.M2V_WARN) console.error("safetensors payload unaligned: copying", rows * dim * 4, "bytes");
  return finish(vocab, emb, dim);
}
function finish(vocab: Map<string, number>, emb: Float32Array, dim: number): M2V {
  const unk = vocab.get("[UNK]") ?? 1;
  const tokenize = (text: string): number[] => {
    const ids: number[] = [];
    for (const word of preTokenize(text)) {
      const chars = [...word]; if (chars.length > 100) { ids.push(unk); continue; }
      const sub: number[] = []; let start = 0, bad = false;
      while (start < chars.length) {
        let end = chars.length, found = -1;
        while (start < end) { const piece = (start > 0 ? "##" : "") + chars.slice(start, end).join(""); const id = vocab.get(piece); if (id !== undefined) { found = id; break; } end--; }
        if (found < 0) { bad = true; break; }
        sub.push(found); start = end;
      }
      if (bad) ids.push(unk); else ids.push(...sub);
    }
    return ids;
  };
  const embed = (text: string): Float32Array => {
    const ids = tokenize(text).filter((i) => i !== unk).slice(0, 512);
    const v = new Float32Array(dim); if (!ids.length) return v;
    for (const id of ids) { const o = id * dim; for (let j = 0; j < dim; j++) v[j] += emb[o + j]!; }
    let n = 0; for (let j = 0; j < dim; j++) { v[j] /= ids.length; n += v[j]! * v[j]!; } n = Math.sqrt(n) + 1e-32;
    for (let j = 0; j < dim; j++) v[j] /= n;
    return v;
  };
  return { vocab, emb, dim, unk, embed, tokenize };
}
