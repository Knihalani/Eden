/**
 * KnowPack — compact queryable graph.
 *
 * KPK5 (this encode): 4-bit kinds (16 namespaces). Scheme/WHATWG/block/method/rel/
 * well-known leave intern. Language is a 2-letter integer. Script is 4 packed chars.
 * Adaptive PFC block (8/16/32, keep smallest). WD02 picks vbyte / u16 / zigzag-δ.
 * Alias AL02 stores kind+payload. On-disk bloom 256 B. Split FOR over 16 kinds.
 *
 * KPK4 still decodes (3-bit kinds reconstructed into 4-bit ids). KPK3 2-bit tags
 * remap on load. Do not gzip / Hexastore / mmap / PFOR / Roaring at this size.
 */

import { indexTokens, postTokens } from "./tokens";
import {
  bareMediaType,
  ianaHttp,
  ianaMedia,
  ianaProtocol,
  ianaScheme,
  spdxId,
  unicodeBlock,
  whatwgSlug,
  ianaLanguage,
  ianaMethod,
  ianaRel,
  ianaWellKnown,
  unicodeScript,
  ianaCharset,
  ianaHeader,
  ianaDns,
  aliasableMediaSubtype,
  spdxAliasable,
} from "./names";

export const PACK_FILE = "graph.kpk";
export const PACK_MAGIC = "KPK1";
export const PACK_MAGIC2 = "KPK2";
export const PACK_MAGIC3 = "KPK3";
export const PACK_MAGIC4 = "KPK4";
export const PACK_MAGIC5 = "KPK5";
export const PFC_BLOCK = 16;
const TE = new TextEncoder();
const TD = new TextDecoder();
export const PACK_PREDS = ["is", "obsoletes", "updates", "capital", "id", "version"] as const;

const PRED_ID = new Map(PACK_PREDS.map((p, i) => [p, i]));
const PRED_RANK = [1, 2, 3, 0, 4, 5];
/** Legacy KPK2/3 two-bit tags. */
const RFC_TAG = 0x80000000;
const W3C_TAG = 0x40000000;
const LIST_TAG = 0xc0000000;
const TAG_MASK = 0xc0000000;
const KIND_SHIFT = 28;
const PAYLOAD_MASK = 0x0fffffff;
const N_KINDS = 16;
const KIND_PFC = 0;
const KIND_RFC = 1;
const KIND_W3C = 2;
const KIND_LIST = 3;
const KIND_PROTO = 4;
const KIND_HTTP = 5;
const KIND_MEDIA = 6;
const KIND_SPDX = 7;
const KIND_SCHEME = 8;
const KIND_WHATWG = 9;
const KIND_BLOCK = 10;
const KIND_LANG = 11;
const KIND_METHOD = 12;
const KIND_REL = 13;
const KIND_WK = 14;
const KIND_SCRIPT = 15;

export type PackFact = { s: string; p: string; o: string; e: string; url: string };

function predRank(p: string): number {
  const i = PRED_ID.get(p as (typeof PACK_PREDS)[number]);
  return i === undefined ? 9 : PRED_RANK[i]!;
}

export function rfcNum(s: string): number | undefined {
  const m = /^RFC\s+(\d{1,5})$/i.exec(s.trim());
  return m ? Number(m[1]) : undefined;
}

export function w3cSlug(s: string): string | undefined {
  const m = /^W3C\s+(\S+)$/i.exec(s.trim());
  return m?.[1]?.toLowerCase();
}

/** Multi-RFC objects (`RFC 7230, RFC 7231`). Single RFC stays a tagged id. */
export function rfcListNums(s: string): number[] | undefined {
  const parts = s.split(/\s*,\s*/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const nums: number[] = [];
  for (const p of parts) {
    const n = rfcNum(p);
    if (n === undefined) return undefined;
    nums.push(n);
  }
  return nums;
}

function listKey(nums: number[]): string {
  return nums.join(",");
}

function packId(kind: number, payload: number): number {
  return ((kind << KIND_SHIFT) | (payload & PAYLOAD_MASK)) >>> 0;
}

function idKind(id: number): number {
  return (id >>> KIND_SHIFT) & 15;
}

function packLang(code: string): number {
  return (code.charCodeAt(0) - 97) * 26 + (code.charCodeAt(1) - 97);
}

function unpackLang(n: number): string {
  return String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26));
}

function packScriptCode(code: string): number {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const c = code.charCodeAt(i);
    n = (n << 6) | (c >= 97 ? c - 97 + 26 : c - 65);
  }
  return n;
}

function unpackScriptCode(n: number): string {
  let s = "";
  for (let i = 3; i >= 0; i--) {
    const v = (n >>> (i * 6)) & 63;
    s += String.fromCharCode(v >= 26 ? 97 + v - 26 : 65 + v);
  }
  return s;
}

function idPayload(id: number): number {
  return (id >>> 0) & PAYLOAD_MASK;
}

function tagRfc(n: number): number {
  return packId(KIND_RFC, n);
}

function tagW3c(i: number): number {
  return packId(KIND_W3C, i);
}

function tagList(i: number): number {
  return packId(KIND_LIST, i);
}

function remapKpk3Id(id: number): number {
  const u = id >>> 0;
  const t = (u & TAG_MASK) >>> 0;
  const p = u & 0x3fffffff;
  if (t === LIST_TAG) return packId(KIND_LIST, p);
  if (t === RFC_TAG) return packId(KIND_RFC, p);
  if (t === W3C_TAG) return packId(KIND_W3C, p);
  return u;
}

function remapKpk3Arr(ids: number[]) {
  for (let i = 0; i < ids.length; i++) ids[i] = remapKpk3Id(ids[i]!);
}

function locTable(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  list.forEach((s, i) => {
    m.set(s, i);
    m.set(s.toLowerCase(), i);
  });
  return m;
}

class Writer {
  private buf = new Uint8Array(256);
  private n = 0;
  get length() {
    return this.n;
  }
  private grow(extra: number) {
    const need = this.n + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  u8(v: number) {
    this.grow(1);
    this.buf[this.n++] = v & 255;
  }
  u16(v: number) {
    this.grow(2);
    this.buf[this.n++] = v & 255;
    this.buf[this.n++] = (v >>> 8) & 255;
  }
  u32(v: number) {
    this.grow(4);
    this.buf[this.n++] = v & 255;
    this.buf[this.n++] = (v >>> 8) & 255;
    this.buf[this.n++] = (v >>> 16) & 255;
    this.buf[this.n++] = (v >>> 24) & 255;
  }
  vbyte(v: number) {
    let x = v >>> 0;
    while (x >= 128) {
      this.u8((x & 127) | 128);
      x >>>= 7;
    }
    this.u8(x);
  }
  bytes(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  utf8(s: string) {
    this.bytes(TE.encode(s));
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

class Reader {
  constructor(
    readonly view: DataView,
    public off: number,
    readonly end: number,
  ) {}
  u8(): number {
    return this.view.getUint8(this.off++);
  }
  u16(): number {
    const n = this.view.getUint16(this.off, true);
    this.off += 2;
    return n;
  }
  u32(): number {
    const n = this.view.getUint32(this.off, true);
    this.off += 4;
    return n;
  }
  vbyte(): number {
    let n = 0;
    let shift = 0;
    for (;;) {
      if (this.off >= this.end) return n >>> 0;
      const b = this.u8();
      n |= (b & 127) << shift;
      if ((b & 128) === 0) return n >>> 0;
      shift += 7;
      if (shift > 35) return n >>> 0;
    }
  }
  utf8(n: number): string {
    const slice = new Uint8Array(this.view.buffer, this.view.byteOffset + this.off, n);
    this.off += n;
    return TD.decode(slice);
  }
}

function encodePfcWithBlock(sorted: string[], block: number): Uint8Array {
  const w = new Writer();
  w.u32(sorted.length);
  w.u32(block);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    const bytes = TE.encode(s);
    if (i % block === 0) {
      w.vbyte(bytes.length);
      w.bytes(bytes);
      continue;
    }
    const prev = sorted[i - 1]!;
    let share = 0;
    const max = Math.min(prev.length, s.length);
    while (share < max && prev.charCodeAt(share) === s.charCodeAt(share)) share++;
    const suffix = TE.encode(s.slice(share));
    w.vbyte(share);
    w.vbyte(suffix.length);
    w.bytes(suffix);
  }
  return w.finish();
}

function encodePfc(sorted: string[]): Uint8Array {
  if (sorted.length < 8) return encodePfcWithBlock(sorted, 16);
  let best = encodePfcWithBlock(sorted, 16);
  for (const b of [8, 32]) {
    const x = encodePfcWithBlock(sorted, b);
    if (x.length < best.length) best = x;
  }
  return best;
}

function decodePfc(buf: Uint8Array): string[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u32();
  const block = r.u32() || 16;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % block === 0) {
      out.push(r.utf8(r.vbyte()));
      continue;
    }
    const share = r.vbyte();
    const prev = out[i - 1]!;
    out.push(prev.slice(0, share) + r.utf8(r.vbyte()));
  }
  return out;
}

function hashTok(t: string): number {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return h >>> 0;
}

const BLOOM_SMALL = 256;
const BLOOM_LARGE = 8192;

function bloomAdd(b: Uint8Array, t: string) {
  let h = hashTok(t);
  for (let i = 0; i < 3; i++) {
    b[(h >>> 3) % b.length] |= 1 << (h & 7);
    h = Math.imul(h, 0x9e3779b1) >>> 0;
  }
}

function bloomHas(b: Uint8Array, t: string): boolean {
  let h = hashTok(t);
  for (let i = 0; i < 3; i++) {
    if (!(b[(h >>> 3) % b.length]! & (1 << (h & 7)))) return false;
    h = Math.imul(h, 0x9e3779b1) >>> 0;
  }
  return true;
}

function queryShapes(s: string): string[] {
  const trimmed = s.trim();
  const out = [trimmed];
  const spaced = trimmed.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (spaced !== trimmed) out.push(spaced);
  const compact = trimmed.replace(/\s+/g, "");
  const rfc = /^rfc(\d{1,5})$/i.exec(compact);
  if (rfc) out.push(`RFC ${rfc[1]}`);
  const w3 = /^w3c(.+)$/i.exec(compact);
  if (w3) out.push(`W3C ${w3[1]!.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`);
  if (/^(get|post|put|patch|delete|head|options|connect|trace)$/i.test(trimmed)) {
    out.push(`IANA method ${trimmed.toUpperCase()}`);
  }
  return out;
}

function isTitleString(s: string): boolean {
  if (!s || /^https?:\/\//i.test(s) || /^IANA scheme /i.test(s)) return false;
  if (PRED_ID.has(s as (typeof PACK_PREDS)[number])) return false;
  return /[ \t]/.test(s) || s.length > 24;
}

function titleParts(s: string): string[] {
  return s.split(/([^a-zA-Z0-9]+)/).filter((x) => x.length > 0);
}

function zig(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function unzig(n: number): number {
  return n & 1 ? -((n + 1) >> 1) : n >> 1;
}

function encodeWordDict(titles: string[]): Uint8Array {
  const vocabSet = new Set<string>();
  const partsList: string[][] = [];
  for (const t of titles) {
    const p = titleParts(t);
    partsList.push(p);
    for (const x of p) vocabSet.add(x);
  }
  const vocab = [...vocabSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idOf = new Map(vocab.map((w, i) => [w, i + 1]));
  const vocabPfc = encodePfc(vocab);
  const frame = (body: Uint8Array) => {
    const w = new Writer();
    w.u32(vocabPfc.length);
    w.bytes(vocabPfc);
    w.u32(body.length);
    w.bytes(body);
    return w.finish();
  };
  const seq = (mode: number) => {
    const seqs = new Writer();
    seqs.u32(titles.length);
    seqs.u8(mode);
    for (const parts of partsList) {
      seqs.vbyte(parts.length);
      let prev = 0;
      for (const p of parts) {
        const id = idOf.get(p)!;
        if (mode === 1) seqs.u16(id);
        else if (mode === 2) {
          seqs.vbyte(zig(id - prev));
          prev = id;
        } else seqs.vbyte(id);
      }
    }
    return seqs.finish();
  };
  const vbyte = frame(seq(0));
  if (vocab.length >= 65536) return vbyte;
  const u16 = frame(seq(1));
  const delta = frame(seq(2));
  return u16.length <= vbyte.length && u16.length <= delta.length
    ? u16
    : delta.length <= vbyte.length
      ? delta
      : vbyte;
}

function decodeWordDict(buf: Uint8Array, withPackFlag = true): string[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const vocabLen = r.u32();
  const vocab = decodePfc(buf.subarray(r.off, r.off + vocabLen));
  r.off += vocabLen;
  const seqsLen = r.u32();
  const sr = new Reader(new DataView(buf.buffer, buf.byteOffset + r.off, seqsLen), 0, seqsLen);
  const n = sr.u32();
  const packed = withPackFlag ? sr.u8() : 0;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = sr.vbyte();
    let s = "";
    let prev = 0;
    for (let j = 0; j < k; j++) {
      let id: number;
      if (packed === 1) id = sr.u16();
      else if (packed === 2) {
        prev += unzig(sr.vbyte());
        id = prev;
      } else id = sr.vbyte();
      s += vocab[id - 1] ?? "";
    }
    out.push(s);
  }
  return out;
}

function encodeIntern(strs: string[]): Uint8Array {
  const titles = strs.filter(isTitleString);
  const atoms = strs.filter((s) => !isTitleString(s));
  if (!titles.length) return encodePfc(atoms.length ? atoms : strs);
  const w = new Writer();
  w.utf8("WD02");
  const wd = encodeWordDict(titles);
  w.u32(wd.length);
  w.bytes(wd);
  const atomPfc = encodePfc(atoms);
  w.u32(atomPfc.length);
  w.bytes(atomPfc);
  return w.finish();
}

function decodeIntern(buf: Uint8Array): string[] {
  if (buf.byteLength >= 4) {
    const mag = TD.decode(buf.subarray(0, 4));
    if (mag === "WD02" || mag === "WD01") {
      const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
      const wdLen = r.u32();
      const titles = decodeWordDict(buf.subarray(r.off, r.off + wdLen), mag === "WD02");
      r.off += wdLen;
      const atomLen = r.u32();
      const atoms = decodePfc(buf.subarray(r.off, r.off + atomLen));
      return [...titles, ...atoms];
    }
  }
  return decodePfc(buf);
}

function deltaEncode(ids: number[]): Uint8Array {
  const w = new Writer();
  w.u32(ids.length);
  let prev = 0;
  for (const id of ids) {
    w.vbyte(id - prev);
    prev = id;
  }
  return w.finish();
}

function deltaDecode(buf: Uint8Array): number[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u32();
  const out = new Array<number>(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += r.vbyte();
    out[i] = prev;
  }
  return out;
}

function vbyteList(ids: number[]): Uint8Array {
  const w = new Writer();
  w.u32(ids.length);
  for (const id of ids) w.vbyte(id);
  return w.finish();
}

function vbyteListDecode(buf: Uint8Array): number[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u32();
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = r.vbyte();
  return out;
}

/** Frame-of-reference: store base, bitpack remaining deltas. Wide jumps → δ-VByte. */
function encodeFor(ids: number[]): Uint8Array {
  const w = new Writer();
  if (ids.length < 2) {
    w.u8(0);
    w.bytes(deltaEncode(ids));
    return w.finish();
  }
  const deltas = new Array<number>(ids.length - 1);
  let max = 0;
  for (let i = 1; i < ids.length; i++) {
    const d = ids[i]! - ids[i - 1]!;
    if (d < 0) {
      w.u8(0);
      w.bytes(deltaEncode(ids));
      return w.finish();
    }
    deltas[i - 1] = d;
    if (d > max) max = d;
  }
  const width = max <= 0 ? 1 : 32 - Math.clz32(max);
  if (width > 16) {
    w.u8(0);
    w.bytes(deltaEncode(ids));
    return w.finish();
  }
  w.u8(1);
  w.u32(ids.length);
  w.u32(ids[0]!);
  w.u32(width);
  const bits = deltas.length * width;
  const bytes = new Uint8Array((bits + 7) >> 3);
  let acc = 0;
  let accBits = 0;
  let o = 0;
  const mask = (1 << width) - 1;
  for (const v of deltas) {
    acc |= (v & mask) << accBits;
    accBits += width;
    while (accBits >= 8) {
      bytes[o++] = acc & 255;
      acc >>>= 8;
      accBits -= 8;
    }
  }
  if (accBits) bytes[o++] = acc & 255;
  w.bytes(bytes);
  return w.finish();
}

function decodeFor(buf: Uint8Array): number[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const kind = r.u8();
  if (kind === 0) return deltaDecode(buf.subarray(1));
  const n = r.u32();
  const base = r.u32();
  const width = r.u32();
  const mask = (1 << width) - 1;
  const out = new Array<number>(n);
  out[0] = base;
  const body = new Uint8Array(buf.buffer, buf.byteOffset + r.off, buf.byteLength - r.off);
  let bit = 0;
  for (let i = 1; i < n; i++) {
    let v = 0;
    for (let b = 0; b < width; b++) {
      const byte = body[(bit + b) >> 3] ?? 0;
      if (byte & (1 << ((bit + b) & 7))) v |= 1 << b;
    }
    bit += width;
    out[i] = out[i - 1]! + (v & mask);
  }
  return out;
}

function encodeBitset(ids: number[], nTriples: number): Uint8Array {
  const bytes = new Uint8Array((nTriples + 7) >> 3);
  for (const id of ids) bytes[id >> 3] |= 1 << (id & 7);
  const w = new Writer();
  w.u32(nTriples);
  w.bytes(bytes);
  return w.finish();
}

function decodeBitset(buf: Uint8Array): number[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u32();
  const body = new Uint8Array(buf.buffer, buf.byteOffset + r.off, (n + 7) >> 3);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (body[i >> 3]! & (1 << (i & 7))) out.push(i);
  }
  return out;
}

function encodePosting(ids: number[], nTriples: number): Uint8Array {
  const w = new Writer();
  const dense = ids.length * 32 > nTriples && nTriples >= 64;
  if (dense) {
    w.u8(1);
    w.bytes(encodeBitset(ids, nTriples));
  } else {
    w.u8(0);
    w.bytes(deltaEncode(ids));
  }
  return w.finish();
}

function decodePosting(buf: Uint8Array): number[] {
  const kind = buf[0]!;
  const rest = buf.subarray(1);
  return kind === 1 ? decodeBitset(rest) : deltaDecode(rest);
}

function gallopIntersect(small: number[], large: number[]): number[] {
  const out: number[] = [];
  let j = 0;
  for (const x of small) {
    let lo = j;
    let hi = large.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (large[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo < large.length && large[lo] === x) out.push(x);
    j = lo;
  }
  return out;
}

function intersect(a: number[], b: number[]): number[] {
  if (a.length > b.length) {
    const t = a;
    a = b;
    b = t;
  }
  if (!a.length) return [];
  if (b.length > a.length * 32) return gallopIntersect(a, b);
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]!);
      i++;
      j++;
    } else if (a[i]! < b[j]!) i++;
    else j++;
  }
  return out;
}

export class KnowPack {
  private bySid: Map<number, number[]>;
  private mediaLoc: Map<string, number>;
  private spdxLoc: Map<string, number>;
  private schemeLoc: Map<string, number>;
  private whatwgLoc: Map<string, number>;
  private blockLoc: Map<string, number>;
  private methodLoc: Map<string, number>;
  private relLoc: Map<string, number>;
  private wkLoc: Map<string, number>;
  private posted = false;

  constructor(
    readonly strs: string[],
    readonly slugs: string[],
    readonly rfcLists: string[],
    readonly loc: Map<string, number>,
    readonly slugLoc: Map<string, number>,
    readonly sid: number[],
    readonly pid: number[],
    readonly oid: number[],
    readonly evid: number[],
    readonly urlid: number[],
    readonly evidText: string[],
    readonly post: Map<string, number[]>,
    readonly media: string[] = [],
    readonly spdx: string[] = [],
    readonly alias: Map<string, number> = new Map(),
    readonly bloom: Uint8Array | null = null,
    readonly scheme: string[] = [],
    readonly whatwg: string[] = [],
    readonly blocks: string[] = [],
    readonly methods: string[] = [],
    readonly rels: string[] = [],
    readonly wks: string[] = [],
  ) {
    this.mediaLoc = locTable(media);
    this.spdxLoc = locTable(spdx);
    this.schemeLoc = locTable(scheme);
    this.whatwgLoc = locTable(whatwg);
    this.blockLoc = locTable(blocks);
    this.methodLoc = locTable(methods);
    this.relLoc = locTable(rels);
    this.wkLoc = locTable(wks);
    this.bySid = new Map();
    for (let i = 0; i < sid.length; i++) {
      const s = sid[i]!;
      const list = this.bySid.get(s);
      if (list) list.push(i);
      else this.bySid.set(s, [i]);
    }
    this.posted = post.size > 0;
    for (let i = 0; i < slugs.length; i++) {
      const spaced = slugs[i]!.replace(/-/g, " ").toLowerCase();
      if (spaced.length < 2 || spaced === slugs[i]!.toLowerCase()) continue;
      if (this.alias.has(spaced)) continue;
      const id = packId(KIND_W3C, i);
      if (this.bySid.has(id)) this.alias.set(spaced, id);
    }
  }

  private qcache = new Map<string, PackFact[]>();

  private remember(q: string, hits: PackFact[]) {
    this.qcache.set(q, hits);
    if (this.qcache.size > 64) this.qcache.delete(this.qcache.keys().next().value!);
  }

  private ensurePost() {
    if (this.posted) return;
    this.posted = true;
    if (this.sid.length) this.synthPost();
  }

  /** Rebuild the inverted index from stored strings. Disk does not keep it. */
  private synthPost() {
    const nTrip = this.sid.length;
    for (let i = 0; i < nTrip; i++) {
      const s = this.extractId(this.sid[i]!);
      const p = PACK_PREDS[this.pid[i]!] ?? "";
      const o = this.extractId(this.oid[i]!);
      const extra = rfcNum(s) !== undefined && p === "is" ? postTokens(o) : [];
      const own = rfcNum(s);
      for (const w of new Set([...indexTokens({ s, p, o, e: "" }), ...extra])) {
        if (own !== undefined && w === String(own)) continue;
        const list = this.post.get(w);
        if (list) list.push(i);
        else this.post.set(w, [i]);
      }
    }
    if (nTrip < 256) return;
    for (const [t, ids] of this.post) {
      if (ids.length > nTrip * 0.2) this.post.delete(t);
    }
  }

  get nTriples() {
    return this.sid.length;
  }

  extractId(id: number): string {
    const kind = idKind(id);
    const p = idPayload(id);
    if (kind === KIND_LIST) return this.rfcLists[p] ?? "";
    if (kind === KIND_RFC) return `RFC ${p}`;
    if (kind === KIND_W3C) return `W3C ${this.slugs[p] ?? ""}`;
    if (kind === KIND_PROTO) return `IANA protocol ${p}`;
    if (kind === KIND_HTTP) return `IANA http ${p}`;
    if (kind === KIND_MEDIA) return `IANA media ${this.media[p] ?? ""}`;
    if (kind === KIND_SPDX) return `SPDX ${this.spdx[p] ?? ""}`;
    if (kind === KIND_SCHEME) return `IANA scheme ${this.scheme[p] ?? ""}`;
    if (kind === KIND_WHATWG) return `WHATWG ${this.whatwg[p] ?? ""}`;
    if (kind === KIND_BLOCK) return `Unicode Block ${this.blocks[p] ?? ""}`;
    if (kind === KIND_LANG) return `IANA language ${unpackLang(p)}`;
    if (kind === KIND_METHOD) return `IANA method ${this.methods[p] ?? ""}`;
    if (kind === KIND_REL) return `IANA rel ${this.rels[p] ?? ""}`;
    if (kind === KIND_WK) return `IANA well-known ${this.wks[p] ?? ""}`;
    if (kind === KIND_SCRIPT) return `Unicode Script ${unpackScriptCode(p)}`;
    return this.strs[p - 1] ?? "";
  }

  locate(s: string): number {
    const trimmed = s.trim();
    const hit = (id: number) => (this.bySid.has(id) ? id : 0);
    const compact = trimmed.replace(/\s+/g, "");
    const rfcBare = /^rfc(\d{1,5})$/i.exec(compact);
    if (rfcBare) {
      const tagged = hit(tagRfc(Number(rfcBare[1])));
      if (tagged) return tagged;
    }
    const n = rfcNum(trimmed);
    if (n !== undefined) {
      const tagged = hit(tagRfc(n));
      if (tagged) return tagged;
    }
    const slug = w3cSlug(trimmed);
    if (slug) {
      const i = this.slugLoc.get(slug);
      if (i !== undefined) {
        const tagged = hit(tagW3c(i));
        if (tagged) return tagged;
      }
    }
    const proto = ianaProtocol(trimmed);
    if (proto !== undefined) {
      const tagged = hit(packId(KIND_PROTO, proto));
      if (tagged) return tagged;
    }
    const http = ianaHttp(trimmed);
    if (http !== undefined) {
      const tagged = hit(packId(KIND_HTTP, http));
      if (tagged) return tagged;
    }
    const media = ianaMedia(trimmed) || bareMediaType(trimmed);
    if (media) {
      const i = this.mediaLoc.get(media);
      if (i !== undefined) {
        const tagged = hit(packId(KIND_MEDIA, i));
        if (tagged) return tagged;
      }
    }
    const spdx = spdxId(trimmed);
    if (spdx) {
      const i = this.spdxLoc.get(spdx) ?? this.spdxLoc.get(spdx.toLowerCase());
      if (i !== undefined) {
        const tagged = hit(packId(KIND_SPDX, i));
        if (tagged) return tagged;
      }
    }
    if (/^\d{3}$/.test(trimmed)) {
      const httpHit = hit(packId(KIND_HTTP, Number(trimmed)));
      if (httpHit) return httpHit;
      const rfcHit = hit(tagRfc(Number(trimmed)));
      if (rfcHit) return rfcHit;
    }
    if (/^\d{1,5}$/.test(trimmed)) {
      const rfcHit = hit(tagRfc(Number(trimmed)));
      if (rfcHit) return rfcHit;
    }
    const aliased = this.alias.get(trimmed.toLowerCase());
    if (aliased && this.bySid.has(aliased)) return aliased;
    const intern = this.loc.get(trimmed) || this.loc.get(trimmed.toLowerCase()) || 0;
    if (intern && this.bySid.has(intern)) return intern;
    const method = ianaMethod(trimmed) || (/^[A-Z][A-Z0-9-]{0,24}$/.test(trimmed) ? trimmed : undefined);
    if (method) {
      const i = this.methodLoc.get(method) ?? this.methodLoc.get(method.toUpperCase());
      if (i !== undefined) {
        const tagged = hit(packId(KIND_METHOD, i));
        if (tagged) return tagged;
      }
    }
    const scheme = ianaScheme(trimmed);
    if (scheme) {
      const i = this.schemeLoc.get(scheme);
      if (i !== undefined) {
        const tagged = hit(packId(KIND_SCHEME, i));
        if (tagged) return tagged;
      }
    }
    const wg = whatwgSlug(trimmed);
    if (wg) {
      const i = this.whatwgLoc.get(wg);
      if (i !== undefined) {
        const tagged = hit(packId(KIND_WHATWG, i));
        if (tagged) return tagged;
      }
    }
    const lang = ianaLanguage(trimmed);
    if (lang) {
      const tagged = hit(packId(KIND_LANG, packLang(lang)));
      if (tagged) return tagged;
    }
    const script = unicodeScript(trimmed);
    if (script) {
      const tagged = hit(packId(KIND_SCRIPT, packScriptCode(script)));
      if (tagged) return tagged;
    }
    const reln = ianaRel(trimmed);
    if (reln) {
      const i = this.relLoc.get(reln);
      if (i !== undefined) {
        const tagged = hit(packId(KIND_REL, i));
        if (tagged) return tagged;
      }
    }
    const wk = ianaWellKnown(trimmed);
    if (wk) {
      const i = this.wkLoc.get(wk);
      if (i !== undefined) {
        const tagged = hit(packId(KIND_WK, i));
        if (tagged) return tagged;
      }
    }
    const block = unicodeBlock(trimmed) || (/^unicode block /i.test(trimmed) ? undefined : trimmed);
    if (block && block.length >= 3) {
      const i = this.blockLoc.get(block) ?? this.blockLoc.get(block.toLowerCase());
      if (i !== undefined) {
        const tagged = hit(packId(KIND_BLOCK, i));
        if (tagged) return tagged;
      }
    }
    return 0;
  }

  factAt(i: number): PackFact {
    return {
      s: this.extractId(this.sid[i]!),
      p: PACK_PREDS[this.pid[i]!] ?? "",
      o: this.extractId(this.oid[i]!),
      e: this.evidText[this.evid[i]!] ?? "",
      url: this.extractId(this.urlid[i]!),
    };
  }

  search(q: string, k = 5): PackFact[] {
    const trimmed = q.trim();
    if (!trimmed) return [];
    const hit = this.qcache.get(trimmed);
    if (hit) return hit.slice(0, k);
    const qn = trimmed.toLowerCase();
    const shapes = queryShapes(trimmed);
    const qtoks = postTokens(shapes[1] ?? trimmed);
    const cover = (h: PackFact) => {
      if (!qtoks.length) return 0;
      const hay = new Set(postTokens(`${h.s} ${h.o}`));
      let n = 0;
      for (const t of qtoks) if (hay.has(t)) n++;
      return n;
    };
    const rankHit = (a: PackFact, b: PackFact) =>
      predRank(a.p) - predRank(b.p) ||
      (a.o.toLowerCase() === qn ? 0 : 1) - (b.o.toLowerCase() === qn ? 0 : 1) ||
      cover(b) - cover(a) ||
      (a.o.toLowerCase() === qn && b.o.toLowerCase() === qn ? b.s.length - a.s.length : a.s.length - b.s.length);
    for (const shape of shapes) {
      const sid = this.locate(shape);
      if (!sid) continue;
      const idxs = this.bySid.get(sid) || [];
      const found = idxs.map((i) => this.factAt(i));
      found.sort(rankHit);
      const out = found.filter((h) => h.p !== "about" && h.p !== "date" && h.o.length <= 72).slice(0, k);
      this.remember(trimmed, out);
      return out;
    }
    let toks = qtoks.filter((t) => t !== "rfc" && t !== "w3c");
    if (!toks.length) toks = qtoks;
    if (this.bloom && toks.length && toks.some((t) => !bloomHas(this.bloom!, t))) {
      this.remember(trimmed, []);
      return [];
    }
    this.ensurePost();
    const lists = toks.map((t) => this.post.get(t));
    if (lists.some((x) => !x)) {
      this.remember(trimmed, []);
      return [];
    }
    let ids = lists[0]!;
    for (let i = 1; i < lists.length; i++) {
      ids = intersect(ids, lists[i]!);
      if (!ids.length) break;
    }
    const hits = ids
      .map((i) => this.factAt(i))
      .filter((h) => h.p !== "about" && h.p !== "date" && h.o.length <= 72);
    hits.sort(rankHit);
    const out = hits.slice(0, k);
    this.remember(trimmed, out);
    return out;
  }
}

function internPfc(s: string, idOf: Map<string, number>): number {
  return idOf.get(s) || 0;
}

function encodeTyped(
  s: string,
  idOf: Map<string, number>,
  slugOf: Map<string, number>,
  listOf: Map<string, number>,
  mediaOf: Map<string, number>,
  spdxOf: Map<string, number>,
  schemeOf: Map<string, number>,
  whatwgOf: Map<string, number>,
  blockOf: Map<string, number>,
  methodOf: Map<string, number>,
  relOf: Map<string, number>,
  wkOf: Map<string, number>,
): number {
  const n = rfcNum(s);
  if (n !== undefined) return tagRfc(n);
  const list = rfcListNums(s);
  if (list) {
    const i = listOf.get(listKey(list));
    if (i !== undefined) return tagList(i);
  }
  const slug = w3cSlug(s);
  if (slug !== undefined) {
    const i = slugOf.get(slug);
    if (i !== undefined) return tagW3c(i);
  }
  const proto = ianaProtocol(s);
  if (proto !== undefined) return packId(KIND_PROTO, proto);
  const http = ianaHttp(s);
  if (http !== undefined) return packId(KIND_HTTP, http);
  const media = ianaMedia(s);
  if (media) {
    const i = mediaOf.get(media);
    if (i !== undefined) return packId(KIND_MEDIA, i);
  }
  const spdx = spdxId(s);
  if (spdx) {
    const i = spdxOf.get(spdx) ?? spdxOf.get(spdx.toLowerCase());
    if (i !== undefined) return packId(KIND_SPDX, i);
  }
  const scheme = ianaScheme(s);
  if (scheme) {
    const i = schemeOf.get(scheme);
    if (i !== undefined) return packId(KIND_SCHEME, i);
  }
  const wg = whatwgSlug(s);
  if (wg) {
    const i = whatwgOf.get(wg);
    if (i !== undefined) return packId(KIND_WHATWG, i);
  }
  const block = unicodeBlock(s);
  if (block) {
    const i = blockOf.get(block);
    if (i !== undefined) return packId(KIND_BLOCK, i);
  }
  const lang = ianaLanguage(s);
  if (lang) return packId(KIND_LANG, packLang(lang));
  const method = ianaMethod(s);
  if (method) {
    const i = methodOf.get(method);
    if (i !== undefined) return packId(KIND_METHOD, i);
  }
  const reln = ianaRel(s);
  if (reln) {
    const i = relOf.get(reln);
    if (i !== undefined) return packId(KIND_REL, i);
  }
  const wk = ianaWellKnown(s);
  if (wk) {
    const i = wkOf.get(wk);
    if (i !== undefined) return packId(KIND_WK, i);
  }
  const script = unicodeScript(s);
  if (script) return packId(KIND_SCRIPT, packScriptCode(script));
  return internPfc(s, idOf);
}

function takeId(
  s: string,
  slugs: Set<string>,
  lists: Map<string, number[]>,
  media: Set<string>,
  spdx: Set<string>,
  scheme: Set<string>,
  whatwg: Set<string>,
  block: Set<string>,
  method: Set<string>,
  rel: Set<string>,
  wk: Set<string>,
  pfc: Set<string>,
) {
  const n = rfcNum(s);
  if (n !== undefined) return;
  const list = rfcListNums(s);
  if (list) {
    lists.set(listKey(list), list);
    return;
  }
  const slug = w3cSlug(s);
  if (slug) {
    slugs.add(slug);
    return;
  }
  if (ianaProtocol(s) !== undefined || ianaHttp(s) !== undefined) return;
  const med = ianaMedia(s);
  if (med) {
    media.add(med);
    return;
  }
  const sid = spdxId(s);
  if (sid) {
    spdx.add(sid);
    return;
  }
  const sch = ianaScheme(s);
  if (sch) {
    scheme.add(sch);
    return;
  }
  const wg = whatwgSlug(s);
  if (wg) {
    whatwg.add(wg);
    return;
  }
  const blk = unicodeBlock(s);
  if (blk) {
    block.add(blk);
    return;
  }
  if (ianaLanguage(s)) return;
  const meth = ianaMethod(s);
  if (meth) {
    method.add(meth);
    return;
  }
  const reln = ianaRel(s);
  if (reln) {
    rel.add(reln);
    return;
  }
  const well = ianaWellKnown(s);
  if (well) {
    wk.add(well);
    return;
  }
  if (unicodeScript(s)) return;
  pfc.add(s);
}

function buildTypedFacts(facts: PackFact[]) {
  const kept = facts.filter((f) => PRED_ID.has(f.p as (typeof PACK_PREDS)[number]));
  const slugs = new Set<string>();
  const lists = new Map<string, number[]>();
  const media = new Set<string>();
  const spdx = new Set<string>();
  const scheme = new Set<string>();
  const whatwg = new Set<string>();
  const block = new Set<string>();
  const method = new Set<string>();
  const rel = new Set<string>();
  const wk = new Set<string>();
  const pfc = new Set<string>();
  const take = (s: string) =>
    takeId(s, slugs, lists, media, spdx, scheme, whatwg, block, method, rel, wk, pfc);
  for (const f of kept) {
    take(f.s);
    take(f.o);
    pfc.add(f.url);
  }
  const slugList = [...slugs].sort();
  const slugOf = new Map(slugList.map((s, i) => [s, i]));
  const listKeys = [...lists.keys()].sort();
  const listOf = new Map(listKeys.map((k, i) => [k, i]));
  const listVals = listKeys.map((k) => lists.get(k)!);
  const mediaList = [...media].sort();
  const mediaOf = new Map(mediaList.map((s, i) => [s, i]));
  const spdxList = [...spdx].sort();
  const spdxOf = new Map(spdxList.map((s, i) => [s, i]));
  const schemeList = [...scheme].sort();
  const schemeOf = new Map(schemeList.map((s, i) => [s, i]));
  const whatwgList = [...whatwg].sort();
  const whatwgOf = new Map(whatwgList.map((s, i) => [s, i]));
  const blockList = [...block].sort();
  const blockOf = new Map(blockList.map((s, i) => [s, i]));
  const methodList = [...method].sort();
  const methodOf = new Map(methodList.map((s, i) => [s, i]));
  const relList = [...rel].sort();
  const relOf = new Map(relList.map((s, i) => [s, i]));
  const wkList = [...wk].sort();
  const wkOf = new Map(wkList.map((s, i) => [s, i]));
  const titles: string[] = [];
  const atoms: string[] = [];
  for (const s of pfc) {
    if (isTitleString(s)) titles.push(s);
    else atoms.push(s);
  }
  titles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  atoms.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const strs = [...titles, ...atoms];
  const idOf = new Map(strs.map((s, i) => [s, i + 1]));
  return {
    kept,
    slugList,
    slugOf,
    listOf,
    listVals,
    mediaList,
    mediaOf,
    spdxList,
    spdxOf,
    schemeList,
    schemeOf,
    whatwgList,
    whatwgOf,
    blockList,
    blockOf,
    methodList,
    methodOf,
    relList,
    relOf,
    wkList,
    wkOf,
    strs,
    idOf,
  };
}

function offerAlias(claimed: Map<string, number>, key: string, sid: number) {
  const k = key.toLowerCase().trim();
  if (k.length < 2 || k.length > 80) return;
  const prev = claimed.get(k);
  if (prev === undefined) claimed.set(k, sid);
  else if (prev !== sid) claimed.set(k, -1);
}

function encodeAliases(alias: Map<string, number>): Uint8Array {
  const keys = [...alias.keys()].sort();
  const w = new Writer();
  w.utf8("AL02");
  const pfc = encodePfc(keys);
  w.u32(pfc.length);
  w.bytes(pfc);
  for (const k of keys) {
    const id = alias.get(k)!;
    w.u8(idKind(id));
    w.vbyte(idPayload(id));
  }
  return w.finish();
}

function decodeAliases(buf: Uint8Array): Map<string, number> {
  const mag = buf.byteLength >= 4 ? TD.decode(buf.subarray(0, 4)) : "";
  if (mag === "AL02" || mag === "AL01") {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const pfcLen = r.u32();
    const keys = decodePfc(buf.subarray(r.off, r.off + pfcLen));
    r.off += pfcLen;
    const out = new Map<string, number>();
    if (mag === "AL02") {
      for (const k of keys) out.set(k, packId(r.u8(), r.vbyte()));
    } else {
      for (const k of keys) out.set(k, r.u32());
    }
    return out;
  }
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u32();
  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = r.utf8(r.vbyte());
    out.set(k, r.u32());
  }
  return out;
}

function encodeRfcLists(lists: number[][]): Uint8Array {
  const w = new Writer();
  w.u32(lists.length);
  for (const L of lists) {
    w.u8(Math.min(L.length, 8));
    for (let i = 0; i < Math.min(L.length, 8); i++) w.vbyte(L[i]!);
  }
  return w.finish();
}

function decodeRfcLists(buf: Uint8Array): string[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u32();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = r.u8();
    const nums: number[] = [];
    for (let j = 0; j < k; j++) nums.push(r.vbyte());
    out.push(nums.map((x) => `RFC ${x}`).join(", "));
  }
  return out;
}

function writeSidGroups(trip: Writer, idxs: number[], sid: number[], kinds = N_KINDS): number[] {
  const origAll: number[] = [];
  for (let kind = 0; kind < kinds; kind++) {
    const subset = idxs.filter((i) => idKind(sid[i]!) === kind);
    subset.sort((a, b) => idPayload(sid[a]!) - idPayload(sid[b]!));
    trip.u32(subset.length);
    if (!subset.length) continue;
    const locals = subset.map((i) => idPayload(sid[i]!));
    const enc = encodeFor(locals);
    trip.u32(enc.length);
    trip.bytes(enc);
    const orig = vbyteList(subset);
    trip.u32(orig.length);
    trip.bytes(orig);
    origAll.push(...subset);
  }
  return origAll;
}

function readSidGroups(
  tr: Reader,
  buf: Uint8Array,
  tripOff: number,
  sid: number[],
  pid: number[],
  p: number,
  kinds = 4,
  remap = false,
): number[] {
  const origAll: number[] = [];
  for (let kind = 0; kind < kinds; kind++) {
    const n = tr.u32();
    if (!n) continue;
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const slice = new Uint8Array(buf.buffer, buf.byteOffset + tripOff + tr.off, len);
      tr.off += len;
      return dec(slice);
    };
    const locals = take(decodeFor);
    const orig = take(vbyteListDecode);
    for (let i = 0; i < n; i++) {
      const idx = orig[i]!;
      const local = locals[i]!;
      sid[idx] = remap
        ? remapKpk3Id(((local >>> 0) & 0x3fffffff | (kind === 1 ? RFC_TAG : kind === 2 ? W3C_TAG : kind === 3 ? LIST_TAG : 0)) >>> 0)
        : packId(kind, local);
      pid[idx] = p;
      origAll.push(idx);
    }
  }
  return origAll;
}

/** KPK1 encoder — kept to bench against KPK2 on the same fact list. */
export function encodePackV1(facts: PackFact[]): Uint8Array {
  const dict = new Set<string>();
  for (const f of facts) {
    dict.add(f.s);
    dict.add(f.p);
    dict.add(f.o);
    dict.add(f.url);
  }
  const strs = [...dict].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idOf = new Map(strs.map((s, i) => [s, i + 1]));
  const evidUniq: string[] = [""];
  const evidOf = new Map<string, number>([["", 0]]);
  for (const f of facts) {
    if (!f.e || evidOf.has(f.e)) continue;
    evidOf.set(f.e, evidUniq.length);
    evidUniq.push(f.e);
  }
  const sid: number[] = [];
  const pid: number[] = [];
  const oid: number[] = [];
  const evid: number[] = [];
  const urlid: number[] = [];
  const post = new Map<string, number[]>();
  const kept = facts.filter((f) => PRED_ID.has(f.p as (typeof PACK_PREDS)[number]));
  kept.forEach((f, i) => {
    const p = PRED_ID.get(f.p as (typeof PACK_PREDS)[number])!;
    sid.push(idOf.get(f.s)!);
    pid.push(p);
    oid.push(idOf.get(f.o)!);
    evid.push(evidOf.get(f.e) ?? 0);
    urlid.push(idOf.get(f.url)!);
    for (const w of new Set(indexTokens({ s: f.s, p: f.p, o: f.o, e: f.e }))) {
      const list = post.get(w);
      if (list) list.push(i);
      else post.set(w, [i]);
    }
  });
  const byPred = new Map<number, number[]>();
  for (let i = 0; i < sid.length; i++) {
    const p = pid[i]!;
    const list = byPred.get(p);
    if (list) list.push(i);
    else byPred.set(p, [i]);
  }
  const trip = new Writer();
  trip.u32(sid.length);
  trip.u32(PACK_PREDS.length);
  for (let p = 0; p < PACK_PREDS.length; p++) {
    const idxs = (byPred.get(p) || []).sort((a, b) => sid[a]! - sid[b]!);
    trip.u32(idxs.length);
    const ds = deltaEncode(idxs.map((i) => sid[i]!));
    const oo = vbyteList(idxs.map((i) => oid[i]!));
    const ee = vbyteList(idxs.map((i) => evid[i]!));
    const uu = vbyteList(idxs.map((i) => urlid[i]!));
    const oi = vbyteList(idxs);
    trip.u32(ds.length);
    trip.bytes(ds);
    trip.u32(oo.length);
    trip.bytes(oo);
    trip.u32(ee.length);
    trip.bytes(ee);
    trip.u32(uu.length);
    trip.bytes(uu);
    trip.u32(oi.length);
    trip.bytes(oi);
  }
  const terms = [...post.keys()].sort();
  const posts = new Writer();
  posts.u32(terms.length);
  for (const t of terms) {
    const ids = (post.get(t) || []).slice().sort((a, b) => a - b);
    const b = new TextEncoder().encode(t);
    posts.vbyte(b.length);
    posts.bytes(b);
    const d = deltaEncode(ids);
    posts.u32(d.length);
    posts.bytes(d);
  }
  const evidSec = new Writer();
  evidSec.u32(evidUniq.length);
  for (const e of evidUniq) {
    const b = TE.encode(e);
    evidSec.vbyte(b.length);
    evidSec.bytes(b);
  }
  const dictSec = encodePfc(strs);
  const tripSec = trip.finish();
  const postSec = posts.finish();
  const evidB = evidSec.finish();
  const hdr = 64;
  const out = new Writer();
  out.utf8(PACK_MAGIC);
  out.u32(1);
  out.u32(strs.length);
  out.u32(sid.length);
  out.u32(terms.length);
  out.u32(hdr);
  out.u32(dictSec.length);
  out.u32(hdr + dictSec.length);
  out.u32(tripSec.length);
  out.u32(hdr + dictSec.length + tripSec.length);
  out.u32(postSec.length);
  out.u32(hdr + dictSec.length + tripSec.length + postSec.length);
  out.u32(evidB.length);
  while (out.length < hdr) out.u8(0);
  out.bytes(dictSec);
  out.bytes(tripSec);
  out.bytes(postSec);
  out.bytes(evidB);
  return out.finish();
}

export function encodePack(facts: PackFact[]): Uint8Array {
  const t = buildTypedFacts(facts);
  const {
    kept, slugList, slugOf, listOf, listVals, mediaList, mediaOf, spdxList, spdxOf,
    schemeList, schemeOf, whatwgList, whatwgOf, blockList, blockOf,
    methodList, methodOf, relList, relOf, wkList, wkOf, strs, idOf,
  } = t;
  const typed = (s: string) =>
    encodeTyped(s, idOf, slugOf, listOf, mediaOf, spdxOf, schemeOf, whatwgOf, blockOf, methodOf, relOf, wkOf);
  const evidUniq: string[] = [""];
  const evidOf = new Map<string, number>([["", 0]]);
  for (const f of kept) {
    if (!f.e || evidOf.has(f.e)) continue;
    evidOf.set(f.e, evidUniq.length);
    evidUniq.push(f.e);
  }
  const sid: number[] = [];
  const pid: number[] = [];
  const oid: number[] = [];
  const evid: number[] = [];
  const urlid: number[] = [];
  const claimed = new Map<string, number>();
  kept.forEach((f) => {
    const p = PRED_ID.get(f.p as (typeof PACK_PREDS)[number])!;
    const s = typed(f.s);
    sid.push(s);
    pid.push(p);
    oid.push(typed(f.o));
    evid.push(evidOf.get(f.e) ?? 0);
    urlid.push(idOf.get(f.url)!);
    const proto = ianaProtocol(f.s);
    if (proto !== undefined) offerAlias(claimed, f.o, s);
    const http = ianaHttp(f.s);
    if (http !== undefined) offerAlias(claimed, String(http), s);
    const spdx = spdxId(f.s);
    if (spdx && spdxAliasable(spdx)) offerAlias(claimed, spdx, s);
    const media = ianaMedia(f.s);
    if (media) {
      const sub = media.split("/")[1];
      if (sub && aliasableMediaSubtype(sub)) offerAlias(claimed, sub, s);
    }
    const scheme = ianaScheme(f.s);
    if (scheme) offerAlias(claimed, scheme, s);
    const wg = whatwgSlug(f.s);
    if (wg) offerAlias(claimed, wg, s);
    const block = unicodeBlock(f.s);
    if (block) offerAlias(claimed, block, s);
    const lang = ianaLanguage(f.s);
    if (lang) {
      offerAlias(claimed, lang, s);
      offerAlias(claimed, f.o, s);
    }
    const method = ianaMethod(f.s);
    if (method) offerAlias(claimed, method, s);
    const reln = ianaRel(f.s);
    if (reln) offerAlias(claimed, reln, s);
    const wk = ianaWellKnown(f.s);
    if (wk) offerAlias(claimed, wk, s);
    const script = unicodeScript(f.s);
    if (script) {
      offerAlias(claimed, script, s);
      offerAlias(claimed, f.o, s);
    }
    const charset = ianaCharset(f.s);
    if (charset) offerAlias(claimed, charset, s);
    const header = ianaHeader(f.s);
    if (header) offerAlias(claimed, header, s);
    const dns = ianaDns(f.s);
    if (dns) offerAlias(claimed, dns, s);
  });
  const alias = new Map<string, number>();
  for (const [k, v] of claimed) if (v >= 0) alias.set(k, v);
  const byPred = new Map<number, number[]>();
  for (let i = 0; i < sid.length; i++) {
    const p = pid[i]!;
    const list = byPred.get(p);
    if (list) list.push(i);
    else byPred.set(p, [i]);
  }
  const trip = new Writer();
  trip.u32(sid.length);
  trip.u32(PACK_PREDS.length);
  for (let p = 0; p < PACK_PREDS.length; p++) {
    const idxs = (byPred.get(p) || []).slice();
    trip.u32(idxs.length);
    const origAll = writeSidGroups(trip, idxs, sid, N_KINDS);
    const oo = vbyteList(origAll.map((i) => oid[i]!));
    trip.u32(oo.length);
    trip.bytes(oo);
    const eids = origAll.map((i) => evid[i]!);
    if (eids.every((e) => e === 0)) {
      trip.u8(0);
    } else {
      trip.u8(1);
      const ee = vbyteList(eids);
      trip.u32(ee.length);
      trip.bytes(ee);
    }
    const uids = origAll.map((i) => urlid[i]!);
    const uniq = new Set(uids);
    if (uniq.size <= 1) {
      trip.u8(0);
      trip.vbyte(uids[0] ?? 0);
    } else {
      trip.u8(1);
      const uu = vbyteList(uids);
      trip.u32(uu.length);
      trip.bytes(uu);
    }
  }
  const posts = new Writer();
  const strPfc = encodePfc([]);
  posts.u32(strPfc.length);
  posts.bytes(strPfc);
  posts.u32(0);
  const bloom = new Uint8Array(kept.length >= 256 ? BLOOM_LARGE : BLOOM_SMALL);
  for (const f of kept) {
    const extra = rfcNum(f.s) !== undefined && f.p === "is" ? postTokens(f.o) : [];
    const own = rfcNum(f.s);
    for (const w of new Set([...indexTokens({ s: f.s, p: f.p, o: f.o, e: f.e }), ...extra])) {
      if (own !== undefined && w === String(own)) continue;
      bloomAdd(bloom, w);
    }
  }
  posts.u16(bloom.length);
  posts.bytes(bloom);
  const evidSec = new Writer();
  evidSec.u32(evidUniq.length);
  for (const e of evidUniq) {
    const b = TE.encode(e);
    evidSec.vbyte(b.length);
    evidSec.bytes(b);
  }
  const dictSec = encodeIntern(strs);
  const slugSec = encodePfc(slugList);
  const listSec = encodeRfcLists(listVals);
  const mediaSec = encodePfc(mediaList);
  const spdxSec = encodePfc(spdxList);
  const aliasSec = encodeAliases(alias);
  const schemeSec = encodePfc(schemeList);
  const whatwgSec = encodePfc(whatwgList);
  const blockSec = encodePfc(blockList);
  const methodSec = encodePfc(methodList);
  const relSec = encodePfc(relList);
  const wkSec = encodePfc(wkList);
  const tripSec = trip.finish();
  const postSec = posts.finish();
  const evidB = evidSec.finish();
  const hdr = 192;
  const out = new Writer();
  out.utf8(PACK_MAGIC5);
  out.u32(5);
  out.u32(strs.length);
  out.u32(sid.length);
  out.u32(0);
  out.u32(slugList.length);
  out.u32(listVals.length);
  out.u32(mediaList.length);
  out.u32(spdxList.length);
  out.u32(alias.size);
  out.u32(schemeList.length);
  out.u32(whatwgList.length);
  out.u32(blockList.length);
  out.u32(methodList.length);
  out.u32(relList.length);
  out.u32(wkList.length);
  let off = hdr;
  const put = (sec: Uint8Array) => {
    out.u32(off);
    out.u32(sec.length);
    off += sec.length;
  };
  put(dictSec);
  put(slugSec);
  put(listSec);
  put(mediaSec);
  put(spdxSec);
  put(aliasSec);
  put(schemeSec);
  put(whatwgSec);
  put(blockSec);
  put(methodSec);
  put(relSec);
  put(wkSec);
  put(tripSec);
  put(postSec);
  put(evidB);
  while (out.length < hdr) out.u8(0);
  out.bytes(dictSec);
  out.bytes(slugSec);
  out.bytes(listSec);
  out.bytes(mediaSec);
  out.bytes(spdxSec);
  out.bytes(aliasSec);
  out.bytes(schemeSec);
  out.bytes(whatwgSec);
  out.bytes(blockSec);
  out.bytes(methodSec);
  out.bytes(relSec);
  out.bytes(wkSec);
  out.bytes(tripSec);
  out.bytes(postSec);
  out.bytes(evidB);
  return out.finish();
}

function locMap(strs: string[]): Map<string, number> {
  const loc = new Map<string, number>();
  strs.forEach((s, i) => {
    loc.set(s, i + 1);
    const low = s.toLowerCase();
    if (!loc.has(low)) loc.set(low, i + 1);
  });
  return loc;
}

function decodeKpk1(buf: Uint8Array): KnowPack {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new Reader(view, 4, buf.byteLength);
  r.u32();
  r.u32();
  const nTrip = r.u32();
  r.u32();
  const dictOff = r.u32();
  const dictLen = r.u32();
  const tripOff = r.u32();
  const tripLen = r.u32();
  const postOff = r.u32();
  const postLen = r.u32();
  const evidOff = r.u32();
  const evidLen = r.u32();
  const strs = decodePfc(buf.subarray(dictOff, dictOff + dictLen));
  const loc = locMap(strs);
  const sid = new Array<number>(nTrip);
  const pid = new Array<number>(nTrip);
  const oid = new Array<number>(nTrip);
  const evid = new Array<number>(nTrip);
  const urlid = new Array<number>(nTrip);
  const tr = new Reader(new DataView(buf.buffer, buf.byteOffset + tripOff, tripLen), 0, tripLen);
  tr.u32();
  const nPred = tr.u32();
  for (let p = 0; p < nPred; p++) {
    const n = tr.u32();
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const slice = new Uint8Array(buf.buffer, buf.byteOffset + tripOff + tr.off, len);
      tr.off += len;
      return dec(slice);
    };
    const sids = take(deltaDecode);
    const oids = take(vbyteListDecode);
    const eids = take(vbyteListDecode);
    const uids = take(vbyteListDecode);
    const orig = take(vbyteListDecode);
    for (let i = 0; i < n; i++) {
      const idx = orig[i]!;
      sid[idx] = sids[i]!;
      pid[idx] = p;
      oid[idx] = oids[i]!;
      evid[idx] = eids[i]!;
      urlid[idx] = uids[i]!;
    }
  }
  const evidText: string[] = [];
  const er = new Reader(new DataView(buf.buffer, buf.byteOffset + evidOff, evidLen), 0, evidLen);
  const nE = er.u32();
  for (let i = 0; i < nE; i++) evidText.push(er.utf8(er.vbyte()));
  const post = new Map<string, number[]>();
  const pr = new Reader(new DataView(buf.buffer, buf.byteOffset + postOff, postLen), 0, postLen);
  const nT = pr.u32();
  for (let i = 0; i < nT; i++) {
    const term = pr.utf8(pr.vbyte());
    const len = pr.u32();
    const slice = new Uint8Array(buf.buffer, buf.byteOffset + postOff + pr.off, len);
    pr.off += len;
    post.set(term, deltaDecode(slice));
  }
  return new KnowPack(strs, [], [], loc, new Map(), sid, pid, oid, evid, urlid, evidText, post);
}

function decodeKpk2(buf: Uint8Array): KnowPack {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new Reader(view, 4, buf.byteLength);
  r.u32();
  r.u32();
  const nTrip = r.u32();
  r.u32();
  r.u32();
  const dictOff = r.u32();
  const dictLen = r.u32();
  const slugOff = r.u32();
  const slugLen = r.u32();
  const tripOff = r.u32();
  const tripLen = r.u32();
  const postOff = r.u32();
  const postLen = r.u32();
  const evidOff = r.u32();
  const evidLen = r.u32();
  const strs = decodePfc(buf.subarray(dictOff, dictOff + dictLen));
  const slugs = decodePfc(buf.subarray(slugOff, slugOff + slugLen));
  const loc = locMap(strs);
  const slugLoc = new Map<string, number>();
  slugs.forEach((s, i) => {
    slugLoc.set(s, i);
    slugLoc.set(s.toLowerCase(), i);
  });
  const sid = new Array<number>(nTrip);
  const pid = new Array<number>(nTrip);
  const oid = new Array<number>(nTrip);
  const evid = new Array<number>(nTrip);
  const urlid = new Array<number>(nTrip);
  const tr = new Reader(new DataView(buf.buffer, buf.byteOffset + tripOff, tripLen), 0, tripLen);
  tr.u32();
  const nPred = tr.u32();
  for (let p = 0; p < nPred; p++) {
    const n = tr.u32();
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const slice = new Uint8Array(buf.buffer, buf.byteOffset + tripOff + tr.off, len);
      tr.off += len;
      return dec(slice);
    };
    const sids = take(decodeFor);
    const oids = take(vbyteListDecode);
    const eids = take(vbyteListDecode);
    const uids = take(vbyteListDecode);
    const orig = take(vbyteListDecode);
    for (let i = 0; i < n; i++) {
      const idx = orig[i]!;
      sid[idx] = sids[i]!;
      pid[idx] = p;
      oid[idx] = oids[i]!;
      evid[idx] = eids[i]!;
      urlid[idx] = uids[i]!;
    }
  }
  const evidText: string[] = [];
  const er = new Reader(new DataView(buf.buffer, buf.byteOffset + evidOff, evidLen), 0, evidLen);
  const nE = er.u32();
  for (let i = 0; i < nE; i++) evidText.push(er.utf8(er.vbyte()));
  const post = new Map<string, number[]>();
  const pr = new Reader(new DataView(buf.buffer, buf.byteOffset + postOff, postLen), 0, postLen);
  const nT = pr.u32();
  for (let i = 0; i < nT; i++) {
    const term = pr.utf8(pr.vbyte());
    const len = pr.u32();
    const slice = new Uint8Array(buf.buffer, buf.byteOffset + postOff + pr.off, len);
    pr.off += len;
    post.set(term, decodePosting(slice));
  }
  remapKpk3Arr(sid);
  remapKpk3Arr(oid);
  return new KnowPack(strs, slugs, [], loc, slugLoc, sid, pid, oid, evid, urlid, evidText, post);
}

function decodeKpk3(buf: Uint8Array): KnowPack {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new Reader(view, 4, buf.byteLength);
  r.u32();
  r.u32();
  const nTrip = r.u32();
  r.u32();
  r.u32();
  r.u32();
  const dictOff = r.u32();
  const dictLen = r.u32();
  const slugOff = r.u32();
  const slugLen = r.u32();
  const listOff = r.u32();
  const listLen = r.u32();
  const tripOff = r.u32();
  const tripLen = r.u32();
  const postOff = r.u32();
  const postLen = r.u32();
  const evidOff = r.u32();
  const evidLen = r.u32();
  const strs = decodePfc(buf.subarray(dictOff, dictOff + dictLen));
  const slugs = decodePfc(buf.subarray(slugOff, slugOff + slugLen));
  const rfcLists = decodeRfcLists(buf.subarray(listOff, listOff + listLen));
  const loc = locMap(strs);
  const slugLoc = new Map<string, number>();
  slugs.forEach((s, i) => {
    slugLoc.set(s, i);
    slugLoc.set(s.toLowerCase(), i);
  });
  const sid = new Array<number>(nTrip);
  const pid = new Array<number>(nTrip);
  const oid = new Array<number>(nTrip);
  const evid = new Array<number>(nTrip);
  const urlid = new Array<number>(nTrip);
  const tr = new Reader(new DataView(buf.buffer, buf.byteOffset + tripOff, tripLen), 0, tripLen);
  tr.u32();
  const nPred = tr.u32();
  for (let p = 0; p < nPred; p++) {
    tr.u32();
    const origAll = readSidGroups(tr, buf, tripOff, sid, pid, p);
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const slice = new Uint8Array(buf.buffer, buf.byteOffset + tripOff + tr.off, len);
      tr.off += len;
      return dec(slice);
    };
    const oids = take(vbyteListDecode);
    for (let i = 0; i < origAll.length; i++) oid[origAll[i]!] = oids[i]!;
    const evidMode = tr.u8();
    if (evidMode === 0) {
      for (const idx of origAll) evid[idx] = 0;
    } else {
      const eids = take(vbyteListDecode);
      for (let i = 0; i < origAll.length; i++) evid[origAll[i]!] = eids[i]!;
    }
    const urlMode = tr.u8();
    if (urlMode === 0) {
      const u = tr.vbyte();
      for (const idx of origAll) urlid[idx] = u;
    } else {
      const uids = take(vbyteListDecode);
      for (let i = 0; i < origAll.length; i++) urlid[origAll[i]!] = uids[i]!;
    }
  }
  const evidText: string[] = [];
  const er = new Reader(new DataView(buf.buffer, buf.byteOffset + evidOff, evidLen), 0, evidLen);
  const nE = er.u32();
  for (let i = 0; i < nE; i++) evidText.push(er.utf8(er.vbyte()));
  const post = new Map<string, number[]>();
  const pr = new Reader(new DataView(buf.buffer, buf.byteOffset + postOff, postLen), 0, postLen);
  const nT = pr.u32();
  for (let i = 0; i < nT; i++) {
    const kind = pr.u8();
    const term = kind === 1 ? String(pr.u16()) : pr.utf8(pr.vbyte());
    const len = pr.u32();
    const slice = new Uint8Array(buf.buffer, buf.byteOffset + postOff + pr.off, len);
    pr.off += len;
    post.set(term, decodePosting(slice));
  }
  remapKpk3Arr(oid);
  return new KnowPack(strs, slugs, rfcLists, loc, slugLoc, sid, pid, oid, evid, urlid, evidText, post);
}

function decodeKpk4(buf: Uint8Array): KnowPack {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new Reader(view, 4, buf.byteLength);
  r.u32();
  r.u32();
  const nTrip = r.u32();
  r.u32();
  r.u32();
  r.u32();
  r.u32();
  r.u32();
  r.u32();
  const dictOff = r.u32();
  const dictLen = r.u32();
  const slugOff = r.u32();
  const slugLen = r.u32();
  const listOff = r.u32();
  const listLen = r.u32();
  const mediaOff = r.u32();
  const mediaLen = r.u32();
  const spdxOff = r.u32();
  const spdxLen = r.u32();
  const aliasOff = r.u32();
  const aliasLen = r.u32();
  const tripOff = r.u32();
  const tripLen = r.u32();
  const postOff = r.u32();
  const postLen = r.u32();
  const evidOff = r.u32();
  const evidLen = r.u32();
  const strs = decodeIntern(buf.subarray(dictOff, dictOff + dictLen));
  const slugs = decodePfc(buf.subarray(slugOff, slugOff + slugLen));
  const rfcLists = decodeRfcLists(buf.subarray(listOff, listOff + listLen));
  const media = decodePfc(buf.subarray(mediaOff, mediaOff + mediaLen));
  const spdx = decodePfc(buf.subarray(spdxOff, spdxOff + spdxLen));
  const alias = decodeAliases(buf.subarray(aliasOff, aliasOff + aliasLen));
  for (const [k, v] of alias) alias.set(k, packId((v >>> 29) & 7, v & 0x1fffffff));
  const loc = locMap(strs);
  const slugLoc = locTable(slugs);
  const sid = new Array<number>(nTrip);
  const pid = new Array<number>(nTrip);
  const oid = new Array<number>(nTrip);
  const evid = new Array<number>(nTrip);
  const urlid = new Array<number>(nTrip);
  const tr = new Reader(new DataView(buf.buffer, buf.byteOffset + tripOff, tripLen), 0, tripLen);
  tr.u32();
  const nPred = tr.u32();
  for (let p = 0; p < nPred; p++) {
    tr.u32();
    const origAll = readSidGroups(tr, buf, tripOff, sid, pid, p, 8);
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const slice = new Uint8Array(buf.buffer, buf.byteOffset + tripOff + tr.off, len);
      tr.off += len;
      return dec(slice);
    };
    const oids = take(vbyteListDecode);
    for (let i = 0; i < origAll.length; i++) oid[origAll[i]!] = packId((oids[i]! >>> 29) & 7, oids[i]! & 0x1fffffff);
    const evidMode = tr.u8();
    if (evidMode === 0) {
      for (const idx of origAll) evid[idx] = 0;
    } else {
      const eids = take(vbyteListDecode);
      for (let i = 0; i < origAll.length; i++) evid[origAll[i]!] = eids[i]!;
    }
    const urlMode = tr.u8();
    if (urlMode === 0) {
      const u = tr.vbyte();
      for (const idx of origAll) urlid[idx] = u;
    } else {
      const uids = take(vbyteListDecode);
      for (let i = 0; i < origAll.length; i++) urlid[origAll[i]!] = uids[i]!;
    }
  }
  const evidText: string[] = [];
  const er = new Reader(new DataView(buf.buffer, buf.byteOffset + evidOff, evidLen), 0, evidLen);
  const nE = er.u32();
  for (let i = 0; i < nE; i++) evidText.push(er.utf8(er.vbyte()));
  const post = new Map<string, number[]>();
  const pr = new Reader(new DataView(buf.buffer, buf.byteOffset + postOff, postLen), 0, postLen);
  const pfcLen = pr.u32();
  const strTerms = decodePfc(new Uint8Array(buf.buffer, buf.byteOffset + postOff + pr.off, pfcLen));
  pr.off += pfcLen;
  for (const t of strTerms) {
    const len = pr.u32();
    const slice = new Uint8Array(buf.buffer, buf.byteOffset + postOff + pr.off, len);
    pr.off += len;
    post.set(t, decodePosting(slice));
  }
  const nNum = pr.u32();
  for (let i = 0; i < nNum; i++) {
    const term = String(pr.u16());
    const len = pr.u32();
    const slice = new Uint8Array(buf.buffer, buf.byteOffset + postOff + pr.off, len);
    pr.off += len;
    post.set(term, decodePosting(slice));
  }
  let bloom: Uint8Array | null = null;
  if (pr.off + 2 <= postLen) {
    const n = pr.u16();
    if (n > 0 && pr.off + n <= postLen) {
      bloom = new Uint8Array(buf.buffer, buf.byteOffset + postOff + pr.off, n).slice();
    }
  }
  return new KnowPack(strs, slugs, rfcLists, loc, slugLoc, sid, pid, oid, evid, urlid, evidText, post, media, spdx, alias, bloom);
}

function decodeKpk5(buf: Uint8Array): KnowPack {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new Reader(view, 4, buf.byteLength);
  r.u32();
  r.u32();
  const nTrip = r.u32();
  for (let i = 0; i < 12; i++) r.u32();
  const takeOff = () => ({ off: r.u32(), len: r.u32() });
  const dict = takeOff();
  const slug = takeOff();
  const list = takeOff();
  const mediaS = takeOff();
  const spdxS = takeOff();
  const aliasS = takeOff();
  const schemeS = takeOff();
  const whatwgS = takeOff();
  const blockS = takeOff();
  const methodS = takeOff();
  const relS = takeOff();
  const wkS = takeOff();
  const tripS = takeOff();
  const postS = takeOff();
  const evidS = takeOff();
  const slice = (sec: { off: number; len: number }) => buf.subarray(sec.off, sec.off + sec.len);
  const strs = decodeIntern(slice(dict));
  const slugs = decodePfc(slice(slug));
  const rfcLists = decodeRfcLists(slice(list));
  const media = decodePfc(slice(mediaS));
  const spdx = decodePfc(slice(spdxS));
  const alias = decodeAliases(slice(aliasS));
  const scheme = decodePfc(slice(schemeS));
  const whatwg = decodePfc(slice(whatwgS));
  const blocks = decodePfc(slice(blockS));
  const methods = decodePfc(slice(methodS));
  const rels = decodePfc(slice(relS));
  const wks = decodePfc(slice(wkS));
  const loc = locMap(strs);
  const slugLoc = locTable(slugs);
  const sid = new Array<number>(nTrip);
  const pid = new Array<number>(nTrip);
  const oid = new Array<number>(nTrip);
  const evid = new Array<number>(nTrip);
  const urlid = new Array<number>(nTrip);
  const tr = new Reader(new DataView(buf.buffer, buf.byteOffset + tripS.off, tripS.len), 0, tripS.len);
  tr.u32();
  const nPred = tr.u32();
  for (let p = 0; p < nPred; p++) {
    tr.u32();
    const origAll = readSidGroups(tr, buf, tripS.off, sid, pid, p, N_KINDS);
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const sliceB = new Uint8Array(buf.buffer, buf.byteOffset + tripS.off + tr.off, len);
      tr.off += len;
      return dec(sliceB);
    };
    const oids = take(vbyteListDecode);
    for (let i = 0; i < origAll.length; i++) oid[origAll[i]!] = oids[i]!;
    const evidMode = tr.u8();
    if (evidMode === 0) {
      for (const idx of origAll) evid[idx] = 0;
    } else {
      const eids = take(vbyteListDecode);
      for (let i = 0; i < origAll.length; i++) evid[origAll[i]!] = eids[i]!;
    }
    const urlMode = tr.u8();
    if (urlMode === 0) {
      const u = tr.vbyte();
      for (const idx of origAll) urlid[idx] = u;
    } else {
      const uids = take(vbyteListDecode);
      for (let i = 0; i < origAll.length; i++) urlid[origAll[i]!] = uids[i]!;
    }
  }
  const evidText: string[] = [];
  const er = new Reader(new DataView(buf.buffer, buf.byteOffset + evidS.off, evidS.len), 0, evidS.len);
  const nE = er.u32();
  for (let i = 0; i < nE; i++) evidText.push(er.utf8(er.vbyte()));
  const post = new Map<string, number[]>();
  const pr = new Reader(new DataView(buf.buffer, buf.byteOffset + postS.off, postS.len), 0, postS.len);
  const pfcLen = pr.u32();
  const strTerms = decodePfc(new Uint8Array(buf.buffer, buf.byteOffset + postS.off + pr.off, pfcLen));
  pr.off += pfcLen;
  for (const term of strTerms) {
    const len = pr.u32();
    const sl = new Uint8Array(buf.buffer, buf.byteOffset + postS.off + pr.off, len);
    pr.off += len;
    post.set(term, decodePosting(sl));
  }
  const nNum = pr.u32();
  for (let i = 0; i < nNum; i++) {
    const term = String(pr.u16());
    const len = pr.u32();
    const sl = new Uint8Array(buf.buffer, buf.byteOffset + postS.off + pr.off, len);
    pr.off += len;
    post.set(term, decodePosting(sl));
  }
  let bloom: Uint8Array | null = null;
  if (pr.off + 2 <= postS.len) {
    const n = pr.u16();
    if (n > 0 && pr.off + n <= postS.len) {
      bloom = new Uint8Array(buf.buffer, buf.byteOffset + postS.off + pr.off, n).slice();
    }
  }
  return new KnowPack(
    strs, slugs, rfcLists, loc, slugLoc, sid, pid, oid, evid, urlid, evidText, post,
    media, spdx, alias, bloom, scheme, whatwg, blocks, methods, rels, wks,
  );
}

export function decodePack(buf: Uint8Array): KnowPack {
  const magic = new TextDecoder().decode(buf.subarray(0, 4));
  if (magic === PACK_MAGIC5) return decodeKpk5(buf);
  if (magic === PACK_MAGIC4) return decodeKpk4(buf);
  if (magic === PACK_MAGIC3) return decodeKpk3(buf);
  if (magic === PACK_MAGIC2) return decodeKpk2(buf);
  if (magic === PACK_MAGIC) return decodeKpk1(buf);
  throw new Error("bad know pack magic");
}

export function mergeFacts(pack: KnowPack | null, overlay: PackFact[]): PackFact[] {
  const seen = new Set<string>();
  const out: PackFact[] = [];
  for (const f of overlay) {
    seen.add(`${f.s}\0${f.p}`);
    out.push(f);
  }
  if (!pack) return out;
  for (let i = 0; i < pack.nTriples; i++) {
    const f = pack.factAt(i);
    if (seen.has(`${f.s}\0${f.p}`)) continue;
    out.push(f);
  }
  return out;
}
