/** Recrawl class for a fetched page. Not a crawl budget. Host/path/source beat URL substrings. */

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

/** Named recrawl class. Wikipedia / catalogs never inherit a “news” substring. */
export function pageTtl(url: string, text = "", source = ""): { class: PageTtlClass; days: number } {
  const host = hostOf(url);
  const path = pathOf(url);
  const cls = (c: PageTtlClass) => ({ class: c, days: TTL_DAYS[c] });

  if (wikiHost(host)) return cls("wiki");
  if (academiaHost(host)) return cls("academia");
  if (registryHost(host)) {
    if (suffixHost(host, "w3.org") && newsPath(path)) return cls("news");
    return cls("registry");
  }
  if (docsHost(host)) return cls("docs");
  if (isNewsSource(source) || newsHost(host) || newsPath(path) || newsMarkup(text)) return cls("news");
  if (/^blog\.|(^|\.)blogs?\./i.test(host) || /\/blog\//i.test(path) || /\/post\//i.test(path)) return cls("blog");
  return cls("stable");
}

export function ttlDaysFor(url: string, text = "", source = ""): number {
  return pageTtl(url, text, source).days;
}

/** Skip / failed extract: retry soon, but news still uses the 1-day clock. */
export function ttlDaysOnSkip(url: string, text = "", source = ""): number {
  return Math.min(ttlDaysFor(url, text, source), 7);
}
