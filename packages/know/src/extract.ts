/** HTML → text + structured slots. No Playwright: JSON-LD / OG / noscript live in the first bytes. */

const SKIP_HOST = /(^|\.)(wikipedia|wikimedia|wikidata|wiktionary)\.org$/i;

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
  if (SKIP_HOST.test(h)) return "wikipedia-out";
  if (PAYWALL_HOST.test(h)) return "paywall-host";
  return undefined;
}

/** Strip an HTTP/1.x status block from a WARC response payload. */
export function httpBody(raw: string): string {
  if (!/^HTTP\/\d/i.test(raw)) return raw;
  const i = raw.search(/\r?\n\r?\n/);
  return i < 0 ? raw : raw.slice(i).replace(/^\r?\n\r?\n/, "");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, (m) => m.replace(/<\/?noscript[^>]*>/gi, " "))
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1]!.trim()));
    } catch {
      /* malformed block */
    }
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

/** Substrings that mark a URL as catalog/quality ingest. Shared with SQLite frontier SQL. */
export const QUALITY_URL_NEEDLES = [
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
] as const;

export function qualityUrlSql(col = "url"): string {
  return `(${QUALITY_URL_NEEDLES.map((n) => `${col} LIKE '%${n}%'`).join(" OR ")})`;
}

export function qualityHost(url: string): boolean {
  const u = url.toLowerCase();
  return QUALITY_URL_NEEDLES.some((n) => u.includes(n));
}

/** What occupies the on-disk graph. News JSON-LD dates and homepage "is" dumps do not. */
export function persistable(url: string, t: Triple): boolean {
  if (!HOT_PRED.has(t.p) || looksLikeCode(`${t.o} ${t.e}`)) return false;
  if (t.p === "capital") return true;
  if (t.p === "is" && /^RFC\s+\d/i.test(t.s)) return true;
  if (t.p === "obsoletes" && /^RFC\s+\d/i.test(t.s) && /RFC\s+\d/i.test(t.o)) return true;
  if (t.p === "updates" && /^RFC\s+\d/i.test(t.s) && /RFC\s+\d/i.test(t.o)) return true;
  if (t.p === "is" && /^W3C\s+/i.test(t.s)) return true;
  if (t.p === "is" && /^IANA\s+(protocol|media|scheme|http)\s+/i.test(t.s)) return true;
  if (t.p === "is" && /^SPDX\s+/i.test(t.s)) return true;
  if (t.p === "is" && /^WHATWG\s+/i.test(t.s)) return true;
  if (t.p === "is" && /^Unicode Block /i.test(t.s)) return true;
  if (t.p === "is" && /^IANA language /i.test(t.s)) return true;
  if (t.p === "is" && /^IANA method /i.test(t.s)) return true;
  if (t.p === "is" && /^IANA rel /i.test(t.s)) return true;
  if (t.p === "is" && /^IANA well-known /i.test(t.s)) return true;
  if (t.p === "is" && /^IANA charset /i.test(t.s)) return true;
  if (t.p === "is" && /^IANA header /i.test(t.s)) return true;
  if (t.p === "is" && /^IANA dns /i.test(t.s)) return true;
  if (t.p === "is" && /^Unicode Script /i.test(t.s)) return true;
  if (t.p === "is" && /w3\.org\/TR\//i.test(url)) return true;
  if ((t.p === "id" || t.p === "version") && qualityHost(url) && t.o.length <= 48) return true;
  return false;
}

function walkLd(node: unknown, into: Triple[], evidence: string): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) walkLd(x, into, evidence);
    return;
  }
  const o = node as Record<string, unknown>;
  if (o["@graph"]) walkLd(o["@graph"], into, evidence);
  const name = String(o.name ?? o.headline ?? o.alternateName ?? "").slice(0, 160);
  const desc = String(o.description ?? o.abstract ?? "");
  if (name && desc && desc.length <= 120 && !looksLikeCode(desc)) {
    into.push({ s: name, p: "is", o: desc.slice(0, 120), e: desc.slice(0, 280) });
  }
  const ident = o.identifier ?? o.isbn ?? o.issn;
  if (name && ident && typeof ident !== "object") {
    into.push({ s: name, p: "id", o: String(ident).slice(0, 80), e: evidence.slice(0, 280) });
  }
  const ver = o.version ?? o.softwareVersion;
  if (name && ver && typeof ver !== "object") {
    into.push({ s: name, p: "version", o: String(ver).slice(0, 40), e: evidence.slice(0, 120) });
  }
  if (typeof o.author === "object") walkLd(o.author, into, evidence);
}

export function looksLikeCode(s: string): boolean {
  if ((s.match(/[{};=<>]/g) || []).length >= 6) return true;
  return /\b(function|cssRules|const |let |var |=>|addMetadata)\b/.test(s);
}

export function shortTitle(s: string): string {
  const c = s
    .replace(/\b(Light|Dark|Auto)\b/gi, " ")
    .replace(/\s+RF\.?$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = c.split(/\s+RFC\s+\d/i)[0]!.trim();
  return cut.split(/\s+/).slice(0, 14).join(" ");
}

export function triplesFromPage(url: string, htmlOrText: string, isHtml: boolean): Triple[] {
  const html = isHtml ? htmlOrText : "";
  const text = isHtml ? htmlToText(htmlOrText) : htmlOrText.replace(/\s+/g, " ").trim();
  const og = isHtml ? openGraph(html) : {};
  const ld = isHtml ? jsonLdBlocks(html) : [];
  const out: Triple[] = [];
  for (const block of ld) walkLd(block, out, text.slice(0, 280));
  const cap = text.match(/capital of ([A-Z][A-Za-z ]{2,40}) is ([A-Z][A-Za-z -]{2,40})/i);
  if (cap) out.push({ s: cap[1]!.trim(), p: "capital", o: cap[2]!.trim(), e: cap[0]!.slice(0, 280) });
  const rfcUrl = url.match(/rfc[-/_]?(\d{3,5})/i);
  if (rfcUrl) {
    const num = rfcUrl[1]!;
    const htmlTitle = html.match(/<title>([\s\S]{8,160}?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    const titled =
      (htmlTitle && htmlTitle.replace(/^RFC\s*\d+\s*[:\-–|]\s*/i, "").trim()) ||
      text.match(new RegExp(`RFC\\s*${num}[^A-Za-z0-9]{0,24}([^\\n.]{8,80})`, "i"))?.[1] ||
      text.match(/document (?:specifies|describes|defines) ([^.]{8,80})/i)?.[1] ||
      og.title;
    const o = shortTitle(titled || "Internet standard");
    if (!/table of contents|january 20|february 20/i.test(o)) {
      out.push({
        s: `RFC ${num}`,
        p: "is",
        o,
        e: (htmlTitle || titled || text).slice(0, 280),
      });
    }
  }
  const rfcLine = text.match(/\bRFC\s*(\d{3,5})\s*[:\-–]\s*([A-Z][^\n.]{8,70})/);
  if (rfcLine) out.push({ s: `RFC ${rfcLine[1]}`, p: "is", o: shortTitle(rfcLine[2]!), e: rfcLine[0]!.slice(0, 280) });
  const tr = url.match(/w3\.org\/TR\/([^/?#]+)/i);
  if (tr) {
    const slug = tr[1]!.replace(/\/+$/, "");
    const htmlTitle = html
      .match(/<title>([^<]{4,160})<\/title>/i)?.[1]
      ?.replace(/\s*[-–|]\s*W3C[\s\S]*$/i, "")
      .trim();
    const h1 = html
      .match(/<h1[^>]*>([\s\S]{4,180}?)<\/h1>/i)?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const abs =
      html.match(/id=["']abstract["'][\s\S]{0,240}<p[^>]*>([^<]{16,140})/i)?.[1] ||
      text.match(/Abstract\s+(.{16,140}?)(?:\s+Status|\s+This document)/i)?.[1];
    const name = `W3C ${slug}`;
    const label = shortTitle(h1 || htmlTitle || slug.replace(/-/g, " "));
    if (label) {
      out.push({
        s: name,
        p: "is",
        o: shortTitle(h1 || htmlTitle || abs || label),
        e: (htmlTitle || abs || label).slice(0, 280),
      });
    }
  }
  if (og.title && og.description && og.description.length <= 80 && (rfcUrl || tr)) {
    out.push({
      s: og.title.slice(0, 160),
      p: "is",
      o: og.description.slice(0, 80),
      e: og.description.slice(0, 280),
    });
  }
  return out.filter((t) => persistable(url, t)).slice(0, 12);
}

export function extractLinks(base: string, htmlOrText: string): string[] {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s"'<>]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(htmlOrText))) {
    try {
      const u = new URL(m[0]!.replace(/[),.;]+$/, ""), base);
      if (u.protocol === "http:" || u.protocol === "https:") urls.add(u.href.split("#")[0]!);
    } catch {
      /* skip */
    }
  }
  const href = /href=["']([^"']+)["']/gi;
  while ((m = href.exec(htmlOrText))) {
    try {
      const u = new URL(m[1]!, base);
      if (u.protocol === "http:" || u.protocol === "https:") urls.add(u.href.split("#")[0]!);
    } catch {
      /* skip */
    }
  }
  return [...urls].slice(0, 40);
}

export function ttlDaysFor(url: string, text: string): number {
  const u = url.toLowerCase();
  const t = text.toLowerCase();
  if (/news|blog|press|post\//.test(u) || /\b(today|yesterday|hours ago)\b/.test(t)) return 7;
  if (/rfc|standard|ietf|w3\.org/.test(u)) return 365 * 5;
  if (/docs\.|developer\.|api\./.test(u)) return 90;
  return 365;
}
