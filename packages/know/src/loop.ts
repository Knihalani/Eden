import { createHash } from "node:crypto";
import {
  englishEnough,
  extractLinks,
  htmlToText,
  httpBody,
  opinionTrash,
  qualityHost,
  skipHost,
  triplesFromPage,
  ttlDaysFor,
} from "./extract";
import { ingestWetSlice, latestCrawlId, newsWarcPath, wetPath } from "./cc";
import { DEFAULT_CC, DEFAULT_LIVE } from "./defaults";
import { liveGet, liveGetStream, sitemapFrontier } from "./live";
import { feedLinks } from "./feeds";
import { FEED_URLS, SEED_URLS } from "./seed";
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
import { openStore, type KnowStore } from "./store";
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
  const triples = triplesFromPage(url, isHtml ? htmlOrText : text, isHtml);
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

function seedIfEmpty(store: KnowStore) {
  if (store.getMeta("need_reseed") === "1") {
    store.enqueue(SEED_URLS, "seed");
    store.setMeta("need_reseed", "0");
    store.setMeta("seeded", "1");
    return;
  }
  if (store.getMeta("seeded")) return;
  store.enqueue(SEED_URLS, "seed");
  store.setMeta("seeded", "1");
}

export async function tickCc(store: KnowStore, limit: number, pathIndex = 0): Promise<TickStats> {
  try {
    const crawlId = (await latestCrawlId().catch(() => store.getMeta("cc_crawl"))) || "";
    if (!crawlId) return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
    const url = await wetPath(crawlId, pathIndex);
    store.setMeta("cc_crawl", crawlId);
    store.setMeta("cc_wet", url);
    const recs = await ingestWetSlice(url, limit);
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

export async function tickNews(store: KnowStore, limit: number, pathIndex = 0): Promise<TickStats> {
  let skipped = 0;
  let nodes = 0;
  let news = 0;
  try {
    const url = await newsWarcPath(pathIndex);
    store.setMeta("cc_news", url);
    const recs = await ingestWetSlice(url, limit);
    news = recs.length;
    for (const rec of recs) {
      const body = httpBody(rec.text);
      const text = body.includes("<") ? htmlToText(body) : body;
      const r = commitPage(store, rec.uri, text, body, "cc-news", body.includes("<"));
      nodes += r.nodes;
      skipped += r.skipped;
    }
  } catch {
    /* month listing can 404; CC-MAIN still runs */
  }
  return { cc: 0, news, live: 0, feeds: 0, cdx: 0, nodes, skipped };
}

export async function tickFeeds(store: KnowStore, n = 2): Promise<TickStats> {
  const idx = Number(store.getMeta("feed_idx") || 0);
  let feeds = 0;
  for (let i = 0; i < n; i++) {
    const url = FEED_URLS[(idx + i) % FEED_URLS.length];
    if (!url) continue;
    const got = await liveGet(url);
    if (!got.ok) continue;
    const links = feedLinks(got.html).filter((u) => !skipHost(u) && u !== url);
    store.enqueue(links, url);
    feeds++;
  }
  store.setMeta("feed_idx", String((idx + n) % FEED_URLS.length));
  return { cc: 0, news: 0, live: 0, feeds, cdx: 0, nodes: 0, skipped: 0 };
}

export async function tickLive(store: KnowStore, limit: number): Promise<TickStats> {
  seedIfEmpty(store);
  const urls = store.takeFrontier(limit);
  let live = 0;
  let skipped = 0;
  let nodes = 0;
  for (const url of urls) {
    const got = await liveGet(url);
    if (!got.ok) {
      store.putPage({ url, digest: "", chars: 0, source: "live", ttl_days: 1, skip: got.skip || "fetch" });
      skipped++;
      continue;
    }
    const text = htmlToText(got.html);
    const r = commitPage(store, url, text.length >= 80 ? text : got.html, got.html, "live", true);
    nodes += r.nodes;
    skipped += r.skipped;
    if (r.skipped) continue;
    live++;
    store.enqueue(extractLinks(url, got.html).filter((u) => !skipHost(u)), url);
    try {
      const host = new URL(url).host;
      const smKey = `sitemap:${host}`;
      if (!store.getMeta(smKey)) {
        store.setMeta(smKey, "1");
        store.enqueue(await sitemapFrontier(new URL(url).origin), url);
      }
    } catch {
      /* ignore */
    }
  }
  return { cc: 0, news: 0, live, feeds: 0, cdx: 0, nodes, skipped };
}

function emptyTick(): TickStats {
  return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
}

function commitCatalog(store: KnowStore, url: string, source: string, digestHex: string, chars: number, triples: Triple[]): TickStats {
  if (store.pageDigest(url) === digestHex) return emptyTick();
  if (!triples.length) return { ...emptyTick(), skipped: 1 };
  const before = (store.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  store.putPage({ url, digest: digestHex, chars, source, ttl_days: 365 });
  store.putNodes(url, triples, 365 * 5);
  store.bumpHost(url, true);
  const after = (store.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  return { ...emptyTick(), live: 1, nodes: Math.max(0, after - before) };
}

export async function tickRfcIndex(store: KnowStore): Promise<TickStats> {
  const parser = makeRfcIndexParser();
  const got = await liveGetStream(RFC_INDEX_URL, {
    timeoutMs: 45_000,
    accept: "application/xml,text/xml,*/*;q=0.1",
    onChunk: (s) => parser.push(s),
  });
  if (!got.ok) return { ...emptyTick(), skipped: 1 };
  const triples = parser.finish();
  return commitCatalog(store, RFC_INDEX_URL, "rfc-index", got.digest, got.chars, triples);
}

export async function tickW3Catalog(store: KnowStore): Promise<TickStats> {
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
  if (!pages.length) return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 1 };
  const blob = raw.join("\n");
  const d = digest(blob);
  if (store.pageDigest(W3_CATALOG_URL) === d) {
    return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
  }
  const triples = parseW3Catalog(pages);
  if (!triples.length) return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 1 };
  const before = (store.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  store.putPage({
    url: W3_CATALOG_URL,
    digest: d,
    chars: blob.length,
    source: "w3-catalog",
    ttl_days: 365,
  });
  store.putNodes(W3_CATALOG_URL, triples, 365 * 5);
  store.bumpHost(W3_CATALOG_URL, true);
  const after = (store.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  return { cc: 0, news: 0, live: 1, feeds: 0, cdx: 0, nodes: Math.max(0, after - before), skipped: 0 };
}

const IETF_UPDATES_CATALOG = `${IETF_RELATED_URL}&relationship=updates`;

export async function tickIetfRelated(store: KnowStore): Promise<TickStats> {
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
  if (!pages.length) return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 1 };
  const blob = raw.join("\n");
  const d = digest(blob);
  if (store.pageDigest(IETF_UPDATES_CATALOG) === d) {
    return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 0 };
  }
  const triples = parseRelatedDocs(pages, "updates");
  if (!triples.length) return { cc: 0, news: 0, live: 0, feeds: 0, cdx: 0, nodes: 0, skipped: 1 };
  const before = (store.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  store.putPage({
    url: IETF_UPDATES_CATALOG,
    digest: d,
    chars: blob.length,
    source: "ietf-related",
    ttl_days: 365,
  });
  store.putNodes(IETF_UPDATES_CATALOG, triples, 365 * 5);
  store.bumpHost(IETF_UPDATES_CATALOG, true);
  const after = (store.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  return { cc: 0, news: 0, live: 1, feeds: 0, cdx: 0, nodes: Math.max(0, after - before), skipped: 0 };
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
  const got = await liveGet(SPDX_LICENSE_URL, { timeoutMs: 20_000, accept: "application/json" });
  if (!got.ok) return { ...emptyTick(), skipped: 1 };
  let json: unknown;
  try {
    json = JSON.parse(got.html);
  } catch {
    return { ...emptyTick(), skipped: 1 };
  }
  return commitCatalog(store, SPDX_LICENSE_URL, "spdx", digest(got.html), got.html.length, parseSpdxLicenses(json));
}

export async function tickWhatwg(store: KnowStore): Promise<TickStats> {
  const got = await liveGet(WHATWG_DB_URL, { timeoutMs: 20_000, accept: "application/json" });
  if (!got.ok) return { ...emptyTick(), skipped: 1 };
  let json: unknown;
  try {
    json = JSON.parse(got.html);
  } catch {
    return { ...emptyTick(), skipped: 1 };
  }
  return commitCatalog(store, WHATWG_DB_URL, "whatwg", digest(got.html), got.html.length, parseWhatwgDb(json));
}

export async function tickUnicode(store: KnowStore): Promise<TickStats> {
  const got = await liveGet(UNICODE_BLOCKS_URL, { timeoutMs: 20_000, accept: "text/plain,*/*;q=0.1" });
  if (!got.ok) return { ...emptyTick(), skipped: 1 };
  return commitCatalog(
    store,
    UNICODE_BLOCKS_URL,
    "unicode",
    digest(got.html),
    got.html.length,
    parseUnicodeBlocks(got.html),
  );
}

export async function tickLangTags(store: KnowStore): Promise<TickStats> {
  const got = await liveGet(LANG_SUBTAG_URL, { timeoutMs: 45_000, accept: "text/plain,*/*;q=0.1" });
  if (!got.ok) return { ...emptyTick(), skipped: 1 };
  return commitCatalog(
    store,
    LANG_SUBTAG_URL,
    "langtags",
    digest(got.html),
    got.html.length,
    parseLangSubtags(got.html),
  );
}

export async function tickScripts(store: KnowStore): Promise<TickStats> {
  const got = await liveGet(UNICODE_SCRIPTS_URL, { timeoutMs: 20_000, accept: "text/plain,*/*;q=0.1" });
  if (!got.ok) return { ...emptyTick(), skipped: 1 };
  return commitCatalog(
    store,
    UNICODE_SCRIPTS_URL,
    "scripts",
    digest(got.html),
    got.html.length,
    parseUnicodeScripts(got.html),
  );
}

export async function tickQuality(store: KnowStore, n = 3): Promise<TickStats> {
  seedIfEmpty(store);
  let live = 0;
  let skipped = 0;
  let nodes = 0;
  let fetched = 0;
  for (const url of SEED_URLS) {
    if (fetched >= n) break;
    if (!/rfc[-/_]?\d{3,5}/i.test(url) && !/\/TR\//i.test(url)) continue;
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
    fetched++;
    const got = await liveGet(url);
    if (!got.ok) {
      skipped++;
      continue;
    }
    const text = htmlToText(got.html);
    const r = commitPage(store, url, text.length >= 80 ? text : got.html, got.html, "seed", true);
    nodes += r.nodes;
    skipped += r.skipped;
    if (!r.skipped) live++;
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
        const text = rec.text.includes("<") ? htmlToText(rec.text) : rec.text;
        const r = commitPage(store, rec.uri, text, rec.text, "cdx", rec.text.includes("<"));
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
    const idx = await tickRfcIndex(store);
    const w3 = await tickW3Catalog(store);
    const rel = await tickIetfRelated(store);
    const iana = await tickIana(store);
    const spdx = await tickSpdx(store);
    const whatwg = await tickWhatwg(store);
    const uni = await tickUnicode(store);
    const lang = await tickLangTags(store);
    const scripts = await tickScripts(store);
    const q = await tickQuality(store, 5);
    const a = await tickCc(store, opts?.cc ?? DEFAULT_CC, opts?.pathIndex ?? Number(store.getMeta("cc_idx") || 0));
    const x = await tickCdx(store, 2);
    const f = await tickFeeds(store);
    const b = await tickLive(store, opts?.live ?? DEFAULT_LIVE);
    store.setMeta("cc_idx", String((Number(store.getMeta("cc_idx") || 0) + 1) % 10_000));
    store.expire();
    if (store.count().wal_nodes >= 1024) store.compact();
    const counts = store.count();
    const extraLive = iana.live + spdx.live + whatwg.live + uni.live + lang.live + scripts.live;
    const extraNodes = iana.nodes + spdx.nodes + whatwg.nodes + uni.nodes + lang.nodes + scripts.nodes;
    const extraSkip = iana.skipped + spdx.skipped + whatwg.skipped + uni.skipped + lang.skipped + scripts.skipped;
    return {
      ...a,
      news: 0,
      live: b.live + q.live + idx.live + w3.live + rel.live + extraLive,
      feeds: f.feeds,
      cdx: x.cdx,
      nodes: a.nodes + b.nodes + x.nodes + q.nodes + idx.nodes + w3.nodes + rel.nodes + extraNodes,
      skipped: a.skipped + b.skipped + x.skipped + q.skipped + idx.skipped + w3.skipped + rel.skipped + extraSkip,
      counts,
    };
  } finally {
    store.close();
  }
}

export async function runLoop(opts: { intervalSec: number; once?: boolean; cc?: number; live?: number }) {
  do {
    const t0 = Date.now();
    try {
      const s = await tick({ cc: opts.cc, live: opts.live });
      console.log(JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, ...s }));
      if (opts.once) return s;
    } catch (e) {
      console.log(JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, err: String(e).slice(0, 200) }));
      if (opts.once) throw e;
    }
    await new Promise((r) => setTimeout(r, Math.max(5_000, opts.intervalSec * 1000 - (Date.now() - t0))));
  } while (true);
}
