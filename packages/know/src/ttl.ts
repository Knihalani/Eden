/** Recrawl class. Host/path/source/headers/unchanged beat URL substrings. */

import { toolDocsUrl, talkUrl } from "./tools";

export type PageTtlClass = "news" | "blog" | "wiki" | "academia" | "registry" | "docs" | "stable";

export const TTL_DAYS: Record<PageTtlClass, number> = {
  news: 1,
  blog: 7,
  wiki: 90,
  academia: 180,
  registry: 365 * 5,
  docs: 90,
  stable: 365,
};

/** Class cap: backoff and heuristics never exceed this. */
export const TTL_CAP: Record<PageTtlClass, number> = {
  news: 7,
  blog: 30,
  wiki: 180,
  academia: 365,
  registry: 365 * 5,
  docs: 180,
  stable: 365 * 2,
};

export type TtlHints = {
  source?: string;
  status?: number;
  cacheControl?: string;
  lastModified?: string;
  unchanged?: boolean;
  prevTtl?: number;
  now?: number;
};

const NEWS_HOSTS = new Set([
  "reuters.com",
  "apnews.com",
  "ap.org",
  "bbc.com",
  "bbc.co.uk",
  "npr.org",
  "theguardian.com",
  "aljazeera.com",
  "dw.com",
  "cnn.com",
  "nbcnews.com",
  "cbsnews.com",
  "abcnews.go.com",
  "abc.net.au",
  "cbc.ca",
  "ctvnews.ca",
  "theglobeandmail.com",
  "politico.com",
  "axios.com",
  "thehill.com",
  "time.com",
  "newsweek.com",
  "usatoday.com",
  "latimes.com",
  "independent.co.uk",
  "voanews.com",
  "france24.com",
  "euronews.com",
  "thehindu.com",
  "japantimes.co.jp",
  "scmp.com",
  "smh.com.au",
]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function suffixHost(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

function registryHost(host: string): boolean {
  return (
    suffixHost(host, "rfc-editor.org") ||
    suffixHost(host, "iana.org") ||
    suffixHost(host, "ietf.org") ||
    suffixHost(host, "w3.org") ||
    suffixHost(host, "spdx.org") ||
    suffixHost(host, "unicode.org") ||
    suffixHost(host, "whatwg.org") ||
    suffixHost(host, "httpwg.org")
  );
}

function wikiHost(host: string): boolean {
  return (
    suffixHost(host, "wikipedia.org") ||
    suffixHost(host, "wikidata.org") ||
    suffixHost(host, "wiktionary.org") ||
    suffixHost(host, "wikibooks.org") ||
    suffixHost(host, "wikisource.org") ||
    suffixHost(host, "wikimedia.org")
  );
}

function academiaHost(host: string): boolean {
  return (
    suffixHost(host, "arxiv.org") ||
    suffixHost(host, "ncbi.nlm.nih.gov") ||
    suffixHost(host, "nih.gov") ||
    suffixHost(host, "openalex.org") ||
    suffixHost(host, "doi.org") ||
    suffixHost(host, "semanticscholar.org") ||
    suffixHost(host, "doaj.org") ||
    suffixHost(host, "europepmc.org") ||
    host === "pubmed.ncbi.nlm.nih.gov"
  );
}

function docsHost(host: string): boolean {
  const first = host.split(".")[0] || "";
  return first === "docs" || first === "developer" || first === "api";
}

function newsHost(host: string): boolean {
  if (NEWS_HOSTS.has(host)) return true;
  for (const root of NEWS_HOSTS) {
    if (host.endsWith(`.${root}`)) return true;
  }
  if (host.startsWith("news.") && !wikiHost(host)) return true;
  return false;
}

function newsPath(path: string): boolean {
  if (/^\/(?:news|world|politics|sports|business|markets|tech|technology|health|science|climate)(?:\/|$)/i.test(path)) {
    return true;
  }
  if (/\/news(?:-|\/|$)/i.test(path)) return true;
  if (/\/press(?:-release)?(?:\/|$)/i.test(path)) return true;
  if (/\/\d{4}\/\d{2}\/\d{2}(?:\/|$)/.test(path)) return true;
  return false;
}

function newsMarkup(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 8_000);
  if (/"@type"\s*:\s*"NewsArticle"/i.test(head)) return true;
  if (/property=["']og:type["'][^>]*content=["']article["']/i.test(head)) return true;
  if (/content=["']article["'][^>]*property=["']og:type["']/i.test(head)) return true;
  return false;
}

function isNewsSource(source: string): boolean {
  return /^(cc-news|news)$/i.test(source);
}

function hintsOf(x?: string | TtlHints): TtlHints {
  if (!x) return {};
  if (typeof x === "string") return { source: x };
  return x;
}

/** Named class only — no header/backoff yet. */
export function pageClass(url: string, text = "", source = ""): PageTtlClass {
  const host = hostOf(url);
  const path = pathOf(url);
  if (wikiHost(host)) return "wiki";
  if (talkUrl(url)) return "blog";
  if (academiaHost(host)) return "academia";
  if (registryHost(host)) {
    if (suffixHost(host, "w3.org") && newsPath(path)) return "news";
    return "registry";
  }
  if (docsHost(host)) return "docs";
  if (toolDocsUrl(url)) return "docs";
  if (isNewsSource(source) || newsHost(host) || newsPath(path) || newsMarkup(text)) return "news";
  if (/^blog\.|(^|\.)blogs?\./i.test(host) || /\/blog\//i.test(path) || /\/post\//i.test(path)) return "blog";
  return "stable";
}

function parseMaxAgeSec(cacheControl: string): number | undefined {
  const m = cacheControl.match(/(?:^|[,;\s])max-age\s*=\s*(\d+)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function lastModifiedAgeDays(lastModified: string, now: number): number | undefined {
  const t = Date.parse(lastModified);
  if (!Number.isFinite(t) || t <= 0 || t > now) return undefined;
  return (now - t) / 86_400_000;
}

function clampDays(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n) || n < lo) return lo;
  if (n > hi) return hi;
  return Math.round(n);
}

/**
 * Recrawl days. Class first, then RFC 9111 hints, then unchanged backoff.
 * Heuristics and max-age never drop news below 1 day or exceed TTL_CAP.
 */
export function pageTtl(url: string, text = "", sourceOrHints: string | TtlHints = ""): { class: PageTtlClass; days: number } {
  const h = hintsOf(sourceOrHints);
  const cls = pageClass(url, text, h.source || "");
  const floor = TTL_DAYS[cls];
  const cap = TTL_CAP[cls];
  let days = floor;
  const cc = (h.cacheControl || "").toLowerCase();
  if (/\bimmutable\b/.test(cc) && cls !== "news") days = cap;
  const maxAge = cc ? parseMaxAgeSec(cc) : undefined;
  if (maxAge != null && !/\bno-store\b/.test(cc)) {
    const fromAge = clampDays(maxAge / 86_400, floor, cap);
    days = Math.max(days, fromAge);
  }
  if (h.lastModified && !maxAge && !/\bno-store\b/.test(cc)) {
    const age = lastModifiedAgeDays(h.lastModified, h.now ?? Date.now());
    if (age != null && age >= 10 && cls !== "news") {
      const heuristic = clampDays(age * 0.1, floor, cap);
      days = Math.max(days, heuristic);
    }
  }
  const unchanged = h.unchanged || h.status === 304;
  if (unchanged) {
    const prev = h.prevTtl && h.prevTtl > 0 ? h.prevTtl : days;
    days = clampDays(Math.max(days, prev * 2), floor, cap);
  }
  return { class: cls, days };
}

export function ttlDaysFor(url: string, text = "", sourceOrHints: string | TtlHints = ""): number {
  return pageTtl(url, text, sourceOrHints).days;
}

/** Skip / failed extract: retry soon, but news stays on its clock (1, or backoff if unchanged). */
export function ttlDaysOnSkip(url: string, text = "", sourceOrHints: string | TtlHints = ""): number {
  const h = hintsOf(sourceOrHints);
  if (h.unchanged || h.status === 304) return ttlDaysFor(url, text, sourceOrHints);
  return Math.min(ttlDaysFor(url, text, sourceOrHints), 7);
}
