import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptCapitalLabel, noteCapitalLabel, resetAdaptForTest } from "./adapt";
import { canonicalUrl, persistable, triplesFromPage, wikiGrowUrls, wikiActionApiBatchUrl, wikiRevisionPages } from "./extract";
import { FEED_URLS, SEED_URLS, wikiCountryUrls } from "./seed";
import { openStore, FRONTIER_PERSIST, PAGE_PERSIST } from "./store";
import { tickRecrawl, tickWikiGrow } from "./loop";
import { compactDue } from "./defaults";

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
    expect(urls.some((u) => /File:/i.test(u))).toBe(false);
    expect(urls.some((u) => /List_of_foo/i.test(u))).toBe(false);
  });
});

describe("feeds", () => {
  test("RFC change feed only — no news/blog", () => {
    expect(FEED_URLS).toEqual(["https://www.rfc-editor.org/rfcrss.xml"]);
    expect(FEED_URLS.some((u) => /nist|nasa|news|blog/i.test(u))).toBe(false);
  });

  test("seeds include wikipedia and open academia", () => {
    expect(SEED_URLS.some((u) => u.includes("wikipedia.org"))).toBe(true);
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

  test("wiki grow enqueues unseen country articles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-grow-"));
    const s = openStore(dir);
    await tickWikiGrow(s, 8);
    const queued = (s.db.query(`SELECT url FROM frontier`).all() as { url: string }[]).map((r) => r.url);
    expect(queued.some((u) => /Ivory_Coast|Madagascar|Andorra|Yemen/.test(u))).toBe(true);
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

  test("compactDue waits, then forces at a large WAL", () => {
    expect(compactDue(0, 0, 1_000_000)).toBe(false);
    expect(compactDue(16, 0, 1_000)).toBe(false);
    expect(compactDue(16, 0, 200_000)).toBe(true);
    expect(compactDue(512, 199_000, 200_000)).toBe(true);
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
