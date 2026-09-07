/** HTML → text + structured slots. No Playwright: JSON-LD / OG / noscript live in the first bytes. */

import {
  MEDIA_SUBTYPE_OBJECT,
  SPDX_KEEP,
} from "./names";
import { mediaTypeNames } from "./media-type-tab";
import { adaptCapitalLabel, noteCapitalLabel } from "./adapt";
import { TOOL_DOC_HOSTS, githubToolUrl, talkUrl, toolDocsUrl } from "./tools";

const MEDIA_TAB = new Set(mediaTypeNames());

const PAYWALL_HOST =
  /(^|\.)(wsj|ft|economist|nytimes|washingtonpost|bloomberg|wired|theathletic)\.com$/i;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function skipHost(url: string): string | undefined {
  const h = hostOf(url);
  if (!h) return "bad-url";
  if (PAYWALL_HOST.test(h)) return "paywall-host";
  return undefined;
}

/** Wikipedia / Wikidata / PubMed-style catalogs. Not how-to talk the model would look up. */
export function encyclopediaUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (
    host === "wikipedia.org" ||
    host.endsWith(".wikipedia.org") ||
    host === "wikidata.org" ||
    host.endsWith(".wikidata.org") ||
    host.endsWith(".wiktionary.org") ||
    host.endsWith(".wikibooks.org") ||
    host.endsWith(".wikisource.org") ||
    host.endsWith(".wikimedia.org")
  )
    return true;
  if (
    host === "ncbi.nlm.nih.gov" ||
    host.endsWith(".ncbi.nlm.nih.gov") ||
    host === "europepmc.org" ||
    host.endsWith(".europepmc.org") ||
    host === "openalex.org" ||
    host.endsWith(".openalex.org") ||
    host === "semanticscholar.org" ||
    host.endsWith(".semanticscholar.org") ||
    host === "doaj.org"
  )
    return true;
  return false;
}

/** Decode named + numeric HTML entities. Cards must never ship `&#x2F;`. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&sol;/gi, "/")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _;
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _;
    })
    .replace(/&amp;/gi, "&");
}

function junkName(s: string): boolean {
  if (/^\[\s*\d+\s*\]$/.test(s) || /^\[/.test(s)) return true;
  if (/^\.mw-/.test(s) || /\.mw-parser-output/.test(s)) return true;
  return false;
}

/** Drop leftover entity junk so hostile HTML never ships `&#x2F;` in objects. */
function cleanTriple(t: Triple): Triple | undefined {
  const s = decodeEntities(t.s).replace(/\s+/g, " ").trim().normalize("NFC");
  const o = decodeEntities(t.o).replace(/\s+/g, " ").trim().normalize("NFC");
  const e = decodeEntities(t.e).replace(/\s+/g, " ").trim().normalize("NFC");
  if (!s || !o || /&#/.test(s) || /&#/.test(o) || /&#/.test(e)) return undefined;
  if (junkName(s) || junkName(o)) return undefined;
  return s === t.s && o === t.o && e === t.e ? t : { s, p: t.p, o, e };
}

/** Stable frontier key: host lowercased, hash dropped, tracking query stripped. Does not upgrade http. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return raw;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "oldid"];
    for (const k of drop) u.searchParams.delete(k);
    if (/wikipedia\.org$/i.test(u.hostname) && /^\/wiki\//i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/wiki\/([^/]+)$/i, (_, t) => `/wiki/${decodeURIComponent(t).replace(/ /g, "_")}`);
    }
    return u.href;
  } catch {
    return raw;
  }
}

/** `Link:` rel=alternate targets (RFC 8288). WARC heads and live response headers. */
export function httpLinkHrefs(headers: string, rel = "alternate"): string[] {
  const want = rel.toLowerCase();
  const out: string[] = [];
  for (const line of headers.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^link\s*:/i.test(trimmed)) continue;
    const v = trimmed.slice(trimmed.indexOf(":") + 1);
    for (const part of v.split(/,(?=\s*<)/)) {
      const href = part.match(/<([^>]+)>/)?.[1]?.trim();
      const r = part.match(/\brel\s*=\s*["']?([^"';,\s]+)/i)?.[1]?.toLowerCase();
      if (href && r === want) out.push(href);
    }
  }
  return out;
}

export function foldLinkTags(hrefs: string[], html: string): string {
  const tags = hrefs
    .filter((u) => /^(https?:\/\/|\/)/i.test(u))
    .slice(0, 16)
    .map((u) => `<link rel="alternate" href="${u.replace(/"/g, "")}">`)
    .join("");
  return tags ? tags + html : html;
}

/** Strip an HTTP/1.x status block from a WARC response payload. Keep Link alternates. */
export function httpBody(raw: string): string {
  if (!/^HTTP\/\d/i.test(raw)) return raw;
  const i = raw.search(/\r?\n\r?\n/);
  if (i < 0) return raw;
  const body = raw.slice(i).replace(/^\r?\n\r?\n/, "");
  return foldLinkTags(httpLinkHrefs(raw.slice(0, i)), body);
}

function tagNameAt(html: string, lt: number): string {
  let i = lt + 1;
  if (i < html.length && html.charCodeAt(i) === 47) i++;
  const start = i;
  while (i < html.length) {
    const c = html.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 62 || c === 47) break;
    i++;
  }
  return html.slice(start, i).toLowerCase();
}

/** Tag closer that does not treat `>` inside quoted attrs as the end. Parsoid `data-mw` embeds HTML. */
function tagCloseGt(html: string, lt: number): number {
  let i = lt + 1;
  let q = 0;
  const n = html.length;
  while (i < n) {
    const c = html.charCodeAt(i);
    if (q) {
      if (c === q) q = 0;
    } else if (c === 34 || c === 39) {
      q = c;
    } else if (c === 62) {
      return i;
    }
    i++;
  }
  return -1;
}

function closeTagFrom(html: string, from: number, close: string): number {
  let i = html.indexOf(close, from);
  if (i < 0) {
    const n = close.length;
    const last = html.length - n;
    outer: for (i = from; i <= last; i++) {
      for (let j = 0; j < n; j++) {
        if ((html.charCodeAt(i + j) | 32) !== (close.charCodeAt(j) | 32)) continue outer;
      }
      break;
    }
    if (i > last) return html.length;
  }
  const lt = html.charCodeAt(i) === 60 ? i : html.lastIndexOf("<", i);
  const gt = lt >= 0 ? tagCloseGt(html, lt) : html.indexOf(">", i + close.length - 1);
  return gt < 0 ? html.length : gt + 1;
}

const BLOCK_PUNCT = new Set([
  "p",
  "div",
  "tr",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "br",
  "dd",
  "dt",
  "section",
  "article",
  "header",
  "blockquote",
  "hr",
  "ul",
  "ol",
  "thead",
  "tbody",
  "caption",
  "td",
  "th",
]);

export type HtmlScan = {
  text: string;
  jsonLd: unknown[];
  tables: { open: string; inner: string }[];
  dls: string[];
  metas: Record<string, string>;
  og: Record<string, string>;
  title: string;
  h1: string[];
  spanH1: string[];
  canonical: string;
  displaytitle: string;
  mwTitle: string;
  itemSlices: string[];
  shortDescription: string;
};

const ATTR_RE = new Map<string, RegExp>();

function attrGet(open: string, name: string): string {
  let re = ATTR_RE.get(name);
  if (!re) {
    re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    ATTR_RE.set(name, re);
  }
  const m = open.match(re);
  return decodeEntities((m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim());
}

/** One HTML walk: text + JSON-LD + tables + dl + meta + microdata/RDFa slices. */
export function scanHtml(html: string, textOnly = false): HtmlScan {
  const parts: string[] = [];
  const jsonLd: unknown[] = [];
  const tables: { open: string; inner: string }[] = [];
  const dls: string[] = [];
  const metas: Record<string, string> = {};
  const og: Record<string, string> = {};
  const h1: string[] = [];
  const spanH1: string[] = [];
  const itemSlices: string[] = [];
  let title = "";
  let canonical = "";
  let displaytitle = "";
  let mwTitle = "";
  let shortDescription = "";
  let tableDepth = 0;
  let tableOpen = "";
  let tableStart = 0;
  let dlDepth = 0;
  let dlStart = 0;
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { parts.push(html.slice(i)); break; }
    if (lt > i) parts.push(html.slice(i, lt));
    if (html.charCodeAt(lt + 1) === 33 && html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      parts.push(" ");
      continue;
    }
    const gt = tagCloseGt(html, lt);
    if (gt < 0) break;
    const name = tagNameAt(html, lt);
    const open = html.slice(lt, Math.min(gt + 1, lt + 280));
    const isClose = html.charCodeAt(lt + 1) === 47;

    if (!isClose && (name === "script" || name === "style")) {
      const isLd = !textOnly && name === "script" && open.includes("ld+json");
      const end = closeTagFrom(html, gt + 1, `</${name}>`);
      if (isLd) { const parsed = parseLdJson(html.slice(gt + 1, Math.max(gt + 1, end - 9))); if (parsed !== undefined) jsonLd.push(parsed); }
      i = end;
      parts.push(" ");
      continue;
    }
    if (!isClose && (name === "nav" || name === "footer" || name === "noscript")) {
      i = closeTagFrom(html, gt + 1, `</${name}>`);
      parts.push(" ");
      continue;
    }
    if (!isClose && (open.includes("mw-navigation") || open.includes('role="navigation"') || open.includes("role='navigation'") || (open.includes("class=") && /class=["'][^"']*\b(?:references|navbox|mw-jump-link|vector-menu)\b/i.test(open)))) {
      i = closeTagFrom(html, gt + 1, `</${name}>`);
      parts.push(" ");
      continue;
    }

    if (!textOnly && name === "table") {
      if (!isClose) {
        if (tableDepth === 0) {
          tableOpen = open;
          tableStart = gt + 1;
        }
        tableDepth++;
      } else if (tableDepth > 0) {
        tableDepth--;
        if (tableDepth === 0) tables.push({ open: tableOpen, inner: html.slice(tableStart, lt) });
      }
    }
    if (!textOnly && name === "dl") {
      if (!isClose) {
        if (dlDepth === 0) dlStart = gt + 1;
        dlDepth++;
      } else if (dlDepth > 0) {
        dlDepth--;
        if (dlDepth === 0) dls.push(html.slice(dlStart, lt));
      }
    }
    if (!textOnly && !isClose && name === "meta") {
      const key = (attrGet(open, "name") || attrGet(open, "property")).toLowerCase();
      const val = attrGet(open, "content");
      if (key && val && metas[key] === undefined) metas[key] = val;
      if (key.startsWith("og:") && val) og[key.slice(3)] = val;
      if (key === "mw:pageprop/displaytitle" && val) displaytitle = val;
    }
    if (!textOnly && !isClose && name === "link") {
      const rel = attrGet(open, "rel").toLowerCase();
      const href = attrGet(open, "href");
      if (rel.includes("canonical") && href) canonical = href;
    }
    if (!isClose && name === "title" && !title) {
      const end = closeTagFrom(html, gt + 1, "</title>");
      title = decodeEntities(html.slice(gt + 1, Math.max(gt + 1, end - 8)).replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      i = end;
      parts.push(" ");
      continue;
    }
    if (!textOnly && !isClose && name === "h1") {
      const end = closeTagFrom(html, gt + 1, "</h1>");
      h1.push(html.slice(gt + 1, Math.max(gt + 1, end - 5)));
    }
    if (!textOnly && !isClose && name === "span" && /\bh1\b/.test(open) && open.includes("class=")) {
      const end = closeTagFrom(html, gt + 1, "</span>");
      spanH1.push(html.slice(gt + 1, Math.max(gt + 1, end - 7)));
    }
    if (!textOnly && !isClose && !shortDescription && (name === "div" || name === "span") && open.includes("shortdescription")) {
      const end = closeTagFrom(html, gt + 1, `</${name}>`);
      const t = decodeEntities(html.slice(gt + 1, Math.max(gt + 1, end - name.length - 3)).replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      if (t.length >= 4 && t.length <= 80) shortDescription = t;
    }
    if (!textOnly && !isClose && name === "span" && open.includes("mw-page-title-main")) {
      const end = closeTagFrom(html, gt + 1, "</span>");
      const t = decodeEntities(html.slice(gt + 1, Math.max(gt + 1, end - 7)).replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
      if (t) mwTitle = t;
    }
    if (!textOnly && !isClose && (open.includes("itemscope") || open.includes("itemtype") || /typeof\s*=\s*["'][^"']*Country/i.test(open))) {
      itemSlices.push(html.slice(lt, Math.min(n, lt + 4000)));
    }

    i = gt + 1;
    parts.push(BLOCK_PUNCT.has(name) ? ". " : " ");
  }
  return {
    text: decodeEntities(parts.join(""))
      .replace(/\s+/g, " ")
      .replace(/(?:\s*\.){2,}/g, ".")
      .replace(/\s+\./g, ".")
      .trim(),
    jsonLd,
    tables,
    dls,
    metas,
    og,
    title,
    h1,
    spanH1,
    canonical,
    displaytitle,
    mwTitle,
    itemSlices,
    shortDescription,
  };
}

/** Tag-scan, not nested `[\s\S]*?` — µs/KB on wiki list pages. */
export function htmlToText(html: string): string {
  return scanHtml(html, true).text;
}

function parseLdJson(raw: string): unknown | undefined {
  let s = decodeEntities(raw)
    .replace(/^\s*<!\[CDATA\[/i, "")
    .replace(/\]\]>\s*$/i, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (!s) return undefined;
  for (const candidate of [s, s.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  let from = 0;
  const n = html.length;
  while (from < n) {
    const mark = html.indexOf("ld+json", from);
    if (mark < 0) break;
    const lt = html.lastIndexOf("<script", mark);
    if (lt < 0 || lt < from) {
      from = mark + 7;
      continue;
    }
    const gt = html.indexOf(">", mark);
    if (gt < 0) break;
    const open = html.slice(lt, gt + 1);
    if (!/type\s*=\s*["']application\/ld\+json/i.test(open)) {
      from = mark + 7;
      continue;
    }
    const end = closeTagFrom(html, gt + 1, "</script>");
    const raw = html.slice(gt + 1, Math.max(gt + 1, end - 9));
    const parsed = parseLdJson(raw);
    if (parsed !== undefined) out.push(parsed);
    from = end;
  }
  return out;
}

export function openGraph(html: string): Record<string, string> {
  const og: Record<string, string> = {};
  const re = /<meta[^>]+(?:property|name)=["']og:([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) og[m[1]!.toLowerCase()] = m[2]!;
  const re2 = /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']og:([^"']+)["'][^>]*>/gi;
  while ((m = re2.exec(html))) og[m[2]!.toLowerCase()] = m[1]!;
  return og;
}

/** DC.Title / citation_title / displaytitle — both attribute orders. */
export function namedMeta(html: string, names: string[]): Record<string, string> {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out: Record<string, string> = {};
  const re = /<meta\b([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1]!;
    const key = tag.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
    const val = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!key || val == null) continue;
    const k = key.toLowerCase();
    if (want.has(k) && out[k] === undefined) out[k] = decodeEntities(val);
  }
  return out;
}

export function htmlAlternateHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /<link\b([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1]!;
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    if (!/\balternate\b/i.test(rel)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href && !/action=edit|application\/x-wiki/i.test(tag)) out.push(href);
  }
  return out;
}

export function opinionTrash(text: string): boolean {
  const t = text.toLowerCase();
  const rant = /sheeple|worst ever|wake up|donate now|only true path|be saved|cannot believe/.test(t);
  const hasFact = /capital of|m\/s|rfc |etag|voted \d|shipped |released |perihelion|\d{4}/.test(t);
  return rant && !hasFact;
}

export function englishEnough(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  return letters >= 40 && letters / Math.max(text.length, 1) > 0.35;
}

export type Triple = { s: string; p: string; o: string; e: string };

/** Predicates that occupy the hot graph. Everything else is extract-only noise. */
export const HOT_PRED = new Set(["capital", "is", "id", "version", "obsoletes", "updates"]);

/** Catalog / standards hosts: fetched first. Not an ingest allowlist. */
export const CATALOG_URL_NEEDLES = [
  "rfc-editor.org",
  "ietf.org",
  "w3.org",
  "nist.gov",
  "nasa.gov",
  "python.org",
  "nodejs.org",
  "httpwg.org",
  "commoncrawl.org",
  "govinfo.gov",
  "iana.org",
  "spdx.org",
  "unicode.org",
  "whatwg.org",
  "github.com/whatwg",
  ...TOOL_DOC_HOSTS,
  "wikipedia.org",
  "wikidata.org",
  "query.wikidata.org",
  "wiktionary.org",
  "wikimedia.org",
  "arxiv.org",
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "europepmc.org",
  "openalex.org",
  "semanticscholar.org",
  "doi.org",
  "doaj.org",
] as const;

export function qualityUrlSql(col = "url"): string {
  const parts = CATALOG_URL_NEEDLES.map((n) => {
    const needle = n.toLowerCase().replace(/'/g, "");
    const slash = needle.indexOf("/");
    const host = slash >= 0 ? needle.slice(0, slash) : needle;
    const path = slash >= 0 ? needle.slice(slash) : "";
    const hostMatch = `(${col} = 'https://${host}' OR ${col} = 'http://${host}' OR ${col} LIKE 'https://${host}/%' OR ${col} LIKE 'http://${host}/%' OR ${col} LIKE 'https://${host}?%' OR ${col} LIKE 'http://${host}?%' OR ${col} LIKE 'https://%.${host}' OR ${col} LIKE 'http://%.${host}' OR ${col} LIKE 'https://%.${host}/%' OR ${col} LIKE 'http://%.${host}/%' OR ${col} LIKE 'https://%.${host}?%' OR ${col} LIKE 'http://%.${host}?%')`;
    if (!path) return hostMatch;
    return `(${hostMatch} AND (${col} LIKE '%${path}' OR ${col} LIKE '%${path}/%' OR ${col} LIKE '%${path}?%'))`;
  });
  return `(${parts.join(" OR ")})`;
}

/**
 * Surface facts LLMs already know and that do not change agent action:
 * capitals, IANA/RFC/SPDX titles, “X is a runtime”, country ISO.
 * Techniques (`used for`) and RFC obsoletes/updates still occupy the graph.
 */
export function frozenEncyclopedia(t: { s: string; p: string; o: string; e?: string }): boolean {
  if (t.p === "capital") return true;
  if (t.p === "obsoletes" || t.p === "updates") return false;
  if (t.p === "version") return false;
  if (t.p === "id") {
    const o = t.o.trim();
    if (/^[A-Z]{2}$/.test(o)) return true;
    if (/^\+\d{1,4}$/.test(o) || /^\.[A-Za-z]{2,8}$/.test(o)) return true;
    if (/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(o)) return true;
    if (/\b(ISO 3166|calling code|population | area |geo )/i.test(t.e || "")) return true;
    return false;
  }
  if (t.p !== "is") return false;
  if (/^used for /i.test(t.o)) return false;
  if (/^(obsoleted|updated) by\b/i.test(t.o)) return false;
  return true;
}

/** Catalog origin: hostname (or subdomain) of a needle, not a URI substring. `github.com/whatwg` also checks path. */
export function qualityHost(url: string): boolean {
  if (githubToolUrl(url) || talkUrl(url)) return true;
  const host = hostOf(url);
  if (!host) return false;
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  for (const n of CATALOG_URL_NEEDLES) {
    const needle = n.toLowerCase();
    const slash = needle.indexOf("/");
    const catalogHost = slash >= 0 ? needle.slice(0, slash) : needle;
    if (host !== catalogHost && !host.endsWith(`.${catalogHost}`)) continue;
    if (slash < 0) return true;
    const prefix = needle.slice(slash);
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** What occupies the on-disk graph. Frozen encyclopedia stays out. */
export function persistable(url: string, t: Triple): boolean {
  if (junkGraphFact(t) || frozenEncyclopedia(t)) return false;
  if (!HOT_PRED.has(t.p) || looksLikeCode(`${t.o} ${t.e}`)) return false;
  if (t.p === "is") {
    return t.s.length >= 2 && t.s.length <= 96 && t.o.length >= 8 && t.o.length <= 72 && t.s.toLowerCase() !== t.o.toLowerCase();
  }
  if (t.p === "obsoletes" && /^RFC\s+\d/i.test(t.s) && /RFC\s+\d/i.test(t.o)) return true;
  if (t.p === "updates" && /^RFC\s+\d/i.test(t.s) && /RFC\s+\d/i.test(t.o)) return true;
  if ((t.p === "id" || t.p === "version") && qualityHost(url) && t.o.length <= 48) return true;
  return false;
}

/** JSON-LD name / @value / language map / wiki @id. Never `[object Object]`. */
export function ldText(v: unknown, depth = 0): string {
  if (v == null || depth > 5) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).replace(/\s+/g, " ").trim();
  if (typeof v === "boolean") return "";
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = ldText(x, depth + 1);
      if (t) return t;
    }
    return "";
  }
  if (typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  if (o["@value"] != null) return ldText(o["@value"], depth + 1);
  if (typeof o.en === "string") return o.en.replace(/\s+/g, " ").trim();
  if (typeof o["en-US"] === "string") return String(o["en-US"]).replace(/\s+/g, " ").trim();
  if (o.name != null) {
    const n = ldText(o.name, depth + 1);
    if (n) return n;
  }
  if (typeof o.headline === "string") return o.headline.replace(/\s+/g, " ").trim();
  if (typeof o["@id"] === "string") {
    const id = o["@id"];
    const wiki = wikiPageName(id);
    if (wiki && !wikiNsSkip(wiki) && !/^Q\d+$/i.test(wiki)) return wiki;
    if (/\/entity\/Q\d+/i.test(id) || /^Q\d+$/i.test(id) || /^https?:/i.test(id)) return "";
  }
  return "";
}

function ldTypes(o: Record<string, unknown>): string {
  const t = o["@type"] ?? o.type;
  if (Array.isArray(t)) return t.map((x) => String(x)).join(" ");
  return String(t ?? "");
}

function walkLd(node: unknown, into: Triple[], evidence: string, depth = 0): void {
  if (!node || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) {
    for (const x of node) walkLd(x, into, evidence, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  if (o["@graph"]) walkLd(o["@graph"], into, evidence, depth + 1);
  if (o.mainEntity) walkLd(o.mainEntity, into, evidence, depth + 1);
  if (o.about) walkLd(o.about, into, evidence, depth + 1);
  if (o.itemListElement) walkLd(o.itemListElement, into, evidence, depth + 1);
  if (o.item) walkLd(o.item, into, evidence, depth + 1);
  if (o.hasPart) walkLd(o.hasPart, into, evidence, depth + 1);
  if (o.containsPlace) walkLd(o.containsPlace, into, evidence, depth + 1);
  if (o.location) walkLd(o.location, into, evidence, depth + 1);
  if (o.mentions) walkLd(o.mentions, into, evidence, depth + 1);
  if (o.member) walkLd(o.member, into, evidence, depth + 1);
  const typ = ldTypes(o);
  const name = ldText(o.name ?? o.headline ?? o.alternateName).slice(0, 160);
  if (/Country|SovereignState|Nation\b/i.test(typ)) {
    const country = name;
    const city = tidyCapital(ldText(o.capital));
    if (country.length >= 2 && country.length <= 40 && city) {
      into.push({ s: country, p: "capital", o: city, e: `capital of ${country} is ${city}`.slice(0, 280) });
    }
    if (country.length >= 2 && country.length <= 40) {
      const iso = tidyIso(ldText(o.isoCode ?? o.iso3166 ?? o.iso3166Code));
      if (iso) into.push({ s: country, p: "id", o: iso, e: `${country} ISO 3166-1 alpha-2 ${iso}`.slice(0, 280) });
      const langs = o.officialLanguage;
      const langNodes = Array.isArray(langs) ? langs : langs != null ? [langs] : [];
      for (const node of langNodes.slice(0, 4)) {
        const lang = tidyProper(ldText(node));
        if (!lang) continue;
        const oLang = `an official language of ${country}`;
        if (oLang.length >= 8 && oLang.length <= 72) {
          into.push({ s: lang, p: "is", o: oLang, e: oLang.slice(0, 280) });
        }
      }
      const aka = tidyProper(ldText(o.alternateName ?? o.officialName ?? o.officialname));
      if (aka && aka.toLowerCase() !== country.toLowerCase()) {
        const oOff = `the official name of ${country}`;
        if (oOff.length >= 8 && oOff.length <= 72) {
          into.push({ s: aka, p: "is", o: oOff, e: oOff.slice(0, 280) });
        }
      }
      const cur = tidyProper(ldText(o.currency));
      if (cur) {
        const oCur = `the currency of ${country}`;
        if (oCur.length >= 8 && oCur.length <= 72) {
          into.push({ s: cur, p: "is", o: oCur, e: oCur.slice(0, 280) });
        }
      }
      const tel = ldText(o.telephone ?? o.telephonePrefix);
      if (tel) {
        const code = tel.replace(/[^\d+]/g, " ").trim().split(/\s+/)[0];
        if (code && /^\+?\d{1,4}$/.test(code)) {
          into.push({
            s: country,
            p: "id",
            o: code.startsWith("+") ? code : `+${code}`,
            e: `${country} calling code ${code}`.slice(0, 280),
          });
        }
      }
      const desc = ldText(o.description ?? o.abstract);
      if (
        desc &&
        desc.length >= 8 &&
        desc.length <= 72 &&
        !looksLikeCode(desc) &&
        country.toLowerCase() !== desc.toLowerCase()
      ) {
        into.push({ s: country, p: "is", o: desc.slice(0, 72), e: desc.slice(0, 280) });
      }
      const pop = tidyPopulation(ldText(o.population ?? o.populationEstimate ?? o.census));
      if (pop) into.push({ s: country, p: "id", o: pop, e: `${country} population ${pop}`.slice(0, 280) });
      const area = tidyArea(ldText(o.area ?? o.surfaceArea));
      if (area) into.push({ s: country, p: "id", o: area, e: `${country} area ${area}`.slice(0, 280) });
      const place = tidyProper(ldText(o.containedInPlace ?? o.containedIn));
      if (place) {
        const pretty = CONTINENT.test(place) ? place.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : place;
        const oPlace = `a country in ${pretty}`;
        if (oPlace.length >= 8 && oPlace.length <= 72) {
          into.push({ s: country, p: "is", o: oPlace, e: oPlace.slice(0, 280) });
        }
      }
      const legis = tidyProper(ldText(o.legislature));
      if (legis) {
        const oLeg = `the legislature of ${country}`;
        if (oLeg.length >= 8 && oLeg.length <= 72) {
          into.push({ s: legis, p: "is", o: oLeg, e: oLeg.slice(0, 280) });
        }
      }
      const geo = o.geo && typeof o.geo === "object" && !Array.isArray(o.geo) ? (o.geo as Record<string, unknown>) : undefined;
      const lat = ldText(o.latitude ?? geo?.latitude);
      const lng = ldText(o.longitude ?? geo?.longitude);
      if (lat && lng && /^-?\d+(?:\.\d+)?$/.test(lat) && /^-?\d+(?:\.\d+)?$/.test(lng)) {
        const oGeo = `${lat},${lng}`;
        if (oGeo.length <= 48) into.push({ s: country, p: "id", o: oGeo, e: `${country} geo ${oGeo}`.slice(0, 280) });
      }
    }
  } else {
    const desc = ldText(o.description ?? o.abstract);
    if (name && desc && desc.length >= 8 && !looksLikeCode(desc) && name.toLowerCase() !== desc.toLowerCase()) {
      const oDesc = desc.length <= 72 ? desc : desc.slice(0, 72).replace(/\s+\S*$/, "").trim();
      if (oDesc.length >= 8 && oDesc.length <= 72) {
        into.push({ s: name, p: "is", o: oDesc, e: desc.slice(0, 280) });
      }
    }
  }
  const ident = o.identifier ?? o.isbn ?? o.issn;
  if (name && ident) {
    const id = ldText(ident);
    if (id && id.length <= 80 && !/^https?:/i.test(id) && !/^Q\d+$/i.test(id)) {
      into.push({ s: name, p: "id", o: id.slice(0, 80), e: evidence.slice(0, 280) });
    }
  }
  const ver = o.version ?? o.softwareVersion;
  if (name && ver) {
    const v = ldText(ver);
    if (v && v.length <= 40) into.push({ s: name, p: "version", o: v.slice(0, 40), e: evidence.slice(0, 120) });
  }
  if (typeof o.author === "object") walkLd(o.author, into, evidence, depth + 1);
}

export function looksLikeCode(s: string): boolean {
  if ((s.match(/[{};=<>]/g) || []).length >= 6) return true;
  return /\b(function|cssRules|const |let |var |=>|addMetadata)\b/.test(s);
}

const WIKI_PIPE_FIELD = /\b(?:leader_title|image_skyline|image_map|image_flag|flag_link|coat_of_arms|infobox)\s*=/i;
const WIKI_LEFTOVER = /\[\[|\{\{|]]|<!--|<[^>]+>|\|{2,}/;
const GENERIC_SETTLEMENT =
  /^(unincorporated community|census-designated place|human settlement|municipality|township|village|town|city)$/i;
const MOTTO_NOT_MOTTO =
  /^(latin|english|french|german|spanish|italian|portuguese|dutch|greek|arabic|chinese|japanese|russian|yoruba|catalan|hebrew|hindi|swahili|municipality|town|city)('*)?$/i;

function wikiNoise(s: string): boolean {
  return WIKI_LEFTOVER.test(s) || /'{2,}/.test(s) || /^\d+px\b/i.test(s) || /^[\s}'"]+$/.test(s);
}

function junkMotto(s: string): boolean {
  if (wikiNoise(s) || MOTTO_NOT_MOTTO.test(s.trim())) return true;
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(s.trim());
}

/**
 * Unparsed wikitext / URL fragments that must never occupy the packed graph.
 * URL-independent so compact can drop leftover dump rows.
 */
export function junkGraphFact(t: { s: string; p: string; o: string; e?: string }): boolean {
  const s = t.s.trim();
  const o = t.o.trim();
  if (!s || !o) return true;
  if (/[|]/.test(s) || /[|]/.test(o)) return true;
  if (WIKI_PIPE_FIELD.test(`${s} ${o}`)) return true;
  if (wikiNoise(s) || wikiNoise(o)) return true;
  if (/\[https?:/i.test(o) || /^https?:\/\//i.test(o) || /\[https?:/i.test(s)) return true;
  if (t.p === "is") {
    if (/^the motto of /i.test(o) && junkMotto(s)) return true;
    const named = o.match(/^the official name of (.+)$/i)?.[1]?.trim();
    if (named) {
      if (GENERIC_SETTLEMENT.test(s)) return true;
      const sl = s.toLowerCase();
      const nl = named.toLowerCase();
      if (nl === sl || nl.startsWith(`${sl},`) || nl.startsWith(`${sl} `)) return true;
    }
  }
  return false;
}

function wikiPageName(url: string): string | undefined {
  const m = url.match(/wikipedia\.org\/wiki\/([^/?#]+)/i);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!.replace(/_/g, " ")).replace(/\s+/g, " ").trim();
  } catch {
    return m[1]!.replace(/_/g, " ");
  }
}

function wikiNsSkip(name: string): boolean {
  return /^(Wikipedia|File|Help|Talk|User|Template|Special|Category|Portal|Draft|Module):/i.test(name);
}

const WIKI_LINK_NS = /^(File|Image|Category|Help|Wikipedia|Template|Special|User|Talk|Draft|Module):/i;

function wikiArticle(url: string): { origin: string; title: string } | undefined {
  if (skipHost(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!/(^|\.)wikipedia\.org$/i.test(parsed.hostname)) return undefined;
  const m = parsed.pathname.match(/^\/wiki\/([^/]+)$/i);
  if (!m) return undefined;
  let title: string;
  try {
    title = decodeURIComponent(m[1]!.replace(/_/g, " ")).replace(/\s+/g, " ").trim();
  } catch {
    title = m[1]!.replace(/_/g, " ");
  }
  if (!title || wikiNsSkip(title) || /^List of /i.test(title)) return undefined;
  return { origin: parsed.origin, title };
}

/** Public Action API for section-0 wikitext. Wikipedia read APIs are in; paywalls stay out. */
export function wikiActionApiUrl(articleUrl: string): string | undefined {
  const art = wikiArticle(articleUrl);
  if (!art) return undefined;
  const titles = encodeURIComponent(art.title.replace(/ /g, "_"));
  return `${art.origin}/w/api.php?action=query&format=json&formatversion=2&prop=revisions&rvprop=content&rvslots=main&rvsection=0&redirects=1&titles=${titles}`;
}

/** Up to 50 Wikipedia titles on one Action API query (read API, robots-ok). */
export function wikiActionApiBatchUrl(articleUrls: string[], cap = 50): string | undefined {
  const titles: string[] = [];
  let origin = "";
  for (const u of articleUrls) {
    const art = wikiArticle(u);
    if (!art) continue;
    if (!origin) origin = art.origin;
    if (art.origin !== origin) continue;
    titles.push(art.title.replace(/ /g, "_"));
    if (titles.length >= cap) break;
  }
  if (!origin || !titles.length) return undefined;
  return `${origin}/w/api.php?action=query&format=json&formatversion=2&prop=revisions&rvprop=content&rvslots=main&rvsection=0&redirects=1&titles=${titles.map(encodeURIComponent).join("|")}`;
}

export function wikiRevisionPages(json: unknown): { title: string; wikitext: string }[] {
  if (!json || typeof json !== "object") return [];
  const pages = (json as { query?: { pages?: unknown } }).query?.pages;
  const list = Array.isArray(pages)
    ? pages
    : pages && typeof pages === "object"
      ? Object.values(pages as Record<string, unknown>)
      : [];
  const out: { title: string; wikitext: string }[] = [];
  for (const page of list) {
    if (!page || typeof page !== "object") continue;
    const title = (page as { title?: unknown }).title;
    if (typeof title !== "string" || !title || wikiNsSkip(title)) continue;
    const revs = (page as { revisions?: unknown[] }).revisions;
    if (!Array.isArray(revs)) continue;
    for (const rev of revs) {
      if (!rev || typeof rev !== "object") continue;
      const r = rev as Record<string, unknown>;
      const main = (r.slots as { main?: Record<string, unknown> } | undefined)?.main;
      const content =
        (typeof main?.content === "string" && main.content) ||
        (typeof main?.["*"] === "string" && (main["*"] as string)) ||
        (typeof r.content === "string" && r.content) ||
        (typeof r["*"] === "string" && (r["*"] as string)) ||
        "";
      if (content.length >= 8) {
        out.push({ title: title.replace(/_/g, " ").trim(), wikitext: content });
        break;
      }
    }
  }
  return out;
}

export function wikiRestSummaryUrl(articleUrl: string): string | undefined {
  const art = wikiArticle(articleUrl);
  if (!art) return undefined;
  const titles = encodeURIComponent(art.title.replace(/ /g, "_"));
  return `${art.origin}/api/rest_v1/page/summary/${titles}`;
}

function unwrapWikiTemplates(raw: string): string {
  let s = raw;
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/\{\{[^{}|]+\|([^{}]*)\}\}/g, "$1");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\{\{[^{}]*\}\}/g, " ");
}

function firstWikiLink(raw: string): string | undefined {
  for (const m of raw.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
    const title = m[1]!.replace(/_/g, " ").trim();
    if (!title || WIKI_LINK_NS.test(title)) continue;
    const display = (m[2] || title).replace(/_/g, " ").trim();
    if (display) return display;
  }
  return undefined;
}

function cityFromWikiValue(raw: string): string | undefined {
  const unwrapped = unwrapWikiTemplates(raw);
  return tidyCapital(firstWikiLink(unwrapped) || firstWikiLink(raw) || unwrapped);
}

/** Infobox `| capital = [[Nairobi]]` / `{{nowrap|[[Nairobi]]}}`. No network. */
export function wikiCapitalFromWikitext(wt: string): string | undefined {
  const re = /\|\s*capital(?:_city)?\s*=\s*([^\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wt))) {
    const o = cityFromWikiValue(m[1]!.trim());
    if (o) return o;
  }
  const jsonWt = wt.match(/"capital"\s*:\s*\{\s*"wt"\s*:\s*"((?:\\.|[^"\\]){2,120})"/i)?.[1];
  if (jsonWt) {
    const o = cityFromWikiValue(jsonWt.replace(/\\"/g, '"').replace(/\\n/g, "\n"));
    if (o) return o;
  }
  const prose = wt.match(/\bcapital(?:\s+and\s+largest\s+city)?\s+is\s+([A-Z][A-Za-z.-]{1,40})/);
  if (prose) return tidyCapital(prose[1]!);
  return undefined;
}

/** `action=query&prop=revisions&rvprop=content` JSON (formatversion 1 or 2, slots or `*`). */
export function wikiRevisionWikitext(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const pages = (json as { query?: { pages?: unknown } }).query?.pages;
  const list = Array.isArray(pages)
    ? pages
    : pages && typeof pages === "object"
      ? Object.values(pages as Record<string, unknown>)
      : [];
  for (const page of list) {
    if (!page || typeof page !== "object") continue;
    const revs = (page as { revisions?: unknown[] }).revisions;
    if (!Array.isArray(revs)) continue;
    for (const rev of revs) {
      if (!rev || typeof rev !== "object") continue;
      const r = rev as Record<string, unknown>;
      const main = (r.slots as { main?: Record<string, unknown> } | undefined)?.main;
      const content =
        (typeof main?.content === "string" && main.content) ||
        (typeof main?.["*"] === "string" && (main["*"] as string)) ||
        (typeof r.content === "string" && r.content) ||
        (typeof r["*"] === "string" && (r["*"] as string)) ||
        "";
      if (content.length >= 8) return content;
    }
  }
  return undefined;
}

export function wikiSummaryExtract(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as { extract?: unknown; description?: unknown };
  const extract = typeof o.extract === "string" ? o.extract : "";
  const desc = typeof o.description === "string" ? o.description : "";
  const s = extract || desc;
  return s.length >= 8 ? s : undefined;
}

/** Resolved article title after Action API redirects / REST summary. */
export function wikiApiNormalizedTitle(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as {
    title?: unknown;
    titles?: { canonical?: unknown; normalized?: unknown };
    query?: {
      redirects?: { to?: string }[];
      normalized?: { to?: string }[];
      pages?: unknown;
    };
  };
  const fromQuery = o.query?.redirects?.[0]?.to || o.query?.normalized?.[0]?.to;
  if (fromQuery && !wikiNsSkip(fromQuery)) return fromQuery.replace(/_/g, " ").trim();
  const pages = o.query?.pages;
  const list = Array.isArray(pages)
    ? pages
    : pages && typeof pages === "object"
      ? Object.values(pages as Record<string, unknown>)
      : [];
  for (const page of list) {
    if (!page || typeof page !== "object") continue;
    const title = (page as { title?: unknown }).title;
    if (typeof title === "string" && title && !wikiNsSkip(title)) return title.replace(/_/g, " ").trim();
  }
  if (typeof o.title === "string" && o.title && !wikiNsSkip(o.title)) return o.title.replace(/_/g, " ").trim();
  const canon = o.titles?.canonical || o.titles?.normalized;
  if (typeof canon === "string" && canon && !wikiNsSkip(canon)) return canon.replace(/_/g, " ").trim();
  return undefined;
}

export function wikiApiBodyToText(body: string): string {
  const t = body.trim();
  if (!t) return "";
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const json = JSON.parse(t) as unknown;
      return wikiRevisionWikitext(json) || wikiSummaryExtract(json) || "";
    } catch {
      return "";
    }
  }
  return t;
}

export function wikiNeedsApiFallback(url: string, html: string): boolean {
  if (!wikiActionApiUrl(url) && !wikiRestSummaryUrl(url)) return false;
  return !wikiCapital(url, html, "");
}

/** Append Action API / REST body when HTML infobox capital is missing. Stamp canonical title. */
export function applyWikiApiFallback(url: string, html: string, apiBody: string): string {
  if (!wikiNeedsApiFallback(url, html)) return html;
  const extra = wikiApiBodyToText(apiBody);
  let out = extra ? `${html}\n${extra}` : html;
  try {
    const title = wikiApiNormalizedTitle(JSON.parse(apiBody.trim()) as unknown);
    const art = wikiArticle(url);
    if (title && art) {
      const href = `${art.origin}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
      out = `<link rel="canonical" href="${href}"><meta property="mw:PageProp/displaytitle" content="${title.replace(/"/g, "")}"/>\n${out}`;
    }
  } catch {
    /* body is wikitext, not JSON */
  }
  return out;
}

const CONTINENT =
  /^(africa|antarctica|asia|europe|oceania|americas|north america|south america|central america|eurasia|afro-eurasia)$/i;

const NAME_JUNK = /^(capital|country|city|town|notes|continent|nation|state|territory)$/i;

/** Abbrev (St.) or word (Kenya, Country001). Period is not a join — that ate "Nairobi. RFC". */
const NAME_HEAD = String.raw`(?:\p{Lu}[\p{L}\p{M}]{0,3}\.|\p{Lu}[\p{L}\p{M}0-9'\-]*)`;
const NAME_PARTICLE = String.raw`(?:and|of|the|da|de|del|do|van|von|di|du|la|le|el|al)`;
const PROPER_NAME = `${NAME_HEAD}(?:\\s+(?:${NAME_PARTICLE}\\s+)*${NAME_HEAD}|\\s+d'${NAME_HEAD})*`;
const PROPER_NAME_RE = new RegExp(`^(${PROPER_NAME})`, "u");
const PROPER_HEAD_RE = new RegExp(`^([\\p{Lu}][\\p{L}\\p{M}0-9'\\-]*(?:\\s+[\\p{L}\\p{M}0-9'\\-]+){0,4})`, "u");
const WAS_CAPITAL_RE = new RegExp(
  `(?:.*\\s)?(${PROPER_NAME})\\s+(?:is|was|serves as)\\s+the\\s+(?:capital(?:\\s+city)?\\s+)?$`,
  "u",
);
const NAME_TAIL_RE = new RegExp(`(${PROPER_NAME})$`, "u");
const LANG_IS_RE = new RegExp(`(${PROPER_NAME})\\s+is\\s+(?:an\\s+|the\\s+)?$`, "u");
const CAPITAL_OF_HINT_RE = new RegExp(`\\bcapital(?:\\s+city)? of (${PROPER_NAME}) is `, "iu");
const COUNTRY_IS_HINT_RE = new RegExp(`\\b(${PROPER_NAME}) is a country\\b`, "iu");

/** Drop template CSS, refs, and parser-output chrome before reading a cell. */
function stripCellChrome(raw: string): string {
  if (raw.length < 12 || (raw.indexOf("<s") < 0 && raw.indexOf("<S") < 0 && !raw.includes("reference") && !raw.includes("cite-"))) return raw;
  return raw.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<sup\b[^>]*\breference\b[^>]*>[\s\S]*?<\/sup>/gi, " ").replace(/<span\b[^>]*\bcite-bracket\b[^>]*>[\s\S]*?<\/span>/gi, " ");
}

function stripMarkup(raw: string): string {
  return decodeEntities(stripCellChrome(raw).replace(/<[^>]+>/g, " "))
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/'{2,}/g, "")
    .replace(/\[[0-9]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function consecutiveHeads(s: string): number {
  let max = 0, run = 0;
  for (const w of s.split(/\s+/)) {
    if (!w || /^(and|of|the|da|de|del|do|van|von|di|du|la|le|el|al)$/i.test(w)) { run = 0; continue; }
    if (/^\p{Lu}/u.test(w)) { if (++run > max) max = run; } else run = 0;
  }
  return max;
}

function tidyCapital(raw: string): string | undefined {
  const t = stripMarkup(raw).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const o = (t.match(PROPER_NAME_RE)?.[1] || t.split(/[,;]/)[0] || "").trim().replace(/[.,]+$/g, "");
  if (o.length < 2 || o.length > 48 || NAME_JUNK.test(o) || CONTINENT.test(o) || /^flag of /i.test(o) || consecutiveHeads(o) >= 4) return;
  return o;
}

function tidyIso(raw: string): string | undefined {
  const o = stripMarkup(raw).replace(/^ISO\s*3166(?:-[12])?:?\s*/i, "").trim().match(/\b([A-Za-z]{2})\b/)?.[1]?.toUpperCase();
  return o && /^[A-Z]{2}$/.test(o) ? o : undefined;
}

function tidyPopulation(raw: string): string | undefined {
  const o = stripMarkup(raw).replace(/\([^)]*\)/g, " ").match(/(\d{1,3}(?:,\d{3}){1,4}|\d{4,12}|\d+(?:\.\d+)?\s*(?:million|billion))/i)?.[1]?.replace(/\s+/g, " ").trim();
  return o && o.length >= 2 && o.length <= 48 ? o : undefined;
}

function tidyArea(raw: string): string | undefined {
  const m = stripMarkup(raw).replace(/\([^)]*\)/g, " ").replace(/km\s*[²2]/gi, "km2").replace(/km²/g, "km2").match(/([\d,]+(?:\.\d+)?)\s*(km2|sq\s*mi|km)\b/i);
  if (!m) return;
  const o = `${m[1]} ${/sq/i.test(m[2]!) ? "sq mi" : "km2"}`;
  return o.length <= 48 ? o : undefined;
}

function tidyGov(raw: string): string | undefined {
  let t = stripMarkup(raw).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < 6 || t.length > 60 || /^(government|republic|none|n\/a|country|state)$/i.test(t)) return;
  t = t.charAt(0).toLowerCase() + t.slice(1);
  if (!/^(a|an|the)\s/i.test(t)) t = `${/^[aeiou]/i.test(t) && !/^(uni|u[bcdfghjklmnpqrstvwxyz])/i.test(t) ? "an" : "a"} ${t}`;
  return t.length >= 8 && t.length <= 72 ? t : undefined;
}

function isFileLinkAttrs(attrs: string): boolean {
  return /wiki\/File:|(?:href|resource|src)\s*=\s*["'][^"']*File:|\bmw-file-description\b|#cite_/i.test(attrs);
}

/** First wiki link in a cell, skipping File: flags. Country/city names live in the link, not the flag span. */
function cellLead(raw: string): string {
  const cleaned = stripCellChrome(raw);
  for (const m of cleaned.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1]!;
    if (isFileLinkAttrs(attrs) || /File:/i.test(attrs)) continue;
    let text = decodeEntities(m[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!text) text = attrGet(`<a ${attrs}>`, "title");
    if (!text || /^\[\s*\d+\s*\]$/.test(text) || /^flag of /i.test(text)) continue;
    return text;
  }
  const title = cleaned.match(/\btitle=["']([^"']+)["']/i)?.[1];
  if (title && !/^flag of /i.test(title) && !/File:/i.test(title)) {
    const t = decodeEntities(title).replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  return decodeEntities(cleaned.replace(/<[^>]+>/g, " ")).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

function headerLabel(raw: string): string {
  return lab(decodeEntities(raw.replace(/<[^>]+>/g, " "))).replace(/^[•·*]+\s*/, "");
}

function lab(s: string): string { return s.replace(/\s+/g, " ").trim().toLowerCase(); }

/** Infobox labels: "Capital", "Capital city", "Capital and largest city", infobox-label spans. */
function isCapitalLabel(label: string): boolean {
  const t = lab(label);
  return !!t && !/\b(country|continent)\b/.test(t) && (adaptCapitalLabel(t) || /^capital\b/.test(t) || /^official capital\b/.test(t));
}

const isIsoLabel = (s: string) => /iso\s*3166/.test(lab(s));
const isLanguageLabel = (s: string) => /^(official\s+languages?|national\s+languages?|working\s+languages?)\b/.test(lab(s));
const isCurrencyLabel = (s: string) => /^currency\b/.test(lab(s));
const isCallingLabel = (s: string) => /^(calling\s+code|telephone\s+code)\b/.test(lab(s));
const isDemonymLabel = (s: string) => /^(demonym|gentilic)\b/.test(lab(s));
const isTldLabel = (s: string) => /^(internet\s+tld|cctld|tld)\b/.test(lab(s));

function isPopulationLabel(label: string): boolean {
  const t = lab(label);
  return /^(population|pop\.|inhabitants)\b/.test(t) && !/density|growth|urban|rank/.test(t);
}

function isAreaLabel(label: string): boolean {
  const t = lab(label);
  return /^(area|area\s*km)\b/.test(t) && !/code|metro|urban|rank|water/.test(t);
}

const isLegislatureLabel = (s: string) => /^(legislature|parliament|congress|national assembly)\b/.test(lab(s));
const isGovernmentLabel = (s: string) => /^(government|government type|system of government|political system)\b/.test(lab(s));
const isTimezoneLabel = (s: string) => /^(time\s*zone|timezone|utc offset)\b/.test(lab(s));
const isDrivingLabel = (s: string) => /^(driving\s+side|drives\s+on)\b/.test(lab(s));
const isHeadLabel = (s: string) => /^(president|monarch|king|queen|head of state|head of government|prime minister)\b/.test(lab(s));
const isAnthemLabel = (s: string) => /^(anthem|national anthem)\b/.test(lab(s));
const isMottoLabel = (s: string) => /^(national\s+)?motto$/.test(lab(s));
const isOfficialNameLabel = (s: string) => /^(official name|conventional long name|long name)\b/.test(lab(s));

function isLargestCityLabel(label: string): boolean {
  const t = lab(label);
  return !isCapitalLabel(t) && /^(largest city|largest cities)\b/.test(t) && !/metro|urban|agglomeration/.test(t);
}

function continentIs(country: string, contRaw: string): Triple | undefined {
  const cont = decodeEntities(contRaw).replace(/\s+/g, " ").trim();
  if (!CONTINENT.test(cont)) return undefined;
  const pretty = cont.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const o = `a country in ${pretty}`;
  if (o.length < 8 || o.length > 72) return undefined;
  return { s: country, p: "is", o, e: o.slice(0, 280) };
}

function isoInverse(t: Triple): Triple | undefined {
  if (t.p !== "id" || !/^[A-Z]{2}$/.test(t.o)) return undefined;
  if (!/ISO 3166/.test(t.e)) return undefined;
  const o = `the ISO 3166-1 alpha-2 of ${t.s}`;
  if (o.length < 8 || o.length > 72) return undefined;
  return { s: t.o, p: "is", o, e: t.e };
}

function tidyProper(raw: string): string | undefined {
  const t = stripMarkup(raw)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = t.match(PROPER_HEAD_RE);
  const o = (m?.[1] || t).trim();
  if (o.length < 2 || o.length > 40) return undefined;
  if (/[|={}<\[\]]/.test(o) || wikiNoise(o) || /^\d+$/.test(o) || junkName(o)) return undefined;
  if (/^(official|language|languages|currency|country|city|none|n\/a|capital)$/i.test(o)) return undefined;
  if (CONTINENT.test(o)) return undefined;
  return o;
}

function namedEntities(raw: string): string[] {
  const cleaned = stripCellChrome(raw);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (n: string | undefined) => {
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (const m of cleaned.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (/wiki\/File:/i.test(m[1]!) || /File:/i.test(m[1]!) || /#cite_/i.test(m[1]!)) continue;
    add(tidyProper(decodeEntities(m[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()));
  }
  for (const m of cleaned.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    add(tidyProper(decodeEntities(m[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()));
  }
  if (!out.length) {
    for (const m of cleaned.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
      const title = (m[2] || m[1]!).replace(/_/g, " ").trim();
      if (WIKI_LINK_NS.test(title)) continue;
      add(tidyProper(title));
    }
  }
  if (out.length <= 1) {
    for (const part of stripMarkup(cleaned)
      .split(/\s*(?:,|;|\/| and )\s*/i)
      .slice(0, 4)) {
      add(tidyProper(part.trim()));
    }
  }
  return out;
}

function infoboxBody(html: string, tables?: { open: string; inner: string }[]): string {
  for (const t of tables?.length ? tables : tableSpans(html)) {
    if (/\binfobox\b/i.test(t.open)) return t.inner;
  }
  return "";
}

function tableSpans(html: string): { open: string; inner: string }[] {
  const out: { open: string; inner: string }[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<table", i);
    if (lt < 0) break;
    const after = html.charCodeAt(lt + 6);
    if (after !== 32 && after !== 9 && after !== 10 && after !== 13 && after !== 62) {
      i = lt + 6;
      continue;
    }
    const gt = tagCloseGt(html, lt);
    if (gt < 0) break;
    const end = closeTagFrom(html, gt + 1, "</table>");
    out.push({ open: html.slice(lt, gt + 1), inner: html.slice(gt + 1, Math.max(gt + 1, end - 8)) });
    i = end;
  }
  return out;
}

function rowInners(scope: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = scope.length;
  while (i < n) {
    const lt = scope.indexOf("<tr", i);
    if (lt < 0) break;
    const after = scope.charCodeAt(lt + 3);
    if (after !== 32 && after !== 9 && after !== 10 && after !== 13 && after !== 62) {
      i = lt + 3;
      continue;
    }
    const gt = tagCloseGt(scope, lt);
    if (gt < 0) break;
    const end = closeTagFrom(scope, gt + 1, "</tr>");
    out.push(scope.slice(gt + 1, Math.max(gt + 1, end - 5)));
    i = end;
  }
  return out;
}

function isOpenTag(html: string, lt: number, namelen: number): boolean {
  const c = html.charCodeAt(lt + namelen);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 62 || c === 47;
}

function spanN(open: string, name: string): number {
  const re =
    name === "rowspan"
      ? /\browspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i
      : /\bcolspan\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i;
  const m = open.match(re);
  const n = Number(m?.[1] || m?.[2] || m?.[3] || 1);
  return Number.isFinite(n) && n >= 1 && n < 200 ? n : 1;
}

type TableCell = { inner: string; rowspan: number; colspan: number; kind: "td" | "th" };

/** td/th via tagCloseGt so Parsoid data-mw `>` does not split the cell. */
function cellsIn(scope: string): TableCell[] {
  const out: TableCell[] = [];
  let i = 0;
  const n = scope.length;
  while (i < n) {
    const td = scope.indexOf("<td", i);
    const th = scope.indexOf("<th", i);
    let lt = -1;
    let kind: "td" | "th" | undefined;
    if (td >= 0 && (th < 0 || td < th) && isOpenTag(scope, td, 3)) {
      lt = td;
      kind = "td";
    } else if (th >= 0 && isOpenTag(scope, th, 3)) {
      lt = th;
      kind = "th";
    } else if (td < 0 && th < 0) {
      break;
    } else {
      i = Math.min(td < 0 ? n : td + 3, th < 0 ? n : th + 3);
      continue;
    }
    const gt = tagCloseGt(scope, lt);
    if (gt < 0) break;
    const open = scope.slice(lt, gt + 1);
    const end = closeTagFrom(scope, gt + 1, `</${kind}>`);
    out.push({
      inner: scope.slice(gt + 1, Math.max(gt + 1, end - kind!.length - 3)),
      rowspan: spanN(open, "rowspan"),
      colspan: spanN(open, "colspan"),
      kind: kind!,
    });
    i = end;
  }
  return out;
}

type PendingSpan = { left: number; inner: string };

/**
 * Expand a row against pending rowspans. If the row already has a cell in every
 * header column (messy fixture: rowspan plus a physical continent td), keep physical
 * cells so Oceania is not shifted into Notes.
 */
function takeRow(physical: TableCell[], pending: (PendingSpan | undefined)[], expectedCols: number): string[] {
  const physWidth = physical.reduce((n, c) => n + (c.colspan || 1), 0);
  const short = expectedCols > 0 && physWidth < expectedCols;
  if (!short) {
    for (let i = 0; i < pending.length; i++) {
      const hold = pending[i];
      if (!hold) continue;
      hold.left--;
      if (hold.left <= 0) pending[i] = undefined;
    }
    const row: string[] = [];
    let col = 0;
    for (const c of physical) {
      const span = c.colspan || 1;
      for (let k = 0; k < span; k++) {
        row[col] = c.inner;
        if (k === 0 && c.rowspan > 1) pending[col] = { left: c.rowspan - 1, inner: c.inner };
        col++;
      }
    }
    return row;
  }
  const row: string[] = [];
  let p = 0;
  let col = 0;
  const limit = expectedCols + 8;
  while (col < limit && (p < physical.length || (col < expectedCols && pending[col]))) {
    const hold = pending[col];
    if (hold && hold.left > 0) {
      row[col] = hold.inner;
      hold.left--;
      if (hold.left <= 0) pending[col] = undefined;
      col++;
      continue;
    }
    if (p >= physical.length) break;
    const c = physical[p++];
    const span = c.colspan || 1;
    for (let k = 0; k < span; k++) {
      row[col] = c.inner;
      if (k === 0 && c.rowspan > 1) pending[col] = { left: c.rowspan - 1, inner: c.inner };
      col++;
    }
  }
  return row;
}

function capitalColumns(
  ths: string[],
): { country: number; capital: number; continent?: number; notes?: number } | undefined {
  const country = ths.findIndex((t) => {
    if (/continent/.test(t) || /^of\b/.test(t)) return false;
    return /\b(country|countries|territory|territories|sovereign|nation|nations|state)\b/.test(t);
  });
  const capital = ths.findIndex((t) => {
    if (/\b(country|countries|territory|nation|state)\b/.test(t) && !/\b(capital|city|town|seat)\b/.test(t)) {
      return false;
    }
    if (/\bcountry\b/.test(t)) return false;
    return /\b(capital|capitals|city|cities|town|towns|seat)\b/.test(t);
  });
  if (country < 0 || capital < 0 || country === capital) return undefined;
  const continent = ths.findIndex((t) => /\bcontinent/.test(t));
  const notes = ths.findIndex((t) => /\bnotes\b/.test(t));
  const out: { country: number; capital: number; continent?: number; notes?: number } = { country, capital };
  if (continent >= 0 && continent !== country && continent !== capital) out.continent = continent;
  if (notes >= 0 && notes !== country && notes !== capital) out.notes = notes;
  return out;
}

function wikiRowPairs(scope: string): { label: string; data: string }[] {
  const out: { label: string; data: string }[] = [];
  let section = "";
  for (const inner of rowInners(scope)) {
    const cells = cellsIn(inner);
    let th: string | undefined;
    let td: string | undefined;
    for (const c of cells) {
      if (c.kind === "th" && th === undefined) th = c.inner;
      else if (c.kind === "td" && td === undefined) td = c.inner;
      if (th !== undefined && td !== undefined) break;
    }
    const label = th ? headerLabel(th) : "";
    const data = td || "";
    const hasData = stripMarkup(data).length >= 1;
    if (label && !hasData) {
      if (
        isAreaLabel(label) ||
        isPopulationLabel(label) ||
        isGovernmentLabel(label) ||
        /^gdp\b/.test(label) ||
        /^independence/.test(label)
      ) {
        section = label;
      }
      continue;
    }
    if (!label && hasData) {
      const implied = stripMarkup(data).match(/^(Anthem|Motto)\s*[:]/i);
      if (implied) {
        out.push({
          label: implied[1]!.toLowerCase(),
          data: data.replace(/^\s*(?:<[^>]+>\s*)*(Anthem|Motto)\s*[:]/i, ""),
        });
      }
      continue;
    }
    if (!label || !hasData) continue;
    let effective = label;
    if (/^gdp\b/.test(section) && /^(total|per capita)\b/.test(label)) continue;
    if (isAreaLabel(section) && /^(total|area)\b/.test(label)) effective = "area";
    if (isPopulationLabel(section) && /\b(estimate|census|population)\b/.test(label)) effective = "population";
    out.push({ label: effective, data });
  }
  return out;
}

/** Parsoid / mobile infobox as label+data divs, not table rows. */
function wikiDivPairs(html: string): { label: string; data: string }[] {
  const out: { label: string; data: string }[] = [];
  const re =
    /<(?:div|th|td)\b[^>]*class="[^"]*\binfobox-label\b[^"]*"[^>]*>([\s\S]{0,240}?)<\/(?:div|th|td)>\s*<(?:div|td)\b[^>]*class="[^"]*\binfobox-data\b[^"]*"[^>]*>([\s\S]{0,1200}?)<\/(?:div|td)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const label = headerLabel(m[1]!);
    const data = m[2]!;
    if (label && stripMarkup(data).length >= 1) out.push({ label, data });
  }
  return out;
}

function wikiInfoboxPairs(html: string, tables?: { open: string; inner: string }[]): { label: string; data: string }[] {
  const rows = wikiRowPairs(infoboxBody(html, tables) || html);
  const divs = wikiDivPairs(html);
  if (!divs.length) return rows;
  const have = new Set(rows.map((r) => r.label.toLowerCase()));
  const extra = divs.filter((d) => !have.has(d.label.toLowerCase()));
  return extra.length ? [...rows, ...extra] : rows;
}

function wikiCapitalCell(html: string, tables?: { open: string; inner: string }[]): string | undefined {
  for (const { label, data } of wikiInfoboxPairs(html, tables)) {
    if (isCapitalLabel(label)) {
      noteCapitalLabel(label);
      return data;
    }
  }
  const thTd = html.match(
    /<(?:th)[^>]*>\s*Capital(?:\s+and\s+largest\s+city|\s+city)?\s*<\/th>\s*<td[^>]*>([\s\S]{0,500}?)<\/td>/i,
  )?.[1];
  if (thTd) return thTd;
  return undefined;
}

function wikiCleanTitle(raw: string): string | undefined {
  const t = decodeEntities(raw.replace(/<[^>]+>/g, " "))
    .replace(/\s*[|\-–]\s*Wikipedia\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length < 2 || t.length > 80) return undefined;
  if (wikiNsSkip(t) || /^List of /i.test(t)) return undefined;
  return t;
}

/**
 * Canonical / displaytitle / mw-page-title-main win over the URL slug so
 * `/wiki/Republic_of_Kenya` (redirect) still yields subject Kenya.
 */
export function wikiSubject(url: string, html: string, scan?: HtmlScan): string | undefined {
  const fromUrl = wikiPageName(url);
  if (fromUrl && (wikiNsSkip(fromUrl) || /^List of /i.test(fromUrl))) return fromUrl;
  const candidates: string[] = [];
  if (scan) {
    if (scan.mwTitle) candidates.push(scan.mwTitle);
    if (scan.displaytitle) candidates.push(scan.displaytitle);
    const n = scan.canonical ? wikiPageName(scan.canonical) : undefined;
    if (n) candidates.push(n);
    const h1 = html.includes("firstHeading") ? html.match(/id=["']firstHeading["'][^>]*>([\s\S]{2,80}?)<\/h1>/i)?.[1] : undefined;
    if (h1) candidates.push(h1);
    const redir = html.includes("redirectText") ? html.match(/class=["'][^"']*\bredirectText\b[^"']*["'][\s\S]{0,200}?<a\b[^>]*>([\s\S]{2,80}?)<\/a>/i)?.[1] : undefined;
    if (redir) candidates.push(redir);
    if (scan.og.title) candidates.push(scan.og.title);
    if (scan.metas["dc.title"]) candidates.push(scan.metas["dc.title"]);
    if (scan.metas["citation_title"]) candidates.push(scan.metas["citation_title"]);
  } else {
    const main = html.match(/<span\b[^>]*class="[^"]*\bmw-page-title-main\b[^"]*"[^>]*>([\s\S]{1,80}?)<\/span>/i)?.[1];
    if (main) candidates.push(main);
    const dt = html.match(/property=["']mw:PageProp\/displaytitle["'][^>]*content=["']([^"']+)["']/i)?.[1] || html.match(/content=["']([^"']+)["'][^>]*property=["']mw:PageProp\/displaytitle["']/i)?.[1];
    if (dt) candidates.push(dt);
    const n = wikiPageName(html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] || html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)?.[1] || "");
    if (n) candidates.push(n);
    const h1 = html.match(/id=["']firstHeading["'][^>]*>([\s\S]{2,80}?)<\/h1>/i)?.[1];
    if (h1) candidates.push(h1);
    const redir = html.match(/class=["'][^"']*\bredirectText\b[^"']*["'][\s\S]{0,200}?<a\b[^>]*>([\s\S]{2,80}?)<\/a>/i)?.[1];
    if (redir) candidates.push(redir);
    for (const v of Object.values(namedMeta(html, ["og:title", "dc.title", "citation_title"]))) candidates.push(v);
  }
  for (const c of candidates) { const t = wikiCleanTitle(c); if (t) return t; }
  return fromUrl;
}

/** Wikipedia infobox / wikitext capital. The prose regex misses most articles. */
export function wikiCapital(url: string, html: string, _text: string, scan?: HtmlScan): Triple | undefined {
  const name = wikiSubject(url, html, scan);
  if (!name || wikiNsSkip(name) || /^List of /i.test(name)) return;
  const o = tidyCapital(wikiCapitalCell(html, scan?.tables) || "") || wikiCapitalFromWikitext(html);
  return o ? { s: name, p: "capital", o, e: `capital of ${name} is ${o}`.slice(0, 280) } : undefined;
}

/** ISO 3166-1 alpha-2 from a country infobox. Same persistable `id` path as Wikidata P297. */
export function wikiIso(url: string, html: string, scan?: HtmlScan): Triple | undefined {
  const name = wikiSubject(url, html, scan);
  if (!name || wikiNsSkip(name) || /^List of /i.test(name)) return;
  let raw: string | undefined;
  for (const { label, data } of wikiInfoboxPairs(html, scan?.tables)) {
    if (isIsoLabel(label)) { raw = data; break; }
  }
  if (!raw) raw = html.match(/"iso3166code"\s*:\s*\{\s*"wt"\s*:\s*"((?:\\.|[^"\\]){2,12})"/i)?.[1] || html.match(/\|\s*iso(?:_?3166_?code|code)\s*=\s*([A-Za-z]{2})\b/i)?.[1];
  const o = tidyIso(raw || "");
  return o ? { s: name, p: "id", o, e: `${name} ISO 3166-1 alpha-2 ${o}`.slice(0, 280) } : undefined;
}

/**
 * Wikipedia "List of national capitals". Country is always the subject, capital the object.
 * Live enwiki is City/Town | Country/Territory | Continent | Notes (city-first). Do not invert.
 * Header matching is per <tr> inside each <table> — a sidebar "Of countries" th must not win.
 */
export function wikiCapitalTable(html: string, tables?: { open: string; inner: string }[]): Triple[] {
  const capitals: Triple[] = [];
  const rest: Triple[] = [];
  const seen = new Set<string>();
  const spans = tables?.length ? tables : tableSpans(html);
  const bodies = spans.length ? spans.map((t) => t.inner) : [html];
  for (const body of bodies) {
    let cols: { country: number; capital: number; continent?: number; notes?: number } | undefined;
    const pending: (PendingSpan | undefined)[] = [];
    let colCount = 0;
    const hasSpan = /rowspan|colspan/i.test(body);
    for (const inner of rowInners(body)) {
      const physical = cellsIn(inner);
      if (!physical.length) continue;
      const cells = hasSpan ? takeRow(physical, pending, colCount || physical.length) : physical.map((c) => c.inner);
      if (!cols) {
        cols = cells.length >= 2 ? capitalColumns(cells.map(headerLabel)) : undefined;
        if (cols) colCount = cells.length;
        continue;
      }
      if (cells.length <= Math.max(cols.country, cols.capital)) continue;
      const country = tidyCapital(cellLead(cells[cols.country] || ""));
      const capital = tidyCapital(cellLead(cells[cols.capital] || ""));
      if (!country || !capital || seen.has(country)) continue;
      seen.add(country);
      capitals.push({ s: country, p: "capital", o: capital, e: `capital of ${country} is ${capital}`.slice(0, 280) });
      if (cols.continent != null && cells.length > cols.continent) { const hit = continentIs(country, cellLead(cells[cols.continent]!)); if (hit) rest.push(hit); }
      if (cols.notes != null && cells.length > cols.notes) {
        const noteText = stripMarkup(cells[cols.notes]!);
        if (/^see also\b/i.test(noteText)) continue;
        const noteCont = cols.continent != null && cells.length > cols.continent ? cellLead(cells[cols.continent]!) : "";
        for (const t of capitalProse(noteText)) {
          if (t.p !== "capital" || seen.has(t.s) || /melbourne|sydney/i.test(t.o) || /melbourne|sydney/i.test(t.s)) continue;
          seen.add(t.s);
          capitals.push(t);
          const hit = noteCont ? continentIs(t.s, noteCont) : undefined;
          if (hit) rest.push(hit);
        }
      }
    }
  }
  return [...capitals.slice(0, 400), ...rest.slice(0, 400)];
}

function attrOrInner(scope: string, key: string): string {
  const k = `(?:[\\w.]+:|https?:\\/\\/schema\\.org\\/)?${key}`;
  const quoted = scope.match(new RegExp(`(?:itemprop|property)\\s*=\\s*["']${k}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
  if (quoted) return quoted;
  const rev = scope.match(new RegExp(`content\\s*=\\s*["']([^"']+)["'][^>]*(?:itemprop|property)\\s*=\\s*["']${k}["']`, "i"))?.[1];
  if (rev) return rev;
  const nested = scope.match(
    new RegExp(`(?:itemprop|property)\\s*=\\s*["']${k}["'][^>]*>\\s*(?:<[^>]+>)*\\s*([A-Z][^<]{1,60})`, "i"),
  )?.[1];
  return nested?.trim() || "";
}

function countryFactsFromScope(scope: string): Triple[] {
  const out: Triple[] = [];
  const country = tidyCapital(attrOrInner(scope, "name"));
  const city = tidyCapital(attrOrInner(scope, "capital")) || tidyCapital(scope.match(/(?:itemprop|property)\s*=\s*["'](?:[\w.]+:|https?:\/\/schema\.org\/)?capital["'][\s\S]{0,400}?(?:itemprop|property)\s*=\s*["'](?:[\w.]+:|https?:\/\/schema\.org\/)?name["'][^>]*>([\s\S]{1,60}?)</i)?.[1] || "");
  if (country && city) out.push({ s: country, p: "capital", o: city, e: `capital of ${country} is ${city}`.slice(0, 280) });
  if (country) {
    const iso = tidyIso(attrOrInner(scope, "isoCode") || attrOrInner(scope, "iso3166Code") || attrOrInner(scope, "identifier"));
    if (iso) out.push({ s: country, p: "id", o: iso, e: `${country} ISO 3166-1 alpha-2 ${iso}`.slice(0, 280) });
    const lang = tidyProper(attrOrInner(scope, "officialLanguage"));
    if (lang) pushIs(out, lang, `an official language of ${country}`);
    const pop = tidyPopulation(attrOrInner(scope, "population") || attrOrInner(scope, "census"));
    if (pop) out.push({ s: country, p: "id", o: pop, e: `${country} population ${pop}`.slice(0, 280) });
  }
  return out;
}

function structuredCountryCapitals(html: string, slices?: string[]): Triple[] {
  const out: Triple[] = [];
  if (slices) {
    for (const scope of slices) if (/Country/i.test(scope) && /(?:itemtype|typeof)\s*=\s*["'][^"']*Country/i.test(scope)) out.push(...countryFactsFromScope(scope));
    return out;
  }
  const re = /(?:itemtype|typeof)\s*=\s*["'][^"']*Country[^"']*["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(...countryFactsFromScope(html.slice(Math.max(0, m.index - 120), m.index + 4000)));
  return out;
}

function pushIs(out: Triple[], s: string, o: string) {
  if (o.length >= 8 && o.length <= 72) out.push({ s, p: "is", o, e: o.slice(0, 280) });
}

function extrasFromPairs(name: string, pairs: { label: string; data: string }[]): Triple[] {
  const out: Triple[] = [];
  for (const { label, data } of pairs) {
    if (isLanguageLabel(label)) {
      const official = !/^national\s+languages?\b/.test(lab(label));
      for (const lang of namedEntities(data).slice(0, 4)) pushIs(out, lang, official ? `an official language of ${name}` : `a national language of ${name}`);
    } else if (isCurrencyLabel(label)) {
      const cur = namedEntities(data)[0];
      if (cur) pushIs(out, cur, `the currency of ${name}`);
      const code = stripMarkup(data).match(/\(([A-Z]{3})\)/)?.[1];
      if (code && !/^(THE|AND|FOR|GDP|ISO|UTC|USA|UN|NEW)$/.test(code)) out.push({ s: name, p: "id", o: code, e: `${name} currency ${code}`.slice(0, 280) });
    } else if (isLargestCityLabel(label) && !CONTINENT.test(name)) {
      const city = tidyCapital(data);
      if (city) pushIs(out, city, `the largest city of ${name}`);
    } else if (isMottoLabel(label)) {
      const motto = namedEntities(data)[0] || tidyProper(data);
      if (motto && !junkMotto(motto)) pushIs(out, motto, `the motto of ${name}`);
    } else if (isOfficialNameLabel(label)) {
      const official = tidyProper(data) || namedEntities(data)[0];
      if (official && official.toLowerCase() !== name.toLowerCase() && !GENERIC_SETTLEMENT.test(official)) pushIs(out, official, `the official name of ${name}`);
    } else if (isCapitalLabel(label) && !CONTINENT.test(name)) {
      const city = tidyCapital(data);
      if (city) {
        out.push({ s: name, p: "capital", o: city, e: `capital of ${name} is ${city}`.slice(0, 280) });
        if (/\blargest city\b/.test(label)) pushIs(out, city, `the largest city of ${name}`);
      }
    } else if (isIsoLabel(label)) {
      const iso = tidyIso(data);
      if (iso) out.push({ s: name, p: "id", o: iso, e: `${name} ISO 3166-1 alpha-2 ${iso}`.slice(0, 280) });
    } else if (isCallingLabel(label)) {
      const code = stripMarkup(data).replace(/[^\d+]/g, " ").trim().split(/\s+/)[0];
      if (code && /^\+?\d{1,4}$/.test(code)) out.push({ s: name, p: "id", o: code.startsWith("+") ? code : `+${code}`, e: `${name} calling code ${code}`.slice(0, 280) });
    } else if (isDemonymLabel(label)) {
      const dem = namedEntities(data)[0];
      if (dem) pushIs(out, dem, `a demonym of ${name}`);
    } else if (isTldLabel(label)) {
      const tld = stripMarkup(data).match(/\.[a-z0-9-]{2,24}/i)?.[0]?.toLowerCase();
      if (tld && tld.length >= 3 && tld.length <= 24) out.push({ s: name, p: "id", o: tld, e: `${name} TLD ${tld}`.slice(0, 280) });
    } else if (isPopulationLabel(label)) {
      const pop = tidyPopulation(data);
      if (pop) out.push({ s: name, p: "id", o: pop, e: `${name} population ${pop}`.slice(0, 280) });
    } else if (isAreaLabel(label)) {
      const area = tidyArea(data);
      if (area) out.push({ s: name, p: "id", o: area, e: `${name} area ${area}`.slice(0, 280) });
    } else if (isLegislatureLabel(label)) {
      const body = namedEntities(data)[0];
      if (body) pushIs(out, body, `the legislature of ${name}`);
    } else if (isGovernmentLabel(label)) {
      const gov = tidyGov(data);
      if (gov) out.push({ s: name, p: "is", o: gov, e: gov.slice(0, 280) });
    } else if (isTimezoneLabel(label)) {
      const tzRaw = stripMarkup(data).replace(/\s+/g, " ");
      const tz = tzRaw.match(/\bUTC\s*[+\-−±]\s*\d{1,2}(?::\d{2})?\b/i)?.[0]?.replace(/\s+/g, "").replace("−", "-").replace("±", "+") || tzRaw.match(/\b([A-Z]{2,5})\b/)?.[1];
      if (tz && tz.length <= 48 && !/^(THE|AND|UTC)$/i.test(tz)) out.push({ s: name, p: "id", o: tz, e: `${name} time zone ${tz}`.slice(0, 280) });
    } else if (isDrivingLabel(label)) {
      const side = stripMarkup(data).match(/\b(left|right)\b/i)?.[1]?.toLowerCase();
      if (side) out.push({ s: name, p: "id", o: side, e: `${name} drives on the ${side}`.slice(0, 280) });
    } else if (isHeadLabel(label)) {
      const person = namedEntities(data)[0];
      if (person) pushIs(out, person, `${/prime minister/i.test(label) ? "the prime minister of" : /head of government/i.test(label) ? "the head of government of" : /president/i.test(label) ? "the president of" : "the head of state of"} ${name}`);
    } else if (isAnthemLabel(label)) {
      const anthem = namedEntities(data)[0];
      if (anthem) pushIs(out, anthem, `the anthem of ${name}`);
    }
  }
  return out;
}

/** Infobox official language / currency (and wikitext `| official_languages =`). */
export function wikiInfoboxExtras(url: string, html: string, scan?: HtmlScan): Triple[] {
  const name = wikiSubject(url, html, scan);
  if (!name || wikiNsSkip(name) || /^List of /i.test(name)) return [];
  const out = extrasFromPairs(name, wikiInfoboxPairs(html, scan?.tables));
  if (!out.some((t) => /official language/i.test(t.o))) {
    const wt = html.match(/\|\s*official_languages?\s*=\s*([^\n]+)/i)?.[1];
    if (wt) for (const lang of namedEntities(wt).slice(0, 4)) pushIs(out, lang, `an official language of ${name}`);
  }
  if (!out.some((t) => /currency of/i.test(t.o))) {
    const cur = namedEntities(html.match(/\|\s*currency\s*=\s*([^\n]+)/i)?.[1] || "")[0];
    if (cur) pushIs(out, cur, `the currency of ${name}`);
  }
  if (!out.some((t) => t.p === "id" && /^\d/.test(t.o))) {
    const pop = tidyPopulation(html.match(/\|\s*population_estimate\s*=\s*([^\n]+)/i)?.[1] || "");
    if (pop) out.push({ s: name, p: "id", o: pop, e: `${name} population ${pop}`.slice(0, 280) });
  }
  if (!out.some((t) => t.p === "id" && /km2|sq mi/.test(t.o))) {
    const wt = html.match(/\|\s*area_km2\s*=\s*([^\n]+)/i)?.[1];
    const area = tidyArea(wt ? `${wt} km2` : "");
    if (area) out.push({ s: name, p: "id", o: area, e: `${name} area ${area}`.slice(0, 280) });
  }
  if (!out.some((t) => /legislature of/i.test(t.o))) {
    const body = namedEntities(html.match(/\|\s*legislature\s*=\s*([^\n]+)/i)?.[1] || "")[0];
    if (body) pushIs(out, body, `the legislature of ${name}`);
  }
  if (!out.some((t) => t.s === name && t.p === "is" && /republic|monarchy|federation|state|kingdom/i.test(t.o))) {
    const gov = tidyGov(html.match(/\|\s*government_type\s*=\s*([^\n]+)/i)?.[1] || "");
    if (gov) out.push({ s: name, p: "is", o: gov, e: gov.slice(0, 280) });
  }
  if (!out.some((t) => /official name of/i.test(t.o))) {
    const wt = html.match(/\|\s*(?:conventional_long_name|official_name)\s*=\s*([^\n]+)/i)?.[1];
    const official = wt ? tidyProper(wt) || namedEntities(wt)[0] : undefined;
    if (official && official.toLowerCase() !== name.toLowerCase() && !GENERIC_SETTLEMENT.test(official)) pushIs(out, official, `the official name of ${name}`);
  }
  if (!out.some((t) => /motto of/i.test(t.o))) {
    const wt = html.match(/\|\s*(?:national_motto|motto)\s*=\s*([^\n]+)/i)?.[1];
    const motto = wt ? namedEntities(wt)[0] || tidyProper(wt) : undefined;
    if (motto && !junkMotto(motto)) pushIs(out, motto, `the motto of ${name}`);
  }
  return out;
}

function defListPairs(html: string, dls?: string[]): { label: string; data: string }[] {
  const out: { label: string; data: string }[] = [];
  const blocks = dls !== undefined ? dls : [...html.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi)].map((m) => m[1]!);
  for (const inner of blocks) {
    for (const m of inner.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
      out.push({ label: headerLabel(m[1]!), data: m[2]! });
    }
  }
  return out;
}

/** `<dl><dt>Capital</dt><dd>Nairobi</dd>` / official language / ISO / currency. */
export function defListFacts(url: string, html: string, scan?: HtmlScan): Triple[] {
  const pairs = defListPairs(html, scan?.dls);
  if (!pairs.length) return [];
  const name = wikiSubject(url, html, scan);
  const s = name && !wikiNsSkip(name) && !/^List of /i.test(name) ? name : tidyCapital(pairs.find((p) => /^(country|nation|state)\b/.test(p.label))?.data || "");
  return s && !wikiNsSkip(s) && !/^List of /i.test(s) ? extrasFromPairs(s, pairs) : [];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wikiShortDescription(html: string): string | undefined {
  const i = html.search(/\bshortdescription\b/i);
  if (i < 0) return;
  const lt = html.lastIndexOf("<", i);
  if (lt < 0) return;
  const gt = tagCloseGt(html, lt);
  if (gt < 0) return;
  const name = tagNameAt(html, lt) || "div";
  const t = decodeEntities(html.slice(gt + 1, Math.max(gt + 1, closeTagFrom(html, gt + 1, `</${name}>`) - name.length - 3)).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return t.length >= 4 && t.length <= 80 ? t : undefined;
}

function shortDescObject(desc: string): string | undefined {
  let o = desc.replace(/\s+/g, " ").trim();
  if (/^country in /i.test(o)) o = `a ${o.charAt(0).toLowerCase()}${o.slice(1)}`;
  else if (o.length >= 8 && !/^(a|an|the)\s/i.test(o)) o = `${/^[aeiou]/i.test(o) ? "an" : "a"} ${o.charAt(0).toLowerCase()}${o.slice(1)}`;
  return o.length >= 8 && o.length <= 72 && !looksLikeCode(o) ? o : undefined;
}

/** Wikipedia article `is` from short description / lead sentence. Persistable only. */
export function wikiLeadIs(url: string, html: string, text: string, scan?: HtmlScan): Triple | undefined {
  const name = wikiSubject(url, html, scan);
  if (!name || wikiNsSkip(name) || /^List of /i.test(name)) return;
  const tryObj = (oRaw: string): Triple | undefined => {
    const o = stripMarkup(oRaw).replace(/\s+/g, " ").trim();
    if (o.length < 8 || o.length > 72 || looksLikeCode(o) || wikiNoise(o) || /[{}<>\[\]]/.test(o)) return;
    if (/^the capital\b|^capital of\b|^official language/i.test(o) || /^(and largest city|ISO |Official |Currency|Capital)\b/i.test(o) || name.toLowerCase() === o.toLowerCase()) return;
    return { s: name, p: "is", o, e: o.slice(0, 280) };
  };
  const short = scan?.shortDescription || (html ? wikiShortDescription(html) : undefined);
  if (short) {
    const o = shortDescObject(short);
    const hit = o ? tryObj(o) : undefined;
    if (hit) return hit;
  }
  const metas = scan ? scan.metas : html ? namedMeta(html, ["description", "og:description", "dc.description"]) : {};
  const og = scan ? scan.og : html ? openGraph(html) : {};
  const candidates = [metas.description, metas["og:description"], metas["dc.description"], og.description, text].filter(
    (s): s is string => typeof s === "string" && s.length >= 12,
  );
  const nameRe = escapeRe(name);
  const lead = new RegExp(`(?:^|[.!?\\n]\\s+)${nameRe}\\s+is\\s+(.{8,72}?)(?:\\.|$|,)`, "i");
  const official = new RegExp(`(?:^|[.!?\\n]\\s+)${nameRe},\\s+officially\\s+[^,.]{2,80},\\s+is\\s+(.{8,72}?)(?:\\.|$|,)`, "i");
  for (const c of candidates) {
    const blob = `. ${c.trim()}`;
    const hit = tryObj((blob.match(official) || blob.match(lead))?.[1] || "");
    if (hit) return hit;
  }
}

function findAsciiCi(hay: string, needleLc: string, from: number): number {
  const n = needleLc.length;
  outer: for (let i = from, last = hay.length - n; i <= last; i++) {
    for (let j = 0; j < n; j++) {
      let c = hay.charCodeAt(i + j);
      if (c >= 65 && c <= 90) c += 32;
      if (c !== needleLc.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function takeProperAt(s: string, from: number): { name: string; end: number } | undefined {
  while (from < s.length && s.charCodeAt(from) <= 32) from++;
  const m = s.slice(from, from + 80).match(PROPER_NAME_RE);
  if (!m) return undefined;
  return { name: m[1]!, end: from + m[1]!.length };
}

function skipWs(s: string, i: number): number {
  while (i < s.length && s.charCodeAt(i) <= 32) i++;
  return i;
}

function startsAsciiCi(s: string, i: number, needleLc: string): boolean {
  if (i + needleLc.length > s.length) return false;
  for (let j = 0; j < needleLc.length; j++) {
    let c = s.charCodeAt(i + j);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== needleLc.charCodeAt(j)) return false;
  }
  return true;
}

function capitalProse(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  const add = (country: string, city: string, ev: string) => {
    const s = tidyCapital(country);
    const o = tidyCapital(city);
    if (!s || !o || seen.has(s) || CONTINENT.test(s) || CONTINENT.test(o)) return;
    seen.add(s);
    out.push({ s, p: "capital", o, e: ev.slice(0, 280) });
  };
  const head = text.slice(0, 12_000);
  for (const needle of ["capital city of ", "capital of "]) {
    let i = 0;
    while ((i = findAsciiCi(head, needle, i)) >= 0) {
      const afterOf = i + needle.length;
      const country = takeProperAt(head, afterOf);
      if (country) {
        let j = skipWs(head, country.end);
        if (startsAsciiCi(head, j, "is ")) {
          const city = takeProperAt(head, j + 3);
          if (city) add(country.name, city.name, head.slice(Math.max(0, i - 24), city.end));
        }
      }
      const before = head.slice(Math.max(0, i - 80), i);
      const was = before.match(WAS_CAPITAL_RE);
      if (was) {
        const country2 = takeProperAt(head, afterOf);
        if (country2) add(country2.name, was[1]!, `${was[1]} ${head.slice(i, country2.end)}`);
      }
      i += 8;
    }
  }
  let i = 0;
  while ((i = findAsciiCi(head, "'s capital", i)) >= 0) {
    const before = head.slice(Math.max(0, i - 80), i);
    const owner = before.match(NAME_TAIL_RE);
    let j = skipWs(head, i + "'s capital".length);
    if (startsAsciiCi(head, j, "city")) j = skipWs(head, j + 4);
    if (owner && startsAsciiCi(head, j, "is ")) {
      const city = takeProperAt(head, j + 3);
      if (city) add(owner[1]!, city.name, head.slice(Math.max(0, i - 40), city.end));
    }
    i += 8;
  }
  i = 0;
  while ((i = findAsciiCi(head, "\u2019s capital", i)) >= 0) {
    const before = head.slice(Math.max(0, i - 80), i);
    const owner = before.match(NAME_TAIL_RE);
    let j = skipWs(head, i + "\u2019s capital".length);
    if (startsAsciiCi(head, j, "city")) j = skipWs(head, j + 4);
    if (owner && startsAsciiCi(head, j, "is ")) {
      const city = takeProperAt(head, j + 3);
      if (city) add(owner[1]!, city.name, head.slice(Math.max(0, i - 40), city.end));
    }
    i += 8;
  }
  return out;
}

function extrasFromProse(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  const add = (t: Triple) => {
    if (t.o.length < 8 || t.o.length > 72) return;
    const k = `${t.s}\0${t.p}\0${t.o}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const head = text.slice(0, 12_000);
  let i = 0;
  while ((i = findAsciiCi(head, "official language of ", i)) >= 0) {
    const country = takeProperAt(head, i + "official language of ".length);
    const before = head.slice(Math.max(0, i - 80), i);
    const langM = before.match(LANG_IS_RE);
    if (langM && country) {
      const lang = tidyProper(langM[1]!);
      const ctry = tidyCapital(country.name);
      if (lang && ctry) add({ s: lang, p: "is", o: `an official language of ${ctry}`, e: head.slice(Math.max(0, i - 40), country.end).slice(0, 280) });
    }
    i += 12;
  }
  i = 0;
  while ((i = findAsciiCi(head, "official languages of ", i)) >= 0) {
    const country = takeProperAt(head, i + "official languages of ".length);
    if (country) {
      let j = skipWs(head, country.end);
      if (startsAsciiCi(head, j, "is ")) {
        const lang = takeProperAt(head, j + 3);
        const ctry = tidyCapital(country.name);
        const l = lang ? tidyProper(lang.name) : undefined;
        if (l && ctry) add({ s: l, p: "is", o: `an official language of ${ctry}`, e: head.slice(i, lang!.end).slice(0, 280) });
      }
    }
    i += 12;
  }
  i = 0;
  while ((i = findAsciiCi(head, "currency of ", i)) >= 0) {
    const country = takeProperAt(head, i + "currency of ".length);
    if (country) {
      let j = skipWs(head, country.end);
      if (startsAsciiCi(head, j, "is ")) {
        j = skipWs(head, j + 3);
        if (startsAsciiCi(head, j, "the ")) j += 4;
        const cur = tidyProper(head.slice(j, j + 48));
        const ctry = tidyCapital(country.name);
        if (cur && ctry) add({ s: cur, p: "is", o: `the currency of ${ctry}`, e: head.slice(i, j + cur.length).slice(0, 280) });
      }
    }
    i += 10;
  }
  const hint =
    tidyCapital(head.match(CAPITAL_OF_HINT_RE)?.[1] || "") ||
    tidyCapital(head.match(COUNTRY_IS_HINT_RE)?.[1] || "");
  const langsAreAt = findAsciiCi(head, "official languages are ", 0);
  if (hint && langsAreAt >= 0) {
    const rest = head.slice(langsAreAt + "official languages are ".length, langsAreAt + 200);
    const cut = rest.split(".")[0] || rest;
    for (const lang of namedEntities(cut).slice(0, 4)) {
      add({ s: lang, p: "is", o: `an official language of ${hint}`, e: cut.slice(0, 280) });
    }
  }
  const TOOL_IS =
    /\b([A-Z][\w.+-]{1,40})\s+is an?\s+((?:incredibly\s+|fast\s+|all-in-one\s+|all in one\s+|open[- ]source\s+|high[- ]level\s+|general[- ]purpose\s+){0,3}(?:javascript\s+|python\s+|rust\s+|go\s+|ruby\s+|java\s+|typescript\s+|web\s+)?(?:runtime|compiler|bundler|package manager|programming language|web framework|testing framework|container runtime|version control system|build tool|command-line tool|cli(?:\s+tool)?|library|framework))\b/gi;
  for (const m of head.matchAll(TOOL_IS)) {
    const s = tidyProper(m[1]!);
    if (!s || /^(this|it|there|what|github|the)$/i.test(s)) continue;
    const kind = m[2]!.replace(/\s+/g, " ").trim().toLowerCase();
    add({ s, p: "is", o: /^[aeiou]/i.test(kind) ? `an ${kind}` : `a ${kind}`, e: m[0]!.slice(0, 280) });
  }
  for (const t of techniquesFromProse(head)) add(t);
  return out;
}

function spdxObjectName(id: string): string {
  switch (id) {
    case "MIT":
      return "MIT License";
    case "Apache-2.0":
      return "Apache License 2.0";
    case "BSD-2-Clause":
      return "BSD 2-Clause License";
    case "BSD-3-Clause":
      return "BSD 3-Clause License";
    case "ISC":
      return "ISC License";
    case "GPL-2.0-only":
      return "GNU GPL v2";
    case "GPL-3.0-only":
      return "GNU GPL v3";
    case "LGPL-3.0-only":
      return "GNU LGPL v3";
    case "MPL-2.0":
      return "Mozilla Public License 2.0";
    case "AGPL-3.0-only":
      return "GNU AGPL v3";
    case "Unlicense":
      return "The Unlicense";
    case "CC0-1.0":
      return "CC0 1.0 Universal";
    case "0BSD":
      return "BSD Zero Clause License";
    case "BlueOak-1.0.0":
      return "Blue Oak Model License";
    default:
      return `${id} license`;
  }
}

function rfcMentionsFromText(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  const add = (num: string, title: string, ev: string) => {
    if (seen.has(num)) return;
    const o = shortTitle(title.replace(/^RFC\s*\d+\s*[:\-–]?\s*/i, ""));
    if (o.length < 8 || rfcGistJunk(o) || /^RFC\s*\d+$/i.test(o) || /^Editor$/i.test(o)) return;
    seen.add(num);
    out.push({ s: `RFC ${num}`, p: "is", o, e: ev.slice(0, 280) });
  };
  const head = text.slice(0, 48_000);
  for (const m of head.matchAll(/\bRFC\s*(\d{3,5})\s*[:\-–]\s*([A-Z][^\n.]{8,80})/g)) {
    add(m[1]!, m[2]!, m[0]!);
  }
  for (const m of head.matchAll(
    /\bRFC\s*(\d{3,5})\s+(?!is\b|was\b|defines\b|specifies\b|obsoletes\b|updates\b|and\b)([A-Z][A-Za-z][^.\n]{6,70})/g,
  )) {
    add(m[1]!, m[2]!, m[0]!);
  }
  for (const m of head.matchAll(/\bRFC\s*(\d{3,5})\s+\(([A-Z][^)]{8,80})\)/g)) {
    add(m[1]!, m[2]!, m[0]!);
  }
  return out.slice(0, 64);
}

function ianaKindFromUrl(url: string): string | undefined {
  if (!/iana\.org/i.test(url)) return undefined;
  if (/http-status-codes/i.test(url)) return "http";
  if (/protocol-numbers/i.test(url)) return "protocol";
  if (/media-types/i.test(url)) return "media";
  if (/uri-schemes/i.test(url)) return "scheme";
  if (/http-methods/i.test(url)) return "method";
  if (/character-sets/i.test(url)) return "charset";
  if (/http-fields|message-headers/i.test(url)) return "header";
  if (/dns-parameters/i.test(url)) return "dns";
  if (/well-known-uris/i.test(url)) return "wellknown";
  return undefined;
}

function xmlTag(block: string, tag: string): string {
  return (block.match(new RegExp(`<${tag}[^>]*>\\s*([^<]*)\\s*</${tag}>`, "i"))?.[1] || "").replace(/\s+/g, " ").trim();
}

/** IANA XML/XHTML `<record>` bodies (registry pages, not Wikipedia). */
function ianaRecordsFromBody(url: string, body: string): Triple[] {
  const kind = ianaKindFromUrl(url);
  if (!kind || !/<record[\s>]/i.test(body)) return [];
  const out: Triple[] = [];
  const skip = /^(unassigned|reserved|deprecated|private encryption|experimental)$/i;
  for (const m of body.matchAll(/<record\b[^>]*>([\s\S]*?)<\/record>/gi)) {
    const b = m[1]!;
    if (kind === "http") {
      const value = xmlTag(b, "value");
      const desc = xmlTag(b, "description");
      if (/^\d{3}$/.test(value) && desc.length >= 2 && desc.length <= 72 && !skip.test(desc)) {
        out.push({ s: `IANA http ${value}`, p: "is", o: desc, e: "" });
      }
    } else if (kind === "protocol") {
      const value = xmlTag(b, "value");
      const name = xmlTag(b, "name");
      if (/^\d+$/.test(value) && name && !skip.test(name) && name.length <= 72) {
        out.push({ s: `IANA protocol ${value}`, p: "is", o: name.slice(0, 72), e: "" });
      }
    } else if (kind === "method") {
      const value = xmlTag(b, "value") || xmlTag(b, "name");
      const desc = xmlTag(b, "description") || xmlTag(b, "semantics");
      if (/^[A-Z][A-Z0-9-]{0,24}$/.test(value) && desc.length >= 2 && desc.length <= 72) {
        out.push({ s: `IANA method ${value}`, p: "is", o: desc, e: "" });
      }
    } else if (kind === "charset") {
      const name = (xmlTag(b, "preferred_alias") || xmlTag(b, "name")).toLowerCase();
      if (/^(utf-8|us-ascii|iso-8859-\d+|windows-125\d)$/i.test(name)) {
        out.push({ s: `IANA charset ${name}`, p: "is", o: name.toUpperCase() === "UTF-8" ? "UTF-8" : name, e: "" });
      }
    } else if (kind === "header") {
      const name = xmlTag(b, "name");
      const desc = xmlTag(b, "description") || xmlTag(b, "status") || `HTTP field ${name}`;
      if (/^[A-Za-z][A-Za-z0-9-]*$/.test(name) && desc.length >= 2 && desc.length <= 72) {
        out.push({ s: `IANA header ${name}`, p: "is", o: desc, e: "" });
      }
    } else if (kind === "dns") {
      const typ = xmlTag(b, "type");
      const meaning = xmlTag(b, "meaning");
      if (/^[A-Z][A-Z0-9-]{0,15}$/.test(typ) && meaning.length >= 2 && meaning.length <= 72) {
        out.push({ s: `IANA dns ${typ}`, p: "is", o: meaning, e: "" });
      }
    }
    if (out.length >= 128) break;
  }
  return out;
}

function mediaFromText(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  const head = text.slice(0, 48_000);
  for (const m of head.matchAll(
    /\b((?:application|text|image|audio|video|font|message|model|multipart|haptics)\/[a-z0-9][a-z0-9!#$&^_.+-]*)\b/gi,
  )) {
    const typ = m[1]!.toLowerCase();
    if (seen.has(typ)) continue;
    if (!MEDIA_TAB.has(typ)) continue;
    seen.add(typ);
    const sub = typ.split("/")[1] || "";
    const o = MEDIA_SUBTYPE_OBJECT[sub] || sub;
    if (o.length < 2) continue;
    out.push({ s: `IANA media ${typ}`, p: "is", o, e: m[0]!.slice(0, 280) });
  }
  return out.slice(0, 24);
}

function mediaFromUrl(url: string): Triple[] {
  const m = url.match(
    /\/media-types\/((?:application|text|image|audio|video|font|message|model|multipart|haptics)\/[a-z0-9+.-]+)/i,
  );
  if (!m) return [];
  const typ = m[1]!.toLowerCase();
  if (!MEDIA_TAB.has(typ)) return [];
  const sub = typ.split("/")[1] || "";
  const o = MEDIA_SUBTYPE_OBJECT[sub] || sub;
  return [{ s: `IANA media ${typ}`, p: "is", o, e: typ }];
}

function spdxFromText(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  const add = (raw: string, ev: string) => {
    let id = "";
    for (const k of SPDX_KEEP) {
      if (k.toLowerCase() === raw.toLowerCase()) {
        id = k;
        break;
      }
    }
    if (!id || seen.has(id)) return;
    seen.add(id);
    const o = spdxObjectName(id);
    if (o.length < 2) return;
    out.push({ s: `SPDX ${id}`, p: "is", o, e: ev.slice(0, 280) });
  };
  const head = text.slice(0, 48_000);
  for (const m of head.matchAll(/SPDX-License-Identifier\s*:\s*([A-Za-z0-9.+-]+)/gi)) add(m[1]!, m[0]!);
  for (const m of head.matchAll(/\bSPDX\s+([A-Za-z0-9.+-]+)/gi)) add(m[1]!, m[0]!);
  return out.slice(0, 16);
}

function isoFromText(url: string, html: string, text: string): Triple | undefined {
  const name = wikiSubject(url, html);
  if (!name || wikiNsSkip(name) || /^List of /i.test(name)) return undefined;
  const raw =
    text.match(/\bISO\s*3166(?:-1)?(?:-[12])?(?:[^A-Z]{0,48})(?:alpha-2)?[:\s]+([A-Z]{2})\b/i)?.[1] || "";
  const o = tidyIso(raw);
  if (!o) return undefined;
  return { s: name, p: "id", o, e: `${name} ISO 3166-1 alpha-2 ${o}`.slice(0, 280) };
}

/** xml2rfc: `<rfc number="9110" docName="..." obsoletes="..." updates="...">` plus `<title>`. */
export function rfcXmlNumber(xml: string): string | undefined {
  return (
    xml.match(/<rfc\b[^>]*\bnumber\s*=\s*["'](\d{3,5})["']/i)?.[1] ||
    xml.match(/<seriesInfo\b[^>]*\bname\s*=\s*["']RFC["'][^>]*\bvalue\s*=\s*["'](\d{3,5})["']/i)?.[1] ||
    xml.match(/<seriesInfo\b[^>]*\bvalue\s*=\s*["'](\d{3,5})["'][^>]*\bname\s*=\s*["']RFC["']/i)?.[1] ||
    xml.match(/<docName>\s*rfc0*(\d{3,5})\s*<\/docName>/i)?.[1] ||
    xml.match(/<rfc\b[^>]*\bdocName\s*=\s*["']rfc0*(\d{3,5})["']/i)?.[1]
  );
}

export function rfcTitleFromXml(xml: string): string | undefined {
  if (!/<rfc\b/i.test(xml) && !/<docName[\s>]/i.test(xml)) return undefined;
  const el = xml.match(/<title\b[^>]*>([\s\S]{4,240}?)<\/title>/i)?.[1];
  if (!el) return undefined;
  const o = shortTitle(innerText(el).replace(/^RFC\s*\d+\s*[:\-–|]\s*/i, ""));
  if (o.length >= 8 && !rfcGistJunk(o) && !/^RFC\s*\d+$/i.test(o) && !/^Editor$/i.test(o)) return o;
  return undefined;
}

export function rfcEdgesFromXml(xml: string, num: string): Triple[] {
  const tag = xml.match(/<rfc\b([^>]*)>/i)?.[1] ?? "";
  const out: Triple[] = [];
  const take = (attr: string, pred: "obsoletes" | "updates") => {
    const raw = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
    if (!raw) return;
    const nums = [...raw.matchAll(/\b(\d{3,5})\b/g)].map((x) => x[1]!).filter((n) => n !== num).slice(0, 8);
    if (!nums.length) return;
    let o = "";
    for (const n of nums) {
      const next = o ? `${o}, RFC ${n}` : `RFC ${n}`;
      if (next.length > 72) break;
      o = next;
    }
    if (o) out.push({ s: `RFC ${num}`, p: pred, o, e: "" });
  };
  take("obsoletes", "obsoletes");
  take("updates", "updates");
  return out;
}

const RFC_CAT: Record<string, string> = {
  std: "an Internet Standard",
  bcp: "a Best Current Practice",
  info: "an Informational RFC",
  exp: "an Experimental RFC",
  historic: "a Historic RFC",
};

/** Map xml2rfc `category=` / `Category:` / `Status:` to a persistable RFC `is` object. Never the Status-of-This-Memo gist. */
function rfcStatusObject(raw: string): string | undefined {
  const t = decodeEntities(raw).replace(/\s+/g, " ").trim().toLowerCase();
  if (!t || t.length > 56) return undefined;
  if (RFC_CAT[t]) return RFC_CAT[t];
  if (/^std\b|standards?\s*track|internet\s+standard/.test(t)) return "an Internet Standard";
  if (/proposed standard/.test(t)) return "a Proposed Standard";
  if (/draft standard/.test(t)) return "a Draft Standard";
  if (/best current practice|^bcp\b/.test(t)) return "a Best Current Practice";
  if (/^info\b|informational/.test(t)) return "an Informational RFC";
  if (/^exp\b|experimental/.test(t)) return "an Experimental RFC";
  if (/historic/.test(t)) return "a Historic RFC";
  return undefined;
}

export function rfcStatusFromXml(xml: string, num: string): Triple[] {
  const out: Triple[] = [];
  const tag = xml.match(/<rfc\b([^>]*)>/i)?.[1] ?? "";
  const cat = tag.match(/\bcategory\s*=\s*["']([^"']+)["']/i)?.[1];
  const o = cat ? rfcStatusObject(cat) : undefined;
  if (o) out.push({ s: `RFC ${num}`, p: "is", o, e: `category ${cat}`.slice(0, 280) });
  const std =
    xml.match(/<seriesInfo\b[^>]*\bname\s*=\s*["']STD["'][^>]*\bvalue\s*=\s*["'](\d{1,4})["']/i)?.[1] ||
    xml.match(/<seriesInfo\b[^>]*\bvalue\s*=\s*["'](\d{1,4})["'][^>]*\bname\s*=\s*["']STD["']/i)?.[1];
  if (std) out.push({ s: `RFC ${num}`, p: "id", o: `STD ${std}`, e: `STD ${std}` });
  const bcp =
    xml.match(/<seriesInfo\b[^>]*\bname\s*=\s*["']BCP["'][^>]*\bvalue\s*=\s*["'](\d{1,4})["']/i)?.[1] ||
    xml.match(/<seriesInfo\b[^>]*\bvalue\s*=\s*["'](\d{1,4})["'][^>]*\bname\s*=\s*["']BCP["']/i)?.[1];
  if (bcp) out.push({ s: `RFC ${num}`, p: "id", o: `BCP ${bcp}`, e: `BCP ${bcp}` });
  return out;
}

/** Header `Category:` / `Status:` / `STD n` — not the “Status of This Memo” boilerplate paragraph. */
export function rfcStatusFromText(num: string, html: string, text: string): Triple[] {
  const head = `${html.slice(0, 2500)}\n${text.slice(0, 2500)}`;
  const out: Triple[] = [];
  const cat =
    head.match(/\bCategory:\s*([A-Za-z][A-Za-z \-]{1,40})/i)?.[1] ||
    head.match(/\bStatus:\s*(Internet Standard|Proposed Standard|Draft Standard|Best Current Practice|Informational|Experimental|Historic)\b/i)?.[1];
  const o = cat ? rfcStatusObject(cat) : undefined;
  if (o) out.push({ s: `RFC ${num}`, p: "is", o, e: (cat || o).slice(0, 280) });
  const std = head.match(/\bSTD\s+(\d{1,4})\b/i)?.[1];
  if (std) out.push({ s: `RFC ${num}`, p: "id", o: `STD ${std}`, e: `STD ${std}` });
  const bcp = head.match(/\bBCP\s+(\d{1,4})\b/i)?.[1];
  if (bcp && !std) out.push({ s: `RFC ${num}`, p: "id", o: `BCP ${bcp}`, e: `BCP ${bcp}` });
  return out;
}

export function shortTitle(s: string): string {
  const c = decodeEntities(s)
    .replace(/\b(Light|Dark|Auto)\b/gi, " ")
    .replace(/\s+RF\.?$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = c.split(/\s+RFC\s+\d/i)[0]!.trim();
  return cut.split(/\s+/).slice(0, 20).join(" ").replace(/\s*[|\-–]\s*RFC Editor\s*$/i, "").trim();
}

function rfcGistJunk(s: string): boolean {
  return /table of contents|january 20|february 20|when server|status of this|copyright notice|this document specifies|this memo|internet society|network working group/i.test(
    s,
  );
}

function innerText(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Prefer `<span class="h1">` / real `<h1>` / RFC XML `<title>` / DC.Title so the gist is the RFC title, not “When server”. */
export function rfcTitleFromHtml(html: string, num: string, text: string, ogTitle?: string, scan?: HtmlScan): string | undefined {
  const candidates: string[] = [];
  const rfcPrefix = new RegExp(`^RFC\\s*${num}\\s*[:\\-–]?\\s*`, "i");
  if (scan) {
    for (const s of scan.spanH1) candidates.push(innerText(s));
    for (const h of scan.h1) {
      let t = innerText(h).replace(rfcPrefix, "").trim();
      if (t && !/^RFC\s*\d+$/i.test(t)) candidates.push(t);
    }
    if (scan.title) {
      const t = innerText(scan.title).replace(/^RFC\s*\d+\s*[:\-–|]\s*/i, "").replace(/\s*[|\-–]\s*RFC Editor\s*$/i, "").trim();
      if (t && !/^rfc\s*\d+$/i.test(t)) candidates.push(t);
    }
    if (scan.metas["citation_title"]) candidates.push(scan.metas["citation_title"]);
    if (scan.metas["dc.title"]) candidates.push(scan.metas["dc.title"]);
  } else {
    for (const m of html.matchAll(/<span\b[^>]*class="[^"]*\bh1\b[^"]*"[^>]*>([\s\S]{4,200}?)<\/span>/gi)) {
      candidates.push(innerText(m[1]!));
    }
    for (const m of html.matchAll(/<h1\b[^>]*>([\s\S]{2,240}?)<\/h1>/gi)) {
      let t = innerText(m[1]!);
      t = t.replace(rfcPrefix, "").trim();
      if (t && !/^RFC\s*\d+$/i.test(t)) candidates.push(t);
    }
    const title = html.match(/<title\b[^>]*>([\s\S]{4,240}?)<\/title>/i)?.[1];
    if (title) {
      const t = innerText(title).replace(/^RFC\s*\d+\s*[:\-–|]\s*/i, "").replace(/\s*[|\-–]\s*RFC Editor\s*$/i, "").trim();
      if (t && !/^rfc\s*\d+$/i.test(t)) candidates.push(t);
    }
    const metas = namedMeta(html, ["citation_title", "dc.title", "dc.identifier"]);
    if (metas["citation_title"]) candidates.push(metas["citation_title"]);
    if (metas["dc.title"]) candidates.push(metas["dc.title"]);
  }
  const xmlTitle = rfcTitleFromXml(html);
  if (xmlTitle) candidates.push(xmlTitle);
  const colon = text.match(new RegExp(`\\bRFC\\s*${num}\\s*[:\\-–]\\s*([A-Z][^\\n.]{8,80})`, "i"));
  if (colon) candidates.push(colon[1]!.trim());
  if (ogTitle) candidates.push(ogTitle);
  for (const c of candidates) {
    const o = shortTitle(c);
    if (o.length >= 8 && !rfcGistJunk(o) && !/^RFC\s*\d+$/i.test(o) && !/^Editor$/i.test(o)) return o;
  }
  return undefined;
}

function rfcNumsListed(raw: string, self: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw.matchAll(/\b(?:RFC\s*)?(\d{3,5})\b/gi)) {
    const n = m[1]!;
    if (n === self || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function rfcEdgesFromText(num: string, text: string): Triple[] {
  const head = text.slice(0, 3500);
  const out: Triple[] = [];
  const take = (label: string, pred: "obsoletes" | "updates") => {
    const m = head.match(new RegExp(`\\b${label}:\\s*([0-9][0-9,\\s]{0,80})`, "i"));
    if (!m) return;
    const nums = rfcNumsListed(m[1]!, num).slice(0, 4);
    if (!nums.length) return;
    const o = nums.map((n) => `RFC ${n}`).join(", ");
    if (o.length <= 72) out.push({ s: `RFC ${num}`, p: pred, o, e: "" });
  };
  take("Obsoletes", "obsoletes");
  take("Updates", "updates");
  const prose = (word: string, pred: "obsoletes" | "updates") => {
    if (out.some((t) => t.p === pred)) return;
    const m = head.match(
      new RegExp(`\\b${word}\\s+((?:RFC\\s*)?\\d{3,5}(?:\\s*(?:,|;|and|&)\\s*(?:RFC\\s*)?\\d{3,5}){0,8})`, "i"),
    );
    if (!m) return;
    const nums = rfcNumsListed(m[1]!, num).slice(0, 4);
    if (!nums.length) return;
    const o = nums.map((n) => `RFC ${n}`).join(", ");
    if (o.length <= 72) out.push({ s: `RFC ${num}`, p: pred, o, e: "" });
  };
  prose("obsoletes", "obsoletes");
  prose("updates", "updates");
  return out;
}

function softwareName(url: string, scan?: HtmlScan): string | undefined {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "github.com" || host === "raw.githubusercontent.com") {
      const repo = u.pathname.split("/").filter(Boolean)[1];
      if (!repo) return undefined;
      const decoded = decodeURIComponent(repo);
      if (/[A-Z.]/.test(decoded) || decoded.includes("-")) return decoded;
      return decoded.charAt(0).toUpperCase() + decoded.slice(1);
    }
  } catch {
    /* fall through */
  }
  const title = (scan?.og.title || scan?.title || "").replace(/\s+/g, " ").trim();
  const h1 = scan?.h1[0] ? innerText(scan.h1[0]!) : "";
  const raw = (h1 || title).replace(/\s*[-–|].*$/, "").trim();
  return tidyProper(raw);
}

const TOOL_SKIP =
  /^(this|it|there|what|which|that|and|github|the|a|an|you|we|they|use|used|using|cookie|cookies|here|only|data|system|software|example|project|plugin|service|information|program)$/i;

function tidyToolName(raw: string): string | undefined {
  const proper = tidyProper(raw);
  if (proper && !TOOL_SKIP.test(proper)) return proper;
  const t = stripMarkup(raw).replace(/\s+/g, " ").trim();
  if (!/^[A-Za-z][\w.+-]{1,24}$/.test(t) || TOOL_SKIP.test(t)) return undefined;
  return t;
}

function tidyTechniqueObject(raw: string): string | undefined {
  let rest = stripMarkup(raw).replace(/\s+/g, " ").trim();
  rest = (rest.split(/(?<=\w)[.!](?:\s|$)/)[0] || rest).trim();
  rest = rest.replace(/^(to|for)\s+/i, "").replace(/[,;:\s]+$/g, "").trim();
  if (rest.length > 56) rest = rest.slice(0, 56).replace(/\s+\S*$/, "").trim();
  if (rest.length < 4 || /^(this|it|that|them|you|your|their)\b/i.test(rest)) return undefined;
  const o = `used for ${rest}`;
  if (o.length < 8 || o.length > 72 || looksLikeCode(o) || wikiNoise(o) || /[{}<>\[\]]/.test(o)) return undefined;
  return o;
}

export function techniquesFromProse(text: string): Triple[] {
  const out: Triple[] = [];
  const seen = new Set<string>();
  const add = (t: Triple) => {
    const k = `${t.s}\0${t.p}\0${t.o}`;
    if (out.length >= 16 || seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const head = text.slice(0, 12_000);
  const pats = [
    /\b([A-Za-z][\w.+-]{1,40})\s+is\s+(?:(?:also|often|commonly|typically|primarily|mainly|widely)\s+)?(?:used|designed|meant|intended)\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\b[Uu]se\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/g,
    /\b([A-Za-z][\w.+-]{1,40})\s+is\s+(?:the\s+)?(?:recommended|standard|usual|preferred|common)\s+(?:way|tool|method)\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\binstead of\s+[A-Za-z][\w.+-]{0,40}.{0,40}?\buse\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\bdon(?:['’])?t use\s+[A-Za-z][\w.+-]{0,40}.{0,48}?\buse\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\b(?:I|we|you)\s+(?:just\s+)?used\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\b(?:fixed|solved|resolved)\b[\s\S]{0,48}?\busing\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\btry(?:ing)?\s+(?:using\s+)?([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\bswitch(?:ed)? to\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\breplace(?:d)?\s+[A-Za-z][\w.+-]{0,40}.{0,24}?with\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\b(?:the )?(?:answer|fix|workaround) is (?:to )?use\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\b([A-Za-z][\w.+-]{1,40})\s+works(?:\s+(?:great|well|fine))?\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
    /\byou (?:should|can|want to)\s+use\s+([A-Za-z][\w.+-]{1,40})\s+(?:to|for)\s+([^.!?\n]{4,80})/gi,
  ];
  for (const re of pats) {
    for (const m of head.matchAll(re)) {
      const s = tidyToolName(m[1]!), o = s && tidyTechniqueObject(m[2]!);
      if (s && o) add({ s, p: "is", o, e: m[0]!.slice(0, 280) });
    }
  }
  return out;
}

function tidySoftwareObject(raw: string): string | undefined {
  let o = stripMarkup(raw).replace(/\s+/g, " ").trim();
  if (!o) return;
  o = (o.split(/(?<=\w)[.!](?:\s|$)/)[0] || o).trim();
  if (o.length > 72) o = o.slice(0, 72).replace(/\s+\S*$/, "").trim();
  o = o.replace(/[,;:\s]+$/g, "").trim();
  if (o.length < 8 || o.length > 72 || looksLikeCode(o) || wikiNoise(o) || /[{}<>\[\]]/.test(o)) return;
  if (!/^(a|an|the)\s/i.test(o) && /^(runtime|compiler|bundler|framework|library|language)\b/i.test(o)) o = `${/^[aeiou]/i.test(o) ? "an" : "a"} ${o}`;
  return o;
}

export function softwareLeadIs(url: string, html: string, text: string, scan?: HtmlScan): Triple | undefined {
  if (!toolDocsUrl(url)) return;
  const name = softwareName(url, scan);
  if (!name || name.length < 2 || name.length > 40) return;
  const metas = scan?.metas ?? (html ? namedMeta(html, ["description", "og:description"]) : {});
  const og = scan?.og ?? (html ? openGraph(html) : {});
  for (const c of [og.description, metas["og:description"], metas.description, text]) {
    if (typeof c !== "string" || c.length < 8) continue;
    const o = tidySoftwareObject(c);
    if (!o || o.toLowerCase() === name.toLowerCase()) continue;
    const t: Triple = { s: name, p: "is", o, e: o.slice(0, 280) };
    if (persistable(url, t)) return t;
  }
}

function rfcEdgeInverses(edges: Triple[]): Triple[] {
  const out: Triple[] = [], seen = new Set<string>();
  for (const t of edges) {
    if (t.p !== "obsoletes" && t.p !== "updates") continue;
    const verb = t.p === "obsoletes" ? "obsoleted by" : "updated by";
    for (const n of rfcNumsListed(t.o, "").slice(0, 8)) {
      const o = `${verb} ${t.s}`, k = `${n}\0${o}`;
      if (o.length < 8 || o.length > 72 || seen.has(k)) continue;
      seen.add(k);
      out.push({ s: `RFC ${n}`, p: "is", o, e: (t.e || o).slice(0, 280) });
    }
  }
  return out;
}

function isCapitalListUrl(url: string): boolean {
  return /\/wiki\/List_of_[^/?#]*capital/i.test(url);
}

function wantsCapitalTable(url: string, html: string, tables?: { open: string; inner: string }[]): boolean {
  if (isCapitalListUrl(url)) return true;
  if (tables) {
    for (const t of tables) {
      if (/\binfobox\b|\bsidebar\b/i.test(t.open)) continue;
      const first = rowInners(t.inner)[0];
      if (!first) continue;
      const ths = cellsIn(first).map((c) => headerLabel(c.inner));
      if (capitalColumns(ths)) return true;
    }
    return false;
  }
  const thCap = /<th\b[^>]*>[\s\S]{0,160}?\b(?:capitals?|city\/town|cities|city|towns|town|seat)\b/i.test(html);
  const thCountry =
    /<th\b[^>]*>[\s\S]{0,160}?\b(?:country|countries|territory|territories|nation|nations|sovereign|state)\b/i.test(
      html,
    );
  return thCap && thCountry;
}

export function triplesFromPage(url: string, htmlOrText: string, isHtml: boolean, scanIn?: HtmlScan): Triple[] {
  const html = isHtml ? htmlOrText : "";
  const scan = isHtml ? scanIn ?? scanHtml(htmlOrText) : undefined;
  const text = scan ? scan.text : htmlOrText.replace(/\s+/g, " ").trim();
  const og = scan ? scan.og : {};
  const ld = scan ? scan.jsonLd : [];
  const out: Triple[] = [];
  for (const block of ld) walkLd(block, out, text.slice(0, 280));
  if (isHtml) out.push(...structuredCountryCapitals(html, scan?.itemSlices));
  const listPage = isCapitalListUrl(url) || /\/wiki\/List_of_/i.test(url);
  const wikiPage = /wikipedia\.org|wikidata\.org/i.test(url);
  if (wikiPage && !listPage) {
    const wikiCap = wikiCapital(url, html, text, scan);
    if (wikiCap) out.push(wikiCap);
    const wikiId = wikiIso(url, html, scan) || isoFromText(url, html, text);
    if (wikiId) out.push(wikiId);
  }
  if (isHtml && wantsCapitalTable(url, html, scan?.tables)) {
    out.push(...wikiCapitalTable(html, scan?.tables));
  }
  if (isHtml && wikiPage) {
    if (!listPage) out.push(...wikiInfoboxExtras(url, html, scan));
    if (!scan || scan.dls.length) out.push(...defListFacts(url, html, scan));
  }
  if (!listPage) {
    out.push(...capitalProse(text), ...extrasFromProse(text));
    for (let i = 0, n = out.length; i < n; i++) {
      const t = out[i]!;
      if (t.p !== "capital" || t.s.toLowerCase() === t.o.toLowerCase()) continue;
      for (const o of [`the capital of ${t.s}`, `a city in ${t.s}`]) if (o.length >= 8 && o.length <= 72) out.push({ s: t.o, p: "is", o, e: t.e });
    }
  }
  for (const t of [wikiPage && !listPage ? wikiLeadIs(url, html, text, scan) : undefined, softwareLeadIs(url, html, text, scan)]) if (t) out.push(t);
  const rfcUrl = url.match(/rfc[-/_]?(\d{3,5})/i);
  const rfcNum = rfcUrl?.[1] || (isHtml ? rfcXmlNumber(html) : undefined);
  if (rfcNum) {
    const metas = scan?.metas ?? (isHtml ? namedMeta(html, ["citation_title", "dc.title"]) : {});
    const titled = rfcTitleFromHtml(html, rfcNum, text, og.title || metas["citation_title"] || metas["dc.title"], scan) || text.match(new RegExp(`\\bRFC\\s*${rfcNum}\\s*[:\\-–]\\s*([A-Z][^\\n.]{8,70})`, "i"))?.[1];
    const o = shortTitle(titled || "Internet standard");
    if (!rfcGistJunk(o)) out.push({ s: `RFC ${rfcNum}`, p: "is", o, e: (titled || text).slice(0, 280) });
    const rfcEdges = [...rfcEdgesFromText(rfcNum, text), ...(isHtml ? rfcEdgesFromXml(html, rfcNum) : [])];
    out.push(...rfcEdges, ...rfcEdgeInverses(rfcEdges), ...(isHtml ? rfcStatusFromXml(html, rfcNum) : []), ...rfcStatusFromText(rfcNum, isHtml ? html : "", text));
  }
  if (findAsciiCi(text, "rfc", 0) >= 0) out.push(...rfcMentionsFromText(text));
  if (text.includes("/")) out.push(...mediaFromText(text));
  out.push(...mediaFromUrl(url));
  if (findAsciiCi(text, "spdx", 0) >= 0) out.push(...spdxFromText(text));
  out.push(...ianaRecordsFromBody(url, isHtml ? html : htmlOrText));
  const tr = url.match(/w3\.org\/TR\/([^/?#]+)/i);
  if (tr) {
    const slug = tr[1]!.replace(/\/+$/, "");
    const htmlTitle = (scan?.title || html.match(/<title>([^<]{4,160})<\/title>/i)?.[1] || "").replace(/\s*[-–|]\s*W3C[\s\S]*$/i, "").trim();
    const h1 = (scan?.h1[0] ? innerText(scan.h1[0]!) : "") || html.match(/<h1[^>]*>([\s\S]{4,180}?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const abs = html.match(/id=["']abstract["'][\s\S]{0,240}<p[^>]*>([^<]{16,140})/i)?.[1] || text.match(/Abstract\s+(.{16,140}?)(?:\s+Status|\s+This document)/i)?.[1];
    const label = shortTitle(h1 || htmlTitle || slug.replace(/-/g, " "));
    if (label) out.push({ s: `W3C ${slug}`, p: "is", o: shortTitle(h1 || htmlTitle || abs || label), e: (htmlTitle || abs || label).slice(0, 280) });
  }
  if (og.title && og.description && og.description.length <= 80 && (rfcUrl || tr)) out.push({ s: og.title.slice(0, 160), p: "is", o: og.description.slice(0, 80), e: og.description.slice(0, 280) });
  for (let i = 0, n = out.length; i < n; i++) { const inv = isoInverse(out[i]!); if (inv) out.push(inv); }
  const seen = new Set<string>();
  const kept = out
    .map(cleanTriple)
    .filter((t): t is Triple => !!t && !junkGraphFact(t) && HOT_PRED.has(t.p))
    .filter((t) => {
      const k = t.p === "capital" ? `${t.s}\0${t.p}` : `${t.s}\0${t.p}\0${t.o}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const capitals = kept.filter((t) => t.p === "capital");
  const rest = kept.filter((t) => t.p !== "capital");
  const restCap = listPage ? 400 : 128;
  return [...capitals.slice(0, 400), ...rest.slice(0, restCap)];
}

const LINK_PREFER =
  /wikipedia\.org|wikidata\.org|rfc-editor\.org|ietf\.org|w3\.org|iana\.org|httpwg\.org|github\.com\/(?:whatwg|oven-sh|denoland|rust-lang|golang|python|nodejs|kubernetes|jqlang)|raw\.githubusercontent\.com|docs\.python\.org|nodejs\.org|doc\.rust-lang\.org|go\.dev|bun\.sh|kubernetes\.io|developer\.mozilla\.org|git-scm\.com|docs\.github\.com|docs\.docker\.com|react\.dev|nextjs\.org|typescriptlang\.org|reddit\.com\/r\/|stackoverflow\.com\/questions|news\.ycombinator\.com\/item/i;

/** Wiki article and list URLs from HTML hrefs and `[[wikilinks]]` so random pages fan out. */
export function wikiGrowUrls(base: string, html: string): string[] {
  if (!/wikipedia\.org/i.test(base)) return [];
  let host = "en.wikipedia.org";
  try { host = new URL(base).host; } catch { /* keep en */ }
  const cap = /\/wiki\/(?:List_of_|Outline_of_)/i.test(base) ? 400 : 160;
  const out: string[] = [];
  const seen = new Set<string>();
  const addSlug = (raw: string) => {
    if (out.length >= cap) return;
    const slug = raw.replace(/ /g, "_");
    if (WIKI_LINK_SKIP.test(`/wiki/${slug}`)) return;
    let title = slug.replace(/_/g, " ");
    try { title = decodeURIComponent(title); } catch { /* keep */ }
    if (wikiNsSkip(title) || !title.trim()) return;
    const url = canonicalUrl(`https://${host}/wiki/${slug}`);
    if (seen.has(url) || skipHost(url)) return;
    seen.add(url);
    out.push(url);
  };
  const re = /href=["'](?:https?:\/\/[a-z]+\.wikipedia\.org)?\/wiki\/([^"'#?]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < cap) addSlug(m[1]!);
  const wt = /\[\[([^\]|#\n]{1,200})(?:[|#][^\]]*)?\]\]/g;
  while ((m = wt.exec(html)) && out.length < cap) addSlug(m[1]!.trim());
  return out;
}
const WIKI_LINK_SKIP = /\/wiki\/(?:File|Special|Help|Talk|User|Template|Wikipedia|Category|Portal|Draft|Module):/i;

export function extractLinks(base: string, htmlOrText: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (href: string) => {
    try {
      const u = new URL(href.replace(/[),.;]+$/, ""), base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      const hrefNoHash = canonicalUrl(u.href.split("#")[0]!);
      if (
        seen.has(hrefNoHash) ||
        skipHost(hrefNoHash) ||
        WIKI_LINK_SKIP.test(hrefNoHash) ||
        /[?&]action=edit\b/i.test(hrefNoHash) ||
        /\/w\/index\.php/i.test(hrefNoHash)
      ) {
        return;
      }
      seen.add(hrefNoHash);
      urls.push(hrefNoHash);
    } catch {
      /* skip */
    }
  };
  for (const href of htmlAlternateHrefs(htmlOrText)) add(href);
  const abs = /https?:\/\/[^\s"'<>]+/gi;
  let m: RegExpExecArray | null;
  while ((m = abs.exec(htmlOrText))) add(m[0]!);
  const href = /href=["']([^"']+)["']/gi;
  while ((m = href.exec(htmlOrText))) add(m[1]!);
  const prefer: string[] = [];
  const rest: string[] = [];
  for (const u of urls) (talkUrl(u) || githubToolUrl(u) || LINK_PREFER.test(u) ? prefer : rest).push(u);
  const listPage = /\/wiki\/List_of_/i.test(base);
  const talkIndex = talkUrl(base) || /\/(?:issues|discussions|questions\/tagged)(?:\/|$)/i.test(base);
  const cap = listPage || talkIndex ? 400 : 160;
  return [...prefer, ...rest].slice(0, cap);
}

export { ttlDaysFor, pageTtl, ttlDaysOnSkip, type TtlHints } from "./ttl";
