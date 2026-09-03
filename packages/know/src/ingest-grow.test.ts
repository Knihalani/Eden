import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptCapitalLabel, noteCapitalLabel, resetAdaptForTest } from "./adapt";
import { canonicalUrl, persistable, triplesFromPage, wikiGrowUrls, wikiActionApiBatchUrl, wikiRevisionPages, ttlDaysFor } from "./extract";
import { FEED_URLS, SEED_URLS, wikiCountryUrls } from "./seed";
import { openStore, FRONTIER_PERSIST, PAGE_PERSIST } from "./store";
import { tickRecrawl, tickWikiGrow } from "./loop";
import { compactDue, DEFAULT_WIKI, DEFAULT_WET_EVERY, expensiveLaneDue, shardOwns } from "./defaults";

const KENYA = "https://en.wikipedia.org/wiki/Kenya";
const LIST = "https://en.wikipedia.org/wiki/List_of_national_capitals";

describe("canonicalUrl", () => {
  test("strips hash, tracking, trailing slash; keeps http", () => {
    expect(canonicalUrl("https://en.wikipedia.org/wiki/Kenya?utm_source=x#Capital")).toBe(
      "https://en.wikipedia.org/wiki/Kenya",
    );
    expect(canonicalUrl("http://www.rfc-editor.org/rfc/rfc3986.html/")).toBe(
      "http://www.rfc-editor.org/rfc/rfc3986.html",
    );
    expect(canonicalUrl("https://example.org/queued")).toBe("https://example.org/queued");
  });
});

describe("adaptive infobox", () => {
  test("seat of government and div infobox-label/data", () => {
    resetAdaptForTest();
    expect(adaptCapitalLabel("Seat of government")).toBe(true);
    const html = `<div class="infobox">
      <div class="infobox-label">Seat of government</div>
      <div class="infobox-data"><a href="/wiki/Nairobi">Nairobi</a></div>
      <div class="infobox-label">ISO 3166 code</div>
      <div class="infobox-data">KE</div>
    </div>`;
    const t = triplesFromPage(KENYA, `<html><title>Kenya</title>${html}<p>Kenya is a country in East Africa with enough text.</p></html>`, true);
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.p === "id" && x.s === "Kenya" && x.o === "KE")).toBe(true);
  });

  test("notes a new capital alias", () => {
    resetAdaptForTest();
    noteCapitalLabel("Royal seat");
    expect(adaptCapitalLabel("Royal seat")).toBe(true);
    expect(adaptCapitalLabel("country")).toBe(false);
  });
});

describe("wiki grow", () => {
  test("country urls from closed table", () => {
    const urls = wikiCountryUrls();
    expect(urls.length).toBeGreaterThan(100);
    expect(urls).toContain("https://en.wikipedia.org/wiki/Kenya");
    expect(urls.every((u) => u.startsWith("https://en.wikipedia.org/wiki/"))).toBe(true);
  });

  test("list page hrefs become article URLs", () => {
    const html = `<a href="/wiki/France">France</a><a href="/wiki/File:Flag.svg">x</a><a href="/wiki/List_of_foo">list</a>`;
    const urls = wikiGrowUrls(LIST, html);
    expect(urls).toContain("https://en.wikipedia.org/wiki/France");
    expect(urls).toContain("https://en.wikipedia.org/wiki/List_of_foo");
    expect(urls.some((u) => /File:/i.test(u))).toBe(false);
  });

  test("wikitext links fan out across topics, not only countries", () => {
    const wt = `Physics is a science. See also [[Quantum mechanics]], [[Chemistry]], and [[File:Atom.svg]].`;
    const urls = wikiGrowUrls("https://en.wikipedia.org/wiki/Physics", wt);
    expect(urls).toContain("https://en.wikipedia.org/wiki/Quantum_mechanics");
    expect(urls).toContain("https://en.wikipedia.org/wiki/Chemistry");
    expect(urls.some((u) => /File:/i.test(u))).toBe(false);
  });
});

describe("feeds", () => {
  test("RFC change feed only — no news/blog", () => {
    expect(FEED_URLS).toEqual(["https://www.rfc-editor.org/rfcrss.xml"]);
    expect(FEED_URLS.some((u) => /nist|nasa|news|blog/i.test(u))).toBe(false);
  });

  test("seeds include wikipedia topics and open academia", () => {
    expect(SEED_URLS.some((u) => u.includes("wikipedia.org") && /Science|Mathematics|Computer_science/.test(u))).toBe(true);
    expect(SEED_URLS.some((u) => u.includes("arxiv.org"))).toBe(true);
    expect(SEED_URLS.some((u) => u.includes("pubmed"))).toBe(true);
    expect(SEED_URLS.some((u) => u.includes("openalex.org"))).toBe(true);
  });
});

describe("ingest overlay", () => {
  test("RFC is object up to 96 chars survives put", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-rfc96-"));
    const s = openStore(dir);
    const o = "The JavaScript Object Notation JSON Data Interchange Format extra title words";
    expect(o.length).toBeGreaterThan(72);
    expect(o.length).toBeLessThanOrEqual(96);
    const url = "https://www.rfc-editor.org/rfc/rfc8259.html";
    const t = { s: "RFC 8259", p: "is" as const, o, e: o };
    expect(persistable(url, t)).toBe(true);
    s.putNodes(url, [t], 365);
    expect(s.search("RFC 8259")[0]?.o).toBe(o);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("stale catalog pages requeue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-stale-"));
    const s = openStore(dir);
    const url = "https://en.wikipedia.org/wiki/Paraguay";
    s.putPage({ url, digest: "abc", chars: 100, source: "live", ttl_days: 0 });
    expect(s.staleUrls(8)).toContain(url);
    await tickRecrawl(s, 8);
    const queued = (s.db.query(`SELECT url FROM frontier`).all() as { url: string }[]).map((r) => r.url);
    expect(queued).toContain(url);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("wiki grow enqueues unseen topic articles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-grow-"));
    const s = openStore(dir);
    await tickWikiGrow(s, 8);
    const queued = (s.db.query(`SELECT url FROM frontier`).all() as { url: string }[]).map((r) => r.url);
    expect(queued.some((u) => /Science|Mathematics|Physics|Computer_science|Medicine/i.test(u))).toBe(true);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("non-catalog robots-ok URLs stay on the frontier", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-open-"));
    const s = openStore(dir);
    const url = "https://notes.example/uri-generic-syntax";
    s.enqueue([url], "live");
    expect(s.count().frontier).toBeGreaterThan(0);
    const queued = (s.db.query(`SELECT url FROM frontier`).all() as { url: string }[]).map((r) => r.url);
    expect(queued).toContain(url);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("compact persist caps keep thousands of URLs", () => {
    expect(FRONTIER_PERSIST).toBeGreaterThanOrEqual(4_096);
    expect(PAGE_PERSIST).toBeGreaterThanOrEqual(4_096);
    expect(FRONTIER_PERSIST).toBeGreaterThanOrEqual(8_000);
  });

  test("compactDue bootstraps once, then waits the interval", () => {
    expect(compactDue(0, 0, 1_000_000)).toBe(false);
    expect(compactDue(64, 0, 1_000)).toBe(true);
    expect(compactDue(64, 1, 1_000)).toBe(false);
    expect(compactDue(64, 1, 900_001)).toBe(true);
    expect(compactDue(900, 1, 200_000)).toBe(false);
  });

  test("shardOwns partitions URLs with no overlap and full cover", () => {
    const urls = Array.from({ length: 200 }, (_, i) => `https://en.wikipedia.org/wiki/Topic_${i}`);
    const a = urls.filter((u) => shardOwns(u, 0, 2));
    const b = urls.filter((u) => shardOwns(u, 1, 2));
    expect(a.length + b.length).toBe(200);
    expect(a.some((u) => b.includes(u))).toBe(false);
    expect(urls.every((u) => shardOwns(u, 0, 1))).toBe(true);
    expect(DEFAULT_WET_EVERY).toBe(3);
    expect(expensiveLaneDue(3, 3, 1)).toBe(true);
    expect(expensiveLaneDue(1, 3, 1)).toBe(false);
    expect(expensiveLaneDue(3, 3, 0)).toBe(false);
    expect(expensiveLaneDue(9, 3, 0)).toBe(true);
  });

  test("ttlDaysFor is host-class, not a crawl budget", () => {
    expect(ttlDaysFor("https://www.rfc-editor.org/rfc/rfc3986.html", "URI Generic Syntax")).toBe(365 * 5);
    expect(ttlDaysFor("https://en.wikipedia.org/wiki/Quantum_mechanics", "operators on Hilbert space")).toBe(90);
    expect(ttlDaysFor("https://arxiv.org/abs/1706.03762", "attention is all you need")).toBe(180);
    expect(ttlDaysFor("https://blog.example/post/today", "published today")).toBe(7);
    expect(ttlDaysFor("https://notes.example/stable-note", "a long enough english page about widgets")).toBe(365);
    expect(ttlDaysFor("https://www.reuters.com/world/asia/story")).toBe(1);
    expect(ttlDaysFor("https://en.wikipedia.org/wiki/Newspaper", "A newspaper is a periodical publication.")).toBe(90);
  });

  test("pageFresh is true only with a fetched digest still in TTL", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-fresh-"));
    const s = openStore(dir);
    const url = "https://www.iana.org/assignments/media-types/media-types.xml";
    expect(s.pageFresh(url)).toBe(false);
    s.putPage({ url, digest: "deadbeefdeadbeef", chars: 100, source: "iana", ttl_days: 365 });
    expect(s.pageFresh(url)).toBe(true);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("wikipedia batch API", () => {
  test("health caps include shard and wetEvery", () => {
    const src = readFileSync(join(import.meta.dir, "worker.ts"), "utf8");
    expect(src).toContain("wetEvery");
    expect(src).toMatch(/shard:\s*shardIndex/);
    expect(src).toMatch(/shards:\s*shardCount/);
  });

  test("batch URL holds many titles on api.php", () => {
    const url = wikiActionApiBatchUrl([
      "https://en.wikipedia.org/wiki/Kenya",
      "https://en.wikipedia.org/wiki/France",
      "https://www.nytimes.com/world",
    ]);
    expect(url).toContain("en.wikipedia.org/w/api.php");
    expect(url).toContain("titles=");
    expect(url).toMatch(/Kenya/);
    expect(url).toMatch(/France/);
    expect(url).not.toMatch(/nytimes/);
  });

  test("batch JSON splits into per-page wikitext", () => {
    const json = {
      query: {
        pages: [
          { title: "Kenya", revisions: [{ slots: { main: { content: "| capital = [[Nairobi]]\n" } } }] },
          { title: "France", revisions: [{ slots: { main: { content: "| capital = [[Paris]]\n" } } }] },
        ],
      },
    };
    const pages = wikiRevisionPages(json);
    expect(pages).toEqual([
      { title: "Kenya", wikitext: "| capital = [[Nairobi]]\n" },
      { title: "France", wikitext: "| capital = [[Paris]]\n" },
    ]);
  });
});
