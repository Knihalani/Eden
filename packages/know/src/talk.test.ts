import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistable, frozenEncyclopedia, techniquesFromProse, triplesFromPage } from "./extract";
import { keepWet } from "./cc";
import { githubFrontierJunk, githubTalkUrl, redditTalkUrl, stackTalkUrl, talkUrl, talkFrontierJunk } from "./tools";
import { junkFrontier } from "./store";
import { encodePack } from "./pack";
import { openStore } from "./store";
import { injectFromText, injectNote, usefulInjectFact } from "./inject";
import { detectNeed } from "./need";
import { implicitTechniqueTask, techniqueNeedleFromText } from "./needles";
import { wetTalkBearing } from "./gate";

const LONG =
  "this is a long enough english page about how to filter json on the command line with enough stop words for the gopher checks to pass here. ";

describe("frozen encyclopedia stays off the graph", () => {
  test("capitals, RFC titles, IANA tautologies, country ISO are frozen", () => {
    expect(frozenEncyclopedia({ s: "Kenya", p: "capital", o: "Nairobi", e: "" })).toBe(true);
    expect(
      persistable("https://en.wikipedia.org/wiki/Kenya", {
        s: "Kenya",
        p: "capital",
        o: "Nairobi",
        e: "capital of Kenya is Nairobi",
      }),
    ).toBe(false);
    expect(
      persistable("https://www.rfc-editor.org/rfc/rfc3986.html", {
        s: "RFC 3986",
        p: "is",
        o: "Uniform Resource Identifier (URI): Generic Syntax",
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
      persistable("https://en.wikipedia.org/wiki/Kenya", {
        s: "Kenya",
        p: "is",
        o: "a country in East Africa",
        e: "",
      }),
    ).toBe(false);
    expect(
      persistable("https://en.wikipedia.org/wiki/Kenya", {
        s: "Kenya",
        p: "id",
        o: "KE",
        e: "Kenya ISO 3166-1 alpha-2 KE",
      }),
    ).toBe(false);
  });

  test("techniques and RFC obsoletes still persist", () => {
    const url = "https://old.reddit.com/r/commandline/comments/abc/jq/";
    expect(
      persistable(url, {
        s: "jq",
        p: "is",
        o: "used for filtering JSON on the command line",
        e: "jq is used for filtering JSON on the command line",
      }),
    ).toBe(true);
    expect(
      persistable("https://www.rfc-editor.org/rfc/rfc8259.html", {
        s: "RFC 8259",
        p: "obsoletes",
        o: "RFC 4627",
        e: "",
      }),
    ).toBe(true);
    expect(persistable(url, { s: "RFC 4627", p: "is", o: "obsoleted by RFC 8259", e: "" })).toBe(true);
  });

  test("wiki capital pages extract then drop at persist", () => {
    const html = `<table class="infobox"><tr><th>Capital</th><td><a href="/wiki/Nairobi">Nairobi</a></td></tr></table>
      <p>Kenya is a country in East Africa. The capital of Kenya is Nairobi.</p>`;
    const t = triplesFromPage("https://en.wikipedia.org/wiki/Kenya", html, true);
    expect(t.some((x) => x.p === "capital" && x.s === "Kenya" && x.o === "Nairobi")).toBe(true);
    expect(
      persistable(
        "https://en.wikipedia.org/wiki/Kenya",
        t.find((x) => x.p === "capital")!,
      ),
    ).toBe(false);
  });
});

describe("talk crawl: Reddit, GitHub issues, Stack Overflow", () => {
  test("allowlisted issues and programming reddit are talk, not junk", () => {
    expect(githubTalkUrl("https://github.com/oven-sh/bun/issues/1")).toBe(true);
    expect(githubTalkUrl("https://github.com/oven-sh/bun/discussions/12")).toBe(true);
    expect(githubTalkUrl("https://github.com/random-user/hello/issues/1")).toBe(false);
    expect(githubFrontierJunk("https://github.com/oven-sh/bun/issues/1")).toBe(false);
    expect(githubFrontierJunk("https://github.com/oven-sh/bun/issues")).toBe(false);
    expect(githubFrontierJunk("https://github.com/oven-sh/bun")).toBe(false);
    expect(githubFrontierJunk("https://github.com/random-user/hello")).toBe(true);
    expect(githubFrontierJunk("https://github.com/oven-sh/bun/wiki/how-to")).toBe(false);
    expect(githubFrontierJunk("https://github.com/random-user/hello/wiki")).toBe(true);
    expect(redditTalkUrl("https://old.reddit.com/r/commandline/comments/x/jq/")).toBe(true);
    expect(redditTalkUrl("https://www.reddit.com/r/funny/comments/x/cat/")).toBe(false);
    expect(talkFrontierJunk("https://old.reddit.com/r/commandline/comments/x/jq/")).toBe(false);
    expect(talkFrontierJunk("https://www.reddit.com/r/funny/comments/x/cat/")).toBe(true);
    expect(stackTalkUrl("https://stackoverflow.com/questions/12345/how-to-parse-json-with-jq")).toBe(true);
    expect(stackTalkUrl("https://stackoverflow.com/users/1")).toBe(false);
    expect(talkUrl("https://news.ycombinator.com/item?id=1")).toBe(true);
    expect(talkUrl("https://users.rust-lang.org/t/how-to-parse-json/1")).toBe(true);
    expect(talkUrl("https://dev.to/t/python")).toBe(true);
    expect(talkUrl("https://dev.to/someone/how-to-parse-json-with-jq-1a2b")).toBe(true);
    expect(talkUrl("https://lobste.rs/s/abc/how_to_jq")).toBe(true);
    expect(talkFrontierJunk("https://dev.to/enter")).toBe(true);
    expect(githubTalkUrl("https://github.com/BurntSushi/ripgrep/issues/12")).toBe(true);
    expect(junkFrontier("https://github.com/oven-sh/bun/issues/1")).toBe(false);
    expect(junkFrontier("https://old.reddit.com/r/commandline/comments/x/jq/")).toBe(false);
    expect(junkFrontier("https://www.reddit.com/r/funny/comments/x/cat/")).toBe(true);
    expect(junkFrontier("https://en.wikipedia.org/wiki/Kenya")).toBe(true);
    expect(junkFrontier("https://en.wikipedia.org/wiki/List_of_national_capitals")).toBe(true);
  });

  test("keepWet holds technique-bearing talk, drops meme reddit", () => {
    const how = LONG.repeat(3) + "How do I parse JSON on the command line? Use jq to filter JSON.";
    expect(keepWet({ uri: "https://old.reddit.com/r/commandline/comments/x/jq/", text: how })).toBe(true);
    expect(keepWet({ uri: "https://github.com/oven-sh/bun/issues/99", text: how })).toBe(true);
    expect(keepWet({ uri: "https://stackoverflow.com/questions/1/jq-json", text: how })).toBe(true);
    expect(keepWet({ uri: "https://www.reddit.com/r/funny/comments/x/cat/", text: how })).toBe(false);
    expect(keepWet({ uri: "https://github.com/random-user/hello/issues/1", text: how })).toBe(false);
  });

  test("forum prose packs used-for, not capitals", () => {
    const text =
      "instead of grep, use jq to filter JSON on the command line. " +
      "I used ripgrep to search the repo. Don't use cat to parse JSON, use jq to parse JSON. " +
      "fixed it by using Bun to run TypeScript services. " +
      "try fd to find files by name. switched to uv to install Python packages. " +
      "the answer is to use ripgrep to search the repo. " +
      "you should use jq to parse nested JSON. fd works well for finding files.";
    const t = techniquesFromProse(text);
    expect(t.some((x) => x.s === "jq" && /used for filter JSON/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "ripgrep" && /used for search/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "Bun" && /used for run TypeScript/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "fd" && /used for find files/i.test(x.o))).toBe(true);
    expect(t.some((x) => x.s === "uv" && /used for install Python/i.test(x.o))).toBe(true);
    const page = triplesFromPage("https://old.reddit.com/r/commandline/comments/x/jq/", text, false);
    expect(page.some((x) => x.p === "is" && x.o.startsWith("used for "))).toBe(true);
    expect(page.every((x) => persistable("https://old.reddit.com/r/commandline/comments/x/jq/", x))).toBe(true);
  });
});

describe("inject useful techniques, skip frozen flash", () => {
  const FACTS = [
    {
      s: "jq",
      p: "is",
      o: "used for filtering JSON on the command line",
      e: "jq is used for filtering JSON on the command line",
      url: "https://jqlang.github.io/jq/",
    },
    {
      s: "RFC 8259",
      p: "obsoletes",
      o: "RFC 4627",
      e: "",
      url: "https://www.rfc-editor.org/rfc/rfc8259.html",
    },
  ];

  test("usefulInjectFact rejects capitals and RFC titles", () => {
    expect(usefulInjectFact("The capital of Kenya is Nairobi.")).toBe(false);
    expect(usefulInjectFact("RFC 3986 is Uniform Resource Identifier (URI): Generic Syntax.")).toBe(false);
    expect(usefulInjectFact("application/json is a JSON media type.")).toBe(false);
    expect(usefulInjectFact("change-password is Change Password.")).toBe(false);
    expect(usefulInjectFact("jq is used for filtering JSON on the command line.")).toBe(true);
    expect(usefulInjectFact("RFC 8259 obsoletes RFC 4627.")).toBe(true);
    expect(usefulInjectFact("The changelog updates the README.")).toBe(false);
    expect(usefulInjectFact("used for nothing without a subject")).toBe(false);
  });

  test("how-to and wrong-way inject jq; capital and RFC title stay silent", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-know-talk-"));
    writeFileSync(join(dir, "graph.kpk"), encodePack(FACTS));
    const store = openStore(dir);
    try {
      const card = injectFromText("what's the best way to filter JSON on the command line", store);
      expect(card?.fact).toMatch(/^jq is used for/);
      expect(card?.url).toBe("https://jqlang.github.io/jq/");
      expect(injectNote(card!)).toBe(
        "Eden Know: jq is used for filtering JSON on the command line. Source: https://jqlang.github.io/jq/",
      );
      expect(injectFromText("how do I parse nested JSON in bash", store)?.url).toBe("https://jqlang.github.io/jq/");
      expect(injectFromText("is there a way to parse JSON on the command line", store)?.fact).toMatch(
        /^jq is used for/,
      );
      expect(injectFromText("looking for a tool to filter JSON", store)?.fact).toMatch(/^jq is used for/);
      expect(injectFromText("What is the capital of Kenya?", store)).toBeUndefined();
      expect(injectFromText("Follow RFC 3986 when parsing the URI.", store)).toBeUndefined();
      expect(injectFromText("Please refactor the auth middleware and add a log line.", store)).toBeUndefined();
      expect(injectFromText("Parse the body with RFC 4627.", store)?.fact).toBe("RFC 8259 obsoletes RFC 4627.");
      expect(detectNeed({ text: "how do I parse nested JSON in bash" }).queries[0]).toBe("used for JSON");
      expect(implicitTechniqueTask("how do I parse nested JSON in bash")).toBe("JSON");
      expect(techniqueNeedleFromText("how do I parse nested JSON in bash")).toBeTruthy();
      expect(wetTalkBearing("How do I parse JSON? Use jq to filter JSON.")).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
