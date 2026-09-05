import { gunzipSync } from "node:zlib";
import { wetHeaderSkip } from "./cc";
import { EDENBOT } from "./ua";
import { pushWarcBytes, type WetRecord } from "./warc";
import { httpBody } from "./extract";
import { GITHUB_HOST_NEEDLES } from "./tools";

const IDX = "https://index.commoncrawl.org/";
const CC = "https://data.commoncrawl.org/";

export type CdxHit = { url: string; filename: string; offset: number; length: number };

export function parseCdxLine(line: string): CdxHit | undefined {
  try {
    const j = JSON.parse(line) as { url?: string; filename?: string; offset?: string | number; length?: string | number };
    if (!j.url || !j.filename) return undefined;
    return { url: j.url, filename: j.filename, offset: Number(j.offset), length: Number(j.length) };
  } catch {
    return undefined;
  }
}

function usableHit(h: CdxHit | undefined): h is CdxHit {
  return !!h && Number.isFinite(h.offset) && h.length > 0 && h.length < 2_000_000;
}

/** NDJSON, a JSON array, or mixed garbage — skip lines that do not parse. */
function parseCdxBody(text: string): CdxHit[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) {
        const out: CdxHit[] = [];
        for (const row of arr) {
          const h = parseCdxLine(JSON.stringify(row));
          if (usableHit(h)) out.push(h);
        }
        return out;
      }
    } catch {
      /* fall through to per-line */
    }
  }
  const out: CdxHit[] = [];
  for (const line of text.split("\n")) {
    const h = parseCdxLine(line);
    if (usableHit(h)) out.push(h);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** collinfo `cdx-api` is `${IDX}${id}-index` — same host as COLLINFO, no extra service. */
async function fetchCdxIndex(url: string): Promise<CdxHit[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": EDENBOT }, signal: AbortSignal.timeout(8_000) });
      if (r.ok) {
        const hits = parseCdxBody(await r.text());
        if (hits.length) return hits;
      }
    } catch {
      /* connection reset / timeout — empty index is also retried */
    }
    if (attempt < 2) await sleep(250 * 2 ** attempt);
  }
  return [];
}

/** collinfo `cdx-api` is often `${IDX}${id}-index`. Resolve once per crawl. */
const cdxApiByCrawl = new Map<string, string>();
/** Last CDX query suffix that returned hits for a host. */
const cdxVariantByHost = new Map<string, string>();

async function cdxApi(crawlId: string): Promise<string> {
  const hit = cdxApiByCrawl.get(crawlId);
  if (hit) return hit;
  let api = `${IDX}${crawlId}-index`;
  try {
    const r = await fetch(`${IDX}collinfo.json`, {
      headers: { "User-Agent": EDENBOT },
      signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) {
      const arr = (await r.json()) as { id?: string; "cdx-api"?: string }[];
      const row = Array.isArray(arr) ? arr.find((x) => x.id === crawlId) : undefined;
      const raw = row?.["cdx-api"]?.trim();
      if (raw) api = raw.replace(/\?.*$/, "");
    }
  } catch {
    /* fall back to conventional path */
  }
  cdxApiByCrawl.set(crawlId, api);
  return api;
}

export async function cdxHits(crawlId: string, host: string, limit = 4): Promise<CdxHit[]> {
  const base = await cdxApi(crawlId);
  const variants = [
    `url=${encodeURIComponent(host)}/*&output=json&limit=${limit}&filter=status:200`,
    `url=${encodeURIComponent(host)}/*&output=json&limit=${limit}&matchType=domain`,
    `url=${encodeURIComponent(host)}&output=json&limit=${limit}&matchType=host`,
    `url=${encodeURIComponent("https://" + host + "/")}&output=json&limit=${limit}&matchType=prefix`,
    `url=${encodeURIComponent(host)}/*&output=json&limit=${limit}&fl=url,filename,offset,length`,
  ];
  const cached = cdxVariantByHost.get(host);
  const ordered = cached ? [cached, ...variants.filter((v) => v !== cached)] : variants;
  for (const q of ordered) {
    const hits = await fetchCdxIndex(`${base}?${q}`);
    if (hits.length) {
      cdxVariantByHost.set(host, q);
      return hits;
    }
  }
  return [];
}

/** Range-get one gzip member from a CC WARC (CDX offset/length). */
export async function rangeWarc(hit: CdxHit): Promise<WetRecord | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${CC}${hit.filename}`, {
        headers: {
          "User-Agent": EDENBOT,
          Range: `bytes=${hit.offset}-${hit.offset + hit.length - 1}`,
          "Accept-Encoding": "identity",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok && r.status !== 206) {
        if (attempt < 2) await sleep(200 * 2 ** attempt);
        continue;
      }
      let buf = Buffer.from(await r.arrayBuffer());
      try {
        buf = gunzipSync(buf);
      } catch {
        /* already a WARC record */
      }
      const recs: WetRecord[] = [];
      pushWarcBytes(new Uint8Array(buf), recs, 1, (uri, _type, len) => wetHeaderSkip(uri, undefined, len));
      const rec = recs[0];
      if (rec) return { uri: rec.uri || hit.url, text: httpBody(rec.text) };
    } catch {
      if (attempt < 2) await sleep(200 * 2 ** attempt);
    }
  }
  return undefined;
}

export const CDX_HOSTS = [
  "reddit.com",
  "old.reddit.com",
  "stackoverflow.com",
  "unix.stackexchange.com",
  "superuser.com",
  "serverfault.com",
  "askubuntu.com",
  "news.ycombinator.com",
  "lobste.rs",
  "dev.to",
  "users.rust-lang.org",
  "discuss.python.org",
  "discourse.nixos.org",
  ...GITHUB_HOST_NEEDLES.filter((n) => n.startsWith("github.com")),
  "docs.python.org",
  "doc.rust-lang.org",
  "go.dev",
  "bun.sh",
  "kubernetes.io",
  "developer.mozilla.org",
  "git-scm.com",
  "docs.docker.com",
  "docs.github.com",
  "nodejs.org",
  "rfc-editor.org",
  "www.rfc-editor.org",
  "w3.org",
  "ietf.org",
  "tools.ietf.org",
  "arxiv.org",
  "export.arxiv.org",
];
