import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePack } from "./pack";
import { openStore } from "./store";
import { formatCard, knowQuery, MAX_TOKENS } from "./query";
import { injectFromText } from "./inject";
import { needleRank, needlesFromText, rankNeedles } from "./needles";

const FACTS = [
  { s: "RFC 35", p: "is", o: "Network Meeting", e: "", url: "https://www.rfc-editor.org/rfc/rfc35.html" },
  { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "", url: "https://www.rfc-editor.org/rfc/rfc3986.html" },
  { s: "RFC 9110", p: "is", o: "HTTP Semantics", e: "", url: "https://www.rfc-editor.org/rfc/rfc9110.html" },
  { s: "RFC 4627", p: "is", o: "The application/json Media Type for JavaScript Object Notation (JSON)", e: "RFC 4627: The application&#x2F;json Media Type for JavaScript Object Notation (JSON)", url: "https://www.rfc-editor.org/rfc/rfc4627.html" },
  { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "https://www.iana.org/assignments/media-types/media-types.xml" },
  { s: "IANA method GET", p: "is", o: "safe, idempotent, RFC 9110", e: "", url: "https://www.iana.org/assignments/http-methods/http-methods.xml" },
  { s: "IANA http 404", p: "is", o: "Not Found", e: "", url: "https://www.iana.org/assignments/http-status-codes/http-status-codes.xml" },
  { s: "IANA protocol 6", p: "is", o: "TCP", e: "", url: "https://www.iana.org/assignments/protocol-numbers/protocol-numbers.xml" },
  { s: "IANA header Accept", p: "is", o: "Media types", e: "", url: "https://www.iana.org/assignments/http-fields/http-fields.xml" },
  { s: "IANA header Content-Type", p: "is", o: "Media type of the payload", e: "", url: "https://www.iana.org/assignments/http-fields/http-fields.xml" },
  { s: "IANA charset utf-8", p: "is", o: "UTF-8", e: "", url: "https://www.iana.org/assignments/character-sets/character-sets.xml" },
  { s: "IANA scheme https", p: "is", o: "Hypertext Transfer Protocol Secure", e: "", url: "https://www.iana.org/assignments/uri-schemes/uri-schemes.xml" },
  { s: "IANA dns AAAA", p: "is", o: "IP6 Address", e: "", url: "https://www.iana.org/assignments/dns-parameters/dns-parameters.xml" },
  { s: "United Kingdom", p: "capital", o: "London", e: "capital of United Kingdom is London", url: "https://en.wikipedia.org/wiki/United_Kingdom" },
  { s: "Kenya", p: "capital", o: "Nairobi", e: "capital of Kenya is Nairobi", url: "https://en.wikipedia.org/wiki/Kenya" },
  { s: "IANA well-known change-password", p: "is", o: "Change Password", e: "", url: "https://www.iana.org/assignments/well-known-uris/well-known-uris.xml" },
  { s: "SPDX MIT", p: "is", o: "MIT License", e: "", url: "https://spdx.org/licenses/licenses.json" },
  { s: "SPDX Apache-2.0", p: "is", o: "Apache License 2.0", e: "", url: "https://spdx.org/licenses/licenses.json" },
  { s: "W3C web-share", p: "is", o: "Web Share API", e: "", url: "https://www.w3.org/TR/web-share/" },
  { s: "WHATWG html", p: "is", o: "HTML", e: "", url: "https://html.spec.whatwg.org/multipage/" },
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
    expect(needlesFromText("charset=\"UTF-8\"")).toContain("UTF-8");
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
    expect(fact(injectFromText("Send UTF-8 and set Accept."))).toMatch(/^Accept is /);
    expect(fact(injectFromText("Send UTF-8 and set Accept."))).not.toMatch(/charset/i);
    expect(fact(injectFromText("GET and application/json"))).toContain("application/json");
    expect(fact(injectFromText("GET and application/json"))).not.toMatch(/^GET is /);
    expect(fact(injectFromText("GET and RFC 3986"))).toContain("RFC 3986");
    expect(fact(injectFromText("GET and RFC 3986"))).not.toMatch(/^GET is /);
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
          { s: "United States", p: "capital", o: "Washington, D.C.", e: "capital of United States is Washington, D.C." },
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

  test("area-only RFC card upgrades to the stored title", () => {
    expect(
      fact(formatCard("RFC 9000", [{ s: "RFC 9000", p: "is", o: "HTTP", e: "" }])),
    ).toBe("RFC 9000 is an HTTP RFC.");
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

  test("RFC keeps (URI); SPDX is not a tautology dump; media is not RFC 4627", () => {
    const rfc = formatCard("RFC 3986", [
      { s: "RFC 3986", p: "is", o: "Uniform Resource Identifier (URI): Generic Syntax", e: "" },
    ]);
    expect(fact(rfc)).toContain("(URI)");
    expect(fact(rfc).split(/\s+/).length).toBeLessThanOrEqual(MAX_TOKENS);
    const mit = formatCard("MIT", [{ s: "SPDX MIT", p: "is", o: "MIT License", e: "" }]);
    expect(fact(mit)).toMatch(/MIT/);
    expect(fact(mit)).not.toBe("SPDX MIT is MIT License.");
    const json = formatCard("application/json", [
      { s: "RFC 4627", p: "is", o: "The application/json Media Type for JSON", e: "RFC 4627: The application&#x2F;json Media Type for JSON" },
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
      const rfc = injectFromText("Use GET and RFC 3986 when parsing.", store);
      expect(fact(rfc)).toContain("RFC 3986");
      expect(fact(rfc)).toContain("URI");
      expect(fact(rfc)).not.toMatch(/^GET is /);

      const short = injectFromText("See RFC 35.", store);
      expect(fact(short)).toBe("RFC 35 is Network Meeting.");

      const json = injectFromText("Send GET with application/json.", store);
      expect(fact(json)).toContain("application/json");
      expect(fact(json)).not.toContain("4627");
      expect(fact(json)).not.toMatch(/^GET is /);

      const status = injectFromText("GET then return HTTP 404.", store);
      expect(fact(status)).toContain("404");
      expect(fact(status)).not.toMatch(/^GET is /);

      const hdr = injectFromText("GET and set Accept.", store);
      expect(fact(hdr)).toMatch(/^Accept is /);

      const proto = injectFromText("GET over TCP.", store);
      expect(fact(proto)).toBe("TCP is protocol 6.");

      const mit = injectFromText("GET with MIT.", store);
      expect(fact(mit)).toMatch(/MIT/);
      expect(fact(mit)).not.toBe("SPDX MIT is MIT License.");

      expect(fact(injectFromText("charset=utf8", store))).toMatch(/UTF-8/);
      expect(fact(injectFromText("SPDX-License-Identifier: Apache-2.0", store))).toMatch(/Apache-2\.0/);
      expect(fact(injectFromText("https://example.com/path", store))).toMatch(/^https is /);
      expect(fact(injectFromText("DNS AAAA record", store))).toBe("AAAA is an IP6 Address record.");
      expect(fact(injectFromText("United Kingdom's capital", store))).toBe("The capital of the United Kingdom is London.");
      expect(fact(injectFromText("Content-Type: text/plain; charset=utf-8", store))).toMatch(/^Content-Type is /);
      expect(fact(injectFromText("Content-Type: text/plain; charset=utf-8", store))).not.toMatch(/UTF-8/);
      expect(fact(injectFromText("RFC 3986 xyzzy-not-a-token", store))).toContain("RFC 3986");
      expect(fact(injectFromText("RFC 3986 xyzzy-not-a-token", store))).not.toMatch(/^GET is /);
      expect(fact(injectFromText("SPDX-License-Identifier: MIT", store))).toMatch(/MIT/);

      const coldRfcGet = injectFromText("Use GET and RFC 4627 when parsing.", store);
      expect(fact(coldRfcGet)).toContain("RFC 4627");
      expect(fact(coldRfcGet)).not.toMatch(/^GET is /);
      const coldRfcJson = injectFromText("Send GET with application/json and see RFC 4627.", store);
      expect(fact(coldRfcJson)).toContain("RFC 4627");
      expect(fact(coldRfcJson)).not.toMatch(/^GET is /);
      expect(fact(coldRfcJson)).not.toMatch(/^application\/json is /);
      expect(fact(injectFromText("RFC 4627 and application/json", store))).toContain("RFC 4627");
      expect(fact(injectFromText("RFC 4627 and application/json", store))).not.toMatch(/^application\/json is /);
      const wkStore = {
        search(q: string) {
          if (/change-password/i.test(q)) {
            return [{ s: "IANA well-known change-password", p: "is", o: "Change Password", e: "", url: "" }];
          }
          return [];
        },
      };
      expect(fact(injectFromText("/.well-known/change-password", wkStore))).toMatch(/change-password/);

      expect(injectFromText("no fact shaped tokens here at all", store)).toBeUndefined();
      expect(fact(injectFromText("Follow the Uniform Resource Identifier generic syntax when parsing URLs", store))).toContain(
        "RFC 3986",
      );
      expect(fact(injectFromText("Follow the Uniform Resource Identifier generic syntax when parsing URLs", store))).toContain(
        "(URI)",
      );
      expect(fact(injectFromText("Follow HTTP Semantics when writing the handler.", store))).toContain("RFC 9110");
      expect(injectFromText("Please refactor the auth middleware and add a log line.", store)).toBeUndefined();
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
      expect(fact(knowQuery("https://example.com/path", store))).toMatch(/^https is /);
      expect(fact(knowQuery("AAAA", store))).toBe("AAAA is an IP6 Address record.");
      expect("unknown" in knowQuery("charset=utf-8 xyzzy-not-a-token", store)).toBe(true);
      expect("unknown" in knowQuery("AAAA record", store)).toBe(true);
      expect(fact(knowQuery("United Kingdom's capital", store))).toBe("The capital of the United Kingdom is London.");
      expect(fact(knowQuery("capital of United Kingdom", store))).toBe("The capital of the United Kingdom is London.");
      expect(fact(knowQuery("Uniform Resource Identifier", store))).toContain("RFC 3986");
      expect(fact(knowQuery("MIT License", store))).toBe("MIT is an SPDX license.");
      expect(fact(knowQuery("Not Found", store))).toBe("HTTP 404 is Not Found.");
      expect("unknown" in knowQuery("Follow the Uniform Resource Identifier generic syntax when parsing URLs", store)).toBe(
        true,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
