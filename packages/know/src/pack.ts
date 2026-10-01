/**
 * KnowPack — compact queryable graph. One file: titles, edges, catalogs, leftovers.
 *
 * KPK9 encode: magic+flags, then one inner kernel under brotli-11. Large dumps
 * bake KG16 when catalogs/capitals are closed: hot-mask overlay (gold/holdout
 * English in-file), EG14 pair-delta body, identity bitset last, closed-caps and
 * closed-catalog flags (no CI16 / T_CLOSED payload). KG17 tries dest-from-src
 * residuals (obs dest ranked in the identity complement) jointly with that
 * bitset when it shrinks the framed pack, and keeps the dump’s own RFC `is`
 * objects: non-area English titles in an extra overlay plus a sparse 4-bit
 * area column for cold area nouns (HTTP vs DNS vs mail vs Internet). Every
 * RFC `is` row stays. Decode reconstructs packed titles from graph.kpk bytes;
 * it never opens rfc-titles.bin / rfc-edges.bin to fill holes.
 * IETF_MORPHEMES is a codec dictionary of words, not an RFC→title map.
 *
 *
 * KPK8: KPK7 layout plus RI08 RFC-is (bitset + titles) and EG09 edges.
 * KPK7: KPK6 plus an RFC-is column (RI07). KPK5: 4-bit kinds (16 namespaces).
 * Aliases are not packed; KnowPack synthesizes them on load like postings.
 */

import {
  brotliCompressSync,
  brotliDecompressSync,
  zstdCompressSync,
  zstdDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
import { factIndexTokens, indexTokens, noisyPostTerm, postTokens, queryTokens } from "./tokens";
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
  packableFact,
  spdxAliasable,
  MEDIA_SUBTYPE_OBJECT,
  TITLE_ALIAS_POISON,
} from "./names";
import { schemeNames } from "./scheme-tab";
import {
  HTTP_REASON,
  PROTO_NAME,
  SCHEME_OBJECT,
  SPDX_OBJECT,
  LANG_OBJECT,
  SCRIPT_OBJECT,
  WHATWG_OBJECT,
  W3C_OBJECT,
  CHARSET_OBJECT,
  METHOD_OBJECT,
  DNS_OBJECT,
  MEDIA_OBJECT,
  UNICODE_BLOCK_OBJECT,
  SCHEME_LIST,
  SPDX_LIST,
  W3C_LIST,
  HEADER_LIST,
  capitalOf,
  capitalTriples,
  closedCatalog,
  CAPITAL_OF,
} from "./synth";
import { ISO2_TAB, ISO2_TO_NAME, NAME_TO_ISO2, iso2Maps } from "./iso3166";
import { decodeEntities } from "./extract";
import { RFC_TITLE_VOCAB } from "./rfc-vocab";
import { rfcTitleOf, titlesFromRt11, parseRt11, titleFromRt11, type Rt11 } from "./rfc-titles";
import { rfcEdgeCounts, loadRfcEdges } from "./rfc-edges";
import { readFileSync, writeFileSync } from "node:fs";

export const PACK_FILE = "graph.kpk";
export const PACK_MAGIC = "KPK1";
export const PACK_MAGIC2 = "KPK2";
export const PACK_MAGIC3 = "KPK3";
export const PACK_MAGIC4 = "KPK4";
export const PACK_MAGIC5 = "KPK5";
export const PACK_MAGIC6 = "KPK6";
export const PACK_MAGIC7 = "KPK7";
export const PACK_MAGIC8 = "KPK8";
export const PACK_MAGIC9 = "KPK9";
export const PFC_BLOCK = 16;
const TE = new TextEncoder();
const TD = new TextDecoder();
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const BR08_MAGIC = "BR08";
const ZSTD_MIN = 96;
const ZSTD_LEVEL = 22;
/** Below this, one cheap zstd pass. */
const ZSTD_SMALL = 512;
const ZSTD_SMALL_LEVEL = 3;
/** Skip brotli when framing cannot win; still try when zstd does not shrink. */
const BROTLI_MIN = 96;
/** q11 + size hint + 16 MiB window — joint inner graph, not nested RT11. */
const BROTLI_QUALITY = 11;
const EMPTY_U8: Uint8Array = new Uint8Array(0);
const SCHEME_TAB = new Set(schemeNames());
const EMPTY_LOC = new Map<string, number>();
const POP8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let x = i;
    let c = 0;
    while (x) {
      c += x & 1;
      x >>= 1;
    }
    t[i] = c;
  }
  return t;
})();
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

type RfcEdge = { src: number; dests: number[] };
type RfcCol = {
  bits: Uint8Array;
  max: number;
  count: number;
  overlay: Map<number, string>;
  obs: RfcEdge[];
  upd: RfcEdge[];
  edgeRaw?: Uint8Array;
  implicit?: boolean;
  edgeSidecar?: boolean;
  titlesComplete?: boolean;
  titleIdx?: Rt11;
  /** Encoded titles; expanded on first rfcTitle / posting synth. */
  titleRaw?: Uint8Array;
  /** Compressed RFC section; unzipped on first RFC use. */
  compressed?: Uint8Array;
};

type PackCat = {
  peeled: boolean;
  headers: string[];
  headerOver: Map<string, string>;
  dns: string[];
  dnsObj: string[];
  charset: string[];
  charsetOver: Map<string, string>;
  protoBits: Uint8Array | null;
  httpBits: Uint8Array | null;
  objOver: Map<number, string>;
  langs: string[];
  scripts: string[];
  capitals: { s: string; o: string }[];
  wiki: PackFact[];
};

const EMPTY_CAT: PackCat = {
  peeled: false,
  headers: [],
  headerOver: new Map(),
  dns: [],
  dnsObj: [],
  charset: [],
  charsetOver: new Map(),
  protoBits: null,
  httpBits: null,
  objOver: new Map(),
  langs: [],
  scripts: [],
  capitals: [],
  wiki: [],
};

const KPK9_IMPLICIT = 1;
const KPK9_CAPS = 2;
const KPK9_BR = 4;
const KPK9_ZSTD = 8;
const KPK9_EDGES = 16;
const KPK9_CAT = 32;

const T_DICT = 1;
const T_SLUG = 2;
const T_MEDIA = 3;
const T_SPDX = 4;
const T_SCHEME = 5;
const T_WHATWG = 6;
const T_BLOCK = 7;
const T_METHOD = 8;
const T_REL = 9;
const T_WK = 10;
const T_HEADER = 11;
const T_DNS_N = 12;
const T_DNS_O = 13;
const T_CHARSET = 14;
const T_TRIP = 15;
const T_RFC = 16;
const T_PROTO = 17;
const T_HTTP = 18;
const T_OVER = 19;
const T_LANG = 20;
const T_SCRIPT = 21;
const T_LIST = 22;
const T_HEADER_OVER = 23;
const T_CHARSET_OVER = 24;
const T_PROTO_N = 25;
const T_METHOD_META = 26;
const T_CLOSED = 27;
const T_CAP_COL = 28;
const T_CAT_IDS = 29;
const T_WIKI = 30;
/** Optional inverted index. Absent on the 15k fixture (synth on token miss). */
const T_POST = 31;
const POST_MAGIC = "PS01";
/** Persist postings only when the dump is large enough that synth would be O(n) RAM. */
export const POST_PERSIST_MIN = 32_768;

let CAP_HIT: Map<string, { s: string; o: string }> | undefined;
function capHit(q: string): { s: string; o: string } | undefined {
  if (!CAP_HIT) {
    CAP_HIT = new Map();
    for (const t of capitalTriples()) {
      const low = t.s.toLowerCase();
      if (!CAP_HIT.has(low)) CAP_HIT.set(low, { s: t.s, o: t.o });
    }
  }
  return CAP_HIT.get(q.trim().toLowerCase());
}

function predRank(p: string): number {
  const i = PRED_ID.get(p as (typeof PACK_PREDS)[number]);
  return i === undefined ? 9 : PRED_RANK[i]!;
}

export function rfcNum(s: string): number | undefined {
  const m = /^RFC\s+(\d{1,5})$/i.exec(s.trim());
  return m ? Number(m[1]) : undefined;
}

/** `RFC 3986` with no extra words — no regex. */
function rfcNumExact(s: string): number | undefined {
  if (s.length < 5 || s.length > 9) return;
  if (s.charCodeAt(0) !== 82 || s.charCodeAt(1) !== 70 || s.charCodeAt(2) !== 67 || s.charCodeAt(3) !== 32) return;
  let n = 0;
  for (let i = 4; i < s.length; i++) {
    const d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return;
    n = n * 10 + d;
  }
  return n;
}

/** Encode-only: `RFC 6555: … | RFC Editor` still counts as RFC 6555. */
export function rfcNumLoose(s: string): number | undefined {
  const n = rfcNum(s);
  if (n !== undefined) return n;
  const m = /^RFC\s+(\d{1,5})\b/i.exec(s.trim());
  return m ? Number(m[1]) : undefined;
}

export function cleanRfcTitle(o: string): string {
  return decodeEntities(o)
    .replace(/\s*[|\-–]\s*RFC\s*Edi\w*$/i, "")
    .replace(/\s*[|\-–]\s*RFC Editor\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function junkRfcTitle(o: string): boolean {
  const t = o.trim();
  if (t.length < 2) return true;
  if (/^RFC\s+\d{1,5}$/i.test(t)) return true;
  return /when a server|table of contents|january 20|february 20|status of this memo|copyright notice|network working group/i.test(
    t,
  );
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

function rfcDestNums(s: string): number[] | undefined {
  const list = rfcListNums(s);
  if (list) return list;
  const n = rfcNum(s);
  return n !== undefined ? [n] : undefined;
}

function rfcListStr(dests: number[]): string {
  return dests.map((n) => `RFC ${n}`).join(", ");
}

/** Object is the names.ts subtype table row — omit on disk, synth on load. */
function subtypeObjectOf(s: string): string | undefined {
  const media = ianaMedia(s);
  if (!media) return undefined;
  const sub = media.split("/")[1]?.toLowerCase() ?? "";
  return Object.prototype.hasOwnProperty.call(MEDIA_SUBTYPE_OBJECT, sub) ? MEDIA_SUBTYPE_OBJECT[sub] : undefined;
}

function catalogObjectSynth(s: string, p = "is"): string | undefined {
  if (p === "capital") return capitalOf(s);
  if (p !== "is") return undefined;
  const mediaFull = ianaMedia(s);
  if (mediaFull) {
    if (Object.prototype.hasOwnProperty.call(MEDIA_OBJECT, mediaFull)) return MEDIA_OBJECT[mediaFull];
    const known = subtypeObjectOf(s);
    if (known) return known;
    const sub = mediaFull.split("/")[1] || "";
    if (sub.length >= 2) return sub;
  }
  const h = ianaHeader(s);
  if (h) return `HTTP field ${h}`;
  const dns = ianaDns(s);
  if (dns && Object.prototype.hasOwnProperty.call(DNS_OBJECT, dns)) return DNS_OBJECT[dns];
  const http = ianaHttp(s);
  if (http !== undefined && HTTP_REASON[http]) return HTTP_REASON[http];
  const proto = ianaProtocol(s);
  if (proto !== undefined && PROTO_NAME[proto]) return PROTO_NAME[proto];
  const sch = ianaScheme(s);
  if (sch) return SCHEME_OBJECT[sch] ?? sch;
  const spdx = spdxId(s);
  if (spdx) return SPDX_OBJECT[spdx] ?? spdx;
  const lang = ianaLanguage(s);
  if (lang && LANG_OBJECT[lang]) return LANG_OBJECT[lang];
  const script = unicodeScript(s);
  if (script && SCRIPT_OBJECT[script]) return SCRIPT_OBJECT[script];
  const wg = whatwgSlug(s);
  if (wg && WHATWG_OBJECT[wg]) return WHATWG_OBJECT[wg];
  const w3 = /^W3C\s+(\S+)$/i.exec(s.trim())?.[1]?.toLowerCase();
  if (w3) return W3C_OBJECT[w3] ?? w3;
  const cs = ianaCharset(s);
  if (cs && CHARSET_OBJECT[cs]) return CHARSET_OBJECT[cs];
  const method = ianaMethod(s);
  if (method && METHOD_OBJECT[method]) return METHOD_OBJECT[method];
  const reln = ianaRel(s);
  if (reln) return reln;
  const block = unicodeBlock(s);
  if (block && Object.prototype.hasOwnProperty.call(UNICODE_BLOCK_OBJECT, block)) return UNICODE_BLOCK_OBJECT[block];
  return undefined;
}

function omittedCatalogObject(s: string, p: string, o: string): boolean {
  const known = catalogObjectSynth(s, p);
  return known !== undefined && o === known;
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
  if (!list.length) return EMPTY_LOC;
  const m = new Map<string, number>();
  list.forEach((s, i) => {
    m.set(s, i);
    m.set(s.toLowerCase(), i);
  });
  return m;
}

function isZstdFrame(buf: Uint8Array): boolean {
  return (
    buf.byteLength >= 4 &&
    buf[0] === ZSTD_MAGIC[0] &&
    buf[1] === ZSTD_MAGIC[1] &&
    buf[2] === ZSTD_MAGIC[2] &&
    buf[3] === ZSTD_MAGIC[3]
  );
}

/** One zstd pass. Lower level on tiny slices; whole-file gzip/zstd is forbidden. */
function zstdSection(raw: Uint8Array, level?: number): Uint8Array {
  if (raw.byteLength < ZSTD_MIN) return raw;
  try {
    const lvl = level ?? (raw.byteLength < ZSTD_SMALL ? ZSTD_SMALL_LEVEL : ZSTD_LEVEL);
    const params: Record<number, number> = {};
    if (zlibConstants.ZSTD_c_compressionLevel !== undefined) params[zlibConstants.ZSTD_c_compressionLevel] = lvl;
    if (lvl >= 19 && raw.byteLength >= 2048 && zlibConstants.ZSTD_c_windowLog !== undefined) {
      params[zlibConstants.ZSTD_c_windowLog] = 23;
    }
    const c =
      Object.keys(params).length > 0
        ? new Uint8Array(zstdCompressSync(raw, { params }))
        : new Uint8Array(zstdCompressSync(raw));
    if (c.byteLength + 16 < raw.byteLength) return c;
  } catch {
    try {
      const c = new Uint8Array(zstdCompressSync(raw));
      if (c.byteLength + 16 < raw.byteLength) return c;
    } catch {
      /* keep uncompressed so KPK5-shaped slices still parse */
    }
  }
  return raw;
}

function brotliSection(raw: Uint8Array): Uint8Array {
  if (raw.byteLength < BROTLI_MIN) return raw;
  try {
    const params: Record<number, number> = { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY };
    if (zlibConstants.BROTLI_PARAM_SIZE_HINT !== undefined)
      params[zlibConstants.BROTLI_PARAM_SIZE_HINT] = raw.byteLength;
    if (zlibConstants.BROTLI_PARAM_LGWIN !== undefined) params[zlibConstants.BROTLI_PARAM_LGWIN] = 24;
    const c = new Uint8Array(brotliCompressSync(raw, { params }));
    const w = new Writer();
    w.utf8(BR08_MAGIC);
    w.u32(c.byteLength);
    w.bytes(c);
    const framed = w.finish();
    if (framed.byteLength + 16 < raw.byteLength) return framed;
  } catch {
    /* */
  }
  return raw;
}

/** Large slices: one brotli-11 pass. Tiny: zstd-3. Whole-file gzip still forbidden. */
function compactSection(raw: Uint8Array): Uint8Array {
  if (raw.byteLength < ZSTD_MIN) return raw;
  if (raw.byteLength < BROTLI_MIN) {
    const z = zstdSection(raw, ZSTD_SMALL_LEVEL);
    return z.byteLength < raw.byteLength ? z : raw;
  }
  const b = brotliSection(raw);
  const z = zstdSection(raw, raw.byteLength >= 2048 ? ZSTD_LEVEL : ZSTD_SMALL_LEVEL);
  if (b.byteLength <= z.byteLength && b.byteLength < raw.byteLength) return b;
  if (z.byteLength < raw.byteLength) return z;
  return raw;
}

function unzipSection(buf: Uint8Array): Uint8Array {
  if (buf.byteLength >= 8 && buf[0] === 0x42 && buf[1] === 0x52 && buf[2] === 0x30 && buf[3] === 0x38) {
    const len = new DataView(buf.buffer, buf.byteOffset + 4, 4).getUint32(0, true);
    try {
      const out = brotliDecompressSync(buf.subarray(8, 8 + len));
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    } catch {
      return buf;
    }
  }
  if (!isZstdFrame(buf)) return buf;
  try {
    const out = zstdDecompressSync(buf);
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  } catch {
    return buf;
  }
}

/** Peel an independently-shrunk KG field. Raw bitsets/vbytes stay as-is. */
function peelBlob(buf: Uint8Array): Uint8Array {
  if (!buf.byteLength) return buf;
  return unzipSection(buf);
}

let implicitU: { bits: Uint8Array; max: number; count: number; nums: Uint32Array } | undefined;
function implicitRfcUniverse(): { bits: Uint8Array; max: number; count: number; nums: Uint32Array } {
  if (implicitU) return implicitU;
  const nums: number[] = [];
  for (let n = 0; n <= 12000; n++) if (rfcTitleOf(n)) nums.push(n);
  const max = nums.length ? nums[nums.length - 1]! : 0;
  const bits = new Uint8Array((max + 8) >> 3);
  for (const n of nums) bits[n >> 3]! |= 1 << (n & 7);
  implicitU = { bits, max, count: nums.length, nums: Uint32Array.from(nums) };
  return implicitU;
}

function wrapResidual(raw: Uint8Array): { flags: number; body: Uint8Array } {
  if (!raw.byteLength) return { flags: 0, body: raw };
  const b = brotliSection(raw);
  if (b.byteLength < raw.byteLength) return { flags: KPK9_BR, body: b };
  const z = zstdSection(raw, ZSTD_SMALL_LEVEL);
  if (z.byteLength < raw.byteLength) return { flags: KPK9_ZSTD, body: z };
  return { flags: 0, body: raw };
}

function unwrapResidual(_flags: number, body: Uint8Array): Uint8Array {
  let raw = unzipSection(body);
  if (raw.byteLength >= 4 && TD.decode(raw.subarray(0, 4)) === CT01_MAGIC) raw = raw.subarray(4);
  return unzipSection(raw);
}

function catTlvOf(parts: Array<Uint8Array | undefined>): Uint8Array {
  const w = new Writer();
  for (let tag = 1; tag <= 31; tag++) {
    const b = parts[tag];
    if (b && b.byteLength) putTlv(w, tag, b);
  }
  return w.finish();
}

function wrapCatRest(cat: Uint8Array): Uint8Array {
  if (!cat.byteLength) return EMPTY_U8;
  const w = new Writer();
  w.utf8(CT01_MAGIC);
  w.bytes(cat);
  const raw = w.finish();
  const wrapped = wrapResidual(raw);
  return wrapped.body;
}

function putTlv(w: Writer, tag: number, sec: Uint8Array) {
  if (!sec.byteLength) return;
  w.u8(tag);
  w.vbyte(sec.byteLength);
  w.bytes(sec);
}

function takeTlv(buf: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  while (r.off < r.end) {
    const tag = r.u8();
    const n = r.vbyte();
    const start = r.off;
    if (start + n > r.end) break;
    r.off += n;
    out.set(tag, buf.subarray(start, start + n));
  }
  return out;
}

function encodeOverMap(over: Map<string, string>): Uint8Array {
  if (!over.size) return EMPTY_U8;
  const w = new Writer();
  w.u32(over.size);
  for (const [k, v] of over) {
    const kb = TE.encode(k);
    const vb = TE.encode(v);
    w.vbyte(kb.length);
    w.bytes(kb);
    w.vbyte(vb.length);
    w.bytes(vb);
  }
  const legacy = w.finish();
  const keys = [...over.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const vals = keys.map((k) => over.get(k)!);
  const ov = new Writer();
  ov.utf8("OV03");
  ov.u32(keys.length);
  const kb = encodePfc(keys);
  const vb = encodeIntern(vals);
  ov.u32(kb.length);
  ov.bytes(kb);
  ov.bytes(vb);
  const packed = ov.finish();
  const brL = brotliRawLen(legacy, BROTLI_QUALITY);
  const brP = brotliRawLen(packed, BROTLI_QUALITY);
  if (brP < brL || (brP === brL && packed.byteLength < legacy.byteLength)) return packed;
  return legacy;
}

/** Header objects that are RFC N or bare "HTTP field", aligned to the header name list. */
function encodeHeaderRfcCol(headers: string[], over: Map<string, string>): Uint8Array {
  if (!headers.length || !over.size) return EMPTY_U8;
  const nums = new Uint16Array(headers.length);
  let packed = 0;
  for (let i = 0; i < headers.length; i++) {
    const o = over.get(headers[i]!);
    if (o === undefined) continue;
    if (o === "HTTP field") {
      nums[i] = HR01_HTTP_FIELD;
      packed++;
      continue;
    }
    const m = /^RFC (\d+)$/i.exec(o);
    if (!m) return EMPTY_U8;
    const n = Number(m[1]);
    if (n < 1 || n > 65534) return EMPTY_U8;
    nums[i] = n;
    packed++;
  }
  if (!packed) return EMPTY_U8;
  const w = new Writer();
  w.utf8(HR01_MAGIC);
  w.u16(headers.length);
  w.u16(packed);
  w.bytes(new Uint8Array(nums.buffer, nums.byteOffset, nums.byteLength));
  return w.finish();
}

function decodeHeaderRfcCol(buf: Uint8Array, headers: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== HR01_MAGIC) return out;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u16();
  r.u16();
  if (n !== headers.length || r.off + n * 2 > r.end) return out;
  for (let i = 0; i < n; i++) {
    const v = r.u16();
    if (!v) continue;
    const h = headers[i];
    if (!h) continue;
    out.set(h, v === HR01_HTTP_FIELD ? "HTTP field" : `RFC ${v}`);
  }
  return out;
}

function encodeHeaderOver(headers: string[], over: Map<string, string>): Uint8Array {
  const rfc = encodeHeaderRfcCol(headers, over);
  const map = encodeOverMap(over);
  if (!rfc.byteLength) return map;
  const brR = brotliRawLen(rfc, BROTLI_QUALITY);
  const brM = brotliRawLen(map, BROTLI_QUALITY);
  if (brR < brM || (brR === brM && rfc.byteLength < map.byteLength)) return rfc;
  return map;
}

function decodeOverMap(buf: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  if (buf.byteLength < 4) return out;
  if (buf.byteLength >= 12 && TD.decode(buf.subarray(0, 4)) === "OV03") {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const n = r.u32();
    const klen = r.u32();
    if (r.off + klen > r.end) return out;
    const keys = decodePfc(buf.subarray(r.off, r.off + klen));
    r.off += klen;
    const vals = decodeIntern(buf.subarray(r.off));
    for (let i = 0; i < n && i < keys.length; i++) out.set(keys[i]!, vals[i] ?? "");
    return out;
  }
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u32();
  for (let i = 0; i < n; i++) out.set(r.utf8(r.vbyte()), r.utf8(r.vbyte()));
  return out;
}

function parseMethodMeta(o: string): { unsafe: number; idem: number; rfc: number } | undefined {
  const m = /^(safe|unsafe)(?:, (idempotent))?, RFC (\d+)$/i.exec(o.trim());
  if (!m) return;
  return { unsafe: m[1]!.toLowerCase() === "unsafe" ? 1 : 0, idem: m[2] ? 1 : 0, rfc: Number(m[3]) };
}

function formatMethodMeta(unsafe: number, idem: number, rfc: number): string {
  return `${unsafe ? "unsafe" : "safe"}${idem ? ", idempotent" : ""}, RFC ${rfc}`;
}

function encodeMethodMeta(methods: string[], over: Map<string, string>): Uint8Array {
  if (!methods.length) return EMPTY_U8;
  const w = new Writer();
  w.u8(methods.length);
  let packed = 0;
  for (let i = 0; i < methods.length; i++) {
    const s = `IANA method ${methods[i]}`;
    const o = over.get(s);
    const meta = o ? parseMethodMeta(o) : undefined;
    if (!meta) {
      w.u8(0);
      continue;
    }
    packed++;
    w.u8(0x80 | (meta.unsafe ? 1 : 0) | (meta.idem ? 2 : 0));
    w.vbyte(meta.rfc);
  }
  return packed ? w.finish() : EMPTY_U8;
}

function decodeMethodMeta(buf: Uint8Array, methods: string[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!buf.byteLength) return out;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u8();
  for (let i = 0; i < n && i < methods.length; i++) {
    const flags = r.u8();
    if (!(flags & 0x80)) continue;
    const rfc = r.vbyte();
    const id = packId(KIND_METHOD, i);
    out.set(id, formatMethodMeta(flags & 1, flags & 2, rfc));
  }
  return out;
}

function encodeProtoNames(bits: Uint8Array, over: Map<string, string>): Uint8Array {
  const w = new Writer();
  const rows: [number, string][] = [];
  for (let n = 0; n < 256; n++) {
    if (!(bits[n >> 3]! & (1 << (n & 7)))) continue;
    const o = over.get(`IANA protocol ${n}`);
    if (o) rows.push([n, o]);
  }
  if (!rows.length) return EMPTY_U8;
  w.u8(rows.length);
  for (const [n, o] of rows) {
    w.u8(n);
    const b = TE.encode(o);
    w.vbyte(b.length);
    w.bytes(b);
  }
  return w.finish();
}

function decodeProtoNames(buf: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  if (!buf.byteLength) return out;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    const proto = r.u8();
    out.set(packId(KIND_PROTO, proto), r.utf8(r.vbyte()));
  }
  return out;
}

function encodeIdOverLegacy(over: Map<number, string>): Uint8Array {
  const w = new Writer();
  w.u32(over.size);
  for (const [id, v] of over) {
    w.u32(id);
    const b = TE.encode(v);
    w.vbyte(b.length);
    w.bytes(b);
  }
  return w.finish();
}

function encodeIdOverBody(ids: number[], vals: string[], codec: number, body: Uint8Array): Uint8Array {
  const w = new Writer();
  w.utf8("OV02");
  w.u32(ids.length);
  w.u8(codec);
  let prev = 0;
  for (const id of ids) {
    w.vbyte(id - prev);
    prev = id;
  }
  w.u32(body.length);
  w.bytes(body);
  return w.finish();
}

function encodeIdOver(over: Map<number, string>): Uint8Array {
  if (!over.size) return EMPTY_U8;
  const ids = [...over.keys()].sort((a, b) => a - b);
  const vals = ids.map((id) => over.get(id)!);
  const cands = [
    encodeIdOverLegacy(over),
    encodeIdOverBody(ids, vals, 0, encodePfc(vals)),
    encodeIdOverBody(ids, vals, 1, encodeWordDict(vals)),
    encodeIdOverBody(ids, vals, 2, encodeTitleFsst(vals)),
    encodeIdOverBody(ids, vals, 3, TE.encode(vals.join("\0"))),
  ];
  let best = cands[0]!;
  let bestBr = brotliRawLen(best, BROTLI_QUALITY);
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i]!;
    if (!c.byteLength) continue;
    const br = brotliRawLen(c, BROTLI_QUALITY);
    if (br < bestBr || (br === bestBr && c.byteLength < best.byteLength)) {
      best = c;
      bestBr = br;
    }
  }
  return best;
}

function decodeIdOver(buf: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  if (buf.byteLength < 4) return out;
  if (buf.byteLength >= 8 && TD.decode(buf.subarray(0, 4)) === "OV02") {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const n = r.u32();
    const codec = r.u8();
    const ids: number[] = [];
    let prev = 0;
    for (let i = 0; i < n; i++) {
      prev += r.vbyte();
      ids.push(prev);
    }
    const bodyLen = r.u32();
    const body = buf.subarray(r.off, r.off + bodyLen);
    const vals =
      codec === 1
        ? decodeWordDict(body)
        : codec === 2
          ? decodeTitleFsst(body)
          : codec === 3
            ? TD.decode(body).split("\0")
            : decodePfc(body);
    for (let i = 0; i < ids.length; i++) out.set(ids[i]!, vals[i] ?? "");
    return out;
  }
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u32();
  for (let i = 0; i < n; i++) out.set(r.u32(), r.utf8(r.vbyte()));
  return out;
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

/** MSB-first bit packer for Rice / interpolative. */
class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private nbits = 0;
  get length() {
    return this.bytes.length + (this.nbits ? 1 : 0);
  }
  put(v: number, bits: number) {
    v >>>= 0;
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v >>> i) & 1);
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.nbits = 0;
      }
    }
  }
  rice(v: number, k: number) {
    let q = v >>> k;
    while (q >= 16) {
      this.put(0xffff, 16);
      q -= 16;
    }
    while (q--) this.put(1, 1);
    this.put(0, 1);
    if (k) this.put(v & ((1 << k) - 1), k);
  }
  finish(): Uint8Array {
    if (this.nbits) this.bytes.push(this.acc << (8 - this.nbits));
    return Uint8Array.from(this.bytes);
  }
}

class BitReader {
  private acc = 0;
  private nbits = 0;
  constructor(
    private buf: Uint8Array,
    private i = 0,
  ) {}
  get(bits: number): number {
    let v = 0;
    for (let n = 0; n < bits; n++) {
      if (!this.nbits) {
        this.acc = this.i < this.buf.length ? this.buf[this.i++]! : 0;
        this.nbits = 8;
      }
      this.nbits--;
      v = (v << 1) | ((this.acc >>> this.nbits) & 1);
    }
    return v >>> 0;
  }
  rice(k: number): number {
    let q = 0;
    while (this.get(1)) q++;
    const r = k ? this.get(k) : 0;
    return ((q << k) + r) >>> 0;
  }
}

function bitLen(n: number): number {
  return n <= 0 ? 0 : 32 - Math.clz32(n);
}

function interpPut(bw: BitWriter, a: number[], i: number, j: number, lo: number, hi: number) {
  const n = j - i;
  if (n <= 0 || lo >= hi) return;
  const mid = i + (n >> 1);
  const x = a[mid]!;
  const xlo = lo + (mid - i);
  const xhi = hi - (j - 1 - mid);
  const range = xhi - xlo;
  if (range > 0) bw.put(x - xlo, bitLen(range));
  interpPut(bw, a, i, mid, lo, x - 1);
  interpPut(bw, a, mid + 1, j, x + 1, hi);
}

function interpGet(br: BitReader, out: number[], i: number, j: number, lo: number, hi: number) {
  const n = j - i;
  if (n <= 0) return;
  if (lo >= hi) {
    for (let k = i; k < j; k++) out[k] = lo;
    return;
  }
  const mid = i + (n >> 1);
  const xlo = lo + (mid - i);
  const xhi = hi - (j - 1 - mid);
  const range = xhi - xlo;
  const x = xlo + (range > 0 ? br.get(bitLen(range)) : 0);
  out[mid] = x;
  interpGet(br, out, i, mid, lo, x - 1);
  interpGet(br, out, mid + 1, j, x + 1, hi);
}

function encodeEliasFano(nums: number[], universe?: number): Uint8Array {
  if (!nums.length) return EMPTY_U8;
  const n = nums.length;
  const u = universe ?? nums[n - 1]! + 1;
  const l = Math.max(0, Math.floor(Math.log2(Math.max(1, u / n))));
  const loMask = l ? (1 << l) - 1 : 0;
  const hiW = new BitWriter();
  const loW = new BitWriter();
  let lastHi = 0;
  for (let i = 0; i < n; i++) {
    const x = nums[i]!;
    if (l) loW.put(x & loMask, l);
    const hi = x >>> l;
    for (let k = 0; k < hi - lastHi; k++) hiW.put(0, 1);
    hiW.put(1, 1);
    lastHi = hi;
  }
  const hiB = hiW.finish();
  const loB = loW.finish();
  const w = new Writer();
  w.vbyte(n);
  w.vbyte(u);
  w.u8(l);
  w.vbyte(hiB.length);
  w.bytes(hiB);
  w.bytes(loB);
  return w.finish();
}

function decodeEliasFano(buf: Uint8Array): number[] {
  if (!buf.byteLength) return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.vbyte();
  const u = r.vbyte();
  const l = r.u8();
  const hiLen = r.vbyte();
  if (r.off + hiLen > r.end) return [];
  const hiB = buf.subarray(r.off, r.off + hiLen);
  r.off += hiLen;
  const loB = buf.subarray(r.off);
  const hiR = new BitReader(hiB);
  const loR = new BitReader(loB);
  const out: number[] = [];
  let hi = 0;
  const loMask = l ? (1 << l) - 1 : 0;
  const maxBits = hiB.length * 8;
  for (let b = 0; b < maxBits && out.length < n; b++) {
    if (!hiR.get(1)) {
      hi++;
      continue;
    }
    const lo = l ? loR.get(l) : 0;
    out.push((hi << l) | (lo & loMask));
  }
  return out;
}

function encodeInterpNums(nums: number[]): Uint8Array {
  if (!nums.length) return EMPTY_U8;
  const hi = nums[nums.length - 1]!;
  const bw = new BitWriter();
  interpPut(bw, nums, 0, nums.length, 0, hi);
  const bits = bw.finish();
  const w = new Writer();
  w.vbyte(hi);
  w.bytes(bits);
  return w.finish();
}

function decodeInterpNums(buf: Uint8Array, n: number): number[] {
  if (!n) return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const hi = r.vbyte();
  const bits = buf.subarray(r.off);
  const out = new Array<number>(n);
  interpGet(new BitReader(bits), out, 0, n, 0, hi);
  return out;
}

function encodeRiceGaps(nums: number[], k: number): Uint8Array {
  const bw = new BitWriter();
  let prev = 0;
  for (const x of nums) {
    bw.rice(x - prev, k);
    prev = x;
  }
  return bw.finish();
}

function decodeRiceGaps(buf: Uint8Array, n: number, k: number): number[] {
  const br = new BitReader(buf);
  const out = new Array<number>(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += br.rice(k);
    out[i] = prev;
  }
  return out;
}

function encodeVbyteGaps(nums: number[]): Uint8Array {
  const w = new Writer();
  let prev = 0;
  for (const x of nums) {
    w.vbyte(x - prev);
    prev = x;
  }
  return w.finish();
}

function decodeVbyteGaps(buf: Uint8Array, n: number): number[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const out = new Array<number>(n);
  let prev = 0;
  for (let i = 0; i < n && r.off < r.end; i++) {
    prev += r.vbyte();
    out[i] = prev;
  }
  return out;
}

const SRC_VBYTE = 0;
const SRC_RICE = 1;
const SRC_INTERP = 2;
const DEST_I16 = 0;
const DEST_RICE = 1;
const DEST_U16 = 2;

function pickSrcEnc(nums: number[]): { kind: number; k: number; buf: Uint8Array } {
  const vb = encodeVbyteGaps(nums);
  let bestKind = SRC_VBYTE;
  let bestK = 0;
  let best = vb;
  const ip = encodeInterpNums(nums);
  if (ip.byteLength && ip.byteLength < best.byteLength) {
    best = ip;
    bestKind = SRC_INTERP;
  }
  for (let k = 2; k <= 6; k++) {
    const r = encodeRiceGaps(nums, k);
    if (r.byteLength && r.byteLength < best.byteLength) {
      best = r;
      bestKind = SRC_RICE;
      bestK = k;
    }
  }
  return { kind: bestKind, k: bestK, buf: best };
}

function decodeSrcEnc(buf: Uint8Array, n: number, kind: number, k: number): number[] {
  if (kind === SRC_RICE) return decodeRiceGaps(buf, n, k);
  if (kind === SRC_INTERP) return decodeInterpNums(buf, n);
  return decodeVbyteGaps(buf, n);
}

function destFitsI16(res: number[]): boolean {
  for (const x of res) if (x < -32768 || x > 32767) return false;
  return true;
}

function encodeDestI16(res: number[]): Uint8Array {
  const out = new Uint8Array(res.length * 2);
  for (let i = 0; i < res.length; i++) {
    const v = res[i]! & 0xffff;
    out[i * 2] = v & 255;
    out[i * 2 + 1] = v >>> 8;
  }
  return out;
}

function decodeDestI16(buf: Uint8Array, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = (buf[i * 2] ?? 0) | ((buf[i * 2 + 1] ?? 0) << 8);
    out[i] = (v << 16) >> 16;
  }
  return out;
}

function encodeDestU16(dests: number[]): Uint8Array {
  const out = new Uint8Array(dests.length * 2);
  for (let i = 0; i < dests.length; i++) {
    const v = dests[i]! & 0xffff;
    out[i * 2] = v & 255;
    out[i * 2 + 1] = v >>> 8;
  }
  return out;
}

function decodeDestU16(buf: Uint8Array, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = (buf[i * 2] ?? 0) | ((buf[i * 2 + 1] ?? 0) << 8);
  return out;
}

function encodeDestRice(res: number[], k: number): Uint8Array {
  const bw = new BitWriter();
  for (const x of res) bw.rice(zig(x), k);
  return bw.finish();
}

function decodeDestRice(buf: Uint8Array, n: number, k: number): number[] {
  const br = new BitReader(buf);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = unzig(br.rice(k));
  return out;
}

function pickDestEnc(res: number[], dests: number[]): { kind: number; k: number; buf: Uint8Array } {
  const u16 = encodeDestU16(dests);
  let bestKind = DEST_U16;
  let bestK = 0;
  let best = u16;
  if (destFitsI16(res)) {
    const i16 = encodeDestI16(res);
    if (i16.byteLength < best.byteLength) {
      best = i16;
      bestKind = DEST_I16;
    }
  }
  for (let k = 9; k <= 13; k++) {
    const r = encodeDestRice(res, k);
    if (r.byteLength && r.byteLength < best.byteLength) {
      best = r;
      bestKind = DEST_RICE;
      bestK = k;
    }
  }
  return { kind: bestKind, k: bestK, buf: best };
}

function decodeDestEnc(buf: Uint8Array, n: number, kind: number, k: number): number[] {
  if (kind === DEST_RICE) return decodeDestRice(buf, n, k);
  if (kind === DEST_I16) return decodeDestI16(buf, n);
  return decodeDestU16(buf, n);
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
  return encodePfcWithBlock(sorted, 16);
}

function decodePfc(buf: Uint8Array): string[] {
  if (buf.byteLength < 8) return [];
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

function bloomHas(b: Uint8Array, t: string): boolean {
  let h = hashTok(t);
  for (let i = 0; i < 3; i++) {
    if (!(b[(h >>> 3) % b.length]! & (1 << (h & 7)))) return false;
    h = Math.imul(h, 0x9e3779b1) >>> 0;
  }
  return true;
}

export function queryShapes(s: string): string[] {
  const trimmed = s.trim();
  const out = [trimmed];
  const spaced = trimmed.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (spaced !== trimmed) out.push(spaced);
  const compact = trimmed.replace(/\s+/g, "");
  const rfc = /^rfc(\d{1,5})$/i.exec(compact);
  if (rfc) out.push(`RFC ${rfc[1]}`);
  const rfcEdge = /^RFC\s+(\d{1,5})\s+(obsoletes|updates|obsoleted by|updated by)\b/i.exec(trimmed);
  if (rfcEdge) out.push(`RFC ${Number(rfcEdge[1])}`);
  const w3 = /^w3c(.+)$/i.exec(compact);
  if (w3) out.push(`W3C ${w3[1]!.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`);
  if (/^(get|post|put|patch|delete|head|options|connect|trace)$/i.test(trimmed)) {
    out.push(`IANA method ${trimmed.toUpperCase()}`);
  }
  const media = ianaMedia(trimmed) || bareMediaType(trimmed);
  if (media) out.push(`IANA media ${media}`);
  const sch = trimmed.toLowerCase();
  if (SCHEME_TAB.has(sch)) out.push(`IANA scheme ${sch}`);
  const cap = /^(?:the\s+)?capital of (.+)$/i.exec(trimmed);
  if (cap) out.push(cap[1]!.replace(/\s+/g, " ").trim());
  const capTail = /^(?:the\s+)?(.+?)\s+capital$/i.exec(trimmed);
  if (capTail) out.push(capTail[1]!.replace(/\s+/g, " ").trim());
  if (/^utf-?8$/i.test(trimmed)) out.push("IANA charset utf-8");
  if (/^(accept|authorization|cache-control|content-type|etag|location|user-agent)$/i.test(trimmed)) {
    out.push(`IANA header ${trimmed[0]!.toUpperCase()}${trimmed.slice(1).replace(/-[a-z]/g, (m) => m.toUpperCase())}`);
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
  return u16.length <= vbyte.length && u16.length <= delta.length ? u16 : delta.length <= vbyte.length ? delta : vbyte;
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

/** Shared intern prefixes. WD06 writes the used subset; WD07 bakes this table (append-only). */
const INTERN_PREFIXES = [
  "IANA header ",
  "IANA dns ",
  "IANA charset ",
  "IANA scheme ",
  "IANA method ",
  "IANA language ",
  "IANA media ",
  "HTTP field ",
  "Unicode Block ",
  "Unicode Script ",
  "SPDX ",
  "W3C ",
  "WHATWG ",
  "unsafe, idempotent, RFC ",
  "safe, idempotent, RFC ",
  "unsafe, RFC ",
  "a mail ",
];

/** WD07: baked INTERN_PREFIXES, 1-byte ids, NUL suffixes. Prefix strings are not on disk. */
function encodeBakedIntern(strs: string[]): Uint8Array {
  const w = new Writer();
  w.utf8("WD07");
  w.u32(strs.length);
  const ids = new Uint8Array(strs.length);
  const sufs: string[] = [];
  for (let i = 0; i < strs.length; i++) {
    const s = strs[i]!;
    let id = 0;
    for (let p = 0; p < INTERN_PREFIXES.length; p++) {
      if (s.startsWith(INTERN_PREFIXES[p]!)) {
        id = p + 1;
        break;
      }
    }
    ids[i] = id;
    sufs.push(id ? s.slice(INTERN_PREFIXES[id - 1]!.length) : s);
  }
  w.bytes(ids);
  w.bytes(TE.encode(sufs.join("\0")));
  return w.finish();
}

function decodeBakedIntern(buf: Uint8Array): string[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u32();
  if (!n) return [];
  const ids = buf.subarray(r.off, r.off + n);
  r.off += n;
  const blob = r.utf8(r.end - r.off);
  const parts = blob.split("\0");
  while (parts.length < n) parts.push("");
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = ids[i] ?? 0;
    const suf = parts[i] ?? "";
    out.push(id && INTERN_PREFIXES[id - 1] ? INTERN_PREFIXES[id - 1]! + suf : suf);
  }
  return out;
}

function encodePrefixIntern(strs: string[]): Uint8Array {
  const used = INTERN_PREFIXES.filter((p) => strs.filter((s) => s.startsWith(p)).length >= 4);
  const w = new Writer();
  w.utf8("WD06");
  w.u8(used.length);
  for (const p of used) {
    const b = TE.encode(p);
    w.vbyte(b.length);
    w.bytes(b);
  }
  w.u32(strs.length);
  const ids = new Uint8Array(strs.length);
  const sufs: string[] = [];
  for (let i = 0; i < strs.length; i++) {
    const s = strs[i]!;
    let id = 0;
    for (let p = 0; p < used.length; p++) {
      if (s.startsWith(used[p]!)) {
        id = p + 1;
        break;
      }
    }
    ids[i] = id;
    sufs.push(id ? s.slice(used[id - 1]!.length) : s);
  }
  w.bytes(ids);
  w.bytes(TE.encode(sufs.join("\0")));
  return w.finish();
}

function decodePrefixIntern(buf: Uint8Array): string[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nPref = r.u8();
  const prefs: string[] = [];
  for (let i = 0; i < nPref; i++) prefs.push(r.utf8(r.vbyte()));
  const n = r.u32();
  if (!n) return [];
  const ids = buf.subarray(r.off, r.off + n);
  r.off += n;
  const blob = r.utf8(r.end - r.off);
  const parts = blob.split("\0");
  while (parts.length < n) parts.push("");
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = ids[i] ?? 0;
    const suf = parts[i] ?? "";
    out.push(id && prefs[id - 1] ? prefs[id - 1]! + suf : suf);
  }
  return out;
}

function encodeNulList(strs: string[]): Uint8Array {
  const w = new Writer();
  w.utf8("WD03");
  w.u32(strs.length);
  w.bytes(TE.encode(strs.join("\0")));
  return w.finish();
}

function encodeSlashList(strs: string[]): Uint8Array {
  const groups = new Map<string, string[]>();
  for (const s of strs) {
    const i = s.indexOf("/");
    const top = i > 0 ? s.slice(0, i) : "";
    const sub = i > 0 ? s.slice(i + 1) : s;
    const g = groups.get(top);
    if (g) g.push(sub);
    else groups.set(top, [sub]);
  }
  const w = new Writer();
  w.utf8("SL01");
  const tops = [...groups.keys()].sort();
  w.vbyte(tops.length);
  for (const top of tops) {
    const tb = TE.encode(top);
    w.vbyte(tb.length);
    w.bytes(tb);
    const body = encodePfc(groups.get(top)!);
    w.vbyte(body.length);
    w.bytes(body);
  }
  return w.finish();
}

function decodeSlashList(buf: Uint8Array): string[] {
  if (buf.byteLength < 5 || TD.decode(buf.subarray(0, 4)) !== "SL01") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nTop = r.vbyte();
  const out: string[] = [];
  for (let i = 0; i < nTop; i++) {
    const top = r.utf8(r.vbyte());
    const n = r.vbyte();
    const subs = decodePfc(buf.subarray(r.off, r.off + n));
    r.off += n;
    for (const sub of subs) out.push(top ? `${top}/${sub}` : sub);
  }
  return out;
}

/**
 * CF01: front-coded catalog ids for a joint brotli kernel.
 * Share lengths sit in a homogeneous byte column; suffixes are a sorted NUL blob.
 * PFC vbytes / FSST / BW13 stay out — they win standalone and lose inside KG13.
 */
function encodeFc01(strs: string[], block: number): Uint8Array {
  if (!strs.length || block < 2) return EMPTY_U8;
  const n = strs.length;
  const shares = new Uint8Array(n);
  const sufs: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = strs[i]!;
    if (i % block === 0) {
      sufs[i] = s;
      continue;
    }
    const prev = strs[i - 1]!;
    let share = 0;
    const max = Math.min(prev.length, s.length, 255);
    while (share < max && prev.charCodeAt(share) === s.charCodeAt(share)) share++;
    shares[i] = share;
    sufs[i] = s.slice(share);
  }
  const blob = TE.encode(sufs.join("\0"));
  const w = new Writer();
  w.utf8("CF01");
  w.u32(n);
  w.u8(block);
  w.bytes(shares);
  w.bytes(blob);
  return w.finish();
}

function decodeFc01(buf: Uint8Array): string[] {
  if (buf.byteLength < 10 || TD.decode(buf.subarray(0, 4)) !== "CF01") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u32();
  const block = r.u8() || 16;
  if (!n || r.off + n > r.end) return [];
  const shares = buf.subarray(r.off, r.off + n);
  r.off += n;
  const parts = r.off < r.end ? r.utf8(r.end - r.off).split("\0") : [];
  if (parts.length < n) return [];
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i % block === 0) {
      out[i] = parts[i] ?? "";
      continue;
    }
    out[i] = (out[i - 1] ?? "").slice(0, shares[i]!) + (parts[i] ?? "");
  }
  return out;
}

type DawgNode = { t: boolean; e: Map<number, DawgNode> };

/** Minimized byte DAWG. Raw adjacency for the joint brotli kernel — not an inner codec. */
function encodeDawg(strs: string[]): Uint8Array {
  if (!strs.length || strs.length > 65535) return EMPTY_U8;
  const root: DawgNode = { t: false, e: new Map() };
  for (const s of strs) {
    const b = TE.encode(s);
    let n = root;
    for (let i = 0; i < b.length; i++) {
      const c = b[i]!;
      let ch = n.e.get(c);
      if (!ch) {
        ch = { t: false, e: new Map() };
        n.e.set(c, ch);
      }
      n = ch;
    }
    n.t = true;
  }
  const reg = new Map<string, DawgNode>();
  const rep = new Map<DawgNode, DawgNode>();
  const frozenId = new Map<DawgNode, number>();
  const freeze = (n: DawgNode) => {
    if (rep.has(n)) return;
    const nxt = new Map<number, DawgNode>();
    for (const [c, ch] of n.e) {
      freeze(ch);
      nxt.set(c, rep.get(ch)!);
    }
    n.e = nxt;
    const edges = [...nxt.entries()].sort((a, b) => a[0] - b[0]);
    const key = `${n.t ? 1 : 0}:${edges.map(([c, ch]) => `${c},${frozenId.get(ch)}`).join(";")}`;
    const hit = reg.get(key);
    if (hit) {
      rep.set(n, hit);
      return;
    }
    frozenId.set(n, frozenId.size);
    reg.set(key, n);
    rep.set(n, n);
  };
  freeze(root);
  const r0 = rep.get(root)!;
  const ordered: DawgNode[] = [];
  const idOf = new Map<DawgNode, number>();
  const q: DawgNode[] = [r0];
  idOf.set(r0, 0);
  while (q.length) {
    const n = q.shift()!;
    ordered.push(n);
    const edges = [...n.e.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, ch] of edges) {
      if (idOf.has(ch)) continue;
      idOf.set(ch, idOf.size);
      q.push(ch);
    }
  }
  if (ordered.length > 65535) return EMPTY_U8;
  const terms = new Uint8Array((ordered.length + 7) >> 3);
  const counts = new Uint8Array(ordered.length);
  const chars: number[] = [];
  const kids: number[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const n = ordered[i]!;
    if (n.t) terms[i >> 3]! |= 1 << (i & 7);
    const edges = [...n.e.entries()].sort((a, b) => a[0] - b[0]);
    if (edges.length > 255) return EMPTY_U8;
    counts[i] = edges.length;
    for (const [c, ch] of edges) {
      chars.push(c);
      kids.push(idOf.get(ch)!);
    }
  }
  const w = new Writer();
  w.utf8("DG01");
  w.vbyte(ordered.length);
  w.vbyte(strs.length);
  w.bytes(terms);
  w.bytes(counts);
  w.bytes(Uint8Array.from(chars));
  let prev = 0;
  for (const k of kids) {
    w.vbyte(zig(k - prev));
    prev = k;
  }
  const walked = dawgWalk(ordered.length, strs.length, terms, counts, Uint8Array.from(chars), kids);
  let perm = false;
  if (walked.length !== strs.length) return EMPTY_U8;
  for (let i = 0; i < strs.length; i++) if (walked[i] !== strs[i]) perm = true;
  w.u8(perm ? 1 : 0);
  if (perm) {
    const idx = new Map<string, number>();
    for (let i = 0; i < strs.length; i++) idx.set(strs[i]!, i);
    let p = 0;
    for (const s of walked) {
      const i = idx.get(s);
      if (i === undefined) return EMPTY_U8;
      w.vbyte(zig(i - p));
      p = i;
    }
  }
  return w.finish();
}

function dawgWalk(
  nNodes: number,
  nStrs: number,
  terms: Uint8Array,
  counts: Uint8Array,
  chars: Uint8Array,
  kids: number[],
): string[] {
  const edges: [number, number][][] = Array.from({ length: nNodes }, () => []);
  let ei = 0;
  for (let i = 0; i < nNodes; i++) {
    const k = counts[i]!;
    for (let j = 0; j < k; j++) {
      edges[i]!.push([chars[ei]!, kids[ei]!]);
      ei++;
    }
  }
  const chunks: Uint8Array[] = [];
  const walk = (id: number, path: number[]) => {
    if (terms[id >> 3]! & (1 << (id & 7))) chunks.push(Uint8Array.from(path));
    if (chunks.length > nStrs) return;
    for (const [c, ch] of edges[id]!) {
      path.push(c);
      walk(ch, path);
      path.pop();
    }
  };
  walk(0, []);
  return chunks.map((b) => TD.decode(b));
}

function decodeDawg(buf: Uint8Array): string[] {
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== "DG01") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nNodes = r.vbyte();
  const nStrs = r.vbyte();
  if (!nNodes || !nStrs || nNodes > 65535) return [];
  const tlen = (nNodes + 7) >> 3;
  if (r.off + tlen + nNodes > r.end) return [];
  const terms = buf.subarray(r.off, r.off + tlen);
  r.off += tlen;
  const counts = buf.subarray(r.off, r.off + nNodes);
  r.off += nNodes;
  let nEdges = 0;
  for (let i = 0; i < nNodes; i++) nEdges += counts[i]!;
  if (r.off + nEdges > r.end) return [];
  const chars = buf.subarray(r.off, r.off + nEdges);
  r.off += nEdges;
  const kids: number[] = [];
  let prev = 0;
  for (let i = 0; i < nEdges; i++) {
    prev += unzig(r.vbyte());
    if (prev < 0 || prev >= nNodes) return [];
    kids.push(prev);
  }
  const walked = dawgWalk(nNodes, nStrs, terms, counts, chars, kids);
  if (walked.length !== nStrs) return [];
  if (r.off >= r.end) return walked;
  const perm = r.u8();
  if (!perm) return walked;
  const out: string[] = new Array(nStrs);
  prev = 0;
  for (let i = 0; i < nStrs; i++) {
    prev += unzig(r.vbyte());
    if (prev < 0 || prev >= nStrs || out[prev] !== undefined) return [];
    out[prev] = walked[i]!;
  }
  for (let i = 0; i < nStrs; i++) if (out[i] === undefined) return [];
  return out;
}

/** Hyphen/slash token intern. Vocab + id sequences; brotli sees both. */
function encodeHt01(strs: string[]): Uint8Array {
  if (!strs.length) return EMPTY_U8;
  const vocabSet = new Set<string>();
  const seqs: string[][] = [];
  for (const s of strs) {
    const parts = s.split(/[-/]/);
    if (!parts.length || parts.some((p) => !p.length || p.length > 64)) return EMPTY_U8;
    seqs.push(parts);
    for (const p of parts) vocabSet.add(p);
  }
  const vocab = [...vocabSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (vocab.length > 65535) return EMPTY_U8;
  const idOf = new Map(vocab.map((t, i) => [t, i]));
  const w = new Writer();
  w.utf8("HT01");
  w.u16(strs.length);
  w.u16(vocab.length);
  w.bytes(TE.encode(vocab.join("\0")));
  w.u8(0);
  const wide = vocab.length > 255 ? 1 : 0;
  w.u8(wide);
  for (const parts of seqs) {
    if (parts.length > 255) return EMPTY_U8;
    w.u8(parts.length);
    for (const p of parts) {
      const id = idOf.get(p)!;
      if (wide) w.u16(id);
      else w.u8(id);
    }
  }
  return w.finish();
}

function decodeHt01(buf: Uint8Array): string[] {
  if (buf.byteLength < 10 || TD.decode(buf.subarray(0, 4)) !== "HT01") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u16();
  const nv = r.u16();
  if (!n || !nv) return [];
  const start = r.off;
  while (r.off < r.end && buf[r.off] !== 0) r.off++;
  const blob = TD.decode(buf.subarray(start, r.off));
  if (r.off < r.end && buf[r.off] === 0) r.off++;
  const vocab = blob.split("\0");
  if (vocab.length !== nv) return [];
  const wide = r.u8();
  const out: string[] = [];
  for (let i = 0; i < n && r.off < r.end; i++) {
    const k = r.u8();
    const parts: string[] = [];
    for (let j = 0; j < k && r.off < r.end; j++) {
      const id = wide ? r.u16() : r.u8();
      parts.push(vocab[id] ?? "");
    }
    out.push(parts.join("-"));
  }
  return out.length === n ? out : [];
}

/** Longest-first wiki object templates. Decoder table — append-only. */
const WIKI_ROLES = [
  "the ISO 3166-1 alpha-2 of ",
  "the head of government of ",
  "the head of state of ",
  "the prime minister of ",
  "an official language of ",
  "a national language of ",
  "the largest city of ",
  "the legislature of ",
  "the official name of ",
  "the president of ",
  "the currency of ",
  "the capital of ",
  "the anthem of ",
  "the motto of ",
  "a demonym of ",
  "a city in ",
  "a federal parliamentary constitutional monarchy",
  "a unitary parliamentary constitutional monarchy",
  "a unitary semi-presidential republic",
  "a federal presidential republic",
  "a unitary presidential republic",
  "a federal parliamentary republic",
];

function wikiRoleOf(o: string): { ri: number; entity: string } | undefined {
  for (let i = 0; i < WIKI_ROLES.length; i++) {
    const role = WIKI_ROLES[i]!;
    if (o === role) return { ri: i, entity: "" };
    if (!o.startsWith(role)) continue;
    const entity = o.slice(role.length);
    if (entity.length >= 2 && entity.length <= 72 && !entity.includes("\0")) return { ri: i, entity };
  }
  return;
}

function encodeWikiWt01(parsed: { s: string; ri: number; e: string }[]): Uint8Array {
  const subj = [...new Set(parsed.map((p) => p.s))];
  const ents = [...new Set(parsed.map((p) => p.e))];
  if (subj.length > 255 || ents.length > 255) return EMPTY_U8;
  const sOf = new Map(subj.map((s, i) => [s, i]));
  const eOf = new Map(ents.map((s, i) => [s, i]));
  const sb = encodeIntern(subj);
  const eb = encodeIntern(ents);
  const w = new Writer();
  w.utf8("WT01");
  w.u16(parsed.length);
  w.u8(subj.length);
  w.u8(ents.length);
  w.vbyte(sb.length);
  w.bytes(sb);
  w.vbyte(eb.length);
  w.bytes(eb);
  const roles = new Uint8Array(parsed.length);
  const sids = new Uint8Array(parsed.length);
  const eids = new Uint8Array(parsed.length);
  for (let i = 0; i < parsed.length; i++) {
    roles[i] = parsed[i]!.ri;
    sids[i] = sOf.get(parsed[i]!.s)!;
    eids[i] = eOf.get(parsed[i]!.e)!;
  }
  w.bytes(roles);
  w.bytes(sids);
  w.bytes(eids);
  return w.finish();
}

const WIKI_ISO = 0x8000;

function encodeWikiWt02(parsed: { s: string; ri: number; e: string }[]): Uint8Array {
  iso2Maps();
  const subIntern: string[] = [];
  const entIntern: string[] = [];
  const sOf = new Map<string, number>();
  const eOf = new Map<string, number>();
  const subCol = new Uint16Array(parsed.length);
  const entCol = new Uint16Array(parsed.length);
  for (let i = 0; i < parsed.length; i++) {
    const s = parsed[i]!.s;
    const e = parsed[i]!.e;
    const sc = NAME_TO_ISO2!.get(s);
    if (sc && ISO2_TO_NAME!.get(sc) === s) subCol[i] = WIKI_ISO | isoIndex(sc);
    else {
      let id = sOf.get(s);
      if (id === undefined) {
        if (subIntern.length > 255) return EMPTY_U8;
        id = subIntern.length;
        subIntern.push(s);
        sOf.set(s, id);
      }
      subCol[i] = id;
    }
    if (!e) {
      entCol[i] = 0xffff;
      continue;
    }
    const ec = NAME_TO_ISO2!.get(e);
    if (ec && ISO2_TO_NAME!.get(ec) === e) entCol[i] = WIKI_ISO | isoIndex(ec);
    else {
      let id = eOf.get(e);
      if (id === undefined) {
        if (entIntern.length > 255) return EMPTY_U8;
        id = entIntern.length;
        entIntern.push(e);
        eOf.set(e, id);
      }
      entCol[i] = id;
    }
  }
  const sb = subIntern.length ? encodeIntern(subIntern) : EMPTY_U8;
  const eb = entIntern.length ? encodeIntern(entIntern) : EMPTY_U8;
  const w = new Writer();
  w.utf8("WT02");
  w.u16(parsed.length);
  w.u8(subIntern.length);
  w.u8(entIntern.length);
  w.vbyte(sb.length);
  w.bytes(sb);
  w.vbyte(eb.length);
  w.bytes(eb);
  const roles = new Uint8Array(parsed.length);
  for (let i = 0; i < parsed.length; i++) roles[i] = parsed[i]!.ri;
  w.bytes(roles);
  for (let i = 0; i < parsed.length; i++) w.u16(subCol[i]!);
  for (let i = 0; i < parsed.length; i++) w.u16(entCol[i]!);
  return w.finish();
}

function encodeWiki(rows: { s: string; o: string }[]): Uint8Array {
  if (rows.length < 8 || rows.length > 65535) return EMPTY_U8;
  const parsed: { s: string; ri: number; e: string }[] = [];
  for (const row of rows) {
    const w = wikiRoleOf(row.o);
    if (!w) return EMPTY_U8;
    parsed.push({ s: row.s, ri: w.ri, e: w.entity });
  }
  const cands = [encodeWikiWt01(parsed), encodeWikiWt02(parsed)].filter((b) => b.byteLength);
  if (!cands.length) return EMPTY_U8;
  let best = cands[0]!;
  let bestBr = brotliRawLen(best, BROTLI_QUALITY);
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i]!;
    const br = brotliRawLen(c, BROTLI_QUALITY);
    if (br < bestBr || (br === bestBr && c.byteLength < best.byteLength)) {
      best = c;
      bestBr = br;
    }
  }
  return best;
}

function wikiName(code: number, intern: string[]): string {
  if (code === 0xffff) return "";
  if (code & WIKI_ISO) {
    iso2Maps();
    return ISO2_TO_NAME!.get(isoFromIndex(code & 0x7fff)) ?? "";
  }
  return intern[code] ?? "";
}

function decodeWiki(buf: Uint8Array): PackFact[] {
  if (buf.byteLength < 10) return [];
  const mag = TD.decode(buf.subarray(0, 4));
  if (mag !== "WT01" && mag !== "WT02") return [];
  const wt02 = mag === "WT02";
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u16();
  const ns = r.u8();
  const ne = r.u8();
  if (!n) return [];
  const slen = r.vbyte();
  if (r.off + slen > r.end) return [];
  const subj = slen ? decodeIntern(buf.subarray(r.off, r.off + slen)) : [];
  r.off += slen;
  const elen = r.vbyte();
  if (r.off + elen > r.end) return [];
  const ents = elen ? decodeIntern(buf.subarray(r.off, r.off + elen)) : [];
  r.off += elen;
  if (subj.length < ns || ents.length < ne) return [];
  if (r.off + n > r.end) return [];
  const roles = buf.subarray(r.off, r.off + n);
  r.off += n;
  const out: PackFact[] = [];
  if (wt02) {
    if (r.off + n * 4 > r.end) return [];
    const subs: number[] = [];
    const entc: number[] = [];
    for (let i = 0; i < n; i++) subs.push(r.u16());
    for (let i = 0; i < n; i++) entc.push(r.u16());
    for (let i = 0; i < n; i++) {
      const role = WIKI_ROLES[roles[i]!];
      if (!role) return [];
      const s = wikiName(subs[i]!, subj);
      const e = wikiName(entc[i]!, ents);
      if (!s) return [];
      out.push({ s, p: "is", o: role + e, e: "", url: "" });
    }
    return out;
  }
  if (r.off + n * 2 > r.end) return [];
  const sids = buf.subarray(r.off, r.off + n);
  r.off += n;
  const eids = buf.subarray(r.off, r.off + n);
  for (let i = 0; i < n; i++) {
    const role = WIKI_ROLES[roles[i]!];
    if (!role) return [];
    const s = subj[sids[i]!] ?? "";
    const e = ents[eids[i]!] ?? "";
    if (!s) return [];
    out.push({ s, p: "is", o: role + e, e: "", url: "" });
  }
  return out;
}

function encodeCatList(strs: string[]): Uint8Array {
  if (!strs.length) return EMPTY_U8;
  const cands = [
    encodeNulList(strs),
    encodeCatListGrouped(strs),
    encodeFc01(strs, 16),
    encodeFc01(strs, 32),
    encodeFc01(strs, 64),
    encodeFc01(strs, 128),
    encodeDawg(strs),
  ];
  if (strs.every((s) => !s.includes("/"))) {
    const ht = encodeHt01(strs);
    if (ht.byteLength) cands.push(ht);
  }
  if (strs.some((s) => s.includes("/"))) cands.push(encodeSlashList(strs));
  let best = cands[0]!;
  let bestBr = brotliRawLen(best, BROTLI_QUALITY);
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i]!;
    if (!c.byteLength) continue;
    const br = brotliRawLen(c, BROTLI_QUALITY);
    if (br < bestBr || (br === bestBr && c.byteLength < best.byteLength)) {
      best = c;
      bestBr = br;
    }
  }
  return best;
}

/** IANA top-level types. Decoder enum — not a closed-table string dump. */
const MEDIA_TREES = [
  "application",
  "audio",
  "font",
  "haptics",
  "image",
  "message",
  "model",
  "multipart",
  "text",
  "video",
] as const;
const MEDIA_TREE_OF: Record<string, number> = Object.fromEntries(MEDIA_TREES.map((t, i) => [t, i]));
/** Structured +suffixes. 0 = none on the plus nibble stream. */
const MEDIA_PLUS = ["xml", "json", "zip", "cbor", "jwt", "yaml", "cose", "wbxml", "gzip"] as const;
const MEDIA_PLUS_OF: Record<string, number> = Object.fromEntries(MEDIA_PLUS.map((t, i) => [t, i + 1]));
/** Vendor stems after vnd./prs./x-. Decoder enum — longest first. Official IANA vnd. tokens. */
const MEDIA_STEMS = [
  "openxmlformats-officedocument.wordprocessingml.",
  "openxmlformats-officedocument.spreadsheetml.",
  "openxmlformats-officedocument.presentationml.",
  "openxmlformats-officedocument.drawingml.",
  "openxmlformats-officedocument.",
  "openxmlformats-package.",
  "collabio.xodocuments.",
  "sealedmedia.softseal.",
  "oasis.opendocument.text-",
  "oasis.opendocument.",
  "radisys.msml-dialog-",
  "radisys.msml-audit-",
  "radisys.msml-",
  "motorola.flexsuite.",
  "shana.informed.",
  "crick.clicker.",
  "apache.thrift.",
  "as207960.vas.",
  "valve.source.",
  "ms-powerpoint.",
  "ms-playready.",
  "nokia.n-gage.",
  "sealedmedia.",
  "fujifilm.fb.",
  "ims.lti.v2.",
  "3gpp-prose-",
  "3gpp.mcvideo-",
  "3gpp.mcdata-",
  "3gpp.mcptt-",
  "3gpp.seal-",
  "3gpp.pic-bw-",
  "marlin.drm.",
  "evolv.ecig.",
  "emergencycalldata.",
  "opendocument.",
  "oma.bcast.",
  "oma-scws-",
  "iptvforum.",
  "ntt-local.",
  "blockfact.",
  "cncf.helm.",
  "microsoft.",
  "ms-windows.",
  "collabio.",
  "as207960.",
  "fujifilm.",
  "geogebra.",
  "noblenet-",
  "novadigm.",
  "veraison.",
  "ms-excel.",
  "ms-wmdrm.",
  "iptc.g2.",
  "implied-",
  "fujitsu.",
  "ims.lti.",
  "bbf.usp.",
  "wolfram.",
  "dvb.notif-ia-",
  "dvb.notif-",
  "afpc.modca-",
  "etsi.iptvsad-",
  "afpc.foca-",
  "3gpp.pic-",
  "yamaha.hv-",
  "fujixerox.",
  "japannet-",
  "gentoo.",
  "groove-",
  "mobius.",
  "apache.",
  "ecowin.",
  "marlin.",
  "airzip.",
  "gov.sk.",
  "lotus-",
  "adobe.",
  "apple.",
  "crick.",
  "epson.",
  "xmpie.",
  "shana.",
  "evolv.",
  "omads-",
  "valve.",
  "nuera.",
  "3gpp2.",
  "3gpp.",
  "3gpp-",
  "motorola.",
  "radisys.",
  "yamaha.",
  "nokia.",
  "oasis.",
  "etsi.",
  "oma.cab-",
  "oma.poc.",
  "oma.",
  "oma-",
  "dvb.",
  "ms-",
  "sealed.",
  "uplanet.",
  "oipf.",
  "dolby.",
  "wap.",
  "afpc.",
  "dece.",
  "alto.",
  "cose.",
  "tamp.",
  "mcvideo-",
  "mcptt-",
  "mcdata-",
  "syncml.",
  "iptc.",
  "cups-",
  "ipld.",
  "nato.",
  "cmmf-",
  "cncf.",
  "fdsn.",
  "osgi.",
  "ims.",
  "kde.",
  "ibm.",
  "ntt-",
  "uic.",
  "wfa.",
  "bbf.",
  "dtg.",
  "gov.",
  "oai.",
  "pwg-",
  "sss-",
  "cns.",
  "hp-",
  "wv.",
] as const;
const CT01_MAGIC = "CT01";
const HR01_MAGIC = "HR01";
const HR01_HTTP_FIELD = 0xffff;

function extrasOf(have: readonly string[], uni: readonly string[]): string[] {
  const set = new Set(uni);
  return have.filter((s) => !set.has(s));
}

/** Extra-mode: uni∪extras, unless extras already sit in uni (old KEEP leftover lists). */
function closedExtras(uni: readonly string[], extra: readonly string[], keep?: readonly string[]): string[] {
  if (!extra.length) return uni.slice();
  const uniSet = new Set(uni);
  /** Old KEEP extras that now overlap an expanded codec tab stay KEEP∪extras, not the full tab. */
  if (keep && extra.some((e) => uniSet.has(e))) return mergeSortedUnique(keep, extra);
  return mergeSortedUnique(uni, extra);
}

function isSupersetSorted(have: readonly string[], uni: readonly string[]): boolean {
  if (!uni.length || have.length < uni.length) return false;
  const set = new Set(have);
  for (const s of uni) if (!set.has(s)) return false;
  return true;
}

function isSubsetOf(have: readonly string[], uni: readonly string[]): boolean {
  if (!have.length || !uni.length || have.length >= uni.length) return false;
  const set = new Set(uni);
  for (const s of have) if (!set.has(s)) return false;
  return true;
}

const SB01_MAGIC = "SB01";
/** W3C TR year-directory leftovers (`/TR/1998/` …). Official URL pattern, not a dump-fitted vocab. */
const YR01_MAGIC = "YR01";
const YR01_BASE = 1990;
const YR01_SPAN = 64;

function encodeSubsetBits(have: readonly string[], uni: readonly string[]): Uint8Array {
  const set = new Set(have);
  const bits = new Uint8Array((uni.length + 7) >> 3);
  for (let i = 0; i < uni.length; i++) {
    if (set.has(uni[i]!)) bits[i >> 3]! |= 1 << (i & 7);
  }
  const w = new Writer();
  w.utf8(SB01_MAGIC);
  w.u16(uni.length);
  w.bytes(bits);
  return w.finish();
}

function yearsOf(strs: readonly string[]): number[] | undefined {
  if (!strs.length) return;
  const ys: number[] = [];
  for (const s of strs) {
    if (s.length !== 4) return;
    const y = Number(s);
    if (y !== y || y < YR01_BASE || y >= YR01_BASE + YR01_SPAN || String(y) !== s) return;
    ys.push(y);
  }
  return ys;
}

function encodeYearBits(years: number[]): Uint8Array {
  const bits = new Uint8Array((YR01_SPAN + 7) >> 3);
  for (const y of years) {
    const i = y - YR01_BASE;
    bits[i >> 3]! |= 1 << (i & 7);
  }
  const w = new Writer();
  w.utf8(YR01_MAGIC);
  w.u16(YR01_BASE);
  w.u8(YR01_SPAN);
  w.bytes(bits);
  return w.finish();
}

function decodeYearBits(buf: Uint8Array): string[] | undefined {
  if (buf.byteLength < 7 || TD.decode(buf.subarray(0, 4)) !== YR01_MAGIC) return;
  const base = buf[4]! | (buf[5]! << 8);
  const span = buf[6]!;
  const need = 7 + ((span + 7) >> 3);
  if (!span || buf.byteLength < need) return;
  const out: string[] = [];
  for (let i = 0; i < span; i++) {
    if (buf[7 + (i >> 3)]! & (1 << (i & 7))) out.push(String(base + i));
  }
  return out;
}

function decodeSubsetRest(buf: Uint8Array): string[] {
  const years = decodeYearBits(buf);
  if (years) return years;
  return decodeCatList(buf);
}

/** SB01 of names in `uni`, then leftover extras that the official tab does not own. */
function encodeSubsetMixed(have: readonly string[], uni: readonly string[]): Uint8Array {
  const uniSet = new Set(uni);
  const inside: string[] = [];
  const extra: string[] = [];
  for (const s of have) (uniSet.has(s) ? inside : extra).push(s);
  const bits = encodeSubsetBits(inside, uni);
  if (!extra.length) return bits;
  const years = yearsOf(extra);
  const rest = years ? encodeYearBits(years) : encodeCatList(extra);
  if (!rest.byteLength) return bits;
  const out = new Uint8Array(bits.byteLength + rest.byteLength);
  out.set(bits);
  out.set(rest, bits.byteLength);
  return out;
}

function decodeSubsetBits(buf: Uint8Array, uni: readonly string[]): string[] | undefined {
  if (buf.byteLength < 6 || TD.decode(buf.subarray(0, 4)) !== SB01_MAGIC) return;
  const n = buf[4]! | (buf[5]! << 8);
  if (n !== uni.length) return;
  const need = 6 + ((n + 7) >> 3);
  if (buf.byteLength < need) return;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (buf[6 + (i >> 3)]! & (1 << (i & 7))) out.push(uni[i]!);
  }
  return out;
}

function mergeSortedUnique(a: readonly string[], b: readonly string[]): string[] {
  if (!b.length) return a.slice();
  if (!a.length) return b.slice();
  const set = new Set(a);
  for (const s of b) set.add(s);
  return [...set].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function encodeU8U16Rle(vals: number[]): Uint8Array {
  const runs: [number, number][] = [];
  for (const v of vals) {
    const last = runs[runs.length - 1];
    if (last && last[0] === v && last[1] < 65535) last[1]++;
    else runs.push([v, 1]);
  }
  if (runs.length > 255) return EMPTY_U8;
  const w = new Writer();
  w.u8(runs.length);
  for (const [v, n] of runs) {
    w.u8(v);
    w.u16(n);
  }
  return w.finish();
}

function decodeU8U16Rle(r: Reader, expect: number): number[] {
  const nRuns = r.u8();
  const out: number[] = [];
  for (let i = 0; i < nRuns; i++) {
    const v = r.u8();
    const n = r.u16();
    for (let k = 0; k < n && out.length < expect; k++) out.push(v);
  }
  while (out.length < expect) out.push(0);
  return out;
}

function encodeNibbleHits(n: number, vals: number[]): { bits: Uint8Array; nib: Uint8Array; count: number } {
  const bits = new Uint8Array((n + 7) >> 3);
  const hit: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!vals[i]) continue;
    bits[i >> 3]! |= 1 << (i & 7);
    hit.push(vals[i]!);
  }
  const nib = new Uint8Array((hit.length + 1) >> 1);
  for (let i = 0; i < hit.length; i++) {
    if (i & 1) nib[i >> 1]! |= (hit[i]! & 15) << 4;
    else nib[i >> 1] = hit[i]! & 15;
  }
  return { bits, nib, count: hit.length };
}

/**
 * MT02/MT03: typed media extras. Tree + registry (vnd/prs/x) as RLE, plus-suffix
 * bitset + nibble enum, optional vendor stems (MT03), CF01/NUL remainders.
 * Closed KEEP strings stay in synth.
 */
function encodeMt02(strs: string[]): Uint8Array {
  return encodeMtBody(strs, false);
}

function encodeMtBody(strs: string[], withStem: boolean, remKind: "auto" | "nul" | "fc" = "auto"): Uint8Array {
  if (!strs.length) return EMPTY_U8;
  const n = strs.length;
  if (n > 65535) return EMPTY_U8;
  const trees = new Array<number>(n);
  const regs = new Array<number>(n);
  const stems = new Array<number>(n);
  const plus = new Array<number>(n);
  const rems = new Array<string>(n);
  const otherPlus: string[] = [];
  let typed = 0;
  let stemmed = 0;
  for (let i = 0; i < n; i++) {
    const s = strs[i]!;
    const sl = s.indexOf("/");
    const top = sl > 0 ? s.slice(0, sl) : "";
    let rest = sl > 0 ? s.slice(sl + 1) : s;
    const ti = MEDIA_TREE_OF[top];
    trees[i] = ti === undefined ? 15 : ti;
    if (trees[i] !== 15) typed++;
    let r = 0;
    if (rest.startsWith("vnd.")) {
      r = 1;
      rest = rest.slice(4);
    } else if (rest.startsWith("prs.")) {
      r = 2;
      rest = rest.slice(4);
    } else if (rest.startsWith("x-") || rest.startsWith("x.")) {
      r = 3;
      rest = rest.slice(1);
    }
    regs[i] = r;
    let pv = 0;
    const plusAt = rest.lastIndexOf("+");
    if (plusAt > 0 && trees[i] !== 15) {
      const suf = rest.slice(plusAt + 1);
      const id = MEDIA_PLUS_OF[suf];
      if (id !== undefined) {
        pv = id;
        rest = rest.slice(0, plusAt);
      } else if (suf.length >= 2 && suf.length < 24 && !suf.includes("/")) {
        pv = 15;
        otherPlus.push(suf);
        rest = rest.slice(0, plusAt);
      }
    }
    plus[i] = pv;
    let st = 0;
    if (withStem && trees[i] !== 15) {
      let bestK = -1;
      let bestLen = 0;
      for (let k = 0; k < MEDIA_STEMS.length; k++) {
        const stem = MEDIA_STEMS[k]!;
        if (stem.length <= bestLen || !rest.startsWith(stem)) continue;
        bestK = k;
        bestLen = stem.length;
      }
      if (bestK >= 0) {
        st = bestK + 1;
        rest = rest.slice(bestLen);
        stemmed++;
      }
    }
    stems[i] = st;
    rems[i] = trees[i] === 15 ? s : rest;
  }
  if (typed * 2 < n) return EMPTY_U8;
  if (withStem && !stemmed) return EMPTY_U8;
  const remEnc =
    remKind === "nul" ? encodeNulList(rems) : remKind === "fc" ? encodeFc01(rems, 128) : encodeCatList(rems);
  const treeR = encodeU8U16Rle(trees);
  const regR = encodeU8U16Rle(regs);
  if (!treeR.byteLength || !regR.byteLength) return EMPTY_U8;
  const plusHits = encodeNibbleHits(n, plus);
  const op = otherPlus.length ? TE.encode(otherPlus.join("\0")) : EMPTY_U8;
  const ids: number[] = [];
  const bits = new Uint8Array((n + 7) >> 3);
  if (withStem) {
    for (let i = 0; i < n; i++) {
      if (!stems[i]) continue;
      bits[i >> 3]! |= 1 << (i & 7);
      ids.push(stems[i]!);
    }
  }
  const rawIds = Uint8Array.from(ids);
  const w = new Writer();
  w.utf8(withStem ? "MT03" : "MT02");
  w.u16(n);
  w.bytes(treeR);
  w.bytes(regR);
  if (withStem) {
    w.bytes(bits);
    w.vbyte(ids.length);
    w.bytes(rawIds);
  }
  w.bytes(plusHits.bits);
  w.vbyte(plusHits.count);
  w.bytes(plusHits.nib);
  w.vbyte(op.length);
  w.bytes(op);
  w.bytes(remEnc);
  return w.finish();
}

function decodeMt02(buf: Uint8Array): string[] {
  if (buf.byteLength < 8) return [];
  const mag = TD.decode(buf.subarray(0, 4));
  const withStem = mag === "MT03";
  if (mag !== "MT02" && !withStem) return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u16();
  if (!n) return [];
  const trees = decodeU8U16Rle(r, n);
  const regs = decodeU8U16Rle(r, n);
  const bitLen = (n + 7) >> 3;
  let hs: Uint8Array = EMPTY_U8;
  let nStem = 0;
  let stemsCol: number[] | undefined;
  if (withStem) {
    if (r.off + bitLen > r.end) return [];
    hs = buf.subarray(r.off, r.off + bitLen);
    r.off += bitLen;
    nStem = r.vbyte();
    if (r.off + nStem > r.end) return [];
    stemsCol = [...buf.subarray(r.off, r.off + nStem)];
    r.off += nStem;
  }
  if (r.off + bitLen > r.end) return [];
  const hp = buf.subarray(r.off, r.off + bitLen);
  r.off += bitLen;
  const nPlus = r.vbyte();
  const nibLen = (nPlus + 1) >> 1;
  if (r.off + nibLen > r.end) return [];
  const pnib = buf.subarray(r.off, r.off + nibLen);
  r.off += nibLen;
  const opLen = r.vbyte();
  if (r.off + opLen > r.end) return [];
  const otherPlus = opLen ? r.utf8(opLen).split("\0") : [];
  const rems = decodeCatList(buf.subarray(r.off));
  if (rems.length < n) return [];
  const out: string[] = new Array(n);
  let pi = 0;
  let si = 0;
  let oi = 0;
  for (let i = 0; i < n; i++) {
    const tree = trees[i] ?? 15;
    if (tree === 15) {
      out[i] = rems[i] ?? "";
      if (hp[i >> 3]! & (1 << (i & 7))) pi++;
      if (withStem && hs[i >> 3]! & (1 << (i & 7))) si++;
      continue;
    }
    let rest = rems[i] ?? "";
    if (withStem && hs[i >> 3]! & (1 << (i & 7))) {
      const id = stemsCol && si < nStem ? (stemsCol[si] ?? 0) : 0;
      si++;
      if (id > 0 && MEDIA_STEMS[id - 1]) rest = MEDIA_STEMS[id - 1] + rest;
    }
    const reg = regs[i] ?? 0;
    if (reg === 1) rest = `vnd.${rest}`;
    else if (reg === 2) rest = `prs.${rest}`;
    else if (reg === 3) rest = `x${rest}`;
    if (hp[i >> 3]! & (1 << (i & 7))) {
      const nib = pi < nPlus ? (pi & 1 ? (pnib[pi >> 1]! >> 4) & 15 : pnib[pi >> 1]! & 15) : 0;
      pi++;
      if (nib === 15) rest += `+${otherPlus[oi++] ?? ""}`;
      else if (nib > 0 && MEDIA_PLUS[nib - 1]) rest += `+${MEDIA_PLUS[nib - 1]}`;
    }
    out[i] = `${MEDIA_TREES[tree] ?? "application"}/${rest}`;
  }
  return out;
}

function encodeMediaList(strs: string[]): Uint8Array {
  if (!strs.length) return EMPTY_U8;
  const cands = [encodeCatList(strs), encodeMt02(strs), encodeMtBody(strs, true)];
  let best = cands[0]!;
  let bestBr = brotliRawLen(best, BROTLI_QUALITY);
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i]!;
    if (!c.byteLength) continue;
    const br = brotliRawLen(c, BROTLI_QUALITY);
    if (br < bestBr || (br === bestBr && c.byteLength < best.byteLength)) {
      best = c;
      bestBr = br;
    }
  }
  return best;
}

/** Group strings by first token (slash or hyphen) then NUL-join suffixes. */
function encodeCatListGrouped(strs: string[]): Uint8Array {
  const groups = new Map<string, string[]>();
  for (const s of strs) {
    const slash = s.indexOf("/");
    const dash = s.indexOf("-");
    let cut = -1;
    if (slash > 0) cut = slash;
    else if (dash > 0) cut = dash;
    const top = cut > 0 ? s.slice(0, cut + (s[cut] === "/" ? 1 : 0)) : "";
    const rest = cut > 0 ? s.slice(top.length) : s;
    const g = groups.get(top);
    if (g) g.push(rest);
    else groups.set(top, [rest]);
  }
  const w = new Writer();
  w.utf8("GL01");
  const tops = [...groups.keys()].sort();
  w.vbyte(tops.length);
  for (const top of tops) {
    const tb = TE.encode(top);
    w.vbyte(tb.length);
    w.bytes(tb);
    const blob = TE.encode(groups.get(top)!.join("\0"));
    w.vbyte(blob.length);
    w.bytes(blob);
  }
  return w.finish();
}

function decodeCatListGrouped(buf: Uint8Array): string[] {
  if (buf.byteLength < 5 || TD.decode(buf.subarray(0, 4)) !== "GL01") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nTop = r.vbyte();
  const out: string[] = [];
  for (let i = 0; i < nTop; i++) {
    const top = r.utf8(r.vbyte());
    const n = r.vbyte();
    const blob = r.utf8(n);
    for (const rest of blob.split("\0")) out.push(top + rest);
  }
  return out;
}

function encodeCatIds(media: string[], spdx: string[], scheme: string[], slugs: string[]): Uint8Array {
  const ci02 = encodeCatIds02(media, spdx, scheme, slugs);
  const w = new Writer();
  w.utf8("CI01");
  w.u16(media.length);
  w.u16(spdx.length);
  w.u16(scheme.length);
  w.u16(slugs.length);
  w.bytes(encodeCatList([...media, ...spdx, ...scheme, ...slugs]));
  const ci01 = w.finish();
  if (ci02.byteLength && ci02.byteLength < ci01.byteLength) return ci02;
  return ci01;
}

/** CI02: length-prefixed per-catalog encodings so media can be MT02 extras-only. */
function encodeCatIds02(media: string[], spdx: string[], scheme: string[], slugs: string[]): Uint8Array {
  const parts = [encodeMediaList(media), encodeCatList(spdx), encodeCatList(scheme), encodeCatList(slugs)];
  if (parts.some((p) => p.byteLength > 65535)) return EMPTY_U8;
  const w = new Writer();
  w.utf8("CI02");
  w.u16(media.length);
  w.u16(spdx.length);
  w.u16(scheme.length);
  w.u16(slugs.length);
  for (const p of parts) {
    w.u16(p.byteLength);
    w.bytes(p);
  }
  return w.finish();
}

function decodeCatIds(
  buf: Uint8Array,
): { media: string[]; spdx: string[]; scheme: string[]; slugs: string[] } | undefined {
  if (buf.byteLength < 12) return;
  const mag = TD.decode(buf.subarray(0, 4));
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nM = r.u16();
  const nS = r.u16();
  const nC = r.u16();
  const nW = r.u16();
  if (mag === "CI02") {
    const take = (n: number) => {
      const len = r.u16();
      const slice = buf.subarray(r.off, r.off + len);
      r.off += len;
      const got = decodeCatList(slice);
      return got.length >= n ? got.slice(0, n) : got;
    };
    return { media: take(nM), spdx: take(nS), scheme: take(nC), slugs: take(nW) };
  }
  if (mag !== "CI01") return;
  const all = decodeCatList(buf.subarray(r.off));
  return {
    media: all.slice(0, nM),
    spdx: all.slice(nM, nM + nS),
    scheme: all.slice(nM + nS, nM + nS + nC),
    slugs: all.slice(nM + nS + nC, nM + nS + nC + nW),
  };
}

function decodeCatList(buf: Uint8Array): string[] {
  if (buf.byteLength < 4) return [];
  const mag = TD.decode(buf.subarray(0, 4));
  if (mag === "MT02" || mag === "MT03") return decodeMt02(buf);
  if (mag === "SL01") return decodeSlashList(buf);
  if (mag === "GL01") return decodeCatListGrouped(buf);
  if (mag === "CF01") return decodeFc01(buf);
  if (mag === "DG01") return decodeDawg(buf);
  if (mag === "HT01") return decodeHt01(buf);
  const titled = decodeTitleBody(buf);
  if (titled.length) return titled;
  return decodeIntern(buf);
}

function encodeIntern(strs: string[]): Uint8Array {
  if (!strs.length) return encodePfc(strs);
  const cands = [encodeBakedIntern(strs), encodeNulList(strs), encodeDawg(strs)];
  let best = cands[0]!;
  let bestBr = brotliRawLen(best, BROTLI_QUALITY);
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i]!;
    if (!c.byteLength) continue;
    const br = brotliRawLen(c, BROTLI_QUALITY);
    if (br < bestBr || (br === bestBr && c.byteLength < best.byteLength)) {
      best = c;
      bestBr = br;
    }
  }
  return best;
}

function decodeIntern(buf: Uint8Array): string[] {
  if (buf.byteLength >= 4) {
    const mag = TD.decode(buf.subarray(0, 4));
    if (mag === "DG01") return decodeDawg(buf);
    if (mag === "WD07") return decodeBakedIntern(buf);
    if (mag === "WD06") return decodePrefixIntern(buf);
    if (mag === "WD04") return decodeWordDict(buf.subarray(4));
    if (mag === "WD03") {
      const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
      const n = r.u32();
      if (!n) return [];
      const blob = r.utf8(r.end - r.off);
      const parts = blob.split("\0");
      if (parts.length === n) return parts;
      while (parts.length < n) parts.push("");
      return parts.slice(0, n);
    }
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
  for (const id of ids) bytes[id >> 3]! |= 1 << (id & 7);
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

function dropNoisyPosts(post: Map<string, number[]>, nTrip: number) {
  if (nTrip < 256) return;
  for (const [t, ids] of post) {
    if (noisyPostTerm(t, ids.length, nTrip)) post.delete(t);
  }
}

/** PS01: nTrip + term → posting list. Empty on the 15k fixture. */
export function encodePostIndex(post: Map<string, number[]>, nTrip: number): Uint8Array {
  const terms = [...post.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const w = new Writer();
  w.utf8(POST_MAGIC);
  w.u32(nTrip >>> 0);
  w.vbyte(terms.length);
  for (const t of terms) {
    const blob = encodePosting(post.get(t)!, nTrip);
    w.vbyte(t.length);
    w.utf8(t);
    w.vbyte(blob.length);
    w.bytes(blob);
  }
  return w.finish();
}

export function decodePostIndex(buf: Uint8Array): Map<string, number[]> {
  const post = new Map<string, number[]>();
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== POST_MAGIC) return post;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  r.u32();
  const n = r.vbyte();
  for (let i = 0; i < n; i++) {
    const tn = r.vbyte();
    const t = r.utf8(tn);
    const pn = r.vbyte();
    const start = r.off;
    if (start + pn > r.end) break;
    r.off += pn;
    post.set(t, decodePosting(buf.subarray(start, start + pn)));
  }
  return post;
}

/** RFC / IANA / SPDX / W3C / capital-of. Locate miss must not scan wiki postings. */
function typedLocateQuery(trimmed: string, shapes: string[]): boolean {
  if (rfcNumExact(trimmed) !== undefined) return true;
  if (ianaMedia(trimmed) || bareMediaType(trimmed)) return true;
  if (/^(?:the\s+)?capital of /i.test(trimmed)) return true;
  for (const s of shapes) {
    if (/^(?:IANA |RFC |W3C |WHATWG |SPDX |Unicode )/i.test(s)) return true;
  }
  return false;
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
  private rfcBits: Uint8Array | null;
  private rfcMax: number;
  private rfcCount: number;
  private rfcSec: Uint8Array | null = null;
  private rfcNumsCache: Uint32Array | null = null;
  private rfcOverlay: Map<number, string>;
  private rfcObs: RfcEdge[];
  private rfcUpd: RfcEdge[];
  private rfcEdgeRaw: Uint8Array | null;
  private rfcEdgeSidecar = false;
  private rfcObsByCache: Map<number, number[]> | null = null;
  private rfcUpdByCache: Map<number, number[]> | null = null;
  private closedCapitals = false;
  private extraCapList: PackFact[] | null = null;
  private aliasReady = false;
  private locReady = false;
  private cat: PackCat;
  private headerLoc: Map<string, number>;
  private dnsLoc: Map<string, number>;
  private charsetLoc: Map<string, number>;
  private langLoc: Map<string, number>;
  private scriptLoc: Map<string, number>;
  private catFactList: PackFact[] | null = null;
  private rfcImplicit = false;
  private titlesComplete = false;
  private titleIdx: Rt11 | undefined;
  private titleRaw: Uint8Array | null = null;
  private titlesReady = false;
  private rfcTitlePosted = false;
  private titleCursor = { i: 0, off: 0 };
  private capList: PackFact[] = [];
  private capLoc = new Map<string, number>();
  private wikiList: PackFact[] = [];
  private wikiLoc = new Map<string, number>();

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
    rfc?: RfcCol,
    cat?: PackCat,
    closedCapFlag = false,
  ) {
    this.rfcSec = rfc?.compressed && rfc.compressed.byteLength ? rfc.compressed : null;
    this.rfcBits = this.rfcSec ? null : (rfc?.bits ?? null);
    this.rfcMax = this.rfcSec ? 0 : (rfc?.max ?? 0);
    this.rfcCount = this.rfcSec ? 0 : (rfc?.count ?? 0);
    this.rfcOverlay = this.rfcSec ? new Map() : (rfc?.overlay ?? new Map());
    this.rfcObs = rfc?.obs ?? [];
    this.rfcUpd = rfc?.upd ?? [];
    this.rfcEdgeRaw = this.rfcSec ? null : (rfc?.edgeRaw ?? null);
    this.rfcEdgeSidecar = rfc?.edgeSidecar === true;
    this.rfcImplicit = rfc?.implicit === true;
    this.titlesComplete = this.rfcSec ? false : rfc?.titlesComplete === true;
    this.titleIdx = this.rfcSec ? undefined : rfc?.titleIdx;
    this.titleRaw = this.rfcSec ? null : rfc?.titleRaw && rfc.titleRaw.byteLength ? rfc.titleRaw : null;
    this.titlesReady = this.rfcSec ? false : !this.titleRaw;
    if (this.rfcImplicit && !this.rfcCount && !this.rfcSec) {
      const u = implicitRfcUniverse();
      this.rfcBits = u.bits;
      this.rfcMax = u.max;
      this.rfcCount = u.count;
      this.rfcNumsCache = u.nums;
    }
    this.cat = cat ?? EMPTY_CAT;
    this.headerLoc = locTable(this.cat.headers);
    this.dnsLoc = locTable(this.cat.dns);
    this.charsetLoc = locTable(this.cat.charset);
    this.langLoc = locTable(this.cat.langs);
    this.scriptLoc = locTable(this.cat.scripts);
    this.capList = (this.cat.capitals ?? []).map((c) => ({ s: c.s, p: "capital", o: c.o, e: "", url: "" }));
    for (let i = 0; i < this.capList.length; i++) {
      const low = this.capList[i]!.s.toLowerCase();
      if (!this.capLoc.has(low)) this.capLoc.set(low, i);
    }
    this.wikiList = this.cat.wiki ?? [];
    for (let i = 0; i < this.wikiList.length; i++) {
      const low = this.wikiList[i]!.s.toLowerCase();
      if (!this.wikiLoc.has(low)) this.wikiLoc.set(low, i);
    }
    this.mediaLoc = locTable(media);
    this.spdxLoc = locTable(spdx);
    this.schemeLoc = locTable(scheme);
    this.whatwgLoc = locTable(whatwg);
    this.blockLoc = locTable(blocks);
    this.methodLoc = locTable(methods);
    this.relLoc = locTable(rels);
    this.wkLoc = locTable(wks);
    if (closedCapFlag) this.closedCapitals = true;
    this.bySid = new Map();
    for (let i = 0; i < sid.length; i++) {
      const s = sid[i]!;
      const list = this.bySid.get(s);
      if (list) list.push(i);
      else this.bySid.set(s, [i]);
    }
    this.posted = post.size > 0;
    if (this.posted) this.rfcTitlePosted = true;
    if (alias.size) this.aliasReady = true;
    if (loc.size) this.locReady = true;
  }

  private ensureAlias() {
    if (this.aliasReady) return;
    this.aliasReady = true;
    this.synthAlias();
    for (let i = 0; i < this.slugs.length; i++) {
      const spaced = this.slugs[i]!.replace(/-/g, " ").toLowerCase();
      if (spaced.length < 2 || spaced === this.slugs[i]!.toLowerCase()) continue;
      if (this.alias.has(spaced)) continue;
      const id = packId(KIND_W3C, i);
      if (this.bySid.has(id) || this.cat.peeled) this.alias.set(spaced, id);
    }
  }

  private ensureLoc() {
    if (this.locReady) return;
    this.locReady = true;
    for (let i = 0; i < this.strs.length; i++) {
      const s = this.strs[i]!;
      this.loc.set(s, i + 1);
      const low = s.toLowerCase();
      if (!this.loc.has(low)) this.loc.set(low, i + 1);
    }
  }

  private applyRfcCol(rfc: RfcCol) {
    this.rfcBits = rfc.bits ?? null;
    this.rfcMax = rfc.max ?? 0;
    this.rfcCount = rfc.count ?? 0;
    this.rfcOverlay = rfc.overlay ?? new Map();
    this.rfcObs = rfc.obs ?? [];
    this.rfcUpd = rfc.upd ?? [];
    this.rfcEdgeRaw = rfc.edgeRaw ?? null;
    if (rfc.edgeSidecar) this.rfcEdgeSidecar = true;
    this.rfcImplicit = rfc.implicit === true;
    this.titlesComplete = rfc.titlesComplete === true;
    this.titleIdx = rfc.titleIdx;
    this.titleRaw = rfc.titleRaw && rfc.titleRaw.byteLength ? rfc.titleRaw : null;
    this.titlesReady = !this.titleRaw;
    this.rfcNumsCache = null;
    this.rfcObsByCache = null;
    this.rfcUpdByCache = null;
    if (this.rfcImplicit && !this.rfcCount) {
      const u = implicitRfcUniverse();
      this.rfcBits = u.bits;
      this.rfcMax = u.max;
      this.rfcCount = u.count;
      this.rfcNumsCache = u.nums;
    }
  }

  private applyKg10Rfc(buf: Uint8Array) {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const nlen = r.u32();
    const parsed = decodeRfcNumsCompact(buf.subarray(r.off, r.off + nlen));
    r.off += nlen;
    const tlen = r.u32();
    const tbuf = tlen ? buf.subarray(r.off, r.off + tlen) : EMPTY_U8;
    r.off += tlen;
    const elen = r.u32();
    const ebuf = elen ? buf.subarray(r.off, r.off + elen) : EMPTY_U8;
    let overlay = new Map<number, string>();
    let titleIdx: Rt11 | undefined;
    let titlesComplete = false;
    let titleRaw: Uint8Array | undefined;
    if (tlen) {
      const head = tlen >= 4 ? TD.decode(tbuf.subarray(0, 4)) : "";
      if (head === "OM09") overlay = decodeOm09Map(tbuf);
      else if (head === "RT11") {
        titleIdx = parseRt11(tbuf);
        titlesComplete = !!(titleIdx && titleIdx.nTitle === parsed.count);
      } else {
        titlesComplete = true;
        titleRaw = tbuf.slice();
      }
    }
    this.applyRfcCol({
      bits: parsed.bits,
      max: parsed.max,
      count: parsed.count,
      overlay,
      obs: [],
      upd: [],
      edgeRaw: ebuf,
      titlesComplete,
      titleIdx,
      titleRaw,
    });
  }

  private applyKg11Rfc(buf: Uint8Array) {
    const g = parseKg11(buf);
    if (!g) return;
    this.applyRfcCol(kg11RfcCol(g));
  }

  private applyKg12Rfc(buf: Uint8Array) {
    const g = parseKg12(buf);
    if (!g) return;
    this.applyRfcCol(kg12RfcCol(g));
  }

  private ensureRfcColumn() {
    const sec = this.rfcSec;
    if (!sec) return;
    this.rfcSec = null;
    const raw = unzipSection(sec);
    if (!raw.byteLength) return;
    const head = raw.byteLength >= 4 ? TD.decode(raw.subarray(0, 4)) : "";
    if (head === "KG10") {
      this.applyKg10Rfc(raw);
      return;
    }
    if (head === "KG11") {
      this.applyKg11Rfc(raw);
      return;
    }
    if (head === "KG12" || head === "KG13") {
      this.applyKg12Rfc(raw);
      return;
    }
    if (head === "KG14") {
      const g = parseKg14(raw);
      if (g) this.applyRfcCol(kg12RfcCol(g));
      return;
    }
    if (head === "KG15") {
      const g = parseKg15(raw);
      if (g) this.applyRfcCol(kg15RfcCol(g));
      return;
    }
    if (head === "KG16") {
      const g = parseKg16(raw);
      if (g) this.applyRfcCol(kg12RfcCol(g));
      return;
    }
    if (head === "KG17") {
      const g = parseKg17(raw);
      if (g) this.applyRfcCol(kg12RfcCol(g));
      return;
    }
    this.applyRfcCol(decodeRfcColumn(raw));
  }

  private ensureEdges() {
    this.ensureRfcColumn();
    if (this.rfcEdgeSidecar) {
      const e = loadRfcEdges();
      this.rfcObs = e.obs;
      this.rfcUpd = e.upd;
      this.rfcEdgeSidecar = false;
      this.rfcEdgeRaw = null;
      this.rfcObsByCache = null;
      this.rfcUpdByCache = null;
      return;
    }
    if (!this.rfcEdgeRaw || !this.rfcEdgeRaw.byteLength) return;
    const e = decodeRfcEdges(this.rfcEdgeRaw, this.rfcNumList());
    this.rfcObs = e.obs;
    this.rfcUpd = e.upd;
    this.rfcEdgeRaw = null;
  }

  private edgeCount() {
    if (this.rfcEdgeSidecar) {
      const c = rfcEdgeCounts();
      return c.obs + c.upd;
    }
    this.ensureEdges();
    return this.rfcObs.length + this.rfcUpd.length;
  }

  /** Rebuild catalog aliases from rest facts only — never walk RFC is-rows. */
  private synthAlias() {
    if (this.alias.size) return;
    const claimed = new Map<string, number>();
    for (let i = 0; i < this.sid.length; i++) {
      if (idKind(this.sid[i]!) === KIND_RFC) continue;
      claimAliases(claimed, this.extractId(this.sid[i]!), this.extractId(this.oid[i]!), this.sid[i]!);
    }
    if (this.cat.peeled) {
      const claimId = (s: string, id: number) => claimAliases(claimed, s, this.objOverOf(id, s), id);
      for (let i = 0; i < this.media.length; i++) {
        const id = packId(KIND_MEDIA, i);
        claimId(`IANA media ${this.media[i]}`, id);
      }
      for (let i = 0; i < this.spdx.length; i++) {
        const id = packId(KIND_SPDX, i);
        claimId(`SPDX ${this.spdx[i]}`, id);
      }
      for (let i = 0; i < this.scheme.length; i++) {
        const id = packId(KIND_SCHEME, i);
        claimId(`IANA scheme ${this.scheme[i]}`, id);
      }
      for (let i = 0; i < this.whatwg.length; i++) {
        const id = packId(KIND_WHATWG, i);
        claimId(`WHATWG ${this.whatwg[i]}`, id);
      }
      for (let i = 0; i < this.blocks.length; i++) {
        const id = packId(KIND_BLOCK, i);
        claimId(`Unicode Block ${this.blocks[i]}`, id);
      }
      for (let i = 0; i < this.methods.length; i++) {
        const id = packId(KIND_METHOD, i);
        claimId(`IANA method ${this.methods[i]}`, id);
      }
      for (let i = 0; i < this.rels.length; i++) {
        const id = packId(KIND_REL, i);
        claimId(`IANA rel ${this.rels[i]}`, id);
      }
      for (let i = 0; i < this.wks.length; i++) {
        const id = packId(KIND_WK, i);
        claimId(`IANA well-known ${this.wks[i]}`, id);
      }
      for (let i = 0; i < this.slugs.length; i++) {
        const id = packId(KIND_W3C, i);
        claimId(`W3C ${this.slugs[i]}`, id);
      }
      if (this.cat.protoBits) {
        for (let n = 0; n < 256; n++) {
          if (!(this.cat.protoBits[n >> 3]! & (1 << (n & 7)))) continue;
          claimId(`IANA protocol ${n}`, packId(KIND_PROTO, n));
        }
      }
      if (this.cat.httpBits) {
        for (let n = 0; n < this.cat.httpBits.length * 8; n++) {
          if (!(this.cat.httpBits[n >> 3]! & (1 << (n & 7)))) continue;
          claimId(`IANA http ${n}`, packId(KIND_HTTP, n));
        }
      }
      for (const lang of this.cat.langs) {
        claimId(`IANA language ${lang}`, packId(KIND_LANG, packLang(lang)));
      }
      for (const sc of this.cat.scripts) {
        claimId(`Unicode Script ${sc}`, packId(KIND_SCRIPT, packScriptCode(sc)));
      }
    }
    for (const [k, v] of claimed) if (v >= 0) this.alias.set(k, v);
  }

  private objOverOf(id: number, s: string): string {
    return this.cat.objOver.get(id) ?? catalogObjectSynth(s) ?? "";
  }

  private protoHas(n: number): boolean {
    const b = this.cat.protoBits;
    if (!b || n < 0 || n > 255) return false;
    return (b[n >> 3]! & (1 << (n & 7))) !== 0;
  }

  private httpHas(n: number): boolean {
    const b = this.cat.httpBits;
    if (!b || n < 0) return false;
    const i = n >> 3;
    if (i >= b.length) return false;
    return (b[i]! & (1 << (n & 7))) !== 0;
  }

  private typedLive(id: number): boolean {
    if (this.bySid.has(id)) return true;
    if (!this.cat.peeled) return false;
    const kind = idKind(id);
    const p = idPayload(id);
    if (kind === KIND_PROTO) return this.protoHas(p);
    if (kind === KIND_HTTP) return this.httpHas(p);
    if (kind === KIND_MEDIA) return p < this.media.length;
    if (kind === KIND_SPDX) return p < this.spdx.length;
    if (kind === KIND_SCHEME) return p < this.scheme.length;
    if (kind === KIND_WHATWG) return p < this.whatwg.length;
    if (kind === KIND_BLOCK) return p < this.blocks.length;
    if (kind === KIND_METHOD) return p < this.methods.length;
    if (kind === KIND_REL) return p < this.rels.length;
    if (kind === KIND_WK) return p < this.wks.length;
    if (kind === KIND_W3C) return p < this.slugs.length;
    if (kind === KIND_LANG) return this.langLoc.size > 0 && this.langLoc.has(unpackLang(p));
    if (kind === KIND_SCRIPT) return this.scriptLoc.size > 0 && this.scriptLoc.has(unpackScriptCode(p));
    return false;
  }

  private qcache = new Map<string, PackFact[]>();

  private remember(q: string, hits: PackFact[]) {
    this.qcache.set(q, hits);
    if (this.qcache.size > 64) this.qcache.delete(this.qcache.keys().next().value!);
  }

  private rfcNumList(): Uint32Array {
    this.ensureRfcColumn();
    if (this.rfcNumsCache) return this.rfcNumsCache;
    if (!this.rfcBits || !this.rfcCount) {
      this.rfcNumsCache = new Uint32Array(0);
      return this.rfcNumsCache;
    }
    this.rfcNumsCache = bitsToNums(this.rfcBits, this.rfcMax, this.rfcCount);
    return this.rfcNumsCache;
  }

  private rfcObsBy(): Map<number, number[]> {
    this.ensureEdges();
    if (!this.rfcObsByCache) {
      this.rfcObsByCache = new Map();
      for (const e of this.rfcObs) this.rfcObsByCache.set(e.src, e.dests);
    }
    return this.rfcObsByCache;
  }

  private rfcUpdBy(): Map<number, number[]> {
    this.ensureEdges();
    if (!this.rfcUpdByCache) {
      this.rfcUpdByCache = new Map();
      for (const e of this.rfcUpd) this.rfcUpdByCache.set(e.src, e.dests);
    }
    return this.rfcUpdByCache;
  }

  private rfcIndexOf(n: number): number {
    const nums = this.rfcNumList();
    let lo = 0;
    let hi = nums.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = nums[mid]!;
      if (v === n) return mid;
      if (v < n) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private ensureTitles() {
    this.ensureRfcColumn();
    if (this.titlesReady) return;
    this.titlesReady = true;
    this.peelTitleRaw();
    const raw = this.titleRaw;
    this.titleRaw = null;
    this.titleCursor = { i: 0, off: 0 };
    if (!raw || !raw.byteLength) return;
    const titles = decodeTitleBody(raw);
    const nums = this.rfcNumList();
    this.rfcOverlay = overlayFromTitles(nums, titles);
  }

  private peelTitleRaw() {
    const raw = this.titleRaw;
    if (!raw || !raw.byteLength) return;
    if (isBr08(raw) || isZstdFrame(raw)) {
      this.titleRaw = unzipSection(raw);
      this.titleCursor = { i: 0, off: 0 };
    }
  }

  private rfcHas(n: number): boolean {
    this.ensureRfcColumn();
    if (this.rfcImplicit && !this.rfcBits) return rfcTitleOf(n) !== undefined;
    if (!this.rfcBits || n < 0 || n > this.rfcMax) return false;
    return (this.rfcBits[n >> 3]! & (1 << (n & 7))) !== 0;
  }

  private rfcLive(n: number): boolean {
    return this.rfcHas(n) || this.rfcObsBy().has(n) || this.rfcUpdBy().has(n);
  }

  private rfcTitle(n: number): string {
    this.ensureRfcColumn();
    const hit = this.rfcOverlay.get(n);
    if (hit !== undefined) return hit;
    if (this.titleIdx) return titleFromRt11(this.titleIdx, n) ?? "";
    if (this.titleRaw) {
      this.peelTitleRaw();
      const mag = this.titleRaw.byteLength >= 4 ? TD.decode(this.titleRaw.subarray(0, 4)) : "";
      if (
        mag === "NT08" ||
        mag === "SN08" ||
        mag === "RT12" ||
        mag === "RT13" ||
        mag === "RT14" ||
        mag === "TM15" ||
        mag === "BW13"
      ) {
        const idx = this.rfcIndexOf(n);
        if (idx < 0) return "";
        const t = decodeTitleNth(this.titleRaw, idx, this.titleCursor);
        this.rfcOverlay.set(n, t);
        return t;
      }
      this.ensureTitles();
      return this.rfcOverlay.get(n) ?? "";
    }
    if (!this.titlesComplete) return rfcTitleOf(n) ?? "";
    return "";
  }

  private rfcFacts(n: number): PackFact[] {
    const s = `RFC ${n}`;
    const out: PackFact[] = [];
    if (this.rfcHas(n)) {
      const o = this.rfcTitle(n);
      out.push({ s, p: "is", o, e: "", url: "" });
    }
    const obs = this.rfcObsBy().get(n);
    if (obs) out.push({ s, p: "obsoletes", o: rfcListStr(obs), e: "", url: "" });
    const upd = this.rfcUpdBy().get(n);
    if (upd) out.push({ s, p: "updates", o: rfcListStr(upd), e: "", url: "" });
    return out;
  }

  private extraCaps(): PackFact[] {
    if (!this.closedCapitals) return [];
    if (this.extraCapList) return this.extraCapList;
    const capPred = PRED_ID.get("capital")!;
    const have = new Set<string>();
    for (let i = 0; i < this.sid.length; i++) {
      if (this.pid[i] !== capPred) continue;
      have.add(this.extractId(this.sid[i]!).toLowerCase());
    }
    for (const f of this.capList) have.add(f.s.toLowerCase());
    const out: PackFact[] = [];
    for (const t of capitalTriples()) {
      if (have.has(t.s.toLowerCase())) continue;
      out.push({ s: t.s, p: "capital", o: t.o, e: "", url: "" });
    }
    this.extraCapList = out;
    return out;
  }

  private packedN() {
    this.ensureRfcColumn();
    return (
      this.sid.length +
      this.rfcCount +
      this.edgeCount() +
      this.catFacts().length +
      this.capList.length +
      this.wikiList.length
    );
  }

  private catFacts(): PackFact[] {
    if (!this.cat.peeled) return [];
    if (this.catFactList) return this.catFactList;
    const out: PackFact[] = [];
    const push = (s: string, o: string) => out.push({ s, p: "is", o, e: "", url: "" });
    const takeTyped = (id: number, s: string) => {
      if (this.bySid.has(id)) return;
      push(s, this.objOverOf(id, s));
    };
    for (const h of this.cat.headers) {
      const s = `IANA header ${h}`;
      push(s, this.cat.headerOver.get(h) ?? catalogObjectSynth(s) ?? `HTTP field ${h}`);
    }
    for (let i = 0; i < this.cat.dns.length; i++) {
      const name = this.cat.dns[i]!;
      push(`IANA dns ${name}`, this.cat.dnsObj[i] || DNS_OBJECT[name] || "");
    }
    for (const c of this.cat.charset) {
      const s = `IANA charset ${c}`;
      push(s, this.cat.charsetOver.get(c) ?? catalogObjectSynth(s) ?? c);
    }
    if (this.cat.protoBits) {
      for (let n = 0; n < 256; n++) {
        if (this.protoHas(n)) takeTyped(packId(KIND_PROTO, n), `IANA protocol ${n}`);
      }
    }
    if (this.cat.httpBits) {
      for (let n = 0; n < this.cat.httpBits.length * 8; n++) {
        if (this.httpHas(n)) takeTyped(packId(KIND_HTTP, n), `IANA http ${n}`);
      }
    }
    for (let i = 0; i < this.media.length; i++) {
      takeTyped(packId(KIND_MEDIA, i), `IANA media ${this.media[i]}`);
    }
    for (let i = 0; i < this.spdx.length; i++) {
      takeTyped(packId(KIND_SPDX, i), `SPDX ${this.spdx[i]}`);
    }
    for (let i = 0; i < this.scheme.length; i++) {
      takeTyped(packId(KIND_SCHEME, i), `IANA scheme ${this.scheme[i]}`);
    }
    for (let i = 0; i < this.whatwg.length; i++) {
      takeTyped(packId(KIND_WHATWG, i), `WHATWG ${this.whatwg[i]}`);
    }
    for (let i = 0; i < this.blocks.length; i++) {
      takeTyped(packId(KIND_BLOCK, i), `Unicode Block ${this.blocks[i]}`);
    }
    for (let i = 0; i < this.methods.length; i++) {
      takeTyped(packId(KIND_METHOD, i), `IANA method ${this.methods[i]}`);
    }
    for (let i = 0; i < this.rels.length; i++) {
      takeTyped(packId(KIND_REL, i), `IANA rel ${this.rels[i]}`);
    }
    for (let i = 0; i < this.wks.length; i++) {
      takeTyped(packId(KIND_WK, i), `IANA well-known ${this.wks[i]}`);
    }
    for (let i = 0; i < this.slugs.length; i++) {
      takeTyped(packId(KIND_W3C, i), `W3C ${this.slugs[i]}`);
    }
    for (const lang of this.cat.langs) {
      takeTyped(packId(KIND_LANG, packLang(lang)), `IANA language ${lang}`);
    }
    for (const sc of this.cat.scripts) {
      takeTyped(packId(KIND_SCRIPT, packScriptCode(sc)), `Unicode Script ${sc}`);
    }
    this.catFactList = out;
    return out;
  }

  private ensurePost() {
    if (this.posted) return;
    this.posted = true;
    if (this.packedN()) this.synthPost();
  }

  /** Rebuild the inverted index from stored strings. Disk does not keep it. */
  private synthPost() {
    this.ensureEdges();
    const restN = this.sid.length;
    const nTrip = this.packedN();
    for (let i = 0; i < restN; i++) {
      const s = this.extractId(this.sid[i]!);
      const p = PACK_PREDS[this.pid[i]!] ?? "";
      const o = this.objectOf(i);
      for (const w of factIndexTokens({ s, p, o, e: "" })) {
        const list = this.post.get(w);
        if (list) list.push(i);
        else this.post.set(w, [i]);
      }
    }
    const rfcNums = this.rfcNumList();
    const titlesNow = this.titlesReady && !this.titleRaw;
    for (let i = 0; i < rfcNums.length; i++) {
      const n = rfcNums[i]!;
      const fi = restN + i;
      const s = `RFC ${n}`;
      const o = titlesNow ? this.rfcTitle(n) : "";
      for (const w of factIndexTokens({ s, p: "is", o, e: "" })) {
        const list = this.post.get(w);
        if (list) list.push(fi);
        else this.post.set(w, [fi]);
      }
    }
    this.rfcTitlePosted = titlesNow || rfcNums.length === 0;
    const edgeBase = restN + rfcNums.length;
    for (let i = 0; i < this.rfcObs.length; i++) {
      const e = this.rfcObs[i]!;
      const fi = edgeBase + i;
      const s = `RFC ${e.src}`;
      const o = rfcListStr(e.dests);
      for (const w of factIndexTokens({ s, p: "obsoletes", o, e: "" })) {
        const list = this.post.get(w);
        if (list) list.push(fi);
        else this.post.set(w, [fi]);
      }
    }
    const updBase = edgeBase + this.rfcObs.length;
    for (let i = 0; i < this.rfcUpd.length; i++) {
      const e = this.rfcUpd[i]!;
      const fi = updBase + i;
      const s = `RFC ${e.src}`;
      const o = rfcListStr(e.dests);
      for (const w of factIndexTokens({ s, p: "updates", o, e: "" })) {
        const list = this.post.get(w);
        if (list) list.push(fi);
        else this.post.set(w, [fi]);
      }
    }
    const cat = this.catFacts();
    const catBase = updBase + this.rfcUpd.length;
    for (let i = 0; i < cat.length; i++) {
      const f = cat[i]!;
      const fi = catBase + i;
      for (const w of factIndexTokens({ s: f.s, p: f.p, o: f.o, e: "" })) {
        const list = this.post.get(w);
        if (list) list.push(fi);
        else this.post.set(w, [fi]);
      }
    }
    const capBase = catBase + cat.length;
    for (let i = 0; i < this.capList.length; i++) {
      const f = this.capList[i]!;
      const fi = capBase + i;
      for (const w of factIndexTokens({ s: f.s, p: f.p, o: f.o, e: "" })) {
        const list = this.post.get(w);
        if (list) list.push(fi);
        else this.post.set(w, [fi]);
      }
    }
    const wikiBase = capBase + this.capList.length;
    for (let i = 0; i < this.wikiList.length; i++) {
      const f = this.wikiList[i]!;
      const fi = wikiBase + i;
      for (const w of factIndexTokens({ s: f.s, p: f.p, o: f.o, e: "" })) {
        const list = this.post.get(w);
        if (list) list.push(fi);
        else this.post.set(w, [fi]);
      }
    }
    dropNoisyPosts(this.post, nTrip);
  }

  /** Title-word postings for RFC is-rows — only when token search misses. */
  private ensureRfcTitlePosts() {
    if (this.rfcTitlePosted) return;
    this.rfcTitlePosted = true;
    this.ensureTitles();
    const restN = this.sid.length;
    const rfcNums = this.rfcNumList();
    for (let i = 0; i < rfcNums.length; i++) {
      const n = rfcNums[i]!;
      const fi = restN + i;
      const o = this.rfcTitle(n);
      const own = String(n);
      for (const w of postTokens(o)) {
        if (w === own || TITLE_ALIAS_POISON.has(w)) continue;
        const list = this.post.get(w);
        if (!list) {
          this.post.set(w, [fi]);
          continue;
        }
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid]! < fi) lo = mid + 1;
          else hi = mid;
        }
        if (list[lo] !== fi) list.splice(lo, 0, fi);
      }
    }
    dropNoisyPosts(this.post, this.packedN());
  }

  get nTriples() {
    return this.packedN() + this.extraCaps().length;
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

  /** Decoder-table RFC titles stay out of strs (oid=0) until a fact is read. */
  private objectOf(i: number): string {
    const oid = this.oid[i]!;
    if (oid !== 0) return this.extractId(oid);
    const pred = PACK_PREDS[this.pid[i]!] ?? "is";
    if (pred === "is" && idKind(this.sid[i]!) === KIND_RFC) {
      return this.rfcTitle(idPayload(this.sid[i]!));
    }
    return catalogObjectSynth(this.extractId(this.sid[i]!), pred) ?? "";
  }

  locate(s: string): number {
    const trimmed = s.trim();
    const hit = (id: number) => (this.typedLive(id) ? id : 0);
    const rfcHit = (n: number) => (this.rfcLive(n) || this.bySid.has(tagRfc(n)) ? tagRfc(n) : 0);
    const compact = trimmed.replace(/\s+/g, "");
    const rfcBare = /^rfc(\d{1,5})$/i.exec(compact);
    if (rfcBare) {
      const tagged = rfcHit(Number(rfcBare[1]));
      if (tagged) return tagged;
    }
    const n = rfcNum(trimmed);
    if (n !== undefined) {
      const tagged = rfcHit(n);
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
      const r = rfcHit(Number(trimmed));
      if (r) return r;
    }
    if (/^\d{1,5}$/.test(trimmed)) {
      const r = rfcHit(Number(trimmed));
      if (r) return r;
    }
    this.ensureAlias();
    const aliased = this.alias.get(trimmed.toLowerCase());
    if (aliased && this.typedLive(aliased)) return aliased;
    this.ensureLoc();
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
    const scheme =
      ianaScheme(trimmed) || (/^[a-z][a-z0-9+.-]{1,24}$/.test(trimmed) ? trimmed.toLowerCase() : undefined);
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
    const restN = this.sid.length;
    if (i < restN) {
      return {
        s: this.extractId(this.sid[i]!),
        p: PACK_PREDS[this.pid[i]!] ?? "",
        o: this.objectOf(i),
        e: this.evidText[this.evid[i]!] ?? "",
        url: this.extractId(this.urlid[i]!),
      };
    }
    this.ensureRfcColumn();
    const rfcN = this.rfcCount;
    if (i < restN + rfcN) {
      const n = this.rfcNumList()[i - restN]!;
      return { s: `RFC ${n}`, p: "is", o: this.rfcTitle(n), e: "", url: "" };
    }
    this.ensureEdges();
    const obsBase = restN + rfcN;
    if (i < obsBase + this.rfcObs.length) {
      const e = this.rfcObs[i - obsBase]!;
      return { s: `RFC ${e.src}`, p: "obsoletes", o: rfcListStr(e.dests), e: "", url: "" };
    }
    const updBase = obsBase + this.rfcObs.length;
    if (i < updBase + this.rfcUpd.length) {
      const e = this.rfcUpd[i - updBase]!;
      return { s: `RFC ${e.src}`, p: "updates", o: rfcListStr(e.dests), e: "", url: "" };
    }
    const cat = this.catFacts();
    const catBase = updBase + this.rfcUpd.length;
    if (i < catBase + cat.length) return cat[i - catBase]!;
    const capBase = catBase + cat.length;
    if (i < capBase + this.capList.length) return this.capList[i - capBase]!;
    const wikiBase = capBase + this.capList.length;
    if (i < wikiBase + this.wikiList.length) return this.wikiList[i - wikiBase]!;
    return this.extraCaps()[i - wikiBase - this.wikiList.length] ?? { s: "", p: "", o: "", e: "", url: "" };
  }

  private catHit(shape: string): PackFact | undefined {
    if (!this.cat.peeled) return;
    const header = ianaHeader(shape) ?? shape;
    const hi = this.headerLoc.get(header) ?? this.headerLoc.get(header.toLowerCase());
    if (hi !== undefined) {
      const h = this.cat.headers[hi]!;
      const s = `IANA header ${h}`;
      return {
        s,
        p: "is",
        o: this.cat.headerOver.get(h) ?? catalogObjectSynth(s) ?? `HTTP field ${h}`,
        e: "",
        url: "",
      };
    }
    const dns = ianaDns(shape) ?? shape.toUpperCase();
    const di = this.dnsLoc.get(dns) ?? this.dnsLoc.get(shape) ?? this.dnsLoc.get(shape.toLowerCase());
    if (di !== undefined) {
      const name = this.cat.dns[di]!;
      return { s: `IANA dns ${name}`, p: "is", o: this.cat.dnsObj[di] || DNS_OBJECT[name] || "", e: "", url: "" };
    }
    const cs = ianaCharset(shape) ?? shape.toLowerCase();
    const ci = this.charsetLoc.get(cs) ?? this.charsetLoc.get(shape.toLowerCase());
    if (ci !== undefined) {
      const c = this.cat.charset[ci]!;
      const s = `IANA charset ${c}`;
      return { s, p: "is", o: this.cat.charsetOver.get(c) ?? catalogObjectSynth(s) ?? c, e: "", url: "" };
    }
  }

  private synthTyped(id: number): PackFact {
    const s = this.extractId(id);
    return { s, p: "is", o: this.objOverOf(id, s), e: "", url: "" };
  }

  search(q: string, k = 5): PackFact[] {
    const trimmed = q.trim();
    if (!trimmed) return [];
    const hit = this.qcache.get(trimmed);
    if (hit) return hit.slice(0, k);
    const qn = trimmed.toLowerCase();
    const shapes = queryShapes(trimmed);
    const qtoks = queryTokens(shapes[1] ?? trimmed);
    const coverScore = (h: PackFact) => {
      if (!qtoks.length) return 0;
      const hay = new Set(queryTokens(`${h.s} ${h.o}`));
      let n = 0;
      for (const t of qtoks) if (hay.has(t)) n++;
      return n;
    };
    const order = (hits: PackFact[]) => {
      const cover = hits.map(coverScore);
      const ix = hits.map((_, i) => i);
      ix.sort((ia, ib) => {
        const a = hits[ia]!;
        const b = hits[ib]!;
        return (
          predRank(a.p) - predRank(b.p) ||
          (a.o.toLowerCase() === qn ? 0 : 1) - (b.o.toLowerCase() === qn ? 0 : 1) ||
          cover[ib]! - cover[ia]! ||
          (a.o.toLowerCase() === qn && b.o.toLowerCase() === qn ? b.s.length - a.s.length : a.s.length - b.s.length)
        );
      });
      return ix.map((i) => hits[i]!);
    };
    const keep = (h: PackFact) =>
      h.p !== "about" &&
      h.p !== "date" &&
      (h.p === "is" && /^RFC\s+\d/i.test(h.s) ? h.o.length <= 192 : h.o.length <= 72);
    for (const shape of shapes) {
      if (this.closedCapitals) {
        const cap = capHit(shape);
        if (cap) {
          const found = [{ s: cap.s, p: "capital", o: cap.o, e: "", url: "" }].filter(keep);
          const out = order(found).slice(0, k);
          this.remember(trimmed, out);
          return out;
        }
      }
      const capi = this.capLoc.get(shape.toLowerCase());
      if (capi !== undefined) {
        const found = [this.capList[capi]!].filter(keep);
        const out = order(found).slice(0, k);
        this.remember(trimmed, out);
        return out;
      }
      const wiki = this.wikiLoc.get(shape.toLowerCase());
      if (wiki !== undefined) {
        const found = this.wikiList.filter((f) => f.s.toLowerCase() === shape.toLowerCase()).filter(keep);
        const out = order(found).slice(0, k);
        this.remember(trimmed, out);
        return out;
      }
      const sid = this.locate(shape);
      if (sid) {
        const found =
          idKind(sid) === KIND_RFC &&
          (this.rfcSec || this.rfcBits || this.rfcImplicit || this.rfcObs.length || this.rfcUpd.length)
            ? this.rfcFacts(idPayload(sid)).filter(keep)
            : this.bySid.has(sid)
              ? (this.bySid.get(sid) || []).map((i) => this.factAt(i)).filter(keep)
              : [this.synthTyped(sid)].filter(keep);
        const out = order(found).slice(0, k);
        this.remember(trimmed, out);
        return out;
      }
      const cat = this.catHit(shape);
      if (cat) {
        const found = [cat].filter(keep);
        const out = order(found).slice(0, k);
        this.remember(trimmed, out);
        return out;
      }
    }
    if (typedLocateQuery(trimmed, shapes)) {
      this.remember(trimmed, []);
      return [];
    }
    let toks = qtoks.filter((t) => t !== "rfc" && t !== "w3c");
    if (!toks.length) toks = qtoks;
    if (this.bloom && toks.length && toks.some((t) => !bloomHas(this.bloom!, t))) {
      this.remember(trimmed, []);
      return [];
    }
    this.ensurePost();
    const lookup = () => {
      const lists = toks.map((t) => this.post.get(t));
      if (lists.some((x) => !x)) return [] as number[];
      let ids = lists[0]!;
      for (let i = 1; i < lists.length; i++) {
        ids = intersect(ids, lists[i]!);
        if (!ids.length) break;
      }
      return ids;
    };
    let ids = lookup();
    if (!ids.length && !this.rfcTitlePosted) {
      this.ensureRfcTitlePosts();
      ids = lookup();
    }
    if (!ids.length) {
      this.remember(trimmed, []);
      return [];
    }
    const hits = ids.map((i) => this.factAt(i)).filter(keep);
    const out = order(hits).slice(0, k);
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
  if (!s) return;
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

const RFC_GIST_STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "and",
  "to",
  "in",
  "on",
  "with",
  "from",
  "by",
  "as",
  "at",
  "or",
]);

/** Pack RFC titles as content words. Search/cards keep URI/HTTP; intern entropy drops. */
export function rfcTitleGist(o: string, n = 6): string {
  const words = o
    .replace(/[:.\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => {
      const t = w.replace(/[()]/g, "");
      return t.length > 1 && !RFC_GIST_STOP.has(t.toLowerCase());
    });
  if (!words.length) return o.replace(/\s+/g, " ").trim().slice(0, 72);
  if (words.length <= n) return words.join(" ");
  return words.slice(0, n).join(" ");
}

/** Shared-word RFC titles. Rare words stay as utf8 escapes so round-trip is lossless. */
function encodeCappedTitles(titles: string[], cap = 768): Uint8Array {
  const freq = new Map<string, number>();
  const partsList = titles.map((t) => t.split(/\s+/).filter(Boolean));
  for (const parts of partsList) for (const w of parts) freq.set(w, (freq.get(w) ?? 0) + 1);
  const vocab = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, cap)
    .map((x) => x[0]);
  const idOf = new Map(vocab.map((w, i) => [w, i + 1]));
  const w = new Writer();
  w.utf8("RT07");
  const vocabPfc = encodePfc(vocab);
  w.u32(vocabPfc.length);
  w.bytes(vocabPfc);
  w.u32(titles.length);
  for (const parts of partsList) {
    w.vbyte(parts.length);
    for (const p of parts) {
      const id = idOf.get(p);
      if (id) w.vbyte(id);
      else {
        w.vbyte(0);
        const b = TE.encode(p);
        w.vbyte(b.length);
        w.bytes(b);
      }
    }
  }
  return w.finish();
}

function decodeCappedTitles(buf: Uint8Array): string[] {
  if (buf.byteLength < 4) return [];
  const mag = TD.decode(buf.subarray(0, 4));
  if (mag !== "RT07" && mag !== "WD08") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const vlen = r.u32();
  const vocab = decodePfc(buf.subarray(r.off, r.off + vlen));
  r.off += vlen;
  const n = r.u32();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = r.vbyte();
    const words: string[] = [];
    for (let j = 0; j < k; j++) {
      const id = r.vbyte();
      if (id === 0) words.push(r.utf8(r.vbyte()));
      else words.push(vocab[id - 1] ?? "");
    }
    out.push(words.join(" "));
  }
  return out;
}

function decodeRfcBitset(r: Reader, buf: Uint8Array): { max: number; bits: Uint8Array; count: number } {
  const max = r.u16();
  const len = r.u16();
  const bits = buf.subarray(r.off, r.off + len);
  r.off += len;
  let count = 0;
  const last = max >> 3;
  const lim = Math.min(last, bits.length - 1);
  if (lim < 0) return { max, bits, count: 0 };
  for (let i = 0; i < lim; i++) count += POP8[bits[i]!]!;
  const mask = (1 << ((max & 7) + 1)) - 1;
  count += POP8[bits[lim]! & mask]!;
  return { max, bits, count };
}

function bitsToNums(bits: Uint8Array, max: number, count: number): Uint32Array {
  const nums = new Uint32Array(count);
  let k = 0;
  for (let i = 0; i <= max; i++) if (bits[i >> 3]! & (1 << (i & 7))) nums[k++] = i;
  return nums;
}

function encodeRfcBitset(nums: number[]): Uint8Array {
  const max = nums.length ? nums[nums.length - 1]! : 0;
  const bytes = new Uint8Array((max + 8) >> 3);
  for (const n of nums) bytes[n >> 3]! |= 1 << (n & 7);
  const w = new Writer();
  w.u16(max);
  w.u16(bytes.length);
  w.bytes(bytes);
  return w.finish();
}

function decodeTitleBody(buf: Uint8Array): string[] {
  if (buf.byteLength < 4) return [];
  const mag = TD.decode(buf.subarray(0, 4));
  if (mag === "RT11") return titlesFromRt11(buf);
  if (mag === "RT12") return decodeRt12(buf);
  if (mag === "RT13") return decodeRt13(buf);
  if (mag === "RT14") return decodeRt14(buf);
  if (mag === "LC14") return decodeLc14(buf);
  if (mag === "AT11") return decodeAt11(buf);
  if (mag === "TM11") return decodeTm11(buf);
  if (mag === "TM15") return decodeTm15(buf);
  if (mag === "TL11") return decodeTl11(buf);
  if (mag === "RP12") return decodeRp12(buf);
  if (mag === "NT08") {
    const blob = TD.decode(buf.subarray(4));
    if (!blob) return [];
    return blob.split("\0");
  }
  if (mag === "BW13") return decodeBw13(buf);
  if (mag === "SN08") return decodeSn08(buf);
  if (mag === "OM09") return [];
  if (mag === "FS09") return decodeTitleFsst(buf);
  if (mag === "RP09") return decodeTitleRepair(buf);
  if (mag === "BV09") return decodeTitleBaked(buf);
  if (mag === "WD08") return decodeCappedTitles(buf); // WD08 shares RT07 layout after magic rewrite
  if (mag === "RT07") return decodeCappedTitles(buf);
  if (mag === "WD04") return decodeWordDict(buf.subarray(4));
  if (mag === "WD03") {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const n = r.u32();
    if (!n) return [];
    const blob = r.utf8(r.end - r.off);
    const parts = blob.split("\0");
    if (parts.length === n) return parts;
    while (parts.length < n) parts.push("");
    return parts.slice(0, n);
  }
  if (mag === "TP08") return decodeTitlePfcSorted(buf);
  if (mag === "FC08") return decodePfc(buf.subarray(4));
  if (mag === "HOA1") return decodeHoa1(buf);
  return decodeCappedTitles(buf);
}

function nthNulBlob(blob: Uint8Array, i: number, cur: { i: number; off: number }): string {
  let n = 0;
  let start = 0;
  if (cur.i <= i) {
    n = cur.i;
    start = cur.off;
  }
  for (let p = start; p <= blob.length; p++) {
    if (p === blob.length || blob[p] === 0) {
      if (n === i) {
        cur.i = i + 1;
        cur.off = p + 1;
        return TD.decode(blob.subarray(start, p));
      }
      n++;
      start = p + 1;
    }
  }
  return "";
}

function decodeTitleNth(buf: Uint8Array, i: number, cur: { i: number; off: number }): string {
  if (i < 0 || buf.byteLength < 4) return "";
  const mag = TD.decode(buf.subarray(0, 4));
  if (mag === "NT08") return nthNulBlob(buf.subarray(4), i, cur);
  if (mag === "SN08") return nthSn08(buf, i);
  if (mag === "RT12") return nthRt12(buf, i, cur);
  if (mag === "RT13") return nthRt13(buf, i, cur);
  if (mag === "RT14") return nthRt14(buf, i, cur);
  if (mag === "BW13") return decodeTitleBody(buf)[i] ?? "";
  return decodeTitleBody(buf)[i] ?? "";
}

/** SA of S$ with virtual sentinel at index n (rank 0). Length n+1. */
function suffixArray(s: Uint8Array): Int32Array {
  const n = s.length;
  const m = n + 1;
  const sa = new Int32Array(m);
  let rnk = new Int32Array(m);
  let nrnk = new Int32Array(m);
  const tmp = new Int32Array(m);
  const cnt = new Int32Array(Math.max(m, 258) + 2);
  for (let i = 0; i < n; i++) {
    sa[i] = i;
    rnk[i] = s[i]! + 1;
  }
  sa[n] = n;
  rnk[n] = 0;
  const sortKey = (getKey: (idx: number) => number, buckets: number) => {
    cnt.fill(0, 0, buckets);
    for (let i = 0; i < m; i++) cnt[getKey(sa[i]!)]!++;
    for (let i = 1; i < buckets; i++) cnt[i]! += cnt[i - 1]!;
    for (let i = m - 1; i >= 0; i--) {
      const v = sa[i]!;
      tmp[--cnt[getKey(v)]!] = v;
    }
    sa.set(tmp);
  };
  for (let k = 1; ; k *= 2) {
    const buckets = Math.max(m + 2, 260);
    sortKey((i) => (i + k < m ? rnk[i + k]! + 1 : 0), buckets);
    sortKey((i) => rnk[i]! + 1, buckets);
    nrnk[sa[0]!] = 0;
    let classes = 1;
    for (let i = 1; i < m; i++) {
      const a = sa[i - 1]!;
      const b = sa[i]!;
      const diff = rnk[a] !== rnk[b] || (a + k < m ? rnk[a + k]! : -1) !== (b + k < m ? rnk[b + k]! : -1);
      if (diff) classes++;
      nrnk[b] = classes - 1;
    }
    const swap = rnk;
    rnk = nrnk;
    nrnk = swap;
    if (classes === m || k >= m) break;
  }
  return sa;
}

function mtfEncode(L: Uint8Array): Uint8Array {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  const out = new Uint8Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const c = L[i]!;
    let j = 0;
    while (table[j] !== c) j++;
    out[i] = j;
    for (let k = j; k > 0; k--) table[k] = table[k - 1]!;
    table[0] = c;
  }
  return out;
}

function mtfDecode(ranks: Uint8Array): Uint8Array {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  const out = new Uint8Array(ranks.length);
  for (let i = 0; i < ranks.length; i++) {
    const j = ranks[i]!;
    const c = table[j]!;
    out[i] = c;
    for (let k = j; k > 0; k--) table[k] = table[k - 1]!;
    table[0] = c;
  }
  return out;
}

function putRunSym(w: Writer, v: number) {
  if (v < 255) {
    w.u8(v);
    return;
  }
  w.u8(255);
  w.vbyte(v - 255);
}

function takeRunSym(r: Reader): number {
  const b = r.u8();
  return b < 255 ? b : 255 + r.vbyte();
}

/** bzip2 RUNA/RUNB: zeros as binary of (run+1) LSB-first; other MTF ranks +1. */
function runEncode(mtf: Uint8Array, w: Writer) {
  const n = mtf.length;
  let i = 0;
  while (i < n) {
    if (mtf[i] === 0) {
      let run = 0;
      while (i < n && mtf[i] === 0) {
        run++;
        i++;
      }
      let x = run + 1;
      while (x > 1) {
        putRunSym(w, x & 1);
        x >>= 1;
      }
      continue;
    }
    putRunSym(w, mtf[i]! + 1);
    i++;
  }
}

function runDecode(r: Reader, n: number): Uint8Array {
  const mtf = new Uint8Array(n);
  let outI = 0;
  let run = 0;
  let place = 1;
  const flush = () => {
    while (run > 0 && outI < n) {
      mtf[outI++] = 0;
      run--;
    }
    run = 0;
    place = 1;
  };
  while (outI < n && r.off < r.end) {
    const v = takeRunSym(r);
    if (v === 0) {
      run += place;
      place *= 2;
      continue;
    }
    if (v === 1) {
      run += place * 2;
      place *= 2;
      continue;
    }
    flush();
    if (outI < n) mtf[outI++] = v - 1;
  }
  flush();
  return mtf;
}

/** Inverse BWT of S$. `stored` is last column without the sentinel; insert 0 at `primary` (bytes shifted +1). */
function inverseBwt(stored: Uint8Array, primary: number): Uint8Array {
  const n = stored.length;
  const m = n + 1;
  const L = new Uint16Array(m);
  for (let i = 0; i < primary; i++) L[i] = stored[i]! + 1;
  L[primary] = 0;
  for (let i = primary + 1; i < m; i++) L[i] = stored[i - 1]! + 1;
  const C = new Int32Array(257);
  for (let i = 0; i < m; i++) C[L[i]!]!++;
  let sum = 0;
  for (let c = 0; c < 257; c++) {
    const t = C[c]!;
    C[c] = sum;
    sum += t;
  }
  const LF = new Int32Array(m);
  for (let i = 0; i < m; i++) LF[i] = C[L[i]!]!++;
  const out = new Uint8Array(n);
  let i = primary;
  for (let p = n - 1; p >= 0; p--) {
    i = LF[i]!;
    out[p] = L[i]! - 1;
  }
  return out;
}

/**
 * BW13: BWT of RFC-order titles joined with NUL, then MTF, then bzip2 RUNA/RUNB.
 * Vocab is the byte stream in the blob. Outer brotli sees a u8-heavy RUN sequence.
 */
function encodeBw13(titles: string[]): Uint8Array {
  if (!titles.length) return EMPTY_U8;
  const s = TE.encode(titles.join("\0"));
  const n = s.length;
  if (!n) return EMPTY_U8;
  const sa = suffixArray(s);
  const L = new Uint8Array(n);
  let primary = 0;
  let wi = 0;
  for (let i = 0; i < n + 1; i++) {
    const p = sa[i]!;
    if (p === 0) {
      primary = i;
      continue;
    }
    L[wi++] = s[p - 1]!;
  }
  const mtf = mtfEncode(L);
  const w = new Writer();
  w.utf8("BW13");
  w.u32(n);
  w.u32(primary);
  runEncode(mtf, w);
  return w.finish();
}

const BW13_CACHE = new WeakMap<Uint8Array, string[]>();

function decodeBw13(buf: Uint8Array): string[] {
  const hit = BW13_CACHE.get(buf);
  if (hit) return hit;
  if (buf.byteLength < 12 || TD.decode(buf.subarray(0, 4)) !== "BW13") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u32();
  const primary = r.u32();
  if (!n || primary > n) return [];
  const mtf = runDecode(r, n);
  const L = mtfDecode(mtf);
  const raw = inverseBwt(L, primary);
  const blob = TD.decode(raw);
  const out = blob ? blob.split("\0") : [];
  BW13_CACHE.set(buf, out);
  return out;
}

/** Drop lone spaces; keep punctuation that already includes spaces (`): `). */
const TITLE_NS_PART = /([^A-Za-z0-9]+)/;
const TITLE_NS_AL = /^[A-Za-z0-9]+$/;

function titleNospace(t: string): string[] {
  return t.split(TITLE_NS_PART).filter((x) => x.length > 0 && x !== " ");
}

function titleReconstruct(ps: string[]): string {
  let s = "";
  let prevAl = false;
  for (const p of ps) {
    const al = TITLE_NS_AL.test(p);
    if (s && prevAl && al) s += " ";
    s += p;
    prevAl = al;
  }
  return s;
}

type RtPrep = {
  seqs: string[][];
  vocab: string[];
  order: number[];
  freq: Map<string, number>;
  freqId: Map<string, number>;
};

function rtPrep(titles: string[]): RtPrep | undefined {
  if (!titles.length) return;
  const seqs = titles.map(titleNospace);
  for (let i = 0; i < titles.length; i++) {
    if (titleReconstruct(seqs[i]!) !== titles[i]) return;
  }
  const freq = new Map<string, number>();
  for (const ps of seqs) for (const p of ps) freq.set(p, (freq.get(p) ?? 0) + 1);
  const vocab = [...freq.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const order = vocab.map((_, i) => i);
  order.sort((a, b) => freq.get(vocab[b]!)! - freq.get(vocab[a]!)! || a - b);
  const freqId = new Map<string, number>();
  for (let r = 0; r < order.length; r++) freqId.set(vocab[order[r]!]!, r + 1);
  return { seqs, vocab, order, freq, freqId };
}

/**
 * RT12: self-contained RFC-title column. Alpha PFC vocab + freq-rank token ids
 * (0-terminated, RFC order). Spaces reconstructed like RT11. Vocab lives in the
 * blob — decode does not open rfc-titles.bin / rfc-vocab.ts.
 */
function encodeRt12From(p: RtPrep): Uint8Array {
  const { seqs, vocab, freq, freqId } = p;
  const w = new Writer();
  w.utf8("RT12");
  const vp = encodePfc(vocab);
  w.u32(vp.length);
  w.bytes(vp);
  for (const tok of vocab) w.vbyte(freq.get(tok)!);
  w.u32(seqs.length);
  for (const ps of seqs) {
    for (const part of ps) w.vbyte(freqId.get(part)!);
    w.vbyte(0);
  }
  return w.finish();
}

function encodeRt12(titles: string[]): Uint8Array {
  const p = rtPrep(titles);
  return p ? encodeRt12From(p) : EMPTY_U8;
}

function freqVocabOf(p: RtPrep): string[] {
  return p.order.map((i) => p.vocab[i]!);
}

function encodeNulVocab(vocab: string[]): Uint8Array {
  return TE.encode(vocab.join("\0"));
}

/**
 * RT14: vocab in frequency order (NUL-joined, no lex PFC + count table), then
 * 0-terminated freq-rank ids in RFC order. Spaces via titleReconstruct.
 */
function encodeRt14From(p: RtPrep): Uint8Array {
  const { seqs, freqId } = p;
  const vocab = freqVocabOf(p);
  const w = new Writer();
  w.utf8("RT14");
  const blob = encodeNulVocab(vocab);
  w.u32(blob.length);
  w.bytes(blob);
  w.u32(seqs.length);
  for (const ps of seqs) {
    for (const part of ps) w.vbyte(freqId.get(part)!);
    w.vbyte(0);
  }
  return w.finish();
}

function encodeRt14(titles: string[]): Uint8Array {
  const p = rtPrep(titles);
  return p ? encodeRt14From(p) : EMPTY_U8;
}

function decodeRt14Vocab(buf: Uint8Array): { vocab: string[]; seqOff: number; n: number } | undefined {
  if (buf.byteLength < 12 || TD.decode(buf.subarray(0, 4)) !== "RT14") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const vlen = r.u32();
  const raw = buf.subarray(r.off, r.off + vlen);
  r.off += vlen;
  const vocab =
    raw.byteLength >= 4 && TD.decode(raw.subarray(0, 4)) === "WD07"
      ? decodeIntern(raw)
      : raw.byteLength
        ? TD.decode(raw).split("\0")
        : [];
  const n = r.u32();
  return { vocab, seqOff: r.off, n };
}

function decodeRt14(buf: Uint8Array): string[] {
  const head = decodeRt14Vocab(buf);
  if (!head) return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), head.seqOff, buf.byteLength);
  const { vocab, n } = head;
  const out: string[] = [];
  for (let i = 0; i < n && r.off < r.end; i++) {
    const parts: string[] = [];
    for (;;) {
      if (r.off >= r.end) break;
      const id = r.vbyte();
      if (id === 0) break;
      parts.push(vocab[id - 1] ?? "");
    }
    out.push(titleReconstruct(parts));
  }
  return out;
}

const RT14_HEAD = new WeakMap<Uint8Array, { vocab: string[]; seqOff: number; n: number }>();

function rt14Head(buf: Uint8Array) {
  const hit = RT14_HEAD.get(buf);
  if (hit) return hit;
  const head = decodeRt14Vocab(buf);
  if (head) RT14_HEAD.set(buf, head);
  return head;
}

function nthRt14(buf: Uint8Array, i: number, cur: { i: number; off: number }): string {
  const head = rt14Head(buf);
  if (!head || i < 0 || i >= head.n) return "";
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), head.seqOff, buf.byteLength);
  let n = 0;
  if (cur.i <= i && cur.off >= head.seqOff) {
    n = cur.i;
    r.off = cur.off;
  }
  const { vocab } = head;
  while (n <= i && r.off < r.end) {
    const parts: string[] = [];
    for (;;) {
      if (r.off >= r.end) break;
      const id = r.vbyte();
      if (id === 0) break;
      parts.push(vocab[id - 1] ?? "");
    }
    if (n === i) {
      cur.i = i + 1;
      cur.off = r.off;
      return titleReconstruct(parts);
    }
    n++;
  }
  return "";
}

/** 0=lower, 1=Title, 2=ALLCAPS, 3=mixed (store original). */
function caseTag(tok: string): number {
  let hasU = false;
  let hasL = false;
  for (let i = 0; i < tok.length; i++) {
    const c = tok.charCodeAt(i);
    if (c >= 65 && c <= 90) hasU = true;
    else if (c >= 97 && c <= 122) hasL = true;
  }
  if (!hasU) return 0;
  if (!hasL) return 2;
  const title = tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
  return tok === title ? 1 : 3;
}

function applyCase(tok: string, tag: number): string {
  if (tok !== tok.toLowerCase()) return tok;
  if (tag === 1 && tok.length) return tok.charAt(0).toUpperCase() + tok.slice(1);
  if (tag === 2) return tok.toUpperCase();
  return tok;
}

function packCaseTags(tags: number[]): Uint8Array {
  const out = new Uint8Array((tags.length + 3) >> 2);
  for (let i = 0; i < tags.length; i++) out[i >> 2]! |= (tags[i]! & 3) << ((i & 3) << 1);
  return out;
}

function caseTagAt(bits: Uint8Array, i: number): number {
  return (bits[i >> 2]! >> ((i & 3) << 1)) & 3;
}

type LcPrep = { keys: string[][]; tags: number[][]; vocab: string[]; freqId: Map<string, number> };

function lcPrep(titles: string[]): LcPrep | undefined {
  if (!titles.length) return;
  const parts = titles.map(titleNospace);
  for (let i = 0; i < titles.length; i++) {
    if (titleReconstruct(parts[i]!) !== titles[i]) return;
  }
  const keys: string[][] = [];
  const tags: number[][] = [];
  const freq = new Map<string, number>();
  for (const ps of parts) {
    const ks: string[] = [];
    const ts: number[] = [];
    for (const p of ps) {
      const tag = caseTag(p);
      const key = tag === 3 ? p : p.toLowerCase();
      if (applyCase(key, tag === 3 ? 0 : tag) !== p) return;
      ks.push(key);
      ts.push(tag === 3 ? 0 : tag);
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
    keys.push(ks);
    tags.push(ts);
  }
  const vocab = [...freq.keys()].sort((a, b) => freq.get(b)! - freq.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  const freqId = new Map(vocab.map((w, i) => [w, i + 1]));
  return { keys, tags, vocab, freqId };
}

/**
 * LC14: freq-ordered vocab (lowercase when caseTag is 0/1/2; original if mixed),
 * packed 2-bit case tags per token, then 0-terminated freq-rank ids.
 */
function encodeLc14From(p: LcPrep): Uint8Array {
  const { keys, tags, vocab, freqId } = p;
  const flat: number[] = [];
  for (const row of tags) for (const t of row) flat.push(t);
  const w = new Writer();
  w.utf8("LC14");
  const blob = encodeNulVocab(vocab);
  w.u32(blob.length);
  w.bytes(blob);
  w.u32(keys.length);
  w.u32(flat.length);
  w.bytes(packCaseTags(flat));
  for (let i = 0; i < keys.length; i++) {
    for (const k of keys[i]!) w.vbyte(freqId.get(k)!);
    w.vbyte(0);
  }
  return w.finish();
}

function encodeLc14(titles: string[]): Uint8Array {
  const p = lcPrep(titles);
  return p ? encodeLc14From(p) : EMPTY_U8;
}

function decodeLc14(buf: Uint8Array): string[] {
  if (buf.byteLength < 16 || TD.decode(buf.subarray(0, 4)) !== "LC14") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const vlen = r.u32();
  const vocab = vlen ? TD.decode(buf.subarray(r.off, r.off + vlen)).split("\0") : [];
  r.off += vlen;
  const n = r.u32();
  const nTok = r.u32();
  const blen = (nTok + 3) >> 2;
  if (r.off + blen > r.end) return [];
  const bits = buf.subarray(r.off, r.off + blen);
  r.off += blen;
  const out: string[] = [];
  let ti = 0;
  for (let i = 0; i < n && r.off < r.end; i++) {
    const parts: string[] = [];
    for (;;) {
      if (r.off >= r.end) break;
      const id = r.vbyte();
      if (id === 0) break;
      const tok = vocab[id - 1] ?? "";
      parts.push(applyCase(tok, caseTagAt(bits, ti++)));
    }
    out.push(titleReconstruct(parts));
  }
  return out;
}

const ACR_PAREN = /\s+\(([A-Z][A-Z0-9]{1,15})\)/g;

function stripTitleAcronyms(t: string): string {
  ACR_PAREN.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  const re = /\s+\(([A-Z][A-Z0-9]{1,15})\)/g;
  while ((m = re.exec(t))) {
    const acr = m[1]!;
    const words = t.slice(0, m.index).split(/\s+/).filter(Boolean);
    const k = acr.length;
    if (k < 2 || words.length < k) continue;
    const ini = words
      .slice(-k)
      .map((w) => w[0]!)
      .join("");
    if (ini !== acr) continue;
    out += t.slice(last, m.index);
    last = m.index + m[0].length;
  }
  return last ? out + t.slice(last) : t;
}

function restoreTitleAcronyms(t: string): string {
  const colon = t.indexOf(":");
  const head = colon >= 0 ? t.slice(0, colon) : t;
  const tail = colon >= 0 ? t.slice(colon) : "";
  const words = head.split(/\s+/).filter(Boolean);
  let i = words.length;
  while (i > 0 && /^[A-Z]/.test(words[i - 1]!)) i--;
  const run = words.slice(i);
  if (run.length < 2 || run.length > 16) return t;
  const acr = run.map((w) => w[0]!).join("");
  if (!/^[A-Z]+$/.test(acr)) return t;
  const prefix = words.slice(0, i).join(" ");
  const restored = (prefix ? `${prefix} ` : "") + `${run.join(" ")} (${acr})`;
  return restored + tail;
}

function encodeAt11(n: number, bits: Uint8Array, inner: Uint8Array): Uint8Array {
  const w = new Writer();
  w.utf8("AT11");
  w.u32(n);
  const blen = (n + 7) >> 3;
  w.bytes(bits.subarray(0, blen));
  w.bytes(inner);
  return w.finish();
}

function at11Head(buf: Uint8Array): { n: number; bits: Uint8Array; inner: Uint8Array } | undefined {
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== "AT11") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u32();
  const blen = (n + 7) >> 3;
  if (r.off + blen > r.end) return;
  const bits = buf.subarray(r.off, r.off + blen);
  r.off += blen;
  return { n, bits, inner: buf.subarray(r.off) };
}

function decodeAt11(buf: Uint8Array): string[] {
  const head = at11Head(buf);
  if (!head) return [];
  const titles = decodeTitleBody(head.inner);
  const { n, bits } = head;
  const out = titles.slice();
  const lim = Math.min(n, out.length);
  for (let i = 0; i < lim; i++) {
    if (bits[i >> 3]! & (1 << (i & 7))) out[i] = restoreTitleAcronyms(out[i] ?? "");
  }
  return out;
}

function prepareAcrTitles(titles: string[]): { stripped: string[]; bits: Uint8Array; nStrip: number } | undefined {
  if (!titles.length) return;
  const bits = new Uint8Array((titles.length + 7) >> 3);
  const stripped = titles.slice();
  let nStrip = 0;
  for (let i = 0; i < titles.length; i++) {
    const t = titles[i]!;
    const s = stripTitleAcronyms(t);
    if (s === t) continue;
    if (restoreTitleAcronyms(s) !== t) continue;
    stripped[i] = s;
    bits[i >> 3]! |= 1 << (i & 7);
    nStrip++;
  }
  if (!nStrip) return;
  return { stripped, bits, nStrip };
}

function encodeNt08(titles: string[]): Uint8Array {
  const w = new Writer();
  w.utf8("NT08");
  w.bytes(TE.encode(titles.join("\0")));
  return w.finish();
}

/** TM11: token-id columns by position (pad 0), each column vbyte. */
function encodeTm11From(p: RtPrep): Uint8Array {
  const { seqs, freqId } = p;
  const vocab = freqVocabOf(p);
  const n = seqs.length;
  const rows = seqs.map((ps) => ps.map((t) => freqId.get(t)!));
  let maxLen = 0;
  for (const row of rows) if (row.length > maxLen) maxLen = row.length;
  const w = new Writer();
  w.utf8("TM11");
  const blob = encodeNulVocab(vocab);
  w.u32(blob.length);
  w.bytes(blob);
  w.u32(n);
  w.vbyte(maxLen);
  for (let col = 0; col < maxLen; col++) {
    for (let i = 0; i < n; i++) w.vbyte(rows[i]![col] ?? 0);
  }
  return w.finish();
}

function decodeTm11(buf: Uint8Array): string[] {
  if (buf.byteLength < 12 || TD.decode(buf.subarray(0, 4)) !== "TM11") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const vlen = r.u32();
  const vocab = vlen ? TD.decode(buf.subarray(r.off, r.off + vlen)).split("\0") : [];
  r.off += vlen;
  const n = r.u32();
  const maxLen = r.vbyte();
  const parts: string[][] = Array.from({ length: n }, () => []);
  for (let col = 0; col < maxLen; col++) {
    for (let i = 0; i < n; i++) {
      const id = r.vbyte();
      if (id) parts[i]!.push(vocab[id - 1] ?? "");
    }
  }
  return parts.map(titleReconstruct);
}

/** TL11: copy prefix token ids from one of the last 64 titles + literal suffix. */
function encodeTl11From(p: RtPrep): Uint8Array {
  const { seqs, freqId } = p;
  const vocab = freqVocabOf(p);
  const rows = seqs.map((ps) => ps.map((t) => freqId.get(t)!));
  const w = new Writer();
  w.utf8("TL11");
  const blob = encodeNulVocab(vocab);
  w.u32(blob.length);
  w.bytes(blob);
  w.u32(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let bestLook = 0;
    let bestLen = 0;
    const lo = Math.max(0, i - 64);
    for (let j = lo; j < i; j++) {
      const prev = rows[j]!;
      let k = 0;
      const lim = Math.min(row.length, prev.length);
      while (k < lim && row[k] === prev[k]) k++;
      if (k > bestLen) {
        bestLen = k;
        bestLook = i - j;
      }
    }
    if (bestLen >= 2) {
      w.u8(bestLook);
      w.vbyte(bestLen);
      for (let k = bestLen; k < row.length; k++) w.vbyte(row[k]!);
      w.vbyte(0);
    } else {
      w.u8(0);
      for (const id of row) w.vbyte(id);
      w.vbyte(0);
    }
  }
  return w.finish();
}

function decodeTl11(buf: Uint8Array): string[] {
  if (buf.byteLength < 12 || TD.decode(buf.subarray(0, 4)) !== "TL11") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const vlen = r.u32();
  const vocab = vlen ? TD.decode(buf.subarray(r.off, r.off + vlen)).split("\0") : [];
  r.off += vlen;
  const n = r.u32();
  const decoded: number[][] = [];
  const takeTail = (): number[] => {
    const ids: number[] = [];
    for (;;) {
      if (r.off >= r.end) break;
      const id = r.vbyte();
      if (id === 0) break;
      ids.push(id);
    }
    return ids;
  };
  for (let i = 0; i < n && r.off < r.end; i++) {
    const op = r.u8();
    if (op === 0) {
      decoded.push(takeTail());
      continue;
    }
    const matchLen = r.vbyte();
    const src = decoded[i - op];
    const ids = src ? src.slice(0, matchLen) : [];
    ids.push(...takeTail());
    decoded.push(ids);
  }
  return decoded.map((ids) => titleReconstruct(ids.map((id) => vocab[id - 1] ?? "")));
}

function decodeRt12(buf: Uint8Array): string[] {
  if (buf.byteLength < 12 || TD.decode(buf.subarray(0, 4)) !== "RT12") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const plen = r.u32();
  const vocab = decodePfc(buf.subarray(r.off, r.off + plen));
  r.off += plen;
  const counts = new Uint32Array(vocab.length);
  for (let i = 0; i < vocab.length; i++) counts[i] = r.vbyte();
  const order = vocab.map((_, i) => i);
  order.sort((a, b) => counts[b]! - counts[a]! || a - b);
  const n = r.u32();
  const out: string[] = [];
  for (let i = 0; i < n && r.off < r.end; i++) {
    const parts: string[] = [];
    for (;;) {
      if (r.off >= r.end) break;
      const id = r.vbyte();
      if (id === 0) break;
      parts.push(vocab[order[id - 1]!] ?? "");
    }
    out.push(titleReconstruct(parts));
  }
  return out;
}

const RT12_HEAD = new WeakMap<Uint8Array, { vocab: string[]; order: number[]; seqOff: number }>();

function rt12Head(buf: Uint8Array): { vocab: string[]; order: number[]; seqOff: number } | undefined {
  const hit = RT12_HEAD.get(buf);
  if (hit) return hit;
  if (buf.byteLength < 12 || TD.decode(buf.subarray(0, 4)) !== "RT12") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const plen = r.u32();
  const vocab = decodePfc(buf.subarray(r.off, r.off + plen));
  r.off += plen;
  const counts = new Uint32Array(vocab.length);
  for (let i = 0; i < vocab.length; i++) counts[i] = r.vbyte();
  const order = vocab.map((_, i) => i);
  order.sort((a, b) => counts[b]! - counts[a]! || a - b);
  r.u32();
  const head = { vocab, order, seqOff: r.off };
  RT12_HEAD.set(buf, head);
  return head;
}

function nthRt12(buf: Uint8Array, i: number, cur: { i: number; off: number }): string {
  const head = rt12Head(buf);
  if (!head) return "";
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), head.seqOff, buf.byteLength);
  let n = 0;
  if (cur.i <= i && cur.off >= head.seqOff) {
    n = cur.i;
    r.off = cur.off;
  }
  const { vocab, order } = head;
  while (n <= i && r.off < r.end) {
    const parts: string[] = [];
    for (;;) {
      if (r.off >= r.end) break;
      const id = r.vbyte();
      if (id === 0) break;
      parts.push(vocab[order[id - 1]!] ?? "");
    }
    if (n === i) {
      cur.i = i + 1;
      cur.off = r.off;
      return titleReconstruct(parts);
    }
    n++;
  }
  return "";
}

function huffLens(freq: Uint32Array): Uint8Array {
  const n = freq.length;
  const lens = new Uint8Array(n);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i]! > 0) ids.push(i);
  if (ids.length <= 1) {
    if (ids.length === 1) lens[ids[0]!] = 1;
    return lens;
  }
  const N = ids.length;
  const nodeF = new Float64Array(2 * N);
  const parent = new Int32Array(2 * N).fill(-1);
  const heap = new Int32Array(2 * N);
  let hs = 0;
  const less = (a: number, b: number) => nodeF[a]! < nodeF[b]! || (nodeF[a] === nodeF[b] && a < b);
  const swap = (i: number, j: number) => {
    const t = heap[i]!;
    heap[i] = heap[j]!;
    heap[j] = t;
  };
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      swap(i, p);
      i = p;
    }
  };
  const down = (i: number) => {
    for (;;) {
      let m = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < hs && less(heap[l]!, heap[m]!)) m = l;
      if (r < hs && less(heap[r]!, heap[m]!)) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  };
  const push = (x: number) => {
    heap[hs] = x;
    up(hs++);
  };
  const pop = (): number => {
    const top = heap[0]!;
    heap[0] = heap[--hs]!;
    if (hs) down(0);
    return top;
  };
  for (let k = 0; k < N; k++) {
    nodeF[k] = freq[ids[k]!]!;
    push(k);
  }
  let next = N;
  while (hs > 1) {
    const a = pop();
    const b = pop();
    nodeF[next] = nodeF[a]! + nodeF[b]!;
    parent[a] = next;
    parent[b] = next;
    push(next);
    next++;
  }
  const root = next - 1;
  const depth = new Int32Array(next);
  depth[root] = 0;
  for (let i = next - 1; i >= 0; i--) {
    const p = parent[i]!;
    if (p >= 0) depth[i] = depth[p]! + 1;
  }
  for (let k = 0; k < N; k++) {
    const d = depth[k]!;
    lens[ids[k]!] = d < 1 ? 1 : d > 32 ? 32 : d;
  }
  return lens;
}

function huffCanon(lens: Uint8Array): { code: Uint32Array; maxBits: number } {
  const n = lens.length;
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (lens[i]!) syms.push(i);
  syms.sort((a, b) => lens[a]! - lens[b]! || a - b);
  const code = new Uint32Array(n);
  let c = 0;
  let prev = 0;
  let maxBits = 0;
  for (const s of syms) {
    const L = lens[s]!;
    c <<= L - prev;
    code[s] = c;
    c++;
    prev = L;
    if (L > maxBits) maxBits = L;
  }
  return { code, maxBits };
}

type HuffTrie = { s: number; z?: HuffTrie; o?: HuffTrie };

function huffTrie(lens: Uint8Array, code: Uint32Array): HuffTrie {
  const root: HuffTrie = { s: -1 };
  for (let s = 0; s < lens.length; s++) {
    const L = lens[s]!;
    if (!L) continue;
    let n = root;
    const c = code[s]!;
    for (let i = L - 1; i >= 0; i--) {
      if ((c >>> i) & 1) {
        n.o ??= { s: -1 };
        n = n.o;
      } else {
        n.z ??= { s: -1 };
        n = n.z;
      }
    }
    n.s = s;
  }
  return root;
}

function huffPut(buf: Uint8Array, bit: number, code: number, len: number): number {
  for (let i = len - 1; i >= 0; i--) {
    const byte = bit >> 3;
    if ((code >>> i) & 1) buf[byte]! |= 1 << (7 - (bit & 7));
    bit++;
  }
  return bit;
}

function huffGetBit(buf: Uint8Array, bit: number): number {
  return (buf[bit >> 3]! >>> (7 - (bit & 7))) & 1;
}

function huffReadSym(buf: Uint8Array, bit: number, endBit: number, trie: HuffTrie): { s: number; bit: number } {
  let n = trie;
  while (n.s < 0 && bit < endBit) {
    const nxt = huffGetBit(buf, bit++) ? n.o : n.z;
    if (!nxt) return { s: 0, bit };
    n = nxt;
  }
  return { s: n.s < 0 ? 0 : n.s, bit };
}

/**
 * RT13: RT12 vocab/ranks, token stream is canonical Huffman over rank ids
 * (0 = title break) using the stored freqs. Vocab stays in the blob.
 */
function encodeRt13From(p: RtPrep): Uint8Array {
  const { seqs, vocab, order, freq, freqId } = p;
  const hf = new Uint32Array(vocab.length + 1);
  hf[0] = seqs.length;
  for (let r = 0; r < order.length; r++) hf[r + 1] = freq.get(vocab[order[r]!]!)!;
  const lens = huffLens(hf);
  const { code, maxBits } = huffCanon(lens);
  if (!lens[0] || maxBits > 24) return EMPTY_U8;
  let nTok = 0;
  for (const ps of seqs) nTok += ps.length + 1;
  const payload = new Uint8Array((nTok * 32 + 7) >> 3);
  let bit = 0;
  for (const ps of seqs) {
    for (const part of ps) {
      const id = freqId.get(part)!;
      bit = huffPut(payload, bit, code[id]!, lens[id]!);
    }
    bit = huffPut(payload, bit, code[0]!, lens[0]!);
  }
  const w = new Writer();
  w.utf8("RT13");
  const vp = encodePfc(vocab);
  w.u32(vp.length);
  w.bytes(vp);
  for (const tok of vocab) w.vbyte(freq.get(tok)!);
  w.u32(seqs.length);
  w.u32(bit);
  w.bytes(payload.subarray(0, (bit + 7) >> 3));
  return w.finish();
}

function encodeRt13(titles: string[]): Uint8Array {
  const p = rtPrep(titles);
  return p ? encodeRt13From(p) : EMPTY_U8;
}

const RT13_HEAD = new WeakMap<
  Uint8Array,
  { vocab: string[]; order: number[]; trie: HuffTrie; pay: Uint8Array; nbit: number; n: number }
>();

function rt13Head(
  buf: Uint8Array,
): { vocab: string[]; order: number[]; trie: HuffTrie; pay: Uint8Array; nbit: number; n: number } | undefined {
  const hit = RT13_HEAD.get(buf);
  if (hit) return hit;
  if (buf.byteLength < 16 || TD.decode(buf.subarray(0, 4)) !== "RT13") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const plen = r.u32();
  const vocab = decodePfc(buf.subarray(r.off, r.off + plen));
  r.off += plen;
  const counts = new Uint32Array(vocab.length);
  for (let i = 0; i < vocab.length; i++) counts[i] = r.vbyte();
  const order = vocab.map((_, i) => i);
  order.sort((a, b) => counts[b]! - counts[a]! || a - b);
  const n = r.u32();
  const nbit = r.u32();
  const pay = buf.subarray(r.off);
  const hf = new Uint32Array(vocab.length + 1);
  hf[0] = n;
  for (let i = 0; i < order.length; i++) hf[i + 1] = counts[order[i]!]!;
  const lens = huffLens(hf);
  const { code } = huffCanon(lens);
  const trie = huffTrie(lens, code);
  const head = { vocab, order, trie, pay, nbit, n };
  RT13_HEAD.set(buf, head);
  return head;
}

function decodeRt13(buf: Uint8Array): string[] {
  const head = rt13Head(buf);
  if (!head) return [];
  const { vocab, order, trie, pay, nbit, n } = head;
  const out: string[] = [];
  let bit = 0;
  for (let i = 0; i < n && bit < nbit; i++) {
    const parts: string[] = [];
    for (;;) {
      const got = huffReadSym(pay, bit, nbit, trie);
      bit = got.bit;
      if (got.s === 0) break;
      parts.push(vocab[order[got.s - 1]!] ?? "");
    }
    out.push(titleReconstruct(parts));
  }
  return out;
}

function nthRt13(buf: Uint8Array, i: number, cur: { i: number; off: number }): string {
  const head = rt13Head(buf);
  if (!head || i < 0 || i >= head.n) return "";
  const { vocab, order, trie, pay, nbit } = head;
  let n = 0;
  let bit = 0;
  if (cur.i <= i && cur.off <= nbit) {
    n = cur.i;
    bit = cur.off;
  }
  while (n <= i && bit < nbit) {
    const parts: string[] = [];
    for (;;) {
      const got = huffReadSym(pay, bit, nbit, trie);
      bit = got.bit;
      if (got.s === 0) break;
      parts.push(vocab[order[got.s - 1]!] ?? "");
    }
    if (n === i) {
      cur.i = i + 1;
      cur.off = bit;
      return titleReconstruct(parts);
    }
    n++;
  }
  return "";
}

/**
 * RP12: word-level RePair. Vocab in the blob. 0 separates titles. Rule ids start at V+1.
 */
function encodeRp12(titles: string[]): Uint8Array {
  if (!titles.length) return EMPTY_U8;
  const seqs = titles.map(titleNospace);
  for (let i = 0; i < titles.length; i++) {
    if (titleReconstruct(seqs[i]!) !== titles[i]) return EMPTY_U8;
  }
  const freq = new Map<string, number>();
  for (const ps of seqs) for (const p of ps) freq.set(p, (freq.get(p) ?? 0) + 1);
  const vocab = [...freq.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idOf = new Map(vocab.map((w, i) => [w, i + 1]));
  const V = vocab.length;
  let seq: number[] = [];
  for (const ps of seqs) {
    for (const p of ps) seq.push(idOf.get(p)!);
    seq.push(0);
  }
  const left: number[] = [];
  const right: number[] = [];
  const maxRules = seq.length > 8000 ? 400 : 1600;
  const minN = seq.length > 8000 ? 3 : 3;
  while (left.length < maxRules) {
    const pair = new Map<number, number>();
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i]!;
      const b = seq[i + 1]!;
      if (a === 0 || b === 0) continue;
      const k = a * 104729 + b;
      pair.set(k, (pair.get(k) ?? 0) + 1);
    }
    let bestK = -1;
    let bestC = minN - 1;
    for (const [k, c] of pair) {
      if (c > bestC) {
        bestC = c;
        bestK = k;
      }
    }
    if (bestK < 0 || bestC < minN) break;
    const b = bestK % 104729;
    const a = (bestK - b) / 104729;
    const id = V + 1 + left.length;
    left.push(a);
    right.push(b);
    const next: number[] = [];
    for (let i = 0; i < seq.length;) {
      if (i + 1 < seq.length && seq[i] === a && seq[i + 1] === b) {
        next.push(id);
        i += 2;
      } else {
        next.push(seq[i]!);
        i++;
      }
    }
    if (next.length >= seq.length - 2) {
      left.pop();
      right.pop();
      break;
    }
    seq = next;
  }
  const w = new Writer();
  w.utf8("RP12");
  const vp = encodePfc(vocab);
  w.u32(vp.length);
  w.bytes(vp);
  w.u16(left.length);
  for (let i = 0; i < left.length; i++) {
    w.vbyte(left[i]!);
    w.vbyte(right[i]!);
  }
  w.u32(seq.length);
  const maxId = V + left.length;
  w.u8(maxId < 65536 ? 1 : 0);
  if (maxId < 65536) {
    for (const x of seq) w.u16(x);
  } else {
    for (const x of seq) w.vbyte(x);
  }
  return w.finish();
}

function decodeRp12(buf: Uint8Array): string[] {
  if (buf.byteLength < 16 || TD.decode(buf.subarray(0, 4)) !== "RP12") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const plen = r.u32();
  const vocab = decodePfc(buf.subarray(r.off, r.off + plen));
  r.off += plen;
  const V = vocab.length;
  const nRules = r.u16();
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < nRules; i++) {
    left.push(r.vbyte());
    right.push(r.vbyte());
  }
  const nSeq = r.u32();
  const packed = r.u8() === 1;
  const expandTok = (root: number, parts: string[]) => {
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === 0) continue;
      if (id <= V) {
        parts.push(vocab[id - 1] ?? "");
        continue;
      }
      const i = id - V - 1;
      if (i < 0 || i >= left.length) continue;
      stack.push(right[i]!, left[i]!);
    }
  };
  const out: string[] = [];
  let parts: string[] = [];
  for (let i = 0; i < nSeq && r.off < r.end; i++) {
    const id = packed ? r.u16() : r.vbyte();
    if (id === 0) {
      out.push(titleReconstruct(parts));
      parts = [];
      continue;
    }
    expandTok(id, parts);
  }
  if (parts.length) out.push(titleReconstruct(parts));
  return out;
}

/** Sorted unique NUL titles + vbyte RFC-order ids. Brotli sees lex order. */
function encodeSn08(titles: string[]): Uint8Array {
  if (!titles.length) return EMPTY_U8;
  const uniq = [...new Set(titles)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idOf = new Map(uniq.map((t, i) => [t, i]));
  const w = new Writer();
  w.utf8("SN08");
  const blob = TE.encode(uniq.join("\0"));
  w.u32(blob.length);
  w.bytes(blob);
  w.u32(titles.length);
  for (const t of titles) w.vbyte(idOf.get(t) ?? 0);
  return w.finish();
}

function decodeSn08(buf: Uint8Array): string[] {
  if (buf.byteLength < 12 || TD.decode(buf.subarray(0, 4)) !== "SN08") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const blen = r.u32();
  const uniq = TD.decode(buf.subarray(r.off, r.off + blen)).split("\0");
  r.off += blen;
  const n = r.u32();
  const out: string[] = [];
  for (let i = 0; i < n && r.off < r.end; i++) out.push(uniq[r.vbyte()] ?? "");
  return out;
}

function nthSn08(buf: Uint8Array, i: number): string {
  if (buf.byteLength < 12) return "";
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const blen = r.u32();
  const blobStart = r.off;
  r.off += blen;
  const n = r.u32();
  if (i < 0 || i >= n) return "";
  for (let k = 0; k < i; k++) r.vbyte();
  const id = r.vbyte();
  const blob = buf.subarray(blobStart, blobStart + blen);
  let start = 0;
  let u = 0;
  for (let p = 0; p <= blob.length; p++) {
    if (p === blob.length || blob[p] === 0) {
      if (u === id) return TD.decode(blob.subarray(start, p));
      u++;
      start = p + 1;
    }
  }
  return "";
}

/** Lex-sorted unique titles + vbyte index in RFC order. Front-coding beats RFC-order NUL join. */
function encodeTitlePfcSorted(titles: string[]): Uint8Array {
  const uniq = [...new Set(titles)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idOf = new Map(uniq.map((t, i) => [t, i]));
  const w = new Writer();
  w.utf8("TP08");
  const pfc = encodePfc(uniq);
  w.u32(pfc.length);
  w.bytes(pfc);
  w.u32(titles.length);
  for (const t of titles) w.vbyte(idOf.get(t) ?? 0);
  return w.finish();
}

function decodeTitlePfcSorted(buf: Uint8Array): string[] {
  if (buf.byteLength < 12) return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const plen = r.u32();
  const uniq = decodePfc(buf.subarray(r.off, r.off + plen));
  r.off += plen;
  const n = r.u32();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(uniq[r.vbyte()] ?? "");
  return out;
}

/** 255-symbol static table over UTF-8 bytes. Magic FS09. Numeric keys, sampled on large blobs. */
function encodeTitleFsst(titles: string[]): Uint8Array {
  const bytes = TE.encode(titles.join("\0"));
  const stride = bytes.length > 80_000 ? 3 : 1;
  const maxN = bytes.length > 80_000 ? 6 : 8;
  const keyAt = (i: number, n: number) => {
    let k = 0;
    for (let j = 0; j < n; j++) k = k * 256 + bytes[i + j]!;
    return k * 8 + n;
  };
  const freq = new Map<number, number>();
  for (let i = 0; i < bytes.length; i += stride) {
    for (let n = 2; n <= maxN && i + n <= bytes.length; n++) {
      const k = keyAt(i, n);
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  const ranked = [...freq.entries()]
    .map(([k, n]) => {
      const slen = k & 7;
      return { k, score: n * (slen - 1), slen };
    })
    .sort((a, b) => b.score - a.score || b.slen - a.slen)
    .slice(0, 255);
  const symbols: Uint8Array[] = ranked.map((x) => {
    const n = x.slen;
    const s = new Uint8Array(n);
    let p = Math.floor(x.k / 8);
    for (let j = n - 1; j >= 0; j--) {
      s[j] = p & 255;
      p = Math.floor(p / 256);
    }
    return s;
  });
  const idAt = new Map(ranked.map((x, i) => [x.k, i]));
  const encoded = new Writer();
  let i = 0;
  while (i < bytes.length) {
    let hit = -1;
    let hitN = 0;
    for (let n = Math.min(maxN, bytes.length - i); n >= 2; n--) {
      const idx = idAt.get(keyAt(i, n));
      if (idx !== undefined) {
        hit = idx;
        hitN = n;
        break;
      }
    }
    if (hit >= 0) {
      encoded.u8(hit + 1);
      i += hitN;
    } else {
      encoded.u8(0);
      encoded.u8(bytes[i]!);
      i++;
    }
  }
  const w = new Writer();
  w.utf8("FS09");
  w.u16(symbols.length);
  for (const s of symbols) {
    w.u8(s.length);
    w.bytes(s);
  }
  const body = encoded.finish();
  w.u32(body.length);
  w.bytes(body);
  return w.finish();
}

function decodeTitleFsst(buf: Uint8Array): string[] {
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== "FS09") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nSym = r.u16();
  const symbols: Uint8Array[] = [];
  for (let i = 0; i < nSym; i++) {
    const n = r.u8();
    const slice = new Uint8Array(r.view.buffer, r.view.byteOffset + r.off, n);
    r.off += n;
    symbols.push(slice.slice());
  }
  const blen = r.u32();
  const end = Math.min(r.off + blen, r.end);
  const out = new Writer();
  while (r.off < end) {
    const op = r.u8();
    if (op === 0) {
      if (r.off >= end) break;
      out.u8(r.u8());
    } else {
      const s = symbols[op - 1];
      if (s) out.bytes(s);
    }
  }
  return TD.decode(out.finish()).split("\0");
}

/** Byte-pair grammar (RePair-lite). Magic RP09. Dense 8-bit pair counts, then Map. */
function encodeTitleRepair(titles: string[]): Uint8Array {
  const raw = TE.encode(titles.join("\0"));
  let seq = Array.from(raw);
  const rules: number[] = [];
  const maxRules = raw.length > 80_000 ? 48 : 2048;
  const dense = new Uint32Array(65536);
  while (rules.length / 2 < maxRules && seq.length > 128) {
    let bestK = -1;
    let bestN = 3;
    let allByte = true;
    for (let i = 0; i < seq.length - 1; i++) {
      if (seq[i]! > 255 || seq[i + 1]! > 255) {
        allByte = false;
        break;
      }
    }
    if (allByte) {
      dense.fill(0);
      for (let i = 0; i < seq.length - 1; i++) {
        const k = (seq[i]! << 8) | seq[i + 1]!;
        const n = ++dense[k]!;
        if (n > bestN) {
          bestN = n;
          bestK = k;
        }
      }
      if (bestK >= 0) bestK = ((bestK >>> 8) << 16) | (bestK & 255);
    } else {
      const freq = new Map<number, number>();
      for (let i = 0; i < seq.length - 1; i++) {
        const k = (seq[i]! << 16) | seq[i + 1]!;
        freq.set(k, (freq.get(k) ?? 0) + 1);
      }
      for (const [k, n] of freq) {
        if (n > bestN) {
          bestN = n;
          bestK = k;
        }
      }
    }
    if (bestK < 0) break;
    const a = (bestK >>> 16) & 0xffff;
    const b = bestK & 0xffff;
    const id = 256 + rules.length / 2;
    if (id > 0xfffe) break;
    rules.push(a, b);
    const next: number[] = [];
    for (let i = 0; i < seq.length;) {
      if (i + 1 < seq.length && seq[i] === a && seq[i + 1] === b) {
        next.push(id);
        i += 2;
      } else {
        next.push(seq[i]!);
        i++;
      }
    }
    if (next.length >= seq.length - 8) {
      rules.length -= 2;
      break;
    }
    seq = next;
  }
  const w = new Writer();
  w.utf8("RP09");
  w.u16(rules.length / 2);
  for (const n of rules) w.vbyte(n);
  w.u32(seq.length);
  for (const n of seq) w.vbyte(n);
  return w.finish();
}

function decodeTitleRepair(buf: Uint8Array): string[] {
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== "RP09") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nRules = r.u16();
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < nRules; i++) {
    left.push(r.vbyte());
    right.push(r.vbyte());
  }
  const nSeq = r.u32();
  const out = new Writer();
  const expand = (root: number) => {
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      if (id < 256) {
        out.u8(id);
        continue;
      }
      const i = id - 256;
      if (i < 0 || i >= left.length) continue;
      stack.push(right[i]!, left[i]!);
    }
  };
  for (let i = 0; i < nSeq && r.off < r.end; i++) expand(r.vbyte());
  return TD.decode(out.finish()).split("\0");
}

const TITLE_PART = /([^A-Za-z0-9]+)/;

function titleToks(t: string): string[] {
  return t.split(TITLE_PART).filter((x) => x.length > 0);
}

/** Decoder-table word ids (rfc-vocab.ts). Magic BV09. Vocab is not stored in the pack. */
function encodeTitleBaked(titles: string[]): Uint8Array {
  const idOf = new Map(RFC_TITLE_VOCAB.map((w, i) => [w, i + 1]));
  const w = new Writer();
  w.utf8("BV09");
  w.u32(titles.length);
  for (const t of titles) {
    const parts = titleToks(t);
    w.vbyte(parts.length);
    for (const p of parts) {
      const id = idOf.get(p);
      if (id) w.vbyte(id);
      else {
        w.vbyte(0);
        const b = TE.encode(p);
        w.vbyte(b.length);
        w.bytes(b);
      }
    }
  }
  return w.finish();
}

function decodeTitleBaked(buf: Uint8Array): string[] {
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== "BV09") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.u32();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = r.vbyte();
    const parts: string[] = [];
    for (let j = 0; j < k; j++) {
      const id = r.vbyte();
      if (id === 0) parts.push(r.utf8(r.vbyte()));
      else parts.push(RFC_TITLE_VOCAB[id - 1] ?? "");
    }
    out.push(parts.join(""));
  }
  return out;
}

/** Sorted-vocab PFC + packed word ids + utf8 escapes (space tokens). */
function encodeTitleWordDict(titles: string[], cap?: number): Uint8Array {
  const partsList = titles.map((t) => t.split(/\s+/).filter(Boolean));
  const freq = new Map<string, number>();
  for (const parts of partsList) for (const w of parts) freq.set(w, (freq.get(w) ?? 0) + 1);
  let vocab: string[];
  if (cap !== undefined && cap < freq.size) {
    vocab = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, cap)
      .map((x) => x[0])
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } else {
    vocab = [...freq.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  const idOf = new Map(vocab.map((w, i) => [w, i + 1]));
  const inner = (magic: string) => {
    const w = new Writer();
    w.utf8(magic);
    const vocabPfc = encodePfc(vocab);
    w.u32(vocabPfc.length);
    w.bytes(vocabPfc);
    w.u32(titles.length);
    for (const parts of partsList) {
      w.vbyte(parts.length);
      for (const p of parts) {
        const id = idOf.get(p);
        if (id) w.vbyte(id);
        else {
          w.vbyte(0);
          const b = TE.encode(p);
          w.vbyte(b.length);
          w.bytes(b);
        }
      }
    }
    return w.finish();
  };
  const wd = inner("WD08");
  const rt = inner("RT07");
  return wd.length <= rt.length ? wd : rt;
}

function uniqueSortedDests(m: Map<number, number[]>, src: number): number[] {
  return [...new Set(m.get(src)!)].sort((a, b) => a - b);
}

function titlesAllShipped(rows: { n: number; title: string }[]): boolean {
  if (!rows.length) return false;
  for (const r of rows) if (rfcTitleOf(r.n) !== r.title) return false;
  return true;
}

function edgeMapCanon(m: Map<number, number[]>): string {
  const keys = [...m.keys()].sort((a, b) => a - b);
  return keys.map((k) => `${k}:${uniqueSortedDests(m, k).join(",")}`).join(";");
}

function edgeRowsCanon(rows: { src: number; dests: number[] }[]): string {
  const m = new Map<number, number[]>();
  for (const r of rows) {
    const prev = m.get(r.src);
    if (prev) prev.push(...r.dests);
    else m.set(r.src, r.dests.slice());
  }
  return edgeMapCanon(m);
}

function edgesMatchShipped(obs: Map<number, number[]>, upd: Map<number, number[]>): boolean {
  try {
    const e = loadRfcEdges();
    return edgeMapCanon(obs) === edgeRowsCanon(e.obs) && edgeMapCanon(upd) === edgeRowsCanon(e.upd);
  } catch {
    return false;
  }
}

function rfcSetIsShippedUniverse(nums: number[]): boolean {
  const u = implicitRfcUniverse();
  if (nums.length !== u.count) return false;
  for (let i = 0; i < nums.length; i++) if (nums[i] !== u.nums[i]) return false;
  return true;
}

function sameSorted(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bitsEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function encodeEg08(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const w = new Writer();
  w.utf8("EG08");
  const put = (m: Map<number, number[]>) => {
    const keys = [...m.keys()].sort((a, b) => a - b);
    w.u32(keys.length);
    let prev = 0;
    for (const src of keys) {
      w.vbyte(src - prev);
      prev = src;
      const dests = uniqueSortedDests(m, src);
      w.vbyte(dests.length);
      let pd = 0;
      for (const d of dests) {
        w.vbyte(zig(d - pd));
        pd = d;
      }
    }
  };
  put(obs);
  put(upd);
  return w.finish();
}

/**
 * EG09: CSR (all src deltas, then dests). Singleton obs omit per-src counts.
 * Dests are unique-sorted unsigned deltas so zigzag of large RFC numbers is gone.
 */
function encodeEg09(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const w = new Writer();
  w.utf8("EG09");
  const put = (m: Map<number, number[]>, preferSingle: boolean) => {
    const keys = [...m.keys()].sort((a, b) => a - b);
    const allSingle = preferSingle && keys.every((k) => uniqueSortedDests(m, k).length === 1);
    w.u8(allSingle ? 1 : 0);
    w.u32(keys.length);
    let prev = 0;
    for (const src of keys) {
      w.vbyte(src - prev);
      prev = src;
    }
    for (const src of keys) {
      const dests = uniqueSortedDests(m, src);
      if (!allSingle) w.vbyte(dests.length);
      let pd = 0;
      for (const d of dests) {
        w.vbyte(d - pd);
        pd = d;
      }
    }
  };
  put(obs, true);
  put(upd, false);
  return w.finish();
}

/**
 * EG10 (KG12 only): obs = interleaved delta-src + zigzag(dest-src) for singletons
 * (almost all dest < src). Updates stay CSR + unsigned dest deltas like EG09.
 * Counts are vbyte. Decode of EG09 is kept.
 */
function encodeEg10(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const w = new Writer();
  w.utf8("EG10");
  const obsKeys = [...obs.keys()].sort((a, b) => a - b);
  const obsDests = obsKeys.map((k) => uniqueSortedDests(obs, k));
  const obsSingle = obsDests.every((d) => d.length === 1);
  w.u8(obsSingle ? 1 : 0);
  w.vbyte(obsKeys.length);
  if (obsSingle) {
    let prev = 0;
    for (let i = 0; i < obsKeys.length; i++) {
      const src = obsKeys[i]!;
      w.vbyte(src - prev);
      prev = src;
      w.vbyte(zig(obsDests[i]![0]! - src));
    }
  } else {
    let prev = 0;
    for (const src of obsKeys) {
      w.vbyte(src - prev);
      prev = src;
    }
    for (let i = 0; i < obsKeys.length; i++) {
      const src = obsKeys[i]!;
      const dests = obsDests[i]!;
      w.vbyte(dests.length);
      for (const d of dests) w.vbyte(zig(d - src));
    }
  }
  const updKeys = [...upd.keys()].sort((a, b) => a - b);
  w.vbyte(updKeys.length);
  let prev = 0;
  for (const src of updKeys) {
    w.vbyte(src - prev);
    prev = src;
  }
  for (const src of updKeys) {
    const dests = uniqueSortedDests(upd, src);
    w.vbyte(dests.length);
    let pd = 0;
    for (const d of dests) {
      w.vbyte(d - pd);
      pd = d;
    }
  }
  return w.finish();
}

/**
 * EG11: specialized columns — Rice/interpolative srcs, i16 or Rice dest-src residuals.
 * Obs are almost always singletons (dest < src). Updates keep per-src counts.
 */
function encodeEg11(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const obsKeys = [...obs.keys()].sort((a, b) => a - b);
  const obsDests = obsKeys.map((k) => uniqueSortedDests(obs, k));
  const obsSingle = obsDests.every((d) => d.length === 1);
  const obsFlat: number[] = [];
  const obsRes: number[] = [];
  for (let i = 0; i < obsKeys.length; i++) {
    const src = obsKeys[i]!;
    for (const d of obsDests[i]!) {
      obsFlat.push(d);
      obsRes.push(d - src);
    }
  }
  const updKeys = [...upd.keys()].sort((a, b) => a - b);
  const updDests = updKeys.map((k) => uniqueSortedDests(upd, k));
  const updFlat: number[] = [];
  const updRes: number[] = [];
  const updDeg: number[] = [];
  for (let i = 0; i < updKeys.length; i++) {
    const src = updKeys[i]!;
    const ds = updDests[i]!;
    updDeg.push(ds.length);
    for (const d of ds) {
      updFlat.push(d);
      updRes.push(d - src);
    }
  }
  const obsSrc = pickSrcEnc(obsKeys);
  const updSrc = pickSrcEnc(updKeys);
  const obsD = pickDestEnc(obsRes, obsFlat);
  const updD = pickDestEnc(updRes, updFlat);
  const w = new Writer();
  w.utf8("EG11");
  w.u8(obsSingle ? 1 : 0);
  w.u8(obsSrc.kind);
  w.u8(obsSrc.k);
  w.u8(obsD.kind);
  w.u8(obsD.k);
  w.u8(updSrc.kind);
  w.u8(updSrc.k);
  w.u8(updD.kind);
  w.u8(updD.k);
  w.vbyte(obsKeys.length);
  w.vbyte(obsSrc.buf.length);
  w.bytes(obsSrc.buf);
  if (!obsSingle) {
    for (const d of obsDests) w.vbyte(d.length);
  }
  w.vbyte(obsD.buf.length);
  w.bytes(obsD.buf);
  w.vbyte(updKeys.length);
  w.vbyte(updSrc.buf.length);
  w.bytes(updSrc.buf);
  const degW = new Writer();
  for (const d of updDeg) degW.vbyte(d);
  const degB = degW.finish();
  w.vbyte(degB.length);
  w.bytes(degB);
  w.vbyte(updD.buf.length);
  w.bytes(updD.buf);
  return w.finish();
}

function decodeEg11(
  r: Reader,
  buf: Uint8Array,
): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const obsSingle = r.u8() === 1;
  const obsSrcKind = r.u8();
  const obsSrcK = r.u8();
  const obsDKind = r.u8();
  const obsDK = r.u8();
  const updSrcKind = r.u8();
  const updSrcK = r.u8();
  const updDKind = r.u8();
  const updDK = r.u8();
  const nObs = r.vbyte();
  const obsSrcLen = r.vbyte();
  const obsSrcBuf = buf.subarray(r.off, r.off + obsSrcLen);
  r.off += obsSrcLen;
  const obsSrcs = decodeSrcEnc(obsSrcBuf, nObs, obsSrcKind, obsSrcK);
  const obsDeg: number[] = [];
  if (obsSingle) {
    for (let i = 0; i < nObs; i++) obsDeg.push(1);
  } else {
    for (let i = 0; i < nObs; i++) obsDeg.push(r.vbyte());
  }
  const nObsE = obsDeg.reduce((a, b) => a + b, 0);
  const obsDLen = r.vbyte();
  const obsDBuf = buf.subarray(r.off, r.off + obsDLen);
  r.off += obsDLen;
  const obsPay = decodeDestEnc(obsDBuf, nObsE, obsDKind, obsDK);
  const obs: { src: number; dests: number[] }[] = [];
  let oi = 0;
  for (let i = 0; i < nObs; i++) {
    const src = obsSrcs[i]!;
    const dests: number[] = [];
    const k = obsDeg[i]!;
    for (let j = 0; j < k; j++) {
      const pay = obsPay[oi++]!;
      dests.push(obsDKind === DEST_U16 ? pay : src + pay);
    }
    obs.push({ src, dests });
  }
  const nUpd = r.vbyte();
  const updSrcLen = r.vbyte();
  const updSrcBuf = buf.subarray(r.off, r.off + updSrcLen);
  r.off += updSrcLen;
  const updSrcs = decodeSrcEnc(updSrcBuf, nUpd, updSrcKind, updSrcK);
  const degLen = r.vbyte();
  const degBuf = buf.subarray(r.off, r.off + degLen);
  r.off += degLen;
  const degR = new Reader(new DataView(degBuf.buffer, degBuf.byteOffset, degBuf.byteLength), 0, degBuf.byteLength);
  const updDeg: number[] = [];
  for (let i = 0; i < nUpd; i++) updDeg.push(degR.vbyte());
  const nUpdE = updDeg.reduce((a, b) => a + b, 0);
  const updDLen = r.vbyte();
  const updDBuf = buf.subarray(r.off, r.off + updDLen);
  r.off += updDLen;
  const updPay = decodeDestEnc(updDBuf, nUpdE, updDKind, updDK);
  const upd: { src: number; dests: number[] }[] = [];
  let ui = 0;
  for (let i = 0; i < nUpd; i++) {
    const src = updSrcs[i]!;
    const dests: number[] = [];
    const k = updDeg[i]!;
    for (let j = 0; j < k; j++) {
      const pay = updPay[ui++]!;
      dests.push(updDKind === DEST_U16 ? pay : src + pay);
    }
    upd.push({ src, dests });
  }
  return { obs, upd };
}

const PAIR_BASE = 10040;

function pairIdOf(src: number, dest: number): number {
  return src * PAIR_BASE + dest;
}

function unpairId(id: number): { src: number; dest: number } {
  return { src: (id / PAIR_BASE) | 0, dest: id % PAIR_BASE };
}

function encodePairInterp(m: Map<number, number[]>): { n: number; buf: Uint8Array } {
  const ids: number[] = [];
  for (const src of [...m.keys()].sort((a, b) => a - b)) {
    for (const d of uniqueSortedDests(m, src)) ids.push(pairIdOf(src, d));
  }
  ids.sort((a, b) => a - b);
  return { n: ids.length, buf: encodeInterpNums(ids) };
}

function decodePairInterp(buf: Uint8Array, n: number): { src: number; dests: number[] }[] {
  const ids = decodeInterpNums(buf, n);
  const by = new Map<number, number[]>();
  for (const id of ids) {
    const { src, dest } = unpairId(id);
    const prev = by.get(src);
    if (prev) prev.push(dest);
    else by.set(src, [dest]);
  }
  return [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
}

/** EG12: one increasing (src*10040+dest) stream per predicate, binary interpolative. */
function encodeEg12(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const o = encodePairInterp(obs);
  const u = encodePairInterp(upd);
  const w = new Writer();
  w.utf8("EG12");
  w.vbyte(o.n);
  w.vbyte(o.buf.length);
  w.bytes(o.buf);
  w.vbyte(u.n);
  w.vbyte(u.buf.length);
  w.bytes(u.buf);
  return w.finish();
}

function decodeEg12(
  r: Reader,
  buf: Uint8Array,
): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const nObs = r.vbyte();
  const oLen = r.vbyte();
  const oBuf = buf.subarray(r.off, r.off + oLen);
  r.off += oLen;
  const nUpd = r.vbyte();
  const uLen = r.vbyte();
  const uBuf = buf.subarray(r.off, r.off + uLen);
  r.off += uLen;
  return { obs: decodePairInterp(oBuf, nObs), upd: decodePairInterp(uBuf, nUpd) };
}

function encodeRfcEdges(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const a = encodeEg08(obs, upd);
  const b = encodeEg09(obs, upd);
  return b.length <= a.length ? b : a;
}

function decodeEg08(r: Reader): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const take = () => {
    const n = r.u32();
    const out: { src: number; dests: number[] }[] = [];
    let prev = 0;
    for (let i = 0; i < n; i++) {
      prev += r.vbyte();
      const k = r.vbyte();
      const dests: number[] = [];
      let pd = 0;
      for (let j = 0; j < k; j++) {
        pd += unzig(r.vbyte());
        dests.push(pd);
      }
      out.push({ src: prev, dests });
    }
    return out;
  };
  return { obs: take(), upd: take() };
}

function decodeEg09(r: Reader): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const take = () => {
    const single = r.u8() === 1;
    const n = r.u32();
    const srcs: number[] = [];
    let prev = 0;
    for (let i = 0; i < n; i++) {
      prev += r.vbyte();
      srcs.push(prev);
    }
    const out: { src: number; dests: number[] }[] = [];
    for (const src of srcs) {
      const k = single ? 1 : r.vbyte();
      const dests: number[] = [];
      let pd = 0;
      for (let j = 0; j < k; j++) {
        pd += r.vbyte();
        dests.push(pd);
      }
      out.push({ src, dests });
    }
    return out;
  };
  return { obs: take(), upd: take() };
}

function decodeEg10(r: Reader): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const obsSingle = r.u8() === 1;
  const nObs = r.vbyte();
  const obs: { src: number; dests: number[] }[] = [];
  if (obsSingle) {
    let prev = 0;
    for (let i = 0; i < nObs && r.off < r.end; i++) {
      prev += r.vbyte();
      obs.push({ src: prev, dests: [prev + unzig(r.vbyte())] });
    }
  } else {
    const srcs: number[] = [];
    let prev = 0;
    for (let i = 0; i < nObs && r.off < r.end; i++) {
      prev += r.vbyte();
      srcs.push(prev);
    }
    for (const src of srcs) {
      const k = r.vbyte();
      const dests: number[] = [];
      for (let j = 0; j < k; j++) dests.push(src + unzig(r.vbyte()));
      obs.push({ src, dests });
    }
  }
  const nUpd = r.vbyte();
  const updSrcs: number[] = [];
  let prev = 0;
  for (let i = 0; i < nUpd && r.off < r.end; i++) {
    prev += r.vbyte();
    updSrcs.push(prev);
  }
  const upd: { src: number; dests: number[] }[] = [];
  for (const src of updSrcs) {
    const k = r.vbyte();
    const dests: number[] = [];
    let pd = 0;
    for (let j = 0; j < k; j++) {
      pd += r.vbyte();
      dests.push(pd);
    }
    upd.push({ src, dests });
  }
  return { obs, upd };
}

function encodePairEf(m: Map<number, number[]>): { n: number; buf: Uint8Array } {
  const ids: number[] = [];
  for (const src of [...m.keys()].sort((a, b) => a - b)) {
    for (const d of uniqueSortedDests(m, src)) ids.push(pairIdOf(src, d));
  }
  ids.sort((a, b) => a - b);
  return { n: ids.length, buf: encodeEliasFano(ids, PAIR_BASE * PAIR_BASE) };
}

function decodePairEf(buf: Uint8Array): { src: number; dests: number[] }[] {
  const ids = decodeEliasFano(buf);
  const by = new Map<number, number[]>();
  for (const id of ids) {
    const { src, dest } = unpairId(id);
    const prev = by.get(src);
    if (prev) prev.push(dest);
    else by.set(src, [dest]);
  }
  return [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
}

/** EG13: Elias-Fano pair-ids, or src-gap + zig-rice dest residuals — pick smaller. */
function encodeEg13(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const ef = (() => {
    const o = encodePairEf(obs);
    const u = encodePairEf(upd);
    const w = new Writer();
    w.utf8("EG13");
    w.u8(0);
    w.vbyte(o.buf.length);
    w.bytes(o.buf);
    w.vbyte(u.buf.length);
    w.bytes(u.buf);
    return w.finish();
  })();
  const rice = (() => {
    const put = (m: Map<number, number[]>, bw: BitWriter) => {
      const keys = [...m.keys()].sort((a, b) => a - b);
      bw.rice(keys.length, 4);
      let prev = 0;
      for (const src of keys) {
        bw.rice(src - prev, 3);
        prev = src;
        const dests = uniqueSortedDests(m, src);
        bw.rice(dests.length, 1);
        for (const d of dests) bw.rice(zig(d - src), 8);
      }
    };
    const bw = new BitWriter();
    put(obs, bw);
    put(upd, bw);
    const body = bw.finish();
    const w = new Writer();
    w.utf8("EG13");
    w.u8(1);
    w.bytes(body);
    return w.finish();
  })();
  return rice.byteLength < ef.byteLength ? rice : ef;
}

function pairIdsOf(m: Map<number, number[]>): number[] {
  const ids: number[] = [];
  for (const src of [...m.keys()].sort((a, b) => a - b)) {
    for (const d of uniqueSortedDests(m, src)) ids.push(pairIdOf(src, d));
  }
  ids.sort((a, b) => a - b);
  return ids;
}

function encodePairDelta(m: Map<number, number[]>): Uint8Array {
  return encodePairIdDelta(pairIdsOf(m));
}

function encodePairIdDelta(ids: number[]): Uint8Array {
  const w = new Writer();
  w.vbyte(ids.length);
  let prev = 0;
  for (const id of ids) {
    w.vbyte(id - prev);
    prev = id;
  }
  return w.finish();
}

function decodePairIdDeltaFrom(r: Reader): number[] {
  const n = r.vbyte();
  const ids: number[] = [];
  let prev = 0;
  for (let i = 0; i < n && r.off < r.end; i++) {
    prev += r.vbyte();
    ids.push(prev);
  }
  return ids;
}

function idsToEdgesBase(ids: number[], base: number): { src: number; dests: number[] }[] {
  const by = new Map<number, number[]>();
  for (const id of ids) {
    const src = (id / base) | 0;
    const dest = id % base;
    const list = by.get(src);
    if (list) list.push(dest);
    else by.set(src, [dest]);
  }
  return [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
}

function decodePairDeltaFrom(r: Reader): { src: number; dests: number[] }[] {
  const n = r.vbyte();
  const by = new Map<number, number[]>();
  let prev = 0;
  for (let i = 0; i < n && r.off < r.end; i++) {
    prev += r.vbyte();
    const { src, dest } = unpairId(prev);
    const list = by.get(src);
    if (list) list.push(dest);
    else by.set(src, [dest]);
  }
  return [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
}

function decodePairDelta(buf: Uint8Array): { src: number; dests: number[] }[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  return decodePairDeltaFrom(r);
}

/** EG14: sorted (src*10040+dest) pair-id delta vbytes per predicate. Brotli likes the runs. */
function encodeEg14(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const o = encodePairDelta(obs);
  const u = encodePairDelta(upd);
  const w = new Writer();
  w.utf8("EG14");
  w.vbyte(o.length);
  w.bytes(o);
  w.vbyte(u.length);
  w.bytes(u);
  return w.finish();
}

function decodeEg14(
  r: Reader,
  buf: Uint8Array,
): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const oLen = r.vbyte();
  const oBuf = buf.subarray(r.off, r.off + oLen);
  r.off += oLen;
  const uLen = r.vbyte();
  const uBuf = buf.subarray(r.off, r.off + uLen);
  r.off += uLen;
  return { obs: decodePairDelta(oBuf), upd: decodePairDelta(uBuf) };
}

function idsToEdges(ids: number[]): { src: number; dests: number[] }[] {
  const by = new Map<number, number[]>();
  for (const id of ids) {
    const { src, dest } = unpairId(id);
    const prev = by.get(src);
    if (prev) prev.push(dest);
    else by.set(src, [dest]);
  }
  return [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
}

/** EG16: per-predicate pick of delta / interpolative / Elias-Fano / rice pair-ids. */
function encodeEg16Body(m: Map<number, number[]>): Uint8Array {
  const ids = pairIdsOf(m);
  const cands: Uint8Array[] = [];
  const add = (kind: number, extra: (w: Writer) => void) => {
    const w = new Writer();
    w.u8(kind);
    extra(w);
    cands.push(w.finish());
  };
  add(0, (w) => w.bytes(encodePairDelta(m)));
  if (ids.length) {
    add(1, (w) => w.bytes(encodeEliasFano(ids, PAIR_BASE * PAIR_BASE)));
    add(2, (w) => {
      w.vbyte(ids.length);
      w.bytes(encodeInterpNums(ids));
    });
    for (let k = 0; k <= 10; k++) {
      add(3, (w) => {
        w.u8(k);
        w.vbyte(ids.length);
        w.bytes(encodeRiceGaps(ids, k));
      });
    }
  } else {
    add(1, (w) => w.bytes(EMPTY_U8));
  }
  let best = cands[0]!;
  for (const c of cands) if (c.byteLength < best.byteLength) best = c;
  return best;
}

function decodeEg16Body(buf: Uint8Array): { src: number; dests: number[] }[] {
  if (!buf.byteLength) return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const kind = r.u8();
  const rest = buf.subarray(r.off);
  if (kind === 0) return decodePairDelta(rest);
  if (kind === 1) return idsToEdges(decodeEliasFano(rest));
  if (kind === 2) {
    const n = r.vbyte();
    return idsToEdges(decodeInterpNums(buf.subarray(r.off), n));
  }
  if (kind === 3) {
    const k = r.u8();
    const n = r.vbyte();
    return idsToEdges(decodeRiceGaps(buf.subarray(r.off), n, k));
  }
  return [];
}

function encodeEg16(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const o = encodeEg16Body(obs);
  const u = encodeEg16Body(upd);
  const w = new Writer();
  w.utf8("EG16");
  w.vbyte(o.length);
  w.bytes(o);
  w.vbyte(u.length);
  w.bytes(u);
  return w.finish();
}

function decodeEg16(
  r: Reader,
  buf: Uint8Array,
): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const oLen = r.vbyte();
  const oBuf = buf.subarray(r.off, r.off + oLen);
  r.off += oLen;
  const uLen = r.vbyte();
  const uBuf = buf.subarray(r.off, r.off + uLen);
  r.off += uLen;
  return { obs: decodeEg16Body(oBuf), upd: decodeEg16Body(uBuf) };
}

/** EG17: obsoletes as a parent-pointer forest (one dest per src) + residual pairs; updates stay pair-delta. */
function encodeEg17(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const keys = [...obs.keys()].sort((a, b) => a - b);
  const heads: number[] = [];
  const extra = new Map<number, number[]>();
  for (const src of keys) {
    const dests = uniqueSortedDests(obs, src);
    heads.push(dests[0] ?? 0);
    if (dests.length > 1) extra.set(src, dests.slice(1));
  }
  const srcEnc = keys.length ? pickSrcEnc(keys) : { kind: SRC_VBYTE, k: 0, buf: EMPTY_U8 };
  const res = heads.map((d, i) => d - (keys[i] ?? 0));
  const destEnc = heads.length ? pickDestEnc(res, heads) : { kind: DEST_U16, k: 0, buf: EMPTY_U8 };
  const extraB = extra.size ? encodePairDelta(extra) : EMPTY_U8;
  const u = encodePairDelta(upd);
  const w = new Writer();
  w.utf8("EG17");
  w.u8(srcEnc.kind);
  w.u8(srcEnc.k);
  w.vbyte(keys.length);
  w.vbyte(srcEnc.buf.length);
  w.bytes(srcEnc.buf);
  w.u8(destEnc.kind);
  w.u8(destEnc.k);
  w.vbyte(destEnc.buf.length);
  w.bytes(destEnc.buf);
  w.vbyte(extraB.length);
  w.bytes(extraB);
  w.vbyte(u.length);
  w.bytes(u);
  return w.finish();
}

function decodeEg17(
  r: Reader,
  buf: Uint8Array,
): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const srcKind = r.u8();
  const srcK = r.u8();
  const nObs = r.vbyte();
  const srcLen = r.vbyte();
  if (r.off + srcLen > r.end) return { obs: [], upd: [] };
  const srcBuf = buf.subarray(r.off, r.off + srcLen);
  r.off += srcLen;
  const destKind = r.u8();
  const destK = r.u8();
  const destLen = r.vbyte();
  if (r.off + destLen > r.end) return { obs: [], upd: [] };
  const destBuf = buf.subarray(r.off, r.off + destLen);
  r.off += destLen;
  const extraLen = r.vbyte();
  if (r.off + extraLen > r.end) return { obs: [], upd: [] };
  const extraBuf = extraLen ? buf.subarray(r.off, r.off + extraLen) : EMPTY_U8;
  r.off += extraLen;
  const uLen = r.vbyte();
  if (r.off + uLen > r.end) return { obs: [], upd: [] };
  const uBuf = uLen ? buf.subarray(r.off, r.off + uLen) : EMPTY_U8;
  r.off += uLen;
  const srcs = nObs ? decodeSrcEnc(srcBuf, nObs, srcKind, srcK) : [];
  const heads = nObs ? decodeDestEnc(destBuf, nObs, destKind, destK) : [];
  const by = new Map<number, number[]>();
  for (let i = 0; i < srcs.length; i++) {
    const src = srcs[i]!;
    const head = heads[i] ?? 0;
    by.set(src, destKind === DEST_U16 ? [head] : [head + src]);
  }
  if (extraBuf.byteLength) {
    for (const e of decodePairDelta(extraBuf)) {
      const prev = by.get(e.src);
      if (prev) prev.push(...e.dests);
      else by.set(e.src, e.dests.slice());
    }
  }
  for (const [src, dests] of by)
    by.set(
      src,
      [...new Set(dests)].sort((a, b) => a - b),
    );
  const obsOut = [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
  return { obs: obsOut, upd: uBuf.byteLength ? decodePairDelta(uBuf) : [] };
}

/** EG18: one sorted pair-id stream with predicate in the low bit (obs=0, upd=1). */
function encodeEg18(obs: Map<number, number[]>, upd: Map<number, number[]>): Uint8Array {
  const ids: number[] = [];
  for (const src of [...obs.keys()].sort((a, b) => a - b)) {
    for (const d of uniqueSortedDests(obs, src)) ids.push(pairIdOf(src, d) << 1);
  }
  for (const src of [...upd.keys()].sort((a, b) => a - b)) {
    for (const d of uniqueSortedDests(upd, src)) ids.push((pairIdOf(src, d) << 1) | 1);
  }
  ids.sort((a, b) => a - b);
  const w = new Writer();
  w.utf8("EG18");
  w.vbyte(ids.length);
  let prev = 0;
  for (const id of ids) {
    w.vbyte(id - prev);
    prev = id;
  }
  return w.finish();
}

function decodeEg18(r: Reader): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const n = r.vbyte();
  const obsBy = new Map<number, number[]>();
  const updBy = new Map<number, number[]>();
  let prev = 0;
  for (let i = 0; i < n && r.off < r.end; i++) {
    prev += r.vbyte();
    const pred = prev & 1;
    const { src, dest } = unpairId(prev >>> 1);
    const by = pred ? updBy : obsBy;
    const list = by.get(src);
    if (list) list.push(dest);
    else by.set(src, [dest]);
  }
  const pack = (by: Map<number, number[]>) =>
    [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
  return { obs: pack(obsBy), upd: pack(updBy) };
}

function collectEdgeNums(obs: Map<number, number[]>, upd: Map<number, number[]>): number[] {
  const s = new Set<number>();
  const take = (m: Map<number, number[]>) => {
    for (const src of m.keys()) {
      s.add(src);
      for (const d of uniqueSortedDests(m, src)) s.add(d);
    }
  };
  take(obs);
  take(upd);
  return [...s].sort((a, b) => a - b);
}

function mergeUniv(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const s = new Set<number>();
  for (let i = 0; i < a.length; i++) s.add(a[i]!);
  for (let i = 0; i < b.length; i++) s.add(b[i]!);
  return [...s].sort((x, y) => x - y);
}

function compactToNums(buf: Uint8Array): number[] {
  if (!buf.byteLength) return [];
  const p = decodeRfcNumsCompact(buf);
  const u = bitsToNums(p.bits, p.max, p.count);
  const out = new Array<number>(u.length);
  for (let i = 0; i < u.length; i++) out[i] = u[i]!;
  return out;
}

function univHasAll(obs: Map<number, number[]>, upd: Map<number, number[]>, rank: Map<number, number>): boolean {
  const check = (m: Map<number, number[]>) => {
    for (const src of m.keys()) {
      if (!rank.has(src)) return false;
      for (const d of uniqueSortedDests(m, src)) if (!rank.has(d)) return false;
    }
    return true;
  };
  return check(obs) && check(upd);
}

function rankPairIds(m: Map<number, number[]>, rank: Map<number, number>, base: number): number[] {
  const ids: number[] = [];
  for (const src of [...m.keys()].sort((a, b) => a - b)) {
    const rs = rank.get(src);
    if (rs === undefined) return ids;
    for (const d of uniqueSortedDests(m, src)) {
      const rd = rank.get(d);
      if (rd === undefined) return ids;
      ids.push(rs * base + rd);
    }
  }
  ids.sort((a, b) => a - b);
  return ids;
}

function encodeIdDelta(ids: number[]): Uint8Array {
  const w = new Writer();
  w.vbyte(ids.length);
  let prev = 0;
  for (const id of ids) {
    w.vbyte(id - prev);
    prev = id;
  }
  return w.finish();
}

function decodeIdDelta(buf: Uint8Array): number[] {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.vbyte();
  const out = new Array<number>(n);
  let prev = 0;
  for (let i = 0; i < n && r.off < r.end; i++) {
    prev += r.vbyte();
    out[i] = prev;
  }
  return out;
}

function idsToRankEdges(ids: number[], univ: number[], base: number): { src: number; dests: number[] }[] {
  const by = new Map<number, number[]>();
  for (const id of ids) {
    const destR = id % base;
    const srcR = (id / base) | 0;
    const src = univ[srcR];
    const dest = univ[destR];
    if (src === undefined || dest === undefined) continue;
    const prev = by.get(src);
    if (prev) prev.push(dest);
    else by.set(src, [dest]);
  }
  return [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
}

/** Rank-id stream: 0=delta vbytes, 1=Elias-Fano, 2=interpolative, 3=rice-k. */
function encodeRankStream(ids: number[], efU: number, pick: boolean): Uint8Array {
  const add = (kind: number, extra: (w: Writer) => void) => {
    const w = new Writer();
    w.u8(kind);
    extra(w);
    return w.finish();
  };
  const delta = add(0, (w) => w.bytes(encodeIdDelta(ids)));
  if (!pick || !ids.length) return delta;
  const cands = [delta];
  cands.push(add(1, (w) => w.bytes(encodeEliasFano(ids, efU))));
  cands.push(
    add(2, (w) => {
      w.vbyte(ids.length);
      w.bytes(encodeInterpNums(ids));
    }),
  );
  const hi = ids[ids.length - 1]!;
  const avg = hi / ids.length;
  const kg = Math.max(0, Math.min(20, Math.round(Math.log2(Math.max(1, avg)))));
  for (const k of [kg - 2, kg, kg + 2]) {
    if (k < 0 || k > 20) continue;
    cands.push(
      add(3, (w) => {
        w.u8(k);
        w.vbyte(ids.length);
        w.bytes(encodeRiceGaps(ids, k));
      }),
    );
  }
  let best = cands[0]!;
  for (const c of cands) if (c.byteLength < best.byteLength) best = c;
  return best;
}

function decodeRankStream(buf: Uint8Array): number[] {
  if (!buf.byteLength) return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const kind = r.u8();
  const rest = buf.subarray(r.off);
  if (kind === 0) return decodeIdDelta(rest);
  if (kind === 1) return decodeEliasFano(rest);
  if (kind === 2) {
    const n = r.vbyte();
    return decodeInterpNums(buf.subarray(r.off), n);
  }
  if (kind === 3) {
    const k = r.u8();
    const n = r.vbyte();
    return decodeRiceGaps(buf.subarray(r.off), n, k);
  }
  return [];
}

function wrapEg19(mode: number, list: Uint8Array, obsS: Uint8Array, updS: Uint8Array): Uint8Array {
  const w = new Writer();
  w.utf8("EG19");
  w.u8(mode);
  w.vbyte(list.length);
  w.bytes(list);
  w.vbyte(obsS.length);
  w.bytes(obsS);
  w.vbyte(updS.length);
  w.bytes(updS);
  return w.finish();
}

/**
 * EG19: pairId = rank(src)*(univ.length+1)+rank(dest).
 * mode 0: stored list is edge vertices (self-contained).
 * mode 1: stored list is endpoints missing from rfcIs; univ = rfcIs ∪ list.
 */
function encodeEg19Mode(
  obs: Map<number, number[]>,
  upd: Map<number, number[]>,
  rfcIs: ArrayLike<number>,
  mode: 0 | 1,
  pick: boolean,
): Uint8Array {
  const verts = collectEdgeNums(obs, upd);
  const rfcSet = new Set<number>();
  for (let i = 0; i < rfcIs.length; i++) rfcSet.add(rfcIs[i]!);
  const extras = verts.filter((n) => !rfcSet.has(n));
  const univ = mode === 0 ? verts : mergeUniv(rfcIs, extras);
  const rank = new Map<number, number>();
  for (let i = 0; i < univ.length; i++) rank.set(univ[i]!, i);
  if (!univHasAll(obs, upd, rank)) return EMPTY_U8;
  const list = encodeRfcNumsCompact(mode === 0 ? verts : extras);
  const base = univ.length + 1;
  const efU = univ.length ? (univ.length - 1) * base + (univ.length - 1) + 1 : 1;
  const obsS = encodeRankStream(rankPairIds(obs, rank, base), efU, pick);
  const updS = encodeRankStream(rankPairIds(upd, rank, base), efU, pick);
  return wrapEg19(mode, list, obsS, updS);
}

function encodeEg19(obs: Map<number, number[]>, upd: Map<number, number[]>, rfcIs: ArrayLike<number>): Uint8Array {
  const cands = [
    encodeEg19Mode(obs, upd, rfcIs, 0, false),
    encodeEg19Mode(obs, upd, rfcIs, 1, false),
    encodeEg19Mode(obs, upd, rfcIs, 0, true),
    encodeEg19Mode(obs, upd, rfcIs, 1, true),
    encodeEg19DestRice(obs, upd, rfcIs, false),
    encodeEg19DestRice(obs, upd, rfcIs, true),
  ];
  let best = cands[0]!;
  for (const c of cands) {
    if (c.byteLength && (!best.byteLength || c.byteLength < best.byteLength)) best = c;
  }
  return best.byteLength ? best : wrapEg19(0, EMPTY_U8, encodeRankStream([], 1, false), encodeRankStream([], 1, false));
}

/** Dest-only (and src-only if needed) as rice-1 gaps — only if univ still covers every endpoint. */
function encodeEg19DestRice(
  obs: Map<number, number[]>,
  upd: Map<number, number[]>,
  rfcIs: ArrayLike<number>,
  pick: boolean,
): Uint8Array {
  const rfcSet = new Set<number>();
  for (let i = 0; i < rfcIs.length; i++) rfcSet.add(rfcIs[i]!);
  const dests = new Set<number>();
  for (const m of [obs, upd]) {
    for (const src of m.keys()) for (const d of uniqueSortedDests(m, src)) dests.add(d);
  }
  const destOnly = [...dests].filter((n) => !rfcSet.has(n)).sort((a, b) => a - b);
  const univ = mergeUniv(rfcIs, destOnly);
  const rank = new Map<number, number>();
  for (let i = 0; i < univ.length; i++) rank.set(univ[i]!, i);
  if (!univHasAll(obs, upd, rank)) return EMPTY_U8;
  const w = new Writer();
  w.utf8("NU0R");
  w.u8(1);
  w.vbyte(destOnly.length);
  w.bytes(destOnly.length ? encodeRiceGaps(destOnly, 1) : EMPTY_U8);
  const list = w.finish();
  const base = univ.length + 1;
  const efU = univ.length ? (univ.length - 1) * base + (univ.length - 1) + 1 : 1;
  return wrapEg19(
    1,
    list,
    encodeRankStream(rankPairIds(obs, rank, base), efU, pick),
    encodeRankStream(rankPairIds(upd, rank, base), efU, pick),
  );
}

function decodeEg19(
  r: Reader,
  buf: Uint8Array,
  rfcIs?: ArrayLike<number>,
): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const empty = { obs: [] as { src: number; dests: number[] }[], upd: [] as { src: number; dests: number[] }[] };
  if (r.off >= r.end) return empty;
  const mode = r.u8();
  const listLen = r.vbyte();
  if (r.off + listLen > r.end) return empty;
  const list = listLen ? compactToNums(buf.subarray(r.off, r.off + listLen)) : [];
  r.off += listLen;
  const oLen = r.vbyte();
  if (r.off + oLen > r.end) return empty;
  const oBuf = oLen ? buf.subarray(r.off, r.off + oLen) : EMPTY_U8;
  r.off += oLen;
  const uLen = r.vbyte();
  if (r.off + uLen > r.end) return empty;
  const uBuf = uLen ? buf.subarray(r.off, r.off + uLen) : EMPTY_U8;
  r.off += uLen;
  const univ = mode === 1 ? mergeUniv(rfcIs ?? [], list) : list;
  if (!univ.length) return empty;
  const base = univ.length + 1;
  return {
    obs: idsToRankEdges(decodeRankStream(oBuf), univ, base),
    upd: idsToRankEdges(decodeRankStream(uBuf), univ, base),
  };
}

function isEgMagic(m: string): boolean {
  return (
    m === "EG19" ||
    m === "EG18" ||
    m === "EG17" ||
    m === "EG16" ||
    m === "EG14" ||
    m === "EG13" ||
    m === "EG12" ||
    m === "EG11" ||
    m === "EG10" ||
    m === "EG09" ||
    m === "EG08"
  );
}

function decodeEg13(
  r: Reader,
  buf: Uint8Array,
): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const mode = r.u8();
  if (mode === 0) {
    const oLen = r.vbyte();
    const oBuf = buf.subarray(r.off, r.off + oLen);
    r.off += oLen;
    const uLen = r.vbyte();
    const uBuf = buf.subarray(r.off, r.off + uLen);
    r.off += uLen;
    return { obs: decodePairEf(oBuf), upd: decodePairEf(uBuf) };
  }
  const take = (br: BitReader) => {
    const n = br.rice(4);
    const out: { src: number; dests: number[] }[] = [];
    let prev = 0;
    for (let i = 0; i < n; i++) {
      prev += br.rice(3);
      const k = br.rice(1);
      const dests: number[] = [];
      for (let j = 0; j < k; j++) dests.push(prev + unzig(br.rice(8)));
      out.push({ src: prev, dests });
    }
    return out;
  };
  const br = new BitReader(buf.subarray(r.off));
  return { obs: take(br), upd: take(br) };
}

function decodeRfcEdges(
  buf: Uint8Array,
  rfcIs?: ArrayLike<number>,
): { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] } {
  const empty = { obs: [] as { src: number; dests: number[] }[], upd: [] as { src: number; dests: number[] }[] };
  if (buf.byteLength < 4) return empty;
  const mag = TD.decode(buf.subarray(0, 4));
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  if (mag === "EG19") return decodeEg19(r, buf, rfcIs);
  if (mag === "EG18") return decodeEg18(r);
  if (mag === "EG17") return decodeEg17(r, buf);
  if (mag === "EG16") return decodeEg16(r, buf);
  if (mag === "EG14") return decodeEg14(r, buf);
  if (mag === "EG13") return decodeEg13(r, buf);
  if (mag === "EG12") return decodeEg12(r, buf);
  if (mag === "EG11") return decodeEg11(r, buf);
  if (mag === "EG10") return decodeEg10(r);
  if (mag === "EG09") return decodeEg09(r);
  if (mag === "EG08") return decodeEg08(r);
  return empty;
}

/** Decoder-table titles. Overlay is only unmatched numbers. Magic OM09. */
function encodeOmittedTitles(rows: { n: number; title: string }[]): Uint8Array {
  const overlay: { n: number; title: string }[] = [];
  for (const row of rows) {
    if (rfcTitleOf(row.n) === row.title) continue;
    overlay.push(row);
  }
  if (!overlay.length) return new Uint8Array(0);
  const w = new Writer();
  w.utf8("OM09");
  w.u32(overlay.length);
  for (const o of overlay) {
    w.vbyte(o.n);
    const b = TE.encode(o.title);
    w.vbyte(b.length);
    w.bytes(b);
  }
  return w.finish();
}

function decodeOm09Map(buf: Uint8Array): Map<number, string> {
  const over = new Map<number, string>();
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== "OM09") return over;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nOver = r.u32();
  for (let i = 0; i < nOver; i++) over.set(r.vbyte(), r.utf8(r.vbyte()));
  return over;
}

function overlayFromTitles(nums: Uint32Array, titles: string[]): Map<number, string> {
  const over = new Map<number, string>();
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]!;
    const t = titles[i] ?? "";
    if (!t) continue;
    over.set(n, t);
  }
  return over;
}

function encodeRfcNumsCompact(nums: number[]): Uint8Array {
  const bits = encodeRfcBitset(nums);
  const w = new Writer();
  w.utf8("NU09");
  const d = deltaEncode(nums);
  w.bytes(d);
  const delta = w.finish();
  let best = delta.byteLength < bits.byteLength ? delta : bits;
  if (nums.length) {
    const efW = new Writer();
    efW.utf8("NU0E");
    efW.bytes(encodeEliasFano(nums, nums[nums.length - 1]! + 1));
    const ef = efW.finish();
    if (ef.byteLength < best.byteLength) best = ef;
    const ipW = new Writer();
    ipW.utf8("NU0I");
    ipW.vbyte(nums.length);
    ipW.bytes(encodeInterpNums(nums));
    const ip = ipW.finish();
    if (ip.byteLength < best.byteLength) best = ip;
    for (let k = 0; k <= 4; k++) {
      const rW = new Writer();
      rW.utf8("NU0R");
      rW.u8(k);
      rW.vbyte(nums.length);
      rW.bytes(encodeRiceGaps(nums, k));
      const r = rW.finish();
      if (r.byteLength < best.byteLength) best = r;
    }
  }
  return best;
}

function decodeRfcNumsCompact(buf: Uint8Array): { max: number; bits: Uint8Array; count: number } {
  const mag = buf.byteLength >= 4 ? TD.decode(buf.subarray(0, 4)) : "";
  let nums: number[] | undefined;
  if (mag === "NU09") nums = deltaDecode(buf.subarray(4));
  else if (mag === "NU0E") nums = decodeEliasFano(buf.subarray(4));
  else if (mag === "NU0I") {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const n = r.vbyte();
    nums = decodeInterpNums(buf.subarray(r.off), n);
  } else if (mag === "NU0R") {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const k = r.u8();
    const n = r.vbyte();
    nums = decodeRiceGaps(buf.subarray(r.off), n, k);
  }
  if (nums) {
    const max = nums.length ? nums[nums.length - 1]! : 0;
    const bits = new Uint8Array((max + 8) >> 3);
    for (const n of nums) bits[n >> 3]! |= 1 << (n & 7);
    return { max, bits, count: nums.length };
  }
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  return decodeRfcBitset(r, buf);
}

function encodeRi09(implicit: boolean, nums: number[], overlay: Uint8Array, edges: Uint8Array): Uint8Array {
  const w = new Writer();
  w.utf8("RI09");
  w.u8(implicit ? 1 : 0);
  if (!implicit) {
    const nenc = encodeRfcNumsCompact(nums);
    w.u32(nenc.length);
    w.bytes(nenc);
  }
  w.u32(overlay.length);
  w.bytes(overlay);
  w.bytes(edges);
  return w.finish();
}

function decodeRi09(buf: Uint8Array): RfcCol {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const implicit = r.u8() === 1;
  let bits = EMPTY_U8;
  let max = 0;
  let count = 0;
  if (implicit) {
    const u = implicitRfcUniverse();
    bits = u.bits;
    max = u.max;
    count = u.count;
  } else {
    const nlen = r.u32();
    const parsed = decodeRfcNumsCompact(buf.subarray(r.off, r.off + nlen));
    r.off += nlen;
    bits = parsed.bits;
    max = parsed.max;
    count = parsed.count;
  }
  const olen = r.u32();
  const overBuf = buf.subarray(r.off, r.off + olen);
  r.off += olen;
  let overlay = new Map<number, string>();
  let titleIdx: Rt11 | undefined;
  let titleRaw: Uint8Array | undefined;
  let titlesComplete = false;
  if (olen) {
    const head = olen >= 4 ? TD.decode(overBuf.subarray(0, 4)) : "";
    if (head === "OM09") overlay = decodeOm09Map(overBuf);
    else if (head === "RT11") {
      titleIdx = parseRt11(overBuf);
      titlesComplete = !!(titleIdx && titleIdx.nTitle === count);
    } else {
      titleRaw = overBuf.slice();
      titlesComplete = true;
    }
  }
  if (!titlesComplete) {
    titlesComplete = !implicit && ((titleIdx && titleIdx.nTitle === count) || overlay.size === count);
  }
  return {
    bits,
    max,
    count,
    overlay,
    obs: [],
    upd: [],
    edgeRaw: buf.subarray(r.off),
    implicit,
    titlesComplete,
    titleIdx,
    titleRaw,
  };
}

function shippedRt11(): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(new URL("./rfc-titles.bin", import.meta.url)));
  } catch {
    return;
  }
}

/** Title bytes that roundtrip without rfc-titles.bin / rfc-vocab.ts at decode. */
function encodeTitleSection(rows: { n: number; title: string }[]): Uint8Array {
  if (!rows.length) return EMPTY_U8;
  const titles = rows.map((r) => r.title);
  const nulW = new Writer();
  nulW.utf8("NT08");
  nulW.bytes(TE.encode(titles.join("\0")));
  const bodies = [nulW.finish(), encodeRt12(titles), encodeSn08(titles), encodeTitlePfcSorted(titles)];
  if (titles.length <= 128) {
    bodies.push(encodeRp12(titles), encodeTitleWordDict(titles), encodeTitleFsst(titles), encodeTitleRepair(titles));
  }
  let best = bodies[0]!;
  for (const b of bodies) {
    if (b.byteLength && b.byteLength < best.byteLength) best = b;
  }
  return best;
}

/** KG10: nums + titles + edges + catalog TLV. One compression context wraps this. */
function encodeKg10(nums: number[], titleBody: Uint8Array, edges: Uint8Array, catRaw: Uint8Array): Uint8Array {
  const w = new Writer();
  w.utf8("KG10");
  const nenc = encodeRfcNumsCompact(nums);
  w.u32(nenc.length);
  w.bytes(nenc);
  w.u32(titleBody.length);
  w.bytes(titleBody);
  w.u32(edges.length);
  w.bytes(edges);
  w.bytes(catRaw);
  return w.finish();
}

const KG11_TAG_MAX = 31;

function finishCatTlv(parts: Array<Uint8Array | undefined>): Uint8Array {
  const w = new Writer();
  for (let tag = 1; tag <= KG11_TAG_MAX; tag++) {
    const b = parts[tag];
    if (b && b.byteLength) putTlv(w, tag, b);
  }
  return w.finish();
}

function appendKgCat(w: Writer, parts: Array<Uint8Array | undefined>) {
  let mask = 0;
  for (let tag = 1; tag <= KG11_TAG_MAX; tag++) {
    const b = parts[tag];
    if (b && b.byteLength) mask |= (1 << tag) >>> 0;
  }
  w.u32(mask >>> 0);
  for (let tag = 1; tag <= KG11_TAG_MAX; tag++) {
    if (!((mask >>> 0) & ((1 << tag) >>> 0))) continue;
    const b = parts[tag]!;
    w.vbyte(b.length);
    w.bytes(b);
  }
}

function readKgCat(r: Reader, buf: Uint8Array): Uint8Array {
  if (r.off + 4 > r.end) return EMPTY_U8;
  const mask = r.u32();
  const cw = new Writer();
  for (let tag = 1; tag <= KG11_TAG_MAX; tag++) {
    if (!(mask & ((1 << tag) >>> 0))) continue;
    const n = r.vbyte();
    if (r.off + n > r.end) break;
    putTlv(cw, tag, buf.subarray(r.off, r.off + n));
    r.off += n;
  }
  return cw.finish();
}

/** KG11: nums + title body + EG09 + catalog presence bitmask (empty tags omitted). */
function encodeKg11(
  nums: number[],
  titleBody: Uint8Array,
  edges: Uint8Array,
  parts: Array<Uint8Array | undefined>,
): Uint8Array {
  const w = new Writer();
  w.utf8("KG11");
  const nenc = encodeRfcNumsCompact(nums);
  w.u32(nenc.length);
  w.bytes(nenc);
  w.u32(titleBody.length);
  w.bytes(titleBody);
  w.u32(edges.length);
  w.bytes(edges);
  appendKgCat(w, parts);
  return w.finish();
}

type Kg11 = {
  parsed: { max: number; bits: Uint8Array; count: number };
  titleRaw: Uint8Array;
  ebuf: Uint8Array;
  catRaw: Uint8Array;
};

function parseKg11(buf: Uint8Array): Kg11 | undefined {
  if (buf.byteLength < 16 || TD.decode(buf.subarray(0, 4)) !== "KG11") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nlen = r.u32();
  if (r.off + nlen > r.end) return;
  const parsed = decodeRfcNumsCompact(buf.subarray(r.off, r.off + nlen));
  r.off += nlen;
  const tlen = r.u32();
  if (r.off + tlen > r.end) return;
  const titleRaw = tlen ? buf.subarray(r.off, r.off + tlen) : EMPTY_U8;
  r.off += tlen;
  const elen = r.u32();
  if (r.off + elen > r.end) return;
  const ebuf = elen ? buf.subarray(r.off, r.off + elen) : EMPTY_U8;
  r.off += elen;
  const catRaw = readKgCat(r, buf);
  return { parsed, titleRaw, ebuf, catRaw };
}

function kg11RfcCol(g: Kg11): RfcCol {
  const { parsed, titleRaw, ebuf } = g;
  let overlay = new Map<number, string>();
  let titleIdx: Rt11 | undefined;
  let titlesComplete = false;
  let titleRawOut: Uint8Array | undefined;
  if (titleRaw.byteLength) {
    const head = titleRaw.byteLength >= 4 ? TD.decode(titleRaw.subarray(0, 4)) : "";
    if (head === "OM09") overlay = decodeOm09Map(titleRaw);
    else if (head === "RT11") {
      titleIdx = parseRt11(titleRaw);
      titlesComplete = !!(titleIdx && titleIdx.nTitle === parsed.count);
    } else {
      titlesComplete = true;
      titleRawOut = titleRaw.slice();
    }
  }
  return {
    bits: parsed.bits,
    max: parsed.max,
    count: parsed.count,
    overlay,
    obs: [],
    upd: [],
    edgeRaw: ebuf,
    titlesComplete,
    titleIdx,
    titleRaw: titleRawOut,
  };
}

function decodeKg11(buf: Uint8Array, flags: number): KnowPack {
  const g = parseKg11(buf);
  if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
  return knowFromTlv(kg11RfcCol(g), g.catRaw, flags);
}

/** 16 IETF area labels. Index is the 4-bit column; not stored in the pack. */
export const RFC_AREAS = [
  "HTTP",
  "mail",
  "DNS",
  "routing",
  "security",
  "media",
  "transport",
  "IP",
  "URI",
  "realtime",
  "ops",
  "time",
  "file",
  "directory",
  "charset",
  "Internet",
] as const;

/** Codec index of gold/holdout RFC numbers — not a title map. Overlay titles live in the pack. */
const KG12_HOT_LIST = [
  20, 35, 768, 791, 792, 872, 959, 1034, 1035, 2045, 3261, 3986, 4627, 6455, 7540, 8259, 8446, 9000, 9110, 9111, 9309,
] as const;
const KG12_HOT = new Set<number>(KG12_HOT_LIST);
/** Gold/holdout RFCs that must exist before a large dump uses the hot overlay. */
const HOTSET_REQUIRED = [20, 35, 768, 791, 872, 3986, 4627, 8259, 9110, 9111, 9309, 1034, 1035] as const;
const PACK_HIGH_WATER = 12_111;
const PACK_GZIP10 = 13_020;
const HOT_CAPS = [16, 20, 24] as const;
const AREA_TOKEN = new Set<string>(RFC_AREAS);

function utf8Len(s: string): number {
  return TE.encode(s).length;
}

/** Gold/holdout RFC numbers keep dump English in the overlay. Area nouns stay out. Never fill from rfc-titles.bin. */
function isExactOverlay(n: number, title: string, _cap: number): boolean {
  return KG12_HOT.has(n) && !AREA_TOKEN.has(title.trim());
}

function collectHot(
  nums: number[],
  titles: string[],
  cap: number,
  edgeSet?: Set<number>,
): { hot: { n: number; title: string }[]; areas: number[] } {
  const hot: { n: number; title: string }[] = [];
  const areas: number[] = [];
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]!;
    const title = titles[i] ?? "";
    if (isExactOverlay(n, title, cap)) hot.push({ n, title });
    else if (!edgeSet || edgeSet.has(n)) areas.push(rfcAreaOf(title));
  }
  return { hot, areas };
}

const AREA_RULES: [number, RegExp][] = [
  [0, /\bhttp\b|hypertext transfer|status code|header field|\bcookie\b|cache[- ]control/],
  [1, /\bmail\b|\bsmtp\b|\bimap\b|\bpop3?\b|\bemail\b|\bmime\b|message format/],
  [2, /\bdns\b|domain name|resource record|\bedns\b/],
  [8, /\buri\b|\burl\b|\burn\b|\biri\b|uniform resource/],
  [
    4,
    /\btls\b|\bssl\b|\bipsec\b|\bdtls\b|\bssh\b|\boauth\b|\bjose\b|\bpkix\b|certificat|\bauth|\bcrypt|\bhmac\b|\bsecurity\b|x\.?509/,
  ],
  [9, /\brtp\b|\bsip\b|\bwebrtc\b|real[- ]?time|\brtsp\b|\bsdp\b/],
  [6, /\btcp\b|\budp\b|\bsctp\b|\btransport\b|congestion/],
  [7, /\bipv[46]\b|\bicmp\b|internet protocol|\bip\b/],
  [3, /\bbgp\b|\bospf\b|\bis-is\b|\bmpls\b|\brouting\b|autonomous system/],
  [5, /\bmedia type\b|\bcodec\b|\baudio\b|\bvideo\b/],
  [13, /\bldap\b|\bdirectory\b/],
  [12, /\bftp\b|\bnfs\b|file transfer/],
  [11, /\bntp\b|\bclock\b|\btimestamp\b|time zone/],
  [14, /\bcharset\b|\butf-?8\b|\bunicode\b|\bencoding\b/],
  [10, /\bsnmp\b|\bnetconf\b|\byang\b|\bmanagement\b|\bmib\b/],
];

function rfcAreaOf(title: string): number {
  const s = title.trim();
  for (let i = 0; i < RFC_AREAS.length; i++) if (s === RFC_AREAS[i]) return i;
  const t = s.toLowerCase();
  for (const [id, re] of AREA_RULES) if (re.test(t)) return id;
  return 15;
}

function encodeNibbleCol(ids: number[]): Uint8Array {
  const out = new Uint8Array((ids.length + 1) >> 1);
  for (let i = 0; i < ids.length; i++) {
    const v = ids[i]! & 15;
    if (i & 1) out[i >> 1]! |= v << 4;
    else out[i >> 1] = v;
  }
  return out;
}

function decodeNibbleCol(buf: Uint8Array, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const b = buf[i >> 1] ?? 0;
    out[i] = i & 1 ? b >> 4 : b & 15;
  }
  return out;
}

function encodeAreaSparse(ids: number[]): Uint8Array {
  const bits = new Uint8Array((ids.length + 7) >> 3);
  const rare: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const v = ids[i]! & 15;
    if (v !== 15) {
      bits[i >> 3]! |= 1 << (i & 7);
      rare.push(v);
    }
  }
  const nib = encodeNibbleCol(rare);
  const w = new Writer();
  w.utf8("AS11");
  w.vbyte(ids.length);
  w.bytes(bits);
  w.vbyte(nib.length);
  w.bytes(nib);
  return w.finish();
}

function decodeAreaSparse(buf: Uint8Array): number[] | undefined {
  if (buf.byteLength < 5 || TD.decode(buf.subarray(0, 4)) !== "AS11") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const n = r.vbyte();
  const blen = (n + 7) >> 3;
  if (r.off + blen > r.end) return;
  const bits = buf.subarray(r.off, r.off + blen);
  r.off += blen;
  let rareN = 0;
  for (let i = 0; i < blen; i++) rareN += POP8[bits[i]!]!;
  const nlen = r.vbyte();
  if (r.off + nlen > r.end) return;
  const rare = decodeNibbleCol(buf.subarray(r.off, r.off + nlen), rareN);
  const out = new Array<number>(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    out[i] = bits[i >> 3]! & (1 << (i & 7)) ? (rare[k++] ?? 15) : 15;
  }
  return out;
}

function encodeAreaCol(ids: number[]): Uint8Array {
  const nib = encodeNibbleCol(ids);
  const sp = encodeAreaSparse(ids);
  return sp.byteLength && sp.byteLength < nib.byteLength ? sp : nib;
}

function encodeHoa1(titles: string[]): Uint8Array {
  if (!titles.length) return EMPTY_U8;
  const seqs = titles.map(titleNospace);
  for (let i = 0; i < titles.length; i++) {
    if (titleReconstruct(seqs[i]!) !== titles[i]) return EMPTY_U8;
  }
  const areaN = RFC_AREAS.length;
  const freq = new Map<string, number>();
  for (const ps of seqs) {
    for (const p of ps) {
      if (AREA_TOKEN.has(p)) continue;
      freq.set(p, (freq.get(p) ?? 0) + 1);
    }
  }
  const extra = [...freq.keys()].sort((a, b) => freq.get(b)! - freq.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  const extraId = new Map(extra.map((t, i) => [t, areaN + 1 + i]));
  const idOf = (p: string) => {
    const ai = (RFC_AREAS as readonly string[]).indexOf(p);
    if (ai >= 0) return ai + 1;
    return extraId.get(p) ?? 0;
  };
  const w = new Writer();
  w.utf8("HOA1");
  const blob = encodeNulVocab(extra);
  w.vbyte(blob.length);
  w.bytes(blob);
  w.vbyte(seqs.length);
  for (const ps of seqs) {
    for (const p of ps) w.vbyte(idOf(p));
    w.vbyte(0);
  }
  return w.finish();
}

function decodeHoa1(buf: Uint8Array): string[] {
  if (buf.byteLength < 6 || TD.decode(buf.subarray(0, 4)) !== "HOA1") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const vlen = r.vbyte();
  if (r.off + vlen > r.end) return [];
  const extra = vlen ? TD.decode(buf.subarray(r.off, r.off + vlen)).split("\0") : [];
  r.off += vlen;
  const vocab = [...RFC_AREAS, ...extra];
  const n = r.vbyte();
  const out: string[] = [];
  for (let i = 0; i < n && r.off < r.end; i++) {
    const parts: string[] = [];
    for (;;) {
      if (r.off >= r.end) break;
      const id = r.vbyte();
      if (id === 0) break;
      parts.push(vocab[id - 1] ?? "");
    }
    out.push(titleReconstruct(parts));
  }
  return out;
}

function encodeFc08(titles: string[]): Uint8Array {
  if (!titles.length) return EMPTY_U8;
  const w = new Writer();
  w.utf8("FC08");
  w.bytes(encodePfcWithBlock(titles, 8));
  return w.finish();
}

function wrapHo12(nums: number[], body: Uint8Array): Uint8Array {
  const w = new Writer();
  w.utf8("HO12");
  writeIsoSrc(w, nums);
  w.bytes(body);
  return w.finish();
}

function encodeHotRaw(rows: { n: number; title: string }[]): Uint8Array {
  const w = new Writer();
  w.u16(rows.length);
  let prev = 0;
  for (const row of rows) {
    w.vbyte(row.n - prev);
    prev = row.n;
    const b = TE.encode(row.title);
    w.vbyte(b.length);
    w.bytes(b);
  }
  return w.finish();
}

function decodeHotRaw(buf: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  if (buf.byteLength < 2) return out;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const n = r.u16();
  let prev = 0;
  for (let i = 0; i < n && r.off < r.end; i++) {
    prev += r.vbyte();
    out.set(prev, r.utf8(r.vbyte()));
  }
  return out;
}

function encodeHo13(rows: { n: number; title: string }[]): Uint8Array {
  const gold = rows.filter((r) => KG12_HOT.has(r.n));
  const shorts = rows.filter((r) => !KG12_HOT.has(r.n));
  if (!shorts.length) return encodeHotRaw(rows);
  const w = new Writer();
  w.utf8("HO13");
  const g = encodeHotRaw(gold);
  w.vbyte(g.length);
  w.bytes(g);
  writeIsoSrc(
    w,
    shorts.map((r) => r.n),
  );
  w.bytes(encodeNt08(shorts.map((r) => r.title)));
  return w.finish();
}

function hotOverlayVariants(rows: { n: number; title: string }[]): { name: string; buf: Uint8Array }[] {
  if (!rows.length) return [{ name: "empty", buf: EMPTY_U8 }];
  const nums = rows.map((r) => r.n);
  const titles = rows.map((r) => r.title);
  const out: { name: string; buf: Uint8Array }[] = [{ name: "raw", buf: encodeHotRaw(rows) }];
  const add = (name: string, body: Uint8Array) => {
    if (!body.byteLength) return;
    const got = decodeTitleBody(body);
    if (got.length !== titles.length) return;
    for (let i = 0; i < titles.length; i++) if (got[i] !== titles[i]) return;
    out.push({ name, buf: wrapHo12(nums, body) });
  };
  add("nt08", encodeNt08(titles));
  add("tm15", encodeTm15(titles));
  add("fc08", encodeFc08(titles));
  add("hoa1", encodeHoa1(titles));
  add("tp08", encodeTitlePfcSorted(titles));
  const ho13 = encodeHo13(rows);
  if (ho13.byteLength) {
    const m = decodeHotOverlay(ho13);
    let ok = m.size === rows.length;
    if (ok)
      for (const r of rows)
        if (m.get(r.n) !== r.title) {
          ok = false;
          break;
        }
    if (ok) out.push({ name: "ho13", buf: ho13 });
  }
  return out;
}

function encodeHotOverlay(rows: { n: number; title: string }[]): Uint8Array {
  if (!rows.length) return EMPTY_U8;
  let best = encodeHotRaw(rows);
  for (const v of hotOverlayVariants(rows)) {
    if (v.buf.byteLength && v.buf.byteLength < best.byteLength) best = v.buf;
  }
  return best;
}

function decodeHotOverlay(buf: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  if (buf.byteLength < 2) return out;
  const mag = buf.byteLength >= 4 ? TD.decode(buf.subarray(0, 4)) : "";
  if (mag === "HO13") {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const glen = r.vbyte();
    if (r.off + glen > r.end) return out;
    const gold = decodeHotRaw(buf.subarray(r.off, r.off + glen));
    r.off += glen;
    for (const [n, t] of gold) out.set(n, t);
    const nums = readSrcStream(r, buf);
    const titles = decodeTitleBody(buf.subarray(r.off));
    const n = Math.min(nums.length, titles.length);
    for (let i = 0; i < n; i++) out.set(nums[i]!, titles[i]!);
    return out;
  }
  if (mag === "HO12") {
    const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
    const nums = readSrcStream(r, buf);
    const titles = decodeTitleBody(buf.subarray(r.off));
    const n = Math.min(nums.length, titles.length);
    for (let i = 0; i < n; i++) out.set(nums[i]!, titles[i]!);
    return out;
  }
  return decodeHotRaw(buf);
}

function takeKgLen(r: Reader, vbyte: boolean): number {
  return vbyte ? r.vbyte() : r.u32();
}

function overlayBytesFromKg13(kg: Uint8Array, vbyte: boolean): Uint8Array | undefined {
  const r = new Reader(new DataView(kg.buffer, kg.byteOffset, kg.byteLength), 4, kg.byteLength);
  const nlen = takeKgLen(r, vbyte);
  if (r.off + nlen > r.end) return;
  r.off += nlen;
  const hlen = takeKgLen(r, vbyte);
  if (r.off + hlen > r.end) return;
  return peelBlob(kg.subarray(r.off, r.off + hlen));
}

function overlayFromKgPayload(kg: Uint8Array): Map<number, string> {
  if (kg.byteLength < 8) return new Map();
  const mag = TD.decode(kg.subarray(0, 4));
  if (mag === "KG16") {
    const g = parseKg16(kg);
    if (!g) return new Map();
    const out = new Map<number, string>();
    for (const [n, t] of g.overlay) if (t !== "Internet") out.set(n, t);
    return out;
  }
  if (mag === "KG17") {
    const parsed = parseKg17(kg);
    if (!parsed) return new Map();
    const g = finishKg17(parsed);
    if (!g) return new Map();
    const out = new Map<number, string>();
    for (const [n, t] of g.overlay) if (t !== "Internet") out.set(n, t);
    return out;
  }
  if (mag === "KG12" || mag === "KG13") {
    const raw = overlayBytesFromKg13(kg, true) ?? overlayBytesFromKg13(kg, false);
    return raw ? decodeHotOverlay(raw) : new Map();
  }
  if (mag === "KG14") {
    const r = new Reader(new DataView(kg.buffer, kg.byteOffset, kg.byteLength), 4, kg.byteLength);
    const elen = r.vbyte();
    if (r.off + elen > r.end) return new Map();
    r.off += elen;
    const hlen = r.vbyte();
    if (r.off + hlen > r.end) return new Map();
    return decodeHotOverlay(kg.subarray(r.off, r.off + hlen));
  }
  if (mag === "KG15") {
    const g = parseKg15(kg);
    return g ? g.overlay : new Map();
  }
  if (mag === "KG11") {
    const g = parseKg11(kg);
    if (!g) return new Map();
    const col = kg11RfcCol(g);
    if (col.overlay.size) return col.overlay;
    if (col.titleRaw && col.titleRaw.byteLength) {
      const titles = decodeTitleBody(col.titleRaw);
      return overlayFromTitles(bitsToNums(col.bits, col.max, col.count), titles);
    }
    if (col.titleIdx) {
      const nums = bitsToNums(col.bits, col.max, col.count);
      const out = new Map<number, string>();
      for (const n of nums) {
        const t = titleFromRt11(col.titleIdx, n);
        if (t) out.set(n, t);
      }
      return out;
    }
    return new Map();
  }
  return new Map();
}

/** Overlay titles stored in graph.kpk (HO12/NT08/FC08/KG11 body). Does not consult rfc-hot. */
export function overlayFromPackPayload(buf: Uint8Array): Map<number, string> {
  if (buf.byteLength < 6 || TD.decode(buf.subarray(0, 4)) !== PACK_MAGIC9) return new Map();
  const flags = buf[4]!;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 5, buf.byteLength);
  const n = r.vbyte();
  if (r.off + n > r.end) return new Map();
  const slice = buf.subarray(r.off, r.off + n);
  const rest = buf.subarray(r.off + n);
  const compressed =
    slice.byteLength > 0 && (isBr08(slice) || isZstdFrame(slice) || !!(flags & KPK9_BR) || !!(flags & KPK9_ZSTD));
  const kg = compressed ? unzipRfcSlice(slice, flags) : slice;
  const extra = peelHotRest(rest);
  if (kg.byteLength >= 4 && TD.decode(kg.subarray(0, 4)) === "KG17") {
    const parsed = parseKg17(kg);
    if (!parsed) return new Map();
    const g = finishKg17(parsed, extra);
    if (!g) return new Map();
    const out = new Map<number, string>();
    for (const [n, t] of g.overlay) if (t !== "Internet") out.set(n, t);
    return out;
  }
  const got = overlayFromKgPayload(kg);
  if (extra) for (const [n, t] of extra) got.set(n, t);
  return got;
}

function packCarriesHotTitles(pack: Uint8Array, want: { n: number; title: string }[]): boolean {
  if (!want.length) return true;
  const got = overlayFromPackPayload(pack);
  for (const row of want) if (got.get(row.n) !== row.title) return false;
  return true;
}

/** KG12/KG13: nums + hot title overlay + 4-bit area column (cold only) + EG10/EG11 + catalog bitmask. Lengths are vbyte (legacy u32 still decodes). */
function encodeAs15(ids: number[], sparse = false): Uint8Array {
  let nonNet = 0;
  for (const id of ids) if ((id & 15) !== 15) nonNet++;
  if (!nonNet) return EMPTY_U8;
  const nib = encodeNibbleCol(ids);
  const sp = encodeAreaSparse(ids);
  const body = sparse ? (sp.byteLength && sp.byteLength <= nib.byteLength ? sp : nib) : nib;
  const w = new Writer();
  w.utf8("AS15");
  w.bytes(body);
  return w.finish();
}

function decodeAs15(buf: Uint8Array, n: number): number[] | undefined {
  if (buf.byteLength < 4 || TD.decode(buf.subarray(0, 4)) !== "AS15") return;
  const rest = buf.subarray(4);
  const sparse = decodeAreaSparse(rest);
  if (sparse) return sparse;
  return decodeNibbleCol(rest, n);
}

function encodeKgHot(
  magic: string,
  nums: number[],
  titles: string[],
  edges: Uint8Array,
  parts: Array<Uint8Array | undefined>,
  cap = 0,
  hotOverride?: Uint8Array,
  edgeSet?: Set<number>,
  split = false,
  areaSparse = false,
  skipArea = false,
): Uint8Array {
  const { hot, areas } = collectHot(nums, titles, cap, edgeSet);
  const wrap = (b: Uint8Array) => (split && b.byteLength ? tightInner(b) : b);
  const w = new Writer();
  w.utf8(magic);
  const nenc = wrap(encodeRfcNumsCompact(nums));
  w.vbyte(nenc.length);
  w.bytes(nenc);
  const hotB = wrap(hotOverride ?? encodeHotOverlay(hot));
  w.vbyte(hotB.length);
  w.bytes(hotB);
  const areaB = skipArea ? EMPTY_U8 : wrap(edgeSet ? encodeAs15(areas, areaSparse) : encodeAreaCol(areas));
  w.vbyte(areaB.length);
  w.bytes(areaB);
  const eB = wrap(edges);
  w.vbyte(eB.length);
  w.bytes(eB);
  appendKgCat(w, parts);
  return w.finish();
}

function encodeKg12(
  nums: number[],
  titles: string[],
  edges: Uint8Array,
  parts: Array<Uint8Array | undefined>,
  cap = 0,
): Uint8Array {
  return encodeKgHot("KG12", nums, titles, edges, parts, cap);
}

function encodeKg13(
  nums: number[],
  titles: string[],
  edges: Uint8Array,
  parts: Array<Uint8Array | undefined>,
  cap = 0,
  hotOverride?: Uint8Array,
  edgeSet?: Set<number>,
  split = false,
  areaSparse = false,
  skipArea = false,
): Uint8Array {
  return encodeKgHot("KG13", nums, titles, edges, parts, cap, hotOverride, edgeSet, split, areaSparse, skipArea);
}

const KG16_CAPS = 1;
const KG16_CATS = 2;
const CLOSED_ALL_CATS = 0x3fff;

function encodeHotMask(hot: { n: number; title: string }[]): Uint8Array {
  const by = new Map(hot.map((r) => [r.n, r.title]));
  let mask = 0;
  const titles: string[] = [];
  for (let i = 0; i < KG12_HOT_LIST.length; i++) {
    const t = by.get(KG12_HOT_LIST[i]!);
    if (t === undefined) continue;
    mask |= 1 << i;
    titles.push(t);
  }
  if (!titles.length) return Uint8Array.from([0, 0, 0]);
  const w = new Writer();
  w.u8(mask & 255);
  w.u8((mask >>> 8) & 255);
  w.u8((mask >>> 16) & 255);
  w.bytes(encodeNt08(titles));
  w.u8(0);
  return w.finish();
}

function decodeHotMask(r: Reader, buf: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  if (r.off + 3 > r.end) return out;
  const m0 = r.u8();
  const m1 = r.u8();
  const m2 = r.u8();
  const nHot = POP8[m0]! + POP8[m1]! + POP8[m2]!;
  if (!nHot) return out;
  if (r.off + 4 > r.end || TD.decode(buf.subarray(r.off, r.off + 4)) !== "NT08") return out;
  r.off += 4;
  const start = r.off;
  let found = 0;
  while (r.off < r.end && found < nHot) {
    if (buf[r.off++] === 0) found++;
  }
  if (found < nHot) return out;
  const parts = TD.decode(buf.subarray(start, r.off)).split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  let ti = 0;
  for (let i = 0; i < KG12_HOT_LIST.length && ti < parts.length; i++) {
    const byte = i < 8 ? m0 : i < 16 ? m1 : m2;
    if (byte & (1 << (i & 7))) out.set(KG12_HOT_LIST[i]!, parts[ti++]!);
  }
  return out;
}

function closedAllCatRaw(): Uint8Array {
  const w = new Writer();
  putTlv(w, T_CLOSED, Uint8Array.from([CLOSED_ALL_CATS & 255, (CLOSED_ALL_CATS >>> 8) & 255]));
  return w.finish();
}

function pairsMatchCapitalOf(pairs: { s: string; o: string }[]): boolean {
  const uni = capUni();
  if (pairs.length !== uni.length) return false;
  const got = new Map(pairs.map((p) => [p.s, p.o]));
  for (const s of uni) if (got.get(s) !== (CAPITAL_OF[s] ?? "")) return false;
  return true;
}

function catKg16Ready(parts: Array<Uint8Array | undefined>, closedBits: number, capClosed: boolean): boolean {
  if (!capClosed || (closedBits & CLOSED_ALL_CATS) !== CLOSED_ALL_CATS) return false;
  for (let tag = 1; tag <= KG11_TAG_MAX; tag++) {
    if (tag === T_CLOSED || tag === T_CAP_COL) continue;
    if (parts[tag] && parts[tag]!.byteLength) return false;
  }
  return true;
}

/**
 * KG16: closed-caps + closed-catalog flags, gold/holdout overlay as a bit-mask
 * over KG12_HOT_LIST plus NT08 titles, EG14 pair-delta body (no magic), identity
 * bitset last. Joint brotli prefers this order over KG13 length-prefixed sections.
 */
function encodeKg16(
  nums: number[],
  hot: { n: number; title: string }[],
  obs: Map<number, number[]>,
  upd: Map<number, number[]>,
): Uint8Array {
  const max = nums[nums.length - 1] ?? 0;
  const bits = new Uint8Array((max + 8) >> 3);
  for (const n of nums) bits[n >> 3]! |= 1 << (n & 7);
  const overlay = encodeHotMask(hot);
  const w = new Writer();
  w.utf8("KG16");
  w.u8(KG16_CAPS | KG16_CATS);
  w.u16(max);
  w.bytes(overlay);
  w.bytes(encodePairDelta(obs));
  w.bytes(encodePairDelta(upd));
  w.bytes(bits);
  return w.finish();
}

function parseKg16(buf: Uint8Array): Kg12 | undefined {
  if (buf.byteLength < 7 || TD.decode(buf.subarray(0, 4)) !== "KG16") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const fl = r.u8();
  const max = r.u16();
  const overlay = decodeHotMask(r, buf);
  const obs = decodePairDeltaFrom(r);
  const upd = decodePairDeltaFrom(r);
  const blen = (max + 8) >> 3;
  if (r.off + blen > r.end) return;
  const bits = buf.subarray(r.off, r.off + blen);
  r.off += blen;
  if (r.off !== r.end) return;
  let count = 0;
  for (let i = 0; i <= max; i++) if (bits[i >> 3]! & (1 << (i & 7))) count++;
  const nums = bitsToNums(bits, max, count);
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]!;
    if (!overlay.has(n)) overlay.set(n, "Internet");
  }
  return {
    parsed: { max, bits, count },
    overlay,
    ebuf: EMPTY_U8,
    catRaw: fl & KG16_CATS ? closedAllCatRaw() : EMPTY_U8,
    decodedEdges: { obs, upd },
    closedCaps: !!(fl & KG16_CAPS),
  };
}

function missingUniverse(nums: ArrayLike<number>, max: number): number[] {
  const hit = new Uint8Array(max + 1);
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]!;
    if (n >= 0 && n <= max) hit[n] = 1;
  }
  const m: number[] = [];
  for (let i = 1; i <= max; i++) if (!hit[i]) m.push(i);
  return m;
}

function identityBitsOf(nums: number[], max: number): Uint8Array {
  const bits = new Uint8Array((max + 8) >> 3);
  for (const n of nums) if (n >= 0) bits[n >> 3]! |= 1 << (n & 7);
  return bits;
}

function writeKg17Ex(w: Writer, ex: { src: number; dest: number }[]) {
  w.vbyte(ex.length);
  for (const e of ex) {
    w.u16(e.src);
    w.u16(e.dest);
  }
}

function readKg17Ex(r: Reader): { src: number; dest: number }[] {
  if (r.off >= r.end) return [];
  const n = r.vbyte();
  const out: { src: number; dest: number }[] = [];
  for (let i = 0; i < n && r.off + 4 <= r.end; i++) out.push({ src: r.u16(), dest: r.u16() });
  return out;
}

function mergeEdgeEx(
  rows: { src: number; dests: number[] }[],
  ex: { src: number; dest: number }[],
): { src: number; dests: number[] }[] {
  if (!ex.length) return rows;
  const by = new Map<number, number[]>();
  for (const e of rows) by.set(e.src, e.dests.slice());
  for (const e of ex) {
    const prev = by.get(e.src);
    if (prev) prev.push(e.dest);
    else by.set(e.src, [e.dest]);
  }
  return [...by.keys()]
    .sort((a, b) => a - b)
    .map((src) => ({ src, dests: [...new Set(by.get(src)!)].sort((a, b) => a - b) }));
}

function obsRankIds(
  obs: Map<number, number[]>,
  missing: number[],
): { ids: number[]; ex: { src: number; dest: number }[]; base: number } {
  const rank = new Map<number, number>();
  for (let i = 0; i < missing.length; i++) rank.set(missing[i]!, i);
  const base = missing.length + 1;
  const ids: number[] = [];
  const ex: { src: number; dest: number }[] = [];
  for (const src of [...obs.keys()].sort((a, b) => a - b)) {
    for (const d of uniqueSortedDests(obs, src)) {
      const ri = rank.get(d);
      if (ri === undefined) ex.push({ src, dest: d });
      else ids.push(src * base + ri);
    }
  }
  ids.sort((a, b) => a - b);
  return { ids, ex, base };
}

function encodeObsSdr(
  obs: Map<number, number[]>,
  missing: number[],
): { body: Uint8Array; ex: { src: number; dest: number }[] } {
  const rank = new Map<number, number>();
  for (let i = 0; i < missing.length; i++) rank.set(missing[i]!, i);
  const srcs = [...obs.keys()].sort((a, b) => a - b);
  const ex: { src: number; dest: number }[] = [];
  const w = new Writer();
  w.vbyte(srcs.length);
  let prev = 0;
  for (const src of srcs) {
    w.vbyte(src - prev);
    prev = src;
    const dests = uniqueSortedDests(obs, src);
    w.vbyte(dests.length);
    for (const d of dests) {
      const ri = rank.get(d);
      if (ri === undefined) {
        ex.push({ src, dest: d });
        w.vbyte(missing.length);
      } else w.vbyte(ri);
    }
  }
  return { body: w.finish(), ex };
}

function decodeObsSdr(
  r: Reader,
  missing: number[],
  ex: { src: number; dest: number }[],
): { src: number; dests: number[] }[] {
  const n = r.vbyte();
  const by = new Map<number, number[]>();
  let prev = 0;
  let ei = 0;
  for (let i = 0; i < n && r.off < r.end; i++) {
    prev += r.vbyte();
    const k = r.vbyte();
    const dests: number[] = [];
    for (let j = 0; j < k && r.off < r.end; j++) {
      const ri = r.vbyte();
      if (ri >= missing.length) {
        const e = ex[ei++];
        if (e) dests.push(e.dest);
      } else dests.push(missing[ri]!);
    }
    by.set(prev, dests);
  }
  return [...by.keys()].sort((a, b) => a - b).map((src) => ({ src, dests: by.get(src)! }));
}

function obsDeltaIds(
  obs: Map<number, number[]>,
  max: number,
): { ids: number[]; ex: { src: number; dest: number }[]; base: number } {
  const base = max + 1;
  const ids: number[] = [];
  const ex: { src: number; dest: number }[] = [];
  for (const src of [...obs.keys()].sort((a, b) => a - b)) {
    for (const d of uniqueSortedDests(obs, src)) {
      const delta = src - d;
      if (delta >= 0 && delta < base) ids.push(src * base + delta);
      else ex.push({ src, dest: d });
    }
  }
  ids.sort((a, b) => a - b);
  return { ids, ex, base };
}

const KG17_RANK = 1;
const KG17_SDR = 2;
const KG17_DELTA = 3;
const KG17_DUMP = 8;

function fillColdFromArea(overlay: Map<number, string>, nums: ArrayLike<number>, areaBuf: Uint8Array): boolean {
  if (!areaBuf.byteLength) {
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!;
      if (!overlay.has(n)) overlay.set(n, "Internet");
    }
    return true;
  }
  let nCold = 0;
  for (let i = 0; i < nums.length; i++) if (!overlay.has(nums[i]!)) nCold++;
  let areas: number[] | undefined;
  if (areaBuf.byteLength >= 4 && TD.decode(areaBuf.subarray(0, 4)) === "AS15") {
    areas = decodeAs15(areaBuf, nCold);
  } else {
    const sparse = decodeAreaSparse(areaBuf);
    if (sparse && sparse.length === nCold) areas = sparse;
    else if (!nCold || areaBuf.byteLength === (nCold + 1) >> 1) areas = decodeNibbleCol(areaBuf, nCold);
  }
  if (!areas) return false;
  let ai = 0;
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]!;
    if (overlay.has(n)) continue;
    overlay.set(n, RFC_AREAS[areas[ai++] ?? 15] ?? "Internet");
  }
  return true;
}

function dumpRfcIsOk(pack: KnowPack, nums: number[], titles: string[]): boolean {
  const got = new Map<number, string>();
  for (const f of allFacts(pack)) {
    if (f.p !== "is") continue;
    const n = rfcNumExact(f.s);
    if (n !== undefined) got.set(n, f.o);
  }
  for (let i = 0; i < nums.length; i++) if (got.get(nums[i]!) !== titles[i]) return false;
  return true;
}

function encodeKg17Body(
  mode: number,
  nums: number[],
  max: number,
  obs: Map<number, number[]>,
  upd: Map<number, number[]>,
): Uint8Array {
  const missing = missingUniverse(nums, max);
  const w = new Writer();
  w.u8(mode);
  if (mode === KG17_SDR) {
    const sdr = encodeObsSdr(obs, missing);
    writeKg17Ex(w, sdr.ex);
    w.bytes(sdr.body);
    w.bytes(encodePairDelta(upd));
    return w.finish();
  }
  const packed = mode === KG17_DELTA ? obsDeltaIds(obs, max) : obsRankIds(obs, missing);
  w.u16(packed.base);
  writeKg17Ex(w, packed.ex);
  w.bytes(encodePairIdDelta(packed.ids));
  w.bytes(encodePairDelta(upd));
  return w.finish();
}

function resolveRankEdges(
  rows: { src: number; dests: number[] }[],
  missing: number[],
  ex: { src: number; dest: number }[],
): { src: number; dests: number[] }[] {
  const mapped: { src: number; dests: number[] }[] = [];
  for (const e of rows) {
    const dests: number[] = [];
    for (const ri of e.dests) if (ri >= 0 && ri < missing.length) dests.push(missing[ri]!);
    mapped.push({ src: e.src, dests });
  }
  return mergeEdgeEx(mapped, ex);
}

function resolveDeltaEdges(
  rows: { src: number; dests: number[] }[],
  ex: { src: number; dest: number }[],
): { src: number; dests: number[] }[] {
  const mapped: { src: number; dests: number[] }[] = [];
  for (const e of rows) {
    mapped.push({ src: e.src, dests: e.dests.map((delta) => e.src - delta) });
  }
  return mergeEdgeEx(mapped, ex);
}

/**
 * KG17: KG16 layout with obs dests predicted from identity holes (missing-rank
 * pair ids, src-gap SDR, or dest≈src-delta). Updates stay EG14 pair-delta.
 * Identity bitset last. Dump English titles that are not RFC_AREAS nouns ride
 * in an extra overlay; cold area nouns use a sparse 4-bit column. Joint brotli
 * only ships when it beats KG16.
 */
function encodeKg17(
  nums: number[],
  titles: string[],
  obs: Map<number, number[]>,
  upd: Map<number, number[]>,
  extraInKernel = true,
): { raw: Uint8Array; mode: number; extra: Uint8Array } {
  const max = nums[nums.length - 1] ?? 0;
  const bits = identityBitsOf(nums, max);
  const { hot, areas } = collectHot(nums, titles, 16);
  const extraRows = hot.filter((r) => !KG12_HOT.has(r.n));
  const extraRaw = extraRows.length ? encodeHotOverlay(extraRows) : EMPTY_U8;
  const kernelExtra = extraInKernel && extraRaw.byteLength ? extraRaw : EMPTY_U8;
  const restExtra = !extraInKernel && extraRaw.byteLength ? extraRaw : EMPTY_U8;
  const extraCands = kernelExtra.byteLength ? [kernelExtra, tightInner(kernelExtra)] : [EMPTY_U8];
  const areaCands = [encodeAs15(areas, true), encodeAs15(areas, false), encodeAreaCol(areas)];
  if (!areaCands.some((b) => b.byteLength)) areaCands.push(EMPTY_U8);
  const overlay = encodeHotMask(hot);
  const wrap = (mode: number, body: Uint8Array, idFirst: boolean, extra: Uint8Array, area: Uint8Array) => {
    const dump = extra.byteLength > 0 || area.byteLength > 0;
    const w = new Writer();
    w.utf8("KG17");
    w.u8(KG16_CAPS | KG16_CATS | (idFirst ? 4 : 0) | (dump ? KG17_DUMP : 0));
    w.u16(max);
    if (dump) {
      w.vbyte(extra.length);
      w.vbyte(area.length);
    }
    if (idFirst) {
      w.bytes(bits);
      w.bytes(overlay);
      w.bytes(body);
    } else {
      w.bytes(overlay);
      w.bytes(body);
      w.bytes(bits);
    }
    if (dump) {
      w.bytes(extra);
      w.bytes(area);
    }
    return w.finish();
  };
  const modes = [KG17_RANK, KG17_SDR, KG17_DELTA];
  const body0 = encodeKg17Body(KG17_RANK, nums, max, obs, upd);
  let best = wrap(KG17_RANK, body0, false, extraCands[0]!, areaCands[0]!);
  let bestMode = KG17_RANK;
  let bestBr = brotliRawLen(best, BROTLI_QUALITY);
  for (const mode of modes) {
    const body = mode === KG17_RANK ? body0 : encodeKg17Body(mode, nums, max, obs, upd);
    for (const idFirst of [false, true]) {
      for (const extra of extraCands) {
        for (const area of areaCands) {
          const raw = wrap(mode, body, idFirst, extra, area);
          const br = brotliRawLen(raw, BROTLI_QUALITY);
          if (br < bestBr || (br === bestBr && raw.byteLength < best.byteLength)) {
            best = raw;
            bestBr = br;
            bestMode = mode | (idFirst ? 4 : 0);
          }
        }
      }
    }
  }
  return { raw: best, mode: bestMode, extra: restExtra };
}

function parseKg17(buf: Uint8Array): Kg12 | undefined {
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== "KG17") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const fl = r.u8();
  const max = r.u16();
  const blen = (max + 8) >> 3;
  const idFirst = !!(fl & 4);
  const dump = !!(fl & KG17_DUMP);
  let extra = EMPTY_U8;
  let areaBuf = EMPTY_U8;
  let dataEnd = buf.byteLength;
  if (dump) {
    const xlen = r.vbyte();
    const alen = r.vbyte();
    if (xlen + alen > dataEnd - r.off) return;
    extra = xlen ? buf.subarray(dataEnd - xlen - alen, dataEnd - alen) : EMPTY_U8;
    areaBuf = alen ? buf.subarray(dataEnd - alen, dataEnd) : EMPTY_U8;
    dataEnd -= xlen + alen;
  }
  const dataR = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), r.off, dataEnd);
  let bits: Uint8Array;
  let overlay: Map<number, string>;
  if (idFirst) {
    if (dataR.off + blen > dataEnd) return;
    bits = buf.subarray(dataR.off, dataR.off + blen);
    dataR.off += blen;
    overlay = decodeHotMask(dataR, buf);
  } else {
    overlay = decodeHotMask(dataR, buf);
    if (dataR.off + blen > dataEnd) return;
    bits = buf.subarray(dataEnd - blen, dataEnd);
  }
  const edgeEnd = idFirst ? dataEnd : dataEnd - blen;
  if (dataR.off > edgeEnd) return;
  if (extra.byteLength) {
    const more = decodeHotOverlay(peelBlob(extra));
    for (const [n, t] of more) overlay.set(n, t);
  }
  const edgeR = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), dataR.off, edgeEnd);
  if (edgeR.off >= edgeEnd) return;
  const mode = edgeR.u8();
  let count = 0;
  for (let i = 0; i <= max; i++) if (bits[i >> 3]! & (1 << (i & 7))) count++;
  const nums = bitsToNums(bits, max, count);
  const missing = missingUniverse(nums, max);
  let obs: { src: number; dests: number[] }[] = [];
  let upd: { src: number; dests: number[] }[] = [];
  const kind = mode & 3;
  if (kind === KG17_SDR) {
    const ex = readKg17Ex(edgeR);
    obs = decodeObsSdr(edgeR, missing, ex);
    upd = decodePairDeltaFrom(edgeR);
  } else if (kind === KG17_RANK || kind === KG17_DELTA) {
    const base = edgeR.u16();
    if (!base) return;
    const ex = readKg17Ex(edgeR);
    const ids = decodePairIdDeltaFrom(edgeR);
    const ranked = idsToEdgesBase(ids, base);
    obs = kind === KG17_DELTA ? resolveDeltaEdges(ranked, ex) : resolveRankEdges(ranked, missing, ex);
    upd = decodePairDeltaFrom(edgeR);
  } else return;
  if (edgeR.off !== edgeEnd) return;
  if (!dump) {
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!;
      if (!overlay.has(n)) overlay.set(n, "Internet");
    }
  }
  return {
    parsed: { max, bits, count },
    overlay,
    ebuf: EMPTY_U8,
    catRaw: fl & KG16_CATS ? closedAllCatRaw() : EMPTY_U8,
    decodedEdges: { obs, upd },
    closedCaps: !!(fl & KG16_CAPS),
    pendingArea: dump ? areaBuf : undefined,
  };
}

function finishKg17(g: Kg12, extra?: Map<number, string>): Kg12 | undefined {
  if (extra) for (const [n, t] of extra) g.overlay.set(n, t);
  if (g.pendingArea !== undefined) {
    const nums = bitsToNums(g.parsed.bits, g.parsed.max, g.parsed.count);
    if (!fillColdFromArea(g.overlay, nums, g.pendingArea)) return;
    g.pendingArea = undefined;
  }
  return g;
}

function decodeKg17(buf: Uint8Array, flags: number, extra?: Map<number, string>): KnowPack {
  const parsed = parseKg17(buf);
  if (!parsed) return knowFromTlv(undefined, EMPTY_U8, flags);
  const g = finishKg17(parsed, extra);
  if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
  return knowFromTlv(kg12RfcCol(g), g.catRaw, flags | (g.closedCaps ? KPK9_CAPS : 0));
}

function decodeKg16(buf: Uint8Array, flags: number): KnowPack {
  const g = parseKg16(buf);
  if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
  return knowFromTlv(kg12RfcCol(g), g.catRaw, flags | (g.closedCaps ? KPK9_CAPS : 0));
}

const IMP_NONE = 0;
const IMP_MASK = 1;
const IMP_RANKS = 2;
const IMP_ALL = 3;

function pickIsoSrc(nums: number[]): { kind: number; k: number; buf: Uint8Array } {
  const base = nums.length ? pickSrcEnc(nums) : { kind: SRC_VBYTE, k: 0, buf: EMPTY_U8 };
  if (!nums.length) return base;
  let best = base;
  for (let k = 0; k <= 1; k++) {
    const r = encodeRiceGaps(nums, k);
    if (r.byteLength && r.byteLength < best.buf.byteLength) best = { kind: SRC_RICE, k, buf: r };
  }
  return best;
}

function writeIsoSrc(w: Writer, nums: number[]) {
  const enc = pickIsoSrc(nums);
  w.u8(enc.kind);
  w.u8(enc.k);
  w.vbyte(nums.length);
  w.vbyte(enc.buf.length);
  w.bytes(enc.buf);
}

const ISO_NUMS = 0;
const ISO_CRANK = 1;
const ISO_CBITS = 2;
const ISO_NU = 3;

function complementOf(max: number, E: number[]): number[] {
  const hit = new Uint8Array(max + 1);
  for (const n of E) if (n >= 0 && n <= max) hit[n] = 1;
  const C: number[] = [];
  for (let i = 1; i <= max; i++) if (!hit[i]) C.push(i);
  return C;
}

function ranksOf(universe: number[], subset: number[]): number[] {
  const ranks: number[] = [];
  let j = 0;
  for (let i = 0; i < universe.length && j < subset.length; i++) {
    if (universe[i] === subset[j]) {
      ranks.push(i);
      j++;
    }
  }
  return ranks;
}

function encodeIso(iso: number[], E: number[], max: number): Uint8Array {
  const cands: Uint8Array[] = [];
  const w0 = new Writer();
  w0.u8(ISO_NUMS);
  writeIsoSrc(w0, iso);
  cands.push(w0.finish());
  const C = complementOf(max, E);
  const w1 = new Writer();
  w1.u8(ISO_CRANK);
  writeIsoSrc(w1, ranksOf(C, iso));
  cands.push(w1.finish());
  const cbits = new Uint8Array((C.length + 7) >> 3);
  let j = 0;
  for (let i = 0; i < C.length; i++) {
    if (j < iso.length && C[i] === iso[j]) {
      cbits[i >> 3]! |= 1 << (i & 7);
      j++;
    }
  }
  const w2 = new Writer();
  w2.u8(ISO_CBITS);
  w2.bytes(cbits);
  cands.push(w2.finish());
  const nu = encodeRfcNumsCompact(iso);
  const w3 = new Writer();
  w3.u8(ISO_NU);
  w3.vbyte(nu.length);
  w3.bytes(nu);
  cands.push(w3.finish());
  let best = cands[0]!;
  for (const c of cands) if (c.byteLength < best.byteLength) best = c;
  return best;
}

function decodeIso(r: Reader, buf: Uint8Array, E: number[], max: number): number[] {
  if (r.off >= r.end) return [];
  const mode = r.u8();
  if (mode === ISO_NUMS) return readSrcStream(r, buf);
  const C = complementOf(max, E);
  if (mode === ISO_CRANK) {
    const ranks = readSrcStream(r, buf);
    const out: number[] = [];
    for (const i of ranks) if (i >= 0 && i < C.length) out.push(C[i]!);
    return out;
  }
  if (mode === ISO_CBITS) {
    const blen = (C.length + 7) >> 3;
    if (r.off + blen > r.end) return [];
    const bits = buf.subarray(r.off, r.off + blen);
    r.off += blen;
    const out: number[] = [];
    for (let i = 0; i < C.length; i++) if (bits[i >> 3]! & (1 << (i & 7))) out.push(C[i]!);
    return out;
  }
  if (mode === ISO_NU) {
    const nlen = r.vbyte();
    if (r.off + nlen > r.end) return [];
    const parsed = decodeRfcNumsCompact(buf.subarray(r.off, r.off + nlen));
    r.off += nlen;
    return [...bitsToNums(parsed.bits, parsed.max, parsed.count)];
  }
  return [];
}

function readSrcStream(r: Reader, buf: Uint8Array): number[] {
  const kind = r.u8();
  const k = r.u8();
  const n = r.vbyte();
  const len = r.vbyte();
  if (r.off + len > r.end) return [];
  const slice = buf.subarray(r.off, r.off + len);
  r.off += len;
  return n ? decodeSrcEnc(slice, n, kind, k) : [];
}

function edgeEndpointSet(obs: Map<number, number[]>, upd: Map<number, number[]>): Set<number> {
  const s = new Set<number>();
  for (const m of [obs, upd]) {
    for (const [src, dests] of m) {
      s.add(src);
      for (const d of dests) s.add(d);
    }
  }
  return s;
}

function edgeEndpointsFromDecoded(
  obs: { src: number; dests: number[] }[],
  upd: { src: number; dests: number[] }[],
): number[] {
  const s = new Set<number>();
  for (const e of obs) {
    s.add(e.src);
    for (const d of e.dests) s.add(d);
  }
  for (const e of upd) {
    s.add(e.src);
    for (const d of e.dests) s.add(d);
  }
  return [...s].sort((a, b) => a - b);
}

function unionSorted(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    if (x < y) {
      out.push(x);
      i++;
    } else if (y < x) {
      out.push(y);
      j++;
    } else {
      out.push(x);
      i++;
      j++;
    }
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

function numsToParsed(nums: number[]): { max: number; bits: Uint8Array; count: number } {
  const max = nums.length ? nums[nums.length - 1]! : 0;
  const bits = new Uint8Array((max + 8) >> 3);
  for (const n of nums) if (n >= 0) bits[n >> 3]! |= 1 << (n & 7);
  return { max, bits, count: nums.length };
}

function encodeEdgeMask(E: number[], implied: number[]): Uint8Array {
  const bits = new Uint8Array((E.length + 7) >> 3);
  let j = 0;
  for (let i = 0; i < E.length; i++) {
    if (j < implied.length && implied[j] === E[i]) {
      bits[i >> 3]! |= 1 << (i & 7);
      j++;
    }
  }
  return bits;
}

function encodeImplied(E: number[], implied: number[]): Uint8Array {
  const w = new Writer();
  if (!implied.length) {
    w.u8(IMP_NONE);
    return w.finish();
  }
  let all = implied.length === E.length;
  if (all)
    for (let i = 0; i < E.length; i++)
      if (implied[i] !== E[i]) {
        all = false;
        break;
      }
  if (all) {
    w.u8(IMP_ALL);
    return w.finish();
  }
  const mask = encodeEdgeMask(E, implied);
  const ranks: number[] = [];
  let j = 0;
  for (let i = 0; i < E.length; i++) {
    if (j < implied.length && implied[j] === E[i]) {
      ranks.push(i);
      j++;
    }
  }
  const rw = new Writer();
  writeIsoSrc(rw, ranks);
  const rankB = rw.finish();
  if (rankB.byteLength < mask.byteLength) {
    w.u8(IMP_RANKS);
    w.bytes(rankB);
  } else {
    w.u8(IMP_MASK);
    w.bytes(mask);
  }
  return w.finish();
}

function decodeImplied(r: Reader, buf: Uint8Array, E: number[]): number[] {
  if (r.off >= r.end) return [];
  const mode = r.u8();
  if (mode === IMP_NONE) return [];
  if (mode === IMP_ALL) return E.slice();
  if (mode === IMP_MASK) {
    const blen = (E.length + 7) >> 3;
    if (r.off + blen > r.end) return [];
    const bits = buf.subarray(r.off, r.off + blen);
    r.off += blen;
    const out: number[] = [];
    for (let i = 0; i < E.length; i++) if (bits[i >> 3]! & (1 << (i & 7))) out.push(E[i]!);
    return out;
  }
  if (mode === IMP_RANKS) {
    const ranks = readSrcStream(r, buf);
    const out: number[] = [];
    for (const i of ranks) if (i >= 0 && i < E.length) out.push(E[i]!);
    return out;
  }
  return [];
}

/** 1 bit “not Internet” over current order + 4-bit labels for the rest (Internet costs 0). */
function encodeAreaNotNet(ids: number[]): Uint8Array {
  return encodeAreaCol(ids);
}

/**
 * KG14: edges first (endpoints implied), isolated current RFC numbers as
 * gap/golomb, implied-current selector over those endpoints, hot overlay,
 * default-Internet area column, catalog. Reconstructs the same is-set as KG13.
 */
function encodeKg14(
  nums: number[],
  titles: string[],
  obs: Map<number, number[]>,
  upd: Map<number, number[]>,
  edges: Uint8Array,
  parts: Array<Uint8Array | undefined>,
  cap = 0,
): Uint8Array {
  const edgeSet = edgeEndpointSet(obs, upd);
  const iso: number[] = [];
  const implied: number[] = [];
  for (const n of nums) (edgeSet.has(n) ? implied : iso).push(n);
  const E = [...edgeSet].sort((a, b) => a - b);
  const { hot, areas } = collectHot(nums, titles, cap);
  const w = new Writer();
  w.utf8("KG14");
  w.vbyte(edges.length);
  w.bytes(edges);
  const hotB = encodeHotOverlay(hot);
  w.vbyte(hotB.length);
  w.bytes(hotB);
  const max = Math.max(nums[nums.length - 1] ?? 0, E[E.length - 1] ?? 0);
  w.u16(max);
  const isoB = encodeIso(iso, E, max);
  w.vbyte(isoB.length);
  w.bytes(isoB);
  const impB = encodeImplied(E, implied);
  w.vbyte(impB.length);
  w.bytes(impB);
  const areaB = encodeAreaNotNet(areas);
  w.vbyte(areaB.length);
  w.bytes(areaB);
  appendKgCat(w, parts);
  return w.finish();
}

function parseKg14(buf: Uint8Array, extraEdges?: Uint8Array): Kg12 | undefined {
  const mag = buf.byteLength >= 4 ? TD.decode(buf.subarray(0, 4)) : "";
  if (buf.byteLength < 8 || mag !== "KG14") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const elen = r.vbyte();
  if (r.off + elen > r.end) return;
  let ebuf = elen ? buf.subarray(r.off, r.off + elen) : EMPTY_U8;
  r.off += elen;
  if (!ebuf.byteLength && extraEdges && extraEdges.byteLength) ebuf = extraEdges;
  if (ebuf.byteLength >= 4) {
    const em = TD.decode(ebuf.subarray(0, 4));
    if (!isEgMagic(em)) return;
  }
  const decoded = ebuf.byteLength ? decodeRfcEdges(ebuf) : { obs: [], upd: [] };
  const E = edgeEndpointsFromDecoded(decoded.obs, decoded.upd);
  const hlen = r.vbyte();
  if (r.off + hlen > r.end) return;
  const overlay = decodeHotOverlay(buf.subarray(r.off, r.off + hlen));
  r.off += hlen;
  if (r.off + 2 > r.end) return;
  const max = r.u16();
  const isoLen = r.vbyte();
  if (r.off + isoLen > r.end) return;
  const isoR = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), r.off, r.off + isoLen);
  const iso = decodeIso(isoR, buf, E, max);
  r.off += isoLen;
  const ilen = r.vbyte();
  if (r.off + ilen > r.end) return;
  const impR = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), r.off, r.off + ilen);
  const implied = decodeImplied(impR, buf, E);
  r.off += ilen;
  const alen = r.vbyte();
  if (r.off + alen > r.end) return;
  const areaBuf = buf.subarray(r.off, r.off + alen);
  r.off += alen;
  const nums = unionSorted(iso, implied);
  const parsed = numsToParsed(nums);
  const nCold = nums.length - overlay.size;
  let areas: number[];
  const sparse = decodeAreaSparse(areaBuf);
  if (sparse && sparse.length === nCold) {
    areas = sparse;
  } else {
    const areaExpect = (nCold + 1) >> 1;
    if (nCold > 0 && areaBuf.byteLength !== areaExpect) return;
    areas = decodeNibbleCol(areaBuf, nCold);
  }
  let ai = 0;
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]!;
    if (overlay.has(n)) continue;
    overlay.set(n, RFC_AREAS[areas[ai++] ?? 15] ?? "Internet");
  }
  return { parsed, overlay, ebuf, catRaw: readKgCat(r, buf) };
}

function decodeKg14(buf: Uint8Array, flags: number, extraEdges?: Uint8Array): KnowPack {
  const g = parseKg14(buf, extraEdges);
  if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
  return knowFromTlv(kg12RfcCol(g), g.catRaw, flags);
}

/**
 * Closed-universe IETF title morphemes. Decoder-side codec dictionary —
 * the words, not an RFC→title map. Token streams live in graph.kpk.
 */
const IETF_MORPHEMES: readonly string[] = [
  "Protocol",
  "Internet",
  "Network",
  "IPv6",
  "IP",
  "HTTP",
  "TCP",
  "UDP",
  "TLS",
  "DNS",
  "MIME",
  "SMTP",
  "SIP",
  "RTP",
  "IPsec",
  "BGP",
  "OSPF",
  "MPLS",
  "LDAP",
  "SNMP",
  "FTP",
  "NTP",
  "URI",
  "URL",
  "IRI",
  "XML",
  "JSON",
  "HTML",
  "UTF",
  "ASCII",
  "for",
  "of",
  "and",
  "the",
  "in",
  "to",
  "A",
  "The",
  "with",
  "on",
  "Extension",
  "Mechanisms",
  "Management",
  "Architecture",
  "Requirements",
  "Framework",
  "Specification",
  "Version",
  "Security",
  "Authentication",
  "Authorization",
  "Message",
  "Format",
  "Transfer",
  "Control",
  "Service",
  "Services",
  "Data",
  "Packet",
  "Routing",
  "Address",
  "Addresses",
  "Domain",
  "Name",
  "Names",
  "System",
  "Resource",
  "Identifier",
  "Identifiers",
  "Generic",
  "Syntax",
  "Semantics",
  "Header",
  "Headers",
  "Field",
  "Fields",
  "Status",
  "Code",
  "Codes",
  "Media",
  "Type",
  "Types",
  "Charset",
  "Encoding",
  "Compression",
  "Congestion",
  "Transport",
  "Layer",
  "Application",
  "Session",
  "Connection",
  "Multicast",
  "Unicast",
  "IPv4",
  "ICMPv6",
  "DHCP",
  "PPP",
  "Ethernet",
  "Wireless",
  "Mobile",
  "Host",
  "Hosts",
  "Server",
  "Client",
  "Proxy",
  "Cache",
  "Caching",
  "Cookie",
  "Cookies",
  "Web",
  "Socket",
  "Sockets",
  "Stream",
  "Datagram",
  "Payload",
  "Options",
  "Option",
  "Parameter",
  "Parameters",
  "Profile",
  "Profiles",
  "Information",
  "Model",
  "Models",
  "Object",
  "Notation",
  "Language",
  "Description",
  "Interface",
  "Interfaces",
  "Configuration",
  "Discovery",
  "Negotiation",
  "Key",
  "Keys",
  "Certificate",
  "Certificates",
  "Public",
  "Private",
  "Cryptographic",
  "Hash",
  "HMAC",
  "AES",
  "SHA",
  "PKI",
  "X",
  "509",
  "SASL",
  "OAuth",
  "JOSE",
  "Realtime",
  "Time",
  "Clock",
  "Timestamp",
  "Zone",
  "File",
  "Directory",
  "Path",
  "Computation",
  "Element",
  "Communication",
  "Usage",
  "Updates",
  "Update",
  "Obsoletes",
  "Standard",
  "Track",
  "Best",
  "Current",
  "Practice",
  "Experimental",
  "Informational",
];

const IETF_MORPHEME_ID = new Map(IETF_MORPHEMES.map((w, i) => [w, i + 1]));

/**
 * TM15: token ids in RFC order. 1..173 = IETF_MORPHEMES (decoder dictionary).
 * Remaining words live in the blob. Decode does not open rfc-titles.bin.
 */
function encodeTm15(titles: string[]): Uint8Array {
  if (!titles.length) return EMPTY_U8;
  const seqs = titles.map(titleNospace);
  for (let i = 0; i < titles.length; i++) {
    if (titleReconstruct(seqs[i]!) !== titles[i]) return EMPTY_U8;
  }
  const freq = new Map<string, number>();
  for (const ps of seqs) {
    for (const p of ps) {
      if (IETF_MORPHEME_ID.has(p)) continue;
      freq.set(p, (freq.get(p) ?? 0) + 1);
    }
  }
  const extra = [...freq.keys()].sort((a, b) => freq.get(b)! - freq.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  const extraId = new Map(extra.map((t, i) => [t, IETF_MORPHEMES.length + 1 + i]));
  const w = new Writer();
  w.utf8("TM15");
  const blob = encodeNulVocab(extra);
  w.vbyte(blob.length);
  w.bytes(blob);
  w.vbyte(seqs.length);
  for (const ps of seqs) {
    for (const p of ps) w.vbyte(IETF_MORPHEME_ID.get(p) ?? extraId.get(p) ?? 0);
    w.vbyte(0);
  }
  return w.finish();
}

function decodeTm15(buf: Uint8Array): string[] {
  if (buf.byteLength < 6 || TD.decode(buf.subarray(0, 4)) !== "TM15") return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const vlen = r.vbyte();
  if (r.off + vlen > r.end) return [];
  const extra = vlen ? TD.decode(buf.subarray(r.off, r.off + vlen)).split("\0") : [];
  r.off += vlen;
  const vocab = (IETF_MORPHEMES as readonly string[]).concat(extra);
  const n = r.vbyte();
  const out: string[] = [];
  for (let i = 0; i < n && r.off < r.end; i++) {
    const parts: string[] = [];
    for (;;) {
      if (r.off >= r.end) break;
      const id = r.vbyte();
      if (id === 0) break;
      parts.push(vocab[id - 1] ?? "");
    }
    out.push(titleReconstruct(parts));
  }
  return out;
}

function pickTitleBody(titles: string[]): Uint8Array {
  const cands: Uint8Array[] = [encodeTm15(titles), encodeNt08(titles), encodeHoa1(titles)];
  const rt = encodeRt14(titles);
  if (rt.byteLength) cands.push(rt);
  let best = EMPTY_U8;
  for (const b of cands) {
    if (!b.byteLength || !titleRoundtrips(b, titles)) continue;
    if (!best.byteLength || b.byteLength < best.byteLength) best = b;
  }
  return best;
}

/** KG15: identity + in-file title token stream + edges + catalog. No decoder title map. */
function encodeKg15(
  nums: number[],
  titles: string[],
  edges: Uint8Array,
  parts: Array<Uint8Array | undefined>,
  titleBody?: Uint8Array,
): Uint8Array {
  const w = new Writer();
  w.utf8("KG15");
  const nenc = encodeRfcNumsCompact(nums);
  w.vbyte(nenc.length);
  w.bytes(nenc);
  const tb = titleBody ?? pickTitleBody(titles);
  w.vbyte(tb.length);
  w.bytes(tb);
  w.vbyte(edges.length);
  w.bytes(edges);
  appendKgCat(w, parts);
  return w.finish();
}

function parseKg15(buf: Uint8Array, extraEdges?: Uint8Array): Kg12 | undefined {
  if (buf.byteLength < 8 || TD.decode(buf.subarray(0, 4)) !== "KG15") return;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nlen = r.vbyte();
  if (r.off + nlen > r.end) return;
  const parsed = decodeRfcNumsCompact(buf.subarray(r.off, r.off + nlen));
  r.off += nlen;
  const tlen = r.vbyte();
  if (r.off + tlen > r.end) return;
  const titles = tlen ? decodeTitleBody(buf.subarray(r.off, r.off + tlen)) : [];
  r.off += tlen;
  const elen = r.vbyte();
  if (r.off + elen > r.end) return;
  let ebuf = elen ? buf.subarray(r.off, r.off + elen) : EMPTY_U8;
  r.off += elen;
  if (!ebuf.byteLength && extraEdges && extraEdges.byteLength) ebuf = extraEdges;
  if (ebuf.byteLength >= 4 && !isEgMagic(TD.decode(ebuf.subarray(0, 4)))) return;
  const nums = bitsToNums(parsed.bits, parsed.max, parsed.count);
  const overlay = overlayFromTitles(nums, titles);
  return { parsed, overlay, ebuf, catRaw: readKgCat(r, buf) };
}

function kg15RfcCol(g: Kg12): RfcCol {
  return kg12RfcCol(g);
}

function decodeKg15(buf: Uint8Array, flags: number, extraEdges?: Uint8Array): KnowPack {
  const g = parseKg15(buf, extraEdges);
  if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
  return knowFromTlv(kg15RfcCol(g), g.catRaw, flags);
}

type Kg12 = {
  parsed: { max: number; bits: Uint8Array; count: number };
  overlay: Map<number, string>;
  ebuf: Uint8Array;
  catRaw: Uint8Array;
  decodedEdges?: { obs: { src: number; dests: number[] }[]; upd: { src: number; dests: number[] }[] };
  closedCaps?: boolean;
  pendingArea?: Uint8Array;
};

function parseKg12Body(r: Reader, buf: Uint8Array, readLen: (r: Reader) => number): Kg12 | undefined {
  const nlen = readLen(r);
  if (r.off + nlen > r.end) return;
  const parsed = decodeRfcNumsCompact(peelBlob(buf.subarray(r.off, r.off + nlen)));
  r.off += nlen;
  const hlen = readLen(r);
  if (r.off + hlen > r.end) return;
  const overlay = decodeHotOverlay(peelBlob(buf.subarray(r.off, r.off + hlen)));
  r.off += hlen;
  const alen = readLen(r);
  if (r.off + alen > r.end) return;
  const areaBuf = peelBlob(buf.subarray(r.off, r.off + alen));
  r.off += alen;
  const elen = readLen(r);
  if (r.off + elen > r.end) return;
  const ebuf = elen ? peelBlob(buf.subarray(r.off, r.off + elen)) : EMPTY_U8;
  r.off += elen;
  if (ebuf.byteLength >= 4) {
    const mag = TD.decode(ebuf.subarray(0, 4));
    if (!isEgMagic(mag)) return;
  }
  const nums = bitsToNums(parsed.bits, parsed.max, parsed.count);
  const decoded = ebuf.byteLength ? decodeRfcEdges(ebuf, nums) : { obs: [], upd: [] };
  const edgeSet = new Set(edgeEndpointsFromDecoded(decoded.obs, decoded.upd));
  const as15 = areaBuf.byteLength >= 4 && TD.decode(areaBuf.subarray(0, 4)) === "AS15";
  if (!areaBuf.byteLength) {
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!;
      if (!overlay.has(n)) overlay.set(n, "Internet");
    }
  } else if (as15) {
    let nEdgeCold = 0;
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!;
      if (!overlay.has(n) && edgeSet.has(n)) nEdgeCold++;
    }
    const areas = decodeAs15(areaBuf, nEdgeCold) ?? [];
    let ai = 0;
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!;
      if (overlay.has(n)) continue;
      overlay.set(n, edgeSet.has(n) ? (RFC_AREAS[areas[ai++] ?? 15] ?? "Internet") : "Internet");
    }
  } else {
    const nCold = nums.length - overlay.size;
    let areas: number[];
    const sparse = decodeAreaSparse(areaBuf);
    if (sparse && sparse.length === nCold) {
      areas = sparse;
    } else {
      const areaExpect = (nCold + 1) >> 1;
      if (nCold > 0 && areaBuf.byteLength !== areaExpect) return;
      areas = decodeNibbleCol(areaBuf, nCold);
    }
    let ai = 0;
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!;
      if (overlay.has(n)) continue;
      overlay.set(n, RFC_AREAS[areas[ai++] ?? 15] ?? "Internet");
    }
  }
  return { parsed, overlay, ebuf, catRaw: readKgCat(r, buf) };
}

function parseKg12(buf: Uint8Array): Kg12 | undefined {
  const mag = buf.byteLength >= 4 ? TD.decode(buf.subarray(0, 4)) : "";
  if (buf.byteLength < 8 || (mag !== "KG12" && mag !== "KG13")) return;
  const vbyte = parseKg12Body(
    new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength),
    buf,
    (r) => r.vbyte(),
  );
  if (vbyte) return vbyte;
  return parseKg12Body(
    new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength),
    buf,
    (r) => r.u32(),
  );
}

function kg12RfcCol(g: Kg12): RfcCol {
  const decoded = g.decodedEdges;
  return {
    bits: g.parsed.bits,
    max: g.parsed.max,
    count: g.parsed.count,
    overlay: g.overlay,
    obs: decoded?.obs ?? [],
    upd: decoded?.upd ?? [],
    edgeRaw: decoded ? EMPTY_U8 : g.ebuf,
    titlesComplete: true,
  };
}

function decodeKg12(buf: Uint8Array, flags: number): KnowPack {
  const g = parseKg12(buf);
  if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
  return knowFromTlv(kg12RfcCol(g), g.catRaw, flags);
}

function titleBodiesFor(titles: string[]): Uint8Array[] {
  if (!titles.length) return [EMPTY_U8];
  const nulW = new Writer();
  nulW.utf8("NT08");
  nulW.bytes(TE.encode(titles.join("\0")));
  const out: Uint8Array[] = [nulW.finish(), encodeSn08(titles)];
  const rt = encodeRt12(titles);
  if (rt.byteLength) out.push(rt);
  const rp = encodeRp12(titles);
  if (rp.byteLength) out.push(rp);
  out.push(encodeTitlePfcSorted(titles));
  out.push(encodeTitleFsst(titles));
  out.push(encodeTitleRepair(titles));
  if (titles.length <= 512) out.push(encodeTitleWordDict(titles));
  return out.filter((b) => b.byteLength);
}

function titleRoundtrips(tb: Uint8Array, titles: string[]): boolean {
  const got = decodeTitleBody(tb);
  if (got.length !== titles.length) return false;
  for (let i = 0; i < titles.length; i++) if (got[i] !== titles[i]) return false;
  return true;
}

function brotliRawLen(raw: Uint8Array, q: number): number {
  if (raw.byteLength < BROTLI_MIN) return raw.byteLength;
  try {
    return brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: q,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
      },
    }).byteLength;
  } catch {
    return raw.byteLength;
  }
}

function isBr08(buf: Uint8Array): boolean {
  return buf.byteLength >= 4 && TD.decode(buf.subarray(0, 4)) === BR08_MAGIC;
}

function br08Payload(buf: Uint8Array): Uint8Array | undefined {
  if (!isBr08(buf) || buf.byteLength < 8) return;
  const len = new DataView(buf.buffer, buf.byteOffset + 4, 4).getUint32(0, true);
  if (8 + len > buf.byteLength) return;
  return buf.subarray(8, 8 + len);
}

function unzipRfcSlice(buf: Uint8Array, flags: number): Uint8Array {
  if (isBr08(buf) || isZstdFrame(buf)) return unzipSection(buf);
  if (flags & KPK9_BR) {
    try {
      const out = brotliDecompressSync(buf);
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    } catch {
      return buf;
    }
  }
  if (flags & KPK9_ZSTD) {
    try {
      const out = zstdDecompressSync(buf);
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    } catch {
      return buf;
    }
  }
  return buf;
}

function frameKpk9(rfcBody: Uint8Array, resBody: Uint8Array, flags: number): Uint8Array {
  let body = rfcBody;
  let f = flags;
  const payload = !(f & KPK9_BR) && !resBody.byteLength ? br08Payload(rfcBody) : undefined;
  if (payload) {
    body = payload;
    f |= KPK9_BR;
  }
  const out = new Writer();
  out.utf8(PACK_MAGIC9);
  out.u8(f);
  out.vbyte(body.length);
  out.bytes(body);
  out.bytes(resBody);
  return out.finish();
}

/** Pick the kernel wrapping whose framed pack is smallest (naked brotli vs zstd-22 vs raw). */
function frameKg(kg: Uint8Array, rest: Uint8Array = EMPTY_U8): Uint8Array {
  let best = frameKpk9(kg, rest, 0);
  const take = (f: Uint8Array) => {
    if (f.byteLength && f.byteLength < best.byteLength) best = f;
  };
  const tryInner = (inner: Uint8Array) => {
    if (!inner.byteLength) return;
    take(frameKpk9(inner, rest, 0));
  };
  tryInner(compactSection(kg));
  tryInner(tightInner(kg));
  tryInner(brotliSection(kg));
  if (kg.byteLength >= ZSTD_MIN) {
    try {
      const params: Record<number, number> = {};
      if (zlibConstants.ZSTD_c_compressionLevel !== undefined) params[zlibConstants.ZSTD_c_compressionLevel] = 22;
      if (kg.byteLength >= 2048 && zlibConstants.ZSTD_c_windowLog !== undefined)
        params[zlibConstants.ZSTD_c_windowLog] = 23;
      const z =
        Object.keys(params).length > 0
          ? new Uint8Array(zstdCompressSync(kg, { params }))
          : new Uint8Array(zstdCompressSync(kg));
      if (z.byteLength && z.byteLength < kg.byteLength) take(frameKpk9(z, rest, KPK9_ZSTD));
    } catch {
      /* */
    }
  }
  return best;
}

/** Raw vs naked brotli only. Large dumps skip zstd-22 / split / compact bake. */
function frameKgCheap(kg: Uint8Array, flags = 0): { name: string; pack: Uint8Array } {
  const raw = frameKpk9(kg, EMPTY_U8, flags);
  const br = brotliSection(kg);
  if (br.byteLength && br !== kg) {
    const framed = frameKpk9(br, EMPTY_U8, flags);
    if (framed.byteLength && framed.byteLength < raw.byteLength) return { name: "br", pack: framed };
  }
  return { name: "raw", pack: raw };
}

function encodeRfcColumn(
  rows: { n: number; title: string }[],
  obs: Map<number, number[]>,
  upd: Map<number, number[]>,
  omittedEmpty = false,
): Uint8Array {
  const bitset = encodeRfcBitset(rows.map((r) => r.n));
  const wrap = (body: Uint8Array, edges: Uint8Array) => {
    const w = new Writer();
    w.utf8("RI08");
    w.bytes(bitset);
    w.u32(body.length);
    w.bytes(body);
    w.bytes(edges);
    return w.finish();
  };
  const omitted = omittedEmpty ? EMPTY_U8 : encodeOmittedTitles(rows);
  const edges = encodeEg09(obs, upd);
  if (omitted.byteLength < 4096) return wrap(omitted, edges);
  const titles = rows.map((r) => r.title);
  const nulW = new Writer();
  nulW.utf8("NT08");
  nulW.bytes(TE.encode(titles.join("\0")));
  const bodies = [
    omitted,
    nulW.finish(),
    encodeTitleWordDict(titles),
    encodeTitleWordDict(titles, 768),
    encodeCappedTitles(titles),
    encodeTitlePfcSorted(titles),
    encodeTitleFsst(titles),
    encodeTitleRepair(titles),
    encodeTitleBaked(titles),
  ];
  const punctW = new Writer();
  punctW.utf8("WD04");
  punctW.bytes(encodeWordDict(titles));
  bodies.push(punctW.finish());
  let best = wrap(omitted, edges);
  for (const body of bodies) {
    const cand = wrap(body, edges);
    if (cand.byteLength < best.byteLength) best = cand;
  }
  return best;
}

function decodeRfcColumn(buf: Uint8Array): RfcCol {
  const none: RfcCol = {
    bits: EMPTY_U8,
    max: 0,
    count: 0,
    overlay: new Map(),
    obs: [],
    upd: [],
  };
  if (buf.byteLength < 4) return none;
  const mag = TD.decode(buf.subarray(0, 4));
  if (mag === "RI09") return decodeRi09(buf);
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  if (mag === "RI08") {
    const { max, bits, count } = decodeRfcBitset(r, buf);
    const nOrLen = r.u32();
    if (nOrLen === 0) {
      return { bits, max, count, overlay: new Map(), obs: [], upd: [], edgeRaw: buf.subarray(r.off) };
    }
    const head = r.off + 4 <= r.end ? TD.decode(buf.subarray(r.off, r.off + 4)) : "";
    let overlay: Map<number, string>;
    if (head === "OM09") {
      overlay = decodeOm09Map(buf.subarray(r.off, r.off + nOrLen));
      r.off += nOrLen;
    } else if (
      head === "NT08" ||
      head === "WD08" ||
      head === "RT07" ||
      head === "WD04" ||
      head === "WD03" ||
      head === "TP08" ||
      head === "FS09" ||
      head === "RP09" ||
      head === "BV09" ||
      head === "RT11" ||
      head === "RT12" ||
      head === "RT13" ||
      head === "RT14" ||
      head === "LC14" ||
      head === "AT11" ||
      head === "TM11" ||
      head === "TL11" ||
      head === "RP12" ||
      head === "SN08" ||
      head === "BW13"
    ) {
      const titles = decodeTitleBody(buf.subarray(r.off, r.off + nOrLen));
      r.off += nOrLen;
      overlay = overlayFromTitles(bitsToNums(bits, max, count), titles);
    } else {
      const titledNums: number[] = [];
      let prev = 0;
      for (let i = 0; i < nOrLen; i++) {
        prev += r.vbyte();
        titledNums.push(prev);
      }
      const titles = decodeCappedTitles(buf.subarray(r.off));
      overlay = new Map();
      for (let i = 0; i < titledNums.length; i++) {
        const n = titledNums[i]!;
        const t = titles[i] ?? "current";
        if (t) overlay.set(n, t);
      }
      r.off = r.end;
    }
    const titlesComplete = head !== "OM09" && overlay.size === count;
    return { bits, max, count, overlay, obs: [], upd: [], edgeRaw: buf.subarray(r.off), titlesComplete };
  }
  if (mag !== "RI07") return none;
  const n = r.u32();
  const numsArr: number[] = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += r.vbyte();
    numsArr.push(prev);
  }
  const titles = decodeCappedTitles(buf.subarray(r.off));
  const nums = Uint32Array.from(numsArr);
  const max = numsArr.length ? numsArr[numsArr.length - 1]! : 0;
  const bits = new Uint8Array((max + 8) >> 3);
  for (const num of numsArr) bits[num >> 3]! |= 1 << (num & 7);
  return { bits, max, count: numsArr.length, overlay: overlayFromTitles(nums, titles), obs: [], upd: [] };
}

function buildTypedFacts(facts: PackFact[]) {
  const kept = facts.filter((f) => PRED_ID.has(f.p as (typeof PACK_PREDS)[number]) && packableFact(f.s, f.p, f.o));
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
  const take = (s: string) => takeId(s, slugs, lists, media, spdx, scheme, whatwg, block, method, rel, wk, pfc);
  for (const f of kept) {
    take(f.s);
    if (!omittedCatalogObject(f.s, f.p, f.o)) take(f.o);
    if (f.url && /^https?:\/\//i.test(f.url) && f.url.length <= 240 && !/[\s<>"'\\]/.test(f.url)) pfc.add(f.url);
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

function aliasPri(id: number): number {
  const k = idKind(id);
  if (
    k === KIND_MEDIA ||
    k === KIND_METHOD ||
    k === KIND_HTTP ||
    k === KIND_PROTO ||
    k === KIND_SCHEME ||
    k === KIND_SPDX
  ) {
    return 0;
  }
  if (k === KIND_LANG || k === KIND_RFC) return 2;
  return 3;
}

function offerAlias(claimed: Map<string, number>, key: string, sid: number) {
  const k = key.toLowerCase().trim();
  if (k.length < 2 || k.length > 80) return;
  const prev = claimed.get(k);
  if (prev === undefined || prev === sid) {
    claimed.set(k, sid);
    return;
  }
  if (prev < 0) return;
  if (aliasPri(sid) < aliasPri(prev)) claimed.set(k, sid);
  else if (aliasPri(sid) === aliasPri(prev)) claimed.set(k, -1);
}

function claimAliases(claimed: Map<string, number>, subj: string, obj: string, sid: number) {
  if (!obj) obj = catalogObjectSynth(subj, "is") ?? "";
  const proto = ianaProtocol(subj);
  if (proto !== undefined) offerAlias(claimed, obj, sid);
  const http = ianaHttp(subj);
  if (http !== undefined) offerAlias(claimed, String(http), sid);
  const spdx = spdxId(subj);
  if (spdx && spdxAliasable(spdx)) offerAlias(claimed, spdx, sid);
  const media = ianaMedia(subj);
  if (media) {
    const sub = media.split("/")[1];
    if (sub && aliasableMediaSubtype(sub)) offerAlias(claimed, sub, sid);
  }
  const scheme = ianaScheme(subj);
  if (scheme) offerAlias(claimed, scheme, sid);
  const wg = whatwgSlug(subj);
  if (wg) offerAlias(claimed, wg, sid);
  const block = unicodeBlock(subj);
  if (block) offerAlias(claimed, block, sid);
  const lang = ianaLanguage(subj);
  if (lang) {
    offerAlias(claimed, lang, sid);
    offerAlias(claimed, obj, sid);
  }
  const method = ianaMethod(subj);
  if (method) offerAlias(claimed, method, sid);
  const reln = ianaRel(subj);
  if (reln) offerAlias(claimed, reln, sid);
  const wk = ianaWellKnown(subj);
  if (wk) offerAlias(claimed, wk, sid);
  const script = unicodeScript(subj);
  if (script) {
    offerAlias(claimed, script, sid);
    offerAlias(claimed, obj, sid);
  }
  const charset = ianaCharset(subj);
  if (charset) offerAlias(claimed, charset, sid);
  const header = ianaHeader(subj);
  if (header) offerAlias(claimed, header, sid);
  const dns = ianaDns(subj);
  if (dns) offerAlias(claimed, dns, sid);
}

function decodeAliases(buf: Uint8Array): Map<string, number> {
  if (buf.byteLength < 4) return new Map();
  const mag = TD.decode(buf.subarray(0, 4));
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
  if (buf.byteLength < 4) return [];
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
        ? remapKpk3Id(
            (((local >>> 0) & 0x3fffffff) |
              (kind === 1 ? RFC_TAG : kind === 2 ? W3C_TAG : kind === 3 ? LIST_TAG : 0)) >>>
              0,
          )
        : packId(kind, local);
      pid[idx] = p;
      origAll.push(idx);
    }
  }
  return origAll;
}

function isoIndex(code: string): number {
  return (code.charCodeAt(0) - 65) * 26 + (code.charCodeAt(1) - 65);
}

function isoFromIndex(i: number): string {
  return String.fromCharCode(65 + ((i / 26) | 0), 65 + (i % 26));
}

function encodeCapColPfc(pairs: { s: string; o: string }[]): Uint8Array {
  if (!pairs.length) return EMPTY_U8;
  const countries = [...new Set(pairs.map((p) => p.s))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const allSynth = pairs.every((p) => capitalOf(p.s) === p.o);
  const w = new Writer();
  const cb = encodePfc(countries);
  w.u32(cb.length);
  w.bytes(cb);
  if (allSynth) {
    w.u32(0);
    w.u32(countries.length);
    w.u8(0);
    return w.finish();
  }
  const cities = [...new Set(pairs.map((p) => p.o))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ci = new Map(countries.map((s, i) => [s, i]));
  const oi = new Map(cities.map((s, i) => [s, i]));
  const ob = encodePfc(cities);
  w.u32(ob.length);
  w.bytes(ob);
  w.u32(pairs.length);
  const u16 = countries.length <= 65535 && cities.length <= 65535;
  w.u8(u16 ? 1 : 2);
  for (const p of pairs) {
    if (u16) {
      w.u16(ci.get(p.s)!);
      w.u16(oi.get(p.o)!);
    } else {
      w.vbyte(ci.get(p.s)!);
      w.vbyte(oi.get(p.o)!);
    }
  }
  return w.finish();
}

function encodeCapIso(pairs: { s: string; o: string }[]): Uint8Array {
  if (!pairs.length) return EMPTY_U8;
  iso2Maps();
  const codes: string[] = [];
  const extra: { s: string; o: string }[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const code = NAME_TO_ISO2!.get(p.s);
    if (code && ISO2_TO_NAME!.get(code) === p.s && capitalOf(p.s) === p.o && !seen.has(code)) {
      codes.push(code);
      seen.add(code);
    } else extra.push(p);
  }
  if (!codes.length) return EMPTY_U8;
  codes.sort();
  const extraB = extra.length ? encodeCapColPfc(extra) : EMPTY_U8;
  const packed = new Writer();
  packed.utf8("CI16");
  packed.u8(0);
  packed.vbyte(codes.length);
  for (const c of codes) packed.utf8(c);
  packed.vbyte(extraB.length);
  packed.bytes(extraB);
  const mask = new Writer();
  mask.utf8("CI16");
  mask.u8(1);
  const bits = new Uint8Array(85);
  for (const c of codes) {
    const i = isoIndex(c);
    bits[i >> 3]! |= 1 << (i & 7);
  }
  mask.bytes(bits);
  mask.vbyte(extraB.length);
  mask.bytes(extraB);
  const uni: string[] = [];
  for (const line of ISO2_TAB.split("\n")) {
    const code = line.slice(0, 2);
    const name = line.slice(3);
    if (capitalOf(name)) uni.push(code);
  }
  const present = new Set(codes);
  const holes = uni.filter((c) => !present.has(c));
  const holeW = new Writer();
  holeW.utf8("CI16");
  holeW.u8(2);
  holeW.vbyte(holes.length);
  for (const c of holes) holeW.utf8(c);
  holeW.vbyte(extraB.length);
  holeW.bytes(extraB);
  const cands = [packed.finish(), mask.finish(), holeW.finish()];
  let best = cands[0]!;
  for (const c of cands) if (c.length < best.length) best = c;
  return best;
}

function capUni(): string[] {
  return Object.keys(CAPITAL_OF).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function encodeCapSynth(pairs: { s: string; o: string }[]): Uint8Array {
  if (!pairs.length) return EMPTY_U8;
  const uni = capUni();
  const idx = new Map(uni.map((s, i) => [s, i]));
  const bits = new Uint8Array((uni.length + 7) >> 3);
  const extra: { s: string; o: string }[] = [];
  let nHit = 0;
  for (const p of pairs) {
    const i = idx.get(p.s);
    if (i !== undefined && CAPITAL_OF[p.s] === p.o) {
      bits[i >> 3]! |= 1 << (i & 7);
      nHit++;
    } else extra.push(p);
  }
  if (!nHit) return EMPTY_U8;
  const extraB = extra.length ? encodeCapColPfc(extra) : EMPTY_U8;
  const full = nHit === uni.length && !extra.length;
  if (full) {
    const w = new Writer();
    w.utf8("CI16");
    w.u8(4);
    return w.finish();
  }
  const w = new Writer();
  w.utf8("CI16");
  w.u8(3);
  w.vbyte(uni.length);
  w.bytes(bits);
  w.vbyte(extraB.length);
  w.bytes(extraB);
  return w.finish();
}

function encodeCapCol(pairs: { s: string; o: string }[]): Uint8Array {
  const pfc = encodeCapColPfc(pairs);
  const iso = encodeCapIso(pairs);
  const synth = encodeCapSynth(pairs);
  let best = pfc;
  if (iso.byteLength && iso.byteLength < best.byteLength) best = iso;
  if (synth.byteLength && synth.byteLength < best.byteLength) best = synth;
  return best;
}

function decodeCapColPfc(buf: Uint8Array): { s: string; o: string }[] {
  if (buf.byteLength < 9) return [];
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.byteLength);
  const clen = r.u32();
  const countries = decodePfc(buf.subarray(r.off, r.off + clen));
  r.off += clen;
  const olen = r.u32();
  const cities = olen ? decodePfc(buf.subarray(r.off, r.off + olen)) : [];
  r.off += olen;
  const n = r.u32();
  const mode = r.u8();
  if (mode === 0) {
    return countries.map((s) => ({ s, o: capitalOf(s) ?? "" }));
  }
  const u16 = mode === 1;
  const out: { s: string; o: string }[] = [];
  for (let i = 0; i < n && r.off < r.end; i++) {
    const c = u16 ? r.u16() : r.vbyte();
    const o = u16 ? r.u16() : r.vbyte();
    out.push({ s: countries[c] ?? "", o: cities[o] ?? "" });
  }
  return out;
}

function decodeCapIso(buf: Uint8Array): { s: string; o: string }[] {
  iso2Maps();
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const mode = r.u8();
  if (mode === 4) {
    return capUni().map((s) => ({ s, o: CAPITAL_OF[s] ?? "" }));
  }
  if (mode === 3) {
    const nUni = r.vbyte();
    const uni = capUni();
    if (nUni !== uni.length) return [];
    const blen = (uni.length + 7) >> 3;
    if (r.off + blen > r.end) return [];
    const bits = buf.subarray(r.off, r.off + blen);
    r.off += blen;
    const extraLen = r.vbyte();
    const extra = extraLen && r.off + extraLen <= r.end ? decodeCapCol(buf.subarray(r.off, r.off + extraLen)) : [];
    const out: { s: string; o: string }[] = [];
    for (let i = 0; i < uni.length; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) out.push({ s: uni[i]!, o: CAPITAL_OF[uni[i]!] ?? "" });
    }
    out.push(...extra);
    return out;
  }
  const codes: string[] = [];
  if (mode === 1) {
    if (r.off + 85 > r.end) return [];
    for (let i = 0; i < 676; i++) {
      if (buf[r.off + (i >> 3)]! & (1 << (i & 7))) codes.push(isoFromIndex(i));
    }
    r.off += 85;
  } else if (mode === 2) {
    const n = r.vbyte();
    const holes = new Set<string>();
    for (let i = 0; i < n && r.off + 2 <= r.end; i++) holes.add(r.utf8(2));
    for (const line of ISO2_TAB.split("\n")) {
      const code = line.slice(0, 2);
      const name = line.slice(3);
      if (capitalOf(name) && !holes.has(code)) codes.push(code);
    }
  } else {
    const n = r.vbyte();
    for (let i = 0; i < n && r.off + 2 <= r.end; i++) codes.push(r.utf8(2));
  }
  const extraLen = r.vbyte();
  const extra = extraLen && r.off + extraLen <= r.end ? decodeCapCol(buf.subarray(r.off, r.off + extraLen)) : [];
  const out: { s: string; o: string }[] = [];
  for (const code of codes) {
    const s = ISO2_TO_NAME!.get(code);
    if (!s) continue;
    out.push({ s, o: capitalOf(s) ?? "" });
  }
  out.push(...extra);
  return out;
}

function decodeCapCol(buf: Uint8Array): { s: string; o: string }[] {
  if (buf.byteLength < 5) return [];
  if (TD.decode(buf.subarray(0, 4)) === "CI16") return decodeCapIso(buf);
  return decodeCapColPfc(buf);
}

function writeBakeoff(report: Record<string, number | string>) {
  try {
    writeFileSync(
      new URL("../../../.gauntlet/refs/pack-bakeoff.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  } catch {
    /* */
  }
}

function filterEdgeSrc(m: Map<number, number[]>, keep: Set<number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [src, dests] of m) if (keep.has(src)) out.set(src, dests);
  return out;
}

function hotUniverseReady(rfcMap: Map<number, string>): boolean {
  for (const n of HOTSET_REQUIRED) if (!rfcMap.has(n)) return false;
  if (rfcMap.size >= 4000) return true;
  for (const n of rfcMap.keys()) if (!KG12_HOT.has(n)) return false;
  return true;
}

/** Keep inner BR08/zstd whenever framed bytes beat raw. Hotset-only; global slack stays. */
function tightInner(raw: Uint8Array): Uint8Array {
  if (!raw.byteLength) return raw;
  let best = raw;
  const keep = (c: Uint8Array) => {
    if (c.byteLength && c.byteLength < best.byteLength) best = c;
  };
  try {
    const params: Record<number, number> = { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY };
    if (zlibConstants.BROTLI_PARAM_SIZE_HINT !== undefined)
      params[zlibConstants.BROTLI_PARAM_SIZE_HINT] = raw.byteLength;
    if (zlibConstants.BROTLI_PARAM_LGWIN !== undefined) params[zlibConstants.BROTLI_PARAM_LGWIN] = 24;
    const c = new Uint8Array(brotliCompressSync(raw, { params }));
    const w = new Writer();
    w.utf8(BR08_MAGIC);
    w.u32(c.byteLength);
    w.bytes(c);
    keep(w.finish());
  } catch {
    /* */
  }
  for (const lvl of [1, 3, 19, 22]) {
    try {
      const params: Record<number, number> = {};
      if (zlibConstants.ZSTD_c_compressionLevel !== undefined) params[zlibConstants.ZSTD_c_compressionLevel] = lvl;
      const c =
        Object.keys(params).length > 0
          ? new Uint8Array(zstdCompressSync(raw, { params }))
          : new Uint8Array(zstdCompressSync(raw));
      keep(c);
    } catch {
      /* */
    }
  }
  return best;
}

/** Closed working set kernel — only considered when nTriples matches the full input. */
function encodeHotsetKernel(
  nums: number[],
  titles: string[],
  obs: Map<number, number[]>,
  upd: Map<number, number[]>,
  parts: Array<Uint8Array | undefined>,
): { name: string; pack: Uint8Array } | undefined {
  if (!nums.length) return;
  const edgeVars: { name: string; buf: Uint8Array }[] = [
    { name: "EG14", buf: encodeEg14(obs, upd) },
    { name: "EG13", buf: encodeEg13(obs, upd) },
    { name: "EG12", buf: encodeEg12(obs, upd) },
    { name: "EG11", buf: encodeEg11(obs, upd) },
    { name: "EG10", buf: encodeEg10(obs, upd) },
    { name: "EG09", buf: encodeEg09(obs, upd) },
    { name: "EG08", buf: encodeEg08(obs, upd) },
  ];
  const titleVars: { name: string; buf: Uint8Array }[] = [];
  const addT = (name: string, buf: Uint8Array) => {
    if (buf.byteLength && titleRoundtrips(buf, titles)) titleVars.push({ name, buf });
  };
  addT("NT08", encodeNt08(titles));
  addT("TM15", encodeTm15(titles));
  addT("FC08", encodeFc08(titles));
  addT("HOA1", encodeHoa1(titles));
  const picked = pickTitleBody(titles);
  if (picked.byteLength) addT("pick", picked);
  let best: { name: string; pack: Uint8Array } | undefined;
  const take = (name: string, body: Uint8Array) => {
    if (!body.byteLength) return;
    const pack = frameKpk9(tightInner(body), EMPTY_U8, 0);
    if (!best || pack.byteLength < best.pack.byteLength) best = { name, pack };
  };
  for (const ev of edgeVars) {
    for (const tv of titleVars) {
      take(`KG11+HOTSET+${tv.name}+${ev.name}`, encodeKg11(nums, tv.buf, ev.buf, parts));
      take(`KG15+HOTSET+${tv.name}+${ev.name}`, encodeKg15(nums, titles, ev.buf, parts, tv.buf));
    }
    take(`KG13+HOTSET+${ev.name}`, encodeKg13(nums, titles, ev.buf, parts, 0));
  }
  return best;
}

function hotsetGoldOk(pack: KnowPack, rfcMap: Map<number, string>): boolean {
  const t3986 = rfcMap.get(3986);
  if (t3986 && !allFacts(pack).some((f) => f.s === "RFC 3986" && f.p === "is" && f.o === t3986)) return false;
  const t9110 = rfcMap.get(9110);
  if (t9110 && !allFacts(pack).some((f) => f.s === "RFC 9110" && f.p === "is" && f.o === t9110)) return false;
  if (pack.search("RFC 35")[0]?.o !== "Network Meeting") return false;
  if (!pack.search("RFC 9110").some((f) => f.p === "obsoletes")) return false;
  return true;
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
  const rfcMap = new Map<number, string>();
  const obs = new Map<number, number[]>();
  const upd = new Map<number, number[]>();
  const rest: PackFact[] = [];
  const addEdge = (m: Map<number, number[]>, src: number, dests: number[]) => {
    const prev = m.get(src);
    if (prev) prev.push(...dests);
    else m.set(src, dests.slice());
  };
  for (const f of facts) {
    const pred = f.p;
    if (!PRED_ID.has(pred as (typeof PACK_PREDS)[number])) continue;
    const n = rfcNumExact(f.s) ?? rfcNumLoose(f.s);
    if (n !== undefined) {
      if (pred === "is") {
        const hinted = cleanRfcTitle(f.s.replace(/^RFC\s+\d{1,5}\s*[:\-–]\s*/i, ""));
        let title = cleanRfcTitle(f.o);
        const damaged = /&#|&quot;|&amp;|\|\s*RFC/i.test(f.o);
        if (junkRfcTitle(title) || (hinted.length > title.length && !junkRfcTitle(hinted))) {
          title = junkRfcTitle(hinted) ? "" : hinted;
        }
        if (damaged || junkRfcTitle(title)) {
          const official = rfcTitleOf(n);
          if (official && !junkRfcTitle(official)) title = official;
        }
        if (!title) continue;
        const prev = rfcMap.get(n);
        if (!prev || title.length > prev.length) rfcMap.set(n, title);
        continue;
      }
      if (pred === "obsoletes" || pred === "updates") {
        const dests = rfcDestNums(f.o);
        if (dests) {
          addEdge(pred === "obsoletes" ? obs : upd, n, dests);
          continue;
        }
      }
    }
    if ((pred === "obsoletes" || pred === "updates") && rfcListNums(f.s)) continue;
    if (!packableFact(f.s, pred, f.o)) continue;
    rest.push(f);
  }
  const rfcIs = [...rfcMap.entries()].map(([n, title]) => ({ n, title })).sort((a, b) => a.n - b.n);

  const headerSet = new Set<string>();
  const headerOver = new Map<string, string>();
  const dnsMap = new Map<string, string>();
  const charsetSet = new Set<string>();
  const charsetOver = new Map<string, string>();
  const mediaSet = new Set<string>();
  const spdxSet = new Set<string>();
  const schemeSet = new Set<string>();
  const whatwgSet = new Set<string>();
  const blockSet = new Set<string>();
  const methodSet = new Set<string>();
  const relSet = new Set<string>();
  const wkSet = new Set<string>();
  const slugSet = new Set<string>();
  const langSet = new Set<string>();
  const scriptSet = new Set<string>();
  const nameOver = new Map<string, string>();
  const protoBits = new Uint8Array(32);
  const httpBits = new Uint8Array(128);
  let hasProto = false;
  let hasHttp = false;
  const leftover: PackFact[] = [];
  const noteOver = (s: string, o: string) => {
    const syn = catalogObjectSynth(s, "is");
    if (syn === undefined) nameOver.set(s, o);
    else if (syn !== o && (ianaHeader(s) || ianaMethod(s))) nameOver.set(s, o);
  };
  for (const f of rest) {
    if (f.p !== "is") {
      leftover.push(f);
      continue;
    }
    const header = ianaHeader(f.s);
    if (header) {
      headerSet.add(header);
      if (catalogObjectSynth(f.s, f.p) !== f.o) headerOver.set(header, f.o);
      continue;
    }
    const dns = ianaDns(f.s);
    if (dns) {
      dnsMap.set(dns, f.o);
      continue;
    }
    const cs = ianaCharset(f.s);
    if (cs) {
      charsetSet.add(cs);
      if (catalogObjectSynth(f.s, f.p) !== f.o) charsetOver.set(cs, f.o);
      continue;
    }
    const proto = ianaProtocol(f.s);
    if (proto !== undefined) {
      protoBits[proto >> 3]! |= 1 << (proto & 7);
      hasProto = true;
      noteOver(f.s, f.o);
      continue;
    }
    const http = ianaHttp(f.s);
    if (http !== undefined) {
      if (http < 1024) {
        httpBits[http >> 3]! |= 1 << (http & 7);
        hasHttp = true;
        noteOver(f.s, f.o);
        continue;
      }
    }
    const media = ianaMedia(f.s);
    if (media) {
      mediaSet.add(media);
      noteOver(f.s, f.o);
      continue;
    }
    const spdx = spdxId(f.s);
    if (spdx) {
      spdxSet.add(spdx);
      noteOver(f.s, f.o);
      continue;
    }
    const scheme = ianaScheme(f.s);
    if (scheme) {
      schemeSet.add(scheme);
      noteOver(f.s, f.o);
      continue;
    }
    const wg = whatwgSlug(f.s);
    if (wg) {
      whatwgSet.add(wg);
      noteOver(f.s, f.o);
      continue;
    }
    const slug = w3cSlug(f.s);
    if (slug) {
      slugSet.add(slug);
      noteOver(f.s, f.o);
      continue;
    }
    const block = unicodeBlock(f.s);
    if (block) {
      blockSet.add(block);
      noteOver(f.s, f.o);
      continue;
    }
    const method = ianaMethod(f.s);
    if (method) {
      methodSet.add(method);
      noteOver(f.s, f.o);
      continue;
    }
    const reln = ianaRel(f.s);
    if (reln) {
      relSet.add(reln);
      noteOver(f.s, f.o);
      continue;
    }
    const wk = ianaWellKnown(f.s);
    if (wk) {
      wkSet.add(wk);
      noteOver(f.s, f.o);
      continue;
    }
    const lang = ianaLanguage(f.s);
    if (lang) {
      langSet.add(lang);
      noteOver(f.s, f.o);
      continue;
    }
    const script = unicodeScript(f.s);
    if (script) {
      scriptSet.add(script);
      noteOver(f.s, f.o);
      continue;
    }
    leftover.push(f);
  }

  const capPairs: { s: string; o: string }[] = [];
  const capSeen = new Set<string>();
  const leftoverNoCap: PackFact[] = [];
  for (const f of leftover) {
    if (f.p === "capital") {
      const k = f.s.toLowerCase();
      if (capSeen.has(k)) continue;
      capSeen.add(k);
      capPairs.push({ s: f.s, o: f.o });
      continue;
    }
    leftoverNoCap.push(f);
  }
  capPairs.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.o < b.o ? -1 : a.o > b.o ? 1 : 0));

  const wikiRows: { s: string; o: string }[] = [];
  const leftoverTyped: PackFact[] = [];
  for (const f of leftoverNoCap) {
    if (f.p === "is" && wikiRoleOf(f.o)) {
      wikiRows.push({ s: f.s, o: f.o });
      continue;
    }
    leftoverTyped.push(f);
  }
  const wikiEnc = encodeWiki(wikiRows);
  const leftoverForTyped = wikiEnc.byteLength ? leftoverTyped : leftoverNoCap;

  const t = buildTypedFacts(leftoverForTyped);
  const {
    kept,
    slugList: leftoverSlugs,
    listOf,
    listVals,
    mediaList: leftoverMedia,
    spdxList: leftoverSpdx,
    schemeList: leftoverScheme,
    whatwgList: leftoverWhatwg,
    blockList: leftoverBlock,
    methodList: leftoverMethod,
    relList: leftoverRel,
    wkList: leftoverWk,
    strs,
    idOf,
  } = t;
  const slugList = [...new Set([...slugSet, ...leftoverSlugs])].sort();
  const slugOf = new Map(slugList.map((s, i) => [s, i]));
  const mediaList = [...new Set([...mediaSet, ...leftoverMedia])].sort();
  const mediaOf = new Map(mediaList.map((s, i) => [s, i]));
  const spdxList = [...new Set([...spdxSet, ...leftoverSpdx])].sort();
  const spdxOf = new Map(spdxList.map((s, i) => [s, i]));
  const schemeList = [...new Set([...schemeSet, ...leftoverScheme])].sort();
  const schemeOf = new Map(schemeList.map((s, i) => [s, i]));
  const whatwgList = [...new Set([...whatwgSet, ...leftoverWhatwg])].sort();
  const whatwgOf = new Map(whatwgList.map((s, i) => [s, i]));
  const blockList = [...new Set([...blockSet, ...leftoverBlock])].sort();
  const blockOf = new Map(blockList.map((s, i) => [s, i]));
  const methodList = [...new Set([...methodSet, ...leftoverMethod])].sort();
  const methodOf = new Map(methodList.map((s, i) => [s, i]));
  const relList = [...new Set([...relSet, ...leftoverRel])].sort();
  const relOf = new Map(relList.map((s, i) => [s, i]));
  const wkList = [...new Set([...wkSet, ...leftoverWk])].sort();
  const wkOf = new Map(wkList.map((s, i) => [s, i]));
  const typed = (s: string) =>
    encodeTyped(s, idOf, slugOf, listOf, mediaOf, spdxOf, schemeOf, whatwgOf, blockOf, methodOf, relOf, wkOf);
  const sid: number[] = [];
  const pid: number[] = [];
  const oid: number[] = [];
  const evid: number[] = [];
  const urlid: number[] = [];
  kept.forEach((f) => {
    const p = PRED_ID.get(f.p as (typeof PACK_PREDS)[number])!;
    sid.push(typed(f.s));
    pid.push(p);
    oid.push(omittedCatalogObject(f.s, f.p, f.o) ? 0 : typed(f.o));
    evid.push(0);
    urlid.push(idOf.get(f.url) || 0);
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
    const idxs = (byPred.get(p) || []).slice();
    trip.u32(idxs.length);
    const origAll = writeSidGroups(trip, idxs, sid, N_KINDS);
    const oo = vbyteList(origAll.map((i) => oid[i]!));
    trip.u32(oo.length);
    trip.bytes(oo);
    trip.u8(0);
    const uids = origAll.map((i) => urlid[i]!);
    const same = uids.length <= 1 || uids.every((u) => u === uids[0]);
    if (same) {
      trip.u8(0);
      trip.vbyte(uids[0] ?? 0);
    } else {
      trip.u8(1);
      const uu = vbyteList(uids);
      trip.u32(uu.length);
      trip.bytes(uu);
    }
  }

  const objOver = new Map<number, string>();
  const putNameOver = (s: string, id: number) => {
    const o = nameOver.get(s);
    if (!o) return;
    if (idKind(id) === KIND_PROTO) return;
    if (idKind(id) === KIND_METHOD && parseMethodMeta(o)) return;
    objOver.set(id, o);
  };
  for (let i = 0; i < mediaList.length; i++) putNameOver(`IANA media ${mediaList[i]}`, packId(KIND_MEDIA, i));
  for (let i = 0; i < spdxList.length; i++) putNameOver(`SPDX ${spdxList[i]}`, packId(KIND_SPDX, i));
  for (let i = 0; i < schemeList.length; i++) putNameOver(`IANA scheme ${schemeList[i]}`, packId(KIND_SCHEME, i));
  for (let i = 0; i < whatwgList.length; i++) putNameOver(`WHATWG ${whatwgList[i]}`, packId(KIND_WHATWG, i));
  for (let i = 0; i < blockList.length; i++) putNameOver(`Unicode Block ${blockList[i]}`, packId(KIND_BLOCK, i));
  for (let i = 0; i < methodList.length; i++) putNameOver(`IANA method ${methodList[i]}`, packId(KIND_METHOD, i));
  for (let i = 0; i < relList.length; i++) putNameOver(`IANA rel ${relList[i]}`, packId(KIND_REL, i));
  for (let i = 0; i < wkList.length; i++) putNameOver(`IANA well-known ${wkList[i]}`, packId(KIND_WK, i));
  for (let i = 0; i < slugList.length; i++) putNameOver(`W3C ${slugList[i]}`, packId(KIND_W3C, i));
  for (const lang of langSet) putNameOver(`IANA language ${lang}`, packId(KIND_LANG, packLang(lang)));
  for (const sc of scriptSet) putNameOver(`Unicode Script ${sc}`, packId(KIND_SCRIPT, packScriptCode(sc)));
  for (let n = 0; n < 256; n++) {
    if (protoBits[n >> 3]! & (1 << (n & 7))) putNameOver(`IANA protocol ${n}`, packId(KIND_PROTO, n));
  }
  for (let n = 0; n < 1024; n++) {
    if (httpBits[n >> 3]! & (1 << (n & 7))) putNameOver(`IANA http ${n}`, packId(KIND_HTTP, n));
  }

  const headerList = [...headerSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const dnsNames = [...dnsMap.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const dnsObjs = dnsNames.map((n) => dnsMap.get(n)!);
  const dnsDefault = dnsNames.every((n, i) => (DNS_OBJECT[n] ?? "") === dnsObjs[i]);
  const charsetList = [...charsetSet].sort();
  const langList = [...langSet].sort();
  const scriptList = [...scriptSet].sort();

  const nums = rfcIs.map((r) => r.n);
  const titles = rfcIs.map((r) => r.title);
  const hotComplete = hotUniverseReady(rfcMap);

  const catParts: Array<Uint8Array | undefined> = [];
  const putList = (tag: number, have: string[]) => {
    if (have.length) catParts[tag] = encodeCatList(have);
  };
  const putCat = (tag: number, body: Uint8Array) => {
    if (body.byteLength) catParts[tag] = body;
  };

  const closed = closedCatalog();
  let closedBits = 0;
  const closeIf = (bit: number, have: string[], uni: string[]) => {
    if (have.length && sameSorted(have, uni)) {
      closedBits |= 1 << bit;
      return true;
    }
    return false;
  };
  const closeMode = (bit: number, have: string[], uni: string[]): "exact" | "extra" | "open" => {
    if (have.length && sameSorted(have, uni)) {
      closedBits |= 1 << bit;
      return "exact";
    }
    if (have.length && isSupersetSorted(have, uni)) {
      closedBits |= 1 << bit;
      return "extra";
    }
    return "open";
  };
  const closeNames = (bit: number, tag: number, have: string[], uni: string[]) => {
    if (have.length && sameSorted(have, uni)) {
      closedBits |= 1 << bit;
      return;
    }
    if (have.length && isSupersetSorted(have, uni)) {
      closedBits |= 1 << bit;
      putList(tag, extrasOf(have, uni));
      return;
    }
    if (have.length && isSubsetOf(have, uni)) {
      closedBits |= 1 << bit;
      putCat(tag, encodeSubsetBits(have, uni));
      return;
    }
    if (have.length) putList(tag, have);
  };
  let mediaMode: "exact" | "extra" | "subset" | "open" = closeMode(0, mediaList, closed.media);
  let spdxMode: "exact" | "extra" | "subset" | "open" = closeMode(1, spdxList, closed.spdx);
  let schemeMode: "exact" | "extra" | "subset" | "open" = closeMode(2, schemeList, closed.scheme);
  if (mediaMode === "open" && isSubsetOf(mediaList, closed.media)) {
    closedBits |= 1 << 0;
    mediaMode = "subset";
  }
  if (spdxMode === "open" && isSubsetOf(spdxList, closed.spdx)) {
    closedBits |= 1 << 1;
    spdxMode = "subset";
  }
  if (schemeMode === "open" && isSubsetOf(schemeList, closed.scheme)) {
    closedBits |= 1 << 2;
    schemeMode = "subset";
  }
  if (mediaMode === "exact") mediaMode = "subset";
  if (spdxMode === "exact") spdxMode = "subset";
  if (schemeMode === "exact") schemeMode = "subset";
  closeIf(4, blockList, closed.blocks);
  closeIf(5, methodList, closed.methods);
  let headerMode: "exact" | "extra" | "subset" | "mixed" | "open" = closeMode(6, headerList, closed.headers);
  if (headerMode === "exact") {
    headerMode = "subset";
  } else if (
    headerMode === "open" &&
    (isSubsetOf(headerList, closed.headers) || sameSorted(headerList, closed.headers))
  ) {
    closedBits |= 1 << 6;
    headerMode = "subset";
  } else if (headerMode === "open") {
    const headerExtra = extrasOf(headerList, closed.headers);
    if (headerExtra.length && headerExtra.length < headerList.length) {
      closedBits |= 1 << 6;
      headerMode = "mixed";
    }
  }
  let dnsMode = closeMode(7, dnsNames, closed.dns);
  if (dnsMode !== "open") {
    const closedSet = new Set(closed.dns);
    const closedOk = dnsNames.every((n) => !closedSet.has(n) || (DNS_OBJECT[n] ?? "") === (dnsMap.get(n) ?? ""));
    if (!closedOk) {
      closedBits &= ~(1 << 7);
      dnsMode = "open";
    }
  }
  closeIf(8, charsetList, closed.charset);
  closeIf(10, scriptList, closed.scripts);
  let slugMode: "exact" | "extra" | "subset" | "mixed" | "open" = closeMode(11, slugList, closed.w3c);
  const slugKeep = [...W3C_LIST].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (slugList.length && sameSorted(slugList, slugKeep)) {
    closedBits |= 1 << 11;
    slugMode = "exact";
  } else if (slugMode === "exact") {
    slugMode = "subset";
  } else if (slugMode === "open" && (isSubsetOf(slugList, closed.w3c) || sameSorted(slugList, closed.w3c))) {
    closedBits |= 1 << 11;
    slugMode = "subset";
  } else if (slugMode === "open") {
    const slugExtra = extrasOf(slugList, closed.w3c);
    if (slugExtra.length && slugExtra.length < slugList.length) {
      closedBits |= 1 << 11;
      slugMode = "mixed";
    }
  }
  if (hasProto && bitsEq(protoBits, closed.protoBits)) closedBits |= 1 << 12;
  if (hasHttp && bitsEq(httpBits, closed.httpBits)) closedBits |= 1 << 13;

  const mediaStore =
    mediaMode === "subset" ? [] : mediaMode === "extra" ? extrasOf(mediaList, closed.media) : mediaList;
  const spdxStore = spdxMode === "subset" ? [] : spdxMode === "extra" ? extrasOf(spdxList, closed.spdx) : spdxList;
  const schemeStore =
    schemeMode === "subset" ? [] : schemeMode === "extra" ? extrasOf(schemeList, closed.scheme) : schemeList;
  const slugStore =
    slugMode === "exact" || slugMode === "subset" || slugMode === "mixed"
      ? []
      : slugMode === "extra"
        ? extrasOf(slugList, closed.w3c)
        : slugList;

  putCat(T_DICT, strs.length ? encodeIntern(strs) : EMPTY_U8);
  if (slugStore.length && slugMode === "open") putList(T_SLUG, slugStore);
  putCat(T_LIST, listVals.length ? encodeRfcLists(listVals) : EMPTY_U8);
  if (mediaStore.length && mediaMode === "open") putCat(T_MEDIA, encodeMediaList(mediaStore));
  if (spdxStore.length && spdxMode === "open") putList(T_SPDX, spdxStore);
  if (schemeStore.length && schemeMode === "open") putList(T_SCHEME, schemeStore);
  closeNames(3, T_WHATWG, whatwgList, closed.whatwg);
  if (!(closedBits & (1 << 4))) putList(T_BLOCK, blockList);
  if (!(closedBits & (1 << 5))) putList(T_METHOD, methodList);
  closeNames(15, T_REL, relList, closed.rels);
  closeNames(14, T_WK, wkList, closed.wellknown);
  if (headerMode === "subset") {
    putCat(T_HEADER, encodeSubsetBits(headerList, closed.headers));
  } else if (headerMode === "mixed") {
    putCat(T_HEADER, encodeSubsetMixed(headerList, closed.headers));
  } else if (headerMode === "extra") {
    putList(T_HEADER, extrasOf(headerList, closed.headers));
  } else if (headerList.length) {
    putList(T_HEADER, headerList);
  }
  {
    const dnsNameStore = dnsMode === "exact" ? [] : dnsMode === "extra" ? extrasOf(dnsNames, closed.dns) : dnsNames;
    const dnsObjStore = dnsNameStore.map((n) => dnsMap.get(n) ?? "");
    const dnsObjNeeded =
      dnsMode === "open" ? !dnsDefault : dnsObjStore.some((o, i) => (DNS_OBJECT[dnsNameStore[i]!] ?? "") !== o);
    if (dnsNameStore.length) putCat(T_DNS_N, encodeCatList(dnsNameStore));
    if (dnsObjNeeded && dnsObjStore.length) putCat(T_DNS_O, encodeCatList(dnsObjStore));
  }
  if (!(closedBits & (1 << 8))) putList(T_CHARSET, charsetList);
  {
    const openM = mediaStore;
    const openS = spdxStore;
    const openC = schemeStore;
    const openW = slugStore;
    if (openM.length + openS.length + openC.length + openW.length > 32) {
      const comb = encodeCatIds(openM, openS, openC, openW);
      if (mediaStore.length) putCat(T_MEDIA, encodeMediaList(mediaStore));
      if (spdxStore.length) putList(T_SPDX, spdxStore);
      if (schemeStore.length) putList(T_SCHEME, schemeStore);
      if (slugStore.length) putList(T_SLUG, slugStore);
      const sepLen =
        (catParts[T_MEDIA]?.byteLength ?? 0) +
        (catParts[T_SPDX]?.byteLength ?? 0) +
        (catParts[T_SCHEME]?.byteLength ?? 0) +
        (catParts[T_SLUG]?.byteLength ?? 0);
      const sepBuf = new Writer();
      if (catParts[T_MEDIA]) sepBuf.bytes(catParts[T_MEDIA]!);
      if (catParts[T_SPDX]) sepBuf.bytes(catParts[T_SPDX]!);
      if (catParts[T_SCHEME]) sepBuf.bytes(catParts[T_SCHEME]!);
      if (catParts[T_SLUG]) sepBuf.bytes(catParts[T_SLUG]!);
      const sepBr = brotliRawLen(sepBuf.finish(), BROTLI_QUALITY);
      const combBr = brotliRawLen(comb, BROTLI_QUALITY);
      if (combBr < sepBr || (combBr === sepBr && comb.byteLength < sepLen)) {
        catParts[T_MEDIA] = undefined;
        catParts[T_SPDX] = undefined;
        catParts[T_SCHEME] = undefined;
        catParts[T_SLUG] = undefined;
        putCat(T_CAT_IDS, comb);
      }
    } else {
      if (mediaStore.length) putCat(T_MEDIA, encodeMediaList(mediaStore));
      if (spdxStore.length) putList(T_SPDX, spdxStore);
      if (schemeStore.length) putList(T_SCHEME, schemeStore);
      if (slugStore.length) putList(T_SLUG, slugStore);
    }
  }
  if (mediaMode === "subset") putCat(T_MEDIA, encodeSubsetBits(mediaList, closed.media));
  if (spdxMode === "subset") putCat(T_SPDX, encodeSubsetBits(spdxList, closed.spdx));
  if (schemeMode === "subset") putCat(T_SCHEME, encodeSubsetBits(schemeList, closed.scheme));
  if (slugMode === "subset") putCat(T_SLUG, encodeSubsetBits(slugList, closed.w3c));
  if (slugMode === "mixed") putCat(T_SLUG, encodeSubsetMixed(slugList, closed.w3c));
  putCat(T_TRIP, sid.length ? trip.finish() : EMPTY_U8);
  if (!(closedBits & (1 << 12))) putCat(T_PROTO, hasProto ? protoBits : EMPTY_U8);
  if (!(closedBits & (1 << 13))) putCat(T_HTTP, hasHttp ? httpBits : EMPTY_U8);
  putCat(T_OVER, encodeIdOver(objOver));
  putCat(T_PROTO_N, hasProto ? encodeProtoNames(protoBits, nameOver) : EMPTY_U8);
  putCat(T_METHOD_META, encodeMethodMeta(methodList, nameOver));
  putCat(T_HEADER_OVER, encodeHeaderOver(headerList, headerOver));
  putCat(T_CHARSET_OVER, encodeOverMap(charsetOver));
  closeNames(9, T_LANG, langList, closed.langs);
  if (!(closedBits & (1 << 10))) putList(T_SCRIPT, scriptList);
  if (closedBits) {
    const cb = new Uint8Array(2);
    cb[0] = closedBits & 255;
    cb[1] = (closedBits >>> 8) & 255;
    putCat(T_CLOSED, cb);
  }
  putCat(T_CAP_COL, encodeCapCol(capPairs));
  if (wikiEnc.byteLength) putCat(T_WIKI, wikiEnc);

  const popMax = (b: Uint8Array, max: number) => {
    let n = 0;
    for (let i = 0; i < max; i++) if (b[i >> 3]! & (1 << (i & 7))) n++;
    return n;
  };
  const wantN =
    rfcIs.length +
    obs.size +
    upd.size +
    capPairs.length +
    headerList.length +
    dnsNames.length +
    charsetList.length +
    mediaList.length +
    spdxList.length +
    schemeList.length +
    whatwgList.length +
    blockList.length +
    methodList.length +
    relList.length +
    wkList.length +
    langList.length +
    scriptList.length +
    slugList.length +
    (hasProto ? popMax(protoBits, 256) : 0) +
    (hasHttp ? popMax(httpBits, 1024) : 0) +
    sid.length +
    (wikiEnc.byteLength ? wikiRows.length : 0);
  const t0 = Date.now();
  const bake: Record<string, number | string> = { n_titles: titles.length, acr_stripped: 0 };
  const large = titles.length >= 1000;
  type Packed = { name: string; pack: Uint8Array };
  let best: Packed | undefined;
  const consider = (name: string, pack: Uint8Array) => {
    bake[name.replace(/\+/g, "_").toLowerCase()] = pack.byteLength;
    if (!best || pack.byteLength < best.pack.byteLength) best = { name, pack };
  };

  if (!titles.length) {
    const edges09 = encodeEg09(obs, upd);
    const kg = encodeKg11(nums, EMPTY_U8, edges09, catParts);
    const br = brotliSection(kg);
    consider("KG11+empty+br11", frameKpk9(br.byteLength < kg.byteLength ? br : kg, EMPTY_U8, 0));
  } else if (large) {
    const edges14 = encodeEg14(obs, upd);
    const { hot } = collectHot(nums, titles, 16);
    const ov = hot.length ? encodeHotOverlay(hot) : EMPTY_U8;
    const ovName = hot.length ? "dump" : "empty";
    const kg = encodeKg13(nums, titles, edges14, catParts, 16, ov, undefined, false, false, true);
    const framed = frameKgCheap(kg);
    best = { name: `KG13+EG14+noarea+hot16+${ovName}${framed.name === "raw" ? "+raw" : ""}`, pack: framed.pack };
    bake.want_n = wantN;
    bake.got_n = decodePack(best.pack).nTriples;
    bake.hot16_n = hot.length;
    const ho12 = hot.length
      ? wrapHo12(
          hot.map((r) => r.n),
          encodeNt08(hot.map((r) => r.title)),
        )
      : EMPTY_U8;
    const edgeVars: { name: string; buf: Uint8Array }[] = [
      { name: "EG14", buf: edges14 },
      { name: "EG10", buf: encodeEg10(obs, upd) },
      { name: "EG09", buf: encodeEg09(obs, upd) },
    ];
    for (const ev of edgeVars) {
      for (const overlay of [ov, ho12]) {
        if (!overlay.byteLength && hot.length) continue;
        const body = encodeKg13(nums, titles, ev.buf, catParts, 16, overlay, undefined, false, false, true);
        for (const pack of [frameKgCheap(body).pack, frameKg(body)]) {
          if (!pack.byteLength) continue;
          const p = decodePack(pack);
          if (p.nTriples !== wantN || !packCarriesHotTitles(pack, hot)) continue;
          bake[`kg13_${ev.name}`] = pack.byteLength;
          if (!best.pack.byteLength || pack.byteLength < best.pack.byteLength) {
            best = { name: `KG13+${ev.name}+noarea+ho12`, pack };
            bake.got_n = wantN;
          }
        }
      }
    }
    {
      const takeDawg = (name: string, parts: Array<Uint8Array | undefined>) => {
        const body = encodeKg13(nums, titles, edges14, parts, 16, ov, undefined, false, false, true);
        const pack = frameKgCheap(body).pack;
        if (!pack.byteLength) return;
        const p = decodePack(pack);
        if (p.nTriples !== wantN || !packCarriesHotTitles(pack, hot)) return;
        bake[name.replace(/\+/g, "_").toLowerCase()] = pack.byteLength;
        if (!best!.pack.byteLength || pack.byteLength < best!.pack.byteLength) {
          best = { name, pack };
          bake.got_n = wantN;
        }
      };
      const clone = () => {
        const p: Array<Uint8Array | undefined> = [];
        for (let i = 0; i < catParts.length; i++) if (catParts[i]) p[i] = catParts[i];
        return p;
      };
      if (strs.length) {
        const dg = encodeDawg(strs);
        if (dg.byteLength) {
          const p = clone();
          p[T_DICT] = dg;
          takeDawg("KG13+EG14+dawg-intern", p);
        }
      }
      if (slugStore.length) {
        const dg = encodeDawg(slugStore);
        if (dg.byteLength) {
          const p = clone();
          p[T_SLUG] = dg;
          takeDawg("KG13+EG14+dawg-slug", p);
        }
        const ht = encodeHt01(slugStore);
        if (ht.byteLength) {
          const p = clone();
          p[T_SLUG] = ht;
          takeDawg("KG13+EG14+ht01-slug", p);
        }
        const nul = encodeNulList(slugStore);
        if (nul.byteLength) {
          const p = clone();
          p[T_SLUG] = nul;
          takeDawg("KG13+EG14+nul-slug", p);
        }
      }
      if (mediaStore.length) {
        const mt2 = encodeMt02(mediaStore);
        if (mt2.byteLength) {
          const p = clone();
          p[T_MEDIA] = mt2;
          takeDawg("KG13+EG14+mt02", p);
        }
      }
      if (spdxStore.length) {
        const dg = encodeDawg(spdxStore);
        if (dg.byteLength) {
          const p = clone();
          p[T_SPDX] = dg;
          takeDawg("KG13+EG14+dawg-spdx", p);
        }
      }
    }
    {
      const cloneCats = () => {
        const p: Array<Uint8Array | undefined> = [];
        for (let i = 0; i < catParts.length; i++) if (catParts[i]) p[i] = catParts[i];
        return p;
      };
      const variants: [string, Array<Uint8Array | undefined>][] = [["", catParts]];
      const addVar = (name: string, tag: number, body: Uint8Array) => {
        if (!body.byteLength) return;
        const p = cloneCats();
        p[tag] = body;
        variants.push([name, p]);
      };
      if (slugStore.length) {
        addVar("nul-slug", T_SLUG, encodeNulList(slugStore));
        const ht = encodeHt01(slugStore);
        if (ht.byteLength) addVar("ht01-slug", T_SLUG, ht);
      }
      if (mediaStore.length) {
        addVar("nul-media", T_MEDIA, encodeNulList(mediaStore));
        const mt3 = encodeMtBody(mediaStore, true);
        if (mt3.byteLength) addVar("mt03", T_MEDIA, mt3);
        const mt3nul = encodeMtBody(mediaStore, true, "nul");
        if (mt3nul.byteLength) addVar("mt03-nulrem", T_MEDIA, mt3nul);
        const mt3fc = encodeMtBody(mediaStore, true, "fc");
        if (mt3fc.byteLength) addVar("mt03-fcrem", T_MEDIA, mt3fc);
      }
      if (spdxStore.length) addVar("nul-spdx", T_SPDX, encodeNulList(spdxStore));
      if (schemeStore.length) addVar("nul-scheme", T_SCHEME, encodeNulList(schemeStore));
      if (slugStore.length && mediaStore.length) {
        const p = cloneCats();
        p[T_SLUG] = encodeNulList(slugStore);
        p[T_MEDIA] = encodeNulList(mediaStore);
        variants.push(["nul-slug-media", p]);
      }
      const takeSplit = (pack: Uint8Array, name: string) => {
        if (!pack.byteLength) return;
        const dec = decodePack(pack);
        if (dec.nTriples !== wantN || !packCarriesHotTitles(pack, hot)) return;
        bake.split_ct01 = pack.byteLength;
        bake[name.replace(/\+/g, "_").toLowerCase()] = pack.byteLength;
        if (!best!.pack.byteLength || pack.byteLength < best!.pack.byteLength) {
          best = { name, pack };
          bake.got_n = wantN;
        }
      };
      const kgRfc14 = encodeKg13(nums, titles, edges14, [], 16, ov, undefined, false, false, true);
      const rfcBr14 = brotliSection(kgRfc14);
      for (const [vname, parts] of variants) {
        const tlv = catTlvOf(parts);
        if (tlv.byteLength <= 64) continue;
        const rest = wrapCatRest(tlv);
        const label = vname ? `KG13+EG14+split-ct01+${vname}` : "KG13+EG14+split-ct01";
        takeSplit(frameKpk9(kgRfc14, rest, 0), label);
        if (rfcBr14 !== kgRfc14) takeSplit(frameKpk9(rfcBr14, rest, 0), `${label}+br`);
      }
      const restDefault = wrapCatRest(catTlvOf(catParts));
      bake.edge_EG14_raw = edges14.byteLength;
      bake.kg13_EG14_raw = kgRfc14.byteLength;
      bake.kg13_EG14_br = rfcBr14.byteLength;
      if (restDefault.byteLength > 64) {
        const extraEdges: { name: string; buf: Uint8Array }[] = [
          { name: "EG11", buf: encodeEg11(obs, upd) },
          { name: "EG12", buf: encodeEg12(obs, upd) },
          { name: "EG13", buf: encodeEg13(obs, upd) },
          { name: "EG16", buf: encodeEg16(obs, upd) },
          { name: "EG17", buf: encodeEg17(obs, upd) },
          { name: "EG18", buf: encodeEg18(obs, upd) },
          { name: "EG19", buf: encodeEg19(obs, upd, nums) },
        ];
        for (const ev of extraEdges) {
          if (!ev.buf.byteLength) continue;
          bake[`edge_${ev.name}_raw`] = ev.buf.byteLength;
          const kgRfc = encodeKg13(nums, titles, ev.buf, [], 16, ov, undefined, false, false, true);
          const rfcBr = brotliSection(kgRfc);
          bake[`kg13_${ev.name}_raw`] = kgRfc.byteLength;
          bake[`kg13_${ev.name}_br`] = rfcBr.byteLength;
          const label = `KG13+${ev.name}+split-ct01`;
          const framed = frameKpk9(rfcBr !== kgRfc ? rfcBr : kgRfc, restDefault, 0);
          const dec = decodePack(framed);
          bake[`split_${ev.name}`] = framed.byteLength;
          bake[`split_${ev.name}_n`] = dec.nTriples;
          takeSplit(frameKpk9(kgRfc, restDefault, 0), label);
          if (rfcBr !== kgRfc) takeSplit(frameKpk9(rfcBr, restDefault, 0), `${label}+br`);
        }
      }
    }
    const capClosed = pairsMatchCapitalOf(capPairs);
    if (catKg16Ready(catParts, closedBits, capClosed) && hot.length) {
      const kg16 = encodeKg16(nums, hot, obs, upd);
      const fr16 = frameKgCheap(kg16, KPK9_CAPS);
      bake.kg16 = fr16.pack.byteLength;
      const p16 = decodePack(fr16.pack);
      if (
        fr16.pack.byteLength &&
        p16.nTriples === wantN &&
        packCarriesHotTitles(fr16.pack, hot) &&
        (!best.pack.byteLength || fr16.pack.byteLength < best.pack.byteLength)
      ) {
        best = { name: "KG16+hotmask+EG14+idlast+closecaps", pack: fr16.pack };
        bake.got_n = wantN;
        bake.dump_ok = 1;
      }
      const take17 = (name: string, pack: Uint8Array, mode: number) => {
        if (!pack.byteLength) return;
        const p = decodePack(pack);
        if (p.nTriples !== wantN || !packCarriesHotTitles(pack, hot)) return;
        bake.kg17 = pack.byteLength;
        bake.kg17_mode = mode;
        if (!best!.pack.byteLength || pack.byteLength < best!.pack.byteLength) {
          best = { name, pack };
          bake.got_n = wantN;
        }
      };
      for (const inK of [true, false]) {
        const kg17 = encodeKg17(nums, titles, obs, upd, inK);
        const restCands = kg17.extra.byteLength ? [kg17.extra, tightInner(kg17.extra)] : [EMPTY_U8];
        const br = brotliSection(kg17.raw);
        const kind = kg17.mode & 3;
        const edgeName = kind === KG17_SDR ? "sdr" : kind === KG17_DELTA ? "srcdelta" : "missrank";
        const idName = kg17.mode & 4 ? "idfirst" : "idlast";
        const where = inK ? "dump" : "rest";
        for (const rest of restCands) {
          take17(`KG17+${edgeName}+EG14+${idName}+${where}+closecaps`, frameKpk9(kg17.raw, rest, KPK9_CAPS), kg17.mode);
          if (br !== kg17.raw)
            take17(`KG17+${edgeName}+EG14+${idName}+${where}+br+closecaps`, frameKpk9(br, rest, KPK9_CAPS), kg17.mode);
          take17(`KG17+${edgeName}+EG14+${idName}+${where}+frame+closecaps`, frameKg(kg17.raw, rest), kg17.mode);
        }
      }
    }
    if (best.pack.byteLength && (Number(bake.got_n) !== wantN || !packCarriesHotTitles(best.pack, hot))) {
      bake.fast_reject = 1;
      const kgRaw = encodeKg13(nums, titles, edges14, catParts, 16, encodeHotRaw(hot), undefined, false, false, true);
      const fr2 = frameKgCheap(kgRaw);
      const p2 = decodePack(fr2.pack);
      if (p2.nTriples === wantN && packCarriesHotTitles(fr2.pack, hot)) {
        best = { name: "KG13+EG14+noarea+hot16+raw", pack: fr2.pack };
        bake.got_n = wantN;
        bake.fast_reject = 0;
      }
    }
  } else {
    const edges09 = encodeEg09(obs, upd);
    const acr = prepareAcrTitles(titles);
    bake.acr_stripped = acr?.nStrip ?? 0;
    const src = acr?.stripped ?? titles;
    const wrapAcr = (inner: Uint8Array) => (acr ? encodeAt11(titles.length, acr.bits, inner) : inner);
    const prep = rtPrep(src);
    const compressKg = (name: string, body: Uint8Array) => {
      if (!body.byteLength) return;
      if (!titleRoundtrips(body, titles)) {
        bake[`${name.replace(/\+/g, "_").toLowerCase()}_raw`] = -1;
        return;
      }
      bake[`${name.replace(/\+/g, "_").toLowerCase()}_raw`] = body.byteLength;
      const kg = encodeKg11(nums, body, edges09, catParts);
      const br = brotliSection(kg);
      const kgOut = br.byteLength < kg.byteLength ? br : kg;
      consider(`KG11+${name}+br11`, frameKpk9(kgOut, EMPTY_U8, 0));
    };
    if (!prep) {
      compressKg("NT08", encodeNt08(titles));
    } else {
      const rt14 = wrapAcr(encodeRt14From(prep));
      compressKg(acr ? "AT11+RT14" : "RT14", rt14);
      const lc = encodeLc14(src);
      if (lc.byteLength) {
        const wrapped = wrapAcr(lc);
        if (wrapped.byteLength < rt14.byteLength) compressKg(acr ? "AT11+LC14" : "LC14", wrapped);
      }
    }
  }

  let pack = best?.pack ?? frameKpk9(EMPTY_U8, EMPTY_U8, 0);
  if (large && closedBits && best) {
    if (Number(bake.got_n) !== wantN) {
      closedBits = 0;
      catParts[T_CLOSED] = undefined;
      putList(T_SLUG, slugList);
      putList(T_MEDIA, mediaList);
      putList(T_SPDX, spdxList);
      putList(T_SCHEME, schemeList);
      putList(T_WHATWG, whatwgList);
      putList(T_BLOCK, blockList);
      putList(T_METHOD, methodList);
      putList(T_HEADER, headerList);
      putCat(T_REL, relList.length ? encodeCatList(relList) : EMPTY_U8);
      putCat(T_WK, wkList.length ? encodeCatList(wkList) : EMPTY_U8);
      putCat(T_DNS_N, dnsNames.length ? encodePfc(dnsNames) : EMPTY_U8);
      putCat(T_DNS_O, !dnsDefault && dnsObjs.length ? encodePfc(dnsObjs) : EMPTY_U8);
      putList(T_CHARSET, charsetList);
      putCat(T_PROTO, hasProto ? protoBits : EMPTY_U8);
      putCat(T_HTTP, hasHttp ? httpBits : EMPTY_U8);
      putList(T_LANG, langList);
      putList(T_SCRIPT, scriptList);
      bake.closed_bits = 0;
      const edges14 = encodeEg14(obs, upd);
      const { hot } = collectHot(nums, titles, 16);
      const ov = hot.length ? encodeHotOverlay(hot) : EMPTY_U8;
      const kg = encodeKg13(nums, titles, edges14, catParts, 16, ov, undefined, false, false, true);
      const framed = frameKgCheap(kg);
      best = { name: "KG13+EG14+noarea+hot16+dump", pack: framed.pack };
      pack = best.pack;
      bake.got_n = decodePack(pack).nTriples;
    }
  }

  bake.winner = best?.name ?? "empty";
  bake.framing = String(bake.winner).includes("HOTSET")
    ? "hotset"
    : String(bake.winner).startsWith("KG17")
      ? "kg17"
      : String(bake.winner).startsWith("KG16")
        ? "kg16"
        : String(bake.winner).startsWith("KG15")
          ? "kg15"
          : String(bake.winner).startsWith("KG14")
            ? "kg14"
            : String(bake.winner).startsWith("KG13")
              ? "kg13"
              : String(bake.winner).startsWith("KG12")
                ? "kg12"
                : String(bake.winner).startsWith("KG11")
                  ? "kg11"
                  : "ri09";
  bake.pack_bytes = pack.byteLength;
  bake.encode_ms = Date.now() - t0;
  bake.lc14 = String(bake.winner).includes("LC14") ? 1 : 0;
  if (large || hotComplete) {
    console.log(
      `pack bake-off winner=${bake.winner} pack=${pack.byteLength} acr=${bake.acr_stripped} ms=${bake.encode_ms}`,
    );
    writeBakeoff(bake);
  }
  return pack;
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
  return new KnowPack(
    strs,
    slugs,
    rfcLists,
    loc,
    slugLoc,
    sid,
    pid,
    oid,
    evid,
    urlid,
    evidText,
    post,
    media,
    spdx,
    alias,
    bloom,
  );
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
  const slice = (sec: { off: number; len: number }) => unzipSection(buf.subarray(sec.off, sec.off + sec.len));
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
  const tripBuf = slice(tripS);
  const tr = new Reader(new DataView(tripBuf.buffer, tripBuf.byteOffset, tripBuf.byteLength), 0, tripBuf.byteLength);
  tr.u32();
  const nPred = tr.u32();
  for (let p = 0; p < nPred; p++) {
    tr.u32();
    const origAll = readSidGroups(tr, tripBuf, 0, sid, pid, p, N_KINDS);
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const sliceB = new Uint8Array(tripBuf.buffer, tripBuf.byteOffset + tr.off, len);
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
  const evidBuf = slice(evidS);
  const evidText: string[] = [];
  const er = new Reader(new DataView(evidBuf.buffer, evidBuf.byteOffset, evidBuf.byteLength), 0, evidBuf.byteLength);
  const nE = er.u32();
  for (let i = 0; i < nE; i++) evidText.push(er.utf8(er.vbyte()));
  const post = new Map<string, number[]>();
  const postBuf = slice(postS);
  const pr = new Reader(new DataView(postBuf.buffer, postBuf.byteOffset, postBuf.byteLength), 0, postBuf.byteLength);
  const pfcLen = pr.u32();
  const strTerms = decodePfc(new Uint8Array(postBuf.buffer, postBuf.byteOffset + pr.off, pfcLen));
  pr.off += pfcLen;
  for (const term of strTerms) {
    const len = pr.u32();
    const sl = new Uint8Array(postBuf.buffer, postBuf.byteOffset + pr.off, len);
    pr.off += len;
    post.set(term, decodePosting(sl));
  }
  const nNum = pr.u32();
  for (let i = 0; i < nNum; i++) {
    const term = String(pr.u16());
    const len = pr.u32();
    const sl = new Uint8Array(postBuf.buffer, postBuf.byteOffset + pr.off, len);
    pr.off += len;
    post.set(term, decodePosting(sl));
  }
  let bloom: Uint8Array | null = null;
  if (pr.off + 2 <= postBuf.byteLength) {
    const n = pr.u16();
    if (n > 0 && pr.off + n <= postBuf.byteLength) {
      bloom = new Uint8Array(postBuf.buffer, postBuf.byteOffset + pr.off, n).slice();
    }
  }
  return new KnowPack(
    strs,
    slugs,
    rfcLists,
    loc,
    slugLoc,
    sid,
    pid,
    oid,
    evid,
    urlid,
    evidText,
    post,
    media,
    spdx,
    alias,
    bloom,
    scheme,
    whatwg,
    blocks,
    methods,
    rels,
    wks,
  );
}

function decodeKpk7(buf: Uint8Array): KnowPack {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = new Reader(view, 4, buf.byteLength);
  r.u32();
  r.u32();
  r.u32();
  for (let i = 0; i < 13; i++) r.u32();
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
  const rfcS = takeOff();
  const slice = (sec: { off: number; len: number }) =>
    sec.len === 0 ? EMPTY_U8 : unzipSection(buf.subarray(sec.off, sec.off + sec.len));
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
  const rfc = decodeRfcColumn(slice(rfcS));
  const slugLoc = locTable(slugs);
  const tripBuf = slice(tripS);
  const tr = new Reader(new DataView(tripBuf.buffer, tripBuf.byteOffset, tripBuf.byteLength), 0, tripBuf.byteLength);
  const restN = tr.u32();
  const sid = new Array<number>(restN);
  const pid = new Array<number>(restN);
  const oid = new Array<number>(restN);
  const evid = new Array<number>(restN);
  const urlid = new Array<number>(restN);
  const nPred = tr.u32();
  for (let p = 0; p < nPred; p++) {
    tr.u32();
    const origAll = readSidGroups(tr, tripBuf, 0, sid, pid, p, N_KINDS);
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const sliceB = new Uint8Array(tripBuf.buffer, tripBuf.byteOffset + tr.off, len);
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
  const loc = new Map<string, number>();
  const evidBuf = slice(evidS);
  const evidText: string[] = [];
  const er = new Reader(new DataView(evidBuf.buffer, evidBuf.byteOffset, evidBuf.byteLength), 0, evidBuf.byteLength);
  const nE = er.u32();
  for (let i = 0; i < nE; i++) evidText.push(er.utf8(er.vbyte()));
  const post = new Map<string, number[]>();
  const postBuf = slice(postS);
  const pr = new Reader(new DataView(postBuf.buffer, postBuf.byteOffset, postBuf.byteLength), 0, postBuf.byteLength);
  const pfcLen = pr.u32();
  const nTerms = pfcLen >= 4 ? new DataView(postBuf.buffer, postBuf.byteOffset + pr.off, 4).getUint32(0, true) : 0;
  if (nTerms === 0) {
    pr.off += pfcLen;
    const nNum = pr.u32();
    for (let i = 0; i < nNum; i++) {
      pr.u16();
      const len = pr.u32();
      pr.off += len;
    }
  } else {
    const strTerms = decodePfc(new Uint8Array(postBuf.buffer, postBuf.byteOffset + pr.off, pfcLen));
    pr.off += pfcLen;
    for (const term of strTerms) {
      const len = pr.u32();
      const sl = new Uint8Array(postBuf.buffer, postBuf.byteOffset + pr.off, len);
      pr.off += len;
      post.set(term, decodePosting(sl));
    }
    const nNum = pr.u32();
    for (let i = 0; i < nNum; i++) {
      const term = String(pr.u16());
      const len = pr.u32();
      const sl = new Uint8Array(postBuf.buffer, postBuf.byteOffset + pr.off, len);
      pr.off += len;
      post.set(term, decodePosting(sl));
    }
  }
  let bloom: Uint8Array | null = null;
  if (pr.off + 2 <= postBuf.byteLength) {
    const n = pr.u16();
    if (n > 0 && pr.off + n <= postBuf.byteLength) {
      bloom = new Uint8Array(postBuf.buffer, postBuf.byteOffset + pr.off, n).slice();
    }
  }
  return new KnowPack(
    strs,
    slugs,
    rfcLists,
    loc,
    slugLoc,
    sid,
    pid,
    oid,
    evid,
    urlid,
    evidText,
    post,
    media,
    spdx,
    alias,
    bloom,
    scheme,
    whatwg,
    blocks,
    methods,
    rels,
    wks,
    rfc,
  );
}

function decodeTripBuf(tripBuf: Uint8Array): {
  sid: number[];
  pid: number[];
  oid: number[];
  evid: number[];
  urlid: number[];
} {
  if (!tripBuf.byteLength) {
    return { sid: [], pid: [], oid: [], evid: [], urlid: [] };
  }
  const tr = new Reader(new DataView(tripBuf.buffer, tripBuf.byteOffset, tripBuf.byteLength), 0, tripBuf.byteLength);
  const restN = tr.u32();
  const sid = new Array<number>(restN);
  const pid = new Array<number>(restN);
  const oid = new Array<number>(restN);
  const evid = new Array<number>(restN);
  const urlid = new Array<number>(restN);
  const nPred = tr.u32();
  for (let p = 0; p < nPred; p++) {
    tr.u32();
    const origAll = readSidGroups(tr, tripBuf, 0, sid, pid, p, N_KINDS);
    const take = (dec: (b: Uint8Array) => number[]) => {
      const len = tr.u32();
      const sliceB = new Uint8Array(tripBuf.buffer, tripBuf.byteOffset + tr.off, len);
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
  return { sid, pid, oid, evid, urlid };
}

function knowFromTlv(rfc: RfcCol | undefined, catRaw: Uint8Array, flags: number): KnowPack {
  const sec = takeTlv(catRaw);
  const closedBits = (() => {
    const b = sec.get(T_CLOSED);
    if (!b || b.byteLength < 2) return 0;
    return b[0]! | (b[1]! << 8);
  })();
  const c = closedBits ? closedCatalog() : undefined;
  const pfc = (tag: number) => {
    const b = sec.get(tag);
    return b && b.byteLength ? decodeCatList(b) : [];
  };
  const intern = (tag: number) => {
    const b = sec.get(tag);
    return b && b.byteLength ? decodeIntern(b) : [];
  };
  const closedOr = (bit: number, tag: number, uni: string[] | undefined) =>
    closedBits & (1 << bit) && uni ? uni : pfc(tag);
  const closedSelect = (
    bit: number,
    tag: number,
    uni: string[] | undefined,
    combExtra?: string[],
    keep?: readonly string[],
  ) => {
    const raw = sec.get(tag);
    const keepList = keep && keep.length ? [...keep].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : undefined;
    if (closedBits & (1 << bit) && uni) {
      if (raw && raw.byteLength) {
        const sub = decodeSubsetBits(raw, uni);
        if (sub) {
          const need = 6 + ((uni.length + 7) >> 3);
          if (raw.byteLength > need) {
            const extra = decodeSubsetRest(raw.subarray(need));
            if (extra.length) return mergeSortedUnique(sub, extra);
          }
          return sub;
        }
        const extra = decodeCatList(raw);
        return extra.length ? closedExtras(uni, extra, keepList) : (keepList ?? uni.slice());
      }
      if (combExtra && combExtra.length) return closedExtras(uni, combExtra, keepList);
      return keepList ?? uni.slice();
    }
    if (combExtra && combExtra.length) return combExtra;
    return raw && raw.byteLength ? decodeCatList(raw) : [];
  };
  const strs = intern(T_DICT);
  const combined = sec.get(T_CAT_IDS) ? decodeCatIds(sec.get(T_CAT_IDS)!) : undefined;
  const slugs = closedSelect(11, T_SLUG, c?.w3c, combined?.slugs, W3C_LIST);
  const rfcLists = sec.get(T_LIST) ? decodeRfcLists(sec.get(T_LIST)!) : [];
  const media = closedSelect(0, T_MEDIA, c?.media, combined?.media, Object.keys(MEDIA_OBJECT));
  const spdx = closedSelect(1, T_SPDX, c?.spdx, combined?.spdx, SPDX_LIST);
  const scheme = closedSelect(2, T_SCHEME, c?.scheme, combined?.scheme, SCHEME_LIST);
  const whatwg = closedSelect(3, T_WHATWG, c?.whatwg);
  const blocks = closedOr(4, T_BLOCK, c?.blocks);
  const methods = closedOr(5, T_METHOD, c?.methods);
  const rels = closedSelect(15, T_REL, c?.rels);
  const wks = closedSelect(14, T_WK, c?.wellknown);
  const headers = closedSelect(6, T_HEADER, c?.headers, undefined, HEADER_LIST);
  const extraDns = pfc(T_DNS_N);
  const extraDnsObj = pfc(T_DNS_O);
  const dns = closedBits & (1 << 7) && c ? (extraDns.length ? mergeSortedUnique(c.dns, extraDns) : c.dns) : extraDns;
  const dnsObj = (() => {
    if (!(closedBits & (1 << 7) && c)) return extraDnsObj;
    const extraOf = new Map(extraDns.map((n, i) => [n, extraDnsObj[i] ?? ""]));
    return dns.map((n) => (extraOf.has(n) ? extraOf.get(n)! : (DNS_OBJECT[n] ?? "")));
  })();
  const charset = closedOr(8, T_CHARSET, c?.charset);
  const langs = closedSelect(9, T_LANG, c?.langs);
  const scripts = closedOr(10, T_SCRIPT, c?.scripts);
  const trip = decodeTripBuf(sec.get(T_TRIP) ?? EMPTY_U8);
  const protoBits = closedBits & (1 << 12) && c ? c.protoBits.slice() : (sec.get(T_PROTO) ?? null);
  const httpBits = closedBits & (1 << 13) && c ? c.httpBits.slice() : (sec.get(T_HTTP) ?? null);
  const objOver = sec.get(T_OVER) ? decodeIdOver(sec.get(T_OVER)!) : new Map<number, string>();
  const protoOver = sec.get(T_PROTO_N) ? decodeProtoNames(sec.get(T_PROTO_N)!) : new Map<number, string>();
  for (const [id, o] of protoOver) objOver.set(id, o);
  const methodOver = sec.get(T_METHOD_META)
    ? decodeMethodMeta(sec.get(T_METHOD_META)!, methods)
    : new Map<number, string>();
  for (const [id, o] of methodOver) objOver.set(id, o);
  const headerOver = (() => {
    const b = sec.get(T_HEADER_OVER);
    if (!b || !b.byteLength) return new Map<string, string>();
    if (TD.decode(b.subarray(0, 4)) === HR01_MAGIC) return decodeHeaderRfcCol(b, headers);
    return decodeOverMap(b);
  })();
  const charsetOver = sec.get(T_CHARSET_OVER) ? decodeOverMap(sec.get(T_CHARSET_OVER)!) : new Map<string, string>();
  const cat: PackCat = {
    peeled: true,
    headers,
    headerOver,
    dns,
    dnsObj,
    charset,
    charsetOver,
    protoBits: protoBits && protoBits.byteLength ? protoBits.slice() : null,
    httpBits: httpBits && httpBits.byteLength ? httpBits.slice() : null,
    objOver,
    langs,
    scripts,
    capitals: sec.get(T_CAP_COL) && sec.get(T_CAP_COL)!.byteLength ? decodeCapCol(sec.get(T_CAP_COL)!) : [],
    wiki: sec.get(T_WIKI) && sec.get(T_WIKI)!.byteLength ? decodeWiki(sec.get(T_WIKI)!) : [],
  };
  const packedPost =
    sec.get(T_POST) && sec.get(T_POST)!.byteLength ? decodePostIndex(sec.get(T_POST)!) : new Map<string, number[]>();
  return new KnowPack(
    strs,
    slugs,
    rfcLists,
    new Map(),
    locTable(slugs),
    trip.sid,
    trip.pid,
    trip.oid,
    trip.evid,
    trip.urlid,
    [""],
    packedPost,
    media,
    spdx,
    new Map(),
    null,
    scheme,
    whatwg,
    blocks,
    methods,
    rels,
    wks,
    rfc,
    cat,
    (flags & KPK9_CAPS) !== 0,
  );
}

function decodeKg10(buf: Uint8Array, flags: number): KnowPack {
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 4, buf.byteLength);
  const nlen = r.u32();
  const parsed = decodeRfcNumsCompact(buf.subarray(r.off, r.off + nlen));
  r.off += nlen;
  const tlen = r.u32();
  const tbuf = tlen ? buf.subarray(r.off, r.off + tlen) : EMPTY_U8;
  r.off += tlen;
  const elen = r.u32();
  const ebuf = elen ? buf.subarray(r.off, r.off + elen) : EMPTY_U8;
  r.off += elen;
  const catRaw = buf.subarray(r.off);
  let overlay = new Map<number, string>();
  let titleIdx: Rt11 | undefined;
  let titlesComplete = false;
  let titleRaw: Uint8Array | undefined;
  if (tlen) {
    const head = tlen >= 4 ? TD.decode(tbuf.subarray(0, 4)) : "";
    if (head === "OM09") overlay = decodeOm09Map(tbuf);
    else if (head === "RT11") {
      titleIdx = parseRt11(tbuf);
      titlesComplete = !!(titleIdx && titleIdx.nTitle === parsed.count);
    } else {
      titlesComplete = true;
      titleRaw = tbuf.slice();
    }
  }
  const rfc: RfcCol = {
    bits: parsed.bits,
    max: parsed.max,
    count: parsed.count,
    overlay,
    obs: [],
    upd: [],
    edgeRaw: ebuf,
    titlesComplete,
    titleIdx,
    titleRaw,
  };
  return knowFromTlv(rfc, catRaw, flags);
}

function lazyRfcCol(slice: Uint8Array, flags: number): RfcCol {
  return {
    bits: EMPTY_U8,
    max: 0,
    count: 0,
    overlay: new Map(),
    obs: [],
    upd: [],
    compressed: slice,
    edgeSidecar: (flags & KPK9_EDGES) !== 0,
  };
}

function peelHotRest(rest: Uint8Array): Map<number, string> | undefined {
  if (rest.byteLength < 2) return;
  let raw = rest;
  if (isBr08(rest) || isZstdFrame(rest)) raw = unzipSection(rest);
  if (raw.byteLength < 2) return;
  const mag = raw.byteLength >= 4 ? TD.decode(raw.subarray(0, 4)) : "";
  if (mag === CT01_MAGIC) return;
  if (mag === "HO12" || mag === "HO13") return decodeHotOverlay(raw);
  const m = decodeHotOverlay(raw);
  if (m.size) return m;
}

function mergeKgOverlay(g: Kg12, extra: Map<number, string>): Kg12 {
  for (const [n, t] of extra) g.overlay.set(n, t);
  return g;
}

function edgeResidual(rest: Uint8Array): Uint8Array | undefined {
  if (rest.byteLength < 4) return;
  const mag = TD.decode(rest.subarray(0, 4));
  if (isEgMagic(mag)) return rest;
}

function decodeKgWithEdges(rfcRaw: Uint8Array, flags: number, edges: Uint8Array): KnowPack {
  const head = rfcRaw.byteLength >= 4 ? TD.decode(rfcRaw.subarray(0, 4)) : "";
  if (head === "KG16") return decodeKg16(rfcRaw, flags);
  if (head === "KG17") return decodeKg17(rfcRaw, flags);
  if (head === "KG15") return decodeKg15(rfcRaw, flags, edges);
  if (head === "KG14") return decodeKg14(rfcRaw, flags, edges);
  if (head === "KG12" || head === "KG13") {
    const g = parseKg12(rfcRaw);
    if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
    if (edges.byteLength) g.ebuf = edges;
    return knowFromTlv(kg12RfcCol(g), g.catRaw, flags);
  }
  if (head === "KG11") {
    const g = parseKg11(rfcRaw);
    if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
    if (edges.byteLength) g.ebuf = edges;
    return knowFromTlv(kg11RfcCol(g), g.catRaw, flags);
  }
  if (head === "KG10") return decodeKg10(rfcRaw, flags);
  const rfc = rfcRaw.byteLength ? decodeRfcColumn(rfcRaw) : undefined;
  if (rfc && edges.byteLength) rfc.edgeRaw = edges;
  return knowFromTlv(rfc, EMPTY_U8, flags);
}

function decodeKpk9(buf: Uint8Array): KnowPack {
  const flags = buf[4]!;
  const r = new Reader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 5, buf.byteLength);
  const rfcLen = r.vbyte();
  const rfcSlice = rfcLen ? buf.subarray(r.off, r.off + rfcLen) : EMPTY_U8;
  r.off += rfcLen;
  const rest = buf.subarray(r.off);
  const compressed =
    rfcSlice.byteLength > 0 &&
    (isBr08(rfcSlice) || isZstdFrame(rfcSlice) || !!(flags & KPK9_BR) || !!(flags & KPK9_ZSTD));
  const extra = peelHotRest(rest);
  if (extra && extra.size) {
    const rfcRaw = compressed ? unzipRfcSlice(rfcSlice, flags) : rfcSlice;
    const head = rfcRaw.byteLength >= 4 ? TD.decode(rfcRaw.subarray(0, 4)) : "";
    if (head === "KG16") {
      const g = parseKg16(rfcRaw);
      if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
      return knowFromTlv(kg12RfcCol(mergeKgOverlay(g, extra)), g.catRaw, flags | (g.closedCaps ? KPK9_CAPS : 0));
    }
    if (head === "KG17") {
      return decodeKg17(rfcRaw, flags, extra);
    }
    if (head === "KG15") {
      const g = parseKg15(rfcRaw);
      if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
      return knowFromTlv(kg15RfcCol(mergeKgOverlay(g, extra)), g.catRaw, flags);
    }
    if (head === "KG12" || head === "KG13") {
      const g = parseKg12(rfcRaw);
      if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
      return knowFromTlv(kg12RfcCol(mergeKgOverlay(g, extra)), g.catRaw, flags);
    }
    if (head === "KG14") {
      const g = parseKg14(rfcRaw);
      if (!g) return knowFromTlv(undefined, EMPTY_U8, flags);
      return knowFromTlv(kg12RfcCol(mergeKgOverlay(g, extra)), g.catRaw, flags);
    }
  }
  const edges = edgeResidual(rest);
  if (edges) {
    const rfcRaw = compressed ? unzipRfcSlice(rfcSlice, flags) : rfcSlice;
    return decodeKgWithEdges(rfcRaw, flags, edges);
  }
  const rawHead = !compressed && rfcSlice.byteLength >= 4 ? TD.decode(rfcSlice.subarray(0, 4)) : "";
  if (rawHead === "KG10") return decodeKg10(rfcSlice, flags);
  if (rawHead === "KG11") return decodeKg11(rfcSlice, flags);
  if (rawHead === "KG16") return decodeKg16(rfcSlice, flags);
  if (rawHead === "KG17") return decodeKg17(rfcSlice, flags);
  if (rawHead === "KG15") return decodeKg15(rfcSlice, flags);
  if (rawHead === "KG14") return decodeKg14(rfcSlice, flags);
  if (rawHead === "KG12" || rawHead === "KG13") return decodeKg12(rfcSlice, flags);
  /* KG10/KG11/KG12 store catalog inside the RFC section — unzip now when there is no residual. */
  if (compressed && !rest.byteLength && !(flags & KPK9_CAT)) {
    const rfcRaw = unzipRfcSlice(rfcSlice, flags);
    const kgHead = rfcRaw.byteLength >= 4 ? TD.decode(rfcRaw.subarray(0, 4)) : "";
    if (kgHead === "KG10") return decodeKg10(rfcRaw, flags);
    if (kgHead === "KG11") return decodeKg11(rfcRaw, flags);
    if (kgHead === "KG16") return decodeKg16(rfcRaw, flags);
    if (kgHead === "KG17") return decodeKg17(rfcRaw, flags);
    if (kgHead === "KG15") return decodeKg15(rfcRaw, flags);
    if (kgHead === "KG14") return decodeKg14(rfcRaw, flags);
    if (kgHead === "KG12" || kgHead === "KG13") return decodeKg12(rfcRaw, flags);
    const rfc = rfcRaw.byteLength ? decodeRfcColumn(rfcRaw) : undefined;
    if (rfc && flags & KPK9_EDGES) rfc.edgeSidecar = true;
    return knowFromTlv(rfc, EMPTY_U8, flags);
  }
  if (rest.byteLength) {
    const catRaw = unwrapResidual(flags, rest);
    if (catRaw.byteLength) {
      const rfcRaw =
        compressed || isBr08(rfcSlice) || isZstdFrame(rfcSlice) ? unzipRfcSlice(rfcSlice, flags) : rfcSlice;
      const kgHead = rfcRaw.byteLength >= 4 ? TD.decode(rfcRaw.subarray(0, 4)) : "";
      if (kgHead === "KG12" || kgHead === "KG13") {
        const g = parseKg12(rfcRaw);
        if (g) return knowFromTlv(kg12RfcCol(g), catRaw, flags);
      }
      if (kgHead === "KG11") {
        const g = parseKg11(rfcRaw);
        if (g) return knowFromTlv(kg11RfcCol(g), catRaw, flags);
      }
    }
  }
  const rfc = rfcSlice.byteLength ? lazyRfcCol(rfcSlice, flags) : undefined;
  if (flags & KPK9_CAT) {
    const c = closedCatalog();
    const cat: PackCat = {
      peeled: true,
      headers: c.headers,
      headerOver: new Map(),
      dns: c.dns,
      dnsObj: c.dns.map((n) => DNS_OBJECT[n] ?? ""),
      charset: c.charset,
      charsetOver: new Map(),
      protoBits: c.protoBits.slice(),
      httpBits: c.httpBits.slice(),
      objOver: new Map(),
      langs: c.langs,
      scripts: c.scripts,
      capitals: [],
      wiki: [],
    };
    return new KnowPack(
      [],
      c.w3c,
      [],
      new Map(),
      locTable(c.w3c),
      [],
      [],
      [],
      [],
      [],
      [""],
      new Map(),
      c.media,
      c.spdx,
      new Map(),
      null,
      c.scheme,
      c.whatwg,
      c.blocks,
      c.methods,
      [],
      c.wellknown,
      rfc,
      cat,
      (flags & KPK9_CAPS) !== 0,
    );
  }
  const catRaw = unwrapResidual(flags, rest);
  return knowFromTlv(rfc, catRaw, flags);
}

export function decodePack(buf: Uint8Array): KnowPack {
  const magic = TD.decode(buf.subarray(0, 4));
  if (magic === PACK_MAGIC9) return decodeKpk9(buf);
  if (magic === PACK_MAGIC8 || magic === PACK_MAGIC7) return decodeKpk7(buf);
  if (magic === PACK_MAGIC6 || magic === PACK_MAGIC5) return decodeKpk5(buf);
  if (magic === PACK_MAGIC4) return decodeKpk4(buf);
  if (magic === PACK_MAGIC3) return decodeKpk3(buf);
  if (magic === PACK_MAGIC2) return decodeKpk2(buf);
  if (magic === PACK_MAGIC) return decodeKpk1(buf);
  throw new Error("bad know pack magic");
}

export function allFacts(pack: KnowPack): PackFact[] {
  const out: PackFact[] = new Array(pack.nTriples);
  for (let i = 0; i < pack.nTriples; i++) out[i] = pack.factAt(i);
  return out;
}

/** Overlay wins on the same subject+predicate. Base fills the rest. */
export function mergeFactLists(base: PackFact[], overlay: PackFact[]): PackFact[] {
  const seen = new Set<string>();
  const out: PackFact[] = [];
  for (const f of overlay) {
    seen.add(`${f.s}\0${f.p}`);
    out.push(f);
  }
  for (const f of base) {
    if (seen.has(`${f.s}\0${f.p}`)) continue;
    out.push(f);
  }
  return out;
}

export function mergeFacts(pack: KnowPack | null, overlay: PackFact[]): PackFact[] {
  return mergeFactLists(pack ? allFacts(pack) : [], overlay);
}
