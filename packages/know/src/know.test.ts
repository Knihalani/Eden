import { describe, expect, test } from "bun:test";
import { robotsAllows, robotsCrawlDelaySec, robotsSitemaps, robotsTxtForHttpStatus, sitemapLocs } from "./robots";
import { htmlToText, httpBody, jsonLdBlocks, looksLikeCode, persistable, qualityHost, skipHost, triplesFromPage } from "./extract";
import { cheapSkip } from "./gate";
import { feedLinks } from "./feeds";
import { parseCdxLine } from "./cdx";
import { parseRfcIndex } from "./rfc-index";
import { parseW3Catalog } from "./w3-catalog";
import { parseRelatedDocs } from "./ietf-related";
import { englishTrigram } from "./lang";
import { formatCard } from "./query";
import { knowCli } from "./cli";
import { pushWarc } from "./warc";
import { encodePack, encodePackV1, decodePack } from "./pack";
import { parseIanaXml } from "./iana";
import { parseSpdxLicenses } from "./spdx";
import { parseWhatwgDb } from "./whatwg";
import { parseUnicodeBlocks } from "./unicode";
import { parseLangSubtags } from "./langtags";
import { parseUnicodeScripts } from "./scripts";
import { EDENBOT } from "./ua";
import { openStore } from "./store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("robots RFC 9309", () => {
  test("disallow slash", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /\n", "Edenbot", "/x")).toBe(false);
  });
  test("allow longer than disallow", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /\nAllow: /p\n", "Edenbot", "/p/x")).toBe(true);
  });
  test("empty disallow allows", () => {
    expect(robotsAllows("User-agent: *\nDisallow:\n", "Edenbot", "/")).toBe(true);
  });
  test("crawl-delay on matching group", () => {
    expect(robotsCrawlDelaySec("User-agent: *\nCrawl-delay: 2.5\n", "Edenbot")).toBe(2.5);
  });
  test("5xx robots is total disallow; 4xx is open", () => {
    expect(robotsAllows(robotsTxtForHttpStatus(503), "Edenbot", "/")).toBe(false);
    expect(robotsAllows(robotsTxtForHttpStatus(404), "Edenbot", "/")).toBe(true);
  });
  test("sitemaps", () => {
    expect(robotsSitemaps("Sitemap: https://example.org/sitemap.xml\n")).toEqual([
      "https://example.org/sitemap.xml",
    ]);
    expect(sitemapLocs("<urlset><url><loc>https://example.org/a</loc></url></urlset>")).toEqual([
      "https://example.org/a",
    ]);
  });
});

describe("extract", () => {
  test("skips wikipedia family", () => {
    expect(skipHost("https://en.wikipedia.org/wiki/Kenya")).toBe("wikipedia-out");
    expect(skipHost("https://www.wikidata.org/wiki/Q1")).toBe("wikipedia-out");
  });
  test("skips paywall hosts", () => {
    expect(skipHost("https://www.nytimes.com/2026/01/01/x")).toBe("paywall-host");
  });
  test("quality urls include unicode and whatwg github", () => {
    expect(qualityHost("https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt")).toBe(true);
    expect(qualityHost("https://github.com/whatwg/sg/raw/main/db.json")).toBe(true);
    expect(qualityHost("https://github.com/other/repo")).toBe(false);
  });
  test("http body strips status line", () => {
    expect(httpBody("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>ok</html>")).toBe("<html>ok</html>");
  });
  test("rss/atom links", () => {
    expect(
      feedLinks(
        `<rss><item><link>https://example.org/a</link></item></rss><feed><link href="https://example.org/b" /></feed>`,
      ),
    ).toEqual(["https://example.org/b", "https://example.org/a"]);
  });
  test("code is not a fact", () => {
    const html = `<p>async function addMetadata(){ const cssRules = 1; }</p>`;
    const t = triplesFromPage("https://example.org/js", html, true);
    expect(t.every((x) => x.p !== "about" || !looksLikeCode(x.o))).toBe(true);
    expect("unknown" in formatCard("x", [{ s: "h", p: "about", o: "async function addMetadata(){ cssRules }", e: "x" }])).toBe(true);
  });
  test("json-ld triples", () => {
    const html = `<html><title>JSON-LD 1.1</title><script type="application/ld+json">{"@type":"TechArticle","name":"JSON-LD 1.1","description":"A JSON-based serialization for Linked Data."}</script><h1>JSON-LD 1.1</h1><p>body text for extract</p></html>`;
    const t = triplesFromPage("https://www.w3.org/TR/json-ld11/", html, true);
    expect(t.some((x) => /JSON-LD/i.test(x.s) || /JSON-LD/i.test(x.o))).toBe(true);
    expect(htmlToText(html).includes("body")).toBe(true);
    expect(jsonLdBlocks(html).length).toBe(1);
  });
  test("w3 tr title is persistable", () => {
    const t = triplesFromPage(
      "https://www.w3.org/TR/web-share/",
      `<html><title>Web Share API</title><h1>Web Share API</h1><div id="abstract"><p>This specification defines an API for sharing text, links and other content to an arbitrary destination of the user's choice.</p></div></html>`,
      true,
    );
    expect(t.some((x) => x.p === "is" && /web-share/i.test(x.s) && /Share/i.test(x.o))).toBe(true);
  });
  test("rfc index skips obsoleted and keeps current titles", () => {
    const xml = `<?xml version="1.0"?>
<rfc-index>
<rfc-entry><doc-id>RFC2616</doc-id><title>Hypertext Transfer Protocol -- HTTP/1.1</title><current-status>DRAFT STANDARD</current-status><obsoleted-by><doc-id>RFC7230</doc-id></obsoleted-by></rfc-entry>
<rfc-entry><doc-id>RFC3986</doc-id><title>Uniform Resource Identifier (URI): Generic Syntax</title><current-status>INTERNET STANDARD</current-status></rfc-entry>
<rfc-entry><doc-id>RFC9110</doc-id><title>HTTP Semantics</title><current-status>INTERNET STANDARD</current-status><obsoletes><doc-id>RFC7231</doc-id></obsoletes></rfc-entry>
<rfc-entry><doc-id>RFC0000</doc-id><title>Not Issued</title><current-status>NOT ISSUED</current-status></rfc-entry>
</rfc-index>`;
    const t = parseRfcIndex(xml);
    expect(t.some((x) => x.s === "RFC 3986" && /URI/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 9110" && x.p === "obsoletes" && /7231/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 2616")).toBe(false);
  });
  test("iana spdx whatwg catalogs are typed is-facts", () => {
    const proto = parseIanaXml(
      `<record><value>6</value><name>TCP</name><description>Transmission Control</description></record>
       <record><value>99</value><name>Unassigned</name></record>`,
      "protocol",
    );
    expect(proto).toEqual([{ s: "IANA protocol 6", p: "is", o: "TCP", e: "Transmission Control" }]);
    expect(persistable("https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xml", proto[0]!)).toBe(true);
    const http = parseIanaXml(`<record><value>404</value><description>Not Found</description></record>`, "http");
    expect(http[0]?.s).toBe("IANA http 404");
    const media = parseIanaXml(
      `<record><name>json</name><file type="template">application/json</file></record>`,
      "media",
    );
    expect(media[0]?.s).toBe("IANA media application/json");
    expect(media[0]?.o).toBe("JSON");
    const spdx = parseSpdxLicenses({
      licenses: [
        { licenseId: "MIT", name: "MIT License", isDeprecatedLicenseId: false },
        { licenseId: "Old", name: "Old License", isDeprecatedLicenseId: true },
      ],
    });
    expect(spdx).toEqual([{ s: "SPDX MIT", p: "is", o: "MIT License", e: "" }]);
    expect(persistable("https://spdx.org/licenses/licenses.json", spdx[0]!)).toBe(true);
    const whatwg = parseWhatwgDb({
      workstreams: [{ standards: [{ name: "HTML", href: "https://html.spec.whatwg.org/multipage/", reference: "HTML" }] }],
    });
    expect(whatwg[0]?.s).toBe("WHATWG html");
    expect(whatwg[0]?.o).toContain("HTML");
    const blocks = parseUnicodeBlocks("# Blocks-16.0.0.txt\n0000..007F; Basic Latin\n0080..00FF; Latin-1 Supplement\n");
    expect(blocks[0]).toEqual({ s: "Unicode Block Basic Latin", p: "is", o: "U+0000..U+007F", e: "" });
    expect(persistable("https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt", blocks[0]!)).toBe(true);
    const langs = parseLangSubtags("%%\nType: language\nSubtag: en\nDescription: English\n%%\nType: language\nSubtag: zxx\nDescription: No linguistic content\nScope: special\n");
    expect(langs).toEqual([{ s: "IANA language en", p: "is", o: "English", e: "" }]);
    expect(persistable("https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry", langs[0]!)).toBe(true);
    const methods = parseIanaXml(`<record><value>GET</value><description>Transfer a current representation</description></record>`, "method");
    expect(methods[0]?.s).toBe("IANA method GET");
    const methodsXml = parseIanaXml(
      `<record><value>GET</value><safe>yes</safe><idempotent>yes</idempotent><xref type="rfc" data="rfc9110" section="9.3.1"/></record>`,
      "method",
    );
    expect(methodsXml[0]?.o).toBe("safe, idempotent, RFC 9110");
    const getCard = formatCard("GET", methodsXml);
    expect("fact" in getCard && (getCard as { fact: string }).fact).toMatch(/IANA method GET is/);
    const sc = parseUnicodeScripts("sc ; Latn ; Latin\nsc ; Zzzz ; Unknown\n");
    expect(sc[0]).toEqual({ s: "Unicode Script Latn", p: "is", o: "Latin", e: "" });
    const cs = parseIanaXml(`<record><name>UTF-8</name><preferred_alias>utf-8</preferred_alias></record>`, "charset");
    expect(cs[0]?.s).toBe("IANA charset utf-8");
    expect(persistable("https://www.iana.org/assignments/character-sets/character-sets.xml", cs[0]!)).toBe(true);
    const hdr = parseIanaXml(`<record><name>Accept</name><status>permanent</status><description>Media types</description></record>`, "header");
    expect(hdr[0]?.s).toBe("IANA header Accept");
    const dns = parseIanaXml(`<record><type>AAAA</type><meaning>IP6 Address</meaning></record>`, "dns");
    expect(dns[0]?.s).toBe("IANA dns AAAA");
    expect("fact" in formatCard("IANA protocol 6", proto)).toBe(true);
    expect("fact" in formatCard("SPDX MIT", spdx)).toBe(true);
  });
  test("w3 catalog uses shortname subjects", () => {
    const t = parseW3Catalog([
      {
        _links: {
          specifications: [
            { href: "https://api.w3.org/specifications/web-share", title: "Web Share API" },
            { href: "https://api.w3.org/specifications/encoding", title: "Encoding Standard" },
          ],
        },
      },
    ]);
    expect(t.some((x) => x.s === "W3C web-share" && /Share/i.test(x.o))).toBe(true);
    expect(persistable("https://api.w3.org/specifications", t[0]!)).toBe(true);
  });
  test("ietf related folds updates per source rfc", () => {
    const t = parseRelatedDocs(
      [
        {
          objects: [
            { source: "/api/v1/doc/document/rfc9110/", target: "/api/v1/doc/document/rfc7230/" },
            { source: "/api/v1/doc/document/rfc9110/", target: "/api/v1/doc/document/rfc7231/" },
            { source: "/api/v1/doc/document/draft-x/", target: "/api/v1/doc/document/rfc80/" },
          ],
        },
      ],
      "updates",
    );
    expect(t.some((x) => x.s === "RFC 9110" && x.p === "updates" && /7230/.test(x.o) && /7231/.test(x.o))).toBe(true);
    expect(t.some((x) => /draft/i.test(x.s))).toBe(false);
    expect(persistable("https://datatracker.ietf.org/api/v1/doc/relateddocument/", t[0]!)).toBe(true);
  });
  test("rfc url becomes typed is-fact", () => {
    const t = triplesFromPage(
      "https://www.rfc-editor.org/rfc/rfc9309.html",
      "RFC 9309: Robots Exclusion Protocol. This document specifies a protocol.",
      false,
    );
    expect(t.some((x) => x.s === "RFC 9309" && x.p === "is")).toBe(true);
  });
  test("news dates are not persistable", () => {
    expect(
      persistable("https://www.nasa.gov/", {
        s: "NASA",
        p: "date",
        o: "2022-12-07",
        e: "x",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.rfc-editor.org/rfc/rfc9309.html", {
        s: "RFC 9309",
        p: "is",
        o: "Robots Exclusion Protocol",
        e: "RFC 9309: Robots Exclusion Protocol",
      }),
    ).toBe(true);
  });
});

describe("warc", () => {
  test("parses a conversion record", () => {
    const body = "The capital of France is Paris. France is a country.";
    const rec =
      `WARC/1.0\r\nWARC-Type: conversion\r\nWARC-Target-URI: https://example.org/fr\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const out: { uri: string; text: string }[] = [];
    pushWarc(rec, out, 5);
    expect(out[0]?.uri).toBe("https://example.org/fr");
    expect(out[0]?.text).toContain("Paris");
  });
});

describe("store", () => {
  test("round trip nodes and crush expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-"));
    const s = openStore(dir);
    s.putNodes("https://example.org/a", [{ s: "France", p: "capital", o: "Paris", e: "The capital of France is Paris." }], 30);
    const hits = s.search("France capital");
    expect(hits[0]?.o).toBe("Paris");
    s.db.run(`UPDATE nodes SET as_of = 0, ttl_days = 1`);
    s.expire(Date.now());
    const crushed = (s.db.query(`SELECT COUNT(*) AS n FROM evidence`).get() as { n: number }).n;
    expect(crushed).toBe(0);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("posting search and skip rows not stored", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-"));
    const s = openStore(dir);
    s.putPage({ url: "https://spam.example/x", digest: "abc", chars: 10, source: "cc", ttl_days: 1, skip: "language" });
    expect((s.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(0);
    expect(s.pageDigest("https://spam.example/x")).toBe("abc");
    s.putNodes("https://example.org/a", [{ s: "France", p: "capital", o: "Paris", e: "The capital of France is Paris." }], 30);
    expect(s.search("France")[0]?.o).toBe("Paris");
    expect(s.search("RFC 3986").length).toBe(0);
    const posts = (s.db.query(`SELECT COUNT(*) AS n FROM post`).get() as { n: number }).n;
    expect(posts).toBeGreaterThan(0);
    s.putPage({ url: "https://spam.example/kept", digest: "zzz", chars: 10, source: "cc", ttl_days: 1 });
    expect((s.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(0);
    s.putPage({ url: "https://www.rfc-editor.org/rfc/rfc9309.html", digest: "ok", chars: 10, source: "seed", ttl_days: 1 });
    expect((s.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(1);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("intern shares predicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-"));
    const s = openStore(dir);
    s.putNodes("https://example.org/a", [
      { s: "France", p: "capital", o: "Paris", e: "The capital of France is Paris." },
      { s: "Kenya", p: "capital", o: "Nairobi", e: "The capital of Kenya is Nairobi." },
    ], 30);
    const n = (s.db.query(`SELECT COUNT(*) AS n FROM intern WHERE s = 'capital'`).get() as { n: number }).n;
    expect(n).toBe(1);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM intern WHERE s = 'france'`).get() as { n: number }).n).toBe(0);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM lex WHERE t = 'france'`).get() as { n: number }).n).toBe(1);
    expect(s.schemaVersion()).toBeGreaterThanOrEqual(10);
    expect((s.db.query(`PRAGMA table_info(pages)`).all() as { name: string }[]).some((c) => c.name === "skip")).toBe(false);
    s.putNodes("https://example.org/dump", [{ s: "x", p: "about", o: "a long page title dump", e: "nope" }], 30);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM nodes WHERE url = 'https://example.org/dump'`).get() as { n: number }).n).toBe(0);
    s.putNodes("https://www.rfc-editor.org/rfc/rfc9309.html", [{
      s: "RFC 9309",
      p: "is",
      o: "Robots Exclusion Protocol RFC 9309 Robots Exclusion Protocol (REP) Sept",
      e: "x",
    }], 30);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM nodes WHERE url LIKE '%rfc9309%'`).get() as { n: number }).n).toBe(0);
    s.putNodes("https://www.rfc-editor.org/rfc/rfc3986.html", [
      { s: "RFC 3986", p: "is", o: "URI Generic Syntax first", e: "RFC 3986 URI Generic Syntax first" },
    ], 30);
    s.putNodes("https://datatracker.ietf.org/doc/html/rfc3986", [
      { s: "RFC 3986", p: "is", o: "URI Generic Syntax other host", e: "RFC 3986 URI Generic Syntax other host" },
    ], 30);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM nodes n JOIN intern s ON s.id = n.sid WHERE s.s = 'RFC 3986'`).get() as { n: number }).n).toBe(1);
    s.putNodes("https://www.rfc-editor.org/rfc-index.xml", [
      { s: "RFC 2119", p: "is", o: "Key words for use in RFCs", e: "" },
    ], 30);
    s.putNodes("https://www.rfc-editor.org/rfc/rfc2119.html", [
      { s: "RFC 2119", p: "is", o: "Key words MUST SHOULD", e: "RFC 2119: Key words for use in RFCs to Indicate Requirement Levels" },
    ], 30);
    const upgraded = s.search("RFC 2119")[0];
    expect(upgraded?.o).toContain("MUST");
    expect(upgraded?.e).toContain("Requirement");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("catalog aliases hit sqlite before compact", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-"));
    const s = openStore(dir);
    s.putNodes("https://www.iana.org/assignments/media-types/media-types.xml", [
      { s: "IANA media application/json", p: "is", o: "JSON", e: "" },
      { s: "SPDX JSON", p: "is", o: "JSON License", e: "" },
    ], 30);
    s.putNodes("https://www.iana.org/assignments/http-methods/http-methods.xml", [
      { s: "IANA method GET", p: "is", o: "safe, idempotent, RFC 9110", e: "" },
    ], 30);
    expect(s.search("json")[0]?.s).toBe("IANA media application/json");
    expect(s.search("GET")[0]?.s).toBe("IANA method GET");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("kpk pack answers without sqlite intern", () => {
    const facts = [
      { s: "France", p: "capital", o: "Paris", e: "The capital of France is Paris.", url: "https://example.org/a" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "https://example.org/rfc" },
      { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "https://example.org/w3" },
      { s: "RFC 9110", p: "obsoletes", o: "RFC 7230, RFC 7231", e: "", url: "https://example.org/rfc" },
      { s: "RFC 872", p: "is", o: "TCP-on-a-LAN", e: "", url: "https://example.org/rfc" },
      { s: "IANA protocol 6", p: "is", o: "TCP", e: "Transmission Control", url: "https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xml" },
      { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "https://www.iana.org/assignments/media-types/media-types.xml" },
      { s: "IANA http 404", p: "is", o: "Not Found", e: "", url: "https://www.iana.org/assignments/http-status-codes/http-status-codes.xml" },
      { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "https://spdx.org/licenses/licenses.json" },
      { s: "Unicode Block Basic Latin", p: "is", o: "U+0000..U+007F", e: "", url: "https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt" },
      { s: "IANA language en", p: "is", o: "English", e: "", url: "https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry" },
      { s: "IANA method GET", p: "is", o: "Transfer a current representation", e: "", url: "https://www.iana.org/assignments/http-methods/http-methods.xml" },
      { s: "Unicode Script Latn", p: "is", o: "Latin", e: "", url: "https://www.unicode.org/Public/UCD/latest/ucd/PropertyValueAliases.txt" },
    ];
    const buf = encodePack(facts);
    const p = decodePack(buf);
    expect(p.search("France capital")[0]?.o).toBe("Paris");
    expect(p.search("RFC 3986")[0]?.o).toContain("URI");
    expect(p.search("web share")[0]?.s).toBe("W3C web-share");
    expect(p.search("RFC 9110")[0]?.o).toContain("7230");
    expect(p.search("TCP")[0]?.s).toBe("IANA protocol 6");
    expect(p.search("application/json")[0]?.s).toBe("IANA media application/json");
    expect(p.search("json")[0]?.s).toBe("IANA media application/json");
    const collide = decodePack(
      encodePack([
        { s: "SPDX JSON", p: "is", o: "JSON License", e: "", url: "https://spdx.org/licenses/licenses.json" },
        { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "https://www.iana.org/assignments/media-types/media-types.xml" },
      ]),
    );
    expect(collide.search("json")[0]?.s).toBe("IANA media application/json");
    expect(p.search("404")[0]?.s).toBe("IANA http 404");
    expect(p.search("MIT")[0]?.s).toBe("SPDX MIT");
    expect(p.search("URI Generic Syntax")[0]?.s).toBe("RFC 3986");
    expect(p.search("Basic Latin")[0]?.s).toBe("Unicode Block Basic Latin");
    expect(p.search("3986")[0]?.s).toBe("RFC 3986");
    expect(p.search("English")[0]?.s).toBe("IANA language en");
    expect(p.search("rfc3986")[0]?.s).toBe("RFC 3986");
    expect(p.search("GET")[0]?.s).toBe("IANA method GET");
    expect(p.search("Latn")[0]?.s).toBe("Unicode Script Latn");
    expect(p.search("Latin")[0]?.s).toBe("Unicode Script Latn");
    expect(p.search("Kenya").length).toBe(0);
    expect(p.search("Kenya capital").length).toBe(0);
    expect(p.search("France xyz").length).toBe(0);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK5");
    expect(decodePack(encodePackV1(facts)).search("RFC 3986")[0]?.o).toContain("URI");
    expect(buf.byteLength).toBeLessThan(facts.reduce((n, f) => n + f.s.length + f.o.length + 80, 0) * 4);
  });
  test("compact freezes the graph into a pack", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-"));
    const s = openStore(dir);
    s.putNodes("https://example.org/a", [{ s: "France", p: "capital", o: "Paris", e: "The capital of France is Paris." }], 30);
    s.compact();
    expect((s.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n).toBe(0);
    expect(s.search("France")[0]?.o).toBe("Paris");
    expect(s.count().pack).toBe(1);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate and cards", () => {
  test("junk tld", () => {
    expect(cheapSkip("https://spam.xyz/x", "Hello world this is enough english text for the gate to look at tokens here.")).toBe("junk-host");
  });
  test("trigram english and cdx json", () => {
    expect(englishTrigram("The capital of Kenya is Nairobi and the standard was published after the first session.")).toBe(true);
    const h = parseCdxLine(
      `{"url":"https://example.org/a","filename":"crawl-data/x.warc.gz","offset":"10","length":"20"}`,
    );
    expect(h?.offset).toBe(10);
    expect(h?.length).toBe(20);
  });
  test("ungrounded unknown and token cap", () => {
    expect("unknown" in formatCard("x", [])).toBe(true);
    const ok = formatCard("capital", [{ s: "Kenya", p: "capital", o: "Nairobi", e: "The capital of Kenya is Nairobi." }]);
    expect("fact" in ok && (ok as { fact: string }).fact.includes("Nairobi")).toBe(true);
    expect("fact" in ok && (ok as { fact: string }).fact.split(/\s+/).length <= 48).toBe(true);
    expect("unknown" in formatCard("javascript cssRules", [{ s: "h", p: "about", o: "x", e: "y" }])).toBe(true);
    expect("unknown" in formatCard("NASA", [{ s: "NASA", p: "date", o: "2022-12-07T13:25:23-05:00", e: "" }])).toBe(true);
    expect("unknown" in formatCard("RFC 3986", [{ s: "RFC 9309", p: "is", o: "Robots Exclusion Protocol", e: "RFC 9309: Robots Exclusion Protocol" }])).toBe(true);
    expect("fact" in formatCard("rfc3986", [{ s: "RFC 3986", p: "is", o: "URI Generic Syntax", e: "RFC 3986 URI Generic Syntax" }])).toBe(true);
    const jsonRfc = formatCard("RFC 8259", [{
      s: "RFC 8259",
      p: "is",
      o: "The JavaScript Object Notation",
      e: "RFC 8259 - The JavaScript Object Notation (JSON) Data Interchange Format Light Dark Auto RF",
    }]);
    expect("fact" in jsonRfc && (jsonRfc as { fact: string }).fact.includes("JSON")).toBe(true);
  });
  test("empty query is unknown and nonzero", async () => {
    const logs: string[] = [];
    const orig = console.log;
    const origE = console.error;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    console.error = () => {};
    try {
      const code = await knowCli(["query"]);
      expect(code).toBe(1);
      expect(logs.join(" ")).toContain("unknown");
    } finally {
      console.log = orig;
      console.error = origE;
    }
  });
});

describe("ua", () => {
  test("product token points at eden-know", () => {
    expect(EDENBOT).toMatch(/Edenbot\/0\.1/);
    expect(EDENBOT).toContain("https://github.com/KaiavN/eden-know");
    expect(EDENBOT.includes("KaiavN/Eden;")).toBe(false);
  });
});
