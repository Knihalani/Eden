import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import type { Triple } from "./extract";
import { canonicalUrl, hostOf, persistable } from "./extract";
import { minhashBands } from "./minhash";
import { allFacts, decodePack, encodePack, mergeFactLists, PACK_FILE, queryShapes, type KnowPack, type PackFact } from "./pack";
import { catalogAliasKeys, indexTokens, queryTokens } from "./tokens";
import { catalogSubject } from "./names";
import { SEED_URLS } from "./seed";

/** Append-only ingest overlay. Query never opens this or sqlite. */
export const JNL_FILE = "graph.jnl";
/** Packed frontier/pages/host/minhash. Replaces disk sqlite for crawl. */
export const CRAWL_FILE = "crawl.bin";
const JNL_MAGIC = "KNJ1";
const SEEN_FILE = "seen.bin";
const SEEN_MAGIC = "KNS1";
const CRAWL_MAGIC = "KNC1";
const CRAWL_SCHEMA = 15;
const SEEN_VER = 4;
const SEEN_VER3 = 3;
const SEEN_VER2 = 2;
const SEEN_SLOTS = 256;
const JNL_BIN = 1;
const JNL_SNAP4 = 4;
const JNL_SNAP5 = 5;
const SEED_SET = new Set(SEED_URLS);
const TTL_ENUM = [0, 7, 30, 365, 1825] as const;
const FRONTIER_KEEP_HOST = /(?:^|\.)(rfc-editor|iana|ietf|httpwg|spdx|unicode|whatwg)\.org$/i;
const WIKI_NS_SKIP = /\/wiki\/(?:File|Special|Help|Talk|User|Template|Wikipedia|Category|Portal|Draft|Module):/i;
const FRONTIER_JUNK_PATH = /image-article|\bapod\b|\/blog\/|\/news-events\/|\/news-release\//i;

/**
 * Paywall-adjacent CMS, APOD, and blog indexes do not belong on the packed
 * frontier. News article paths stay (1-day TTL). Catalog hosts stay: RFC,
 * IANA, IETF, W3C TR, SPDX, Unicode, WHATWG, Wikipedia.
 */
export function junkFrontier(url: string): boolean {
  if (!url || SEED_SET.has(url)) return false;
  const host = hostOf(url);
  const u = url.toLowerCase();
  if (/^blog\.|(^|\.)blogs?\./i.test(host)) return true;
  if (FRONTIER_KEEP_HOST.test(host)) return FRONTIER_JUNK_PATH.test(u);
  if (host === "w3.org" || host.endsWith(".w3.org")) {
    if (/\/blog\//i.test(u)) return true;
    if (/\/news\//i.test(u)) return false;
    return !/\/tr\//i.test(u);
  }
  if (host === "wikipedia.org" || host.endsWith(".wikipedia.org")) {
    return !/\/wiki\//i.test(u) || WIKI_NS_SKIP.test(u);
  }
  if (host === "wikidata.org" || host.endsWith(".wikidata.org")) {
    return !/\/wiki\//i.test(u);
  }
  if (
    host === "nist.gov" ||
    host.endsWith(".nist.gov") ||
    host === "nasa.gov" ||
    host.endsWith(".nasa.gov") ||
    host === "commoncrawl.org" ||
    host.endsWith(".commoncrawl.org")
  )
    return true;
  if (FRONTIER_JUNK_PATH.test(u) || /[?&]post_type=press-release/i.test(u)) return true;
  return false;
}

const KEEP_EV = new Set(["capital", "is", "obsoletes", "updates"]);
const EVIDENCE_CAP = 96;
const FRONTIER_CAP = 8_000;
/** Disk snapshot after compact. Same as RAM cap so compact does not forget the crawl. */
export const FRONTIER_PERSIST = 8_000;
export const PAGE_PERSIST = 8_000;
const MH_CAP = 1_024;
const MH_PERSIST = 1_024;
const FR_SLOTS = 8;
const SQLITE_FILES = ["graph.sqlite", "graph.sqlite-wal", "graph.sqlite-shm"] as const;
const CRAWL_VER = 8;

/** Decoder-side origin dictionary. Not a sidecar. Index 0 unused. */
const URL_ORIGINS: readonly string[] = [
  "",
  "https://www.rfc-editor.org",
  "http://www.rfc-editor.org",
  "https://rfc-editor.org",
  "https://www.w3.org",
  "http://www.w3.org",
  "https://datatracker.ietf.org",
  "http://datatracker.ietf.org",
  "https://httpwg.org",
  "https://www.httpwg.org",
  "https://en.wikipedia.org",
  "https://www.wikidata.org",
  "https://www.iana.org",
  "https://commoncrawl.org",
  "https://www.nist.gov",
  "https://www.nasa.gov",
  "https://science.nasa.gov",
  "https://www.ietf.org",
  "http://www.ietf.org",
  "https://www.unicode.org",
  "https://spdx.org",
  "https://html.spec.whatwg.org",
  "https://whatwg.org",
  "https://docs.python.org",
  "https://nodejs.org",
  "https://example.org",
  "http://example.org",
  "https://account.ietf.org",
  "https://errata.rfc-editor.org",
  "https://mailman.rfc-editor.org",
  "http://lists.w3.org",
  "https://lists.w3.org",
  "https://authors.ietf.org",
  "https://status.ietf.org",
  "https://status.commoncrawl.org",
  "https://dashboard.rfc-editor.org",
  "https://iad.rfc-editor.org",
  "http://trustee.ietf.org",
  "https://trustee.ietf.org",
  "https://www.govinfo.gov",
  "https://api.w3.org",
  "https://data.commoncrawl.org",
];

/** RFC number templates. Longer suffixes first so .html wins over bare. */
const RFC_SHAPES: readonly { pre: string; suf: string }[] = [
  { pre: "https://www.rfc-editor.org/rfc/inline-errata/rfc", suf: ".html" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: ".html" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: ".txt" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: ".xml" },
  { pre: "http://www.rfc-editor.org/rfc/rfc", suf: ".html" },
  { pre: "http://www.rfc-editor.org/rfc/rfc", suf: ".txt" },
  { pre: "https://httpwg.org/specs/rfc", suf: ".html" },
  { pre: "https://www.httpwg.org/specs/rfc", suf: ".html" },
  { pre: "https://datatracker.ietf.org/doc/html/rfc", suf: "" },
  { pre: "http://datatracker.ietf.org/doc/html/rfc", suf: "" },
  { pre: "https://www.rfc-editor.org/info/rfc", suf: "" },
  { pre: "http://www.rfc-editor.org/info/rfc", suf: "" },
  { pre: "http://www.ietf.org/rfc/rfc", suf: ".txt" },
  { pre: "https://www.ietf.org/rfc/rfc", suf: ".txt" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: "" },
  { pre: "http://www.rfc-editor.org/rfc/rfc", suf: "" },
];

/** v7 numeric templates. Longer suffixes / prefixes first. Index is on-disk shape id. */
const NUM_SHAPES: readonly { pre: string; suf: string }[] = [
  { pre: "https://www.rfc-editor.org/rfc/inline-errata/rfc", suf: ".html" },
  { pre: "https://www.nasa.gov/?post_type=press-release&#038;p=", suf: "" },
  { pre: "https://en.wikipedia.org/wiki/Frontier_", suf: "_title" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: ".html" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: ".txt" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: ".xml" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: ".pdf" },
  { pre: "http://www.rfc-editor.org/rfc/rfc", suf: ".html" },
  { pre: "http://www.rfc-editor.org/rfc/rfc", suf: ".txt" },
  { pre: "https://httpwg.org/specs/rfc", suf: ".html" },
  { pre: "https://www.httpwg.org/specs/rfc", suf: ".html" },
  { pre: "https://datatracker.ietf.org/doc/html/rfc", suf: "" },
  { pre: "http://datatracker.ietf.org/doc/html/rfc", suf: "" },
  { pre: "https://datatracker.ietf.org/feed/document-changes/rfc", suf: "/" },
  { pre: "https://www.rfc-editor.org/info/rfc", suf: "/" },
  { pre: "https://www.rfc-editor.org/info/rfc", suf: "" },
  { pre: "http://www.rfc-editor.org/info/rfc", suf: "" },
  { pre: "http://www.ietf.org/rfc/rfc", suf: ".txt" },
  { pre: "https://www.ietf.org/rfc/rfc", suf: ".txt" },
  { pre: "https://www.rfc-editor.org/rfc/rfc", suf: "" },
  { pre: "http://www.rfc-editor.org/rfc/rfc", suf: "" },
  { pre: "https://www.rfc-editor.org/errata/eid", suf: "" },
  { pre: "https://www.rfc-editor.org/bcp/bcp", suf: "" },
  { pre: "https://www.nist.gov/node/", suf: "" },
  { pre: "https://www.nasa.gov/?p=", suf: "" },
  { pre: "https://errata.rfc-editor.org/search/?rfc_number=", suf: "" },
  { pre: "https://example.org/p/", suf: "" },
  { pre: "https://example.org/q/", suf: "" },
  { pre: "http://example.org/p/", suf: "" },
  { pre: "http://example.org/q/", suf: "" },
  { pre: "https://en.wikipedia.org/wiki/Page_", suf: "" },
  { pre: "https://www.rfc-editor.org/info/std", suf: "" },
];

/** NUM_SHAPES indices whose mid is an RFC number. Append-only; do not reorder. */
const RFC_SHAPE_IX: readonly number[] = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const W3C_TR_HTTPS = "https://www.w3.org/TR/";
const W3C_TR_HTTP = "http://www.w3.org/TR/";
const IANA_ASSIGN = "https://www.iana.org/assignments/";

const WIKI_PREFIXES: readonly string[] = [
  "https://en.wikipedia.org/wiki/",
  "https://www.wikidata.org/wiki/",
];

/** Longest-first slug prefixes. Residual after prefix is unique title text. */
const SLUG_PREFIXES: readonly string[] = [
  "https://www.nasa.gov/directorates/stmd/prizes-challenges-crowdsourcing-program/centennial-challenges/",
  "https://science.nasa.gov/missions/roman-space-telescope/",
  "https://science.nasa.gov/earth/earth-observatory/",
  "https://science.nasa.gov/photojournal/",
  "https://www.rfc-editor.org/rfc/inline-errata/css/images/",
  "https://www.rfc-editor.org/rfc/inline-errata/css/",
  "https://www.nist.gov/news-events/news/",
  "https://www.nasa.gov/news-release/",
  "https://www.nasa.gov/centers-and-facilities/",
  "https://account.ietf.org/application/o/",
  "https://mailman.rfc-editor.org/mailman/listinfo/",
  "https://www.w3.org/news/2026/",
  "https://commoncrawl.org/blog/",
  "https://commoncrawl.org/team/",
  "https://www.w3.org/TR/html/",
  "http://www.w3.org/TR/xhtml1/",
  "http://www.w3.org/TR/index/",
  "http://www.w3.org/TR/intro/",
  "https://www.w3.org/groups/wg/",
  "https://www.w3.org/Consortium/",
  "https://httpwg.org/assets/",
  "https://www.w3.org/TR/",
  "http://www.w3.org/TR/",
  "https://httpwg.org/",
  "https://commoncrawl.org/",
  "https://www.iana.org/assignments/",
  "https://www.unicode.org/Public/UCD/latest/ucd/",
  "https://www.w3.org/1999/",
  "http://www.w3.org/1999/",
  "http://www.w3.org/Addressing/",
  "http://www.w3.org/Graphics/",
  "https://www.rfc-editor.org/_nuxt/",
  "https://datatracker.ietf.org/api/v1/doc/",
];

const OVERLAY_SCHEMA = `
CREATE TABLE intern (id INTEGER PRIMARY KEY, s TEXT NOT NULL UNIQUE);
CREATE TABLE evidence (id INTEGER PRIMARY KEY, h TEXT NOT NULL UNIQUE, t TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1);
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  sid INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  oid INTEGER NOT NULL,
  eid INTEGER NOT NULL,
  url TEXT,
  as_of INTEGER,
  ttl_days INTEGER
);
CREATE UNIQUE INDEX nodes_sp ON nodes(sid, pid);
CREATE INDEX nodes_url ON nodes(url);
CREATE INDEX nodes_sid ON nodes(sid);
CREATE TABLE lex (id INTEGER PRIMARY KEY, t TEXT NOT NULL UNIQUE);
CREATE TABLE post (tid INTEGER NOT NULL, nid INTEGER NOT NULL, PRIMARY KEY (tid, nid)) WITHOUT ROWID;
CREATE INDEX post_nid ON post(nid);
`;

export type KnowStore = ReturnType<typeof openStore>;

export type KnowSearch = {
  search(q: string, k?: number): { s: string; p: string; o: string; e: string; url: string }[];
  close?: () => void;
};

export function knowDir(): string {
  return process.env.EDEN_KNOW_DIR || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "know");
}

/**
 * Query/inject path: pack only. Never opens SQLite, so a long ingest write
 * cannot stall the agent. WAL overlay is ingest-only until compact.
 */
export function openQueryStore(dir = knowDir()): KnowSearch {
  let pack: KnowPack | null = null;
  try {
    pack = decodePack(readFileSync(join(dir, PACK_FILE)));
  } catch {
    pack = null;
  }
  return {
    search(q: string, k = 5) {
      return pack ? pack.search(q, k) : [];
    },
    close() {
      pack = null;
    },
  };
}

function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function urlHash(url: string): string {
  return sha16(url);
}

function isHex16(s: string): boolean {
  if (s.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    const c = s.charCodeAt(i);
    if ((c < 48 || c > 57) && (c < 97 || c > 102)) return false;
  }
  return true;
}

function seenKey(k: string): string {
  return isHex16(k) ? k : urlHash(k);
}

/** Signed 32-bit key for compact minhash rows. */
function i32(s: string): number {
  return createHash("sha256").update(s).digest().readInt32BE(0);
}

function zstdMaybe(raw: Uint8Array, level = 22): { z: boolean; b: Uint8Array } {
  if (raw.byteLength < 24) return { z: false, b: raw };
  try {
    const params: Record<number, number> = {};
    if (zlibConstants.ZSTD_c_compressionLevel !== undefined) params[zlibConstants.ZSTD_c_compressionLevel] = level;
    if (level >= 19 && raw.byteLength >= 256 && zlibConstants.ZSTD_c_windowLog !== undefined) {
      params[zlibConstants.ZSTD_c_windowLog] = 22;
    }
    const c = new Uint8Array(
      Object.keys(params).length ? zstdCompressSync(raw, { params }) : zstdCompressSync(raw),
    );
    if (c.byteLength < raw.byteLength) return { z: true, b: c };
  } catch {
    /* */
  }
  return { z: false, b: raw };
}

function packFrame(raw: Uint8Array): { kind: number; b: Uint8Array } {
  if (raw.byteLength < 48) return { kind: 0, b: raw };
  let best: Uint8Array = raw;
  let kind = 0;
  const z = zstdMaybe(raw, 22);
  if (z.z && z.b.byteLength < best.byteLength) {
    best = z.b;
    kind = 1;
  }
  try {
    const br = new Uint8Array(
      brotliCompressSync(raw, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
          [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
        },
      }),
    );
    if (br.byteLength < best.byteLength) {
      best = br;
      kind = 2;
    }
  } catch {
    /* */
  }
  return { kind, b: best };
}

function unpackFrame(buf: Uint8Array, kind: number): Uint8Array {
  if (kind === 2) return new Uint8Array(brotliDecompressSync(buf));
  if (kind === 1) return new Uint8Array(zstdDecompressSync(buf));
  return buf;
}

function hostHash(h: string): number {
  return createHash("sha256").update(h).digest().readUInt32BE(0);
}

function rfcNum(s: string): number {
  if (s.length < 5 || s.length > 11 || s[0] !== "R" || s[1] !== "F" || s[2] !== "C" || s[3] !== " ") return 0;
  let n = 0;
  for (let i = 4; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return 0;
    n = n * 10 + (c - 48);
  }
  return n > 0 && n <= 65535 ? n : 0;
}

function slotOf(hex16: string): number {
  if (hex16.length < 4) return 0;
  const a = hex16.charCodeAt(0);
  const b = hex16.charCodeAt(1);
  const nibble = (c: number) => (c < 58 ? c - 48 : c - 87);
  return ((nibble(a) << 4) | nibble(b)) & (SEEN_SLOTS - 1);
}

function slotsEmpty(slots: Buffer): boolean {
  for (let i = 0; i < slots.byteLength; i++) if (slots[i]) return false;
  return true;
}

function paintSeenSlot(slots: Buffer, key: string, digest: string) {
  if (!isHex16(digest) || slots.byteLength < SEEN_SLOTS * 8) return;
  const i = slotOf(key) * 8;
  Buffer.from(digest, "hex").copy(slots, i, 0, 8);
}

function slotDigest(slots: Buffer, key: string): string | undefined {
  if (slots.byteLength < SEEN_SLOTS * 8) return undefined;
  const i = slotOf(key) * 8;
  let z = true;
  for (let j = 0; j < 8; j++) if (slots[i + j]) z = false;
  if (z) return undefined;
  return slots.toString("hex", i, i + 8);
}

function sharePrefix(prev: string, s: string): number {
  const n = Math.min(prev.length, s.length, 255);
  let i = 0;
  while (i < n && prev.charCodeAt(i) === s.charCodeAt(i)) i++;
  return i;
}

function zstdOpen(buf: Uint8Array, z: boolean): Uint8Array {
  if (!z) return buf;
  return new Uint8Array(zstdDecompressSync(buf));
}

function writeFramed(path: string, magic: string, payloads: Uint8Array[], append: boolean) {
  const chunks: Uint8Array[] = [];
  if (!append) chunks.push(Buffer.from(magic, "ascii"));
  for (const raw of payloads) {
    const { kind, b } = packFrame(raw);
    const head = Buffer.alloc(5);
    head.writeUInt32LE(b.byteLength, 0);
    head[4] = kind;
    chunks.push(head, b);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = Buffer.allocUnsafe(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  if (append && existsSync(path)) {
    writeFileSync(path, out, { flag: "a" });
  } else if (append && !existsSync(path)) {
    writeFileSync(path, Buffer.concat([Buffer.from(magic, "ascii"), out]));
  } else {
    writeFileSync(path, out);
  }
}

function readFramed(path: string, magic: string): Uint8Array[] {
  if (!existsSync(path)) return [];
  const buf = readFileSync(path);
  if (buf.byteLength < 4 || buf.subarray(0, 4).toString("ascii") !== magic) return [];
  const out: Uint8Array[] = [];
  let i = 4;
  while (i + 5 <= buf.byteLength) {
    const n = buf.readUInt32LE(i);
    const kind = buf[i + 4] ?? 0;
    i += 5;
    if (n < 0 || i + n > buf.byteLength) break;
    try {
      out.push(unpackFrame(buf.subarray(i, i + n), kind));
    } catch {
      break;
    }
    i += n;
  }
  return out;
}

type JnlPut = { op: "put"; url: string; ttl: number; at: number; t: [string, string, string, string][] };
type JnlSnap = { op: "snap"; rows: { s: string; p: string; o: string; e: string; url: string; at: number; ttl: number }[] };
type JnlExp = { op: "exp"; now: number };
type JnlOp = JnlPut | JnlSnap | JnlExp | { op: "clr" };

function jnlPath(dir: string) {
  return join(dir, JNL_FILE);
}

function seenPath(dir: string) {
  return join(dir, SEEN_FILE);
}

function crawlPath(dir: string) {
  return join(dir, CRAWL_FILE);
}

function appendJournal(dir: string, op: JnlOp) {
  writeFramed(jnlPath(dir), JNL_MAGIC, [encodeOp(op)], true);
}

function rewriteJournal(dir: string, op: JnlOp) {
  writeFramed(jnlPath(dir), JNL_MAGIC, [encodeOp(op)], false);
}

function clearJournal(dir: string) {
  writeFileSync(jnlPath(dir), Buffer.from(JNL_MAGIC, "ascii"));
}

type SeenState = { map: Map<string, string>; slots: Buffer };

function loadSeenMap(dir: string): SeenState {
  const map = new Map<string, string>();
  let slots = Buffer.alloc(0);
  for (const raw of readFramed(seenPath(dir), SEEN_MAGIC)) {
    const got = decodeSeenPayload(raw, map);
    if (got.byteLength) slots = got;
  }
  return { map, slots };
}

function persistSeenMap(dir: string, map: Map<string, string>, slots: Buffer) {
  const rest = [...map.entries()].filter(([, v]) => !isHex16(v));
  if (!rest.length) {
    writeFileSync(seenPath(dir), Buffer.from(SEEN_MAGIC, "ascii"));
    return;
  }
  writeFramed(seenPath(dir), SEEN_MAGIC, [encodeSeenMap(map, slots)], false);
}

function dropSqlite(dir: string) {
  for (const n of SQLITE_FILES) {
    const p = join(dir, n);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* */
    }
  }
}

function mmapRead(path: string): Buffer {
  try {
    const mm = (Bun as unknown as { mmap?: (p: string) => Uint8Array }).mmap?.(path);
    if (mm && mm.byteLength) return Buffer.from(mm.buffer, mm.byteOffset, mm.byteLength);
  } catch {
    /* */
  }
  return readFileSync(path);
}

/** Split without `new URL()` so host case, trailing slash, and query/hash round-trip. */
function splitKnowUrl(url: string): { origin: string; segs: string[]; trail: number; q: string } {
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!m) return { origin: url, segs: [], trail: 0, q: "" };
  const origin = `${m[1]}://${m[2]}`;
  const path = m[3] || "";
  const q = `${m[4] || ""}${m[5] || ""}`;
  const segs = path.split("/").filter((p) => p.length > 0);
  const trail = path.endsWith("/") && (path.length > 1 || segs.length === 0) ? 1 : 0;
  return { origin, segs, trail, q };
}

type FrKey = { hid: number; p: number[]; trail: number; qid: number };

function keyStr(k: FrKey): string {
  return `${k.hid}\t${k.p.join(",")}\t${k.trail}\t${k.qid}`;
}

class Intern {
  s: string[] = [""];
  m = new Map<string, number>([["", 0]]);
  id(s: string): number {
    if (!s) return 0;
    const hit = this.m.get(s);
    if (hit !== undefined) return hit;
    if (this.s.length >= 65535) return 0;
    const i = this.s.length;
    this.s.push(s);
    this.m.set(s, i);
    return i;
  }
  has(s: string): number | undefined {
    return this.m.get(s);
  }
  get(i: number): string {
    return this.s[i] || "";
  }
}

class W {
  b: Buffer;
  i = 0;
  constructor(cap = 4096) {
    this.b = Buffer.allocUnsafe(cap);
  }
  grow(n: number) {
    if (this.i + n <= this.b.byteLength) return;
    let c = this.b.byteLength * 2;
    while (c < this.i + n) c *= 2;
    const next = Buffer.allocUnsafe(c);
    this.b.copy(next, 0, 0, this.i);
    this.b = next;
  }
  u8(v: number) {
    this.grow(1);
    this.b[this.i++] = v & 255;
  }
  u16(v: number) {
    this.grow(2);
    this.b.writeUInt16LE(v & 65535, this.i);
    this.i += 2;
  }
  u32(v: number) {
    this.grow(4);
    this.b.writeUInt32LE(v >>> 0, this.i);
    this.i += 4;
  }
  i32(v: number) {
    this.grow(4);
    this.b.writeInt32LE(v, this.i);
    this.i += 4;
  }
  str(s: string) {
    const raw = Buffer.from(s, "utf8");
    if (raw.byteLength < 255) {
      this.u8(raw.byteLength);
    } else {
      this.u8(255);
      this.u16(Math.min(raw.byteLength, 65535));
    }
    const n = raw.byteLength < 255 ? raw.byteLength : Math.min(raw.byteLength, 65535);
    this.grow(n);
    raw.copy(this.b, this.i, 0, n);
    this.i += n;
  }
  bytes(buf: Buffer, n = buf.byteLength) {
    this.grow(n);
    buf.copy(this.b, this.i, 0, n);
    this.i += n;
  }
  vu(v: number) {
    v = v >>> 0;
    while (v >= 128) {
      this.u8((v & 127) | 128);
      v >>>= 7;
    }
    this.u8(v);
  }
  out(): Buffer {
    return this.b.subarray(0, this.i);
  }
}

class R {
  constructor(
    readonly b: Buffer,
    public i = 0,
  ) {}
  get left() {
    return this.b.byteLength - this.i;
  }
  u8() {
    return this.b[this.i++]!;
  }
  u16() {
    const v = this.b.readUInt16LE(this.i);
    this.i += 2;
    return v;
  }
  u32() {
    const v = this.b.readUInt32LE(this.i);
    this.i += 4;
    return v;
  }
  i32() {
    const v = this.b.readInt32LE(this.i);
    this.i += 4;
    return v;
  }
  str() {
    const n0 = this.u8();
    const n = n0 === 255 ? this.u16() : n0;
    if (this.i + n > this.b.byteLength) return "";
    const s = this.b.toString("utf8", this.i, this.i + n);
    this.i += n;
    return s;
  }
  hex8() {
    const s = this.b.toString("hex", this.i, this.i + 8);
    this.i += 8;
    return s;
  }
  vu() {
    let v = 0;
    let s = 0;
    for (;;) {
      const b = this.u8();
      v |= (b & 127) << s;
      if ((b & 128) === 0) return v >>> 0;
      s += 7;
      if (s > 28) return v >>> 0;
    }
  }
}

function readIntern(r: R): Intern {
  const intern = new Intern();
  const n = r.u32();
  for (let i = 1; i < n && r.left > 0; i++) intern.id(r.str());
  return intern;
}

function writeIntern(w: W, intern: Intern) {
  w.u32(intern.s.length);
  for (let i = 1; i < intern.s.length; i++) w.str(intern.s[i]!);
}

function writeInternFc(w: W, strs: string[]) {
  w.u32(strs.length + 1);
  let prev = "";
  for (const s of strs) {
    const share = sharePrefix(prev, s);
    w.u8(share);
    w.str(s.slice(share));
    prev = s;
  }
}

function readInternFc(r: R): Intern {
  const intern = new Intern();
  const n = r.u32();
  let prev = "";
  for (let i = 1; i < n && r.left > 0; i++) {
    const share = r.u8();
    const s = prev.slice(0, share) + r.str();
    intern.id(s);
    prev = s;
  }
  return intern;
}

function writeFcStrs(w: W, strs: string[]) {
  w.u32(strs.length);
  let prev = "";
  for (const s of strs) {
    const share = sharePrefix(prev, s);
    w.u8(share);
    w.str(s.slice(share));
    prev = s;
  }
}

function readFcStrs(r: R): string[] {
  const n = r.u32();
  const out: string[] = [];
  let prev = "";
  for (let i = 0; i < n && r.left > 0; i++) {
    const share = r.u8();
    const s = prev.slice(0, share) + r.str();
    out.push(s);
    prev = s;
  }
  return out;
}

function originRest(url: string): { origin: string; rest: string } {
  const m = /^(https?:\/\/[^/?#]+)(.*)$/i.exec(url);
  if (!m) return { origin: url, rest: "" };
  return { origin: m[1]!, rest: m[2] || "" };
}

function matchShape(
  url: string,
  shapes: readonly { pre: string; suf: string }[],
): { si: number; n: number } | undefined {
  for (let si = 0; si < shapes.length; si++) {
    const { pre, suf } = shapes[si]!;
    if (!url.startsWith(pre)) continue;
    if (suf) {
      if (!url.endsWith(suf)) continue;
      if (url.length < pre.length + suf.length) continue;
    }
    const mid = suf ? url.slice(pre.length, url.length - suf.length) : url.slice(pre.length);
    if (!/^(0|[1-9]\d{0,9})$/.test(mid)) continue;
    const n = Number(mid);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) return { si, n };
  }
  return undefined;
}

function matchRfcShape(url: string): { si: number; n: number } | undefined {
  const hit = matchShape(url, RFC_SHAPES);
  if (!hit || hit.n === 0) return undefined;
  return hit;
}

function matchNumShape(url: string): { si: number; n: number } | undefined {
  return matchShape(url, NUM_SHAPES);
}

function wikiPrefixOf(url: string): { pi: number; title: string } | undefined {
  let best = -1;
  for (let i = 0; i < WIKI_PREFIXES.length; i++) {
    const p = WIKI_PREFIXES[i]!;
    if (url.startsWith(p) && url.length > p.length && (best < 0 || p.length > WIKI_PREFIXES[best]!.length)) best = i;
  }
  if (best < 0) return undefined;
  return { pi: best, title: url.slice(WIKI_PREFIXES[best]!.length) };
}

function slugPrefixOf(url: string): { pi: number; slug: string } | undefined {
  let best = -1;
  for (let i = 0; i < SLUG_PREFIXES.length; i++) {
    const p = SLUG_PREFIXES[i]!;
    if (url.startsWith(p) && url.length > p.length && (best < 0 || p.length > SLUG_PREFIXES[best]!.length)) best = i;
  }
  if (best < 0) return undefined;
  return { pi: best, slug: url.slice(SLUG_PREFIXES[best]!.length) };
}

function originIdOf(url: string): number {
  let best = 0;
  for (let i = 1; i < URL_ORIGINS.length; i++) {
    const o = URL_ORIGINS[i]!;
    if (url === o || url.startsWith(o + "/") || url.startsWith(o + "?") || url.startsWith(o + "#")) {
      if (o.length >= URL_ORIGINS[best]!.length) best = i;
    }
  }
  return best;
}

function writeDelta16(w: W, nums: number[]) {
  const a = [...new Set(nums)].sort((x, y) => x - y);
  w.u16(a.length);
  let prev = 0;
  for (const n of a) {
    w.u16(n - prev);
    prev = n;
  }
}

function readDelta16(r: R): number[] {
  const n = r.u16();
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < n && r.left >= 2; i++) {
    prev += r.u16();
    out.push(prev);
  }
  return out;
}

function writeDelta32(w: W, nums: number[]) {
  const a = [...new Set(nums)].sort((x, y) => x - y);
  w.u16(a.length);
  let prev = 0;
  for (const n of a) {
    w.u32((n - prev) >>> 0);
    prev = n;
  }
}

function readDelta32(r: R): number[] {
  const n = r.u16();
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < n && r.left >= 4; i++) {
    prev += r.u32();
    out.push(prev);
  }
  return out;
}

function writeNums(w: W, nums: number[]) {
  const a = [...new Set(nums)].sort((x, y) => x - y);
  const max = a[a.length - 1] || 0;
  if (max <= 65535) {
    w.u8(0);
    writeDelta16(w, a);
  } else {
    w.u8(1);
    writeDelta32(w, a);
  }
}

function readNums(r: R): number[] {
  const k = r.u8();
  return k === 1 ? readDelta32(r) : readDelta16(r);
}

function writeRleNums(w: W, nums: number[]) {
  const a = [...new Set(nums)].sort((x, y) => x - y);
  const runs: number[] = [];
  let i = 0;
  while (i < a.length) {
    let j = i;
    while (j + 1 < a.length && a[j + 1]! === a[j]! + 1) j++;
    runs.push(a[i]!, j - i + 1);
    i = j + 1;
  }
  w.vu(runs.length / 2);
  let prev = 0;
  for (let k = 0; k < runs.length; k += 2) {
    const start = runs[k]!;
    w.vu(start - prev);
    w.vu(runs[k + 1]!);
    prev = start;
  }
}

function readRleNums(r: R): number[] {
  const nRun = r.vu();
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < nRun && r.left > 0; i++) {
    const start = prev + r.vu();
    const len = r.vu();
    for (let k = 0; k < len; k++) out.push(start + k);
    prev = start;
  }
  return out;
}

function ianaNameOf(url: string): string | undefined {
  if (!url.startsWith(IANA_ASSIGN)) return undefined;
  const rest = url.slice(IANA_ASSIGN.length);
  const m = /^([^/]+)\/\1\.xml$/.exec(rest);
  return m?.[1];
}

function w3cTrOf(url: string): { https: boolean; rest: string } | undefined {
  if (url.startsWith(W3C_TR_HTTPS) && url.length > W3C_TR_HTTPS.length) {
    const longer = slugPrefixOf(url);
    if (longer && SLUG_PREFIXES[longer.pi] !== W3C_TR_HTTPS && SLUG_PREFIXES[longer.pi] !== W3C_TR_HTTP) return undefined;
    return { https: true, rest: url.slice(W3C_TR_HTTPS.length) };
  }
  if (url.startsWith(W3C_TR_HTTP) && url.length > W3C_TR_HTTP.length) {
    const longer = slugPrefixOf(url);
    if (longer && SLUG_PREFIXES[longer.pi] !== W3C_TR_HTTPS && SLUG_PREFIXES[longer.pi] !== W3C_TR_HTTP) return undefined;
    return { https: false, rest: url.slice(W3C_TR_HTTP.length) };
  }
  return undefined;
}

function writeWikiTitles(w: W, titles: string[]) {
  const tok = new Intern();
  const rows: { kind: number; v: number }[][] = [];
  for (const t of titles) {
    const row: { kind: number; v: number }[] = [];
    for (const p of t.split("_")) {
      if (/^(0|[1-9]\d{0,4})$/.test(p)) row.push({ kind: 0, v: Number(p) });
      else row.push({ kind: 1, v: tok.id(p) });
    }
    rows.push(row);
  }
  writeFcStrs(w, tok.s.slice(1));
  w.u16(titles.length);
  for (const row of rows) {
    w.u8(Math.min(row.length, 255));
    for (const p of row) {
      w.u8(p.kind);
      w.u16(p.v);
    }
  }
}

function readWikiTitles(r: R): string[] {
  const toks = ["", ...readFcStrs(r)];
  const n = r.u16();
  const out: string[] = [];
  for (let i = 0; i < n && r.left > 0; i++) {
    const np = r.u8();
    const parts: string[] = [];
    for (let j = 0; j < np && r.left >= 3; j++) {
      const kind = r.u8();
      const v = r.u16();
      parts.push(kind === 0 ? String(v) : toks[v] || "");
    }
    out.push(parts.join("_"));
  }
  return out;
}

function writeNl(w: W, strs: string[]) {
  const blob = Buffer.from(strs.join("\n"));
  w.u32(blob.byteLength);
  w.bytes(blob);
}

function readNl(r: R, nExpect?: number): string[] {
  const n = r.u32();
  if (!n) return nExpect && nExpect > 0 ? Array.from({ length: nExpect }, () => "") : [];
  const s = r.b.toString("utf8", r.i, r.i + n);
  r.i += n;
  const out = s.split("\n");
  if (nExpect !== undefined && out.length !== nExpect) {
    while (out.length < nExpect) out.push("");
    return out.slice(0, nExpect);
  }
  return out;
}

function writeBits(w: W, bits: boolean[]) {
  w.u32(bits.length);
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8 && i + j < bits.length; j++) if (bits[i + j]) b |= 1 << j;
    w.u8(b);
  }
}

function readBits(r: R): boolean[] {
  const n = r.u32();
  const out: boolean[] = Array.from({ length: n }, () => false);
  for (let i = 0; i < n; i += 8) {
    const b = r.u8();
    for (let j = 0; j < 8 && i + j < n; j++) out[i + j] = !!(b & (1 << j));
  }
  return out;
}

function expandUrlList(
  rfcByShape: Map<number, number[]>,
  restByOrigin: Map<number, string[]>,
  unknown: string[],
): string[] {
  const urls: string[] = [];
  for (let si = 0; si < RFC_SHAPES.length; si++) {
    const nums = rfcByShape.get(si);
    if (!nums?.length) continue;
    const { pre, suf } = RFC_SHAPES[si]!;
    for (const n of nums) urls.push(`${pre}${n}${suf}`);
  }
  for (let oi = 1; oi < URL_ORIGINS.length; oi++) {
    const rests = restByOrigin.get(oi);
    if (!rests?.length) continue;
    const o = URL_ORIGINS[oi]!;
    for (const rest of rests) urls.push(o + rest);
  }
  for (const u of unknown) urls.push(u);
  return urls;
}

function expandUrlListV7(
  numByShape: Map<number, number[]>,
  wikiByPrefix: Map<number, string[]>,
  slugByPrefix: Map<number, string[]>,
  restByOrigin: Map<number, string[]>,
  unknown: string[],
): string[] {
  const urls: string[] = [];
  for (let si = 0; si < NUM_SHAPES.length; si++) {
    const nums = numByShape.get(si);
    if (!nums?.length) continue;
    const { pre, suf } = NUM_SHAPES[si]!;
    for (const n of nums) urls.push(`${pre}${n}${suf}`);
  }
  for (let pi = 0; pi < WIKI_PREFIXES.length; pi++) {
    const titles = wikiByPrefix.get(pi);
    if (!titles?.length) continue;
    const p = WIKI_PREFIXES[pi]!;
    for (const t of titles) urls.push(p + t);
  }
  for (let pi = 0; pi < SLUG_PREFIXES.length; pi++) {
    const slugs = slugByPrefix.get(pi);
    if (!slugs?.length) continue;
    const p = SLUG_PREFIXES[pi]!;
    for (const s of slugs) urls.push(p + s);
  }
  for (let oi = 1; oi < URL_ORIGINS.length; oi++) {
    const rests = restByOrigin.get(oi);
    if (!rests?.length) continue;
    const o = URL_ORIGINS[oi]!;
    for (const rest of rests) urls.push(o + rest);
  }
  for (const u of unknown) urls.push(u);
  return urls;
}

function expandUrlListV8(
  rfcNums: number[],
  rfcBits: number[],
  rfcShapes: number[],
  numByShape: Map<number, number[]>,
  wikiByPrefix: Map<number, string[]>,
  w3cRests: string[],
  w3cBits: number[],
  ianaNames: string[],
  slugByPrefix: Map<number, string[]>,
  originFlags: Map<number, number>,
  restByOrigin: Map<number, string[]>,
  unknown: string[],
): string[] {
  const urls: string[] = [];
  for (let i = 0; i < rfcNums.length; i++) {
    const n = rfcNums[i]!;
    const bits = rfcBits[i]!;
    for (let b = 0; b < rfcShapes.length; b++) {
      if (!(bits & (1 << b))) continue;
      const si = rfcShapes[b]!;
      const { pre, suf } = NUM_SHAPES[si]!;
      urls.push(`${pre}${n}${suf}`);
    }
  }
  for (let si = 0; si < NUM_SHAPES.length; si++) {
    const nums = numByShape.get(si);
    if (!nums?.length) continue;
    const { pre, suf } = NUM_SHAPES[si]!;
    for (const n of nums) urls.push(`${pre}${n}${suf}`);
  }
  for (let pi = 0; pi < WIKI_PREFIXES.length; pi++) {
    const titles = wikiByPrefix.get(pi);
    if (!titles?.length) continue;
    const p = WIKI_PREFIXES[pi]!;
    for (const t of titles) urls.push(p + t);
  }
  for (let i = 0; i < w3cRests.length; i++) {
    const rest = w3cRests[i]!;
    const bits = w3cBits[i]!;
    if (bits & 1) urls.push(W3C_TR_HTTPS + rest);
    if (bits & 2) urls.push(W3C_TR_HTTP + rest);
  }
  for (const name of ianaNames) urls.push(`${IANA_ASSIGN}${name}/${name}.xml`);
  for (let pi = 0; pi < SLUG_PREFIXES.length; pi++) {
    const slugs = slugByPrefix.get(pi);
    if (!slugs?.length) continue;
    const p = SLUG_PREFIXES[pi]!;
    for (const s of slugs) urls.push(p + s);
  }
  for (let oi = 1; oi < URL_ORIGINS.length; oi++) {
    const fl = originFlags.get(oi) || 0;
    const o = URL_ORIGINS[oi]!;
    if (fl & 1) urls.push(o);
    if (fl & 2) urls.push(o + "/");
    const rests = restByOrigin.get(oi);
    if (!rests?.length) continue;
    for (const rest of rests) urls.push(o + rest);
  }
  for (const u of unknown) urls.push(u);
  return urls;
}

function ttlCode(ttl: number): number {
  const i = TTL_ENUM.indexOf(ttl as (typeof TTL_ENUM)[number]);
  return i >= 0 ? i : 15;
}

function ttlFromCode(c: number, extra = 0): number {
  if (c === 15) return extra;
  return TTL_ENUM[c] ?? 0;
}

function evOmit(e: string, o: string): string {
  if (!e) return "";
  if (e === o) return "";
  return e;
}

function internOp(parts: string[]): Intern {
  const intern = new Intern();
  for (const s of parts) intern.id(s);
  return intern;
}

function encodePut(op: JnlPut): Buffer {
  const intern = internOp([op.url, ...op.t.flat()]);
  const w = new W(64 + intern.s.length * 16);
  w.u8(JNL_BIN);
  w.u8(2);
  writeIntern(w, intern);
  w.u16(intern.id(op.url));
  w.u16(op.ttl);
  w.u32(secOf(op.at));
  w.u16(op.t.length);
  for (const [s, p, o, e] of op.t) {
    w.u16(intern.id(s));
    w.u16(intern.id(p));
    w.u16(intern.id(o));
    w.u16(intern.id(e));
  }
  return w.out();
}

function encodeSnap3(rows: JnlSnap["rows"]): Buffer {
  const intern = internOp(rows.flatMap((r) => [r.s, r.p, r.o, r.e, r.url]));
  const w = new W(64 + intern.s.length * 24 + rows.length * 16);
  w.u8(JNL_BIN);
  w.u8(3);
  writeIntern(w, intern);
  w.u32(rows.length);
  for (const r of rows) {
    w.u16(intern.id(r.s));
    w.u16(intern.id(r.p));
    w.u16(intern.id(r.o));
    w.u16(intern.id(r.e));
    w.u16(intern.id(r.url));
    w.u32(secOf(r.at));
    w.u16(r.ttl);
  }
  return w.out();
}

function encodeSnap4(rows: JnlSnap["rows"]): Buffer | undefined {
  const urls: string[] = [];
  const urlIx = new Map<string, number>();
  const atOf: number[] = [];
  const ttlOf: number[] = [];
  const rfcUpd: [number, number, number][] = [];
  const rest: JnlSnap["rows"] = [];
  for (const row of rows) {
    let ui = urlIx.get(row.url);
    if (ui === undefined) {
      if (urls.length >= 255) return undefined;
      ui = urls.length;
      urlIx.set(row.url, ui);
      urls.push(row.url);
      atOf.push(row.at);
      ttlOf.push(row.ttl);
    } else {
      atOf[ui] = row.at;
      ttlOf[ui] = row.ttl;
    }
    const a = rfcNum(row.s);
    const b = rfcNum(row.o);
    if (row.p === "updates" && a && b && !row.e) {
      rfcUpd.push([a, b, ui]);
      continue;
    }
    rest.push(row);
  }
  const intern = internOp([...urls, ...rest.flatMap((r) => [r.s, r.p, r.o, r.e])]);
  const strs = intern.s.slice(1).slice().sort();
  const idOf = new Map<string, number>();
  strs.forEach((s, i) => idOf.set(s, i + 1));
  const iid = (s: string) => idOf.get(s) || 0;
  rfcUpd.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const wbuf = new W(64 + intern.s.length * 24 + rfcUpd.length * 6 + rest.length * 12);
  wbuf.u8(JNL_BIN);
  wbuf.u8(JNL_SNAP4);
  writeInternFc(wbuf, strs);
  wbuf.u8(urls.length);
  for (let i = 0; i < urls.length; i++) {
    wbuf.u16(iid(urls[i]!));
    wbuf.u32(secOf(atOf[i]!));
    wbuf.u16(ttlOf[i]!);
  }
  wbuf.u16(rfcUpd.length);
  let prevA = 0;
  for (const [a, b, ui] of rfcUpd) {
    wbuf.u16(a - prevA);
    wbuf.u16(b);
    wbuf.u8(ui);
    prevA = a;
  }
  wbuf.u16(rest.length);
  for (const row of rest) {
    wbuf.u16(iid(row.s));
    wbuf.u16(iid(row.p));
    wbuf.u16(iid(row.o));
    wbuf.u16(iid(row.e));
    wbuf.u8(urlIx.get(row.url) ?? 0);
  }
  return wbuf.out();
}

function encodeSnap5(rows: JnlSnap["rows"]): Buffer {
  const urls: string[] = [];
  const urlIx = new Map<string, number>();
  const atOf: number[] = [];
  const ttlOf: number[] = [];
  const rfcUpd: [number, number, number][] = [];
  const rest: JnlSnap["rows"] = [];
  for (const row of rows) {
    let ui = urlIx.get(row.url);
    if (ui === undefined) {
      ui = urls.length;
      urlIx.set(row.url, ui);
      urls.push(row.url);
      atOf.push(row.at);
      ttlOf.push(row.ttl);
    } else {
      atOf[ui] = row.at;
      ttlOf[ui] = row.ttl;
    }
    const a = rfcNum(row.s);
    const b = rfcNum(row.o);
    if (row.p === "updates" && a && b && !row.e) {
      rfcUpd.push([a, b, ui]);
      continue;
    }
    rest.push(row);
  }
  const intern = internOp([...urls, ...rest.flatMap((r) => [r.s, r.p, r.o, evOmit(r.e, r.o)])]);
  const strs = intern.s.slice(1).slice().sort();
  const idOf = new Map<string, number>();
  strs.forEach((s, i) => idOf.set(s, i + 1));
  const iid = (s: string) => idOf.get(s) || 0;
  rfcUpd.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const oneUrl = urls.length === 1;
  const wbuf = new W(64 + intern.s.length * 24 + rfcUpd.length * 6 + rest.length * 12);
  wbuf.u8(JNL_BIN);
  wbuf.u8(JNL_SNAP5);
  writeInternFc(wbuf, strs);
  wbuf.u8(oneUrl ? 1 : 0);
  wbuf.u16(urls.length);
  for (let i = 0; i < urls.length; i++) {
    wbuf.u16(iid(urls[i]!));
    const at = secOf(atOf[i]!);
    const ttl = ttlOf[i]!;
    let fl = 0;
    if (at) fl |= 1;
    if (ttl) fl |= 2;
    wbuf.u8(fl);
    if (fl & 1) wbuf.u32(at);
    if (fl & 2) wbuf.u16(ttl);
  }
  wbuf.u16(rfcUpd.length);
  let prevA = 0;
  for (const [a, b, ui] of rfcUpd) {
    wbuf.u16(a - prevA);
    wbuf.u16(b);
    if (!oneUrl) wbuf.u8(ui);
    prevA = a;
  }
  wbuf.u16(rest.length);
  for (const row of rest) {
    wbuf.u16(iid(row.s));
    wbuf.u16(iid(row.p));
    wbuf.u16(iid(row.o));
    wbuf.u16(iid(evOmit(row.e, row.o)));
    wbuf.u8(urlIx.get(row.url) ?? 0);
  }
  return wbuf.out();
}

function encodeOp(op: JnlOp): Uint8Array {
  if (op.op === "clr") {
    const w = new W(2);
    w.u8(JNL_BIN);
    w.u8(0);
    return w.out();
  }
  if (op.op === "exp") {
    const w = new W(8);
    w.u8(JNL_BIN);
    w.u8(1);
    w.u32(secOf(op.now));
    return w.out();
  }
  if (op.op === "put") return encodePut(op);
  return encodeSnap5(op.rows);
}

function decodeOp(raw: Uint8Array): JnlOp | undefined {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.byteLength && buf[0] === JNL_BIN) {
    try {
      const r = new R(buf, 1);
      const kind = r.u8();
      if (kind === 0) return { op: "clr" };
      if (kind === 1) return { op: "exp", now: msOf(r.u32()) };
      if (kind === 2) {
        const intern = readIntern(r);
        const url = intern.get(r.u16());
        const ttl = r.u16();
        const at = msOf(r.u32());
        const n = r.u16();
        const t: [string, string, string, string][] = [];
        for (let i = 0; i < n && r.left > 0; i++) {
          t.push([intern.get(r.u16()), intern.get(r.u16()), intern.get(r.u16()), intern.get(r.u16())]);
        }
        return { op: "put", url, ttl, at, t };
      }
      if (kind === 3) {
        const intern = readIntern(r);
        const n = r.u32();
        const rows: JnlSnap["rows"] = [];
        for (let i = 0; i < n && r.left > 0; i++) {
          rows.push({
            s: intern.get(r.u16()),
            p: intern.get(r.u16()),
            o: intern.get(r.u16()),
            e: intern.get(r.u16()),
            url: intern.get(r.u16()),
            at: msOf(r.u32()),
            ttl: r.u16(),
          });
        }
        return { op: "snap", rows };
      }
      if (kind === JNL_SNAP4) {
        const intern = readInternFc(r);
        const nUrl = r.u8();
        const urls: { url: string; at: number; ttl: number }[] = [];
        for (let i = 0; i < nUrl && r.left > 0; i++) {
          urls.push({ url: intern.get(r.u16()), at: msOf(r.u32()), ttl: r.u16() });
        }
        const rows: JnlSnap["rows"] = [];
        const nRfc = r.u16();
        let prevA = 0;
        for (let i = 0; i < nRfc && r.left >= 5; i++) {
          const a = prevA + r.u16();
          prevA = a;
          const b = r.u16();
          const ui = r.u8();
          const u = urls[ui] || urls[0];
          if (!u) continue;
          rows.push({ s: `RFC ${a}`, p: "updates", o: `RFC ${b}`, e: "", url: u.url, at: u.at, ttl: u.ttl });
        }
        const nRest = r.u16();
        for (let i = 0; i < nRest && r.left >= 9; i++) {
          const s = intern.get(r.u16());
          const p = intern.get(r.u16());
          const o = intern.get(r.u16());
          const e = intern.get(r.u16());
          const u = urls[r.u8()] || urls[0];
          if (!u) continue;
          rows.push({ s, p, o, e, url: u.url, at: u.at, ttl: u.ttl });
        }
        return { op: "snap", rows };
      }
      if (kind === JNL_SNAP5) {
        const intern = readInternFc(r);
        const oneUrl = r.u8() === 1;
        const nUrl = r.u16();
        const urls: { url: string; at: number; ttl: number }[] = [];
        for (let i = 0; i < nUrl && r.left > 0; i++) {
          const url = intern.get(r.u16());
          const fl = r.u8();
          const at = fl & 1 ? msOf(r.u32()) : 0;
          const ttl = fl & 2 ? r.u16() : 0;
          urls.push({ url, at, ttl });
        }
        const rows: JnlSnap["rows"] = [];
        const nRfc = r.u16();
        let prevA = 0;
        for (let i = 0; i < nRfc && r.left >= 4; i++) {
          const a = prevA + r.u16();
          prevA = a;
          const b = r.u16();
          const ui = oneUrl ? 0 : r.u8();
          const u = urls[ui] || urls[0];
          if (!u) continue;
          rows.push({ s: `RFC ${a}`, p: "updates", o: `RFC ${b}`, e: "", url: u.url, at: u.at, ttl: u.ttl });
        }
        const nRest = r.u16();
        for (let i = 0; i < nRest && r.left >= 9; i++) {
          const s = intern.get(r.u16());
          const p = intern.get(r.u16());
          const o = intern.get(r.u16());
          const e = intern.get(r.u16());
          const u = urls[r.u8()] || urls[0];
          if (!u) continue;
          rows.push({ s, p, o, e, url: u.url, at: u.at, ttl: u.ttl });
        }
        return { op: "snap", rows };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  try {
    const v = JSON.parse(buf.toString("utf8")) as JnlOp;
    if (v && (v.op === "put" || v.op === "snap" || v.op === "clr" || v.op === "exp")) return v;
  } catch {
    /* */
  }
  return undefined;
}

function decodeSeenPayload(raw: Uint8Array, map: Map<string, string>): Buffer {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.byteLength >= 5 && buf[0] === SEEN_VER) {
    const r = new R(buf, 1);
    const nStr = r.u32();
    for (let i = 0; i < nStr && r.left >= 9; i++) {
      const k = r.hex8();
      map.set(k, r.str());
    }
    return Buffer.alloc(0);
  }
  if (buf.byteLength >= 3 && buf[0] === SEEN_VER3) {
    const r = new R(buf, 1);
    const nSlots = r.u16();
    let slots = Buffer.alloc(0);
    if (nSlots && r.left >= nSlots * 8) {
      slots = Buffer.from(r.b.subarray(r.i, r.i + nSlots * 8));
      r.i += nSlots * 8;
    }
    const nStr = r.left >= 4 ? r.u32() : 0;
    for (let i = 0; i < nStr && r.left >= 9; i++) {
      const k = r.hex8();
      map.set(k, r.str());
    }
    return slots;
  }
  if (buf.byteLength >= 5 && buf[0] === SEEN_VER2) {
    const r = new R(buf, 1);
    const nHex = r.u32();
    for (let i = 0; i < nHex && r.left >= 16; i++) {
      const k = r.hex8();
      const v = r.hex8();
      map.set(k, v);
    }
    const nStr = r.left >= 4 ? r.u32() : 0;
    for (let i = 0; i < nStr && r.left >= 9; i++) {
      const k = r.hex8();
      map.set(k, r.str());
    }
    return Buffer.alloc(0);
  }
  const txt = buf.toString("utf8");
  for (const line of txt.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    map.set(seenKey(line.slice(0, tab)), line.slice(tab + 1));
  }
  return Buffer.alloc(0);
}

function encodeSeenMap(map: Map<string, string>, _prevSlots: Buffer): Buffer {
  const rest: [string, string][] = [];
  for (const [k0, v] of map) {
    const k = seenKey(k0);
    if (!isHex16(v)) rest.push([k, v]);
  }
  const w = new W(8 + rest.length * 24);
  w.u8(SEEN_VER);
  w.u32(rest.length);
  for (const [k, v] of rest) {
    w.bytes(Buffer.from(k, "hex"));
    w.str(v);
  }
  return w.out();
}

function secOf(ms: number): number {
  if (!ms) return 0;
  return Math.floor(ms / 1000) >>> 0;
}

function msOf(sec: number): number {
  return sec ? sec * 1000 : 0;
}

type FrEnt = { k: FrKey; next: number; fid: number };
type PgEnt = { k: FrKey; digest: string; chars: number; src: number; fetched: number; ttl: number };

class Crawl {
  tok = new Intern();
  frontier = new Map<string, FrEnt>();
  pages = new Map<string, PgEnt>();
  hosts = new Map<number, { kept: number; skipped: number }>();
  blocked = new Set<number>();
  mh = new Map<number, number>();
  meta = new Map<string, string>();
  dirty = 0;
  fileVer = 0;

  packUrl(url: string): FrKey {
    const { origin, segs, trail, q } = splitKnowUrl(url);
    const hid = this.tok.id(origin);
    const p = Array.from({ length: FR_SLOTS }, () => 0);
    if (segs.length <= FR_SLOTS) {
      for (let i = 0; i < segs.length; i++) p[i] = this.tok.id(segs[i]!);
    } else {
      for (let i = 0; i < FR_SLOTS - 1; i++) p[i] = this.tok.id(segs[i]!);
      p[FR_SLOTS - 1] = this.tok.id(segs.slice(FR_SLOTS - 1).join("/"));
    }
    return { hid, p, trail, qid: q ? this.tok.id(q) : 0 };
  }

  assemble(k: FrKey): string {
    let s = this.tok.get(k.hid);
    for (let i = 0; i < FR_SLOTS; i++) {
      const id = k.p[i]!;
      if (!id) continue;
      s += "/" + this.tok.get(id);
    }
    if (k.trail) s += "/";
    if (k.qid) s += this.tok.get(k.qid);
    return s;
  }

  internFrom(from: string): number {
    if (!from || from === "seed") return 0;
    return this.tok.id(from);
  }

  mark() {
    this.dirty++;
  }

  setBit(id: number, on: boolean) {
    if (!id) return;
    if (on) this.blocked.add(id);
    else this.blocked.delete(id);
  }

  getBit(id: number): boolean {
    return this.blocked.has(id);
  }

  refreshHost(id: number) {
    const row = this.hosts.get(id);
    if (!row) {
      this.setBit(id, false);
      return;
    }
    const t = row.kept + row.skipped;
    this.setBit(id, t >= 8 && row.kept / t < 0.15);
  }

  purgeZeroHosts() {
    for (const [id, row] of [...this.hosts]) {
      if (row.kept === 0) {
        this.hosts.delete(id);
        this.setBit(id, false);
      }
    }
  }

  writeKey(w: W, k: FrKey) {
    let nseg = 0;
    while (nseg < FR_SLOTS && k.p[nseg]) nseg++;
    w.u16(k.hid);
    w.u8(nseg | (k.trail ? 0x10 : 0) | (k.qid ? 0x20 : 0));
    for (let i = 0; i < nseg; i++) w.u16(k.p[i]!);
    if (k.qid) w.u16(k.qid);
  }

  readKey(r: R): FrKey {
    const hid = r.u16();
    const flags = r.u8();
    const nseg = flags & 0x0f;
    const trail = flags & 0x10 ? 1 : 0;
    const hasq = !!(flags & 0x20);
    const p = Array.from({ length: FR_SLOTS }, () => 0);
    for (let i = 0; i < nseg && i < FR_SLOTS; i++) p[i] = r.u16();
    const qid = hasq ? r.u16() : 0;
    return { hid, p, trail, qid };
  }

  remapKey(k: FrKey, rid: (id: number) => number): FrKey {
    return { hid: rid(k.hid), p: k.p.map(rid), trail: k.trail, qid: rid(k.qid) };
  }

  collectUsed(): { strs: string[]; rid: (id: number) => number } {
    const seen = new Set<string>([""]);
    const take = (id: number) => {
      const s = this.tok.get(id);
      if (s) seen.add(s);
    };
    for (const e of this.frontier.values()) {
      take(e.k.hid);
      for (const id of e.k.p) take(id);
      take(e.k.qid);
      take(e.fid);
    }
    for (const e of this.pages.values()) {
      take(e.k.hid);
      for (const id of e.k.p) take(id);
      take(e.k.qid);
      take(e.src);
      if (e.digest && !isHex16(e.digest)) seen.add(e.digest);
    }
    const strs = [...seen].filter(Boolean).sort();
    const map = new Map<string, number>();
    strs.forEach((s, i) => map.set(s, i + 1));
    const rid = (id: number) => {
      if (!id) return 0;
      return map.get(this.tok.get(id)) || 0;
    };
    const sid = (s: string) => (s ? map.get(s) || 0 : 0);
    return { strs, rid, sid };
  }

  writeGrouped(
    w: W,
    items: { k: FrKey; write: (w: W) => void }[],
  ) {
    const groups = new Map<number, { k: FrKey; write: (w: W) => void }[]>();
    for (const it of items) {
      const g = groups.get(it.k.hid) || [];
      g.push(it);
      groups.set(it.k.hid, g);
    }
    w.u16(groups.size);
    for (const [hid, g] of groups) {
      g.sort((a, b) => {
        for (let i = 0; i < FR_SLOTS; i++) if (a.k.p[i] !== b.k.p[i]) return a.k.p[i]! - b.k.p[i]!;
        return a.k.qid - b.k.qid;
      });
      w.u16(hid);
      w.u16(g.length);
      let prevP = Array.from({ length: FR_SLOTS }, () => 0);
      for (const it of g) {
        let nseg = 0;
        while (nseg < FR_SLOTS && it.k.p[nseg]) nseg++;
        let sh = 0;
        while (sh < nseg && it.k.p[sh] === prevP[sh]) sh++;
        w.u8(nseg | (it.k.trail ? 0x10 : 0) | (it.k.qid ? 0x20 : 0));
        w.u8(sh);
        for (let i = sh; i < nseg; i++) w.u16(it.k.p[i]!);
        if (it.k.qid) w.u16(it.k.qid);
        it.write(w);
        prevP = it.k.p;
      }
    }
  }

  readGrouped(r: R, _nExpect: number, each: (k: FrKey) => void) {
    const nGroups = r.u16();
    let n = 0;
    for (let g = 0; g < nGroups && r.left > 0; g++) {
      const hid = r.u16();
      const m = r.u16();
      let prevP = Array.from({ length: FR_SLOTS }, () => 0);
      for (let i = 0; i < m && r.left > 0; i++) {
        const flags = r.u8();
        const sh = r.u8();
        const nseg = flags & 0x0f;
        const trail = flags & 0x10 ? 1 : 0;
        const hasq = !!(flags & 0x20);
        const p = Array.from({ length: FR_SLOTS }, () => 0);
        for (let j = 0; j < sh && j < FR_SLOTS; j++) p[j] = prevP[j]!;
        for (let j = sh; j < nseg && j < FR_SLOTS; j++) p[j] = r.u16();
        const qid = hasq ? r.u16() : 0;
        const k = { hid, p, trail, qid };
        each(k);
        prevP = p;
        n++;
      }
    }
    return n;
  }

  encode(): Buffer {
    const intern = new Intern();
    const frSet = new Set<string>();
    const frEnt = new Map<string, FrEnt>();
    for (const e of this.frontier.values()) {
      const url = this.assemble(e.k);
      if (e.fid === 0 && SEED_SET.has(url)) continue;
      frSet.add(url);
      frEnt.set(url, e);
      if (e.fid) intern.id(this.tok.get(e.fid));
    }
    const pgEnt = new Map<string, PgEnt>();
    for (const e of this.pages.values()) {
      const url = this.assemble(e.k);
      pgEnt.set(url, e);
      if (e.src) intern.id(this.tok.get(e.src));
      if (e.digest && !isHex16(e.digest)) intern.id(e.digest);
    }
    for (const [k, v] of this.meta) {
      intern.id(k);
      intern.id(v);
    }
    const strs = intern.s.slice(1).slice().sort();
    const idOf = new Map<string, number>();
    strs.forEach((s, i) => idOf.set(s, i + 1));
    const sid = (s: string) => (s ? idOf.get(s) || 0 : 0);
    const iid = (id: number) => sid(this.tok.get(id));

    const union = [...new Set([...frSet, ...pgEnt.keys()])];
    const numByShape = new Map<number, number[]>();
    const wikiByPrefix = new Map<number, string[]>();
    const w3cMap = new Map<string, number>();
    const ianaNames: string[] = [];
    const slugByPrefix = new Map<number, string[]>();
    const originFlags = new Map<number, number>();
    const restByOrigin = new Map<number, string[]>();
    const unknown: string[] = [];
    for (const url of union) {
      const num = matchNumShape(url);
      if (num) {
        const a = numByShape.get(num.si) || [];
        a.push(num.n);
        numByShape.set(num.si, a);
        continue;
      }
      const wiki = wikiPrefixOf(url);
      if (wiki) {
        const a = wikiByPrefix.get(wiki.pi) || [];
        a.push(wiki.title);
        wikiByPrefix.set(wiki.pi, a);
        continue;
      }
      const iana = ianaNameOf(url);
      if (iana) {
        ianaNames.push(iana);
        continue;
      }
      const w3c = w3cTrOf(url);
      if (w3c) {
        w3cMap.set(w3c.rest, (w3cMap.get(w3c.rest) || 0) | (w3c.https ? 1 : 2));
        continue;
      }
      const slug = slugPrefixOf(url);
      if (slug) {
        const a = slugByPrefix.get(slug.pi) || [];
        a.push(slug.slug);
        slugByPrefix.set(slug.pi, a);
        continue;
      }
      const oi = originIdOf(url);
      if (oi) {
        const rest = url.slice(URL_ORIGINS[oi]!.length);
        if (!rest) {
          originFlags.set(oi, (originFlags.get(oi) || 0) | 1);
          continue;
        }
        if (rest === "/") {
          originFlags.set(oi, (originFlags.get(oi) || 0) | 2);
          continue;
        }
        const a = restByOrigin.get(oi) || [];
        a.push(rest);
        restByOrigin.set(oi, a);
        continue;
      }
      unknown.push(url);
    }
    const rfcByNum = new Map<number, number>();
    const otherByShape = new Map<number, number[]>();
    const rfcShapes = RFC_SHAPE_IX.filter((si) => (numByShape.get(si) || []).length > 0);
    for (const [si, a0] of [...numByShape]) {
      const a = [...new Set(a0)].sort((x, y) => x - y);
      const bit = rfcShapes.indexOf(si);
      if (bit >= 0) {
        for (const n of a) rfcByNum.set(n, (rfcByNum.get(n) || 0) | (1 << bit));
      } else otherByShape.set(si, a);
    }
    for (const [pi, a] of [...wikiByPrefix]) wikiByPrefix.set(pi, [...new Set(a)].sort());
    const ianaUniq = [...new Set(ianaNames)].sort();
    const w3cRests = [...w3cMap.keys()].sort();
    const w3cBits = w3cRests.map((rest) => w3cMap.get(rest) || 0);
    for (const [pi, a] of [...slugByPrefix]) slugByPrefix.set(pi, [...new Set(a)].sort());
    for (const a of restByOrigin.values()) a.sort();
    unknown.sort();
    const rfcNums = [...rfcByNum.keys()].sort((x, y) => x - y);
    const rfcBits = rfcNums.map((n) => rfcByNum.get(n) || 0);
    let urlList = expandUrlListV8(
      rfcNums,
      rfcBits,
      rfcShapes,
      otherByShape,
      wikiByPrefix,
      w3cRests,
      w3cBits,
      ianaUniq,
      slugByPrefix,
      originFlags,
      restByOrigin,
      unknown,
    );
    const have = new Set(urlList);
    const missing = union.filter((u) => !have.has(u));
    if (missing.length) {
      unknown.push(...missing);
      unknown.sort();
      urlList = expandUrlListV8(
        rfcNums,
        rfcBits,
        rfcShapes,
        otherByShape,
        wikiByPrefix,
        w3cRests,
        w3cBits,
        ianaUniq,
        slugByPrefix,
        originFlags,
        restByOrigin,
        unknown,
      );
    }
    const ix = new Map<string, number>();
    urlList.forEach((u, i) => ix.set(u, i));

    const w = new W(8192);
    writeNl(w, strs);
    w.u8(rfcShapes.length);
    for (const si of rfcShapes) w.u8(si);
    writeRleNums(w, rfcNums);
    for (const bits of rfcBits) w.vu(bits);
    w.u8(otherByShape.size);
    for (let si = 0; si < NUM_SHAPES.length; si++) {
      const nums = otherByShape.get(si);
      if (!nums?.length) continue;
      w.u8(si);
      writeRleNums(w, nums);
    }
    w.u8(wikiByPrefix.size);
    for (let pi = 0; pi < WIKI_PREFIXES.length; pi++) {
      const titles = wikiByPrefix.get(pi);
      if (!titles?.length) continue;
      w.u8(pi);
      writeNl(w, titles);
    }
    writeNl(w, w3cRests);
    for (const bits of w3cBits) w.u8(bits);
    writeNl(w, ianaUniq);
    w.u8(slugByPrefix.size);
    for (let pi = 0; pi < SLUG_PREFIXES.length; pi++) {
      const slugs = slugByPrefix.get(pi);
      if (!slugs?.length) continue;
      w.u8(pi);
      writeNl(w, slugs);
    }
    w.u8(originFlags.size);
    for (let oi = 1; oi < URL_ORIGINS.length; oi++) {
      const fl = originFlags.get(oi);
      if (!fl) continue;
      w.u8(oi);
      w.u8(fl);
    }
    w.u8(restByOrigin.size);
    for (let oi = 1; oi < URL_ORIGINS.length; oi++) {
      const rests = restByOrigin.get(oi);
      if (!rests?.length) continue;
      w.u8(oi);
      writeNl(w, rests);
    }
    writeNl(w, unknown);
    const frBits = urlList.map((u) => frSet.has(u));
    const pgBits = urlList.map((u) => pgEnt.has(u));
    writeBits(w, frBits);
    writeBits(w, pgBits);
    const fids: [number, number][] = [];
    for (const [url, e] of frEnt) {
      const id = iid(e.fid);
      if (!id) continue;
      const i = ix.get(url);
      if (i !== undefined) fids.push([i, id]);
    }
    w.u16(fids.length);
    for (const [i, id] of fids) {
      w.u16(i);
      w.u16(id);
    }
    for (const url of urlList) {
      const p = pgEnt.get(url);
      if (!p) continue;
      let fl = 0;
      if (p.digest && !isHex16(p.digest)) fl |= 2;
      if (p.src) fl |= 4;
      const ttlc = ttlCode(p.ttl);
      w.u8(fl);
      w.u8(ttlc);
      if (ttlc === 15) w.u16(p.ttl);
      if (fl & 2) w.u16(sid(p.digest));
      if (fl & 4) w.u16(iid(p.src));
    }
    let nHost = 0;
    const hostOff = w.i;
    w.u32(0);
    for (const [id, row] of this.hosts) {
      if (row.kept < 2 && row.skipped < 8 && !this.blocked.has(id)) continue;
      w.u32(id);
      w.u16(Math.min(row.kept, 65535));
      w.u16(Math.min(row.skipped, 65535));
      nHost++;
    }
    w.b.writeUInt32LE(nHost, hostOff);
    const blocked = [...this.blocked].filter((id) => this.hosts.has(id)).sort((a, b) => a - b);
    w.u32(blocked.length);
    for (const id of blocked) w.u32(id);
    w.u32(this.mh.size);
    for (const [h, u] of this.mh) {
      w.i32(h);
      w.i32(u);
    }
    const metaKeys = [...this.meta.keys()].sort();
    w.u32(metaKeys.length);
    for (const k of metaKeys) {
      w.u16(sid(k));
      w.u16(sid(this.meta.get(k) || ""));
    }
    return w.out();
  }

  decodeCrawlBody(r: R, urlList: string[]) {
    const frBits = readBits(r);
    const pgBits = readBits(r);
    this.frontier.clear();
    this.pages.clear();
    const now = Date.now();
    for (let i = 0; i < urlList.length; i++) {
      if (!frBits[i]) continue;
      const url = urlList[i]!;
      const k = this.packUrl(url);
      this.frontier.set(keyStr(k), { k, next: now, fid: 0 });
    }
    const nFid = r.u16();
    for (let i = 0; i < nFid && r.left >= 4; i++) {
      const idx = r.u16();
      const fid = r.u16();
      const url = urlList[idx];
      if (!url) continue;
      const row = this.frontier.get(keyStr(this.packUrl(url)));
      if (row) row.fid = fid;
    }
    for (let i = 0; i < urlList.length; i++) {
      if (!pgBits[i]) continue;
      const url = urlList[i]!;
      const flags = r.u8();
      const ttlc = r.u8();
      const ttl = ttlc === 15 ? r.u16() : ttlFromCode(ttlc);
      let digest = "";
      if (flags & 1) digest = r.left >= 8 ? r.hex8() : "";
      if (flags & 2) digest = this.tok.get(r.u16());
      const src = flags & 4 ? r.u16() : 0;
      const k = this.packUrl(url);
      this.pages.set(keyStr(k), { k, digest, chars: 0, src, fetched: 0, ttl });
    }
    const nHost = r.u32();
    this.hosts.clear();
    this.blocked.clear();
    for (let i = 0; i < nHost && r.left >= 8; i++) {
      const id = r.u32();
      const kept = r.u16();
      const skipped = r.u16();
      this.hosts.set(id, { kept, skipped });
    }
    const nBlk = r.u32();
    for (let i = 0; i < nBlk && r.left >= 4; i++) this.blocked.add(r.u32());
    for (const [id] of this.hosts) this.refreshHost(id);
    const nMh = r.u32();
    this.mh.clear();
    for (let i = 0; i < nMh && r.left >= 8; i++) this.mh.set(r.i32(), r.i32());
    if (this.mh.size > MH_CAP) {
      const drop = this.mh.size - (MH_CAP >> 1);
      let n = 0;
      for (const h of this.mh.keys()) {
        this.mh.delete(h);
        if (++n >= drop) break;
      }
    }
    const nMeta = r.u32();
    this.meta.clear();
    for (let i = 0; i < nMeta && r.left >= 4; i++) {
      const k = this.tok.get(r.u16());
      const v = this.tok.get(r.u16());
      if (k) this.meta.set(k, v);
    }
  }

  decodeV8(r: R) {
    this.tok = new Intern();
    for (const s of readNl(r)) this.tok.id(s);
    const nRfcSh = r.u8();
    const rfcShapes: number[] = [];
    for (let i = 0; i < nRfcSh && r.left > 0; i++) rfcShapes.push(r.u8());
    const rfcNums = readRleNums(r);
    const rfcBits: number[] = [];
    for (let i = 0; i < rfcNums.length && r.left > 0; i++) rfcBits.push(r.vu());
    const numByShape = new Map<number, number[]>();
    const nOther = r.u8();
    for (let i = 0; i < nOther && r.left > 0; i++) {
      const si = r.u8();
      numByShape.set(si, readRleNums(r));
    }
    const wikiByPrefix = new Map<number, string[]>();
    const nWiki = r.u8();
    for (let i = 0; i < nWiki && r.left > 0; i++) {
      const pi = r.u8();
      wikiByPrefix.set(pi, readNl(r));
    }
    const w3cRests = readNl(r);
    const w3cBits: number[] = [];
    for (let i = 0; i < w3cRests.length && r.left > 0; i++) w3cBits.push(r.u8());
    const ianaNames = readNl(r);
    const slugByPrefix = new Map<number, string[]>();
    const nSlug = r.u8();
    for (let i = 0; i < nSlug && r.left > 0; i++) {
      const pi = r.u8();
      slugByPrefix.set(pi, readNl(r));
    }
    const originFlags = new Map<number, number>();
    const nFl = r.u8();
    for (let i = 0; i < nFl && r.left >= 2; i++) {
      const oi = r.u8();
      originFlags.set(oi, r.u8());
    }
    const restByOrigin = new Map<number, string[]>();
    const nOr = r.u8();
    for (let i = 0; i < nOr && r.left > 0; i++) {
      const oi = r.u8();
      restByOrigin.set(oi, readNl(r));
    }
    const unknown = readNl(r);
    const urlList = expandUrlListV8(
      rfcNums,
      rfcBits,
      rfcShapes,
      numByShape,
      wikiByPrefix,
      w3cRests,
      w3cBits,
      ianaNames,
      slugByPrefix,
      originFlags,
      restByOrigin,
      unknown,
    );
    this.decodeCrawlBody(r, urlList);
  }

  decodeV7(r: R) {
    this.tok = new Intern();
    for (const s of readFcStrs(r)) this.tok.id(s);
    const numByShape = new Map<number, number[]>();
    const nSh = r.u8();
    for (let i = 0; i < nSh && r.left > 0; i++) {
      const si = r.u8();
      numByShape.set(si, readNums(r));
    }
    const wikiByPrefix = new Map<number, string[]>();
    const nWiki = r.u8();
    for (let i = 0; i < nWiki && r.left > 0; i++) {
      const pi = r.u8();
      wikiByPrefix.set(pi, readWikiTitles(r));
    }
    const slugByPrefix = new Map<number, string[]>();
    const nSlug = r.u8();
    for (let i = 0; i < nSlug && r.left > 0; i++) {
      const pi = r.u8();
      slugByPrefix.set(pi, readFcStrs(r));
    }
    const restByOrigin = new Map<number, string[]>();
    const nOr = r.u8();
    for (let i = 0; i < nOr && r.left > 0; i++) {
      const oi = r.u8();
      restByOrigin.set(oi, readFcStrs(r));
    }
    const unknown = readFcStrs(r);
    const urlList = expandUrlListV7(numByShape, wikiByPrefix, slugByPrefix, restByOrigin, unknown);
    this.decodeCrawlBody(r, urlList);
  }

  decodeV6(r: R) {
    this.tok = new Intern();
    for (const s of readFcStrs(r)) this.tok.id(s);
    const rfcByShape = new Map<number, number[]>();
    const nSh = r.u8();
    for (let i = 0; i < nSh && r.left > 0; i++) {
      const si = r.u8();
      rfcByShape.set(si, readDelta16(r));
    }
    const restByOrigin = new Map<number, string[]>();
    const nOr = r.u8();
    for (let i = 0; i < nOr && r.left > 0; i++) {
      const oi = r.u8();
      const nRest = r.u16();
      const rests = readNl(r, nRest);
      restByOrigin.set(oi, rests);
    }
    const nUnk = r.u16();
    const unknown = readNl(r, nUnk);
    const urlList = expandUrlList(rfcByShape, restByOrigin, unknown);
    const frBits = readBits(r);
    const pgBits = readBits(r);
    this.frontier.clear();
    this.pages.clear();
    const now = Date.now();
    for (let i = 0; i < urlList.length; i++) {
      if (!frBits[i]) continue;
      const url = urlList[i]!;
      const k = this.packUrl(url);
      this.frontier.set(keyStr(k), { k, next: now, fid: 0 });
    }
    const nFid = r.u16();
    for (let i = 0; i < nFid && r.left >= 4; i++) {
      const idx = r.u16();
      const fid = r.u16();
      const url = urlList[idx];
      if (!url) continue;
      const row = this.frontier.get(keyStr(this.packUrl(url)));
      if (row) row.fid = fid;
    }
    for (let i = 0; i < urlList.length; i++) {
      if (!pgBits[i]) continue;
      const url = urlList[i]!;
      const flags = r.u8();
      const ttlc = r.u8();
      const ttl = ttlc === 15 ? r.u16() : ttlFromCode(ttlc);
      let digest = "";
      if (flags & 1) digest = r.left >= 8 ? r.hex8() : "";
      if (flags & 2) digest = this.tok.get(r.u16());
      const src = flags & 4 ? r.u16() : 0;
      const k = this.packUrl(url);
      this.pages.set(keyStr(k), { k, digest, chars: 0, src, fetched: 0, ttl });
    }
    const nHost = r.u32();
    this.hosts.clear();
    this.blocked.clear();
    for (let i = 0; i < nHost && r.left >= 8; i++) {
      const id = r.u32();
      const kept = r.u16();
      const skipped = r.u16();
      this.hosts.set(id, { kept, skipped });
    }
    const nBlk = r.u32();
    for (let i = 0; i < nBlk && r.left >= 4; i++) this.blocked.add(r.u32());
    for (const [id] of this.hosts) this.refreshHost(id);
    const nMh = r.u32();
    this.mh.clear();
    for (let i = 0; i < nMh && r.left >= 8; i++) this.mh.set(r.i32(), r.i32());
    if (this.mh.size > MH_CAP) {
      const drop = this.mh.size - (MH_CAP >> 1);
      let n = 0;
      for (const h of this.mh.keys()) {
        this.mh.delete(h);
        if (++n >= drop) break;
      }
    }
    const nMeta = r.u32();
    this.meta.clear();
    for (let i = 0; i < nMeta && r.left >= 4; i++) {
      const k = this.tok.get(r.u16());
      const v = this.tok.get(r.u16());
      if (k) this.meta.set(k, v);
    }
  }

  decodeV5(r: R) {
    this.tok = new Intern();
    for (const s of readFcStrs(r)) this.tok.id(s);
    const nFr = r.u32();
    const frText = nFr ? r.b.toString("utf8", r.i, r.i + nFr) : "";
    r.i += nFr;
    const frUrls = nFr ? frText.split("\n") : [];
    this.frontier.clear();
    this.pages.clear();
    const now = Date.now();
    for (const url of frUrls) {
      if (!url) continue;
      const k = this.packUrl(url);
      this.frontier.set(keyStr(k), { k, next: now, fid: 0 });
    }
    const nFid = r.u16();
    for (let i = 0; i < nFid && r.left >= 4; i++) {
      const idx = r.u16();
      const fid = r.u16();
      const url = frUrls[idx];
      if (!url) continue;
      const row = this.frontier.get(keyStr(this.packUrl(url)));
      if (row) row.fid = fid;
    }
    const nPg = r.u32();
    const pgText = nPg ? r.b.toString("utf8", r.i, r.i + nPg) : "";
    r.i += nPg;
    const pgUrls = nPg ? pgText.split("\n") : [];
    for (const url of pgUrls) {
      if (!url) continue;
      const flags = r.u8();
      const ttlc = r.u8();
      const ttl = ttlc === 15 ? r.u16() : ttlFromCode(ttlc);
      let digest = "";
      if (flags & 1) digest = r.left >= 8 ? r.hex8() : "";
      if (flags & 2) digest = this.tok.get(r.u16());
      const src = flags & 4 ? r.u16() : 0;
      const k = this.packUrl(url);
      this.pages.set(keyStr(k), { k, digest, chars: 0, src, fetched: 0, ttl });
    }
    const nHost = r.u32();
    this.hosts.clear();
    this.blocked.clear();
    for (let i = 0; i < nHost && r.left >= 8; i++) {
      const id = r.u32();
      const kept = r.u16();
      const skipped = r.u16();
      this.hosts.set(id, { kept, skipped });
    }
    const nBlk = r.u32();
    for (let i = 0; i < nBlk && r.left >= 4; i++) this.blocked.add(r.u32());
    for (const [id] of this.hosts) this.refreshHost(id);
    const nMh = r.u32();
    this.mh.clear();
    for (let i = 0; i < nMh && r.left >= 8; i++) this.mh.set(r.i32(), r.i32());
    if (this.mh.size > MH_CAP) {
      const drop = this.mh.size - (MH_CAP >> 1);
      let n = 0;
      for (const h of this.mh.keys()) {
        this.mh.delete(h);
        if (++n >= drop) break;
      }
    }
    const nMeta = r.u32();
    this.meta.clear();
    for (let i = 0; i < nMeta && r.left >= 4; i++) {
      const k = this.tok.get(r.u16());
      const v = this.tok.get(r.u16());
      if (k) this.meta.set(k, v);
    }
  }

  decodeV4(r: R) {
    this.tok = new Intern();
    for (const s of readFcStrs(r)) this.tok.id(s);
    const origins = readFcStrs(r);
    const base = r.u32();
    this.frontier.clear();
    this.pages.clear();
    const nOrig = r.u16();
    for (let g = 0; g < nOrig && r.left > 0; g++) {
      const origin = origins[g] || "";
      const n = r.u16();
      let prev = "";
      for (let i = 0; i < n && r.left > 0; i++) {
        const share = r.u8();
        const rest = prev.slice(0, share) + r.str();
        prev = rest;
        const url = origin + rest;
        const flags = r.u8();
        let next = 0;
        let fid = 0;
        if (flags & 4) next = msOf(base + r.u16());
        if (flags & 8) fid = r.u16();
        let digest = "";
        if (flags & 16) digest = r.left >= 8 ? r.hex8() : "";
        if (flags & 32) digest = this.tok.get(r.u16());
        let src = 0;
        if (flags & 64) src = r.u16();
        let ttl = 0;
        if (flags & 2) {
          const ttlc = r.u8();
          ttl = ttlc === 15 ? r.u16() : ttlFromCode(ttlc);
        }
        const k = this.packUrl(url);
        if (flags & 1) this.frontier.set(keyStr(k), { k, next, fid });
        if (flags & 2) this.pages.set(keyStr(k), { k, digest, chars: 0, src, fetched: 0, ttl });
      }
    }
    const nHost = r.u32();
    this.hosts.clear();
    this.blocked.clear();
    for (let i = 0; i < nHost && r.left >= 8; i++) {
      const id = r.u32();
      const kept = r.u16();
      const skipped = r.u16();
      this.hosts.set(id, { kept, skipped });
    }
    const nBlk = r.u32();
    for (let i = 0; i < nBlk && r.left >= 4; i++) this.blocked.add(r.u32());
    for (const [id] of this.hosts) this.refreshHost(id);
    const nMh = r.u32();
    this.mh.clear();
    for (let i = 0; i < nMh && r.left >= 8; i++) this.mh.set(r.i32(), r.i32());
    if (this.mh.size > MH_CAP) {
      const drop = this.mh.size - (MH_CAP >> 1);
      let n = 0;
      for (const h of this.mh.keys()) {
        this.mh.delete(h);
        if (++n >= drop) break;
      }
    }
    const nMeta = r.u32();
    this.meta.clear();
    for (let i = 0; i < nMeta && r.left >= 4; i++) {
      const k = this.tok.get(r.u16());
      const v = this.tok.get(r.u16());
      if (k) this.meta.set(k, v);
    }
  }

  decodeV3(r: R) {
    this.tok = readInternFc(r);
    const nFr = r.u32();
    this.frontier.clear();
    this.readGrouped(r, nFr, (k) => {
      const next = msOf(r.u32());
      const fid = r.u16();
      this.frontier.set(keyStr(k), { k, next, fid });
    });
    const nPg = r.u32();
    this.pages.clear();
    this.readGrouped(r, nPg, (k) => {
      let digest = "";
      const flags = r.u8();
      if (flags & 1) digest = r.left >= 8 ? r.hex8() : "";
      else {
        const id = r.u16();
        digest = id ? this.tok.get(id) : "";
      }
      const chars = r.u32();
      const src = r.u16();
      const fetched = msOf(r.u32());
      const ttl = r.u16();
      this.pages.set(keyStr(k), { k, digest, chars, src, fetched, ttl });
    });
    const nHost = r.u32();
    this.hosts.clear();
    this.blocked.clear();
    for (let i = 0; i < nHost && r.left >= 8; i++) {
      const id = r.u32();
      const kept = r.u16();
      const skipped = r.u16();
      this.hosts.set(id, { kept, skipped });
    }
    const nBlk = r.u32();
    for (let i = 0; i < nBlk && r.left >= 4; i++) this.blocked.add(r.u32());
    for (const [id] of this.hosts) this.refreshHost(id);
    const nMh = r.u32();
    this.mh.clear();
    for (let i = 0; i < nMh && r.left >= 8; i++) this.mh.set(r.i32(), r.i32());
    if (this.mh.size > MH_CAP) {
      const drop = this.mh.size - (MH_CAP >> 1);
      let n = 0;
      for (const h of this.mh.keys()) {
        this.mh.delete(h);
        if (++n >= drop) break;
      }
    }
    const nMeta = r.u32();
    this.meta.clear();
    for (let i = 0; i < nMeta && r.left > 0; i++) this.meta.set(r.str(), r.str());
  }

  decode(payload: Buffer, ver = 1) {
    const r = new R(payload);
    if (r.left < 4) return;
    if (ver >= 8) {
      this.decodeV8(r);
      return;
    }
    if (ver >= 7) {
      this.decodeV7(r);
      return;
    }
    if (ver >= 6) {
      this.decodeV6(r);
      return;
    }
    if (ver >= 5) {
      this.decodeV5(r);
      return;
    }
    if (ver >= 4) {
      this.decodeV4(r);
      return;
    }
    if (ver >= 3) {
      this.decodeV3(r);
      return;
    }
    const nTok = r.u32();
    this.tok = new Intern();
    for (let i = 1; i < nTok && r.left > 0; i++) this.tok.id(r.str());
    const nFr = r.u32();
    this.frontier.clear();
    for (let i = 0; i < nFr && r.left > 0; i++) {
      const k = this.readKey(r);
      const next = msOf(r.u32());
      const fid = r.u16();
      this.frontier.set(keyStr(k), { k, next, fid });
    }
    const nPg = r.u32();
    this.pages.clear();
    for (let i = 0; i < nPg && r.left > 0; i++) {
      const k = this.readKey(r);
      let digest = "";
      if (ver >= 2) {
        const flags = r.u8();
        if (flags & 1) digest = r.left >= 8 ? r.hex8() : "";
        else {
          const id = r.u16();
          digest = id ? this.tok.get(id) : "";
        }
      } else {
        const id = r.u16();
        digest = id ? this.tok.get(id) : "";
      }
      const chars = r.u32();
      const src = r.u16();
      const fetched = msOf(r.u32());
      const ttl = r.u16();
      this.pages.set(keyStr(k), { k, digest, chars, src, fetched, ttl });
    }
    const nHost = r.u32();
    this.hosts.clear();
    this.blocked.clear();
    for (let i = 0; i < nHost && r.left > 0; i++) {
      const id = r.u16();
      const kept = r.u16();
      const skipped = r.u16();
      const name = this.tok.get(id);
      this.hosts.set(name ? hostHash(name) : id, { kept, skipped });
    }
    const nBlk = r.u32();
    for (let i = 0; i < nBlk && r.left > 0; i++) {
      const id = r.u16();
      const name = this.tok.get(id);
      if (name) this.blocked.add(hostHash(name));
    }
    for (const [id] of this.hosts) this.refreshHost(id);
    const nMh = r.u32();
    this.mh.clear();
    for (let i = 0; i < nMh && r.left > 0; i++) this.mh.set(r.i32(), r.i32());
    if (this.mh.size > MH_CAP) {
      const drop = this.mh.size - (MH_CAP >> 1);
      let n = 0;
      for (const h of this.mh.keys()) {
        this.mh.delete(h);
        if (++n >= drop) break;
      }
    }
    const nMeta = r.u32();
    this.meta.clear();
    for (let i = 0; i < nMeta && r.left > 0; i++) this.meta.set(r.str(), r.str());
    if (ver >= 2 && r.left >= 4) {
      const nSm = r.u32();
      for (let i = 0; i < nSm && r.left > 0; i++) {
        const host = this.tok.get(r.u16());
        if (host) this.meta.set(`sitemap:${host}`, "1");
      }
    }
  }

  load(dir: string): boolean {
    const path = crawlPath(dir);
    if (!existsSync(path)) return false;
    try {
      const buf = mmapRead(path);
      if (buf.byteLength < 8 || buf.subarray(0, 4).toString("ascii") !== CRAWL_MAGIC) return false;
      const ver = buf[4] || 1;
      const kind = buf[5] || 0;
      const payload = Buffer.from(kind === 0 ? buf.subarray(8) : unpackFrame(buf.subarray(8), kind === 1 ? 1 : kind));
      this.decode(payload, ver);
      this.fileVer = ver;
      this.dirty = 0;
      return true;
    } catch {
      return false;
    }
  }

  persist(dir: string) {
    this.crush();
    const raw = this.encode();
    const { kind, b } = packFrame(raw);
    const head = Buffer.alloc(8);
    head.write(CRAWL_MAGIC, 0, 4, "ascii");
    head[4] = CRAWL_VER;
    head[5] = kind;
    const out = Buffer.concat([head, b]);
    const path = crawlPath(dir);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, out);
    renameSync(tmp, path);
    this.dirty = 0;
    this.fileVer = CRAWL_VER;
  }

  maybePersist(dir: string, force = false) {
    if (force || this.dirty >= 32) this.persist(dir);
  }

  enqueue(urls: string[], from: string) {
    const now = Date.now();
    const fid = this.internFrom(from);
    for (const raw of urls) {
      const u = canonicalUrl(raw);
      if (!u || junkFrontier(u)) continue;
      const k = this.packUrl(u);
      const id = keyStr(k);
      if (this.frontier.has(id)) continue;
      this.frontier.set(id, { k, next: now, fid });
    }
    this.trim();
    this.mark();
  }

  stale(n: number, now = Date.now()): string[] {
    const due: { url: string; ttl: number; fetched: number }[] = [];
    for (const e of this.pages.values()) {
      if (e.fetched + e.ttl * 86_400_000 > now) continue;
      const url = this.assemble(e.k);
      if (!url) continue;
      if (junkFrontier(url) && !SEED_SET.has(url)) continue;
      due.push({ url, ttl: e.ttl, fetched: e.fetched });
    }
    due.sort((a, b) => a.ttl - b.ttl || a.fetched - b.fetched);
    return due.slice(0, n).map((r) => r.url);
  }

  requeueSeeds() {
    const now = Date.now();
    for (const u of SEED_URLS) {
      const k = this.packUrl(u);
      const id = keyStr(k);
      const cur = this.frontier.get(id);
      if (cur) {
        cur.fid = 0;
        cur.next = now;
      } else this.frontier.set(id, { k, next: now, fid: 0 });
    }
    this.mark();
  }

  crush() {
    for (const [id, e] of [...this.frontier]) {
      const url = this.assemble(e.k);
      if (junkFrontier(url)) this.frontier.delete(id);
    }
    for (const [id, e] of [...this.pages]) {
      const url = this.assemble(e.k);
      if (junkFrontier(url)) this.pages.delete(id);
    }
    this.mark();
  }

  rank(url: string, fid: number): number {
    if (fid === 0) return 0;
    const u = url.toLowerCase();
    if (
      u.startsWith("https://www.rfc-editor.org/rfc/") ||
      u.startsWith("https://rfc-editor.org/rfc/") ||
      u.startsWith("http://www.rfc-editor.org/rfc/") ||
      u.startsWith("https://datatracker.ietf.org/doc/html/rfc") ||
      u.startsWith("https://httpwg.org/specs/") ||
      u.startsWith("https://www.httpwg.org/specs/")
    )
      return 1;
    if (
      u.startsWith("https://www.w3.org/tr/") ||
      u.startsWith("https://w3.org/tr/") ||
      u.startsWith("https://www.ietf.org/rfc/") ||
      u.startsWith("https://ietf.org/rfc/") ||
      u.startsWith("https://www.iana.org/") ||
      u.startsWith("https://iana.org/")
    )
      return 2;
    const host = hostOf(url);
    if (
      host === "wikipedia.org" ||
      host.endsWith(".wikipedia.org") ||
      host === "wikidata.org" ||
      host.endsWith(".wikidata.org") ||
      host.endsWith(".wiktionary.org")
    )
      return 3;
    const from = this.tok.get(fid).toLowerCase();
    if (from.includes("rss") || from.includes("feed") || from.includes("atom") || from.includes("sitemap")) return 4;
    return 5;
  }

  trim() {
    this.trimTo(FRONTIER_CAP);
  }

  trimPersist() {
    this.trimTo(FRONTIER_PERSIST);
    if (this.pages.size > PAGE_PERSIST) {
      const extra = [...this.pages.entries()]
        .map(([id, e]) => ({ id, rk: this.rank(this.assemble(e.k), e.src), fetched: e.fetched }))
        .sort((a, b) => b.rk - a.rk || a.fetched - b.fetched);
      const drop = extra.length - PAGE_PERSIST;
      for (let i = 0; i < drop && i < extra.length; i++) this.pages.delete(extra[i]!.id);
      this.mark();
    }
    if (this.mh.size > MH_PERSIST) {
      const drop = this.mh.size - MH_PERSIST;
      let n = 0;
      for (const h of this.mh.keys()) {
        this.mh.delete(h);
        if (++n >= drop) break;
      }
      this.mark();
    }
  }

  trimTo(cap: number) {
    const n = this.frontier.size;
    if (n <= cap) return;
    const drop = n - cap;
    const ranked = [...this.frontier.entries()]
      .map(([id, e]) => ({ id, rk: this.rank(this.assemble(e.k), e.fid), next: e.next }))
      .sort((a, b) => b.rk - a.rk || b.next - a.next);
    for (let i = 0; i < drop && i < ranked.length; i++) this.frontier.delete(ranked[i]!.id);
    this.mark();
  }

  take(n: number): string[] {
    const now = Date.now();
    const ready = [...this.frontier.entries()]
      .filter(([, e]) => e.next <= now)
      .map(([id, e]) => {
        const url = this.assemble(e.k);
        return { id, url, rk: this.rank(url, e.fid), next: e.next };
      })
      .sort((a, b) => a.rk - b.rk || a.next - b.next)
      .slice(0, n);
    const out: string[] = [];
    for (const r of ready) {
      this.frontier.delete(r.id);
      out.push(r.url);
    }
    if (out.length) this.mark();
    return out;
  }

  putPage(row: { url: string; digest: string; chars: number; source: string; ttl_days: number }) {
    const k = this.packUrl(row.url);
    this.pages.set(keyStr(k), {
      k,
      digest: row.digest || "",
      chars: row.chars,
      src: row.source ? this.tok.id(row.source) : 0,
      fetched: Date.now(),
      ttl: row.ttl_days,
    });
    this.mark();
  }

  pageRow(url: string): PgEnt | undefined {
    return this.pages.get(keyStr(this.packUrl(url)));
  }

  pageDigest(url: string): string | undefined {
    const row = this.pageRow(url);
    return row?.digest || undefined;
  }

  pageTtlDays(url: string): number | undefined {
    const row = this.pageRow(url);
    return row ? row.ttl : undefined;
  }

  pageFetched(url: string): number | undefined {
    const row = this.pageRow(url);
    return row?.fetched || undefined;
  }

  pageFresh(url: string, now = Date.now()): boolean {
    const row = this.pageRow(url);
    if (!row?.digest) return false;
    if (!row.fetched) return false;
    return row.fetched + row.ttl * 86_400_000 > now;
  }

  bumpHost(url: string, kept: boolean) {
    const h = hostOf(url);
    if (!h) return;
    const id = hostHash(h);
    const row = this.hosts.get(id) || { kept: 0, skipped: 0 };
    if (kept) row.kept++;
    else row.skipped++;
    this.hosts.set(id, row);
    this.refreshHost(id);
    this.mark();
  }

  hostBlocked(url: string): string | undefined {
    const h = hostOf(url);
    if (!h) return undefined;
    const id = hostHash(h);
    if (!this.hosts.has(id)) return undefined;
    return this.getBit(id) ? "host-junk" : undefined;
  }

  hostKept(host: string): number | undefined {
    return this.hosts.get(hostHash(host))?.kept;
  }

  skippedSum(): number {
    let n = 0;
    for (const row of this.hosts.values()) n += row.skipped;
    return n;
  }

  nearDup(url: string, text: string): boolean {
    const bands = minhashBands(text);
    if (!bands.length) return false;
    const uh = i32(url);
    for (const b of bands) {
      const hit = this.mh.get(i32(b));
      if (hit !== undefined && hit !== uh) return true;
    }
    for (const b of bands) {
      const h = i32(b);
      if (!this.mh.has(h)) this.mh.set(h, uh);
    }
    if (this.mh.size > MH_CAP) {
      const drop = this.mh.size - (MH_CAP >> 1);
      let n = 0;
      for (const h of this.mh.keys()) {
        this.mh.delete(h);
        if (++n >= drop) break;
      }
    }
    this.mark();
    return false;
  }

  urls(): string[] {
    const out: string[] = [];
    for (const e of this.frontier.values()) out.push(this.assemble(e.k));
    return out;
  }

  hasFrontier(url: string): boolean {
    return this.frontier.has(keyStr(this.packUrl(url)));
  }
}

function sqliteHas(db: Database, name: string): boolean {
  return !!(db.query(`SELECT 1 AS x FROM sqlite_master WHERE name = ?`).get(name) as { x: number } | null);
}

function overlayFromSqlite(db: Database, dir: string) {
  let rows: JnlSnap["rows"] = [];
  try {
    rows = db
      .query(
        `SELECT s.s AS s, p.s AS p, o.s AS o, COALESCE(e.t,'') AS e, COALESCE(n.url,'') AS url,
                n.as_of AS at, n.ttl_days AS ttl
         FROM nodes n
         JOIN intern s ON s.id = n.sid
         JOIN intern p ON p.id = n.pid
         JOIN intern o ON o.id = n.oid
         LEFT JOIN evidence e ON e.id = n.eid`,
      )
      .all() as JnlSnap["rows"];
  } catch {
    /* */
  }
  if (!rows.length) return;
  const prior: JnlOp[] = [];
  for (const raw of readFramed(jnlPath(dir), JNL_MAGIC)) {
    const op = decodeOp(raw);
    if (op) prior.push(op);
  }
  rewriteJournal(dir, { op: "snap", rows });
  for (const op of prior) appendJournal(dir, op);
}

function seenFromSqlite(db: Database, seen: Map<string, string>) {
  try {
    const rows = db.query(`SELECT url, digest FROM seen_digest`).all() as { url: string; digest: string }[];
    for (const r of rows) if (r.digest) seen.set(urlHash(r.url), r.digest);
  } catch {
    /* */
  }
}

function crawlFromSqlite(db: Database, crawl: Crawl) {
  const srcMap = new Map<number, string>([[0, "seed"]]);
  if (sqliteHas(db, "fr_src")) {
    try {
      for (const r of db.query(`SELECT id, s FROM fr_src`).all() as { id: number; s: string }[]) srcMap.set(r.id, r.s);
    } catch {
      /* */
    }
  }
  try {
    const cols = sqliteHas(db, "frontier")
      ? (db.query(`PRAGMA table_info(frontier)`).all() as { name: string }[]).map((c) => c.name)
      : [];
    const hasFrom = cols.includes("from_url");
    const hasFid = cols.includes("fid") || sqliteHas(db, "fr_row");
    const rows = db
      .query(
        `SELECT url, next_fetch${hasFid ? ", fid" : ""}${hasFrom ? ", from_url" : ""} FROM frontier`,
      )
      .all() as { url: string; next_fetch: number; fid?: number; from_url?: string }[];
    for (const r of rows) {
      let from = "seed";
      if (hasFrom) from = r.from_url || "seed";
      else if (hasFid) from = srcMap.get(r.fid ?? 0) || "seed";
      const k = crawl.packUrl(r.url);
      crawl.frontier.set(keyStr(k), { k, next: r.next_fetch || Date.now(), fid: crawl.internFrom(from) });
    }
  } catch {
    /* */
  }
  try {
    const rows = db.query(`SELECT url, digest, chars, source, fetched_at, ttl_days FROM pages`).all() as {
      url: string;
      digest: string;
      chars: number;
      source: string;
      fetched_at: number;
      ttl_days: number;
    }[];
    for (const r of rows) {
      const k = crawl.packUrl(r.url);
      crawl.pages.set(keyStr(k), {
        k,
        digest: r.digest || "",
        chars: r.chars || 0,
        src: r.source ? crawl.tok.id(r.source) : 0,
        fetched: r.fetched_at || 0,
        ttl: r.ttl_days || 0,
      });
    }
  } catch {
    /* */
  }
  try {
    const rows = db.query(`SELECT host, kept, skipped FROM host_prior`).all() as {
      host: string;
      kept: number;
      skipped: number;
    }[];
    for (const r of rows) {
      if (!r.host || !r.kept) continue;
      const id = hostHash(r.host);
      crawl.hosts.set(id, { kept: r.kept, skipped: r.skipped || 0 });
      crawl.refreshHost(id);
    }
  } catch {
    /* */
  }
  try {
    const cols = (db.query(`PRAGMA table_info(mh_band)`).all() as { name: string }[]).map((c) => c.name);
    if (cols.includes("h") && cols.includes("u")) {
      for (const r of db.query(`SELECT h, u FROM mh_band`).all() as { h: number; u: number }[]) {
        crawl.mh.set(Number(r.h), Number(r.u));
      }
    } else if (cols.includes("band")) {
      for (const r of db.query(`SELECT band, url FROM mh_band`).all() as { band: string; url: string }[]) {
        crawl.mh.set(i32(r.band), i32(r.url));
      }
    }
    if (crawl.mh.size > MH_CAP) {
      const drop = crawl.mh.size - (MH_CAP >> 1);
      let n = 0;
      for (const h of crawl.mh.keys()) {
        crawl.mh.delete(h);
        if (++n >= drop) break;
      }
    }
  } catch {
    /* */
  }
  try {
    for (const r of db.query(`SELECT k, v FROM meta`).all() as { k: string; v: string }[]) {
      if (r.k) crawl.meta.set(r.k, r.v ?? "");
    }
  } catch {
    /* */
  }
  crawl.mark();
}

function packedExists(path: string, magic: string): boolean {
  try {
    if (!existsSync(path) || statSync(path).size < 4) return false;
    return readFileSync(path).subarray(0, 4).toString("ascii") === magic;
  } catch {
    return false;
  }
}

function ingestLegacy(dir: string, crawl: Crawl, seen: Map<string, string>): boolean {
  const path = join(dir, "graph.sqlite");
  if (!existsSync(path)) return false;
  const hasJnl = packedExists(jnlPath(dir), JNL_MAGIC);
  const hasSeen = packedExists(seenPath(dir), SEEN_MAGIC);
  const hasCrawl = packedExists(crawlPath(dir), CRAWL_MAGIC);
  if (hasJnl && hasSeen && hasCrawl) return false;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    try {
      db = new Database(path);
    } catch {
      return false;
    }
  }
  try {
    if (!hasJnl) overlayFromSqlite(db, dir);
    if (!hasSeen) seenFromSqlite(db, seen);
    if (!hasCrawl) crawlFromSqlite(db, crawl);
  } finally {
    try {
      db.close();
    } catch {
      /* */
    }
  }
  return true;
}

function lit(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
    if (v == null) return "NULL";
    return String(v);
  });
}

function unquote(s: string): string {
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function crawlQuery(crawl: Crawl, sql: string) {
  const run = (params: unknown[], one: boolean): unknown => {
    const q = lit(sql, params).replace(/\s+/g, " ").trim();
    const low = q.toLowerCase();
    if (low === "pragma table_info(pages)") {
      const cols = ["url", "digest", "chars", "source", "fetched_at", "ttl_days"].map((name) => ({ name }));
      return one ? cols[0] : cols;
    }
    if (low === "pragma user_version") return { user_version: CRAWL_SCHEMA };
    let m = /^SELECT COUNT\(\*\) AS n FROM pages(?: WHERE url = (.+))?$/i.exec(q);
    if (m) {
      const n = m[1] ? (crawl.pageRow(unquote(m[1])) ? 1 : 0) : crawl.pages.size;
      return { n };
    }
    m = /^SELECT COUNT\(\*\) AS n FROM frontier(?: WHERE url = (.+))?$/i.exec(q);
    if (m) {
      const n = m[1] ? (crawl.hasFrontier(unquote(m[1])) ? 1 : 0) : crawl.frontier.size;
      return { n };
    }
    m = /^SELECT digest FROM pages WHERE url = (.+)$/i.exec(q);
    if (m) {
      const d = crawl.pageDigest(unquote(m[1]));
      return d ? { digest: d } : null;
    }
    m = /^SELECT url FROM frontier$/i.exec(q);
    if (m) {
      const rows = crawl.urls().map((url) => ({ url }));
      return one ? (rows[0] ?? null) : rows;
    }
    m = /^SELECT kept FROM host_prior WHERE host = (.+)$/i.exec(q);
    if (m) {
      const kept = crawl.hostKept(unquote(m[1]));
      return kept === undefined ? null : { kept };
    }
    m = /^SELECT COUNT\(\*\) AS n FROM host_prior WHERE kept = 0$/i.exec(q);
    if (m) {
      let n = 0;
      for (const row of crawl.hosts.values()) if (row.kept === 0) n++;
      return { n };
    }
    m = /^SELECT COALESCE\(SUM\(skipped\),0\) AS n FROM host_prior$/i.exec(q);
    if (m) return { n: crawl.skippedSum() };
    return one ? null : [];
  };
  return {
    get(...params: unknown[]) {
      return run(params, true);
    },
    all(...params: unknown[]) {
      const v = run(params, false);
      return Array.isArray(v) ? v : v == null ? [] : [v];
    },
  };
}

function seenNeedsRewrite(dir: string): boolean {
  const frames = readFramed(seenPath(dir), SEEN_MAGIC);
  if (!frames.length) return existsSync(seenPath(dir)) && statSync(seenPath(dir)).size > 4;
  const raw = frames[0]!;
  return !raw.byteLength || raw[0] !== SEEN_VER;
}

function pruneSeenAgainstCrawl(seen: Map<string, string>, crawl: Crawl): boolean {
  let n = 0;
  for (const e of crawl.pages.values()) {
    if (!e.digest) continue;
    const h = urlHash(crawl.assemble(e.k));
    if (seen.get(h) === e.digest) {
      seen.delete(h);
      n++;
    }
  }
  return n > 0;
}

function overlaySql(sql: string): boolean {
  return /\b(nodes|intern|lex|post|evidence)\b/i.test(sql);
}

export function openStore(dir = knowDir()) {
  mkdirSync(dir, { recursive: true });
  const crawl = new Crawl();
  const loaded = loadSeenMap(dir);
  const seen = loaded.map;
  let seenSlots = loaded.slots;
  let seenDirty = false;
  let seenPuts = 0;
  const hadSqlite = ingestLegacy(dir, crawl, seen);
  const hadCrawl = crawl.load(dir);
  if (pruneSeenAgainstCrawl(seen, crawl)) seenDirty = true;
  const seenLegacy = seenNeedsRewrite(dir);
  if (hadSqlite || seenDirty || seenLegacy) {
    persistSeenMap(dir, seen, seenSlots);
    seenDirty = false;
    seenPuts = 0;
  }
  if (hadSqlite) dropSqlite(dir);
  crawl.requeueSeeds();
  crawl.trim();
  if (!hadCrawl && hadSqlite) crawl.persist(dir);
  else if (hadCrawl && crawl.fileVer < CRAWL_VER) crawl.persist(dir);

  const mem = new Database(":memory:");
  mem.exec(OVERLAY_SCHEMA);

  const db = {
    query(sql: string) {
      if (overlaySql(sql)) return mem.query(sql);
      return crawlQuery(crawl, sql);
    },
    run(sql: string, ...params: unknown[]) {
      if (!overlaySql(sql)) return;
      return params.length ? mem.run(sql, ...(params as never[])) : mem.run(sql);
    },
    exec(sql: string) {
      if (overlaySql(sql)) return mem.exec(sql);
    },
    prepare(sql: string) {
      return mem.prepare(sql);
    },
    transaction<T>(fn: () => T) {
      return mem.transaction(fn);
    },
    close() {
      mem.close();
    },
  };

  const packPath = join(dir, PACK_FILE);
  let pack: KnowPack | null = null;
  try {
    pack = decodePack(readFileSync(packPath));
  } catch {
    pack = null;
  }

  const internCache = new Map<string, number>();
  const insIntern = mem.prepare(`INSERT OR IGNORE INTO intern(s) VALUES (?)`);
  const getIntern = mem.prepare(`SELECT id FROM intern WHERE s = ?`);
  function intern(s: string): number {
    const hit = internCache.get(s);
    if (hit) return hit;
    insIntern.run(s);
    const id = (getIntern.get(s) as { id: number }).id;
    internCache.set(s, id);
    return id;
  }

  const lexCache = new Map<string, number>();
  const insLex = mem.prepare(`INSERT OR IGNORE INTO lex(t) VALUES (?)`);
  const getLex = mem.prepare(`SELECT id FROM lex WHERE t = ?`);
  function lex(t: string): number {
    const hit = lexCache.get(t);
    if (hit) return hit;
    insLex.run(t);
    const id = (getLex.get(t) as { id: number }).id;
    lexCache.set(t, id);
    return id;
  }

  const insEv = mem.prepare(`INSERT OR IGNORE INTO evidence(h,t,n) VALUES (?,?,1)`);
  const getEv = mem.prepare(`SELECT id FROM evidence WHERE h = ?`);
  const bumpEv = mem.prepare(`UPDATE evidence SET n = n + 1 WHERE h = ?`);
  function casEvidence(text: string): number {
    if (!text) return 0;
    const clipped = text.length > EVIDENCE_CAP ? text.slice(0, EVIDENCE_CAP) : text;
    const h = sha16(clipped);
    const existed = getEv.get(h);
    if (existed) {
      bumpEv.run(h);
      return (existed as { id: number }).id;
    }
    insEv.run(h, clipped);
    return (getEv.get(h) as { id: number }).id;
  }

  const hydrateSql = `
    SELECT s.s AS s, p.s AS p, o.s AS o, COALESCE(e.t,'') AS e, n.url AS url,
      CASE p.s WHEN 'capital' THEN 0 WHEN 'is' THEN 1 WHEN 'obsoletes' THEN 2 WHEN 'updates' THEN 3 WHEN 'date' THEN 4 ELSE 5 END AS rk
    FROM nodes n
    JOIN intern s ON s.id = n.sid
    JOIN intern p ON p.id = n.pid
    JOIN intern o ON o.id = n.oid
    LEFT JOIN evidence e ON e.id = n.eid`;

  function searchSql(q: string, k: number): { s: string; p: string; o: string; e: string; url: string }[] {
    const toks = queryTokens(q);
    const exactKeys = [...new Set([q.trim(), ...queryShapes(q), ...toks])].filter(Boolean);
    for (const t of exactKeys) {
      const exact = mem.query(`${hydrateSql} WHERE s.s = ? COLLATE NOCASE ORDER BY rk LIMIT ?`).all(t, k) as {
        s: string; p: string; o: string; e: string; url: string;
      }[];
      if (exact.length) return exact.filter((h) => h.p !== "about" && h.p !== "date" && h.o.length <= 96);
    }
    if (!toks.length) return [];
    let ids: number[] | undefined;
    let missing = false;
    for (const t of toks) {
      const row = getLex.get(t) as { id: number } | null;
      if (!row) {
        missing = true;
        break;
      }
      const nids = mem.query(`SELECT nid FROM post WHERE tid = ?`).all(row.id) as { nid: number }[];
      const set = new Set(nids.map((x) => x.nid));
      ids = ids ? ids.filter((i) => set.has(i)) : [...set];
    }
    if (!missing && ids?.length) {
      const one = mem.query(`${hydrateSql} WHERE n.id = ?`);
      const out: { s: string; p: string; o: string; e: string; url: string; rk: number }[] = [];
      for (const id of ids) {
        const row = one.get(id) as { s: string; p: string; o: string; e: string; url: string; rk: number } | null;
        if (row && row.p !== "about" && row.p !== "date" && row.o.length <= 96) out.push(row);
      }
      out.sort((a, b) => a.rk - b.rk);
      if (out.length) return out.slice(0, k);
    }
    return [];
  }

  const insNode = mem.prepare(
    `INSERT INTO nodes(sid,pid,oid,eid,url,as_of,ttl_days) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(sid, pid) DO UPDATE SET
       oid = CASE WHEN excluded.eid != 0 AND nodes.eid = 0 THEN excluded.oid
                  WHEN nodes.eid = 0 THEN excluded.oid ELSE nodes.oid END,
       eid = CASE WHEN excluded.eid != 0 AND nodes.eid = 0 THEN excluded.eid
                  WHEN nodes.eid = 0 THEN excluded.eid ELSE nodes.eid END,
       url = CASE WHEN excluded.eid != 0 AND nodes.eid = 0 THEN excluded.url
                  WHEN nodes.eid = 0 THEN excluded.url ELSE nodes.url END,
       as_of = excluded.as_of,
       ttl_days = excluded.ttl_days`,
  );
  const insP = mem.prepare(`INSERT OR IGNORE INTO post(tid, nid) VALUES (?,?)`);
  const delPost = mem.prepare(`DELETE FROM post WHERE nid = ?`);
  const getNid = mem.prepare(`SELECT id FROM nodes WHERE sid = ? AND pid = ?`);
  const staleOf = mem.prepare(`SELECT id, sid, pid FROM nodes WHERE url = ?`);
  const delNode = mem.prepare(`DELETE FROM nodes WHERE id = ?`);

  function applyPut(url: string, triples: Triple[], ttl_days: number, as_of: number): [string, string, string, string][] {
    const kept: [string, string, string, string][] = [];
    const write = mem.transaction(() => {
      const keep = new Set<string>();
      for (const t of triples) {
        if (!persistable(url, t)) continue;
        const cap = t.p === "is" && /^RFC\s+\d/i.test(t.s) ? 96 : 72;
        if (t.o.length > cap || /\b(Light|Dark|Auto)\b/i.test(t.o) || /REP\)/i.test(t.o)) continue;
        const sid = intern(t.s);
        const pid = intern(t.p);
        const oid = intern(t.o);
        const ev = KEEP_EV.has(t.p) ? t.e : "";
        const eid = casEvidence(ev);
        insNode.run(sid, pid, oid, eid, url, as_of, ttl_days);
        const nid = (getNid.get(sid, pid) as { id: number }).id;
        keep.add(`${sid},${pid}`);
        delPost.run(nid);
        const words = catalogSubject(t.s) ? catalogAliasKeys(t) : indexTokens(t);
        for (const w of words) insP.run(lex(w), nid);
        kept.push([t.s, t.p, t.o, ev]);
      }
      const stale = staleOf.all(url) as { id: number; sid: number; pid: number }[];
      for (const r of stale) {
        if (keep.has(`${r.sid},${r.pid}`)) continue;
        delPost.run(r.id);
        delNode.run(r.id);
      }
    });
    write();
    return kept;
  }

  function overlayRows(): JnlSnap["rows"] {
    return mem
      .query(
        `SELECT s.s AS s, p.s AS p, o.s AS o, COALESCE(e.t,'') AS e, COALESCE(n.url,'') AS url,
                n.as_of AS at, n.ttl_days AS ttl
         FROM nodes n
         JOIN intern s ON s.id = n.sid
         JOIN intern p ON p.id = n.pid
         JOIN intern o ON o.id = n.oid
         LEFT JOIN evidence e ON e.id = n.eid`,
      )
      .all() as JnlSnap["rows"];
  }

  function clearOverlay() {
    mem.run(`DELETE FROM post`);
    mem.run(`DELETE FROM lex`);
    mem.run(`DELETE FROM nodes`);
    mem.run(`DELETE FROM intern`);
    mem.run(`DELETE FROM evidence`);
    internCache.clear();
    lexCache.clear();
  }

  let jnlPuts = 0;
  function snapshotJournal() {
    let rows = overlayRows();
    if (pack) {
      const have = new Set<string>();
      for (const f of allFacts(pack)) have.add(`${f.s}\0${f.p}`);
      rows = rows.filter((r) => !have.has(`${r.s}\0${r.p}`) && !r.s.includes(" | "));
    } else {
      rows = rows.filter((r) => !r.s.includes(" | "));
    }
    if (rows.length !== overlayRows().length) {
      clearOverlay();
      const byUrl = new Map<string, { ttl: number; at: number; t: Triple[] }>();
      for (const r of rows) {
        const cur = byUrl.get(r.url) || { ttl: r.ttl, at: r.at, t: [] };
        cur.t.push({ s: r.s, p: r.p, o: r.o, e: r.e });
        cur.ttl = r.ttl;
        cur.at = r.at;
        byUrl.set(r.url, cur);
      }
      for (const [url, g] of byUrl) applyPut(url, g.t, g.ttl, g.at);
    }
    if (!rows.length) clearJournal(dir);
    else rewriteJournal(dir, { op: "snap", rows });
    jnlPuts = 0;
  }

  function expireMem(now: number) {
    mem.run(`UPDATE nodes SET eid = 0 WHERE as_of + ttl_days * 86400000 < ? AND eid != 0`, [now]);
    mem.run(`DELETE FROM evidence WHERE id NOT IN (SELECT eid FROM nodes WHERE eid != 0)`);
  }

  for (const raw of readFramed(jnlPath(dir), JNL_MAGIC)) {
    const op = decodeOp(raw);
    if (!op) continue;
    if (op.op === "clr") clearOverlay();
    else if (op.op === "exp") expireMem(op.now);
    else if (op.op === "snap") {
      clearOverlay();
      const byUrl = new Map<string, { ttl: number; at: number; t: Triple[] }>();
      for (const r of op.rows) {
        const cur = byUrl.get(r.url) || { ttl: r.ttl, at: r.at, t: [] };
        cur.t.push({ s: r.s, p: r.p, o: r.o, e: r.e });
        cur.ttl = r.ttl;
        cur.at = r.at;
        byUrl.set(r.url, cur);
      }
      for (const [url, g] of byUrl) applyPut(url, g.t, g.ttl, g.at);
    } else if (op.op === "put") {
      applyPut(
        op.url,
        op.t.map(([s, p, o, e]) => ({ s, p, o, e })),
        op.ttl,
        op.at,
      );
    }
  }
  snapshotJournal();

  let walHint = !!(mem.query(`SELECT 1 AS x FROM nodes LIMIT 1`).get());
  let crawlHold = 0;
  function crawlPersist(force = false) {
    if (!crawlHold) crawl.maybePersist(dir, force);
  }

  return {
    db: db as unknown as Database,
    dir,
    intern,
    crawlBatch<T>(fn: () => T): T {
      crawlHold++;
      try {
        return fn();
      } finally {
        crawlHold = Math.max(0, crawlHold - 1);
        crawl.maybePersist(dir, true);
      }
    },
    pageDigest(url: string): string | undefined {
      const h = urlHash(url);
      const hit = seen.get(h);
      if (hit) return hit;
      const page = crawl.pageDigest(url);
      if (page) return page;
      return slotDigest(seenSlots, h);
    },
    pageTtlDays(url: string): number | undefined {
      return crawl.pageTtlDays(url);
    },
    pageFetched(url: string): number | undefined {
      return crawl.pageFetched(url);
    },
    pageFresh(url: string, now = Date.now()): boolean {
      return crawl.pageFresh(url, now);
    },
    hasWalNodes(url: string): boolean {
      return !!(mem.query(`SELECT 1 AS x FROM nodes WHERE url = ? LIMIT 1`).get(url));
    },
    hostBlocked(url: string): string | undefined {
      return crawl.hostBlocked(url);
    },
    bumpHost(url: string, kept: boolean) {
      crawl.bumpHost(url, kept);
      crawlPersist();
    },
    nearDup(url: string, text: string): boolean {
      const hit = crawl.nearDup(url, text);
      crawlPersist();
      return hit;
    },
    putPage(row: {
      url: string;
      digest: string;
      chars: number;
      source: string;
      ttl_days: number;
      skip?: string;
    }) {
      if (row.digest) {
        const h = urlHash(row.url);
        if (row.skip) {
          seen.set(h, row.digest);
          seenDirty = true;
          seenPuts++;
          if (seenPuts >= 64) {
            persistSeenMap(dir, seen, seenSlots);
            seenDirty = false;
            seenPuts = 0;
          }
        } else if (seen.delete(h)) {
          seenDirty = true;
        }
      }
      if (row.skip) return;
      crawl.putPage(row);
      crawlPersist();
    },
    putNodes(url: string, triples: Triple[], ttl_days: number) {
      const now = Date.now();
      const kept = applyPut(url, triples, ttl_days, now);
      appendJournal(dir, { op: "put", url, ttl: ttl_days, at: now, t: kept });
      jnlPuts++;
      if (jnlPuts >= 32) snapshotJournal();
      walHint = true;
    },
    enqueue(urls: string[], from: string) {
      crawl.enqueue(urls, from);
      crawl.maybePersist(dir, true);
    },
    takeFrontier(n: number): string[] {
      const rows = crawl.take(n);
      crawl.maybePersist(dir, true);
      return rows;
    },
    staleUrls(n: number): string[] {
      return crawl.stale(n);
    },
    count() {
      return {
        pages: crawl.pages.size,
        skipped: crawl.skippedSum(),
        nodes: (mem.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n + (pack?.nTriples ?? 0),
        frontier: crawl.frontier.size,
        wal_nodes: (mem.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n,
        pack: pack?.nTriples ?? 0,
      };
    },
    search(q: string, k = 5): { s: string; p: string; o: string; e: string; url: string }[] {
      const packed = pack ? pack.search(q, k) : [];
      const wal = walHint && !!(mem.query(`SELECT 1 AS x FROM nodes LIMIT 1`).get());
      walHint = wal;
      if (!wal) return packed;
      if (packed.length) {
        for (const shape of queryShapes(q)) {
          if (pack?.locate(shape)) return packed;
        }
      } else if (pack) {
        const words = q.trim().split(/\s+/).filter(Boolean);
        const entity =
          /^(?:the\s+)?capital of /i.test(q) ||
          (words.length === 1 && words[0]!.length <= 16 && /^[A-Za-z][A-Za-z -]*$/.test(words[0]!));
        if (!entity) return packed;
      }
      const overlay = searchSql(q, k);
      if (!pack) return overlay;
      if (!overlay.length) return packed;
      const keys = new Set(overlay.map((h) => `${h.s}\0${h.p}`));
      const rest = packed.filter((h) => !keys.has(`${h.s}\0${h.p}`));
      const rk = (p: string) =>
        p === "capital" ? 0 : p === "is" ? 1 : p === "obsoletes" ? 2 : p === "updates" ? 3 : 4;
      return [...overlay, ...rest].sort((a, b) => rk(a.p) - rk(b.p)).slice(0, k);
    },
    expire(now = Date.now()) {
      expireMem(now);
      appendJournal(dir, { op: "exp", now });
    },
    compact(base: PackFact[] = []): Uint8Array | undefined {
      try {
        crawl.crush();
        crawl.trim();
        crawl.purgeZeroHosts();
        crawl.trimPersist();
        const overlay = overlayRows().map((r) => ({ s: r.s, p: r.p, o: r.o, e: r.e, url: r.url }));
        const localFacts = pack ? allFacts(pack) : [];
        const packTriple = new Set(localFacts.map((f) => `${f.s}\0${f.p}\0${f.o}`));
        const facts = mergeFactLists(mergeFactLists(base, localFacts), overlay).filter((f) => {
          if (packTriple.has(`${f.s}\0${f.p}\0${f.o}`)) return true;
          if (f.p !== "capital") return true;
          if (f.s.toLowerCase() === f.o.toLowerCase()) return false;
          return !localFacts.some((p) => p.p === "capital" && p.s === f.o && p.o === f.s);
        });
        let written: Uint8Array | undefined;
        if (facts.length) {
          const bytes = encodePack(facts);
          const decoded = decodePack(bytes);
          const tmp = `${packPath}.tmp`;
          writeFileSync(tmp, bytes);
          renameSync(tmp, packPath);
          pack = decoded;
          written = bytes;
        }
        clearOverlay();
        crawl.mh.clear();
        crawl.mark();
        clearJournal(dir);
        jnlPuts = 0;
        walHint = false;
        if (seenDirty) {
          persistSeenMap(dir, seen, seenSlots);
          seenDirty = false;
          seenPuts = 0;
        }
        crawl.persist(dir);
        dropSqlite(dir);
        return written;
      } catch (e) {
        console.error(JSON.stringify({ compact: "failed", err: String(e).slice(0, 200) }));
        return undefined;
      }
    },
    schemaVersion(): number {
      return CRAWL_SCHEMA;
    },
    setMeta(k: string, v: string) {
      crawl.meta.set(k, v);
      crawl.mark();
      crawl.maybePersist(dir, true);
    },
    getMeta(k: string): string | undefined {
      return crawl.meta.get(k);
    },
    close() {
      if (seenDirty) persistSeenMap(dir, seen, seenSlots);
      if (jnlPuts > 0) snapshotJournal();
      crawl.persist(dir);
      mem.close();
    },
  };
}
