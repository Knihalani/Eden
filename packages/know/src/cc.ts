import { gunzipSync, constants as zconst } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EDENBOT } from "./ua";
import { junkFrontier, knowDir } from "./store";
import { englishEnough, hostOf, qualityHost, skipHost } from "./extract";
import { pageTtl } from "./ttl";
import { cheapSkip, gopherSkip, headerSkipHost, wetFactBearing, wetSpam } from "./gate";
import { englishTrigram } from "./lang";
import { minhashBands } from "./minhash";
import { WET_SCAN_MULT, envNum, shardWetIndex, wetByteCap } from "./defaults";
import { BytePipe, emptyWarcStats, pushWarcBytes, type WetRecord } from "./warc";

const CC = "https://data.commoncrawl.org/";
const COLLINFO = "https://index.commoncrawl.org/collinfo.json";

let crawlMem: { id: string; at: number } | undefined;

export async function latestCrawlId(): Promise<string> {
  if (crawlMem && Date.now() - crawlMem.at < 6 * 3600_000) return crawlMem.id;
  const cached = join(knowDir(), "collinfo-id.txt");
  try {
    const r = await fetch(COLLINFO, { headers: { "User-Agent": EDENBOT }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`collinfo ${r.status}`);
    const j = (await r.json()) as { id: string }[];
    for (const row of j.slice(0, 8)) {
      if (!row.id) continue;
      try {
        const paths = await listWetPaths(row.id);
        if (paths.length) {
          crawlMem = { id: row.id, at: Date.now() };
          mkdirSync(knowDir(), { recursive: true });
          writeFileSync(cached, row.id);
          return row.id;
        }
      } catch {
        continue;
      }
    }
    throw new Error("no crawl with wet.paths");
  } catch (e) {
    try {
      const id = readFileSync(cached, "utf8").trim();
      if (id) {
        crawlMem = { id, at: Date.now() };
        return id;
      }
    } catch {
      /* miss */
    }
    throw e;
  }
}

export async function listWetPaths(crawlId: string): Promise<string[]> {
  const dir = knowDir();
  mkdirSync(dir, { recursive: true });
  const cache = join(dir, `wet-paths-${crawlId}.txt`);
  try {
    const cached = readFileSync(cache, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (cached.length) return cached;
  } catch {
    /* miss */
  }
  const r = await fetch(`${CC}crawl-data/${crawlId}/wet.paths.gz`, {
    headers: { "User-Agent": EDENBOT },
  });
  if (!r.ok) throw new Error(`wet.paths ${r.status}`);
  const text = gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  writeFileSync(cache, lines.join("\n"));
  return lines;
}

export async function wetPath(crawlId: string, index = 0): Promise<string> {
  const lines = await listWetPaths(crawlId);
  const line = lines[shardWetIndex(index) % lines.length];
  if (!line) throw new Error("empty wet.paths");
  return `${CC}${line}`;
}

export async function listNewsWarcs(year: number, month: number): Promise<string[]> {
  const ym = `${year}/${String(month).padStart(2, "0")}`;
  const dir = knowDir();
  mkdirSync(dir, { recursive: true });
  const cache = join(dir, `news-warc-${year}-${String(month).padStart(2, "0")}.txt`);
  try {
    const cached = readFileSync(cache, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (cached.length) return cached;
  } catch {
    /* miss */
  }
  const r = await fetch(`${CC}crawl-data/CC-NEWS/${ym}/warc.paths.gz`, {
    headers: { "User-Agent": EDENBOT },
  });
  if (!r.ok) throw new Error(`news warc.paths ${r.status}`);
  const text = gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  writeFileSync(cache, lines.join("\n"));
  return lines;
}

export async function newsWarcPath(index = 0, at = new Date()): Promise<string> {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() + 1;
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  let lines: string[] = [];
  for (const pair of [
    [y, m],
    [prevY, prevM],
  ] as [number, number][]) {
    try {
      lines = await listNewsWarcs(pair[0], pair[1]);
      if (lines.length) break;
    } catch {
      continue;
    }
  }
  if (!lines.length) throw new Error("no CC-NEWS warc.paths");
  const line = lines[lines.length - 1 - (shardWetIndex(index) % lines.length)];
  if (!line) throw new Error("empty CC-NEWS paths");
  return `${CC}${line}`;
}

/** Catalog registries: hostname match, never a URI substring. Wikipedia is not a registry. */
const REGISTRY_HOST = /(?:^|\.)(iana|rfc-editor|ietf|w3|spdx|unicode|whatwg)\.org$/i;
const WIKI_NS_SKIP = /\/wiki\/(?:File|Special|Help|Talk|User|Template|Wikipedia|Category|Portal|Draft|Module):/i;

/**
 * Lower fetches first. Dense wiki lists beat RFC HTML beat other registries
 * beat wiki articles beat other catalog hosts. Paywalls are 90 (also skipHost).
 */
export function rankFrontier(url: string): number {
  if (skipHost(url) || junkFrontier(url)) return 90;
  const u = url.toLowerCase();
  if (/wikipedia\.org\/wiki\/(?:list_of_|outline_of_)/i.test(u)) return 1;
  if (/rfc[-/_]?\d{3,5}/i.test(u) && (catalogRegistry(url) || qualityHost(url))) return 2;
  if (catalogRegistry(url)) return 3;
  if (/wikipedia\.org\/wiki\//i.test(u) && !WIKI_NS_SKIP.test(u)) return 4;
  if (/(?:wikidata|wiktionary|wikimedia|wikibooks|wikisource)\.org/i.test(u) && qualityHost(url)) return 5;
  if (qualityHost(url)) return 6;
  if (/rfc[-/_]?\d{3,5}/i.test(u) || /\/wiki\//i.test(u)) return 7;
  return 8;
}

export function rankFrontierUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (skipHost(u) || junkFrontier(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  out.sort((a, b) => rankFrontier(a) - rankFrontier(b) || (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

export function catalogRegistry(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (REGISTRY_HOST.test(host)) return true;
  if (host !== "github.com") return false;
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path === "/whatwg" || path.startsWith("/whatwg/");
  } catch {
    return false;
  }
}

const TOPICAL_WET =
  /(?:wikipedia|wikidata|wiktionary|wikibooks|wikisource)\.org|arxiv\.org|pubmed|ncbi\.nlm|europepmc\.org|openalex\.org|semanticscholar\.org|doaj\.org|doi\.org/i;

/**
 * FineWeb meter is *slice* yield: kept / scanned on a WET window.
 * Catalog registries: length ≥ 80.
 * Wikipedia / arXiv / PubMed / OpenAlex: English Gopher-quality, any topic.
 * Other hosts still need a typed-fact signal so casino/spam English does not fill the slice.
 */
export function keepWet(rec: WetRecord): boolean {
  if (skipHost(rec.uri)) return false;
  if (rec.text.length < 80) return false;
  if (catalogRegistry(rec.uri)) return true;
  if (cheapSkip(rec.uri, rec.text)) return false;
  if (wetSpam(rec.text)) return false;
  if (gopherSkip(rec.text)) return false;
  if (!englishEnough(rec.text) || !englishTrigram(rec.text)) return false;
  if (TOPICAL_WET.test(rec.uri)) return true;
  if (pageTtl(rec.uri, rec.text).class === "news") return true;
  return wetFactBearing(rec.text);
}

function keepWetRanked(pool: WetRecord[], maxRecords: number): WetRecord[] {
  return pool
    .map((rec, i) => ({ rec, rk: rankFrontier(rec.uri), i }))
    .sort((a, b) => a.rk - b.rk || a.i - b.i)
    .slice(0, maxRecords)
    .map((x) => x.rec);
}

export function wetScanCap(maxRecords: number): number {
  return Math.max(2_000, maxRecords * WET_SCAN_MULT);
}

/** Header-only reject (warcio no_record_parse / FineWeb URLFilter). */
export function wetHeaderSkip(uri: string, seen?: (uri: string) => boolean, len?: number): boolean {
  if (len != null && len < 80) return true;
  if (headerSkipHost(uri)) return true;
  if (seen?.(uri)) return true;
  return false;
}

/** Range first prefix of a WET gzip. Inclusive end index. */
export function wetRangeHeader(bytes: number): string {
  const n = Math.max(1, bytes | 0);
  return `bytes=0-${n - 1}`;
}

/** Inflate a gzip WET prefix; truncated members are OK (`Z_SYNC_FLUSH`). Raw WARC bytes pass through. */
export function inflateWetPrefix(gzip: Uint8Array): Uint8Array {
  if (gzip.length < 2 || gzip[0] !== 0x1f || gzip[1] !== 0x8b) return gzip;
  try {
    return new Uint8Array(gunzipSync(gzip, { finishFlush: zconst.Z_SYNC_FLUSH }));
  } catch {
    try {
      return new Uint8Array(gunzipSync(gzip));
    } catch {
      return new Uint8Array(0);
    }
  }
}

export async function readCappedBody(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = body.getReader();
  try {
    while (n < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const take = n + value.length <= cap ? value : value.subarray(0, cap - n);
      chunks.push(take);
      n += take.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export type WetFetchMeter = {
  gzipFetchedBytes: number;
  rangePrefix: boolean;
  status: number;
};

let lastWetMeter: WetFetchMeter = { gzipFetchedBytes: 0, rangePrefix: false, status: 0 };

export function lastWetFetch(): WetFetchMeter {
  return lastWetMeter;
}

async function fetchWetGzip(wetUrl: string, budgetMs: number, byteCap: number): Promise<WetFetchMeter & { gzip: Uint8Array }> {
  let wait = 400;
  let lastErr = "wet fetch";
  const timeout = Math.max(5_000, budgetMs);
  const headersBase = { "User-Agent": EDENBOT, "Accept-Encoding": "identity" };
  const tryOnce = async (range: boolean) => {
    const headers = range
      ? { ...headersBase, Range: wetRangeHeader(byteCap) }
      : headersBase;
    return fetch(wetUrl, { headers, signal: AbortSignal.timeout(timeout) });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let r = await tryOnce(true);
      let rangePrefix = r.status === 206;
      if (r.status === 416) {
        r = await tryOnce(false);
        rangePrefix = false;
      }
      if (r.status === 200 || r.status === 206) {
        if (!r.body) throw new Error("no body");
        const gzip = await readCappedBody(r.body, byteCap);
        return { gzip, gzipFetchedBytes: gzip.byteLength, rangePrefix, status: r.status };
      }
      lastErr = `wet ${r.status}`;
      if (r.status !== 429 && r.status < 500) throw new Error(lastErr);
    } catch (e) {
      lastErr = String(e).slice(0, 80);
      if (/wet 4\d\d/.test(lastErr) && !/wet 416/.test(lastErr) && !/wet 429/.test(lastErr)) throw e;
    }
    if (attempt < 2) {
      await new Promise((res) => setTimeout(res, wait + Math.floor(Math.random() * wait)));
      wait = Math.min(wait * 2, 8_000);
    }
  }
  throw new Error(lastErr);
}

function keepFromChunk(
  chunk: WetRecord[],
  pool: WetRecord[],
  poolCap: number,
  bandHit: Set<string>,
  seen?: (uri: string) => boolean,
) {
  for (const rec of chunk) {
    if (pool.length >= poolCap) break;
    if (seen?.(rec.uri)) continue;
    if (!keepWet(rec)) continue;
    const bands = minhashBands(rec.text);
    if (bands.some((b) => bandHit.has(b))) continue;
    for (const b of bands) bandHit.add(b);
    pool.push(rec);
  }
}

/** Parse inflated WARC/WET bytes with the same keepWet + MinHash path as a live slice. */
export function ingestWetPlain(
  plain: Uint8Array,
  maxRecords: number,
  seen?: (uri: string) => boolean,
  scanLimit?: number,
): { recs: WetRecord[]; stats: ReturnType<typeof emptyWarcStats> } {
  const pipe = new BytePipe();
  const pool: WetRecord[] = [];
  const bandHit = new Set<string>();
  const stats = emptyWarcStats();
  const scanCap = scanLimit && scanLimit > 0 ? scanLimit : wetScanCap(maxRecords);
  const poolCap = Math.max(maxRecords * 4, Math.min(scanCap, maxRecords * 8));
  const skip = (uri: string, _type: string, len: number) => wetHeaderSkip(uri, seen, len);
  let off = 0;
  while (off < plain.length && stats.scanned < scanCap && pool.length < poolCap) {
    const n = Math.min(65_536, plain.length - off);
    pipe.append(plain.subarray(off, off + n));
    off += n;
    const chunk: WetRecord[] = [];
    pipe.setLeftover(pushWarcBytes(pipe.view(), chunk, scanCap - stats.scanned, skip, stats));
    keepFromChunk(chunk, pool, poolCap, bandHit, seen);
  }
  return { recs: keepWetRanked(pool, maxRecords), stats };
}

/** Gzip (or raw) WET window: inflate prefix, then the same scan-cap keep path. */
export function ingestWetGzip(
  gzip: Uint8Array,
  maxRecords: number,
  seen?: (uri: string) => boolean,
  scanLimit?: number,
): { recs: WetRecord[]; gzipFetchedBytes: number; stats: ReturnType<typeof emptyWarcStats> } {
  const plain = inflateWetPrefix(gzip);
  const got = ingestWetPlain(plain, maxRecords, seen, scanLimit);
  return { ...got, gzipFetchedBytes: gzip.byteLength };
}

export async function ingestWetSlice(
  wetUrl: string,
  maxRecords: number,
  seen?: (uri: string) => boolean,
  scanLimit?: number,
): Promise<WetRecord[]> {
  const t0 = Date.now();
  const budget = envNum("EDEN_KNOW_WET_MS", 45_000);
  const byteCap = wetByteCap();
  const fetched = await fetchWetGzip(wetUrl, budget, byteCap);
  lastWetMeter = {
    gzipFetchedBytes: fetched.gzipFetchedBytes,
    rangePrefix: fetched.rangePrefix,
    status: fetched.status,
  };
  const pipe = new BytePipe();
  const pool: WetRecord[] = [];
  const bandHit = new Set<string>();
  const stats = emptyWarcStats();
  const scanCap = scanLimit && scanLimit > 0 ? scanLimit : wetScanCap(maxRecords);
  const poolCap = Math.max(maxRecords * 4, Math.min(scanCap, maxRecords * 8));
  const skip = (uri: string, _type: string, len: number) => wetHeaderSkip(uri, seen, len);
  const plain = inflateWetPrefix(fetched.gzip);
  let off = 0;
  let lastYield = t0;
  while (off < plain.length && stats.scanned < scanCap && pool.length < poolCap) {
    if (Date.now() - t0 > budget) break;
    const n = Math.min(65_536, plain.length - off);
    pipe.append(plain.subarray(off, off + n));
    off += n;
    const chunk: WetRecord[] = [];
    pipe.setLeftover(pushWarcBytes(pipe.view(), chunk, scanCap - stats.scanned, skip, stats));
    keepFromChunk(chunk, pool, poolCap, bandHit, seen);
    const now = Date.now();
    if (now - lastYield >= 100) {
      await new Promise((r) => setTimeout(r, 0));
      lastYield = now;
    }
  }
  return keepWetRanked(pool, maxRecords);
}
