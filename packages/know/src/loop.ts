import { createHash } from "node:crypto";
import {
  applyWikiApiFallback,
  englishEnough,
  extractLinks,
  wikiGrowUrls,
  httpBody,
  opinionTrash,
  qualityHost,
  scanHtml,
  skipHost,
  triplesFromPage,
  ttlDaysFor,
  wikiActionApiUrl,
  wikiNeedsApiFallback,
  type HtmlScan,
} from "./extract";
import { ingestWetSlice, latestCrawlId, newsWarcPath, rankFrontierUrls, wetPath } from "./cc";
import { DEFAULT_CC, DEFAULT_CC_SLICES, DEFAULT_LIVE, DEFAULT_NEWS, LIVE_CONCURRENCY, LIVE_PER_HOST, CATALOG_REFRESH_MS, envNum } from "./defaults";
import { liveGet, liveGetStream, liveWikiApi, liveWikiApiBatch, sitemapFrontier } from "./live";
import { feedLinks } from "./feeds";
import { FEED_URLS, SEED_URLS, wikiCountryUrls } from "./seed";
import { cheapSkip } from "./gate";
import { englishTrigram } from "./lang";
import { cdxHits, CDX_HOSTS, rangeWarc } from "./cdx";
import { makeRfcIndexParser, RFC_INDEX_URL } from "./rfc-index";
import { nextW3Page, parseW3Catalog, W3_CATALOG_URL } from "./w3-catalog";
import { IETF_RELATED_URL, nextRelatedPage, parseRelatedDocs } from "./ietf-related";
import { IANA_REGISTRIES, makeIanaXmlParser } from "./iana";
import { parseSpdxLicenses, SPDX_LICENSE_URL } from "./spdx";
import { parseWhatwgDb, WHATWG_DB_URL } from "./whatwg";
import { parseUnicodeBlocks, UNICODE_BLOCKS_URL } from "./unicode";
import { parseUnicodeScripts, UNICODE_SCRIPTS_URL } from "./scripts";
import { parseLangSubtags, LANG_SUBTAG_URL } from "./langtags";
import { parseWikidataCapitals, WIKIDATA_SPARQL_URL } from "./wikidata";
import { capitalTriples } from "./synth";
import { openStore, type KnowStore } from "./store";
import { compactAndPublish } from "./s3";
import type { Triple } from "./extract";

export type TickStats = {
  cc: number;
  news: number;
  live: number;
  feeds: number;
  cdx: number;
  nodes: number;
  skipped: number;
  crawlId?: string;
};

function digest(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const IETF_UPDATES_CATALOG = `${IETF_RELATED_URL}&relationship=updates`;

function admitText(url: string, text: string, store: KnowStore): string | undefined {
  const skip = skipHost(url) || (!qualityHost(url) && store.hostBlocked(url)) || cheapSkip(url, text);
  if (skip) return skip;
  if (!englishEnough(text) || !englishTrigram(text)) return "language";
  if (opinionTrash(text)) return "opinion";
  if (text.length < 80) return "thin";
  return undefined;
}

function commitPage(
  store: KnowStore,
  url: string,
  text: string,
  htmlOrText: string,
  source: string,
  isHtml: boolean,
  scan?: HtmlScan,
): { nodes: number; skipped: number } {
  const why = admitText(url, text, store);
  const d = digest(htmlOrText);
  if (why) {
    store.bumpHost(url, false);
    store.putPage({ url, digest: d, chars: text.length, source, ttl_days: 7, skip: why });
    return { nodes: 0, skipped: 1 };
  }
  if (store.pageDigest(url) === d) {
    const have = (store.db.query(`SELECT COUNT(*) AS n FROM nodes WHERE url = ?`).get(url) as { n: number }).n;
    if (have > 0) {
      store.putPage({ url, digest: d, chars: text.length, source, ttl_days: ttlDaysFor(url, text) });
      return { nodes: 0, skipped: 0 };
    }
  }
  if (!qualityHost(url) && store.nearDup(url, text)) {
    store.bumpHost(url, false);
    store.putPage({ url, digest: d, chars: text.length, source, ttl_days: 30, skip: "near-dup" });
    return { nodes: 0, skipped: 1 };
  }
  const triples = triplesFromPage(url, isHtml ? htmlOrText : text, isHtml, scan);
  if (!triples.length) {
    store.bumpHost(url, false);
    store.putPage({ url, digest: d, chars: text.length, source, ttl_days: 7, skip: "no-hot" });
    return { nodes: 0, skipped: 1 };
  }
  const ttl = ttlDaysFor(url, text);
  store.putPage({ url, digest: d, chars: text.length, source, ttl_days: ttl });
  store.bumpHost(url, true);
  store.putNodes(url, triples, ttl);
  return { nodes: triples.length, skipped: 0 };
}

async function htmlForExtract(url: string, html: string): Promise<string> {
  if (!wikiNeedsApiFallback(url, html)) return html;
  return applyWikiApiFallback(url, html, await liveWikiApi(url));
}

function enqueueRanked(store: KnowStore, urls: string[], from: string) {
  const ranked = rankFrontierUrls(urls);
  if (ranked.length) store.enqueue(ranked, from);
}

function seedIfEmpty(store: KnowStore) {
  if (store.getMeta("need_reseed") === "1") {
    enqueueRanked(store, SEED_URLS, "seed");
    store.setMeta("need_reseed", "0");
    store.setMeta("seeded", "1");
    return;
  }
  if (store.getMeta("seeded")) return;
  enqueueRanked(store, SEED_URLS, "seed");
  store.setMeta("seeded", "1");
}

function htmlText(html: string): { text: string; scan: HtmlScan } {
  const scan = scanHtml(html);
  return { text: scan.text, scan };
}

async function tickCcSlice(store: KnowStore, limit: number, pathIndex: number): Promise<TickStats> {
  try {
    const crawlId = (await latestCrawlId().catch(() => store.getMeta("cc_crawl"))) || "";
    if (!crawlId) return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
    const url = await wetPath(crawlId, pathIndex);
    store.setMeta("cc_crawl", crawlId);
    store.setMeta("cc_wet", url);
    const recs = await ingestWetSlice(url, limit, (uri) => !!store.pageDigest(uri));
    let skipped = 0;
    let nodes = 0;
    for (const rec of recs) {
      const r = commitPage(store, rec.uri, rec.text, rec.text, "cc", false);
      nodes += r.nodes;
      skipped += r.skipped;
    }
    return { cc: recs.length, news: 0, live: 0, feeds: 0, cdx: 0, nodes, skipped, crawlId };
  } catch {
    return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0, crawlId: store.getMeta("cc_crawl") };
  }
}

/** One or more WET files from the latest crawl. `slices` walks consecutive wet.paths entries. */
export async function tickCc(store: KnowStore, limit: number, pathIndex = 0, slices = DEFAULT_CC_SLICES): Promise<TickStats> {
  const n = Math.max(1, Math.min(6, slices | 0));
  const acc: TickStats = { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
  for (let i = 0; i < n; i++) {
    const one = await tickCcSlice(store, limit, pathIndex + i);
    acc.cc += one.cc;
    acc.nodes += one.nodes;
    acc.skipped += one.skipped;
    if (one.crawlId) acc.crawlId = one.crawlId;
  }
  return acc;
}

export async function tickNews(store: KnowStore, limit: number, pathIndex = 0): Promise<TickStats> {
  let skipped = 0;
  let nodes = 0;
  let news = 0;
  try {
    const url = await newsWarcPath(pathIndex);
    store.setMeta("cc_news", url);
    const recs = await ingestWetSlice(url, limit, (uri) => !!store.pageDigest(uri));
    news = recs.length;
    for (const rec of recs) {
      const body = httpBody(rec.text);
      const isHtml = body.includes("<");
      const scan = isHtml ? scanHtml(body) : undefined;
      const text = scan ? scan.text : body;
      const r = commitPage(store, rec.uri, text, body, "cc-news", isHtml, scan);
      nodes += r.nodes;
      skipped += r.skipped;
    }
  } catch {
    /* month listing can 404; CC-MAIN still runs */
  }
  return { cc: 0, news, live: 0, feeds: 0, cdx: 0, nodes, skipped };
}

export async function tickFeeds(store: KnowStore, n = FEED_URLS.length): Promise<TickStats> {
  const idx = Number(store.getMeta("feed_idx") || 0);
  let feeds = 0;
  for (let i = 0; i < n; i++) {
    const url = FEED_URLS[(idx + i) % FEED_URLS.length];
    if (!url) continue;
    const got = await liveGet(url);
    if (!got.ok) continue;
    const links = feedLinks(got.html).filter((u) => !skipHost(u) && u !== url);
    enqueueRanked(store, links, url);
    feeds++;
  }
  store.setMeta("feed_idx", String((idx + n) % FEED_URLS.length));
  return { cc: 0, news: 0, live: 0, feeds, cdx: 0, nodes: 0, skipped: 0 };
}

export async function tickLive(store: KnowStore, limit: number): Promise<TickStats> {
  seedIfEmpty(store);
  const urls = rankFrontierUrls(store.takeFrontier(limit));
  const hostN = new Map<string, number>();
  const waiters: Array<() => void> = [];
  const fetched = await mapPool(urls, LIVE_CONCURRENCY, async (url) => {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      return { url, got: await liveGet(url) };
    }
    while ((hostN.get(host) ?? 0) >= LIVE_PER_HOST) {
      await new Promise<void>((r) => waiters.push(r));
    }
    hostN.set(host, (hostN.get(host) ?? 0) + 1);
    try {
      return { url, got: await liveGet(url) };
    } finally {
      hostN.set(host, Math.max(0, (hostN.get(host) ?? 1) - 1));
      waiters.shift()?.();
    }
  });
  let live = 0;
  let skipped = 0;
  let nodes = 0;
  const sitemapHosts = new Set<string>();
  for (const { url, got } of fetched) {
    if (!got.ok) {
      store.putPage({ url, digest: "", chars: 0, source: "live", ttl_days: 1, skip: got.skip || "fetch" });
      skipped++;
      continue;
    }
    const html = await htmlForExtract(url, got.html);
    const { text, scan } = htmlText(html);
    const r = commitPage(store, url, text.length >= 80 ? text : html, html, "live", true, scan);
    nodes += r.nodes;
    skipped += r.skipped;
    if (!r.skipped) live++;
    enqueueRanked(
      store,
      [...extractLinks(url, got.html).filter((u) => !skipHost(u)), ...wikiGrowUrls(url, got.html)],
      url,
    );
    try {
      sitemapHosts.add(new URL(url).host);
    } catch {
      /* ignore */
    }
  }
  for (const host of sitemapHosts) {
    try {
      const origin = `https://${host}`;
      const smKey = `sitemap:${host}`;
      const at = Number(store.getMeta(smKey) || 0);
      if (!at || !Number.isFinite(at) || at < 1e12 || Date.now() - at > 24 * 3600_000) {
        store.setMeta(smKey, String(Date.now()));
        enqueueRanked(store, await sitemapFrontier(origin), origin);
      }
    } catch {
      /* ignore */
    }
  }
  return { cc: 0, news: 0, live, feeds: 0, cdx: 0, nodes, skipped };
}

async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

function emptyTick(): TickStats {
  return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
}

type Gather = {
  url: string;
  source: string;
  digest: string;
  chars: number;
  triples: Triple[];
  links: string[];
  ok: boolean;
  notModified?: boolean;
};

function catalogDue(store: KnowStore, url: string): boolean {
  const at = Number(store.getMeta(`cat:${url}`) || 0);
  if (at && Number.isFinite(at) && Date.now() - at < CATALOG_REFRESH_MS) return false;
  if (store.pageFresh(url)) return false;
  return true;
}

function skipGather(url: string, source: string): Gather {
  return { url, source, digest: "", chars: 0, triples: [], links: [], ok: true, notModified: true };
}

function commitCatalog(store: KnowStore, url: string, source: string, digestHex: string, chars: number, triples: Triple[]): TickStats {
  if (store.pageDigest(url) === digestHex) return emptyTick();
  if (!triples.length) return { ...emptyTick(), skipped: 1 };
  const before = (store.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  store.putPage({ url, digest: digestHex, chars, source, ttl_days: 365 });
  store.putNodes(url, triples, 365 * 5);
  store.bumpHost(url, true);
  store.setMeta(`cat:${url}`, String(Date.now()));
  const after = (store.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  return { ...emptyTick(), live: 1, nodes: Math.max(0, after - before) };
}

function applyGather(store: KnowStore, g: Gather): TickStats {
  if (g.links.length) enqueueRanked(store, g.links.filter((u) => !skipHost(u)), g.url);
  if (g.notModified) return emptyTick();
  if (!g.ok) return { ...emptyTick(), skipped: 1 };
  return commitCatalog(store, g.url, g.source, g.digest, g.chars, g.triples);
}

async function gatherRfcIndex() {
  const parser = makeRfcIndexParser();
  const got = await liveGetStream(RFC_INDEX_URL, {
    timeoutMs: 45_000,
    accept: "application/xml,text/xml,*/*;q=0.1",
    onChunk: (s) => parser.push(s),
  });
  if (got.skip === "not-modified" || got.status === 304) {
    return {
      url: RFC_INDEX_URL,
      source: "rfc-index",
      digest: got.digest,
      chars: 0,
      triples: [] as Triple[],
      links: [] as string[],
      ok: true,
      notModified: true,
    };
  }
  return {
    url: RFC_INDEX_URL,
    source: "rfc-index",
    digest: got.digest,
    chars: got.chars,
    triples: got.ok ? parser.finish() : [],
    links: got.ok ? got.links : [],
    ok: got.ok,
  };
}

async function gatherJsonCatalog(
  url: string,
  source: string,
  parse: (json: unknown) => Triple[],
  timeoutMs = 20_000,
) {
  const got = await liveGet(url, { timeoutMs, accept: "application/json" });
  if (!got.ok) return { url, source, digest: "", chars: 0, triples: [] as Triple[], links: [] as string[], ok: false };
  let json: unknown;
  try {
    json = JSON.parse(got.html);
  } catch {
    return { url, source, digest: "", chars: 0, triples: [] as Triple[], links: [] as string[], ok: false };
  }
  return {
    url,
    source,
    digest: digest(got.html),
    chars: got.html.length,
    triples: parse(json),
    links: [] as string[],
    ok: true,
  };
}

async function gatherTextCatalog(
  url: string,
  source: string,
  parse: (text: string) => Triple[],
  timeoutMs = 20_000,
  accept = "text/plain,*/*;q=0.1",
) {
  const got = await liveGet(url, { timeoutMs, accept });
  if (!got.ok) return { url, source, digest: "", chars: 0, triples: [] as Triple[], links: [] as string[], ok: false };
  return {
    url,
    source,
    digest: digest(got.html),
    chars: got.html.length,
    triples: parse(got.html),
    links: [] as string[],
    ok: true,
  };
}

export async function tickCapitals(store: KnowStore): Promise<TickStats> {
  const triples = capitalTriples();
  const blob = triples.map((t) => `${t.s}|${t.o}`).join("\n");
  return commitCatalog(store, "eden:capitals", "capitals", digest(blob), blob.length, triples);
}

export async function tickRfcIndex(store: KnowStore): Promise<TickStats> {
  return applyGather(store, await gatherRfcIndex());
}

async function gatherW3() {
  const pages: unknown[] = [];
  const raw: string[] = [];
  let url: string | undefined = `${W3_CATALOG_URL}?items=1000`;
  for (let i = 0; i < 16 && url; i++) {
    const got = await liveGet(url, { timeoutMs: 20_000, accept: "application/json" });
    if (!got.ok) break;
    raw.push(got.html);
    try {
      pages.push(JSON.parse(got.html));
    } catch {
      break;
    }
    url = nextW3Page(pages[pages.length - 1]);
  }
  if (!pages.length) {
    return { url: W3_CATALOG_URL, source: "w3-catalog", digest: "", chars: 0, triples: [] as Triple[], links: [] as string[], ok: false };
  }
  const blob = raw.join("\n");
  return {
    url: W3_CATALOG_URL,
    source: "w3-catalog",
    digest: digest(blob),
    chars: blob.length,
    triples: parseW3Catalog(pages),
    links: [] as string[],
    ok: true,
  };
}

async function gatherIetf() {
  const pages: unknown[] = [];
  const raw: string[] = [];
  let url: string | undefined = IETF_UPDATES_CATALOG;
  for (let i = 0; i < 16 && url; i++) {
    const got = await liveGet(url, { timeoutMs: 20_000, accept: "application/json" });
    if (!got.ok) break;
    raw.push(got.html);
    try {
      pages.push(JSON.parse(got.html));
    } catch {
      break;
    }
    url = nextRelatedPage(pages[pages.length - 1]);
  }
  if (!pages.length) {
    return { url: IETF_UPDATES_CATALOG, source: "ietf-related", digest: "", chars: 0, triples: [] as Triple[], links: [] as string[], ok: false };
  }
  const blob = raw.join("\n");
  return {
    url: IETF_UPDATES_CATALOG,
    source: "ietf-related",
    digest: digest(blob),
    chars: blob.length,
    triples: parseRelatedDocs(pages, "updates"),
    links: [] as string[],
    ok: true,
  };
}

async function gatherIana() {
  return Promise.all(
    IANA_REGISTRIES.map(async (reg) => {
      const parser = makeIanaXmlParser(reg.kind);
      const got = await liveGetStream(reg.url, {
        timeoutMs: 45_000,
        accept: "application/xml,text/xml,*/*;q=0.1",
        onChunk: (s) => parser.push(s),
      });
      if (got.skip === "not-modified" || got.status === 304) {
        return {
          url: reg.url,
          source: "iana",
          digest: got.digest,
          chars: 0,
          triples: [] as Triple[],
          links: [] as string[],
          ok: true,
          notModified: true,
        };
      }
      return {
        url: reg.url,
        source: "iana",
        digest: got.digest,
        chars: got.chars,
        triples: got.ok ? parser.finish() : [],
        links: got.ok ? got.links : [],
        ok: got.ok,
      };
    }),
  );
}

export async function tickW3Catalog(store: KnowStore): Promise<TickStats> {
  return applyGather(store, await gatherW3());
}

export async function tickIetfRelated(store: KnowStore): Promise<TickStats> {
  return applyGather(store, await gatherIetf());
}

export async function tickIana(store: KnowStore): Promise<TickStats> {
  const acc = emptyTick();
  const fetched = await Promise.all(
    IANA_REGISTRIES.map(async (reg) => {
      const parser = makeIanaXmlParser(reg.kind);
      const got = await liveGetStream(reg.url, {
        timeoutMs: 45_000,
        accept: "application/xml,text/xml,*/*;q=0.1",
        onChunk: (s) => parser.push(s),
      });
      return { reg, got, triples: got.ok ? parser.finish() : [] };
    }),
  );
  for (const { reg, got, triples } of fetched) {
    if (got.links.length) enqueueRanked(store, got.links.filter((u) => !skipHost(u)), reg.url);
    if (!got.ok) {
      acc.skipped++;
      continue;
    }
    const r = commitCatalog(store, reg.url, "iana", got.digest, got.chars, triples);
    acc.live += r.live;
    acc.nodes += r.nodes;
    acc.skipped += r.skipped;
  }
  if (!acc.live && !acc.nodes && !acc.skipped) acc.skipped = 1;
  return acc;
}

export async function tickSpdx(store: KnowStore): Promise<TickStats> {
  return applyGather(store, await gatherJsonCatalog(SPDX_LICENSE_URL, "spdx", parseSpdxLicenses));
}

export async function tickWhatwg(store: KnowStore): Promise<TickStats> {
  return applyGather(store, await gatherJsonCatalog(WHATWG_DB_URL, "whatwg", parseWhatwgDb));
}

export async function tickUnicode(store: KnowStore): Promise<TickStats> {
  return applyGather(store, await gatherTextCatalog(UNICODE_BLOCKS_URL, "unicode", parseUnicodeBlocks));
}

export async function tickLangTags(store: KnowStore): Promise<TickStats> {
  return applyGather(store, await gatherTextCatalog(LANG_SUBTAG_URL, "langtags", parseLangSubtags, 45_000));
}

export async function tickWikidata(store: KnowStore): Promise<TickStats> {
  return applyGather(
    store,
    await gatherJsonCatalog(WIKIDATA_SPARQL_URL, "wikidata", parseWikidataCapitals, 45_000),
  );
}

export async function tickScripts(store: KnowStore): Promise<TickStats> {
  return applyGather(store, await gatherTextCatalog(UNICODE_SCRIPTS_URL, "scripts", parseUnicodeScripts));
}

export async function tickWikiGrow(store: KnowStore, n = 24): Promise<TickStats> {
  seedIfEmpty(store);
  const all = wikiCountryUrls();
  if (!all.length) return emptyTick();
  const idx = Number(store.getMeta("wiki_grow_idx") || 0) % all.length;
  const batch: string[] = [];
  for (let i = 0; i < all.length && batch.length < n; i++) {
    const url = all[(idx + i) % all.length]!;
    if (store.pageDigest(url)) continue;
    batch.push(url);
  }
  enqueueRanked(store, batch, "wiki-grow");
  store.setMeta("wiki_grow_idx", String((idx + n) % all.length));
  return emptyTick();
}

/** Action API batch: up to 50 unseen country articles in one robots-ok request. */
export async function tickWikiBatch(store: KnowStore, n = 50): Promise<TickStats> {
  seedIfEmpty(store);
  const all = wikiCountryUrls();
  const todo: string[] = [];
  for (const url of all) {
    if (store.pageDigest(url)) continue;
    todo.push(url);
    if (todo.length >= n) break;
  }
  if (!todo.length) return emptyTick();
  const pages = await liveWikiApiBatch(todo);
  let live = 0;
  let skipped = 0;
  let nodes = 0;
  const got = new Set(pages.map((p) => p.url));
  for (const p of pages) {
    const html = `<html><title>${p.title}</title>\n${p.wikitext}\n</html>`;
    const { text, scan } = htmlText(html);
    const r = commitPage(store, p.url, text.length >= 80 ? text : html, html, "wiki-api", true, scan);
    nodes += r.nodes;
    skipped += r.skipped;
    if (!r.skipped) live++;
  }
  enqueueRanked(
    store,
    todo.filter((u) => !got.has(u)),
    "wiki-batch",
  );
  return { cc: 0, news: 0, live, feeds: 0, cdx: 0, nodes, skipped };
}

export async function tickRecrawl(store: KnowStore, n = 16): Promise<TickStats> {
  enqueueRanked(store, store.staleUrls(n), "recrawl");
  return emptyTick();
}

export async function tickQuality(store: KnowStore, n = 3): Promise<TickStats> {
  seedIfEmpty(store);
  let live = 0;
  let skipped = 0;
  let nodes = 0;
  const want = (url: string) =>
    /rfc[-/_]?\d{3,5}/i.test(url) || /\/TR\//i.test(url) || /wikipedia\.org\/wiki\//i.test(url);
  const wiki = SEED_URLS.filter((u) => /wikipedia\.org\/wiki\//i.test(u));
  const rest = SEED_URLS.filter((u) => want(u) && !/wikipedia\.org\/wiki\//i.test(u));
  const ordered = [
    ...wiki.filter((u) => wikiActionApiUrl(u)),
    ...wiki.filter((u) => !wikiActionApiUrl(u)),
    ...rest,
  ];
  const todo: string[] = [];
  for (const url of ordered) {
    if (todo.length >= n) break;
    const rfc = url.match(/rfc[-/_]?(\d{3,5})/i);
    if (rfc) {
      const row = store.db
        .query(
          `SELECT n.eid AS eid FROM nodes n JOIN intern s ON s.id = n.sid JOIN intern p ON p.id = n.pid
           WHERE s.s = ? AND p.s = 'is'`,
        )
        .get(`RFC ${rfc[1]}`) as { eid: number } | null;
      if (row && row.eid !== 0) continue;
    } else {
      const have = (store.db.query(`SELECT COUNT(*) AS n FROM nodes WHERE url = ?`).get(url) as { n: number }).n;
      if (have > 0) continue;
    }
    todo.push(url);
  }
  const fetchedPages = await mapPool(todo, Math.min(LIVE_CONCURRENCY, Math.max(1, todo.length)), async (url) => {
    const got = await liveGet(url);
    return { url, got };
  });
  for (const { url, got } of fetchedPages) {
    if (!got.ok) {
      skipped++;
      continue;
    }
    const html = await htmlForExtract(url, got.html);
    const { text, scan } = htmlText(html);
    const r = commitPage(store, url, text.length >= 80 ? text : html, html, "seed", true, scan);
    nodes += r.nodes;
    skipped += r.skipped;
    if (!r.skipped) {
      live++;
      enqueueRanked(store, wikiGrowUrls(url, html), url);
    }
  }
  return { cc: 0, news: 0, live, feeds: 0, cdx: 0, nodes, skipped };
}

export async function tickCdx(store: KnowStore, n = 2): Promise<TickStats> {
  const crawlId = store.getMeta("cc_crawl") || (await latestCrawlId().catch(() => ""));
  let cdx = 0;
  let nodes = 0;
  let skipped = 0;
  if (!crawlId) return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
  const idx = Number(store.getMeta("cdx_host_idx") || 0);
  for (let i = 0; i < n; i++) {
    const host = CDX_HOSTS[(idx + i) % CDX_HOSTS.length];
    if (!host) continue;
    try {
      const hits = await cdxHits(crawlId, host, 3);
      for (const hit of hits.slice(0, 2)) {
        const rec = await rangeWarc(hit);
        if (!rec) {
          skipped++;
          continue;
        }
        store.setMeta("cdx_ok", "1");
        const isHtml = rec.text.includes("<");
        const scan = isHtml ? scanHtml(rec.text) : undefined;
        const text = scan ? scan.text : rec.text;
        const r = commitPage(store, rec.uri, text, rec.text, "cdx", isHtml, scan);
        nodes += r.nodes;
        skipped += r.skipped;
        cdx++;
      }
    } catch {
      /* index 503 */
    }
  }
  store.setMeta("cdx_host_idx", String((idx + n) % CDX_HOSTS.length));
  return { cc: 0, news: 0, live: 0, feeds: 0, cdx, nodes, skipped };
}

export async function tick(opts?: { cc?: number; news?: number; live?: number; pathIndex?: number }) {
  const store = openStore();
  try {
    seedIfEmpty(store);
    const caps = await tickCapitals(store);
    const due = (url: string) => catalogDue(store, url);
    const ianaDue = IANA_REGISTRIES.some((r) => due(r.url));
    const [rfcG, w3G, relG, ianaGs, spdxG, whatwgG, uniG, langG, scriptsG, wdG, wikiB] = await Promise.all([
      due(RFC_INDEX_URL) ? gatherRfcIndex() : skipGather(RFC_INDEX_URL, "rfc-index"),
      due(W3_CATALOG_URL) ? gatherW3() : skipGather(W3_CATALOG_URL, "w3-catalog"),
      due(IETF_UPDATES_CATALOG) ? gatherIetf() : skipGather(IETF_UPDATES_CATALOG, "ietf-related"),
      ianaDue ? gatherIana() : IANA_REGISTRIES.map((r) => skipGather(r.url, "iana")),
      due(SPDX_LICENSE_URL) ? gatherJsonCatalog(SPDX_LICENSE_URL, "spdx", parseSpdxLicenses) : skipGather(SPDX_LICENSE_URL, "spdx"),
      due(WHATWG_DB_URL) ? gatherJsonCatalog(WHATWG_DB_URL, "whatwg", parseWhatwgDb) : skipGather(WHATWG_DB_URL, "whatwg"),
      due(UNICODE_BLOCKS_URL) ? gatherTextCatalog(UNICODE_BLOCKS_URL, "unicode", parseUnicodeBlocks) : skipGather(UNICODE_BLOCKS_URL, "unicode"),
      due(LANG_SUBTAG_URL) ? gatherTextCatalog(LANG_SUBTAG_URL, "langtags", parseLangSubtags, 45_000) : skipGather(LANG_SUBTAG_URL, "langtags"),
      due(UNICODE_SCRIPTS_URL) ? gatherTextCatalog(UNICODE_SCRIPTS_URL, "scripts", parseUnicodeScripts) : skipGather(UNICODE_SCRIPTS_URL, "scripts"),
      due(WIKIDATA_SPARQL_URL) ? gatherJsonCatalog(WIKIDATA_SPARQL_URL, "wikidata", parseWikidataCapitals, 45_000) : skipGather(WIKIDATA_SPARQL_URL, "wikidata"),
      tickWikiBatch(store, 50),
    ]);
    const idx = applyGather(store, rfcG);
    const w3 = applyGather(store, w3G);
    const rel = applyGather(store, relG);
    const iana = emptyTick();
    for (const g of ianaGs) {
      const r = applyGather(store, g);
      iana.live += r.live;
      iana.nodes += r.nodes;
      iana.skipped += r.skipped;
    }
    if (!iana.live && !iana.nodes && !iana.skipped) iana.skipped = 1;
    const spdx = applyGather(store, spdxG);
    const whatwg = applyGather(store, whatwgG);
    const uni = applyGather(store, uniG);
    const lang = applyGather(store, langG);
    const scripts = applyGather(store, scriptsG);
    const wd = applyGather(store, wdG);
    await tickWikiGrow(store, 48);
    await tickRecrawl(store, 32);
    const q = await tickQuality(store, 8);
    const slices = envNum("EDEN_KNOW_CC_SLICES", DEFAULT_CC_SLICES);
    const ccIdx = opts?.pathIndex ?? Number(store.getMeta("cc_idx") || 0);
    const a = await tickCc(store, opts?.cc ?? DEFAULT_CC, ccIdx, slices);
    const news = await tickNews(store, opts?.news ?? DEFAULT_NEWS, Number(store.getMeta("news_idx") || 0));
    const x = await tickCdx(store, 2);
    const f = await tickFeeds(store);
    const b = await tickLive(store, opts?.live ?? DEFAULT_LIVE);
    store.setMeta("cc_idx", String((ccIdx + slices) % 10_000));
    store.setMeta("news_idx", String((Number(store.getMeta("news_idx") || 0) + 1) % 10_000));
    store.expire();
    if (store.count().wal_nodes >= 16) await compactAndPublish(store);
    const counts = store.count();
    const extraLive = iana.live + spdx.live + whatwg.live + uni.live + lang.live + scripts.live;
    const extraNodes = iana.nodes + spdx.nodes + whatwg.nodes + uni.nodes + lang.nodes + scripts.nodes;
    const extraSkip = iana.skipped + spdx.skipped + whatwg.skipped + uni.skipped + lang.skipped + scripts.skipped;
    return {
      ...a,
      news: news.news,
      live: b.live + q.live + wikiB.live + idx.live + w3.live + rel.live + extraLive + wd.live + caps.live,
      feeds: f.feeds,
      cdx: x.cdx,
      nodes: a.nodes + b.nodes + x.nodes + q.nodes + wikiB.nodes + idx.nodes + w3.nodes + rel.nodes + extraNodes + wd.nodes + caps.nodes + news.nodes,
      skipped: a.skipped + b.skipped + x.skipped + q.skipped + wikiB.skipped + idx.skipped + w3.skipped + rel.skipped + extraSkip + wd.skipped + caps.skipped + news.skipped,
      counts,
    };
  } finally {
    store.close();
  }
}

export async function runLoop(opts: { intervalSec: number; once?: boolean; cc?: number; live?: number; news?: number }) {
  do {
    const t0 = Date.now();
    try {
      const s = await tick({ cc: opts.cc, live: opts.live, news: opts.news });
      console.log(JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, ...s }));
      if (opts.once) return s;
    } catch (e) {
      console.log(JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, err: String(e).slice(0, 200) }));
      if (opts.once) throw e;
    }
    await new Promise((r) => setTimeout(r, Math.max(5_000, opts.intervalSec * 1000 - (Date.now() - t0))));
  } while (true);
}
