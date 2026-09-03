import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodePack, encodePack, encodePackV1, allFacts, overlayFromPackPayload, type PackFact } from "./pack";
import { RFC_TITLE_HOT } from "./rfc-hot";
import { closedCatalog, DNS_OBJECT, HEADER_LIST } from "./synth";
import { httpFieldNames } from "./http-field-tab";
import { mediaTypeNames } from "./media-type-tab";
import { schemeNames } from "./scheme-tab";
import { relNames } from "./rel-tab";

const facts: PackFact[] = [
  { s: "Kenya", p: "capital", o: "Nairobi", e: "", url: "https://example.org/a" },
  { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "https://example.org/rfc" },
  { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "https://example.org/w3" },
  { s: "RFC 9110", p: "obsoletes", o: "RFC 7230, RFC 7231", e: "", url: "https://example.org/rfc" },
  { s: "RFC 8259", p: "updates", o: "RFC 7159", e: "", url: "https://example.org/rfc" },
  { s: "RFC 234", p: "updates", o: "RFC 222, RFC 204", e: "", url: "https://example.org/rfc" },
  { s: "RFC 872", p: "is", o: "TCP-on-a-LAN", e: "", url: "https://example.org/rfc" },
  { s: "IANA protocol 6", p: "is", o: "TCP", e: "Transmission Control", url: "https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xml" },
  { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "https://www.iana.org/assignments/media-types/media-types.xml" },
  { s: "RFC 4627", p: "is", o: "The application/json Media Type for JavaScript Object Notation (JSON)", e: "", url: "https://www.rfc-editor.org/rfc/rfc4627.html" },
  { s: "IANA http 404", p: "is", o: "Not Found", e: "", url: "https://www.iana.org/assignments/http-status-codes/http-status-codes.xml" },
  { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "https://spdx.org/licenses/licenses.json" },
  { s: "IANA method GET", p: "is", o: "Transfer a current representation", e: "", url: "https://www.iana.org/assignments/http-methods/http-methods.xml" },
  { s: "IANA header Accept", p: "is", o: "RFC 9110", e: "", url: "https://www.iana.org/assignments/http-fields/http-fields.xml" },
  { s: "IANA header Accept-CH", p: "is", o: "HTTP field Accept-CH", e: "", url: "https://www.iana.org/assignments/http-fields/http-fields.xml" },
];

describe("KPK9", () => {
  test("leftover IANA/W3C/SPDX catalog rows round-trip", () => {
    const extra: PackFact[] = [
      { s: "IANA media application/1d-interleaved-parityfec", p: "is", o: "1d-interleaved-parityfec", e: "", url: "" },
      { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "" },
      { s: "IANA scheme acap", p: "is", o: "application configuration access protocol", e: "", url: "" },
      { s: "IANA scheme https", p: "is", o: "Hypertext Transfer Protocol Secure", e: "", url: "" },
      { s: "SPDX SISSL", p: "is", o: "Sun Industry Standards Source License v1.1", e: "", url: "" },
      { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "" },
      { s: "W3C css-namespaces-3", p: "is", o: "CSS Namespaces Module Level 3", e: "", url: "" },
      { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const buf = encodePack(extra);
    const p = decodePack(buf);
    const got = allFacts(p);
    expect(got.some((f) => f.s === "IANA media application/1d-interleaved-parityfec" && f.o === "1d-interleaved-parityfec")).toBe(true);
    expect(got.some((f) => f.s === "IANA media application/json" && f.o === "JSON")).toBe(true);
    expect(got.some((f) => f.s === "IANA scheme acap" && f.o === "acap")).toBe(true);
    expect(got.some((f) => f.s === "SPDX SISSL" && f.o === "SISSL")).toBe(true);
    expect(got.some((f) => f.s === "W3C css-namespaces-3" && f.o === "css-namespaces-3")).toBe(true);
    expect(got.some((f) => f.s === "W3C web-share")).toBe(true);
    expect(p.nTriples).toBe(got.length);
    expect(p.nTriples).toBe(extra.length);
  });

  test("IANA HTTP field tab is the official registry, not a dump KEEP list", () => {
    const tab = new Set(httpFieldNames());
    expect(tab.has("ID")).toBe(true);
    expect(tab.has("Accept")).toBe(true);
    expect(tab.size).toBeGreaterThan(HEADER_LIST.length);
    for (const h of HEADER_LIST) expect(tab.has(h)).toBe(true);
    const buf = encodePack([
      { s: "IANA header Accept", p: "is", o: "RFC 9110", e: "", url: "" },
      { s: "IANA header Content-Type", p: "is", o: "HTTP field Content-Type", e: "", url: "" },
    ]);
    const got = allFacts(decodePack(buf)).filter((f) => f.s.startsWith("IANA header "));
    expect(got.map((f) => f.s).sort()).toEqual(["IANA header Accept", "IANA header Content-Type"]);
    expect(got.some((f) => f.s === "IANA header ID")).toBe(false);
  });

  test("leftover W3C shortnames round-trip via official codec tab", () => {
    const extra: PackFact[] = [
      { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "" },
      { s: "W3C css-namespaces-3", p: "is", o: "css-namespaces-3", e: "", url: "" },
      { s: "W3C activitypub", p: "is", o: "activitypub", e: "", url: "" },
      { s: "W3C 1998", p: "is", o: "1998", e: "", url: "" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const buf = encodePack(extra);
    const p = decodePack(buf);
    const got = allFacts(p);
    for (const f of extra) expect(got.some((g) => g.s === f.s && g.p === f.p)).toBe(true);
    expect(p.nTriples).toBe(extra.length);
    expect(got.some((g) => g.s === "W3C yaml-ld-10")).toBe(false);
  });

  test("front-coded leftover media lists round-trip", () => {
    const extra: PackFact[] = [
      { s: "IANA media application/1d-interleaved-parityfec", p: "is", o: "1d-interleaved-parityfec", e: "", url: "" },
      { s: "IANA media application/3gpp-ims+xml", p: "is", o: "3gpp-ims+xml", e: "", url: "" },
      { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "" },
      { s: "IANA media application/vnd.api+json", p: "is", o: "vnd.api+json", e: "", url: "" },
      { s: "IANA media text/html", p: "is", o: "html", e: "", url: "" },
      { s: "IANA media text/plain", p: "is", o: "plain", e: "", url: "" },
      { s: "SPDX Apache-2.0", p: "is", o: "Apache License 2.0", e: "", url: "" },
      { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "" },
      { s: "W3C css-color-4", p: "is", o: "css-color-4", e: "", url: "" },
      { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "" },
    ];
    const buf = encodePack(extra);
    const got = allFacts(decodePack(buf));
    for (const f of extra) {
      expect(got.some((g) => g.s === f.s && g.p === f.p)).toBe(true);
    }
    expect(decodePack(buf).nTriples).toBe(extra.length);
  });

  test("full official media/scheme/rel tabs round-trip without collapsing to KEEP", () => {
    const extra: PackFact[] = [
      ...mediaTypeNames().map((m) => ({
        s: `IANA media ${m}`,
        p: "is" as const,
        o: m.split("/")[1] || m,
        e: "",
        url: "",
      })),
      ...schemeNames().map((s) => ({ s: `IANA scheme ${s}`, p: "is" as const, o: s, e: "", url: "" })),
      ...relNames().map((r) => ({ s: `IANA rel ${r}`, p: "is" as const, o: r, e: "", url: "" })),
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const p = decodePack(encodePack(extra));
    const got = allFacts(p);
    expect(p.nTriples).toBe(extra.length);
    expect(got.filter((f) => f.s.startsWith("IANA media ")).length).toBe(mediaTypeNames().length);
    expect(got.filter((f) => f.s.startsWith("IANA scheme ")).length).toBe(schemeNames().length);
    expect(got.filter((f) => f.s.startsWith("IANA rel ")).length).toBe(relNames().length);
    expect(p.search("application/json")[0]?.s).toBe("IANA media application/json");
    expect(p.search("bitcoin")[0]?.s).toBe("IANA scheme bitcoin");
    expect(p.search("stylesheet")[0]?.s).toBe("IANA rel stylesheet");
  }, 60_000);

  test("extras-only KEEP + leftover media round-trips without dropping closed rows", () => {
    const extra: PackFact[] = [
      { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "" },
      { s: "IANA media application/1d-interleaved-parityfec", p: "is", o: "1d-interleaved-parityfec", e: "", url: "" },
      { s: "IANA media application/vnd.api+json", p: "is", o: "vnd.api+json", e: "", url: "" },
      { s: "IANA media text/html", p: "is", o: "HTML", e: "", url: "" },
      { s: "IANA media audio/ogg", p: "is", o: "ogg", e: "", url: "" },
      { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "" },
      { s: "SPDX SISSL", p: "is", o: "SISSL", e: "", url: "" },
      { s: "IANA scheme https", p: "is", o: "https", e: "", url: "" },
      { s: "IANA scheme acap", p: "is", o: "acap", e: "", url: "" },
      { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "" },
      { s: "W3C css-namespaces-3", p: "is", o: "css-namespaces-3", e: "", url: "" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const buf = encodePack(extra);
    const p = decodePack(buf);
    const got = allFacts(p);
    for (const f of extra) {
      expect(got.some((g) => g.s === f.s && g.p === f.p)).toBe(true);
    }
    expect(p.nTriples).toBe(extra.length);
  });

  test("vendor-stem leftover media round-trips", () => {
    const extra: PackFact[] = [
      { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "" },
      { s: "IANA media application/vnd.3gpp.mcvideo-info+xml", p: "is", o: "3gpp.mcvideo-info+xml", e: "", url: "" },
      { s: "IANA media application/vnd.openxmlformats-officedocument.wordprocessingml.document", p: "is", o: "document", e: "", url: "" },
      { s: "IANA media application/vnd.ms-excel", p: "is", o: "ms-excel", e: "", url: "" },
      { s: "IANA media application/vnd.oma.poc+xml", p: "is", o: "oma.poc+xml", e: "", url: "" },
      { s: "IANA media application/vnd.oasis.opendocument.text", p: "is", o: "opendocument.text", e: "", url: "" },
      { s: "IANA media application/vnd.collabio.xodocuments.document", p: "is", o: "document", e: "", url: "" },
      { s: "IANA media text/html", p: "is", o: "html", e: "", url: "" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const got = allFacts(decodePack(encodePack(extra)));
    for (const f of extra) expect(got.some((g) => g.s === f.s && g.p === f.p)).toBe(true);
    expect(got.some((g) => g.s === "IANA media application/vnd.3gpp.mcvideo-info+xml")).toBe(true);
    expect(got.some((g) => g.s === "IANA media application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(got.some((g) => g.s === "IANA media application/vnd.oasis.opendocument.text")).toBe(true);
    expect(got.some((g) => g.s === "IANA media application/vnd.collabio.xodocuments.document")).toBe(true);
  });

  test("compound vendor-stem leftover media round-trips", () => {
    const extra: PackFact[] = [
      { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "" },
      { s: "IANA media application/mbms-user-service-description", p: "is", o: "mbms-user-service-description", e: "", url: "" },
      { s: "IANA media application/mbms-associated-procedure-description", p: "is", o: "mbms-associated-procedure-description", e: "", url: "" },
      { s: "IANA media application/mbms-protection-description", p: "is", o: "mbms-protection-description", e: "", url: "" },
      { s: "IANA media application/vnd.3gpp.mcptt-info+xml", p: "is", o: "info", e: "", url: "" },
      { s: "IANA media application/vnd.3gpp.mcptt-affiliation-command+xml", p: "is", o: "affiliation-command", e: "", url: "" },
      { s: "IANA media application/vnd.collabio.xodocuments.document", p: "is", o: "document", e: "", url: "" },
      { s: "IANA media text/html", p: "is", o: "html", e: "", url: "" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const got = allFacts(decodePack(encodePack(extra)));
    for (const f of extra) expect(got.some((g) => g.s === f.s && g.p === f.p)).toBe(true);
    expect(got.length).toBe(extra.length);
  });

  test("closed DNS plus leftover record names round-trip", () => {
    const c = closedCatalog();
    const extra: PackFact[] = [
      ...c.dns.map((n) => ({ s: `IANA dns ${n}`, p: "is", o: DNS_OBJECT[n] ?? n, e: "", url: "" })),
      { s: "IANA dns A", p: "is", o: "a host address", e: "", url: "" },
      { s: "IANA dns C", p: "is", o: "contact", e: "", url: "" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const got = allFacts(decodePack(encodePack(extra)));
    expect(got.some((g) => g.s === "IANA dns A" && g.o === "a host address")).toBe(true);
    expect(got.some((g) => g.s === "IANA dns C" && g.o === "contact")).toBe(true);
    expect(got.some((g) => g.s === `IANA dns ${c.dns[0]}`)).toBe(true);
    expect(decodePack(encodePack(extra)).nTriples).toBe(extra.length);
  });

  test("WHATWG subset and well-known subset keep present rows only", () => {
    const c = closedCatalog();
    const extra: PackFact[] = [
      { s: "WHATWG fetch", p: "is", o: "Fetch Standard", e: "", url: "" },
      { s: "WHATWG html", p: "is", o: "HTML Standard", e: "", url: "" },
      { s: "WHATWG url", p: "is", o: "URL Standard", e: "", url: "" },
      { s: "IANA well-known webfinger", p: "is", o: "WebFinger", e: "", url: "" },
      { s: "IANA well-known security.txt", p: "is", o: "security.txt", e: "", url: "" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const p = decodePack(encodePack(extra));
    const got = allFacts(p);
    expect(got.some((f) => f.s === "WHATWG fetch")).toBe(true);
    expect(got.some((f) => f.s === "WHATWG html")).toBe(true);
    expect(got.some((f) => f.s === "WHATWG url")).toBe(true);
    expect(got.some((f) => f.s === `WHATWG ${c.whatwg.find((s) => s === "webusb")}`)).toBe(false);
    expect(got.some((f) => f.s === "IANA well-known webfinger")).toBe(true);
    expect(got.some((f) => f.s === "IANA well-known security.txt")).toBe(true);
    expect(p.nTriples).toBe(extra.length);
  });

  test("language extras-only KEEP plus leftover langs round-trip", () => {
    const c = closedCatalog();
    const extra: PackFact[] = [
      ...c.langs.map((n) => ({ s: `IANA language ${n}`, p: "is" as const, o: n, e: "", url: "" })),
      { s: "IANA language af", p: "is", o: "af", e: "", url: "" },
      { s: "IANA language da", p: "is", o: "da", e: "", url: "" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
    ];
    const p = decodePack(encodePack(extra));
    const got = allFacts(p);
    expect(got.some((f) => f.s === "IANA language en")).toBe(true);
    expect(got.some((f) => f.s === "IANA language af")).toBe(true);
    expect(got.some((f) => f.s === "IANA language da")).toBe(true);
    expect(p.nTriples).toBe(extra.length);
  });

  test("magic, full titles, edges, omitted subtype object", () => {
    const buf = encodePack(facts);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK9");
    const p = decodePack(buf);
    expect(p.search("RFC 3986")[0]?.o).toBe("Uniform Resource Identifier (URI): Generic Syntax");
    expect(p.search("RFC 3986")[0]?.o).not.toBe("current");
    expect(p.search("URI Generic Syntax")[0]?.s).toBe("RFC 3986");
    expect(p.search("RFC 9110")[0]?.o).toBe("RFC 7230, RFC 7231");
    expect(p.search("RFC 8259")[0]?.o).toBe("RFC 7159");
    expect(p.search("RFC 234")[0]?.o).toBe("RFC 204, RFC 222");
    expect(p.search("application/json")[0]?.s).toBe("IANA media application/json");
    expect(p.search("application/json")[0]?.o).toBe("JSON");
    expect(p.search("json")[0]?.s).toBe("IANA media application/json");
    expect(p.search("GET")[0]?.s).toBe("IANA method GET");
    expect(p.search("404")[0]?.s).toBe("IANA http 404");
    expect(p.search("TCP")[0]?.s).toBe("IANA protocol 6");
    expect(p.search("MIT")[0]?.s).toBe("SPDX MIT");
    expect(p.search("Accept")[0]?.o).toBe("RFC 9110");
    expect(p.search("Accept-CH")[0]?.o).toBe("HTTP field Accept-CH");
    expect(p.search("Kenya")[0]?.o).toBe("Nairobi");
    expect(allFacts(p).some((f) => f.s === "RFC 3986" && f.o === "Uniform Resource Identifier (URI): Generic Syntax")).toBe(true);
    expect(p.nTriples).toBe(allFacts(p).length);
    expect(p.search("France").length).toBe(0);
  });

  test("junk HTML RFC subject becomes typed RFC with page title", () => {
    const p = decodePack(
      encodePack([
        {
          s: "RFC 6555: Happy Eyeballs: Success with Dual-Stack Hosts | RFC Editor",
          p: "is",
          o: "When a server",
          e: "",
          url: "",
        },
      ]),
    );
    expect(p.search("RFC 6555")[0]?.s).toBe("RFC 6555");
    expect(p.search("RFC 6555")[0]?.o).toContain("Happy Eyeballs");
    expect(p.search("RFC 6555")[0]?.o).not.toMatch(/When a server/i);
    expect(p.search("RFC 6555")[0]?.o).not.toMatch(/RFC Editor/i);
  });

  test("short real RFC titles are kept; tautology RFC N objects are not", () => {
    const p = decodePack(
      encodePack([
        { s: "RFC 872", p: "is", o: "TCP LAN", e: "", url: "" },
        { s: "RFC 1598", p: "is", o: "RFC 1598", e: "", url: "" },
        { s: "RFC 1598", p: "is", o: "PPP in a Real-Time Environment", e: "", url: "" },
      ]),
    );
    expect(p.search("RFC 872")[0]?.o).toBe("TCP LAN");
    expect(p.search("RFC 1598")[0]?.o).toBe("PPP in a Real-Time Environment");
  });

  test("HTML RFC subject title wins over a shorter object", () => {
    const p = decodePack(
      encodePack([
        {
          s: "RFC 6891: Extension Mechanisms for DNS (EDNS(0)) | RFC Editor",
          p: "is",
          o: "Domain Name System",
          e: "",
          url: "",
        },
      ]),
    );
    expect(p.search("RFC 6891")[0]?.s).toBe("RFC 6891");
    expect(p.search("RFC 6891")[0]?.o).toBe("Extension Mechanisms for DNS (EDNS(0))");
  });

  test("lex-sorted title roundtrip keeps full URI title", () => {
    const titles = [
      "Hypertext Transfer Protocol -- HTTP/1.0",
      "Hypertext Transfer Protocol -- HTTP/1.1",
      "Uniform Resource Identifier (URI): Generic Syntax",
    ];
    const facts = titles.map((o, i) => ({ s: `RFC ${1000 + i}`, p: "is" as const, o, e: "", url: "" }));
    const p = decodePack(encodePack(facts));
    expect(p.search("RFC 1002")[0]?.o).toBe(titles[2]);
    expect(p.search("RFC 1000")[0]?.o).toBe(titles[0]);
  });

  test("roundtrip does not gist RFC titles", () => {
    const title = "The application/json Media Type for JavaScript Object Notation (JSON)";
    const p = decodePack(encodePack([{ s: "RFC 4627", p: "is", o: title, e: "", url: "" }]));
    expect(p.search("RFC 4627")[0]?.o).toBe(title);
  });

  test("omitted HTTP/protocol/capital objects roundtrip", () => {
    const p = decodePack(
      encodePack([
        { s: "IANA http 404", p: "is", o: "Not Found", e: "", url: "" },
        { s: "IANA protocol 6", p: "is", o: "TCP", e: "", url: "" },
        { s: "Kenya", p: "capital", o: "Nairobi", e: "", url: "" },
        { s: "IANA scheme https", p: "is", o: "Hypertext Transfer Protocol Secure", e: "", url: "" },
      ]),
    );
    expect(p.search("404")[0]?.o).toBe("Not Found");
    expect(p.search("TCP")[0]?.s).toBe("IANA protocol 6");
    expect(p.search("Kenya")[0]?.o).toBe("Nairobi");
    expect(p.search("https")[0]?.o).toContain("Hypertext");
  });

  test("omitted decoder-table RFC title is stored in the pack, not a sidecar", () => {
    const title = "Uniform Resource Identifier (URI): Generic Syntax";
    const buf = encodePack([{ s: "RFC 3986", p: "is", o: title, e: "", url: "" }]);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK9");
    expect(buf[4]! & 1).toBe(0);
    expect(buf[4]! & 16).toBe(0);
    expect(buf[4]! & 32).toBe(0);
    const p = decodePack(buf);
    expect(p.search("RFC 3986")[0]?.o).toBe(title);
    expect(p.strs.includes(title)).toBe(false);
    expect(buf.byteLength).toBeGreaterThan(20);
    expect(buf.byteLength).toBeLessThan(8000);
  });

  test("EG09 sorted dests still query as obsoletes/updates facts", () => {
    const p = decodePack(
      encodePack([
        { s: "RFC 9110", p: "obsoletes", o: "RFC 7231, RFC 7230", e: "", url: "" },
        { s: "RFC 8259", p: "updates", o: "RFC 7159", e: "", url: "" },
      ]),
    );
    const dests = (p.search("RFC 9110")[0]?.o ?? "").split(/,\s*/).sort();
    expect(dests).toEqual(["RFC 7230", "RFC 7231"]);
    expect(p.search("RFC 8259")[0]?.o).toBe("RFC 7159");
  });

  test("IANA header intern prefix roundtrips", () => {
    const p = decodePack(
      encodePack([
        { s: "IANA header Accept", p: "is", o: "RFC 9110", e: "", url: "" },
        { s: "IANA header Accept-CH", p: "is", o: "HTTP field Accept-CH", e: "", url: "" },
        { s: "IANA dns AAAA", p: "is", o: "IPv6 Address", e: "", url: "" },
        { s: "IANA charset utf-8", p: "is", o: "UTF-8", e: "", url: "" },
        { s: "IANA method GET", p: "is", o: "safe, idempotent, RFC 9110", e: "", url: "" },
        { s: "IANA method POST", p: "is", o: "unsafe, RFC 9110", e: "", url: "" },
      ]),
    );
    expect(p.search("Accept")[0]?.s).toBe("IANA header Accept");
    expect(p.search("Accept")[0]?.o).toBe("RFC 9110");
    expect(p.search("Accept-CH")[0]?.o).toBe("HTTP field Accept-CH");
    expect(p.search("GET")[0]?.o).toBe("safe, idempotent, RFC 9110");
    expect(p.search("POST")[0]?.o).toBe("unsafe, RFC 9110");
  });

  test("KPK1 still decodes", () => {
    const p = decodePack(encodePackV1(facts));
    expect(p.search("RFC 3986")[0]?.o).toContain("URI");
  });

  test("baseline KPK7 still decodes", () => {
    const raw = readFileSync(new URL("../../../.gauntlet/baseline/know-pack.kpk", import.meta.url));
    expect(new TextDecoder().decode(raw.subarray(0, 4))).toBe("KPK7");
    const p = decodePack(raw);
    expect(p.search("RFC 3986")[0]?.o).toContain("URI");
    expect(p.search("application/json")[0]?.s).toBe("IANA media application/json");
  });

  test("one capital in the file is not the whole country table", () => {
    const p = decodePack(encodePack([{ s: "France", p: "capital", o: "Paris", e: "", url: "" }]));
    expect(p.search("France")[0]?.o).toBe("Paris");
    expect(p.search("Kenya").length).toBe(0);
  });

  test("EG11 singleton and multi dests roundtrip on a large RFC column", () => {
    const facts: PackFact[] = [];
    for (let n = 1000; n < 2200; n++) {
      facts.push({ s: `RFC ${n}`, p: "is", o: n % 3 === 0 ? "HTTP" : "Internet", e: "", url: "" });
    }
    facts.push({ s: "RFC 2000", p: "obsoletes", o: "RFC 1500", e: "", url: "" });
    facts.push({ s: "RFC 1999", p: "obsoletes", o: "RFC 1400", e: "", url: "" });
    facts.push({ s: "RFC 1980", p: "updates", o: "RFC 1900, RFC 1910", e: "", url: "" });
    facts.push({ s: "Kenya", p: "capital", o: "Nairobi", e: "", url: "" });
    const buf = encodePack(facts);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK9");
    const p = decodePack(buf);
    const obs = p.search("RFC 2000").find((f) => f.p === "obsoletes");
    expect(obs?.o).toBe("RFC 1500");
    const upd = p.search("RFC 1980").find((f) => f.p === "updates");
    const dests = (upd?.o ?? "").split(/,\s*/).sort();
    expect(dests).toEqual(["RFC 1900", "RFC 1910"]);
    expect(p.search("RFC 1000")[0]?.o).toMatch(/HTTP|Internet/);
    expect(p.search("Kenya")[0]?.o).toBe("Nairobi");
    expect(p.search("France").length).toBe(0);
    const dests2 = (decodePack(encodePack(facts)).search("RFC 1980").find((f) => f.p === "updates")?.o ?? "")
      .split(/,\s*/)
      .sort();
    expect(dests2).toEqual(["RFC 1900", "RFC 1910"]);
  }, 15_000);

  test(
    "live graph.kpk re-encodes as one self-contained dump",
    () => {
    const paths = [
      new URL("../../../.gauntlet/refs/graph.kpk", import.meta.url),
      "/Users/kaiavnihalani/.eden/know/graph.kpk",
      new URL("../../../.gauntlet/captures/know-moon/graph.kpk", import.meta.url),
    ];
    let live: Uint8Array | undefined;
    for (const p of paths) {
      try {
        const buf = new Uint8Array(readFileSync(typeof p === "string" ? p : p));
        if (new TextDecoder().decode(buf.subarray(0, 4)) !== "KPK9") continue;
        live = buf;
        break;
      } catch {
        /* */
      }
    }
    if (!live) return;
    const facts = allFacts(decodePack(live));
    const buf = encodePack(facts);
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("KPK9");
    expect(buf[4]! & 1).toBe(0);
    expect(buf[4]! & 32).toBe(0);
    expect(buf.byteLength).toBeGreaterThan(64);
    expect(buf.byteLength).toBeLessThan(200_000);
    const p = decodePack(buf);
    expect(p.nTriples).toBe(allFacts(p).length);
    expect(p.nTriples).toBeGreaterThan(200);
    expect(p.nTriples).toBe(facts.length);
    if (facts.length === 8299) expect(buf.byteLength).toBeLessThanOrEqual(10_857);
    expect(p.search("RFC 3986")[0]?.o).toBe("Uniform Resource Identifier (URI): Generic Syntax");
    expect(p.search("RFC 35")[0]?.o).toBe("Network Meeting");
    expect(p.search("RFC 9110").some((f) => f.p === "is" && f.o === "HTTP Semantics")).toBe(true);
    expect(p.search("RFC 9110").some((f) => f.p === "obsoletes")).toBe(true);
    expect(p.search("RFC 792").length).toBeGreaterThan(0);
    const rfc792 = facts.find((f) => f.s === "RFC 792" && f.p === "is")?.o;
    expect(p.search("RFC 792")[0]?.o).toBe(rfc792);
    expect(p.search("Kenya")[0]?.o).toBe("Nairobi");
    expect(p.search("application/json")[0]?.s).toBe("IANA media application/json");
    expect(p.search("application/json")[0]?.o).toBe("JSON");
    expect(encodePack(allFacts(p)).byteLength).toBe(buf.byteLength);
    },
    120_000,
  );

  test("gold/holdout dump titles live in graph.kpk bytes, not rfc-hot", () => {
    const paths = [
      new URL("../../../.gauntlet/refs/graph.kpk", import.meta.url),
      "/Users/kaiavnihalani/.eden/know/graph.kpk",
    ];
    let live: Uint8Array | undefined;
    for (const p of paths) {
      try {
        const buf = new Uint8Array(readFileSync(typeof p === "string" ? p : p));
        if (new TextDecoder().decode(buf.subarray(0, 4)) !== "KPK9") continue;
        live = buf;
        break;
      } catch {
        /* */
      }
    }
    if (!live) return;
    const want: Record<number, string> = {
      35: "Network Meeting",
      3986: "Uniform Resource Identifier (URI): Generic Syntax",
      8259: "The JavaScript Object Notation (JSON) Data Interchange Format",
      9110: "HTTP Semantics",
    };
    const fromFile = overlayFromPackPayload(live);
    for (const [n, title] of Object.entries(want)) {
      expect(fromFile.get(+n)).toBe(title);
    }
    const prev: Record<number, string | undefined> = {};
    for (const n of [35, 3986, 8259, 9110]) {
      prev[n] = RFC_TITLE_HOT[n];
      RFC_TITLE_HOT[n] = `broken-hot-${n}`;
    }
    try {
      const p = decodePack(live);
      expect(p.search("RFC 35")[0]?.o).toBe(want[35]);
      expect(p.search("RFC 3986")[0]?.o).toBe(want[3986]);
      expect(p.search("RFC 8259")[0]?.o).toBe(want[8259]);
      expect(p.search("RFC 9110").some((f) => f.p === "is" && f.o === want[9110])).toBe(true);
      expect(p.search("RFC 3986")[0]?.o).not.toContain("broken-hot");
      expect(p.search("RFC 9309")[0]?.o).toMatch(/Robots/);
    } finally {
      for (const n of [35, 3986, 8259, 9110]) {
        const t = prev[n];
        if (t === undefined) delete RFC_TITLE_HOT[n];
        else RFC_TITLE_HOT[n] = t;
      }
    }
  });

  test(
    "launch dump re-encodes smaller with gold titles in the file",
    () => {
      const launchPath = new URL("../../../.gauntlet/baseline/know-launch/graph.kpk", import.meta.url);
      let launch: Uint8Array;
      try {
        launch = new Uint8Array(readFileSync(launchPath));
      } catch {
        return;
      }
      expect(new TextDecoder().decode(launch.subarray(0, 4))).toBe("KPK9");
      const facts = allFacts(decodePack(launch));
      const buf = encodePack(facts);
      expect(buf.byteLength).toBeLessThan(launch.byteLength);
      expect(decodePack(buf).nTriples).toBe(facts.length);
      const prev = RFC_TITLE_HOT[3986];
      RFC_TITLE_HOT[3986] = "broken-hot-3986";
      try {
        expect(decodePack(buf).search("RFC 3986")[0]?.o).toContain("URI");
        expect(decodePack(buf).search("RFC 9110")[0]?.o).toContain("HTTP Semantics");
        expect(decodePack(buf).search("RFC 35")[0]?.o).toBe("Network Meeting");
      } finally {
        if (prev === undefined) delete RFC_TITLE_HOT[3986];
        else RFC_TITLE_HOT[3986] = prev;
      }
    },
    120_000,
  );

  test("wiki infobox templates round-trip leftover is-rows", () => {
    const extra: PackFact[] = [
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "" },
      { s: "Harambee", p: "is", o: "the motto of Kenya", e: "", url: "" },
      { s: "Ee Mungu Nguvu Yetu", p: "is", o: "the anthem of Kenya", e: "", url: "" },
      { s: "KE", p: "is", o: "the ISO 3166-1 alpha-2 of Kenya", e: "", url: "" },
      { s: "English", p: "is", o: "an official language of Kenya", e: "", url: "" },
      { s: "Swahili", p: "is", o: "an official language of Kenya", e: "", url: "" },
      { s: "William Ruto", p: "is", o: "the president of Kenya", e: "", url: "" },
      { s: "Nairobi", p: "is", o: "the largest city of Kenya", e: "", url: "" },
      { s: "Kenyan shilling", p: "is", o: "the currency of Kenya", e: "", url: "" },
      { s: "Kenyan", p: "is", o: "a demonym of Kenya", e: "", url: "" },
      { s: "Liberté", p: "is", o: "the motto of France", e: "", url: "" },
      { s: "La Marseillaise", p: "is", o: "the anthem of France", e: "", url: "" },
      { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "" },
    ];
    const buf = encodePack(extra);
    const p = decodePack(buf);
    const got = allFacts(p);
    expect(p.nTriples).toBe(extra.length);
    expect(got.some((f) => f.s === "Harambee" && f.o === "the motto of Kenya")).toBe(true);
    expect(got.some((f) => f.s === "English" && f.o === "an official language of Kenya")).toBe(true);
    expect(got.some((f) => f.s === "Liberté" && f.o === "the motto of France")).toBe(true);
    expect(got.some((f) => f.s === "KE" && /ISO 3166-1 alpha-2 of Kenya/.test(f.o))).toBe(true);
    expect(p.search("Harambee")[0]?.o).toContain("motto");
  });
});
