import { describe, expect, test } from "bun:test";
import { buildArgs, mapSearchArgs, usable, type ToolSchema } from "./schema-args";

const NOW = Date.UTC(2026, 9, 27, 9);
const s = (properties: ToolSchema["properties"], required: string[] = []): ToolSchema => ({
  type: "object",
  properties,
  required,
});
const str = { type: "string" };
const num = { type: "number" };

describe("mapSearchArgs", () => {
  test("finds the query argument by name, and the limit", () => {
    const meili = s({ query: str, indexUid: str, limit: num, offset: num, filter: str }, ["query"]);
    const m = mapSearchArgs(meili, { indexUid: "items" });
    expect(usable(m)).toBe(true);
    expect(buildArgs(m, "jamie fox", 10, NOW)).toEqual({ indexUid: "items", query: "jamie fox", limit: 10 });
  });

  test("a list-of-queries argument gets the query in a list (Chroma)", () => {
    const chroma = s(
      { collection_name: str, query_texts: { type: "array", items: str }, n_results: num, where: { type: "object" } },
      ["collection_name", "query_texts"],
    );
    expect(usable(mapSearchArgs(chroma))).toBe(false); // collection_name is required and unknown
    const m = mapSearchArgs(chroma, { collection_name: "items" });
    expect(buildArgs(m, "dinner", 5, NOW)).toEqual({ collection_name: "items", query_texts: ["dinner"], n_results: 5 });
  });

  test("a required date window is filled around now (CalDAV)", () => {
    const caldav = s(
      { calendar_index: num, query: str, search_fields: { type: "array" }, start_date: str, end_date: str },
      ["start_date", "end_date"],
    );
    const m = mapSearchArgs(caldav);
    expect(usable(m)).toBe(true);
    expect(buildArgs(m, "Jamie Fox", 5, NOW)).toEqual({
      query: "Jamie Fox",
      start_date: "2026-09-27",
      end_date: "2027-01-25",
    });
  });

  test("field-only search uses a text field, never an id or a folder (IMAP)", () => {
    const imap = s({
      accountId: str,
      folder: str,
      from: str,
      to: str,
      subject: str,
      body: str,
      since: str,
      messageId: str,
      limit: num,
    });
    const m = mapSearchArgs(imap, { accountId: "lab" });
    expect(m.text).toEqual({ name: "body", array: false });
    expect(m.limit).toBe("limit");
  });

  test("unknown names: a string argument described as the search; required context stays missing", () => {
    const rocket = s({ channel: str, search_text: str, count: num }, ["channel", "search_text"]);
    expect(mapSearchArgs(rocket).missing).toEqual(["channel"]);
    expect(usable(mapSearchArgs(rocket, { channel: "general" }))).toBe(true);
    const odd = s({ needle: { type: "string", description: "Words to search for" }, sort: str }, ["needle"]);
    expect(mapSearchArgs(odd).text?.name).toBe("needle");
    const none = s({ id: str, path: str });
    expect(mapSearchArgs(none).text).toBeNull();
  });

  test("an enum is never the query, and operator values win over the mapper", () => {
    const m = mapSearchArgs(s({ mode: { type: "string", enum: ["text", "vector"] }, query: str }), { mode: "text" });
    expect(buildArgs(m, "x", 3, NOW)).toEqual({ mode: "text", query: "x" });
  });
});

/** The search tools of eight open-source MCP servers, as their `tools/list` reported them in the connector lab. */
const corpus = (await Bun.file(new URL("./fixtures/mcp-tools.json", import.meta.url)).json()) as Record<
  string,
  { tool: string; inputSchema: ToolSchema }
>;

describe("mapSearchArgs on real servers' schemas", () => {
  // Hand-labelled: where each server's query goes, its limit, and what the operator must still supply.
  const expected: Record<string, { text: string; array?: boolean; limit: string | null; missing: string[] }> = {
    memory: { text: "query", limit: null, missing: [] },
    mcpvault: { text: "query", limit: "limit", missing: [] },
    "basic-memory": { text: "query", limit: "page_size", missing: [] },
    meilisearch: { text: "query", limit: "limit", missing: [] },
    caldav: { text: "query", limit: null, missing: [] },
    "imap-subject": { text: "body", limit: "limit", missing: [] },
    chroma: { text: "query_texts", array: true, limit: "n_results", missing: ["collection_name"] },
    "gitea-bleve": { text: "query", limit: "per_page", missing: [] },
  };

  for (const [name, want] of Object.entries(expected)) {
    test(name, () => {
      const m = mapSearchArgs(corpus[name]!.inputSchema);
      expect(m.text).toEqual({ name: want.text, array: want.array ?? false });
      expect(m.limit).toBe(want.limit);
      expect(m.missing).toEqual(want.missing);
    });
  }

  test("CalDAV's required date window is filled; the rest need nothing from the operator but Chroma's collection", () => {
    expect(mapSearchArgs(corpus.caldav!.inputSchema).window).toEqual({ start: "start_date", end: "end_date" });
    const usableWithout = Object.keys(expected).filter((n) => usable(mapSearchArgs(corpus[n]!.inputSchema)));
    expect(usableWithout.sort()).toEqual(
      Object.keys(expected)
        .filter((n) => n !== "chroma")
        .sort(),
    );
  });
});
