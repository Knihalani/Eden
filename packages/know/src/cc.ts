import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EDENBOT } from "./ua";
import { knowDir } from "./store";
import { qualityHost } from "./extract";
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

const QUALITY_URI = /rfc|ietf|nist|nasa|w3|python|nodejs/i;

function keepWet(rec: WetRecord): boolean {
  if (qualityHost(rec.uri) || QUALITY_URI.test(rec.uri)) return true;
  return /capital of /i.test(rec.text.slice(0, 400));
}

export async function ingestWetSlice(wetUrl: string, maxRecords: number): Promise<WetRecord[]> {
  const r = await fetch(wetUrl, { headers: { "User-Agent": EDENBOT } });
  if (!r.ok) throw new Error(`wet ${r.status}`);
  if (!r.body) throw new Error("no body");
  const ds = r.body.pipeThrough(new DecompressionStream("gzip"));
  const reader = ds.getReader();
  let buf = new Uint8Array(0);
  const raw: WetRecord[] = [];
  const records: WetRecord[] = [];
  const scanCap = Math.max(40, maxRecords * 8);
  while (raw.length < scanCap && records.length < maxRecords) {
    const { done, value } = await reader.read();
    if (value) {
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
    buf = pushWarcBytes(buf, raw, scanCap);
    records.length = 0;
    for (const rec of raw) if (keepWet(rec)) records.push(rec);
    if (done) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return records.slice(0, maxRecords);
}
