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
  ttlDaysOnSkip,
  type TtlHints,
  wikiActionApiUrl,
  wikiNeedsApiFallback,
  type HtmlScan,
} from "./extract";
import { ingestWetSlice, lastWetFetch, latestCrawlId, newsWarcPath, rankFrontierUrls, wetPath, type WetFetchMeter } from "./cc";
import { DEFAULT_CC, DEFAULT_CC_SLICES, DEFAULT_CDX, DEFAULT_LIVE, DEFAULT_NEWS, DEFAULT_QUALITY, DEFAULT_RECRAWL, DEFAULT_WIKI, DEFAULT_WIKI_GROW, DEFAULT_WET_EVERY, LIVE_CONCURRENCY, LIVE_PER_HOST, CATALOG_REFRESH_MS, compactDue, envNum, expensiveLaneDue, shardCount, shardOwns } from "./defaults";
import { fetchRobots, liveGet, liveGetStream, liveWikiApi, liveWikiApiBatch, liveWikiRandomBatch, sitemapFrontier } from "./live";
import { feedLinks } from "./feeds";
import { FEED_URLS, SEED_URLS, WIKI_TOPIC_URLS } from "./seed";
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
import { githubToolUrl, talkUrl, toolDocsUrl } from "./tools";
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
  wet?: WetFetchMeter;
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
  hints?: TtlHints,
): { nodes: number; skipped: number } {
  const why = admitText(url, text, store);
  const d = digest(htmlOrText);
  const ttlArg: TtlHints = { source, ...hints };
  if (why) {
    store.bumpHost(url, false);
    store.putPage({ url, digest: d, chars: text.length, source, ttl_days: ttlDaysOnSkip(url, text, ttlArg), skip: why });
    return { nodes: 0, skipped: 1 };
  }
  if (store.pageDigest(url) === d) {
    if (store.hasWalNodes(url)) {
      store.putPage({
        url,
        digest: d,
        chars: text.length,
        source,
        ttl_days: ttlDaysFor(url, text, { ...ttlArg, unchanged: true, prevTtl: store.pageTtlDays(url) }),
      });
      return { nodes: 0, skipped: 0 };
    }
  }
  if (!qualityHost(url) && store.nearDup(url, text)) {
    store.bumpHost(url, false);
    store.putPage({
      url,
      digest: d,
      chars: text.length,
      source,
      ttl_days: Math.min(ttlDaysFor(url, text, ttlArg), 30),
      skip: "near-dup",
    });
    return { nodes: 0, skipped: 1 };
  }
  const triples = triplesFromPage(url, isHtml ? htmlOrText : text, isHtml, scan);
  if (!triples.length) {
    store.bumpHost(url, false);
    store.putPage({ url, digest: d, chars: text.length, source, ttl_days: ttlDaysOnSkip(url, text, ttlArg), skip: "no-hot" });
    return { nodes: 0, skipped: 1 };
  }
  const ttl = ttlDaysFor(url, text, ttlArg);
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
  const ranked = rankFrontierUrls(urls.filter((u) => shardOwns(u)));
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

async function collectCcSlice(
  store: KnowStore,
  limit: number,
  pathIndex: number,
): Promise<{ recs: Awaited<ReturnType<typeof ingestWetSlice>>; crawlId?: string; url?: string }> {
  if (limit <= 0) return { recs: [] };
  try {
    const crawlId = (await latestCrawlId().catch(() => store.getMeta("cc_crawl"))) || "";
    if (!crawlId) return { recs: [] };
    const url = await wetPath(crawlId, pathIndex);
    const recs = await ingestWetSlice(
      url,
      limit,
      (uri) => !!store.pageDigest(uri),
      envNum("EDEN_KNOW_WET_SCAN", 0) || undefined,
    );
    return { recs, crawlId, url };
  } catch {
    return { recs: [], crawlId: store.getMeta("cc_crawl") };
  }
}

function commitCcRecords(
  store: KnowStore,
  recs: Awaited<ReturnType<typeof ingestWetSlice>>,
  crawlId?: string,
  url?: string,
): TickStats {
  return store.crawlBatch(() => {
    if (crawlId) store.setMeta("cc_crawl", crawlId);
    if (url) store.setMeta("cc_wet", url);
    let skipped = 0;
    let nodes = 0;
    for (const rec of recs) {
      const r = commitPage(store, rec.uri, rec.text, rec.text, "cc", false);
      nodes += r.nodes;
      skipped += r.skipped;
    }
    return { cc: recs.length, news: 0, live: 0, feeds: 0, cdx: 0, nodes, skipped, crawlId };
  });
}

/** One or more WET files from the latest crawl. `slices` walks consecutive wet.paths entries. Fetches in parallel; commits serially. */
export async function tickCc(store: KnowStore, limit: number, pathIndex = 0, slices = DEFAULT_CC_SLICES): Promise<TickStats> {
  const n = Math.max(1, Math.min(6, slices | 0));
  const got = await Promise.all(Array.from({ length: n }, (_, i) => collectCcSlice(store, limit, pathIndex + i)));
  const acc: TickStats = { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
  for (const one of got) {
    const r = commitCcRecords(store, one.recs, one.crawlId, one.url);
    acc.cc += r.cc;
    acc.nodes += r.nodes;
    acc.skipped += r.skipped;
    if (r.crawlId) acc.crawlId = r.crawlId;
  }
  return acc;
}

async function collectNewsRecords(
  store: KnowStore,
  limit: number,
  pathIndex: number,
): Promise<{ recs: Awaited<ReturnType<typeof ingestWetSlice>>; url?: string }> {
  if (limit <= 0) return { recs: [] };
  try {
    const url = await newsWarcPath(pathIndex);
    const recs = await ingestWetSlice(
      url,
      limit,
      (uri) => !!store.pageDigest(uri),
      envNum("EDEN_KNOW_WET_SCAN", 0) || undefined,
    );
    return { recs, url };
  } catch {
    return { recs: [] };
  }
}

function commitNewsRecords(store: KnowStore, recs: Awaited<ReturnType<typeof ingestWetSlice>>, url?: string): TickStats {
  return store.crawlBatch(() => {
    if (url) store.setMeta("cc_news", url);
    let skipped = 0;
    let nodes = 0;
    for (const rec of recs) {
      const body = httpBody(rec.text);
      const isHtml = body.includes("<");
      const scan = isHtml ? scanHtml(body) : undefined;
      const text = scan ? scan.text : body;
      const r = commitPage(store, rec.uri, text, body, "cc-news", isHtml, scan);
      nodes += r.nodes;
      skipped += r.skipped;
    }
    return { cc: 0, news: recs.length, live: 0, feeds: 0, cdx: 0, nodes, skipped };
  });
}

export async function tickNews(store: KnowStore, limit: number, pathIndex = 0): Promise<TickStats> {
  const got = await collectNewsRecords(store, limit, pathIndex);
  return commitNewsRecords(store, got.recs, got.url);
}

export async function tickFeeds(store: KnowStore, n = FEED_URLS.length): Promise<TickStats> {
  const idx = Number(store.getMeta("feed_idx") || 0);
  const urls = Array.from({ length: n }, (_, i) => FEED_URLS[(idx + i) % FEED_URLS.length]).filter(Boolean);
  const got = await mapPool(urls, Math.min(4, urls.length), async (url) => ({ url, got: await liveGet(url) }));
  let feeds = 0;
  for (const { url, got: r } of got) {
    if (!r.ok) continue;
    const links = feedLinks(r.html).filter((u) => !skipHost(u) && u !== url);
    enqueueRanked(store, links, url);
    feeds++;
  }
  store.setMeta("feed_idx", String((idx + n) % FEED_URLS.length));
  return { cc: 0, news: 0, live: 0, feeds, cdx: 0, nodes: 0, skipped: 0 };
}

async function ingestWikiApiPages(store: KnowStore, urls: string[], source: string): Promise<TickStats> {
  const acc = emptyTick();
  const due = urls.filter((u) => shardOwns(u) && !store.pageFresh(u) && wikiActionApiUrl(u));
  for (let i = 0; i < due.length; ) {
    const chunk = due.slice(i, i + 50);
    i += chunk.length;
    const pages = await liveWikiApiBatch(chunk);
    const seen = new Set(pages.map((p) => p.url));
    for (const p of pages) {
      const html = `<html><title>${p.title}</title>\n${p.wikitext}\n</html>`;
      const { text, scan } = htmlText(html);
      const r = commitPage(store, p.url, text.length >= 80 ? text : html, html, source, true, scan);
      acc.nodes += r.nodes;
      acc.skipped += r.skipped;
      if (!r.skipped) acc.live++;
      enqueueRanked(store, wikiGrowUrls(p.url, html), p.url);
    }
    enqueueRanked(
      store,
      chunk.filter((u) => !seen.has(u)),
      source,
    );
  }
  return acc;
}

export async function tickLive(store: KnowStore, limit: number): Promise<TickStats> {
  seedIfEmpty(store);
  const taken = rankFrontierUrls(store.takeFrontier(Math.max(limit, 1)));
  const due = taken.filter((u) => shardOwns(u) && !store.pageFresh(u));
  const wiki = due.filter((u) => wikiActionApiUrl(u));
  const rest = due.filter((u) => !wikiActionApiUrl(u));
  const fromWiki = await ingestWikiApiPages(store, wiki, "live-wiki");
  const origins = new Set<string>();
  for (const url of rest) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      /* ignore */
    }
  }
  if (origins.size) {
    await mapPool([...origins], Math.min(8, origins.size), (origin) => fetchRobots(origin));
  }
  const hostN = new Map<string, number>();
  const waiters: Array<() => void> = [];
  const fetched = await mapPool(rest, LIVE_CONCURRENCY, async (url) => {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      return { url, got: await liveGet(url, { ifModifiedSinceMs: store.pageFetched(url) }) };
    }
    while ((hostN.get(host) ?? 0) >= LIVE_PER_HOST) {
      await new Promise<void>((r) => waiters.push(r));
    }
    hostN.set(host, (hostN.get(host) ?? 0) + 1);
    try {
      return { url, got: await liveGet(url, { ifModifiedSinceMs: store.pageFetched(url) }) };
    } finally {
      hostN.set(host, Math.max(0, (hostN.get(host) ?? 1) - 1));
      waiters.shift()?.();
    }
  });
  let live = fromWiki.live;
  let skipped = fromWiki.skipped;
  let nodes = fromWiki.nodes;
  const sitemapHosts = new Set<string>();
  for (const { url, got } of fetched) {
    if (!got.ok) {
      store.putPage({ url, digest: "", chars: 0, source: "live", ttl_days: 1, skip: got.skip || "fetch" });
      skipped++;
      continue;
    }
    if (got.status === 304) {
      const ttl = ttlDaysFor(url, "", {
        source: "live",
        status: 304,
        unchanged: true,
        prevTtl: store.pageTtlDays(url),
        cacheControl: got.cacheControl,
        lastModified: got.lastModified,
      });
      store.putPage({ url, digest: store.pageDigest(url) || "304", chars: 0, source: "live", ttl_days: ttl });
      live++;
      continue;
    }
    const html = await htmlForExtract(url, got.html);
    const { text, scan } = htmlText(html);
    const r = commitPage(store, url, text.length >= 80 ? text : html, html, "live", true, scan, {
      cacheControl: got.cacheControl,
      lastModified: got.lastModified,
    });
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

export async function tickCapitals(_store: KnowStore): Promise<TickStats> {
  return emptyTick();
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
  const all = WIKI_TOPIC_URLS;
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

/** Random main-namespace Wikipedia articles, then leftover topic seeds. Not a country table. */
export async function tickWikiBatch(store: KnowStore, n = envNum("EDEN_KNOW_WIKI", DEFAULT_WIKI)): Promise<TickStats> {
  seedIfEmpty(store);
  const want = Math.max(0, Math.min(200, n | 0));
  const acc = emptyTick();
  let got = 0;
  while (got < want) {
    const take = Math.min(50, Math.max(1, (want - got) * (shardCount() > 1 ? shardCount() : 1)));
    const pages = await liveWikiRandomBatch(take);
    if (!pages.length) break;
    for (const p of pages) {
      if (store.pageFresh(p.url) || !shardOwns(p.url)) continue;
      const html = `<html><title>${p.title}</title>\n${p.wikitext}\n</html>`;
      const { text, scan } = htmlText(html);
      const r = commitPage(store, p.url, text.length >= 80 ? text : html, html, "wiki-random", true, scan);
      acc.nodes += r.nodes;
      acc.skipped += r.skipped;
      if (!r.skipped) acc.live++;
      enqueueRanked(store, wikiGrowUrls(p.url, html), p.url);
    }
    got += pages.length;
    if (pages.length < take) break;
  }
  if (got < want) {
    const fill = await wikiBatchOnce(store, want - got);
    acc.live += fill.live;
    acc.nodes += fill.nodes;
    acc.skipped += fill.skipped;
  }
  return acc;
}

async function wikiBatchOnce(store: KnowStore, n: number): Promise<TickStats> {
  seedIfEmpty(store);
  const all = WIKI_TOPIC_URLS;
  const todo: string[] = [];
  for (const url of all) {
    if (store.pageDigest(url)) continue;
    todo.push(url);
    if (todo.length >= n) break;
  }
  const due = todo.filter((u) => shardOwns(u) && !store.pageFresh(u));
  if (!due.length) return emptyTick();
  const pages = await liveWikiApiBatch(due);
  let live = 0;
  let skipped = 0;
  let nodes = 0;
  const seen = new Set(pages.map((p) => p.url));
  for (const p of pages) {
    const html = `<html><title>${p.title}</title>\n${p.wikitext}\n</html>`;
    const { text, scan } = htmlText(html);
    const r = commitPage(store, p.url, text.length >= 80 ? text : html, html, "wiki-api", true, scan);
    nodes += r.nodes;
    skipped += r.skipped;
    if (!r.skipped) live++;
    enqueueRanked(store, wikiGrowUrls(p.url, html), p.url);
  }
  enqueueRanked(
    store,
    due.filter((u) => !seen.has(u)),
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
    talkUrl(url) || toolDocsUrl(url) || githubToolUrl(url) || /rfc[-/_]?\d{3,5}/i.test(url) || /\/TR\//i.test(url);
  const talk = SEED_URLS.filter((u) => talkUrl(u));
  const tools = SEED_URLS.filter((u) => toolDocsUrl(u) || githubToolUrl(u));
  const rest = SEED_URLS.filter((u) => want(u) && !talkUrl(u) && !toolDocsUrl(u) && !githubToolUrl(u));
  const ordered = [...talk, ...tools, ...rest];
  const todo: string[] = [];
  for (const url of ordered) {
    if (todo.length >= n) break;
    if (!shardOwns(url) || store.pageFresh(url)) continue;
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
      const have = store.hasWalNodes(url);
      if (have > 0) continue;
    }
    todo.push(url);
  }
  const wikiTodo = todo.filter((u) => wikiActionApiUrl(u));
  const restTodo = todo.filter((u) => !wikiActionApiUrl(u));
  const fromWiki = await ingestWikiApiPages(store, wikiTodo, "seed");
  live += fromWiki.live;
  skipped += fromWiki.skipped;
  nodes += fromWiki.nodes;
  const fetchedPages = await mapPool(restTodo, Math.min(LIVE_CONCURRENCY, Math.max(1, restTodo.length)), async (url) => {
    const got = await liveGet(url, { ifModifiedSinceMs: store.pageFetched(url) });
    return { url, got };
  });
  for (const { url, got } of fetchedPages) {
    if (!got.ok) {
      skipped++;
      continue;
    }
    if (got.status === 304) {
      const ttl = ttlDaysFor(url, "", {
        source: "seed",
        status: 304,
        unchanged: true,
        prevTtl: store.pageTtlDays(url),
        cacheControl: got.cacheControl,
        lastModified: got.lastModified,
      });
      store.putPage({ url, digest: store.pageDigest(url) || "304", chars: 0, source: "seed", ttl_days: ttl });
      live++;
      continue;
    }
    const html = await htmlForExtract(url, got.html);
    const { text, scan } = htmlText(html);
    const r = commitPage(store, url, text.length >= 80 ? text : html, html, "seed", true, scan, {
      cacheControl: got.cacheControl,
      lastModified: got.lastModified,
    });
    nodes += r.nodes;
    skipped += r.skipped;
    if (!r.skipped) {
      live++;
      enqueueRanked(store, wikiGrowUrls(url, html), url);
    }
  }
  return { cc: 0, news: 0, live, feeds: 0, cdx: 0, nodes, skipped };
}

type CdxBundle = {
  fetched: Array<{ recs: Array<{ rec: NonNullable<Awaited<ReturnType<typeof rangeWarc>>> }>; miss: number }>;
  idx: number;
  take: number;
};

async function collectCdx(store: KnowStore, n = envNum("EDEN_KNOW_CDX", DEFAULT_CDX)): Promise<CdxBundle | null> {
  const crawlId = store.getMeta("cc_crawl") || (await latestCrawlId().catch(() => ""));
  const take = Math.max(0, Math.min(32, n | 0));
  if (!crawlId || !take) return null;
  const idx = Number(store.getMeta("cdx_host_idx") || 0);
  const hosts: string[] = [];
  for (let i = 0; i < take; i++) {
    const host = CDX_HOSTS[(idx + i) % CDX_HOSTS.length];
    if (host) hosts.push(host);
  }
  const fetched = await mapPool(hosts, Math.min(8, hosts.length), async (host) => {
    try {
      const hits = await cdxHits(crawlId, host, 4);
      const recs: Array<{ rec: NonNullable<Awaited<ReturnType<typeof rangeWarc>>> }> = [];
      let miss = 0;
      const warcs = await Promise.all(hits.slice(0, 3).map((hit) => rangeWarc(hit)));
      for (const rec of warcs) {
        if (!rec) miss++;
        else recs.push({ rec });
      }
      return { recs, miss };
    } catch {
      return { recs: [], miss: 0 };
    }
  });
  return { fetched, idx, take };
}

function commitCdx(store: KnowStore, bundle: CdxBundle): TickStats {
  return store.crawlBatch(() => {
    let cdx = 0;
    let nodes = 0;
    let skipped = 0;
    for (const got of bundle.fetched) {
      skipped += got.miss;
      for (const { rec } of got.recs) {
        store.setMeta("cdx_ok", "1");
        const isHtml = rec.text.includes("<");
        const scan = isHtml ? scanHtml(rec.text) : undefined;
        const text = scan ? scan.text : rec.text;
        const r = commitPage(store, rec.uri, text, rec.text, "cdx", isHtml, scan);
        nodes += r.nodes;
        skipped += r.skipped;
        cdx++;
      }
    }
    store.setMeta("cdx_host_idx", String((bundle.idx + bundle.take) % CDX_HOSTS.length));
    return { cc: 0, news: 0, live: 0, feeds: 0, cdx, nodes, skipped };
  });
}

export async function tickCdx(store: KnowStore, n = envNum("EDEN_KNOW_CDX", DEFAULT_CDX)): Promise<TickStats> {
  const got = await collectCdx(store, n);
  if (!got) return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
  return commitCdx(store, got);
}

export async function tick(opts?: { cc?: number; news?: number; live?: number; pathIndex?: number; cdx?: number }) {
  const store = openStore();
  try {
    seedIfEmpty(store);
    const tickN = Number(store.getMeta("tick_n") || "0") + 1;
    store.setMeta("tick_n", String(tickN));
    const every = Math.max(1, envNum("EDEN_KNOW_WET_EVERY", DEFAULT_WET_EVERY) | 0);
    const lastWet = Number(store.getMeta("wet_kept") ?? "1");
    const lastNews = Number(store.getMeta("news_kept") ?? "1");
    const lastCdx = Number(store.getMeta("cdx_kept") ?? "1");
    const doWet = expensiveLaneDue(tickN, every, lastWet);
    const doNews = expensiveLaneDue(tickN + 1, every, lastNews);
    const doCdx = expensiveLaneDue(tickN + 2, every, lastCdx);
    const slices = envNum("EDEN_KNOW_CC_SLICES", DEFAULT_CC_SLICES);
    const ccIdx = opts?.pathIndex ?? Number(store.getMeta("cc_idx") || 0);
    const sliceN = Math.max(1, Math.min(6, slices | 0));
    const wetLane = Promise.all([
      doCdx ? collectCdx(store, opts?.cdx ?? envNum("EDEN_KNOW_CDX", DEFAULT_CDX)) : Promise.resolve(null),
      doWet
        ? Promise.all(Array.from({ length: sliceN }, (_, i) => collectCcSlice(store, opts?.cc ?? DEFAULT_CC, ccIdx + i)))
        : Promise.resolve([]),
      doNews
        ? collectNewsRecords(store, opts?.news ?? DEFAULT_NEWS, Number(store.getMeta("news_idx") || 0))
        : Promise.resolve({ recs: [] as Awaited<ReturnType<typeof ingestWetSlice>>, url: undefined as string | undefined }),
    ]);
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
      skipGather(WIKIDATA_SPARQL_URL, "wikidata"),
      tickWikiBatch(store, envNum("EDEN_KNOW_WIKI", DEFAULT_WIKI)),
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
    await tickWikiGrow(store, envNum("EDEN_KNOW_WIKI_GROW", DEFAULT_WIKI_GROW));
    await tickRecrawl(store, envNum("EDEN_KNOW_RECRAWL", DEFAULT_RECRAWL));
    const q = await tickQuality(store, envNum("EDEN_KNOW_QUALITY", DEFAULT_QUALITY));
    const f = await tickFeeds(store);
    const b = await tickLive(store, opts?.live ?? DEFAULT_LIVE);
    console.log(JSON.stringify({ cc: 0, news: 0, live: b.live, feeds: f.feeds, cdx: 0, nodes: b.nodes, skipped: b.skipped, phase: "live" }));
    const [cdxGot, wetGot, newsGot] = await wetLane;
    const x = cdxGot ? commitCdx(store, cdxGot) : emptyTick();
    const a: TickStats = { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
    for (const one of wetGot) {
      const r = commitCcRecords(store, one.recs, one.crawlId, one.url);
      a.cc += r.cc;
      a.nodes += r.nodes;
      a.skipped += r.skipped;
      if (r.crawlId) a.crawlId = r.crawlId;
    }
    const news = commitNewsRecords(store, newsGot.recs, newsGot.url);
    if (doWet) {
      store.setMeta("cc_idx", String((ccIdx + slices) % 10_000));
      store.setMeta("wet_kept", String(a.nodes));
    }
    if (doNews) {
      store.setMeta("news_idx", String((Number(store.getMeta("news_idx") || 0) + 1) % 10_000));
      store.setMeta("news_kept", String(news.nodes));
    }
    if (doCdx) store.setMeta("cdx_kept", String(x.nodes));
    store.expire();
    const wal = store.count().wal_nodes;
    if (compactDue(wal, Number(store.getMeta("compact_at") || 0))) {
      const pub = await compactAndPublish(store);
      store.setMeta("compact_at", String(Date.now()));
      console.log(
        JSON.stringify({
          compact: {
            uploaded: pub.uploaded,
            bytes: pub.bytes,
            skipped: pub.skipped,
            sha256: pub.sha256,
          },
        }),
      );
    }
    const counts = store.count();
    const extraLive = iana.live + spdx.live + whatwg.live + uni.live + lang.live + scripts.live;
    const extraNodes = iana.nodes + spdx.nodes + whatwg.nodes + uni.nodes + lang.nodes + scripts.nodes;
    const extraSkip = iana.skipped + spdx.skipped + whatwg.skipped + uni.skipped + lang.skipped + scripts.skipped;
    return {
      ...a,
      wet: lastWetFetch(),
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

export async function runLoop(opts: {
  intervalSec: number;
  once?: boolean;
  cc?: number;
  live?: number;
  news?: number;
  onStart?: () => void;
}) {
  do {
    const t0 = Date.now();
    opts.onStart?.();
    try {
      const s = await tick({ cc: opts.cc, live: opts.live, news: opts.news });
      console.log(JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, ...s }));
      if (opts.once) return s;
    } catch (e) {
      console.log(JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, err: String(e).slice(0, 200) }));
      if (opts.once) throw e;
    }
    await new Promise((r) => setTimeout(r, Math.max(1_000, opts.intervalSec * 1000 - (Date.now() - t0))));
  } while (true);
}
