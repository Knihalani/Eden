import { describe, expect, test } from "bun:test";
import {
  robotsAllows,
  robotsCrawlDelaySec,
  robotsSitemaps,
  robotsTxtForHttpStatus,
  sitemapLocs,
  parseSitemap,
} from "./robots";
import {
  htmlToText,
  httpBody,
  jsonLdBlocks,
  looksLikeCode,
  persistable,
  qualityHost,
  qualityUrlSql,
  skipHost,
  triplesFromPage,
  decodeEntities,
  wikiCapitalTable,
  wikiActionApiUrl,
  wikiCapitalFromWikitext,
  wikiNeedsApiFallback,
  applyWikiApiFallback,
} from "./extract";
import { cheapSkip } from "./gate";
import { feedLinks } from "./feeds";
import { parseCdxLine } from "./cdx";
import { parseRfcIndex } from "./rfc-index";
import { parseW3Catalog } from "./w3-catalog";
import { parseRelatedDocs } from "./ietf-related";
import { englishTrigram } from "./lang";
import { formatCard, knowQuery } from "./query";
import { needlesFromText } from "./needles";
import { injectFromText } from "./inject";
import { knowCli } from "./cli";
import { pushWarc } from "./warc";
import { encodePack, encodePackV1, decodePack, queryShapes } from "./pack";
import { CAPITAL_OF } from "./synth";
import { parseIanaXml } from "./iana";
import { parseWikidataCapitals } from "./wikidata";
import { keepWet } from "./cc";
import { parseSpdxLicenses } from "./spdx";
import { parseWhatwgDb } from "./whatwg";
import { parseUnicodeBlocks } from "./unicode";
import { parseLangSubtags } from "./langtags";
import { parseUnicodeScripts } from "./scripts";
import { EDENBOT } from "./ua";
import { openStore, openQueryStore } from "./store";
import { SEED_URLS } from "./seed";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  test("wildcard star and dollar; specific UA beats star", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /*.json$\n", "Edenbot", "/x.json")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /*.json$\n", "Edenbot", "/x.json.html")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /this/*/exactly$\n", "Edenbot", "/this/foo/exactly")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /\nUser-agent: Edenbot\nAllow: /\n", "Edenbot", "/wiki/Kenya")).toBe(
      true,
    );
    expect(robotsAllows("User-agent: OtherBot\nDisallow: /\nUser-agent: *\nAllow: /\n", "Edenbot", "/x")).toBe(true);
  });
  test("sitemaps", () => {
    expect(robotsSitemaps("Sitemap: https://example.org/sitemap.xml\n")).toEqual(["https://example.org/sitemap.xml"]);
    expect(sitemapLocs("<urlset><url><loc>https://example.org/a</loc></url></urlset>")).toEqual([
      "https://example.org/a",
    ]);
    const idx = parseSitemap(`<sitemapindex><sitemap><loc>https://example.org/s1.xml</loc></sitemap></sitemapindex>`);
    expect(idx.kind).toBe("index");
    expect(idx.children).toEqual(["https://example.org/s1.xml"]);
    const set = parseSitemap(
      `<urlset><url><loc>https://www.rfc-editor.org/rfc/rfc9110.html</loc><lastmod>2026-01-01</lastmod></url></urlset>`,
    );
    expect(set.kind).toBe("urlset");
    expect(set.urls[0]).toEqual({ loc: "https://www.rfc-editor.org/rfc/rfc9110.html", lastmod: "2026-01-01" });
  });
});

describe("extract", () => {
  test("allows wikipedia family", () => {
    expect(skipHost("https://en.wikipedia.org/wiki/Kenya")).toBeUndefined();
    expect(skipHost("https://www.wikidata.org/wiki/Q1")).toBeUndefined();
  });
  test("skips paywall hosts", () => {
    expect(skipHost("https://www.nytimes.com/2026/01/01/x")).toBe("paywall-host");
  });
  test("quality urls include unicode and whatwg github", () => {
    expect(qualityHost("https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt")).toBe(true);
    expect(qualityHost("https://github.com/whatwg/sg/raw/main/db.json")).toBe(true);
    expect(qualityHost("https://en.wikipedia.org/wiki/Kenya")).toBe(true);
    expect(qualityHost("https://github.com/other/repo")).toBe(false);
    expect(qualityHost("https://github.com/oven-sh/bun")).toBe(true);
    expect(qualityHost("https://github.com/oven-sh/bun/issues/1")).toBe(true);
    expect(qualityHost("https://raw.githubusercontent.com/rust-lang/rust/master/README.md")).toBe(true);
    expect(qualityHost("https://doc.rust-lang.org/book/")).toBe(true);
    expect(qualityHost("https://bun.sh/docs")).toBe(true);
    expect(qualityHost("https://learn-python-scam.example/essay")).toBe(false);
    expect(qualityHost("https://spam.rfc.test/clickbait")).toBe(false);
    expect(qualityHost("https://notw3.org/TR/x")).toBe(false);
    expect(qualityHost("https://docs.python.org/3/")).toBe(true);
    expect(qualityHost("https://arxiv.org/abs/1706.03762")).toBe(true);
    expect(qualityHost("https://pubmed.ncbi.nlm.nih.gov/12345/")).toBe(true);
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
    expect(
      "unknown" in formatCard("x", [{ s: "h", p: "about", o: "async function addMetadata(){ cssRules }", e: "x" }]),
    ).toBe(true);
  });
  test("json-ld triples", () => {
    const html = `<html><title>JSON-LD 1.1</title><script type="application/ld+json">{"@type":"TechArticle","name":"JSON-LD 1.1","description":"A JSON-based serialization for Linked Data."}</script><h1>JSON-LD 1.1</h1><p>body text for extract</p></html>`;
    const t = triplesFromPage("https://www.w3.org/TR/json-ld11/", html, true);
    expect(t.some((x) => /JSON-LD/i.test(x.s) || /JSON-LD/i.test(x.o))).toBe(true);
    expect(htmlToText(html).includes("body")).toBe(true);
    expect(jsonLdBlocks(html).length).toBe(1);
  });
  test("json-ld Country capital persists", () => {
    const html = `<script type="application/ld+json">{"@type":"Country","name":"Kenya","capital":{"name":"Nairobi"},"description":"A country in East Africa."}</script>`;
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Kenya", html, true);
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
  });
  test("wikipedia infobox capital", () => {
    const t = triplesFromPage(
      "https://en.wikipedia.org/wiki/Kenya",
      `<html><head><title>Kenya</title></head><body>
      <table class="infobox"><tr><th>Capital</th><td><a href="/wiki/Nairobi">Nairobi</a></td></tr></table>
      <p>Kenya is a country in East Africa.</p></body></html>`,
      true,
    );
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
  });
  test("wikipedia wikitext infobox capital including nowrap", () => {
    expect(wikiCapitalFromWikitext("| capital = [[Nairobi]]")).toBe("Nairobi");
    expect(wikiCapitalFromWikitext("| capital = {{nowrap|[[Nairobi]]}}")).toBe("Nairobi");
    const t = triplesFromPage(
      "https://en.wikipedia.org/wiki/Kenya",
      "{{Infobox country\n| capital = {{nowrap|[[Nairobi]]}}\n}}",
      true,
    );
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
  });
  test("wikipedia Action API fallback from revision JSON (no network)", () => {
    const kenya = "https://en.wikipedia.org/wiki/Kenya";
    const shell = "<html><p>Kenya is a country in East Africa with enough text here.</p></html>";
    expect(wikiNeedsApiFallback(kenya, shell)).toBe(true);
    expect(wikiActionApiUrl(kenya)).toContain("action=query");
    expect(wikiActionApiUrl("https://www.nytimes.com/world/kenya")).toBeUndefined();
    const api = JSON.stringify({
      query: { pages: [{ revisions: [{ slots: { main: { content: "| capital = [[Nairobi]]\n" } } }] }] },
    });
    const html = applyWikiApiFallback(kenya, shell, api);
    expect(
      triplesFromPage(kenya, html, true).some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi"),
    ).toBe(true);
  });
  test("wikipedia capital list table", () => {
    const t = triplesFromPage(
      "https://en.wikipedia.org/wiki/List_of_national_capitals",
      `<html><table class="wikitable"><tr><th>Country</th><th>Capital</th></tr>
      <tr><td><a>France</a></td><td><a>Paris</a></td></tr>
      <tr><td><a>Kenya</a></td><td><a>Nairobi</a></td></tr>
      <tr><td><a>Japan</a></td><td><a>Tokyo</a></td></tr></table></html>`,
      true,
    );
    expect(t.filter((x) => x.p === "capital").length).toBeGreaterThanOrEqual(3);
    expect(t.some((x) => x.s === "France" && x.o === "Paris")).toBe(true);
    const swapped = triplesFromPage(
      "https://en.wikipedia.org/wiki/List_of_national_capitals",
      `<html><table class="wikitable"><tr><th>City</th><th>Country</th></tr>
      <tr><td><a>Nairobi</a></td><td><a>Kenya</a></td></tr></table></html>`,
      true,
    );
    expect(swapped.some((x) => x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
  });
  test("wikipedia capital list fixture: country subject, not inverted", () => {
    const html = readFileSync(join(import.meta.dir, "fixtures/national-capitals.fragment.html"), "utf8");
    const t = wikiCapitalTable(html);
    expect(t.length).toBeGreaterThanOrEqual(5);
    const hit = (s: string, o: string) => t.some((x) => x.p === "capital" && x.s === s && x.o === o);
    expect(hit("Kenya", "Nairobi")).toBe(true);
    expect(hit("France", "Paris")).toBe(true);
    expect(hit("Japan", "Tokyo")).toBe(true);
    expect(t.some((x) => x.s === "Nairobi" || x.s === "Paris" || x.s === "Tokyo")).toBe(false);
    expect(t.some((x) => /^(africa|asia|europe|oceania|north america|south america)$/i.test(x.s))).toBe(false);
    const page = triplesFromPage("https://en.wikipedia.org/wiki/List_of_national_capitals", html, true);
    expect(page.some((x) => x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    expect(page.some((x) => x.s === "France" && x.o === "Paris")).toBe(true);
    expect(page.some((x) => x.s === "Japan" && x.o === "Tokyo")).toBe(true);
    expect(page.some((x) => x.s === "Germany" && x.o === "Berlin")).toBe(true);
    expect(page.some((x) => x.s === "Australia" && x.o === "Canberra")).toBe(true);
    expect(page.some((x) => /melbourne|sydney/i.test(x.s) || /melbourne|sydney/i.test(x.o))).toBe(false);
  });
  test("obscure media types are not persistable", () => {
    expect(
      persistable("https://www.iana.org/assignments/media-types/media-types.xml", {
        s: "IANA media application/vnd.obscure-x",
        p: "is",
        o: "Obscure",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.iana.org/assignments/media-types/media-types.xml", {
        s: "IANA media application/json",
        p: "is",
        o: "JSON",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.iana.org/assignments/well-known-uris/well-known-uris.xml", {
        s: "IANA well-known change-password",
        p: "is",
        o: "Change Password",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.iana.org/assignments/well-known-uris/well-known-uris.xml", {
        s: "IANA well-known obscure-x",
        p: "is",
        o: "Obscure",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.iana.org/assignments/media-types/media-types.xml", {
        s: "IANA media application/cbor",
        p: "is",
        o: "CBOR",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.iana.org/assignments/uri-schemes/uri-schemes.xml", {
        s: "IANA scheme bitcoin",
        p: "is",
        o: "Bitcoin",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.iana.org/assignments/link-relations/link-relations.xml", {
        s: "IANA rel stylesheet",
        p: "is",
        o: "Stylesheet",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.iana.org/assignments/link-relations/link-relations.xml", {
        s: "IANA rel obscure-x",
        p: "is",
        o: "Obscure",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.iana.org/assignments/well-known-uris/well-known-uris.xml", {
        s: "IANA well-known security.txt",
        p: "is",
        o: "security.txt",
        e: "",
      }),
    ).toBe(false);
    expect(qualityUrlSql()).not.toContain("LIKE '%rfc-editor.org%'");
    expect(qualityUrlSql()).toContain("LIKE 'https://%.rfc-editor.org/%'");
    expect(qualityUrlSql()).not.toMatch(/LIKE '%python\.org%'/);
  });
  test("official capitals are full names, not truncated", () => {
    expect(CAPITAL_OF["Brazil"]).toBe("Brasilia");
    expect(CAPITAL_OF["Ivory Coast"]).toBe("Yamoussoukro");
    expect(CAPITAL_OF["Iceland"]).toBe("Reykjavik");
    expect(CAPITAL_OF["Paraguay"]).toBe("Asuncion");
    const cities = Object.values(CAPITAL_OF);
    expect(cities.includes("Bras")).toBe(false);
    expect(cities.includes("St")).toBe(false);
    expect(cities.includes("Abidjan")).toBe(false);
  });
  test("IANA rel, scheme, and media pack and query", () => {
    const buf = encodePack([
      { s: "IANA rel stylesheet", p: "is", o: "stylesheet", e: "", url: "" },
      { s: "IANA scheme bitcoin", p: "is", o: "bitcoin", e: "", url: "" },
      { s: "IANA media application/cbor", p: "is", o: "cbor", e: "", url: "" },
      { s: "Brazil", p: "capital", o: "Brasilia", e: "", url: "" },
    ]);
    const p = decodePack(buf);
    expect(p.search("stylesheet")[0]?.s).toBe("IANA rel stylesheet");
    expect(p.search("bitcoin")[0]?.s).toBe("IANA scheme bitcoin");
    expect(p.search("application/cbor")[0]?.s).toBe("IANA media application/cbor");
    expect(p.search("Brazil")[0]?.o).toBe("Brasilia");
    expect(queryShapes("bitcoin").some((s) => /IANA scheme bitcoin/i.test(s))).toBe(true);
    expect(queryShapes("RFC 8259 obsoletes")).toContain("RFC 8259");
    expect(queryShapes("RFC 4627 obsoletes")).toContain("RFC 4627");
    expect(knowQuery("bitcoin", p).fact ?? "").toMatch(/URI scheme/i);
    expect(knowQuery("stylesheet", p).fact ?? "").toMatch(/link relation/i);
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
<rfc-entry><doc-id>RFC9110</doc-id><title>HTTP Semantics</title><current-status>INTERNET STANDARD</current-status><obsoletes><doc-id>RFC2818</doc-id><doc-id>RFC7230</doc-id><doc-id>RFC7231</doc-id></obsoletes><updates><doc-id>RFC3864</doc-id></updates></rfc-entry>
<rfc-entry><doc-id>RFC0000</doc-id><title>Not Issued</title><current-status>NOT ISSUED</current-status></rfc-entry>
</rfc-index>`;
    const t = parseRfcIndex(xml);
    expect(t.some((x) => x.s === "RFC 3986" && /URI/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 9110" && x.p === "obsoletes" && /7231/.test(x.o) && /2818/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 9110" && x.p === "updates" && /3864/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 2616")).toBe(false);
    const longTail = parseRfcIndex(
      `<rfc-entry><doc-id>RFC0872</doc-id><title>TCP-on-a-LAN</title><current-status>INFORMATIONAL</current-status></rfc-entry>`,
    );
    expect(longTail.some((x) => x.s === "RFC 872" && /TCP/i.test(x.o))).toBe(true);
    const junk = parseRfcIndex(
      `<rfc-entry><doc-id>RFC0001</doc-id><title>When a server</title><current-status>INFORMATIONAL</current-status></rfc-entry>`,
    );
    expect(junk.some((x) => x.s === "RFC 1")).toBe(false);
  });
  test("iana spdx whatwg catalogs are typed is-facts", () => {
    const proto = parseIanaXml(
      `<record><value>6</value><name>TCP</name><description>Transmission Control</description></record>
       <record><value>99</value><name>Unassigned</name></record>`,
      "protocol",
    );
    expect(proto).toEqual([{ s: "IANA protocol 6", p: "is", o: "TCP", e: "" }]);
    expect(persistable("https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xml", proto[0]!)).toBe(
      false,
    );
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
    expect(persistable("https://spdx.org/licenses/licenses.json", spdx[0]!)).toBe(false);
    const whatwg = parseWhatwgDb({
      workstreams: [
        { standards: [{ name: "HTML", href: "https://html.spec.whatwg.org/multipage/", reference: "HTML" }] },
      ],
    });
    expect(whatwg[0]?.s).toBe("WHATWG html");
    expect(whatwg[0]?.o).toContain("HTML");
    const blocks = parseUnicodeBlocks("# Blocks-16.0.0.txt\n0000..007F; Basic Latin\n0080..00FF; Latin-1 Supplement\n");
    expect(blocks[0]).toEqual({ s: "Unicode Block Basic Latin", p: "is", o: "U+0000..U+007F", e: "" });
    expect(persistable("https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt", blocks[0]!)).toBe(false);
    const langs = parseLangSubtags(
      "%%\nType: language\nSubtag: en\nDescription: English\n%%\nType: language\nSubtag: zxx\nDescription: No linguistic content\nScope: special\n",
    );
    expect(langs).toEqual([{ s: "IANA language en", p: "is", o: "English", e: "" }]);
    expect(
      persistable("https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry", langs[0]!),
    ).toBe(false);
    const methods = parseIanaXml(
      `<record><value>GET</value><description>Transfer a current representation</description></record>`,
      "method",
    );
    expect(methods[0]?.s).toBe("IANA method GET");
    const methodsXml = parseIanaXml(
      `<record><value>GET</value><safe>yes</safe><idempotent>yes</idempotent><xref type="rfc" data="rfc9110" section="9.3.1"/></record>`,
      "method",
    );
    expect(methodsXml[0]?.o).toBe("safe, idempotent, RFC 9110");
    const getCard = formatCard("GET", methodsXml);
    expect("fact" in getCard && (getCard as { fact: string }).fact).toMatch(/^GET is /);
    const sc = parseUnicodeScripts("sc ; Latn ; Latin\nsc ; Zzzz ; Unknown\n");
    expect(sc[0]).toEqual({ s: "Unicode Script Latn", p: "is", o: "Latin", e: "" });
    const cs = parseIanaXml(`<record><name>UTF-8</name><preferred_alias>utf-8</preferred_alias></record>`, "charset");
    expect(cs[0]?.s).toBe("IANA charset utf-8");
    expect(persistable("https://www.iana.org/assignments/character-sets/character-sets.xml", cs[0]!)).toBe(false);
    const hdr = parseIanaXml(
      `<record><name>Accept</name><status>permanent</status><description>Media types</description></record>`,
      "header",
    );
    expect(hdr[0]?.s).toBe("IANA header Accept");
    expect(hdr[0]?.o).toBe("Media types");
    const hdrXref = parseIanaXml(
      `<record><name>Accept</name><status>permanent</status><xref type="rfc" data="rfc9110"/></record>`,
      "header",
    );
    expect(hdrXref[0]?.o).toBe("RFC 9110");
    expect("fact" in formatCard("Accept", hdrXref)).toBe(true);
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
    expect(persistable("https://api.w3.org/specifications", t[0]!)).toBe(false);
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
  test("wikidata capitals parse and queryShapes capital-of", () => {
    const t = parseWikidataCapitals({
      results: {
        bindings: [
          { countryLabel: { value: "Kenya" }, capitalLabel: { value: "Nairobi" } },
          { countryLabel: { value: "France" }, capitalLabel: { value: "Paris" } },
          { countryLabel: { value: "Q1" }, capitalLabel: { value: "Nope" } },
        ],
      },
    });
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "France" && x.o === "Paris")).toBe(true);
    expect(t.some((x) => x.s === "Q1")).toBe(false);
    expect(queryShapes("capital of Kenya")).toContain("Kenya");
    expect(queryShapes("UTF-8")).toContain("IANA charset utf-8");
    expect(
      keepWet({
        uri: "https://spam.example/x",
        text: "hello world this is a long enough english page about nothing in particular here.",
      }),
    ).toBe(false);
    expect(
      keepWet({
        uri: "https://www.rfc-editor.org/rfc/rfc3986.html",
        text: "RFC 3986 Uniform Resource Identifier Generic Syntax. This document defines the generic syntax of URI.",
      }),
    ).toBe(true);
    const long =
      "This is a long enough english page about nothing in particular, just filler text for a junk host that the old length floor would have admitted. ".repeat(
        4,
      );
    expect(keepWet({ uri: "https://learn-python-scam.example/essay", text: long })).toBe(false);
    expect(keepWet({ uri: "https://spam.rfc.test/clickbait", text: long })).toBe(false);
  });
  test("keepWet slice yield is the FineWeb meter (not lifetime host_prior.skipped)", () => {
    const longJunk =
      "This is a long enough english page about nothing in particular, just filler text for a junk host that the old length floor would have admitted. ".repeat(
        4,
      );
    expect(longJunk.length).toBeGreaterThanOrEqual(200);
    const junk = [
      ...Array.from({ length: 90 }, (_, i) => ({
        uri: `https://spam${i}.junk.test/long-page`,
        text: longJunk,
      })),
      { uri: "https://learn-python-scam.example/essay", text: longJunk },
      { uri: "https://spam.rfc.test/clickbait", text: longJunk },
    ];
    const quality = [
      ...Array.from({ length: 7 }, (_, i) => ({
        uri: `https://www.rfc-editor.org/rfc/rfc${3900 + i}.html`,
        text: "RFC document that defines an internet standard with enough body text to pass the WET length floor for conversion records.",
      })),
      {
        uri: "https://www.ietf.org/rfc/rfc9110.html",
        text: "RFC 9110 HTTP Semantics. This document specifies HTTP semantics for the web as used by agents and servers.",
      },
      {
        uri: "https://www.w3.org/TR/json-ld11/",
        text: "JSON-LD 1.1 is a JSON-based serialization for Linked Data used on the web by publishers.",
      },
      {
        uri: "https://www.nist.gov/pml/",
        text: "NIST publishes physical constants and measurement standards used across science and industry.",
      },
    ];
    expect(quality).toHaveLength(10);
    const kept = [...junk, ...quality].filter(keepWet);
    expect(kept).toHaveLength(9);
    expect(kept.every((r) => /rfc-editor|ietf\.org|w3\.org/.test(r.uri))).toBe(true);
    expect(keepWet(quality[9]!)).toBe(false);
    expect(junk.every((r) => keepWet(r) === false)).toBe(true);
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
    ).toBe(false);
  });
});

describe("warc", () => {
  test("parses a conversion record", () => {
    const body = "The capital of France is Paris. France is a country.";
    const rec = `WARC/1.0\r\nWARC-Type: conversion\r\nWARC-Target-URI: https://example.org/fr\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
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
    s.putNodes(
      "https://example.org/a",
      [{ s: "jq", p: "is", o: "used for filtering JSON", e: "jq is used for filtering JSON on the command line." }],
      30,
    );
    const hits = s.search("used for JSON");
    expect(hits[0]?.s).toBe("jq");
    expect(hits[0]?.url).toBe("https://example.org/a");
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
    s.putNodes(
      "https://example.org/a",
      [{ s: "jq", p: "is", o: "used for filtering JSON", e: "jq is used for filtering JSON on the command line." }],
      30,
    );
    expect(s.search("jq")[0]?.o).toMatch(/used for/);
    expect(s.search("RFC 3986").length).toBe(0);
    const posts = (s.db.query(`SELECT COUNT(*) AS n FROM post`).get() as { n: number }).n;
    expect(posts).toBeGreaterThan(0);
    s.putPage({ url: "https://spam.example/kept", digest: "zzz", chars: 10, source: "cc", ttl_days: 1 });
    expect((s.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(1);
    s.putPage({
      url: "https://www.rfc-editor.org/rfc/rfc9309.html",
      digest: "ok",
      chars: 10,
      source: "seed",
      ttl_days: 1,
    });
    expect((s.db.query(`SELECT COUNT(*) AS n FROM pages`).get() as { n: number }).n).toBe(2);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("intern shares predicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-"));
    const s = openStore(dir);
    s.putNodes(
      "https://example.org/a",
      [
        { s: "jq", p: "is", o: "used for filtering JSON", e: "jq is used for filtering JSON on the command line." },
        { s: "Bun", p: "is", o: "used for running TypeScript", e: "Use Bun to run TypeScript services." },
      ],
      30,
    );
    expect((s.db.query(`SELECT COUNT(*) AS n FROM intern WHERE s = 'is'`).get() as { n: number }).n).toBe(1);
    expect((s.db.query(`SELECT COUNT(*) AS n FROM lex WHERE t = 'json'`).get() as { n: number }).n).toBeGreaterThan(0);
    expect(s.schemaVersion()).toBeGreaterThanOrEqual(10);
    expect((s.db.query(`PRAGMA table_info(pages)`).all() as { name: string }[]).some((c) => c.name === "skip")).toBe(
      false,
    );
    s.putNodes("https://example.org/dump", [{ s: "x", p: "about", o: "a long page title dump", e: "nope" }], 30);
    expect(
      (s.db.query(`SELECT COUNT(*) AS n FROM nodes WHERE url = 'https://example.org/dump'`).get() as { n: number }).n,
    ).toBe(0);
    s.putNodes(
      "https://www.rfc-editor.org/rfc/rfc9309.html",
      [
        {
          s: "RFC 9309",
          p: "is",
          o: "Robots Exclusion Protocol RFC 9309 Robots Exclusion Protocol (REP) Sept",
          e: "x",
        },
      ],
      30,
    );
    expect((s.db.query(`SELECT COUNT(*) AS n FROM nodes WHERE url LIKE '%rfc9309%'`).get() as { n: number }).n).toBe(0);
    s.putNodes(
      "https://www.rfc-editor.org/rfc/rfc3986.html",
      [{ s: "RFC 3986", p: "is", o: "URI Generic Syntax first", e: "RFC 3986 URI Generic Syntax first" }],
      30,
    );
    s.putNodes(
      "https://datatracker.ietf.org/doc/html/rfc3986",
      [{ s: "RFC 3986", p: "is", o: "URI Generic Syntax other host", e: "RFC 3986 URI Generic Syntax other host" }],
      30,
    );
    expect(
      (
        s.db.query(`SELECT COUNT(*) AS n FROM nodes n JOIN intern s ON s.id = n.sid WHERE s.s = 'RFC 3986'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    s.putNodes(
      "https://www.rfc-editor.org/rfc-index.xml",
      [{ s: "RFC 2119", p: "is", o: "Key words for use in RFCs", e: "" }],
      30,
    );
    s.putNodes(
      "https://www.rfc-editor.org/rfc/rfc2119.html",
      [
        {
          s: "RFC 2119",
          p: "is",
          o: "Key words MUST SHOULD",
          e: "RFC 2119: Key words for use in RFCs to Indicate Requirement Levels",
        },
      ],
      30,
    );
    expect(s.search("RFC 2119").length).toBe(0);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("catalog aliases hit sqlite before compact", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-"));
    const s = openStore(dir);
    s.putNodes(
      "https://jqlang.github.io/jq/",
      [{ s: "jq", p: "is", o: "used for filtering JSON", e: "jq is used for filtering JSON on the command line." }],
      30,
    );
    expect(s.search("used for JSON")[0]?.s).toBe("jq");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("kpk pack answers without sqlite intern", () => {
    const facts = [
      { s: "Kenya", p: "capital", o: "Nairobi", e: "The capital of Kenya is Nairobi.", url: "https://example.org/a" },
      {
        s: "RFC 3986",
        p: "is",
        o: "Uniform Resource Identifier (URI): Generic Syntax",
        e: "",
        url: "https://example.org/rfc",
      },
      { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "https://example.org/w3" },
      { s: "RFC 9110", p: "obsoletes", o: "RFC 7230, RFC 7231", e: "", url: "https://example.org/rfc" },
      { s: "RFC 872", p: "is", o: "TCP-on-a-LAN", e: "", url: "https://example.org/rfc" },
      {
        s: "IANA protocol 6",
        p: "is",
        o: "TCP",
        e: "Transmission Control",
        url: "https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xml",
      },
      {
        s: "IANA media application/json",
        p: "is",
        o: "JSON",
        e: "",
        url: "https://www.iana.org/assignments/media-types/media-types.xml",
      },
      {
        s: "RFC 4627",
        p: "is",
        o: "The application/json Media Type for JavaScript Object Notation (JSON)",
        e: "RFC 4627: The application&#x2F;json Media Type for JavaScript Object Notation (JSON)",
        url: "https://www.rfc-editor.org/rfc/rfc4627.html",
      },
      {
        s: "IANA http 404",
        p: "is",
        o: "Not Found",
        e: "",
        url: "https://www.iana.org/assignments/http-status-codes/http-status-codes.xml",
      },
      { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "https://spdx.org/licenses/licenses.json" },
      {
        s: "Unicode Block Basic Latin",
        p: "is",
        o: "U+0000..U+007F",
        e: "",
        url: "https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt",
      },
      {
        s: "IANA language en",
        p: "is",
        o: "English",
        e: "",
        url: "https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry",
      },
      {
        s: "IANA method GET",
        p: "is",
        o: "Transfer a current representation",
        e: "",
        url: "https://www.iana.org/assignments/http-methods/http-methods.xml",
      },
      {
        s: "IANA scheme https",
        p: "is",
        o: "Hypertext Transfer Protocol Secure",
        e: "",
        url: "https://www.iana.org/assignments/uri-schemes/uri-schemes.xml",
      },
      {
        s: "IANA header Accept",
        p: "is",
        o: "RFC 9110",
        e: "",
        url: "https://www.iana.org/assignments/http-fields/http-fields.xml",
      },
      {
        s: "Unicode Script Latn",
        p: "is",
        o: "Latin",
        e: "",
        url: "https://www.unicode.org/Public/UCD/latest/ucd/PropertyValueAliases.txt",
      },
    ];
    const buf = encodePack(facts);
    const p = decodePack(buf);
    expect(p.search("Kenya capital")[0]?.o).toBe("Nairobi");
    expect(p.search("RFC 3986")[0]?.o).toContain("URI");
    expect(p.search("web share")[0]?.s).toBe("W3C web-share");
    expect(p.search("RFC 9110")[0]?.o).toContain("7230");
    expect(p.search("TCP")[0]?.s).toBe("IANA protocol 6");
    expect(p.search("application/json")[0]?.s).toBe("IANA media application/json");
    expect(p.search("json")[0]?.s).toBe("IANA media application/json");
    const collide = decodePack(
      encodePack([
        { s: "SPDX JSON", p: "is", o: "JSON License", e: "", url: "https://spdx.org/licenses/licenses.json" },
        {
          s: "IANA media application/json",
          p: "is",
          o: "JSON",
          e: "",
          url: "https://www.iana.org/assignments/media-types/media-types.xml",
        },
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
    expect(p.search("https")[0]?.s).toBe("IANA scheme https");
    expect(p.search("Accept")[0]?.o).toBe("RFC 9110");
    expect(p.search("TCP")[0]?.e).toBe("");
    expect(p.search("Latn")[0]?.s).toBe("Unicode Script Latn");
    expect(p.search("Latin")[0]?.s).toBe("Unicode Script Latn");
    expect(p.search("Kenya")[0]?.o).toBe("Nairobi");
    expect(p.search("Kenya capital")[0]?.o).toBe("Nairobi");
    expect(p.search("France xyz").length).toBe(0);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK9");
    expect(decodePack(encodePackV1(facts)).search("RFC 3986")[0]?.o).toContain("URI");
    expect(buf.byteLength).toBeLessThan(facts.reduce((n, f) => n + f.s.length + f.o.length + 80, 0) * 4);
  });
  test("compact freezes the graph into a pack", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-"));
    const s = openStore(dir);
    s.putNodes(
      "https://example.org/a",
      [{ s: "jq", p: "is", o: "used for filtering JSON", e: "jq is used for filtering JSON on the command line." }],
      30,
    );
    s.compact();
    expect((s.db.query(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n).toBe(0);
    expect(s.search("jq")[0]?.s).toBe("jq");
    expect(s.count().wal_nodes).toBe(0);
    expect(s.count().pack).toBeGreaterThanOrEqual(1);
    s.close();
    const q = openQueryStore(dir);
    expect(q.search("jq")[0]?.s).toBe("jq");
    q.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  test("compact with pack=null keeps fetched base facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-base-"));
    const s = openStore(dir);
    expect(s.count().pack).toBe(0);
    s.compact([{ s: "jq", p: "is", o: "used for filtering JSON", e: "", url: "" }]);
    expect(s.search("jq")[0]?.s).toBe("jq");
    expect(s.count().pack).toBeGreaterThanOrEqual(1);
    s.close();
    const q = openQueryStore(dir);
    expect(q.search("jq")[0]?.s).toBe("jq");
    q.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  test("query store ignores WAL until compact", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-wal-"));
    const s = openStore(dir);
    s.putNodes(
      "https://example.org/a",
      [{ s: "jq", p: "is", o: "used for filtering JSON", e: "jq is used for filtering JSON on the command line." }],
      30,
    );
    const q = openQueryStore(dir);
    expect(q.search("jq").length).toBe(0);
    q.close?.();
    s.compact();
    const q2 = openQueryStore(dir);
    expect(q2.search("jq")[0]?.s).toBe("jq");
    q2.close?.();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate and cards", () => {
  test("junk tld", () => {
    expect(
      cheapSkip("https://spam.xyz/x", "Hello world this is enough english text for the gate to look at tokens here."),
    ).toBe("junk-host");
  });
  test("trigram english and cdx json", () => {
    expect(
      englishTrigram("The capital of Kenya is Nairobi and the standard was published after the first session."),
    ).toBe(true);
    const h = parseCdxLine(
      `{"url":"https://example.org/a","filename":"crawl-data/x.warc.gz","offset":"10","length":"20"}`,
    );
    expect(h?.offset).toBe(10);
    expect(h?.length).toBe(20);
  });
  test("ungrounded unknown and token cap", () => {
    expect("unknown" in formatCard("x", [])).toBe(true);
    const ok = formatCard("capital", [
      { s: "Kenya", p: "capital", o: "Nairobi", e: "The capital of Kenya is Nairobi." },
    ]);
    expect("fact" in ok && (ok as { fact: string }).fact.includes("Nairobi")).toBe(true);
    expect("fact" in ok && (ok as { fact: string }).fact.split(/\s+/).length <= 48).toBe(true);
    expect("unknown" in formatCard("javascript cssRules", [{ s: "h", p: "about", o: "x", e: "y" }])).toBe(true);
    expect("unknown" in formatCard("NASA", [{ s: "NASA", p: "date", o: "2022-12-07T13:25:23-05:00", e: "" }])).toBe(
      true,
    );
    expect(
      "unknown" in
        formatCard("RFC 3986", [
          { s: "RFC 9309", p: "is", o: "Robots Exclusion Protocol", e: "RFC 9309: Robots Exclusion Protocol" },
        ]),
    ).toBe(true);
    expect(
      "fact" in
        formatCard("rfc3986", [{ s: "RFC 3986", p: "is", o: "URI Generic Syntax", e: "RFC 3986 URI Generic Syntax" }]),
    ).toBe(true);
    const jsonRfc = formatCard("RFC 8259", [
      {
        s: "RFC 8259",
        p: "is",
        o: "The JavaScript Object Notation",
        e: "RFC 8259 - The JavaScript Object Notation (JSON) Data Interchange Format Light Dark Auto RF",
      },
    ]);
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

describe("needles", () => {
  test("pulls RFC and media type from CoT", () => {
    expect(needlesFromText("We should follow RFC 3986 and send application/json.")).toEqual([
      "RFC 3986",
      "application/json",
    ]);
    expect(needlesFromText("See RFC 35.")).toEqual(["RFC 35"]);
  });
  test("pulls method, status, scheme, protocol from agent prose", () => {
    const n = needlesFromText("Is GET safe? Return HTTP 404. TCP is protocol 6. the https URI scheme.");
    expect(n).toContain("GET");
    expect(n).toContain("404");
    expect(n).toContain("TCP");
    expect(n).toContain("https");
  });
  test("pulls json media type, return-404, language subtag, and charset", () => {
    expect(needlesFromText("the json media type from IANA")).toContain("json");
    expect(needlesFromText("Return 404 if the resource is missing")).toContain("404");
    expect(needlesFromText("IANA language subtag en")).toContain("IANA language en");
    const n = needlesFromText("Send UTF-8 and set Accept.");
    expect(n).toContain("UTF-8");
    expect(n).toContain("Accept");
  });
  test("inject stays silent without a graph hit", () => {
    expect(injectFromText("no fact shaped tokens here at all")).toBeUndefined();
  });
});

describe("ua", () => {
  test("product token points at the public data landing", () => {
    expect(EDENBOT).toMatch(/Edenbot\/0\.1/);
    expect(EDENBOT).toContain("https://github.com/Knihalani/eden-know-data");
    expect(EDENBOT.includes("Knihalani/eden-know;")).toBe(false);
    expect(EDENBOT.includes("KaiavN/eden-know")).toBe(false);
    expect(EDENBOT.includes("KaiavN/Eden;")).toBe(false);
  });
});

describe("know crush holdout", () => {
  type Holdout = {
    must_hit: { q: string; needles: string[]; forbid?: string[] }[];
    must_unknown: string[];
    inject_hit: string;
    inject_silent: string;
    card_forbid: string[];
  };
  // .gauntlet/ is gitignored, so CI and fresh clones have no holdout. Reading it only when present
  // keeps the rest of this block running there; the two tests that need it skip
  // (quarantined in P0.-1: https://github.com/Knihalani/Eden/issues/23).
  const holdoutUrl = new URL("../../../.gauntlet/know-crush/refs/holdout.json", import.meta.url);
  const HAS_HOLDOUT = existsSync(holdoutUrl);
  const holdout: Holdout | undefined = HAS_HOLDOUT ? JSON.parse(readFileSync(holdoutUrl, "utf8")) : undefined;

  function packedStore() {
    const facts = [
      {
        s: "RFC 3986",
        p: "is",
        o: "Uniform Resource Identifier (URI): Generic Syntax",
        e: "",
        url: "https://www.rfc-editor.org/rfc/rfc3986.html",
      },
      { s: "RFC 9110", p: "is", o: "HTTP Semantics", e: "", url: "https://www.rfc-editor.org/rfc/rfc9110.html" },
      {
        s: "IANA media application/json",
        p: "is",
        o: "JSON",
        e: "",
        url: "https://www.iana.org/assignments/media-types/media-types.xml",
      },
      {
        s: "RFC 4627",
        p: "is",
        o: "The application/json Media Type for JavaScript Object Notation (JSON)",
        e: "RFC 4627: The application&#x2F;json Media Type for JavaScript Object Notation (JSON)",
        url: "https://www.rfc-editor.org/rfc/rfc4627.html",
      },
      { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "https://spdx.org/licenses/licenses.json" },
      { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "https://www.w3.org/TR/web-share/" },
    ];
    const dir = mkdtempSync(join(tmpdir(), "eden-know-holdout-"));
    writeFileSync(join(dir, "graph.kpk"), encodePack(facts));
    return { dir, store: openStore(dir) };
  }

  test("decodes numeric entities", () => {
    expect(decodeEntities("application&#x2F;json")).toBe("application/json");
    expect(decodeEntities("a&#47;b &amp; c")).toBe("a/b & c");
    const card = formatCard("RFC 4627", [
      {
        s: "RFC 4627",
        p: "is",
        o: "The application&#x2F;json Media Type for JSON",
        e: "RFC 4627: The application&#x2F;json Media Type for JSON",
      },
    ]);
    expect("fact" in card && !(card as { fact: string }).fact.includes("&#x")).toBe(true);
    expect("fact" in card && (card as { fact: string }).fact.includes("application/json")).toBe(true);
  });

  test("application/json locates IANA media, not RFC 4627", () => {
    const { dir, store } = packedStore();
    try {
      const hits = store.search("application/json", 5);
      expect(hits[0]?.s).toBe("IANA media application/json");
      expect(hits[0]?.s).not.toContain("4627");
      const card = knowQuery("application/json", store);
      expect("fact" in card).toBe(true);
      const fact = (card as { fact: string }).fact;
      expect(fact.toLowerCase()).toContain("json");
      expect(fact).not.toContain("RFC 4627");
      expect(fact).not.toContain("&#x");
      const mit = knowQuery("MIT", store);
      expect("fact" in mit).toBe(true);
      expect((mit as { fact: string }).fact).toMatch(/MIT/);
      expect((mit as { fact: string }).fact).not.toBe("SPDX MIT is MIT License.");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!HAS_HOLDOUT)("holdout must_hit 100% and must_unknown stay unknown", () => {
    const { dir, store } = packedStore();
    try {
      for (const row of holdout!.must_hit) {
        const card = knowQuery(row.q, store);
        expect("fact" in card).toBe(true);
        const fact = (card as { fact: string }).fact;
        for (const n of row.needles) expect(fact).toContain(n);
        for (const f of row.forbid ?? []) expect(fact).not.toContain(f);
        for (const f of holdout!.card_forbid) expect(fact).not.toContain(f);
      }
      for (const q of holdout!.must_unknown) {
        expect("unknown" in knowQuery(q, store)).toBe(true);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("openStore requeues talk and RFC seeds; skipHost keeps nytimes out", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-seeds-"));
    const s = openStore(dir);
    try {
      const urls = (s.db.query(`SELECT url FROM frontier`).all() as { url: string }[]).map((r) => r.url);
      expect(urls.some((u) => u.includes("wikipedia.org"))).toBe(false);
      expect(urls.some((u) => /reddit\.com|stackoverflow\.com/.test(u))).toBe(true);
      expect(urls.some((u) => /rfc3986/i.test(u))).toBe(true);
      expect(SEED_URLS.some((u) => u.includes("wikipedia.org"))).toBe(false);
      expect(skipHost("https://en.wikipedia.org/wiki/Kenya")).toBeUndefined();
      expect(skipHost("https://www.nytimes.com/2026/01/01/x")).toBe("paywall-host");
      expect(urls.every((u) => skipHost(u) === undefined)).toBe(true);
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!HAS_HOLDOUT)("EDEN_KNOW=0 disables inject; silent chat stays silent", () => {
    const prev = process.env.EDEN_KNOW;
    process.env.EDEN_KNOW = "0";
    try {
      expect(injectFromText(holdout!.inject_hit)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.EDEN_KNOW;
      else process.env.EDEN_KNOW = prev;
    }
    expect(injectFromText(holdout!.inject_silent)).toBeUndefined();
  });
});
