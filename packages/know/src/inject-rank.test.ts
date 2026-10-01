import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePack } from "./pack";
import { openStore } from "./store";
import { citeableUrl, formatCard, knowQuery, MAX_TOKENS } from "./query";
import { injectFromText } from "./inject";
import { needleRank, needlesFromText, rankNeedles, techniqueNeedleFromText, techniqueQueryFallbacks } from "./needles";

const FACTS = [
  { s: "RFC 35", p: "is", o: "Network Meeting", e: "", url: "https://www.rfc-editor.org/rfc/rfc35.html" },
  {
    s: "RFC 3986",
    p: "is",
    o: "Uniform Resource Identifier (URI): Generic Syntax",
    e: "",
    url: "https://www.rfc-editor.org/rfc/rfc3986.html",
  },
  { s: "RFC 9110", p: "is", o: "HTTP Semantics", e: "", url: "https://www.rfc-editor.org/rfc/rfc9110.html" },
  {
    s: "RFC 4627",
    p: "is",
    o: "The application/json Media Type for JavaScript Object Notation (JSON)",
    e: "RFC 4627: The application&#x2F;json Media Type for JavaScript Object Notation (JSON)",
    url: "https://www.rfc-editor.org/rfc/rfc4627.html",
  },
  {
    s: "IANA media application/json",
    p: "is",
    o: "JSON",
    e: "",
    url: "https://www.iana.org/assignments/media-types/media-types.xml",
  },
  {
    s: "IANA method GET",
    p: "is",
    o: "safe, idempotent, RFC 9110",
    e: "",
    url: "https://www.iana.org/assignments/http-methods/http-methods.xml",
  },
  {
    s: "IANA http 404",
    p: "is",
    o: "Not Found",
    e: "",
    url: "https://www.iana.org/assignments/http-status-codes/http-status-codes.xml",
  },
  {
    s: "IANA protocol 6",
    p: "is",
    o: "TCP",
    e: "",
    url: "https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xml",
  },
  {
    s: "IANA header Accept",
    p: "is",
    o: "Media types",
    e: "",
    url: "https://www.iana.org/assignments/http-fields/http-fields.xml",
  },
  {
    s: "IANA header Content-Type",
    p: "is",
    o: "Media type of the payload",
    e: "",
    url: "https://www.iana.org/assignments/http-fields/http-fields.xml",
  },
  {
    s: "IANA charset utf-8",
    p: "is",
    o: "UTF-8",
    e: "",
    url: "https://www.iana.org/assignments/character-sets/character-sets.xml",
  },
  {
    s: "IANA scheme https",
    p: "is",
    o: "Hypertext Transfer Protocol Secure",
    e: "",
    url: "https://www.iana.org/assignments/uri-schemes/uri-schemes.xml",
  },
  {
    s: "IANA dns AAAA",
    p: "is",
    o: "IP6 Address",
    e: "",
    url: "https://www.iana.org/assignments/dns-parameters/dns-parameters.xml",
  },
  {
    s: "United Kingdom",
    p: "capital",
    o: "London",
    e: "capital of United Kingdom is London",
    url: "https://en.wikipedia.org/wiki/United_Kingdom",
  },
  {
    s: "Kenya",
    p: "capital",
    o: "Nairobi",
    e: "capital of Kenya is Nairobi",
    url: "https://en.wikipedia.org/wiki/Kenya",
  },
  {
    s: "IANA well-known change-password",
    p: "is",
    o: "Change Password",
    e: "",
    url: "https://www.iana.org/assignments/well-known-uris/well-known-uris.xml",
  },
  { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "https://spdx.org/licenses/licenses.json" },
  { s: "SPDX Apache-2.0", p: "is", o: "Apache License 2.0", e: "", url: "https://spdx.org/licenses/licenses.json" },
  {
    s: "SPDX CC-BY-4.0",
    p: "is",
    o: "Creative Commons Attribution 4.0 International",
    e: "",
    url: "https://spdx.org/licenses/licenses.json",
  },
  { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "https://www.w3.org/TR/web-share/" },
  { s: "WHATWG html", p: "is", o: "HTML", e: "", url: "https://html.spec.whatwg.org/multipage/" },
  {
    s: "jq",
    p: "is",
    o: "used for filtering JSON on the command line",
    e: "jq is used for filtering JSON on the command line",
    url: "https://jqlang.github.io/jq/",
  },
  {
    s: "Bun",
    p: "is",
    o: "used for running TypeScript services",
    e: "Use Bun to run TypeScript services",
    url: "https://bun.sh/",
  },
  {
    s: "RFC 8259",
    p: "obsoletes",
    o: "RFC 4627",
    e: "",
    url: "https://www.rfc-editor.org/rfc/rfc8259.html",
  },
];

function packed() {
  const dir = mkdtempSync(join(tmpdir(), "eden-know-inject-rank-"));
  writeFileSync(join(dir, "graph.kpk"), encodePack(FACTS));
  return { dir, store: openStore(dir) };
}

function fact(card: { fact: string } | { unknown: true } | { fact: string } | undefined): string {
  if (card && "fact" in card) return card.fact;
  return "";
}

describe("needle rank", () => {
  test("RFC beats media beats status beats header beats SPDX beats W3C beats protocol beats method", () => {
    const order = rankNeedles(["GET", "TCP", "W3C web-share", "MIT", "Accept", "404", "application/json", "RFC 3986"]);
    expect(order[0]).toBe("RFC 3986");
    expect(order[1]).toBe("application/json");
    expect(order[2]).toBe("404");
    expect(order[3]).toBe("Accept");
    expect(order[4]).toBe("MIT");
    expect(order[5]).toBe("W3C web-share");
    expect(order[6]).toBe("TCP");
    expect(order[7]).toBe("GET");
    expect(needleRank("RFC 3986")).toBeLessThan(needleRank("application/json"));
    expect(needleRank("application/json")).toBeLessThan(needleRank("404"));
    expect(needleRank("404")).toBeLessThan(needleRank("Accept"));
    expect(needleRank("UTF-8")).toBe(needleRank("Accept"));
    expect(needleRank("Accept")).toBeLessThan(needleRank("MIT"));
    expect(needleRank("MIT")).toBeLessThan(needleRank("W3C web-share"));
    expect(needleRank("WHATWG html")).toBe(needleRank("W3C web-share"));
    expect(needleRank("W3C web-share")).toBeLessThan(needleRank("TCP"));
    expect(needleRank("https")).toBe(needleRank("TCP"));
    expect(needleRank("TCP")).toBeLessThan(needleRank("GET"));
  });

  test("needlesFromText ranks GET behind RFC and media", () => {
    expect(needlesFromText("GET and RFC 3986")).toEqual(["RFC 3986", "GET"]);
    expect(needlesFromText("See RFC 35.")).toEqual(["RFC 35"]);
    expect(needlesFromText("GET and application/json")).toEqual(["application/json", "GET"]);
    expect(needlesFromText("GET and HTTP 404")).toEqual(["404", "GET"]);
  });

  test("Kenya's capital is a capital-of needle", () => {
    expect(needlesFromText("What is Kenya's capital?")).toContain("capital of Kenya");
    expect(needlesFromText("If Kenya's capital comes up")).toContain("capital of Kenya");
    expect(needlesFromText("If Kenya's capital comes up")).not.toContain("capital of If Kenya");
  });

  test("United Kingdom possessive is a capital-of needle", () => {
    expect(needlesFromText("United Kingdom's capital")).toContain("capital of United Kingdom");
    expect(needlesFromText("What is the United Kingdom's capital?")).toContain("capital of United Kingdom");
  });

  test("names the packed row: charset param, SPDX header, URI scheme, DNS, well-known, possessive", () => {
    expect(needlesFromText("charset=utf-8")).toContain("UTF-8");
    expect(needlesFromText("charset=utf8")).toContain("UTF-8");
    expect(needlesFromText('charset="UTF-8"')).toContain("UTF-8");
    expect(needlesFromText("SPDX-License-Identifier: MIT")).toContain("MIT");
    expect(needlesFromText("SPDX-License-Identifier: MIT")).not.toContain("SPDX");
    expect(needlesFromText("SPDX-License-Identifier: Apache-2.0")).toContain("Apache-2.0");
    expect(needlesFromText("licensed under Apache-2.0")).toContain("Apache-2.0");
    expect(needlesFromText("https://example.com/path")).toEqual(["https"]);
    expect(needlesFromText("fetch https://example.com")).toContain("https");
    expect(needlesFromText("DNS AAAA record")).toContain("AAAA");
    expect(needlesFromText("DNS A record")).toContain("IANA dns A");
    expect(needlesFromText("DNS A record")).not.toContain("IANA dns AAAA");
    expect(needlesFromText("the DNS HTTPS record")).toContain("IANA dns HTTPS");
    expect(needlesFromText("the DNS HTTPS record")[0]).toBe("IANA dns HTTPS");
    expect(needlesFromText("AAAA record")).toContain("AAAA");
    expect(needlesFromText("/.well-known/change-password")).toContain("IANA well-known change-password");
    expect(needlesFromText("United Kingdom's capital")).toContain("capital of United Kingdom");
    expect(needlesFromText("Please refactor the auth middleware and add a log line.")).toEqual([]);
    expect(needlesFromText("Content-Type: text/plain; charset=utf-8")[0]).toBe("Content-Type");
    expect(needlesFromText("Content-Type: text/plain; charset=utf-8")).toContain("UTF-8");
    expect(needlesFromText("Content-Type: text/plain; charset=utf-8")).not.toContain("text/plain");
  });

  test("catalog English titles inject the packed identifier; quiet stays empty", () => {
    expect(needlesFromText("Follow the Uniform Resource Identifier generic syntax when parsing URLs")).toEqual([
      "RFC 3986",
    ]);
    expect(needlesFromText("Follow HTTP Semantics when writing the handler.")).toEqual(["RFC 9110"]);
    expect(needlesFromText("Robots Exclusion Protocol for the crawler")).toEqual(["RFC 9309"]);
    expect(needlesFromText("Use the Web Share API from the document.")).toEqual(["W3C web-share"]);
    expect(needlesFromText("licensed under the MIT License")).toContain("MIT");
    expect(needlesFromText("Return not found when the row is missing")).toEqual(["404"]);
    expect(needlesFromText("Please refactor the auth middleware and add a log line.")).toEqual([]);
    expect(needlesFromText("GET and RFC 3986")).toEqual(["RFC 3986", "GET"]);
    expect(needlesFromText("GET and application/json")).toEqual(["application/json", "GET"]);
    expect(needlesFromText("the json media type from IANA")).toContain("json");
    expect(needlesFromText("the json media type from IANA")).not.toContain("RFC 4627");
    expect(needlesFromText("the https URI scheme")).toContain("https");
    expect(needlesFromText("the https URI scheme")).not.toContain("RFC 3986");
    expect(needlesFromText("Follow HTTP Semantics and RFC 3986.")[0]).toBe("RFC 3986");
    expect(needlesFromText("Use the Cookie Store API in the worker")).toEqual(["WHATWG cookiestore"]);
    expect(needlesFromText("Hypertext Transfer Protocol Secure")).toEqual(["https"]);
    expect(needlesFromText("Set Cookie on the response")).toContain("Cookie");
    expect(needlesFromText("Temporary Redirect to the new host")).toEqual(["307"]);
    expect(needlesFromText("URL Pattern in the worker")).toEqual(["WHATWG urlpattern"]);
    expect(needlesFromText("Use the Web IDL bindings")).toEqual(["WHATWG webidl"]);
    expect(needlesFromText("Push API from the browser")).toEqual(["W3C push-api"]);
    expect(needlesFromText("WebSocket connections to the host")).toEqual(["ws"]);
    expect(needlesFromText("JSON Web Key Set at the issuer")).toEqual(["IANA well-known jwks.json"]);
    expect(needlesFromText("Do Not Track header")).toEqual(["IANA well-known dnt"]);
    expect(needlesFromText("web share from the document")).toEqual(["W3C web-share"]);
    expect(needlesFromText("Cookie Store in the worker")).toEqual(["WHATWG cookiestore"]);
  });

  test("equal-rank needles prefer the card with more tokens not in the prompt", () => {
    expect(needleRank("UTF-8")).toBe(needleRank("Accept"));
    expect(needleRank("RFC 3986")).toBeLessThan(needleRank("application/json"));
    expect(needleRank("application/json")).toBeLessThan(needleRank("GET"));
    expect(fact(injectFromText("Send UTF-8 and set Accept."))).toBe("");
    expect(fact(injectFromText("GET and application/json"))).toBe("");
    expect(fact(injectFromText("GET and RFC 3986"))).toBe("");
  });
});

describe("cards", () => {
  test("United Kingdom card keeps leading The; possessive still hits", () => {
    const uk = formatCard("capital of United Kingdom", [
      { s: "United Kingdom", p: "capital", o: "London", e: "capital of United Kingdom is London" },
    ]);
    expect(fact(uk)).toBe("The capital of the United Kingdom is London.");
    const theUk = formatCard("capital of United Kingdom", [
      { s: "the United Kingdom", p: "capital", o: "London", e: "capital of the United Kingdom is London" },
    ]);
    expect(fact(theUk)).toBe("The capital of the United Kingdom is London.");
    expect(fact(formatCard("capital of Kenya", [{ s: "Kenya", p: "capital", o: "Nairobi", e: "" }]))).toBe(
      "The capital of Kenya is Nairobi.",
    );
    expect(fact(formatCard("English", [{ s: "English", p: "is", o: "an official language of Kenya", e: "" }]))).toBe(
      "English is an official language of Kenya.",
    );
    expect(fact(formatCard("Kenya", [{ s: "Kenya", p: "is", o: "a unitary presidential republic", e: "" }]))).toBe(
      "Kenya is a unitary presidential republic.",
    );
    expect(
      fact(formatCard("Kenya", [{ s: "Kenya", p: "is", o: "a unitary presidential republic", e: "" }])),
    ).not.toMatch(/^The Kenya is /);
    expect(
      fact(
        formatCard("capital of Netherlands", [
          { s: "Netherlands", p: "capital", o: "Amsterdam", e: "capital of Netherlands is Amsterdam" },
        ]),
      ),
    ).toBe("The capital of the Netherlands is Amsterdam.");
    expect(
      fact(
        formatCard("capital of United States", [
          {
            s: "United States",
            p: "capital",
            o: "Washington, D.C.",
            e: "capital of United States is Washington, D.C.",
          },
        ]),
      ),
    ).toBe("The capital of the United States is Washington, D.C.");
  });

  test("charset / DNS / well-known cards have no IANA-prefix junk", () => {
    const utf = formatCard("utf-8", [{ s: "IANA charset utf-8", p: "is", o: "UTF-8", e: "" }]);
    expect(fact(utf)).toBe("UTF-8 is a charset.");
    expect(fact(utf)).not.toMatch(/IANA charset/i);
    const dns = formatCard("AAAA", [{ s: "IANA dns AAAA", p: "is", o: "IP6 Address", e: "" }]);
    expect(fact(dns)).toBe("AAAA is an IP6 Address record.");
    expect(fact(dns)).not.toMatch(/IANA dns/i);
    const wk = formatCard("IANA well-known change-password", [
      { s: "IANA well-known change-password", p: "is", o: "Change Password", e: "" },
    ]);
    expect(fact(wk)).toBe("change-password is Change Password.");
    expect(fact(wk)).not.toMatch(/IANA well-known/i);
  });

  test("GET / 404 / TCP have no IANA-prefix junk", () => {
    const get = formatCard("GET", [{ s: "IANA method GET", p: "is", o: "safe, idempotent, RFC 9110", e: "" }]);
    expect(fact(get)).toMatch(/^GET is /);
    expect(fact(get)).not.toMatch(/IANA method/i);
    const sc = formatCard("404", [{ s: "IANA http 404", p: "is", o: "Not Found", e: "" }]);
    expect(fact(sc)).toBe("HTTP 404 is Not Found.");
    expect(fact(sc)).not.toMatch(/IANA http/i);
    const tcp = formatCard("TCP", [{ s: "IANA protocol 6", p: "is", o: "TCP", e: "" }]);
    expect(fact(tcp)).toBe("TCP is protocol 6.");
    expect(fact(tcp)).not.toMatch(/IANA protocol/i);
    const lang = formatCard("IANA language en", [{ s: "IANA language en", p: "is", o: "English", e: "" }]);
    expect(fact(lang)).toBe("IANA language en is English.");
  });

  test("cards keep a citeable source URL off the fact sentence", () => {
    const rfc = formatCard("RFC 3986", [
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "" },
    ]);
    expect("url" in rfc && rfc.url).toBe("https://www.rfc-editor.org/rfc/rfc3986.html");
    expect(fact(rfc)).not.toMatch(/https?:\/\//);
    const talk = formatCard("used for JSON", [
      {
        s: "jq",
        p: "is",
        o: "used for filtering JSON on the command line",
        e: "jq is used for filtering JSON on the command line",
        url: "https://jqlang.github.io/jq/",
      },
    ]);
    expect("url" in talk && talk.url).toBe("https://jqlang.github.io/jq/");
    expect(fact(talk)).toBe("jq is used for filtering JSON on the command line.");
    expect(citeableUrl("javascript:alert(1)")).toBeUndefined();
    expect(citeableUrl("/wiki/Kenya")).toBeUndefined();
    expect(citeableUrl("https://jqlang.github.io/jq/")).toBe("https://jqlang.github.io/jq/");
  });

  test("area-only RFC card upgrades to the stored title", () => {
    expect(fact(formatCard("RFC 9000", [{ s: "RFC 9000", p: "is", o: "HTTP", e: "" }]))).toBe(
      "RFC 9000 is an HTTP RFC.",
    );
    expect(
      fact(
        formatCard("RFC 9000", [
          {
            s: "RFC 9000",
            p: "is",
            o: "HTTP",
            e: "QUIC: A UDP-Based Multiplexed and Secure Transport",
          },
        ]),
      ),
    ).toBe("RFC 9000 is QUIC: A UDP-Based Multiplexed and Secure Transport.");
  });

  test("RFC is-obsoleted-by keeps the successor number", () => {
    expect(
      fact(
        formatCard("RFC 1111", [
          {
            s: "RFC 1111",
            p: "is",
            o: "obsoleted by RFC 9998",
            e: "",
            url: "https://www.rfc-editor.org/rfc/rfc9998.html",
          },
        ]),
      ),
    ).toBe("RFC 1111 is obsoleted by RFC 9998.");
  });

  test("RFC keeps (URI); SPDX is not a tautology dump; media is not RFC 4627", () => {
    const rfc = formatCard("RFC 3986", [
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "" },
    ]);
    expect(fact(rfc)).toContain("(URI)");
    expect(fact(rfc).split(/\s+/).length).toBeLessThanOrEqual(MAX_TOKENS);
    const mit = formatCard("MIT", [{ s: "SPDX MIT", p: "is", o: "MIT License", e: "" }]);
    expect(fact(mit)).toMatch(/MIT/);
    expect(fact(mit)).not.toBe("SPDX MIT is MIT License.");
    const cc = formatCard("SPDX CC-BY-4.0", [
      { s: "SPDX CC-BY-4.0", p: "is", o: "Creative Commons Attribution 4.0 International", e: "" },
    ]);
    expect(fact(cc)).toBe("CC-BY-4.0 is Creative Commons Attribution 4.0 International.");
    expect(fact(cc)).not.toMatch(/unknown/);
    const json = formatCard("application/json", [
      {
        s: "RFC 4627",
        p: "is",
        o: "The application/json Media Type for JSON",
        e: "RFC 4627: The application&#x2F;json Media Type for JSON",
      },
      { s: "IANA media application/json", p: "is", o: "JSON", e: "" },
    ]);
    expect(fact(json)).toBe("application/json is a JSON media type.");
    expect(fact(json)).not.toContain("4627");
    expect(fact(json)).not.toContain("&#x");
  });

  test("wrong first hit still surfaces the graph row", () => {
    const card = formatCard("RFC 3986", [
      { s: "RFC 9309", p: "is", o: "Robots Exclusion Protocol", e: "RFC 9309: Robots Exclusion Protocol" },
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "" },
    ]);
    expect(fact(card)).toContain("3986");
    expect(fact(card)).toContain("(URI)");
  });

  test("hard cases stay unknown", () => {
    expect("unknown" in formatCard("", [])).toBe(true);
    expect("unknown" in knowQuery("")).toBe(true);
    const rfc = [{ s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "" }];
    expect("unknown" in formatCard("RFC 3986 xyzzy-not-a-token", rfc)).toBe(true);
    expect("unknown" in formatCard("asdfghjkl qwerty zxcvbnm", rfc)).toBe(true);
  });
});

describe("injectFromText ranking", () => {
  test("most specific needle wins; silent and disabled stay quiet", () => {
    const { dir, store } = packed();
    try {
      expect(injectFromText("Use GET and RFC 3986 when parsing.", store)).toBeUndefined();
      expect(injectFromText("See RFC 35.", store)).toBeUndefined();
      expect(injectFromText("Send GET with application/json.", store)).toBeUndefined();
      expect(injectFromText("GET then return HTTP 404.", store)).toBeUndefined();
      expect(injectFromText("GET and set Accept.", store)).toBeUndefined();
      expect(injectFromText("GET over TCP.", store)).toBeUndefined();
      expect(injectFromText("GET with MIT.", store)).toBeUndefined();
      expect(injectFromText("charset=utf8", store)).toBeUndefined();
      expect(injectFromText("SPDX-License-Identifier: Apache-2.0", store)).toBeUndefined();
      expect(injectFromText("https://example.com/path", store)).toBeUndefined();
      expect(injectFromText("DNS AAAA record", store)).toBeUndefined();
      expect(injectFromText("United Kingdom's capital", store)).toBeUndefined();
      expect(injectFromText("Content-Type: text/plain; charset=utf-8", store)).toBeUndefined();
      expect(injectFromText("RFC 3986 xyzzy-not-a-token", store)).toBeUndefined();
      expect(injectFromText("SPDX-License-Identifier: MIT", store)).toBeUndefined();
      expect(fact(injectFromText("Use GET and RFC 4627 when parsing.", store))).toBe("RFC 8259 obsoletes RFC 4627.");
      expect(fact(injectFromText("Send GET with application/json and see RFC 4627.", store))).toBe(
        "RFC 8259 obsoletes RFC 4627.",
      );
      expect(fact(injectFromText("RFC 4627 and application/json", store))).toBe("RFC 8259 obsoletes RFC 4627.");
      expect(
        injectFromText("/.well-known/change-password", {
          search(q: string) {
            if (/change-password/i.test(q)) {
              return [{ s: "IANA well-known change-password", p: "is", o: "Change Password", e: "", url: "" }];
            }
            return [];
          },
        }),
      ).toBeUndefined();

      expect(injectFromText("no fact shaped tokens here at all", store)).toBeUndefined();
      expect(
        injectFromText("Follow the Uniform Resource Identifier generic syntax when parsing URLs", store),
      ).toBeUndefined();
      expect(injectFromText("Follow HTTP Semantics when writing the handler.", store)).toBeUndefined();
      expect(injectFromText("Please refactor the auth middleware and add a log line.", store)).toBeUndefined();
      expect(techniqueNeedleFromText("what's the best way to filter JSON on the command line")).toBe(
        "used for filter JSON command line",
      );
      expect(needlesFromText("what's the best way to filter JSON on the command line")[0]).toBe(
        "used for filter JSON command line",
      );
      expect(fact(injectFromText("what's the best way to filter JSON on the command line", store))).toBe(
        "jq is used for filtering JSON on the command line.",
      );
      expect(fact(injectFromText("what's the best way to filter JSON on the command line", store))).not.toMatch(
        /media type/i,
      );
      expect(fact(injectFromText("what's the best way to filter JSON on the command line", store))).not.toMatch(
        /^python /i,
      );
      expect(injectFromText("use jq to filter JSON on the command line", store)).toBeUndefined();
      expect(fact(injectFromText("what should I use for running TypeScript", store))).toBe(
        "Bun is used for running TypeScript services.",
      );
      expect(fact(injectFromText("Parse the body with RFC 4627.", store))).toBe("RFC 8259 obsoletes RFC 4627.");
      expect(fact(injectFromText("cat payload.json and pull the nested ids", store))).toMatch(/^jq is used for/);
      expect(techniqueQueryFallbacks("used for JSON command line")).toContain("used for JSON");
      expect(fact(knowQuery("used for JSON command line", store))).toMatch(/^jq is used for/);
      expect(injectFromText("Use the Web Share API from the document.", store)).toBeUndefined();
      const prev = process.env.EDEN_KNOW;
      process.env.EDEN_KNOW = "0";
      try {
        expect(injectFromText("RFC 3986 and application/json", store)).toBeUndefined();
      } finally {
        if (prev === undefined) delete process.env.EDEN_KNOW;
        else process.env.EDEN_KNOW = prev;
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("knowQuery application/json is IANA media; extra tokens unknown", () => {
    const { dir, store } = packed();
    try {
      const card = knowQuery("application/json", store);
      expect(fact(card)).toBe("application/json is a JSON media type.");
      expect(fact(card)).not.toContain("RFC 4627");
      expect("unknown" in knowQuery("RFC 3986 xyzzy-not-a-token", store)).toBe(true);
      expect("unknown" in knowQuery("", store)).toBe(true);
      expect(fact(knowQuery("charset=utf-8", store))).toBe("UTF-8 is a charset.");
      expect(fact(knowQuery("utf8", store))).toBe("UTF-8 is a charset.");
      expect(fact(knowQuery("SPDX-License-Identifier: Apache-2.0", store))).toMatch(/Apache-2\.0/);
      expect(fact(knowQuery("SPDX CC-BY-4.0", store))).toBe(
        "CC-BY-4.0 is Creative Commons Attribution 4.0 International.",
      );
      expect(fact(knowQuery("https://example.com/path", store))).toMatch(/^https is /);
      expect(fact(knowQuery("AAAA", store))).toBe("AAAA is an IP6 Address record.");
      expect("unknown" in knowQuery("charset=utf-8 xyzzy-not-a-token", store)).toBe(true);
      expect("unknown" in knowQuery("AAAA record", store)).toBe(true);
      expect(fact(knowQuery("United Kingdom's capital", store))).toBe("The capital of the United Kingdom is London.");
      expect(fact(knowQuery("capital of United Kingdom", store))).toBe("The capital of the United Kingdom is London.");
      expect(fact(knowQuery("Uniform Resource Identifier", store))).toContain("RFC 3986");
      expect(fact(knowQuery("MIT License", store))).toBe("MIT is an SPDX license.");
      expect(fact(knowQuery("Not Found", store))).toBe("HTTP 404 is Not Found.");
      expect(
        "unknown" in knowQuery("Follow the Uniform Resource Identifier generic syntax when parsing URLs", store),
      ).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("technique AND-miss falls back to the task object", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-tech-fb-"));
    writeFileSync(
      join(dir, "graph.kpk"),
      encodePack([
        {
          s: "jq",
          p: "is",
          o: "used for filtering JSON",
          e: "jq is used for filtering JSON",
          url: "https://jqlang.github.io/jq/",
        },
      ]),
    );
    const store = openStore(dir);
    try {
      expect(fact(knowQuery("used for JSON command line", store))).toBe("jq is used for filtering JSON.");
      expect(fact(injectFromText("what's the best way to filter JSON on the command line", store))).toBe(
        "jq is used for filtering JSON.",
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
