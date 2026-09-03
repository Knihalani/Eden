import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EDENBOT } from "./ua";
import { junkFrontier, knowDir } from "./store";
import { englishEnough, hostOf, qualityHost, skipHost } from "./extract";
import { cheapSkip, gopherSkip, wetFactBearing, wetSpam } from "./gate";
import { englishTrigram } from "./lang";
import { minhashBands } from "./minhash";
import { WET_SCAN_MULT } from "./defaults";
import { pushWarcBytes, type WetRecord } from "./warc";

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
  const line = lines[index % lines.length];
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
  const line = lines[lines.length - 1 - (index % lines.length)];
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
  if (/wikipedia\.org\/wiki\/list_of_[^/?#]*capital/i.test(u)) return 0;
  if (/wikipedia\.org\/wiki\/list_of_/i.test(u)) return 1;
  if (/rfc[-/_]?\d{3,5}/i.test(u) && (catalogRegistry(url) || qualityHost(url))) return 2;
  if (catalogRegistry(url)) return 3;
  if (/wikipedia\.org\/wiki\//i.test(u) && !WIKI_NS_SKIP.test(u)) return 4;
  if (/(?:wikidata|wiktionary|wikimedia)\.org/i.test(u) && qualityHost(url)) return 5;
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

/**
 * FineWeb meter is *slice* yield: kept / scanned on a WET window.
 * Catalog *registries* (IANA, RFC Editor, IETF, W3C, SPDX, Unicode, WHATWG): length ≥ 80.
 * Wikipedia / other qualityHost: same as non-catalog — junk/paywall/casino out, then
 * Gopher quality + English, then fact-bearing (capital-of, RFC, media type, SPDX, IANA,
 * ISO 3166) — not first-800 “capital of ” only.
 * MinHash 14×8 near-dup is applied per slice in ingestWetSlice, not here (no corpus).
 */
export function keepWet(rec: WetRecord): boolean {
  if (skipHost(rec.uri)) return false;
  if (rec.text.length < 80) return false;
  if (catalogRegistry(rec.uri)) return true;
  if (cheapSkip(rec.uri, rec.text)) return false;
  if (wetSpam(rec.text)) return false;
  if (gopherSkip(rec.text)) return false;
  if (qualityHost(rec.uri) && wetFactBearing(rec.text)) return true;
  if (!englishEnough(rec.text) || !englishTrigram(rec.text)) return false;
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

export async function ingestWetSlice(
  wetUrl: string,
  maxRecords: number,
  seen?: (uri: string) => boolean,
  scanLimit?: number,
): Promise<WetRecord[]> {
  const r = await fetch(wetUrl, { headers: { "User-Agent": EDENBOT } });
  if (!r.ok) throw new Error(`wet ${r.status}`);
  if (!r.body) throw new Error("no body");
  const ds = r.body.pipeThrough(new DecompressionStream("gzip"));
  const reader = ds.getReader();
  let buf = new Uint8Array(0);
  const pool: WetRecord[] = [];
  const bandHit = new Set<string>();
  let scanned = 0;
  const scanCap = scanLimit && scanLimit > 0 ? scanLimit : wetScanCap(maxRecords);
  const poolCap = Math.max(maxRecords * 4, Math.min(scanCap, maxRecords * 8));
  while (scanned < scanCap && pool.length < poolCap) {
    const { done, value } = await reader.read();
    if (value) {
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
    const chunk: WetRecord[] = [];
    buf = pushWarcBytes(buf, chunk, scanCap - scanned);
    for (const rec of chunk) {
      scanned++;
      if (scanned > scanCap || pool.length >= poolCap) break;
      if (seen?.(rec.uri)) continue;
      if (!keepWet(rec)) continue;
      const bands = minhashBands(rec.text);
      if (bands.some((b) => bandHit.has(b))) continue;
      for (const b of bands) bandHit.add(b);
      pool.push(rec);
    }
    if (done) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return keepWetRanked(pool, maxRecords);
}
