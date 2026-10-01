import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyWikiApiFallback,
  extractLinks,
  httpBody,
  persistable,
  rfcTitleFromHtml,
  scanHtml,
  skipHost,
  softwareLeadIs,
  techniquesFromProse,
  triplesFromPage,
  wikiActionApiUrl,
  wikiApiBodyToText,
  wikiCapital,
  wikiCapitalFromWikitext,
  wikiCapitalTable,
  wikiInfoboxExtras,
  wikiIso,
  wikiLeadIs,
  wikiNeedsApiFallback,
  wikiRestSummaryUrl,
  wikiRevisionWikitext,
  wikiSummaryExtract,
} from "./extract";
import { parseWikidataCapitals } from "./wikidata";
import { keepWet, rankFrontier, rankFrontierUrls, wetScanCap } from "./cc";
import { gopherSkip, wetFactBearing } from "./gate";
import { wikiReadAllowed } from "./live";

const LIST = "https://en.wikipedia.org/wiki/List_of_national_capitals";
const KENYA = "https://en.wikipedia.org/wiki/Kenya";
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/national-capitals.fragment.html"), "utf8");

const KENYA_INFOBOX = `<table class="infobox ib-country vcard">
<tr><th scope="row" class="infobox-label">Capital<div class="ib-country-largest">and largest city</div></th>
<td class="infobox-data"><a rel="mw:WikiLink" href="/wiki/Nairobi" title="Nairobi">Nairobi</a></td></tr>
<tr><th scope="row" class="infobox-label"><a href="/wiki/ISO_3166" title="ISO 3166">ISO 3166 code</a></th>
<td class="infobox-data"><a href="/wiki/ISO_3166-2:KE" title="ISO 3166-2:KE">KE</a></td></tr>
</table>`;

describe("infobox capital yield", () => {
  test("plain th Capital still Kenya → Nairobi", () => {
    const html = `<table class="infobox"><tr><th>Capital</th><td><a href="/wiki/Nairobi">Nairobi</a></td></tr></table>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "Nairobi" && x.p === "capital")).toBe(false);
  });

  test("Capital and largest city + infobox-label", () => {
    const cap = wikiCapital(KENYA, KENYA_INFOBOX, "");
    expect(cap).toEqual({
      s: "Kenya",
      p: "capital",
      o: "Nairobi",
      e: "capital of Kenya is Nairobi",
    });
    const t = triplesFromPage(KENYA, `<html>${KENYA_INFOBOX}</html>`, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
  });

  test("infobox calling code and demonym persist", () => {
    const html = `<table class="infobox"><tr><th>Capital</th><td>Nairobi</td></tr>
      <tr><th>Calling code</th><td>+254</td></tr>
      <tr><th>Demonym</th><td>Kenyan</td></tr>
      <tr><th>Internet TLD</th><td>.ke</td></tr></table>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && x.o === "+254")).toBe(true);
    expect(t.some((x) => x.s === "Kenyan" && /demonym of Kenya/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && x.o === ".ke")).toBe(true);
  });

  test("wikitext |capital= and parser wt", () => {
    const wt = wikiCapital(KENYA, `<pre>|capital = [[Nairobi]]</pre>`, "");
    expect(wt?.o).toBe("Nairobi");
    expect(wt?.s).toBe("Kenya");
    const json = wikiCapital(KENYA, `{"capital":{"wt":"[[Nairobi]]"}}`, "");
    expect(json?.o).toBe("Nairobi");
  });

  test("nowrap template around the capital link", () => {
    const fixture = `{{Infobox country
| conventional_long_name = Republic of Kenya
| capital = {{nowrap|[[Nairobi]]}}
| iso3166code = KE
}}`;
    expect(wikiCapitalFromWikitext("| capital = [[Nairobi]]")).toBe("Nairobi");
    expect(wikiCapitalFromWikitext(fixture)).toBe("Nairobi");
    const t = wikiCapital(KENYA, fixture, "");
    expect(t).toEqual({
      s: "Kenya",
      p: "capital",
      o: "Nairobi",
      e: "capital of Kenya is Nairobi",
    });
    expect(persistable(KENYA, t!)).toBe(false);
  });

  test("does not invert country/capital from a Country row", () => {
    const html = `<table class="infobox"><tr><th>Country</th><td>Kenya</td></tr>
      <tr><th>Largest city</th><td>Nairobi</td></tr></table>`;
    expect(wikiCapital(KENYA, html, "")).toBeUndefined();
  });

  test("ISO 3166-1 alpha-2 from infobox is persistable id", () => {
    const id = wikiIso(KENYA, KENYA_INFOBOX);
    expect(id).toEqual({ s: "Kenya", p: "id", o: "KE", e: "Kenya ISO 3166-1 alpha-2 KE" });
    expect(persistable(KENYA, id!)).toBe(false);
    const t = triplesFromPage(KENYA, KENYA_INFOBOX, true);
    expect(t.some((x) => x.p === "id" && x.s === "Kenya" && x.o === "KE")).toBe(true);
    expect(t.some((x) => x.s === "KE" && x.p === "is" && /ISO 3166-1 alpha-2 of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Nairobi" && x.p === "is" && /city in Kenya/i.test(x.o))).toBe(true);
  });
});

describe("wikipedia Action API fallback (no network)", () => {
  const KENYA_WT = `{{Infobox country
| capital = {{nowrap|[[Nairobi]]}}
| iso3166code = KE
}}`;
  const ACTION_JSON = JSON.stringify({
    query: {
      pages: [
        {
          title: "Kenya",
          revisions: [{ slots: { main: { content: KENYA_WT } } }],
        },
      ],
    },
  });
  const ACTION_JSON_V1 = JSON.stringify({
    query: {
      pages: {
        "15580": { title: "Kenya", revisions: [{ "*": "| capital = [[Nairobi]]\n" }] },
      },
    },
  });
  const REST_JSON = JSON.stringify({
    title: "Kenya",
    extract: "Kenya is a country in East Africa. Its capital and largest city is Nairobi.",
  });
  const SHELL = `<html><title>Kenya</title><p>Kenya is a country in East Africa with a long enough lead for extract.</p></html>`;

  test("Action API URL is wikipedia.org only; nytimes is out", () => {
    const api = wikiActionApiUrl(KENYA);
    expect(api).toContain("en.wikipedia.org/w/api.php");
    expect(api).toContain("action=query");
    expect(api).toContain("rvprop=content");
    expect(api).toContain("rvsection=0");
    expect(api).toContain("titles=Kenya");
    expect(wikiRestSummaryUrl(KENYA)).toContain("/api/rest_v1/page/summary/Kenya");
    expect(wikiActionApiUrl("https://www.nytimes.com/2026/01/01/kenya")).toBeUndefined();
    expect(wikiRestSummaryUrl("https://www.nytimes.com/2026/01/01/kenya")).toBeUndefined();
    expect(wikiNeedsApiFallback("https://www.nytimes.com/2026/01/01/kenya", SHELL)).toBe(false);
    expect(skipHost("https://www.nytimes.com/2026/01/01/kenya")).toBe("paywall-host");
  });

  test("HTML shell with no infobox needs API; infobox does not", () => {
    expect(wikiNeedsApiFallback(KENYA, SHELL)).toBe(true);
    expect(wikiNeedsApiFallback(KENYA, KENYA_INFOBOX)).toBe(false);
    expect(wikiNeedsApiFallback("https://www.rfc-editor.org/rfc/rfc3986.html", SHELL)).toBe(false);
  });

  test("revision JSON → Nairobi triple via applyWikiApiFallback", () => {
    expect(wikiRevisionWikitext(JSON.parse(ACTION_JSON))).toContain("nowrap");
    expect(wikiRevisionWikitext(JSON.parse(ACTION_JSON_V1))).toContain("Nairobi");
    expect(wikiApiBodyToText(ACTION_JSON)).toContain("capital");
    const html = applyWikiApiFallback(KENYA, SHELL, ACTION_JSON);
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    expect(applyWikiApiFallback(KENYA, KENYA_INFOBOX, ACTION_JSON)).toBe(KENYA_INFOBOX);
  });

  test("REST summary extract is a last-ditch capital", () => {
    expect(wikiSummaryExtract(JSON.parse(REST_JSON))).toMatch(/Nairobi/);
    const html = applyWikiApiFallback(KENYA, SHELL, REST_JSON);
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
  });

  test("wikiReadAllowed: articles + query API in; paywalls and Special out", () => {
    expect(wikiReadAllowed(KENYA)).toBe(true);
    expect(wikiReadAllowed(wikiActionApiUrl(KENYA)!)).toBe(true);
    expect(wikiReadAllowed(wikiRestSummaryUrl(KENYA)!)).toBe(true);
    expect(wikiReadAllowed("https://en.wikipedia.org/w/api.php?action=edit")).toBe(false);
    expect(wikiReadAllowed("https://en.wikipedia.org/wiki/Special:Search")).toBe(false);
    expect(wikiReadAllowed("https://www.nytimes.com/2026/01/01/x")).toBe(false);
  });
});

describe("national capitals table yield", () => {
  test("fixture: country subject, city object, no continents", () => {
    const t = wikiCapitalTable(FIXTURE);
    expect(t.length).toBeGreaterThanOrEqual(5);
    expect(t.some((x) => x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "France" && x.o === "Paris")).toBe(true);
    expect(t.some((x) => x.s === "Japan" && x.o === "Tokyo")).toBe(true);
    expect(t.some((x) => x.s === "Germany" && x.o === "Berlin")).toBe(true);
    expect(t.some((x) => x.s === "Australia" && x.o === "Canberra")).toBe(true);
    expect(t.some((x) => x.s === "Nairobi" || x.s === "Paris" || x.s === "Tokyo")).toBe(false);
    expect(t.some((x) => /^(africa|asia|europe|oceania)$/i.test(x.s))).toBe(false);
  });

  test("locked fixture: every country/capital row, no Melbourne/Sydney junk", () => {
    const page = triplesFromPage(LIST, FIXTURE, true);
    const caps = page.filter((x) => x.p === "capital");
    const byCountry = Object.fromEntries(caps.map((x) => [x.s, x.o]));
    expect(byCountry.Kenya).toBe("Nairobi");
    expect(byCountry.France).toBe("Paris");
    expect(byCountry.Japan).toBe("Tokyo");
    expect(byCountry.Germany).toBe("Berlin");
    expect(byCountry.Australia).toBe("Canberra");
    expect(caps.some((x) => x.s === "West Germany" && x.o === "Bonn")).toBe(true);
    expect(caps.some((x) => /melbourne|sydney/i.test(x.s) || /melbourne|sydney/i.test(x.o))).toBe(false);
    expect(
      caps.some(
        (x) => x.s === "Nairobi" || x.s === "Paris" || x.s === "Tokyo" || x.s === "Canberra" || x.s === "Berlin",
      ),
    ).toBe(false);
    const countries = new Set(caps.map((x) => x.s));
    expect(countries.has("Kenya")).toBe(true);
    expect(countries.has("France")).toBe(true);
    expect(countries.has("Japan")).toBe(true);
    expect(countries.has("Germany")).toBe(true);
    expect(countries.has("Australia")).toBe(true);
    expect(caps.length).toBeGreaterThanOrEqual(6);
    expect(page.every((x) => persistable(LIST, x))).toBe(false);
  });

  test("Parsoid rowspan: Australia still extracted when continent td is omitted", () => {
    const html = `<table class="wikitable">
      <tr><th>City/Town</th><th>Country/Territory</th><th>Continent</th><th>Notes</th></tr>
      <tr>
        <td><a href="/wiki/Berlin">Berlin</a></td>
        <td><span class="flagicon"><span typeof="mw:File"><a href="/wiki/File:Flag_of_Germany.svg"><img alt="Flag of Germany"></a></span></span><span typeof="mw:Entity">&#160;</span><a href="/wiki/Germany" title="Germany">Germany</a></td>
        <td rowspan="2">Europe</td>
        <td><a>Bonn</a> was the capital of <a>West Germany</a>.</td>
      </tr>
      <tr>
        <td><a href="/wiki/Canberra">Canberra</a></td>
        <td data-mw='{"html":"<b>x</b>"}'><span class="flagicon"><a href="./File:Flag_of_Australia.svg" class="mw-file-description"><img alt=""></a></span><span typeof="mw:Entity">&#160;</span><a href="/wiki/Australia" title="Australia">Australia</a></td>
        <td>Planned city to mitigate rivalry between <a>Melbourne</a> (de facto capital) and <a>Sydney</a>.</td>
      </tr>
    </table>`;
    const t = wikiCapitalTable(html);
    expect(t.some((x) => x.s === "Germany" && x.o === "Berlin")).toBe(true);
    expect(t.some((x) => x.s === "Australia" && x.o === "Canberra")).toBe(true);
    expect(t.some((x) => x.s === "West Germany" && x.o === "Bonn")).toBe(true);
    expect(t.some((x) => /melbourne|sydney/i.test(x.s) || /melbourne|sydney/i.test(x.o))).toBe(false);
    const page = triplesFromPage("https://en.wikipedia.org/wiki/List_of_cities", html, true);
    expect(page.some((x) => x.s === "Germany" && x.p === "capital" && x.o === "Berlin")).toBe(true);
    expect(page.some((x) => x.s === "Australia" && x.p === "capital" && x.o === "Canberra")).toBe(true);
    expect(page.some((x) => /melbourne|sydney/i.test(x.s) || /melbourne|sydney/i.test(x.o))).toBe(false);
  });

  test("header variants Nation / Capital city and Sovereign state / Seat", () => {
    const nation = wikiCapitalTable(
      `<table><tr><th>Nation</th><th>Capital city</th></tr>
       <tr><td><a>Kenya</a></td><td><a>Nairobi</a></td></tr></table>`,
    );
    expect(nation.some((x) => x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    const seat = wikiCapitalTable(
      `<table><tr><th>Sovereign state</th><th>Seat of government</th></tr>
       <tr><td><a>France</a></td><td><a>Paris</a></td></tr></table>`,
    );
    expect(seat.some((x) => x.s === "France" && x.o === "Paris")).toBe(true);
  });
});

describe("RFC HTML title yield", () => {
  test("span.h1 wins over When server body gist", () => {
    const html = `<pre>Request for Comments: 3986
<span class="h1">Uniform Resource Identifier (URI): Generic Syntax</span>
Status of This Memo
When servers process a request they must validate the URI.
RFC 3986                   URI Generic Syntax               January 2005
</pre>`;
    const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc3986.html", html, true);
    const hit = t.find((x) => x.s === "RFC 3986" && x.p === "is");
    expect(hit?.o).toContain("URI");
    expect(hit?.o).not.toMatch(/when server/i);
    expect(rfcTitleFromHtml(html, "3986", "When servers process a request they must", undefined)).toContain("URI");
  });

  test("h1 RFC number is skipped; following h1 is the title", () => {
    const html = `<title>RFC 9110: HTTP Semantics</title><h1>RFC 9110</h1><h1>HTTP Semantics</h1>
      <p>When servers receive a request they look at the method.</p>`;
    const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc9110.html", html, true);
    expect(t.some((x) => x.s === "RFC 9110" && x.p === "is" && /Semantics/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 9110" && /when server/i.test(x.o))).toBe(false);
  });

  test("RFC HTML prose obsoletes become edge facts", () => {
    const html = `<html><head><title>RFC 3986: Uniform Resource Identifier (URI): Generic Syntax</title>
      <meta name="citation_title" content="Uniform Resource Identifier (URI): Generic Syntax"></head>
      <body><h1>RFC 3986</h1><p>This document defines Uniform Resource Identifier (URI): Generic Syntax and obsoletes RFC 2396 and RFC 2732.</p></body></html>`;
    const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc3986.html", html, true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "is" && /URI/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "obsoletes" && /2396/.test(x.o) && /2732/.test(x.o))).toBe(true);
    expect(t.some((x) => /when server/i.test(x.o))).toBe(false);
  });

  test("RFC HTML Obsoletes/Updates become edge facts", () => {
    const html = `<pre>RFC 9110
Obsoletes: 7230, 7231
Updates: 3864
HTTP Semantics</pre>`;
    const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc9110.html", html, true);
    expect(t.some((x) => x.s === "RFC 9110" && x.p === "obsoletes" && /7230/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 9110" && x.p === "updates" && /3864/.test(x.o))).toBe(true);
  });

  test("RFC HTML title + obsoletes + updates + status + STD id, not memo gist", () => {
    const html = `<html><head><title>RFC 3986: Uniform Resource Identifier (URI): Generic Syntax</title>
<meta name="citation_title" content="Uniform Resource Identifier (URI): Generic Syntax"></head>
<body><pre>Request for Comments: 3986
Updates: 1738
Obsoletes: 2732, 2396, 1808
Category: Standards Track
STD 66
<span class="h1">Uniform Resource Identifier (URI): Generic Syntax</span>
Status of This Memo
This document specifies an Internet standards track protocol for the Internet community.
When servers process a request they must validate the URI.
</pre></body></html>`;
    const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc3986.html", html, true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "is" && /URI/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "obsoletes" && /2732/.test(x.o) && /1808/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "updates" && /1738/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "is" && /Internet Standard/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "id" && x.o === "STD 66")).toBe(true);
    expect(t.some((x) => x.s === "RFC 2396" && x.p === "is" && /obsoleted by RFC 3986/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 1738" && x.p === "is" && /updated by RFC 3986/i.test(x.o))).toBe(true);
    expect(t.some((x) => /when server|status of this memo|this document specifies/i.test(x.o))).toBe(false);
    expect(
      t.every(
        (x) =>
          persistable("https://www.rfc-editor.org/rfc/rfc3986.html", x) ===
          (x.p === "obsoletes" || x.p === "updates" || x.p === "id" || /^(obsoleted|updated) by\b/i.test(x.o)),
      ),
    ).toBe(true);
  });
});

describe("Wikidata SPARQL parse", () => {
  test("capitals still parse; ISO P297 as id; Q-ids skipped", () => {
    const t = parseWikidataCapitals({
      results: {
        bindings: [
          {
            countryLabel: { value: "Kenya" },
            capitalLabel: { value: "Nairobi" },
            iso: { value: "KE" },
          },
          { countryLabel: { value: "France" }, capitalLabel: { value: "Paris" } },
          { countryLabel: { value: "Q1" }, capitalLabel: { value: "Nope" }, iso: { value: "ZZ" } },
          { countryLabel: { value: "Spain" }, capitalLabel: { value: "Madrid" }, iso: { value: "not-a-code" } },
        ],
      },
    });
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && x.o === "KE")).toBe(true);
    expect(t.some((x) => x.s === "France" && x.o === "Paris")).toBe(true);
    expect(t.some((x) => x.s === "Q1")).toBe(false);
    expect(t.some((x) => x.p === "id" && x.o === "ZZ")).toBe(false);
    expect(t.some((x) => x.s === "Spain" && x.p === "id")).toBe(false);
    expect(
      persistable("https://query.wikidata.org/sparql", {
        s: "Kenya",
        p: "id",
        o: "KE",
        e: "Kenya ISO 3166-1 alpha-2 KE",
      }),
    ).toBe(false);
  });
});

describe("prose capital sax", () => {
  test("prose Kenya's capital is Nairobi", () => {
    const t = triplesFromPage(
      "https://en.wikipedia.org/wiki/Kenya",
      `<html><p>Kenya's capital is Nairobi and the country is in East Africa with more than eighty letters of english prose here so extract keeps going.</p></html>`,
      true,
    );
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
  });
});

describe("extractLinks", () => {
  test("resolves relative /wiki/, skips paywalls, prefers catalog", () => {
    const html = `<a href="/wiki/Kenya">Kenya</a>
      <a href="https://www.nytimes.com/2026/01/01/x">nyt</a>
      <a href="https://spam.example/noise">junk</a>
      <a href="https://www.rfc-editor.org/rfc/rfc3986.html">rfc</a>
      <a href="/wiki/File:Flag.svg">flag</a>`;
    const links = extractLinks(LIST, html);
    expect(links).toContain("https://en.wikipedia.org/wiki/Kenya");
    expect(links).toContain("https://www.rfc-editor.org/rfc/rfc3986.html");
    expect(links.some((u) => /nytimes/.test(u))).toBe(false);
    expect(links.some((u) => /File:/.test(u))).toBe(false);
    expect(links[0]).toMatch(/wikipedia\.org|rfc-editor\.org/);
    expect(skipHost("https://www.nytimes.com/2026/01/01/x")).toBe("paywall-host");
    expect(skipHost(KENYA)).toBeUndefined();
  });

  test("wiki list pages keep more than 100 useful links", () => {
    const parts = Array.from({ length: 150 }, (_, i) => `<a href="/wiki/Country_${i}">C${i}</a>`);
    const links = extractLinks(LIST, parts.join("\n"));
    expect(links.length).toBe(150);
    expect(links[0]).toBe("https://en.wikipedia.org/wiki/Country_0");
  });
});

describe("keepWet FineWeb meter", () => {
  test("junk hosts stay false; rfc/ietf/w3/iana/spdx/unicode/whatwg stay true; nist is not a registry", () => {
    const long =
      "This is a long enough english page about nothing in particular, just filler text for a junk host that the old length floor would have admitted. ".repeat(
        4,
      );
    expect(keepWet({ uri: "https://spam.junk.test/long", text: long })).toBe(false);
    expect(keepWet({ uri: "https://learn-python-scam.example/essay", text: long })).toBe(false);
    expect(keepWet({ uri: "https://spam.rfc.test/clickbait", text: long })).toBe(false);
    expect(keepWet({ uri: "https://www.rfc-editor.org/rfc/rfc3986.html", text: long })).toBe(true);
    expect(keepWet({ uri: "https://www.ietf.org/rfc/rfc9110.html", text: long })).toBe(true);
    expect(keepWet({ uri: "https://www.w3.org/TR/json-ld11/", text: long })).toBe(true);
    expect(keepWet({ uri: "https://www.iana.org/assignments/media-types/application/json", text: long })).toBe(true);
    expect(keepWet({ uri: "https://spdx.org/licenses/", text: long })).toBe(true);
    expect(keepWet({ uri: "https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt", text: long })).toBe(true);
    expect(keepWet({ uri: "https://whatwg.org/", text: long })).toBe(true);
    expect(keepWet({ uri: "https://github.com/whatwg/html", text: long })).toBe(true);
    const bun =
      "Bun is a fast JavaScript runtime, bundler, test runner, and package manager. " +
      "Agents use it to run TypeScript without a separate compile step on everyday services. " +
      "The project documents install, test, and package commands for application teams.";
    expect(keepWet({ uri: "https://github.com/oven-sh/bun", text: bun })).toBe(true);
    expect(keepWet({ uri: "https://github.com/random-user/hello", text: bun })).toBe(false);
    expect(keepWet({ uri: "https://github.com/oven-sh/bun/issues/1", text: bun })).toBe(true);
    expect(keepWet({ uri: "https://docs.python.org/3/", text: bun })).toBe(true);
    expect(keepWet({ uri: "https://www.nist.gov/pml/", text: long })).toBe(false);
    const reuters =
      "Reuters staff report that the city council voted after midnight on a budget amendment covering transit. ".repeat(
        4,
      );
    expect(keepWet({ uri: "https://www.reuters.com/world/city-council-vote", text: reuters })).toBe(true);
  });

  test("wikipedia encyclopedia drops; casino wiki-mirrors still drop", () => {
    const filler = "The protocol is used by agents and origin servers around the world for everyday work. ";
    const kenya = `The capital of Kenya is Nairobi and the city hosts the government. ${filler.repeat(3)}`;
    const long =
      "This is a long enough english page about nothing in particular, just filler text for a junk host that the old length floor would have admitted. ".repeat(
        4,
      );
    const casino = `Best casino slots bahis win now! The capital of luck is winning tonight. ${"bahis casino slot ".repeat(20)}`;
    expect(keepWet({ uri: "https://en.wikipedia.org/wiki/Kenya", text: kenya })).toBe(false);
    expect(keepWet({ uri: "https://www.wikidata.org/wiki/Q114", text: kenya })).toBe(false);
    expect(keepWet({ uri: "https://en.wikipedia.org/wiki/Travel", text: long })).toBe(false);
    expect(keepWet({ uri: "https://en.wikipedia.org/wiki/Online_casino", text: casino })).toBe(false);
    expect(keepWet({ uri: "https://www.wikimedia.org/wiki/Casino", text: casino })).toBe(false);
  });

  test("Gopher quality drops repetition and casino; fact-bearing quality English is kept", () => {
    const filler = "The protocol is used by agents and origin servers around the world for everyday work. ";
    const rfc = `RFC 9110: HTTP Semantics. This document defines HTTP semantics. ${filler.repeat(3)}`;
    const media = `The IANA media type application/json is JSON. ${filler.repeat(3)}`;
    const spdx = `Projects declare SPDX-License-Identifier: MIT when they publish source. ${filler.repeat(3)}`;
    const iso = `Kenya uses ISO 3166-1 alpha-2 KE as its country code in trade documents. ${filler.repeat(3)}`;
    const lateRfc =
      "Chapter one covers sockets. Chapter two walks through percent-encoding. " +
      "Chapter three shows how user agents resolve a relative reference against a base. " +
      "Chapter four compares file paths with HTTP targets. Chapter five is a short errata list. " +
      "Chapter six records interop bugs from early browsers. Chapter seven restates the grammar. " +
      "Chapter eight is examples only. Chapter nine lists reserved characters. " +
      "Chapter ten explains fragments versus queries. Chapter eleven is a history of WHATWG URL. " +
      "Chapter twelve warns about backslashes. Appendix A is a mapping from file URLs to local paths. " +
      "Appendix B covers internationalized domain names and punycode round trips. " +
      "Appendix C is operator notes from a CDN that saw mixed encodings on the same host. " +
      "After more than eight hundred characters of that survey, " +
      "the author finally cites RFC 3986: Uniform Resource Identifier Generic Syntax for parsers.";
    const capital = `Nairobi is the capital of Kenya and the city hosts the government. ${filler.repeat(3)}`;
    const casino = `Best casino slots bahis win now! The capital of luck is winning tonight. ${"bahis casino slot ".repeat(20)}`;
    const thinRepeat = `The capital of France is Paris. A long travel essay about wine. ${"word ".repeat(40)}`;
    const paywall = `The capital of Kenya is Nairobi. ${filler.repeat(3)}`;
    const spanish =
      "El capital de Francia es Paris y la historia sigue con muchas palabras espanolas sobre vino y viajes por el pais. ".repeat(
        4,
      );

    expect(gopherSkip(rfc)).toBeUndefined();
    expect(wetFactBearing(rfc)).toBe(true);
    expect(keepWet({ uri: "https://blog.example/http-semantics", text: rfc })).toBe(true);
    expect(keepWet({ uri: "https://notes.example/json-type", text: media })).toBe(true);
    expect(keepWet({ uri: "https://notes.example/mit-license", text: spdx })).toBe(true);
    expect(keepWet({ uri: "https://notes.example/iso-kenya", text: iso })).toBe(true);
    expect(lateRfc.indexOf("RFC 3986")).toBeGreaterThan(800);
    expect(keepWet({ uri: "https://notes.example/uri-later", text: lateRfc })).toBe(true);
    expect(keepWet({ uri: "https://notes.example/nairobi", text: capital })).toBe(true);
    expect(keepWet({ uri: "https://spam.example/casino", text: casino })).toBe(false);
    expect(keepWet({ uri: "https://blog.example/essay", text: thinRepeat })).toBe(false);
    expect(keepWet({ uri: "https://www.nytimes.com/world/kenya", text: paywall })).toBe(false);
    expect(keepWet({ uri: "https://noticias.example/paris", text: spanish })).toBe(false);
    expect(keepWet({ uri: "https://example.org/x", text: "short" })).toBe(false);
    const physics = `Quantum mechanics describes nature at atomic and subatomic scales with operators on Hilbert space. ${filler.repeat(3)}`;
    expect(keepWet({ uri: "https://en.wikipedia.org/wiki/Quantum_mechanics", text: physics })).toBe(false);
    const countryOnly = `Kenya is a country in East Africa and the highlands run the length of the nation. ${filler.repeat(3)}`;
    expect(wetFactBearing(countryOnly)).toBe(true);
    expect(keepWet({ uri: "https://en.wikipedia.org/wiki/Kenya", text: countryOnly })).toBe(false);
    const arxiv = `We present a method. arXiv:1706.03762 Attention is all you need. ${filler.repeat(3)}`;
    expect(wetFactBearing(arxiv)).toBe(true);
    expect(keepWet({ uri: "https://arxiv.org/abs/1706.03762", text: arxiv })).toBe(true);
    const company = `Acme is a company founded in 1998 with headquarters in Nairobi and offices across East Africa. ${filler.repeat(3)}`;
    const city = `Nairobi is a city in Kenya and the highlands run the length of the nation around it. ${filler.repeat(3)}`;
    expect(wetFactBearing(company)).toBe(true);
    expect(wetFactBearing(city)).toBe(true);
    expect(keepWet({ uri: "https://en.wikipedia.org/wiki/Acme", text: company })).toBe(false);
  });

  test("bench WET_SAMPLES kept/scanned plus extras: catalog in, junk out, fact pages in", () => {
    const wetSamples = [
      {
        uri: "https://www.rfc-editor.org/rfc/rfc3986.html",
        text: "RFC 3986 Uniform Resource Identifier (URI): Generic Syntax. " + "word ".repeat(40),
      },
      {
        uri: "https://en.wikipedia.org/wiki/Kenya",
        text: "The capital of Kenya is Nairobi. Kenya is a country in East Africa and the city hosts the government for the republic.",
      },
      { uri: "https://spam.example/clickbait", text: "buy now!!! cheap cheap cheap " + "CLICK ".repeat(80) },
      {
        uri: "https://blog.example/essay",
        text: "The capital of France is Paris. A long travel essay about wine. " + "word ".repeat(40),
      },
      {
        uri: "https://www.iana.org/assignments/media-types/application/json",
        text: "application/json JSON " + "word ".repeat(40),
      },
      { uri: "https://example.org/x", text: "short" },
    ];
    const keptBench = wetSamples.filter((r) => keepWet(r));
    expect(keptBench.map((r) => r.uri)).toEqual([
      "https://www.rfc-editor.org/rfc/rfc3986.html",
      "https://www.iana.org/assignments/media-types/application/json",
    ]);
    expect(keptBench.length / wetSamples.length).toBeCloseTo(1 / 3);

    const filler = "Agents and origin servers use this every day when they speak HTTP. ";
    const extra = [
      { uri: "https://dev.example/rfc9110", text: `RFC 9110: HTTP Semantics. ${filler.repeat(4)}` },
      {
        uri: "https://dev.example/json",
        text: `Send application/json in the Content-Type header. ${filler.repeat(4)}`,
      },
      {
        uri: "https://casino.example/play",
        text: `bahis casino slot gacor ${filler.repeat(4)} RFC 9110: HTTP Semantics.`,
      },
    ];
    expect(extra.filter((r) => keepWet(r)).map((r) => r.uri)).toEqual([
      "https://dev.example/rfc9110",
      "https://dev.example/json",
    ]);
  });

  test("WET scan depth is 40× keep, at least 2000", () => {
    expect(wetScanCap(40)).toBeGreaterThanOrEqual(2_000);
    expect(wetScanCap(120)).toBe(Math.max(2_000, 120 * 40));
  });

  test("rankFrontierUrls keeps robots-ok non-catalog hosts", () => {
    const urls = rankFrontierUrls([
      "https://notes.example/uri-later",
      "https://www.nytimes.com/world/kenya",
      "https://www.rfc-editor.org/rfc/rfc3986.html",
    ]);
    expect(urls).toContain("https://notes.example/uri-later");
    expect(urls).toContain("https://www.rfc-editor.org/rfc/rfc3986.html");
    expect(urls.some((u) => /nytimes/.test(u))).toBe(false);
  });
});

describe("JSON-LD @graph / @value yield", () => {
  test("@graph array of Country + @value names", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Country","name":{"@value":"Kenya","@language":"en"},"capital":{"@type":"City","name":{"@value":"Nairobi"}}},
      {"@type":["Country","Place"],"name":"France","capital":{"@id":"https://en.wikipedia.org/wiki/Paris"}},
      {"@type":"https://schema.org/Country","name":{"en":"Japan"},"capital":"Tokyo"}
    ]}</script>`;
    const t = triplesFromPage("https://www.wikidata.org/wiki/Q114", html, true);
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.p === "capital" && x.s === "France" && x.o === "Paris")).toBe(true);
    expect(t.some((x) => x.p === "capital" && x.s === "Japan" && x.o === "Tokyo")).toBe(true);
    expect(t.some((x) => /object Object/i.test(x.s) || /object Object/i.test(x.o))).toBe(false);
  });

  test("ld+json charset + entity-encoded block still parses", () => {
    const html = `<script type="application/ld+json; charset=utf-8">{"@type":"Country","name":"Kenya","capital":{"name":"Nairobi"}}</script>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
  });
});

describe("microdata / RDFa capitals", () => {
  test("schema.org Country itemprop name+capital", () => {
    const html = `<div itemscope itemtype="https://schema.org/Country">
      <span itemprop="name">Kenya</span>
      <span itemprop="capital" itemscope itemtype="https://schema.org/City"><span itemprop="name">Nairobi</span></span>
    </div>`;
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Kenya", html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
  });

  test("schema: prefixed RDFa Country still yields Kenya → Nairobi", () => {
    const html = `<div typeof="schema:Country" resource="https://example.org/Kenya">
      <span property="schema:name">Kenya</span>
      <span property="schema:capital">Nairobi</span>
    </div>`;
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Kenya", html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
  });
});

describe("RFC XML docName/title", () => {
  test("xml2rfc title with attributes and number/docName", () => {
    const xml = `<?xml version="1.0"?>
<rfc xmlns="http://www.rfc-editor.org/rfc" number="3986" category="std" docName="rfc3986" obsoletes="1808,2732" updates="1738">
  <front>
    <title abbrev="URI Generic Syntax">Uniform Resource Identifier (URI): Generic Syntax</title>
    <author><title>Editor</title></author>
  </front>
</rfc>`;
    const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc3986.xml", xml, true);
    const hit = t.find((x) => x.s === "RFC 3986" && x.p === "is");
    expect(hit?.o).toContain("URI");
    expect(hit?.o).not.toMatch(/editor/i);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "obsoletes" && /1808/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "updates" && /1738/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "is" && /Internet Standard/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && /when server|editor/i.test(x.o))).toBe(false);
  });

  test("citation_title and DC.Title when h1 is missing", () => {
    const html = `<html><head>
      <meta name="citation_title" content="HTTP Semantics">
      <meta name="DC.Title" content="HTTP Semantics">
      <title>rfc9110</title>
    </head><body><p>When servers process a request they must validate the method.</p></body></html>`;
    const t = triplesFromPage("https://datatracker.ietf.org/doc/html/rfc9110", html, true);
    expect(t.some((x) => x.s === "RFC 9110" && x.p === "is" && /Semantics/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 9110" && /when server/i.test(x.o))).toBe(false);
  });
});

describe("Wikipedia redirect / displaytitle", () => {
  test("canonical and displaytitle beat the redirect slug", () => {
    const html = `<link rel="canonical" href="https://en.wikipedia.org/wiki/Kenya">
      <meta property="mw:PageProp/displaytitle" content="Kenya"/>
      <h1 id="firstHeading"><span class="mw-page-title-main">Kenya</span></h1>
      <table class="infobox"><tr><th>Capital</th><td><a href="/wiki/Nairobi">Nairobi</a></td></tr></table>`;
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Republic_of_Kenya", html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "Republic of Kenya")).toBe(false);
  });

  test("Action API redirects JSON stamps canonical Kenya", () => {
    const shell = `<html><p>Republic of Kenya redirects; enough english prose for extract fallback.</p></html>`;
    const api = JSON.stringify({
      query: {
        redirects: [{ from: "Republic of Kenya", to: "Kenya" }],
        pages: [{ title: "Kenya", revisions: [{ slots: { main: { content: "| capital = [[Nairobi]]\n" } } }] }],
      },
    });
    const html = applyWikiApiFallback("https://en.wikipedia.org/wiki/Republic_of_Kenya", shell, api);
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Republic_of_Kenya", html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
  });
});

describe("Link rel=alternate + HTTP Link", () => {
  test("alternate RFC XML is preferred; paywalls and edit links stay out", () => {
    const html = `<link rel="alternate" type="application/rfc+xml" href="https://www.rfc-editor.org/rfc/rfc3986.xml">
      <link rel="alternate" type="application/x-wiki" href="/w/index.php?title=Kenya&action=edit">
      <a href="https://www.nytimes.com/2026/01/01/x">nyt</a>
      <a href="/wiki/Kenya">Kenya</a>`;
    const links = extractLinks("https://en.wikipedia.org/wiki/Kenya", html);
    expect(links[0]).toBe("https://www.rfc-editor.org/rfc/rfc3986.xml");
    expect(links).toContain("https://en.wikipedia.org/wiki/Kenya");
    expect(links.some((u) => /nytimes|action=edit|index\.php/.test(u))).toBe(false);
  });

  test("WARC Link header is folded into the body as rel=alternate", () => {
    const raw =
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nLink: <https://www.rfc-editor.org/rfc/rfc3986.xml>; rel="alternate"; type="application/rfc+xml"\r\n\r\n<html>ok</html>';
    const body = httpBody(raw);
    expect(body).toContain('rel="alternate"');
    expect(body).toContain("rfc3986.xml");
    expect(body).toContain("<html>ok</html>");
  });
});

describe("infobox extras, definition lists, WET harvest", () => {
  test("official language and currency from infobox are persistable is-facts", () => {
    const html = `<table class="infobox ib-country">
      <tr><th>Capital</th><td><a href="/wiki/Nairobi">Nairobi</a></td></tr>
      <tr><th>Official languages</th><td><a href="/wiki/English_language">English</a>, <a href="/wiki/Swahili_language">Swahili</a></td></tr>
      <tr><th>Currency</th><td><a href="/wiki/Kenyan_shilling">Kenyan shilling</a></td></tr>
    </table>`;
    const extras = wikiInfoboxExtras(KENYA, html);
    expect(extras.some((x) => x.s === "English" && x.p === "is" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(extras.some((x) => x.s === "Swahili" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(extras.some((x) => x.s === "Kenyan shilling" && /currency of Kenya/i.test(x.o))).toBe(true);
    expect(extras.every((x) => persistable(KENYA, x))).toBe(false);
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "English" && /official language of Kenya/i.test(x.o))).toBe(true);
  });

  test("definition list capital + ISO", () => {
    const html = `<dl>
      <dt>Capital</dt><dd><a href="/wiki/Nairobi">Nairobi</a></dd>
      <dt>ISO 3166 code</dt><dd>KE</dd>
    </dl>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && x.o === "KE")).toBe(true);
  });

  test("Wikipedia lead is persistable; list pages skip", () => {
    const lead = wikiLeadIs(KENYA, "", "The capital of Kenya is Nairobi. Kenya is a country in East Africa.");
    expect(lead).toEqual({
      s: "Kenya",
      p: "is",
      o: "a country in East Africa",
      e: "a country in East Africa",
    });
    expect(persistable(KENYA, lead!)).toBe(false);
    expect(wikiLeadIs(LIST, FIXTURE, "List of national capitals is a Wikipedia list.")).toBeUndefined();
  });

  test("GitHub README and tool docs yield a persistable software is-fact", () => {
    const bun = "https://github.com/oven-sh/bun";
    const html = `<meta property="og:description" content="Incredibly fast JavaScript runtime, bundler, test runner, and package manager.">
      <p>Bun is a fast JavaScript runtime. SPDX-License-Identifier: MIT</p>`;
    const t = triplesFromPage(bun, html, true);
    expect(t.some((x) => x.s === "Bun" && x.p === "is" && /runtime/i.test(x.o))).toBe(true);
    expect(t.filter((x) => x.s === "Bun" && /runtime/i.test(x.o)).every((x) => persistable(bun, x))).toBe(false);
    const lead = softwareLeadIs(bun, html, "Bun is a fast JavaScript runtime.");
    expect(lead).toBeUndefined();
    expect(
      softwareLeadIs("https://github.com/random-user/hello", html, "Hello world this is a long enough english page."),
    ).toBeUndefined();
    const py = triplesFromPage(
      "https://docs.python.org/3/",
      "Python is a programming language. The standard library covers http and json.",
      false,
    );
    expect(py.some((x) => x.s === "Python" && /programming language/i.test(x.o))).toBe(true);
  });

  test("prose techniques pack as used-for is-facts, not tautological is-a", () => {
    const url = "https://jqlang.github.io/jq/";
    const text =
      "jq is used for filtering JSON on the command line. Use Bun to run TypeScript services. " +
      "Cargo is the recommended way to build Rust packages from a crate.";
    const t = triplesFromPage(url, text, false);
    expect(
      techniquesFromProse(text).some((x) => x.s === "jq" && x.o === "used for filtering JSON on the command line"),
    ).toBe(true);
    expect(t.some((x) => x.s === "jq" && x.p === "is" && x.o === "used for filtering JSON on the command line")).toBe(
      true,
    );
    expect(t.some((x) => x.s === "Bun" && x.p === "is" && /used for run TypeScript/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Cargo" && x.p === "is" && /used for build Rust/i.test(x.o))).toBe(true);
    expect(t.filter((x) => x.p === "is" && x.o.startsWith("used for ")).every((x) => persistable(url, x))).toBe(true);
    expect(wetFactBearing(text)).toBe(true);
  });

  test("wiki template pipes, official-name echoes, and URL objects are not persistable", () => {
    const wiki = "https://en.wikipedia.org/wiki/Hop_Bottom,_Pennsylvania";
    expect(persistable(wiki, { s: "Hop Bottom, Pennsylvania", p: "is", o: "a |leader_title =", e: "" })).toBe(false);
    expect(
      persistable(wiki, { s: "Hop Bottom", p: "is", o: "the official name of Hop Bottom, Pennsylvania", e: "" }),
    ).toBe(false);
    expect(persistable(wiki, { s: "| image_skyline =", p: "is", o: "the motto of Myangad, Khovd", e: "" })).toBe(false);
    expect(
      persistable(wiki, {
        s: "Edward Tsang",
        p: "is",
        o: "the Director (and co-founder) of [http://www",
        e: "",
      }),
    ).toBe(false);
    expect(persistable(KENYA, { s: "Republic of Kenya", p: "is", o: "the official name of Kenya", e: "" })).toBe(false);
    expect(
      persistable(wiki, { s: "Unincorporated community", p: "is", o: "the official name of Coalton, Kentucky", e: "" }),
    ).toBe(false);
    expect(persistable(wiki, { s: "Latin", p: "is", o: "the motto of HMS Achates (H12)", e: "" })).toBe(false);
    expect(
      persistable(wiki, {
        s: "Platanoussa",
        p: "is",
        o: "situated on the eastern slope of the [[Xerovouni]] mountain",
        e: "",
      }),
    ).toBe(false);
    expect(persistable(wiki, { s: "{{Unbulleted list", p: "is", o: "the currency of France", e: "" })).toBe(false);
    const html = `<table class="infobox"><tr><th>Official name</th><td>Hop Bottom, Pennsylvania</td></tr>
      <tr><th>Motto</th><td>|leader_title = Mayor</td></tr>
      <tr><th>Motto language</th><td>Latin</td></tr>
      <tr><th>Official name</th><td>Unincorporated community</td></tr></table>`;
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Hop_Bottom,_Pennsylvania", html, true);
    expect(t.some((x) => /\|/.test(x.s) || /\|/.test(x.o))).toBe(false);
    expect(t.some((x) => x.s === "Hop Bottom" && /official name of Hop Bottom/i.test(x.o))).toBe(false);
    expect(t.some((x) => x.s === "Latin" && /motto of/i.test(x.o))).toBe(false);
    expect(t.some((x) => x.s === "Unincorporated community")).toBe(false);
  });

  test("wiki lead strips wikilinks and drops leftover templates", () => {
    const linked = wikiLeadIs(
      "https://en.wikipedia.org/wiki/Platanoussa",
      "",
      "Platanoussa is situated on the eastern slope of the [[Xerovouni]] mountain.",
    );
    expect(linked?.o).toBe("situated on the eastern slope of the Xerovouni mountain");
    expect(linked?.o.includes("[")).toBe(false);
    expect(
      wikiLeadIs("https://en.wikipedia.org/wiki/France", "", "France is {{Unbulleted list|the euro}}."),
    ).toBeUndefined();
  });

  test("WET plaintext harvests RFC, media type, SPDX; Kenya/Nairobi stays", () => {
    const wet =
      "Kenya is a country in East Africa. The capital of Kenya is Nairobi. " +
      "RFC 3986: Uniform Resource Identifier Generic Syntax. " +
      "Send application/json. SPDX-License-Identifier: MIT";
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Kenya", wet, false);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "RFC 3986" && x.p === "is" && /URI|Identifier/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "IANA media application/json" && x.p === "is" && x.o === "JSON")).toBe(true);
    expect(t.some((x) => x.s === "SPDX MIT" && x.p === "is")).toBe(true);
    expect(t.every((x) => persistable("https://en.wikipedia.org/wiki/Kenya", x))).toBe(false);
  });

  test("national capitals fragment: continent is-facts and West Germany; no inverted cities", () => {
    const table = wikiCapitalTable(FIXTURE);
    expect(table.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(table.some((x) => x.s === "Kenya" && x.p === "is" && /Africa/i.test(x.o))).toBe(true);
    expect(table.some((x) => x.s === "France" && x.p === "is" && /Europe/i.test(x.o))).toBe(true);
    const page = triplesFromPage(LIST, FIXTURE, true);
    expect(page.some((x) => x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    expect(page.some((x) => x.s === "West Germany" && x.p === "capital" && x.o === "Bonn")).toBe(true);
    expect(page.some((x) => x.s === "West Germany" && x.p === "is" && /Europe/i.test(x.o))).toBe(true);
    expect(page.some((x) => x.s === "Nairobi" || x.s === "Paris" || x.s === "Tokyo")).toBe(false);
    expect(page.filter((x) => x.p === "capital").length).toBeGreaterThanOrEqual(6);
  });

  test("JSON-LD Country officialLanguage + iso3166Code", () => {
    const html = `<script type="application/ld+json">{"@type":"Country","name":"Kenya","capital":{"name":"Nairobi"},"iso3166Code":"KE","officialLanguage":{"name":"Swahili"},"currency":{"name":"Kenyan shilling"}}</script>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && x.o === "KE")).toBe(true);
    expect(t.some((x) => x.s === "Swahili" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenyan shilling" && /currency of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "KE" && /ISO 3166-1 alpha-2 of Kenya/i.test(x.o))).toBe(true);
  });

  test("JSON-LD officialLanguage array + unlinked infobox languages both persist", () => {
    const ld = `<script type="application/ld+json">{"@type":"Country","name":"Kenya","capital":{"name":"Nairobi"},"officialLanguage":[{"name":"English"},{"name":"Swahili"}]}</script>`;
    const tLd = triplesFromPage(KENYA, ld, true);
    expect(tLd.some((x) => x.s === "English" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(tLd.some((x) => x.s === "Swahili" && /official language of Kenya/i.test(x.o))).toBe(true);
    const html = `<table class="infobox"><tr><th>Capital</th><td>Nairobi</td></tr>
      <tr><th>Official languages</th><td>English, Swahili</td></tr>
      <tr><th>Official name</th><td>Republic of Kenya</td></tr>
      <tr><th>Motto</th><td>Harambee</td></tr>
      <tr><th>Currency</th><td>Kenyan shilling (KES)</td></tr></table>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "English" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Swahili" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Republic of Kenya" && /official name of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Harambee" && /motto of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && x.o === "KES")).toBe(true);
    expect(t.every((x) => persistable(KENYA, x))).toBe(false);
  });

  test("RFC HTML titles still win; extra RFC lines do not replace them", () => {
    const html = `<pre>Request for Comments: 3986
<span class="h1">Uniform Resource Identifier (URI): Generic Syntax</span>
Status of This Memo
When servers process a request they must validate the URI.
RFC 3986                   URI Generic Syntax               January 2005
</pre>`;
    const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc3986.html", html, true);
    const hit = t.find((x) => x.s === "RFC 3986" && x.p === "is");
    expect(hit?.o).toContain("URI");
    expect(hit?.o).not.toMatch(/when server/i);
  });

  test("dense City/Town list: digit names persist country→city, not inverted", () => {
    const rows = Array.from({ length: 80 }, (_, i) => {
      const country = `Country${String(i + 1).padStart(3, "0")}`;
      const city = `City${String(i + 1).padStart(3, "0")}`;
      return `<tr><td><a href="/wiki/${city}">${city}</a></td><td><a href="/wiki/${country}">${country}</a></td><td>Africa</td></tr>`;
    }).join("");
    const html = `<table class="wikitable"><tr><th>City/Town</th><th>Country/Territory</th><th>Continent</th></tr>${rows}</table>`;
    const t = triplesFromPage(LIST, html, true);
    const caps = t.filter((x) => x.p === "capital");
    expect(caps.length).toBe(80);
    expect(t.some((x) => x.s === "Country001" && x.p === "capital" && x.o === "City001")).toBe(true);
    expect(t.some((x) => x.s === "Country080" && x.o === "City080")).toBe(true);
    expect(t.some((x) => x.s === "City001" || x.s === "City080")).toBe(false);
    expect(t.filter((x) => x.p === "is" && /Africa/i.test(x.o)).length).toBe(80);
  });

  test("City/Town real names: particles, apostrophe, period", () => {
    const html = `<table class="wikitable"><tr><th>City/Town</th><th>Country/Territory</th></tr>
      <tr><td><a>Yamoussoukro</a></td><td><a>Côte d'Ivoire</a></td></tr>
      <tr><td><a>St. John's</a></td><td><a>Antigua and Barbuda</a></td></tr>
      <tr><td><a>N'Djamena</a></td><td><a>Chad</a></td></tr>
      <tr><td><a>Kinshasa</a></td><td><a>Democratic Republic of the Congo</a></td></tr>
    </table>`;
    const t = wikiCapitalTable(html);
    expect(t.some((x) => x.s === "Côte d'Ivoire" && x.o === "Yamoussoukro")).toBe(true);
    expect(t.some((x) => x.s === "Antigua and Barbuda" && x.o === "St. John's")).toBe(true);
    expect(t.some((x) => x.s === "Chad" && x.o === "N'Djamena")).toBe(true);
    expect(t.some((x) => x.s === "Democratic Republic of the Congo" && x.o === "Kinshasa")).toBe(true);
    expect(t.some((x) => x.s === "Yamoussoukro" || x.s === "Kinshasa")).toBe(false);
  });

  test("WET plaintext harvests language, currency, RFC, media without inventing", () => {
    const wet =
      "The capital of Kenya is Nairobi. English is an official language of Kenya. " +
      "The currency of Kenya is the Kenyan shilling. RFC 9110: HTTP Semantics. Send application/json.";
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Kenya", wet, false);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "English" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenyan shilling" && /currency of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "RFC 9110" && /Semantics/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "IANA media application/json" && x.p === "is")).toBe(true);
    expect(t.some((x) => x.s === "Nairobi" && x.p === "capital")).toBe(false);
    expect(t.every((x) => persistable("https://en.wikipedia.org/wiki/Kenya", x))).toBe(false);
  });
});

describe("one-pass yield: infobox extras, entities, thin HTML", () => {
  test("population area legislature government persist when grounded", () => {
    const html = `<table class="infobox">
      <tr><th>Capital</th><td>Nairobi</td></tr>
      <tr><th>Population</th><td>55,864,655 (2024)</td></tr>
      <tr><th>Area</th><td>580,367 km<sup>2</sup> (224,081 sq mi)</td></tr>
      <tr><th>Legislature</th><td><a href="/wiki/Parliament_of_Kenya">Parliament of Kenya</a></td></tr>
      <tr><th>Government</th><td>Unitary presidential republic</td></tr>
    </table>
    <p>Kenya is a country in East Africa. The capital of Kenya is Nairobi.</p>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && /55[,.]?864[,.]?655/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && /580[,.]?367/.test(x.o) && /km2/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Parliament of Kenya" && /legislature of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "is" && /presidential republic/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "is" && /country in East Africa/i.test(x.o))).toBe(true);
    expect(t.every((x) => persistable(KENYA, x))).toBe(false);
  });

  test("JSON-LD ItemList + description + population", () => {
    const html = `<script type="application/ld+json">{"@graph":[
      {"@type":"ItemList","itemListElement":[
        {"@type":"ListItem","item":{"@type":"Country","name":"Kenya","capital":{"name":"Nairobi"},"description":"A country in East Africa.","population":"55864655","containedInPlace":"East Africa"}}
      ]}
    ]}</script>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "is" && /East Africa/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && /55864655/.test(x.o))).toBe(true);
  });

  test("hostile HTML never emits &#x2F; in objects", () => {
    const html = `<html><p>RFC 4627: The application&#x2F;json Media Type for JSON documents used on the wire today.</p>
      <table class="infobox"><tr><th>Capital</th><td>Nairobi&#x2F;Westlands</td></tr></table></html>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => /&#/.test(x.s) || /&#/.test(x.o) || /&#/.test(x.e))).toBe(false);
    expect(t.some((x) => x.o.includes("&#x2F;") || x.e.includes("&#x2F;"))).toBe(false);
  });

  test("thin HTML yields 0 triples", () => {
    expect(triplesFromPage("https://example.org/x", "<p>hi</p>", true)).toEqual([]);
    expect(triplesFromPage("https://example.org/x", "<html><title>x</title></html>", true)).toEqual([]);
  });

  test("Parsoid infobox: nested area/pop, unlinked English, UTC +3, no cite junk", () => {
    const html = `<html><head><title>Kenya</title></head><body>
      <div class="shortdescription" data-mw='{"parts":[{"template":{"params":{"1":{"wt":"Country in East Africa"}}}}]}'>Country in East Africa</div>
      <table class="infobox ib-country">
        <tr><th scope="row" class="infobox-label">Capital<div class="ib-country-largest">and largest city</div></th>
          <td><a href="/wiki/Nairobi">Nairobi</a></td></tr>
        <tr><th>Official languages</th><td><ul><li><a href="/wiki/Swahili_language">Swahili</a></li>
          <li>English<sup class="reference"><a href="#cite_note-1"><span class="cite-bracket">[</span>1<span class="cite-bracket">]</span></a></sup></li></ul></td></tr>
        <tr><th>Area</th></tr>
        <tr><th>• Total</th><td>580,367 km<sup>2</sup> (224,081 sq mi)</td></tr>
        <tr><th>Population</th></tr>
        <tr><th>• 2026 estimate</th><td>54,227,015<sup class="reference"><a href="#cite_note-2">[2]</a></sup></td></tr>
        <tr><th>Time zone</th><td>UTC +3 (East Africa Time)</td></tr>
        <tr><th>Government</th><td>Unitary presidential republic</td></tr>
        <tr><th>• President</th><td><a href="/wiki/William_Ruto">William Ruto</a></td></tr>
        <tr><td colspan="2">Anthem: <a href="/wiki/Ee_Mungu_Nguvu_Yetu">Ee Mungu Nguvu Yetu</a></td></tr>
      </table>
      <p>Kenya, officially the Republic of Kenya, is a country in East Africa with a long enough lead for extract.</p>
    </body></html>`;
    const t = triplesFromPage(KENYA, html, true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    expect(t.some((x) => x.s === "English" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Swahili" && /official language of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => /^\[\s*\d+\s*\]$/.test(x.s) || x.s.includes("[ 1 ]"))).toBe(false);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && /580[,.]?367/.test(x.o) && /km2/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && /54[,.]?227[,.]?015/.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "id" && /UTC\+3/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "William Ruto" && /president of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Ee Mungu Nguvu Yetu" && /anthem of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Nairobi" && x.p === "is" && /largest city of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Nairobi" && x.p === "is" && /capital of Kenya/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Kenya" && x.p === "is" && /country in East Africa/i.test(x.o))).toBe(true);
    expect(t.some((x) => /&#/.test(x.s) || /&#/.test(x.o))).toBe(false);
    expect(t.every((x) => persistable(KENYA, x))).toBe(false);
    expect(t.length).toBeGreaterThanOrEqual(10);
  });

  test("IANA HTTP status records from registry XML body", () => {
    const xml = `<registry><record><value>404</value><description>Not Found</description></record>
      <record><value>200</value><description>OK</description></record></registry>`;
    const t = triplesFromPage("https://www.iana.org/assignments/http-status-codes/http-status-codes.xml", xml, true);
    expect(t.some((x) => x.s === "IANA http 404" && x.o === "Not Found")).toBe(true);
    expect(t.some((x) => x.s === "IANA http 200" && x.o === "OK")).toBe(true);
  });

  test("RFC title extract still wins over When server", () => {
    const html = `<pre>Request for Comments: 3986
<span class="h1">Uniform Resource Identifier (URI): Generic Syntax</span>
Status of This Memo
When servers process a request they must validate the URI.
RFC 3986                   URI Generic Syntax               January 2005
</pre>`;
    const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc3986.html", html, true);
    const hit = t.find((x) => x.s === "RFC 3986" && x.p === "is");
    expect(hit?.o).toContain("URI");
    expect(hit?.o).not.toMatch(/when server/i);
  });
});

describe("frontier rank + one-pass scan", () => {
  test("talk and RFC beat blogs; wiki encyclopedia dropped; nytimes dropped", () => {
    const ranked = rankFrontierUrls([
      "https://blog.example/essay",
      "https://en.wikipedia.org/wiki/Kenya",
      "https://www.nytimes.com/2026/01/01/x",
      "https://www.rfc-editor.org/rfc/rfc3986.html",
      "https://en.wikipedia.org/wiki/List_of_academic_disciplines",
      "https://en.wikipedia.org/wiki/List_of_national_capitals",
      "https://en.wikipedia.org/wiki/File:Flag.svg",
      "https://www.iana.org/assignments/media-types/application/json",
      "https://old.reddit.com/r/commandline/comments/x/jq/",
      "https://docs.python.org/3/",
    ]);
    expect(ranked[0]).toBe("https://old.reddit.com/r/commandline/comments/x/jq/");
    expect(ranked).toContain("https://docs.python.org/3/");
    expect(ranked).toContain("https://www.rfc-editor.org/rfc/rfc3986.html");
    expect(ranked).toContain("https://www.iana.org/assignments/media-types/application/json");
    expect(ranked.some((u) => /wikipedia\.org/.test(u))).toBe(false);
    expect(ranked.some((u) => /blog.example/.test(u))).toBe(false);
    expect(ranked.some((u) => /nytimes/.test(u))).toBe(false);
    expect(skipHost("https://www.nytimes.com/2026/01/01/x")).toBe("paywall-host");
    expect(skipHost(KENYA)).toBeUndefined();
    expect(rankFrontier("https://old.reddit.com/r/commandline/comments/x/jq/")).toBeLessThan(
      rankFrontier("https://www.rfc-editor.org/rfc/rfc3986.html"),
    );
    expect(rankFrontier("https://docs.python.org/3/")).toBeLessThan(rankFrontier("https://blog.example/essay"));
  });

  test("reused scanHtml matches a fresh extract on Kenya stub and list fixture", () => {
    const kenyaHtml = `<html><title>Kenya</title>${KENYA_INFOBOX}<p>Kenya is a country in East Africa.</p></html>`;
    const scan = scanHtml(kenyaHtml);
    const once = triplesFromPage(KENYA, kenyaHtml, true, scan);
    const twice = triplesFromPage(KENYA, kenyaHtml, true);
    expect(once).toEqual(twice);
    expect(once.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi")).toBe(true);
    const listScan = scanHtml(FIXTURE);
    const listOnce = triplesFromPage(LIST, FIXTURE, true, listScan);
    const listTwice = triplesFromPage(LIST, FIXTURE, true);
    expect(listOnce).toEqual(listTwice);
    expect(listOnce.filter((x) => x.p === "capital").length).toBeGreaterThanOrEqual(6);
  });
});
