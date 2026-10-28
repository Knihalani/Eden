import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { searchSources } from "./fanout";
import { toItems } from "./mcp-source";
import type { Source } from "./source";
import { StaticSource } from "./static-source";

const scope = { tenantId: "t", userId: "u" };
const query = (text: string) => ({ scope, text, entities: [], limit: 5 });

describe("StaticSource", () => {
  test("ranks by term overlap and ids items by source", async () => {
    const s = new StaticSource("docs", "policies", [
      { ref: "a", title: "Travel policy", text: "Book flights through Navan" },
      { ref: "b", title: "Expense policy", text: "Receipts within 30 days, travel too" },
    ]);
    const items = await s.search(query("travel flights"));
    expect(items.map((i) => i.id)).toEqual(["docs:a", "docs:b"]);
  });
});

describe("toItems", () => {
  test("splits a JSON array result into items and keeps plain text whole", () => {
    const rows = JSON.stringify([{ id: "m1", subject: "Renewal", snippet: "Acme wants 3 years" }]);
    const items = toItems(
      "gmail",
      [
        { type: "text", text: rows },
        { type: "text", text: "plain note" },
      ],
      10,
    );
    expect(items[0]).toMatchObject({ id: "gmail:m1", title: "Renewal", text: "Acme wants 3 years" });
    expect(items[1]).toMatchObject({ text: "plain note" });
    expect(items[1]!.ref).toMatch(/^eden-h-[0-9a-f]{16}$/);
  });
});

describe("searchSources", () => {
  const slow: Source = {
    id: "slow",
    kind: "test",
    description: "",
    search: () => new Promise<ContextItem[]>((r) => setTimeout(() => r([]), 1_000)),
  };
  const broken: Source = { id: "broken", kind: "test", description: "", search: async () => Promise.reject("x") };

  test("a slow or broken source reports why and never blocks the others", async () => {
    const ok = new StaticSource("ok", "", [{ ref: "1", title: "hello", text: "world" }]);
    const out = await searchSources([slow, broken, ok], query("hello"), { timeoutMs: 50 });
    expect(out.map((o) => [o.sourceId, o.status])).toEqual([
      ["slow", "timeout"],
      ["broken", "error"],
      ["ok", "ok"],
    ]);
    expect(out[2]!.items).toHaveLength(1);
  });
});

/** One real search result from each of eight open-source MCP servers, from the connector lab (synthetic data). */
const real = (await Bun.file(new URL("./fixtures/mcp-results.json", import.meta.url)).json()) as Record<
  string,
  { content: unknown; structuredContent?: unknown }
>;

describe("toItems on real servers' results", () => {
  const items = (name: string) => toItems(name, real[name]!.content, 10, real[name]!.structuredContent);

  test("every server's result becomes one item per row, each with a distinct, non-positional ref", () => {
    for (const name of Object.keys(real)) {
      const got = items(name);
      expect(got.length).toBeGreaterThan(0);
      expect(new Set(got.map((i) => i.id)).size).toBe(got.length);
      for (const i of got) expect(i.ref).not.toMatch(/^block-/);
    }
  });

  test("a row's own id is its ref, wherever the server put it", () => {
    expect(items("meilisearch")[0]!.ref).toBe("gmail-mail-2"); // after a prose line; also in structuredContent
    expect(items("caldav")[0]!.ref).toBe("calendar-event-0"); // uid
    expect(items("chroma")[0]!.ref).toBe("calendar-event-0"); // columnar ids
    expect(items("gitea-bleve")[0]!.ref).toBe("5");
    expect(items("basic-memory")[0]!.ref).toBe("main/gmail/gmail-mail-3"); // nested {result: {results}}
    expect(items("mcpvault")[0]!.ref).toBe("obsidian:////vault/calendar/calendar-event-0"); // uri
    expect(items("imap-subject")[0]!.ref).toMatch(/^\d+$/); // uid under {messages}
    expect(items("caldav")[0]!.title).toBe("Dinner with Jamie Fox");
    expect(items("chroma")[0]!.text).toContain("Barrafina");
  });

  test("rows without an id get a content hash: the same row keeps its id, different rows never share one", () => {
    const a = { name: "Dana Lee", observations: ["prefers mornings"] };
    const b = { name: "Dana Lee", observations: ["moved to Leeds"] };
    const first = toItems("memory", [{ type: "text", text: JSON.stringify({ entities: [a] }) }], 5);
    const again = toItems("memory", [{ type: "text", text: JSON.stringify({ entities: [b, a] }) }], 5);
    expect(again[1]!.id).toBe(first[0]!.id);
    expect(again[0]!.id).not.toBe(first[0]!.id);
    expect(first[0]).toMatchObject({ title: "Dana Lee", text: "prefers mornings" });
    // Plain text blocks: the same holds by content.
    const t1 = toItems("s", [{ type: "text", text: "one" }], 5);
    const t2 = toItems("s", [{ type: "text", text: "two" }], 5);
    expect(t1[0]!.id).not.toBe(t2[0]!.id);
  });

  test("an empty JSON result is no items, and a single record is one", () => {
    for (const text of ["[]", '{"totalFound": 0, "messages": []}', "{}", 'Search results for "x":\n{"hits": []}']) {
      expect(toItems("x", [{ type: "text", text }], 5)).toEqual([]);
    }
    const one = toItems("x", [{ type: "text", text: '{"id": "n1", "title": "Note", "content": "hello"}' }], 5);
    expect(one).toMatchObject([{ ref: "n1", title: "Note", text: "hello" }]);
  });

  test("a record keeps its nested lists: an issue's labels are not results", () => {
    const issue = {
      id: 7,
      title: "Bug",
      body: "crash",
      labels: [
        { id: 1, name: "bug" },
        { id: 2, name: "p1" },
      ],
    };
    expect(toItems("x", [{ type: "text", text: JSON.stringify(issue) }], 5)).toMatchObject([
      { ref: "7", title: "Bug" },
    ]);
    const page = { data: { id: "p1", title: "Page", attachments: [{ name: "a.pdf" }] } };
    expect(toItems("x", [{ type: "text", text: JSON.stringify(page) }], 5)).toMatchObject([{ ref: "p1" }]);
  });

  test("an empty result list stays empty whatever else the result holds (facets, filters)", () => {
    const text = JSON.stringify({
      results: [],
      query: { filters: [{ field: "from", value: "a" }] },
      facets: [{ k: 1 }],
    });
    expect(toItems("x", [{ type: "text", text }], 5)).toEqual([]);
    expect(toItems("x", [], 5, { hits: [], suggestions: [{ text: "did you mean" }] })).toEqual([]);
  });

  test("rows with no id that share a title but differ elsewhere get different refs", () => {
    const refs = (v: unknown) => toItems("x", [{ type: "text", text: JSON.stringify(v) }], 5).map((i) => i.ref);
    const contacts = refs([
      { name: "Dana Lee", email: "a@x.io" },
      { name: "Dana Lee", email: "b@y.io" },
    ]);
    expect(new Set(contacts).size).toBe(2);
    const standups = refs({
      events: [
        { summary: "Standup", start: "2026-10-01T09:00" },
        { summary: "Standup", start: "2026-10-02T09:00" },
      ],
    });
    expect(new Set(standups).size).toBe(2);
  });

  test("a response that echoes its request (url, path, id) still yields its results", () => {
    const refs = (v: unknown) => toItems("x", [{ type: "text", text: JSON.stringify(v) }], 5).map((i) => i.ref);
    expect(refs({ url: "https://api.x/search?q=a", results: [{ id: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
    expect(refs({ path: "notes/", matches: [{ path: "notes/a.md" }, { path: "notes/b.md" }] })).toEqual([
      "notes/a.md",
      "notes/b.md",
    ]);
    expect(refs({ id: "req-1", hits: [{ id: "h1" }] })).toEqual(["h1"]);
    expect(refs({ url: "https://q", data: { results: [{ id: "a" }, { id: "b" }] } })).toEqual(["a", "b"]);
    // Rows told apart only by a snippet still get different refs.
    expect(
      new Set(
        refs([
          { title: "Notes", snippet: "a" },
          { title: "Notes", snippet: "b" },
        ]),
      ).size,
    ).toBe(2);
  });

  test("plain text that merely ends in JSON is still one item", () => {
    for (const text of ["Budget for Q3 attached: [1, 2, 3]", "Config used: {}", "see {the notes}"]) {
      expect(toItems("x", [{ type: "text", text }], 5)).toMatchObject([{ text }]);
    }
  });

  test("a row with no id keeps one ref when only its score or excerpt changes between queries", () => {
    const a = { title: "A", content: "x", _score: 1.2, excerpt: "…x…" };
    const b = { title: "A", content: "x", _score: 0.7, excerpt: "…other…" };
    const ref = (row: object) => toItems("x", [{ type: "text", text: JSON.stringify([row]) }], 5)[0]!.ref;
    expect(ref(a)).toBe(ref(b));
    expect(ref(a)).not.toBe(ref({ ...a, content: "y" }));
    // With no title or text, volatile fields are left out of the hash.
    expect(ref({ k: 1, score: 3 })).toBe(ref({ k: 1, score: 9 }));
  });

  test("structuredContent wins over text, and only http(s) links become urls", () => {
    const got = toItems("x", [{ type: "text", text: "Found 1." }], 5, {
      hits: [{ id: "a", title: "A", url: "javascript:alert(1)", link: "https://example.com/a" }],
    });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ ref: "a", url: "https://example.com/a" });
  });
});
