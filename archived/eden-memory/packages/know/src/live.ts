import { EDENBOT, UA_TOKEN } from "./ua";
import { robotsAllows, robotsCrawlDelaySec, robotsSitemaps, robotsTxtForHttpStatus, parseSitemap } from "./robots";
import {
  skipHost,
  canonicalUrl,
  wikiActionApiUrl,
  wikiActionApiBatchUrl,
  wikiRestSummaryUrl,
  wikiRevisionPages,
  foldLinkTags,
  httpLinkHrefs,
} from "./extract";
import { junkFrontier } from "./store";
import { createHash } from "node:crypto";

const robotsCache = new Map<string, { txt: string; at: number }>();
const lastHit = new Map<string, number>();
const etagCache = new Map<string, { etag?: string; lastMod?: string; html: string }>();
const ETAG_CACHE_MAX = 256;
const ETAG_BODY_MAX = 2_000_000;

function rememberEtag(url: string, etag: string | null, lastMod: string | null, html: string) {
  if (html.length > ETAG_BODY_MAX) return;
  if (!etag && !lastMod) return;
  if (etagCache.size >= ETAG_CACHE_MAX) {
    const first = etagCache.keys().next().value;
    if (first) etagCache.delete(first);
  }
  etagCache.set(url, { etag: etag || undefined, lastMod: lastMod || undefined, html });
}

export async function fetchRobots(origin: string): Promise<string> {
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.txt;
  try {
    const r = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": EDENBOT },
      signal: AbortSignal.timeout(8000),
    });
    const txt = r.ok ? await r.text() : robotsTxtForHttpStatus(r.status);
    robotsCache.set(origin, { txt, at: Date.now() });
    return txt;
  } catch {
    robotsCache.set(origin, { txt: robotsTxtForHttpStatus(503), at: Date.now() });
    return robotsTxtForHttpStatus(503);
  }
}

async function prepareLive(
  url: string,
  opts?: { timeoutMs?: number; accept?: string },
): Promise<
  | { ok: true; parsed: URL; headers: Record<string, string>; timeoutMs: number }
  | { ok: false; status: number; html: string; skip: string; chars: number; digest: string }
> {
  const blocked = skipHost(url);
  const empty = { ok: false as const, status: 0, html: "", chars: 0, digest: "" };
  if (blocked) return { ...empty, skip: blocked };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...empty, skip: "bad-url" };
  }
  const robots = await fetchRobots(parsed.origin);
  if (robots && !robotsAllows(robots, UA_TOKEN, parsed.pathname || "/")) {
    if (!wikiReadAllowed(url)) return { ...empty, skip: "robots" };
  }
  const delay = robotsCrawlDelaySec(robots, UA_TOKEN) ?? 0;
  const last = lastHit.get(parsed.host) ?? 0;
  const minGap = Math.max(delay * 1000, 20);
  const wait = minGap - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
  lastHit.set(parsed.host, Date.now());
  return {
    ok: true,
    parsed,
    headers: {
      "User-Agent": EDENBOT,
      Accept: opts?.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
      "Accept-Encoding": "gzip, deflate, br",
    },
    timeoutMs: opts?.timeoutMs ?? 12_000,
  };
}

export async function liveGetStream(
  url: string,
  opts?: { timeoutMs?: number; accept?: string; onChunk?: (s: string) => void },
): Promise<{
  ok: boolean;
  status: number;
  html: string;
  chars: number;
  digest: string;
  skip?: string;
  links: string[];
}> {
  const pre = await prepareLive(url, opts);
  if (!pre.ok) return { ...pre, links: [] };
  const cached = etagCache.get(url);
  const headers = { ...pre.headers };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastMod) headers["If-Modified-Since"] = cached.lastMod;
  try {
    const r = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(pre.timeoutMs),
      redirect: "follow",
    });
    const linkHdr = `Link: ${r.headers.get("link") || ""}`;
    const links = [...new Set([...httpLinkHrefs(linkHdr), ...httpLinkHrefs(linkHdr, "next")])].slice(0, 16);
    if (r.status === 304) {
      return {
        ok: true,
        status: 304,
        html: "",
        chars: 0,
        digest: cached?.etag?.slice(0, 16) || "",
        skip: "not-modified",
        links,
      };
    }
    if (!r.ok) return { ok: false, status: r.status, html: "", chars: 0, digest: "", skip: `http-${r.status}`, links };
    const h = createHash("sha256");
    let chars = 0;
    const onChunk = opts?.onChunk;
    const reader = r.body?.getReader();
    if (!reader) {
      const html = await r.text();
      h.update(html);
      onChunk?.(html);
      rememberEtag(url, r.headers.get("etag"), r.headers.get("last-modified"), html.slice(0, ETAG_BODY_MAX));
      return { ok: true, status: r.status, html: "", chars: html.length, digest: h.digest("hex").slice(0, 16), links };
    }
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      if (!s) continue;
      h.update(s);
      chars += s.length;
      onChunk?.(s);
    }
    const tail = dec.decode();
    if (tail) {
      h.update(tail);
      chars += tail.length;
      onChunk?.(tail);
    }
    rememberEtag(url, r.headers.get("etag"), r.headers.get("last-modified"), "");
    return { ok: true, status: r.status, html: "", chars, digest: h.digest("hex").slice(0, 16), links };
  } catch (e) {
    return { ok: false, status: 0, html: "", chars: 0, digest: "", skip: String(e).slice(0, 80), links: [] };
  }
}

export async function liveGet(
  url: string,
  opts?: { timeoutMs?: number; accept?: string; ifModifiedSinceMs?: number },
): Promise<{
  ok: boolean;
  status: number;
  html: string;
  skip?: string;
  cacheControl?: string;
  lastModified?: string;
}> {
  const pre = await prepareLive(url, opts);
  if (!pre.ok) return { ok: false, status: pre.status, html: "", skip: pre.skip };
  const cached = etagCache.get(url);
  const headers = { ...pre.headers };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastMod) headers["If-Modified-Since"] = cached.lastMod;
  else if (opts?.ifModifiedSinceMs && opts.ifModifiedSinceMs > 1e12) {
    headers["If-Modified-Since"] = new Date(opts.ifModifiedSinceMs).toUTCString();
  }
  try {
    const r = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(pre.timeoutMs),
      redirect: "follow",
    });
    const cacheControl = r.headers.get("cache-control") || undefined;
    const lastModified = r.headers.get("last-modified") || undefined;
    if (r.status === 304) {
      return { ok: true, status: 304, html: cached?.html || "", cacheControl, lastModified };
    }
    const html = foldLinkTags(httpLinkHrefs(`Link: ${r.headers.get("link") || ""}`), await r.text());
    if (!r.ok) return { ok: false, status: r.status, html: "", skip: `http-${r.status}`, cacheControl, lastModified };
    rememberEtag(url, r.headers.get("etag"), r.headers.get("last-modified"), html);
    return { ok: true, status: r.status, html, cacheControl, lastModified };
  } catch (e) {
    return { ok: false, status: 0, html: "", skip: String(e).slice(0, 80) };
  }
}

export async function sitemapFrontier(origin: string): Promise<string[]> {
  const robots = await fetchRobots(origin);
  const maps = robotsSitemaps(robots).slice(0, 8);
  const pages: { loc: string; lastmod?: string }[] = [];
  const children: string[] = [];
  const mapBodies = await Promise.all(maps.map((sm) => liveGet(sm)));
  for (const got of mapBodies) {
    if (!got.ok) continue;
    const p = parseSitemap(got.html, 500);
    if (p.kind === "index") children.push(...p.children.slice(0, 8));
    else pages.push(...p.urls);
  }
  const childBodies = await Promise.all(children.slice(0, 8).map((sm) => liveGet(sm)));
  for (const got of childBodies) {
    if (!got.ok) continue;
    pages.push(...parseSitemap(got.html, 500).urls);
  }
  pages.sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || ""));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const u = canonicalUrl(p.loc);
    if (seen.has(u) || skipHost(u) || junkFrontier(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * Wikipedia /wiki/ articles plus read-only Action/REST endpoints.
 * `Disallow: /w/` must not swallow `/wiki/` (character-prefix collision).
 */
export function wikiReadAllowed(url: string): boolean {
  if (skipHost(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/(^|\.)wikipedia\.org$/i.test(parsed.hostname)) return false;
  const p = parsed.pathname || "/";
  if (/^\/wiki\//i.test(p)) return !/\/wiki\/(?:Special|File|Spezial|Spesial):/i.test(p);
  if (/^\/w\/api\.php$/i.test(p)) {
    const a = (parsed.searchParams.get("action") || "").toLowerCase();
    return a === "query" || a === "parse";
  }
  if (/^\/api\/rest_v1\/page\/summary\//i.test(p)) return true;
  return false;
}

/** Action API section-0, then REST summary. Fail-open. Never hits skipHost hosts. */
export async function liveWikiApi(articleUrl: string): Promise<string> {
  if (skipHost(articleUrl) || (!wikiActionApiUrl(articleUrl) && !wikiRestSummaryUrl(articleUrl))) return "";
  try {
    const action = wikiActionApiUrl(articleUrl);
    if (action) {
      const got = await liveGet(action, { accept: "application/json", timeoutMs: 12_000 });
      if (got.ok && got.html) return got.html;
    }
    const rest = wikiRestSummaryUrl(articleUrl);
    if (rest) {
      const got = await liveGet(rest, { accept: "application/json", timeoutMs: 12_000 });
      if (got.ok && got.html) return got.html;
    }
  } catch {
    /* fail-open */
  }
  return "";
}

/** One Action API round-trip for up to 50 Wikipedia articles. Fail-open. */
export async function liveWikiApiBatch(
  articleUrls: string[],
): Promise<{ url: string; title: string; wikitext: string }[]> {
  const api = wikiActionApiBatchUrl(articleUrls);
  if (!api) return [];
  try {
    const got = await liveGet(api, { accept: "application/json", timeoutMs: 20_000 });
    if (!got.ok || !got.html) return [];
    const pages = wikiRevisionPages(JSON.parse(got.html) as unknown);
    const byTitle = new Map(pages.map((p) => [p.title.toLowerCase(), p]));
    const out: { url: string; title: string; wikitext: string }[] = [];
    for (const url of articleUrls) {
      let title = "";
      try {
        title = decodeURIComponent(new URL(url).pathname.replace(/^\/wiki\//i, "").replace(/_/g, " "));
      } catch {
        continue;
      }
      const hit = byTitle.get(title.toLowerCase());
      if (hit) out.push({ url, title: hit.title, wikitext: hit.wikitext });
    }
    return out;
  } catch {
    return [];
  }
}

/** Random English Wikipedia main-namespace pages with section-0 wikitext. Fail-open. */
export async function liveWikiRandomBatch(n: number): Promise<{ url: string; title: string; wikitext: string }[]> {
  const take = Math.max(1, Math.min(50, n | 0));
  const api =
    `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2` +
    `&generator=random&grnnamespace=0&grnlimit=${take}` +
    `&prop=revisions&rvprop=content&rvslots=main&rvsection=0`;
  try {
    const got = await liveGet(api, { accept: "application/json", timeoutMs: 20_000 });
    if (!got.ok || !got.html) return [];
    const pages = wikiRevisionPages(JSON.parse(got.html) as unknown);
    return pages.map((p) => ({
      url: `https://en.wikipedia.org/wiki/${p.title.replace(/ /g, "_")}`,
      title: p.title,
      wikitext: p.wikitext,
    }));
  } catch {
    return [];
  }
}
