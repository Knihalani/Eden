import { describe, expect, test } from "bun:test";
import {
  buildArgs,
  buildFetchArgs,
  fetchUsable,
  mapFetchArgs,
  mapSearchArgs,
  usable,
  type ToolSchema,
} from "./schema-args";

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

  test("a mail tool's required from/to are a sender and recipient, not a date window", () => {
    const mail = s({ query: str, from: str, to: str }, ["from", "to"]);
    const m = mapSearchArgs(mail);
    expect(m.window).toBeNull();
    expect(m.missing).toEqual(["from", "to"]);
    const dated = s({ query: str, from: { type: "string", format: "date" }, to: { type: "string", format: "date" } }, [
      "from",
      "to",
    ]);
    expect(mapSearchArgs(dated).window).toMatchObject({ start: "from", end: "to", required: true });
  });

  test("an optional date window is filled only with the request's own days (D44); timestamps get a time", () => {
    const cal = s({
      fullText: str,
      startTime: { type: "string", description: "ISO 8601 timestamp" },
      endTime: { type: "string", description: "ISO 8601 timestamp" },
    });
    const m = mapSearchArgs(cal);
    expect(m.window).toEqual({ start: "startTime", end: "endTime", required: false, time: true, events: true });
    expect(m.missing).toEqual([]);
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(buildArgs(m, "globex", 5, now)).not.toHaveProperty("startTime");
    // At the user's offset, RFC 3339.
    expect(buildArgs(m, "", 5, now, { start: "2026-11-01", end: "2026-11-02", offsetMinutes: -420 })).toMatchObject({
      startTime: "2026-11-01T00:00:00-07:00",
    });
    expect(buildArgs(m, "globex", 5, now, { start: "2026-11-01", end: "2026-11-02" })).toMatchObject({
      startTime: "2026-11-01T00:00:00Z",
      endTime: "2026-11-02T00:00:00Z",
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
    expect(mapSearchArgs(corpus.caldav!.inputSchema).window).toMatchObject({
      start: "start_date",
      end: "end_date",
      required: true,
    });
    expect(mapSearchArgs(corpus.caldav!.inputSchema).window?.events).toBe(true);
    // IMAP's since/before filter mail by date: a listing of them would be the day's mail, not a calendar's (D44).
    expect(mapSearchArgs(corpus["imap-subject"]!.inputSchema).window).toMatchObject({ start: "since", events: false });
    const usableWithout = Object.keys(expected).filter((n) => usable(mapSearchArgs(corpus[n]!.inputSchema)));
    expect(usableWithout.sort()).toEqual(
      Object.keys(expected)
        .filter((n) => n !== "chroma")
        .sort(),
    );
  });
});

describe("mapFetchArgs", () => {
  const schema = (properties: Record<string, unknown>, required: string[] = []) =>
    ({ type: "object", properties, required }) as ToolSchema;

  test("the ref goes to a known id name", () => {
    const m = mapFetchArgs(schema({ id: { type: "string" }, format: { type: "string" } }, ["id"]));
    expect(buildFetchArgs(m, "n1")).toEqual({ id: "n1" });
  });

  test("else to the one argument named like an id", () => {
    const m = mapFetchArgs(schema({ message_id: { type: "string" }, format: { type: "string" } }));
    expect(buildFetchArgs(m, "m-9")).toEqual({ message_id: "m-9" });
  });

  test("two id-like arguments: the required one, else no mapping", () => {
    const both = { user_id: { type: "string" }, message_id: { type: "string" } };
    expect(buildFetchArgs(mapFetchArgs(schema(both, ["message_id"])), "m")).toEqual({ message_id: "m" });
    expect(fetchUsable(mapFetchArgs(schema(both)))).toBe(false);
  });

  test("a number argument takes a numeric ref only; fixed values fill the rest", () => {
    const github = schema({ owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "integer" } }, [
      "owner",
      "repo",
      "issue_number",
    ]);
    expect(fetchUsable(mapFetchArgs(github))).toBe(false); // owner and repo: which one is the ref is a guess.
    const m = mapFetchArgs(github, { owner: "acme", repo: "app" });
    expect(fetchUsable(m)).toBe(true);
    expect(buildFetchArgs(m, "42")).toEqual({ owner: "acme", repo: "app", issue_number: 42 });
    expect(buildFetchArgs(m, "https://example.com/42")).toBeNull();
  });

  test("a required argument with no value makes the mapping unusable", () => {
    const m = mapFetchArgs(schema({ id: { type: "string" }, collection: { type: "string" } }, ["id", "collection"]));
    expect(m.missing).toEqual(["collection"]);
    expect(fetchUsable(m)).toBe(false);
  });

  test("a word that merely ends in id is not an id", () => {
    const m = mapFetchArgs(schema({ valid: { type: "string" }, thread: { type: "string" } }));
    expect(fetchUsable(m)).toBe(false);
    expect(mapFetchArgs(schema({ pageId: { type: "string" }, paid: { type: "string" } })).ref?.name).toBe("pageId");
  });

  test("a search's text argument is never the ref, even as the one required argument", () => {
    const m = mapFetchArgs(schema({ query: { type: "string" }, limit: { type: "number" } }, ["query"]));
    expect(m.ref).toBeNull();
  });

  test("enum arguments never take the ref; a required argument with a default is not missing", () => {
    const m = mapFetchArgs(
      schema(
        {
          uid: { type: "string" },
          mode: { type: "string", enum: ["a", "b"] },
          view: { type: "string", default: "full" },
        },
        ["uid", "view"],
      ),
    );
    expect(m.ref?.name).toBe("uid");
    expect(m.missing).toEqual([]);
    const onlyEnum = mapFetchArgs(schema({ id: { type: "string", enum: ["x"] } }, ["id"]));
    expect(onlyEnum.ref).toBeNull();
  });

  test("a number argument takes a numeric ref, as an integer one does", () => {
    const m = mapFetchArgs(schema({ issue_number: { type: "number" } }, ["issue_number"]));
    expect(buildFetchArgs(m, "7")).toEqual({ issue_number: 7 });
    expect(buildFetchArgs(m, "abc")).toBeNull();
  });
});
