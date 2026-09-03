import { describe, expect, test } from "bun:test";
import { pageTtl, ttlDaysFor, ttlDaysOnSkip, TTL_DAYS } from "./ttl";

describe("pageTtl host/path/source, not URL substrings", () => {
  test("registries are 5 years; wikipedia is 90 even when the title contains news/standard", () => {
    expect(pageTtl("https://www.rfc-editor.org/rfc/rfc3986.html", "URI Generic Syntax")).toEqual({
      class: "registry",
      days: 365 * 5,
    });
    expect(ttlDaysFor("https://en.wikipedia.org/wiki/Newspaper", "A newspaper is a periodical.")).toBe(90);
    expect(ttlDaysFor("https://en.wikipedia.org/wiki/Standard_Model", "particle physics")).toBe(90);
    expect(ttlDaysFor("https://en.wikipedia.org/wiki/Blog", "A blog is a website.")).toBe(90);
    expect(ttlDaysFor("https://en.wikipedia.org/wiki/Press", "printing press")).toBe(90);
  });

  test("academia and docs are their own clocks", () => {
    expect(ttlDaysFor("https://arxiv.org/abs/1706.03762", "attention is all you need")).toBe(180);
    expect(ttlDaysFor("https://pubmed.ncbi.nlm.nih.gov/12345/", "pmid abstract")).toBe(180);
    expect(ttlDaysFor("https://docs.python.org/3/library/os.html", "os module")).toBe(90);
    expect(ttlDaysFor("https://developer.mozilla.org/en-US/docs/Web/HTTP", "http")).toBe(90);
  });

  test("known news hosts and dated/news paths recrawl daily", () => {
    expect(pageTtl("https://www.reuters.com/world/asia/story")).toEqual({ class: "news", days: 1 });
    expect(ttlDaysFor("https://apnews.com/article/abc")).toBe(1);
    expect(ttlDaysFor("https://www.bbc.com/news/world-123")).toBe(1);
    expect(ttlDaysFor("https://notes.example/news/local-election")).toBe(1);
    expect(ttlDaysFor("https://city.example/2026/09/03/mayor-wins")).toBe(1);
    expect(ttlDaysFor("https://www.w3.org/news/2026/pointer-events-level-3/")).toBe(1);
  });

  test("cc-news source is news even on an unknown host", () => {
    expect(ttlDaysFor("https://cms.example/p/123", "city council voted", "cc-news")).toBe(1);
    expect(pageTtl("https://cms.example/p/123", "", "cc-news").class).toBe("news");
  });

  test("NewsArticle markup is news; encyclopedic today is not", () => {
    const ld = `<script type="application/ld+json">{"@type":"NewsArticle","headline":"Vote"}</script>` + " body ".repeat(20);
    expect(ttlDaysFor("https://cms.example/vote", ld)).toBe(1);
    expect(ttlDaysFor("https://notes.example/stable-note", "a long enough english page about widgets today and yesterday")).toBe(
      365,
    );
  });

  test("blogs are weekly; generic pages are yearly", () => {
    expect(ttlDaysFor("https://blog.example/post/today", "published today")).toBe(7);
    expect(ttlDaysFor("https://notes.example/stable-note", "a long enough english page about widgets")).toBe(365);
  });

  test("skip TTL keeps news on the 1-day clock", () => {
    expect(ttlDaysOnSkip("https://www.reuters.com/world/x", "thin", "cc-news")).toBe(1);
    expect(ttlDaysOnSkip("https://en.wikipedia.org/wiki/Physics", "thin", "wiki-random")).toBe(7);
    expect(TTL_DAYS.news).toBe(1);
  });
});
