import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SourceFanout } from "./guarded";
import { ArgumentMappingError, McpSource, nextCursorOf, ReadOnlyViolation } from "./mcp-source";
import { buildListArgs, mapListArgs } from "./schema-args";

const scope = { tenantId: "t", userId: "u" };
const rows = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, subject: `Mail ${i}`, snippet: `body ${i}` }));

/** A mail-like server: a token-paged list tool (read-only or not), and a write tool that must never be called. */
function mailServer(readOnly = true, schema: "token" | "offset" | "required" = "token") {
  const server = new McpServer({ name: "mail", version: "1" });
  const calls: Record<string, unknown>[] = [];
  let writes = 0;
  server.registerTool(
    "search_mail",
    { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "[]" }] }),
  );
  const input: z.ZodRawShape =
    schema === "token"
      ? { pageToken: z.string().optional(), maxResults: z.number().optional() }
      : schema === "offset"
        ? { offset: z.number().optional(), limit: z.number().optional() }
        : { folder: z.string(), limit: z.number().optional() };
  server.registerTool(
    "list_mail",
    { inputSchema: input, annotations: { readOnlyHint: readOnly } },
    async (args: Record<string, unknown>) => {
      calls.push(args);
      const a = args as Record<string, unknown>;
      const size = Number(a.maxResults ?? a.limit ?? 2);
      const at = a.pageToken ? Number(String(a.pageToken).slice(1)) : Number(a.offset ?? 0);
      const page = rows.slice(at, at + size);
      const next = at + size < rows.length ? `p${at + size}` : undefined;
      return {
        content: [{ type: "text", text: JSON.stringify({ messages: page, ...(next ? { nextPageToken: next } : {}) }) }],
      };
    },
  );
  server.registerTool("delete_mail", { inputSchema: { id: z.string() } }, async () => {
    writes++;
    return { content: [] };
  });
  return { server, calls, writes: () => writes };
}

const make = (
  server: McpServer,
  listTool?: ConstructorParameters<typeof McpSource>[0]["listTool"],
  trusted?: string[],
) =>
  new McpSource({
    id: "mail",
    description: "mail",
    transport: () => {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      void server.connect(serverSide);
      return client;
    },
    searchTool: { name: "search_mail" },
    listTool,
    trustedReadTools: trusted,
  });

describe("McpSource list (D56)", () => {
  test("pages through a read-only list tool with the server's own cursor, arguments from its schema", async () => {
    const { server, calls } = mailServer();
    const s = make(server, { name: "list_mail" });
    const one = await s.list!(scope, undefined, 2, AbortSignal.timeout(2_000));
    expect(one.items.map((i) => i.ref)).toEqual(["m0", "m1"]);
    expect(one.next).toBe("p2");
    const two = await s.list!(scope, one.next!, 2, AbortSignal.timeout(2_000));
    const three = await s.list!(scope, two.next!, 2, AbortSignal.timeout(2_000));
    expect(three.items.map((i) => i.ref)).toEqual(["m4"]);
    expect(three.next).toBeNull();
    expect(calls).toEqual([{ maxResults: 2 }, { pageToken: "p2", maxResults: 2 }, { pageToken: "p4", maxResults: 2 }]);
    await s.close();
  });

  test("an offset-paged tool: Eden computes the next offset while pages come back full", async () => {
    const { server } = mailServer(true, "offset");
    const s = make(server, { name: "list_mail" });
    const one = await s.list!(scope, undefined, 3, AbortSignal.timeout(2_000));
    expect(one.next).toBe("3");
    const two = await s.list!(scope, one.next!, 3, AbortSignal.timeout(2_000));
    expect(two.items.map((i) => i.ref)).toEqual(["m3", "m4"]);
    expect(two.next).toBeNull();
    await s.close();
  });

  test("a list tool not declared read-only fails the connect: no tool at all is called", async () => {
    const { server, calls, writes } = mailServer(false);
    const s = make(server, { name: "list_mail" });
    await expect(s.list!(scope, undefined, 2, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(s.search({ scope, text: "x", entities: [], limit: 5 }, AbortSignal.timeout(2_000))).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(writes()).toBe(0);
  });

  test("an operator may trust a list tool by name, as for search and fetch", async () => {
    const { server } = mailServer(false);
    const s = make(server, { name: "list_mail" }, ["list_mail"]);
    expect((await s.list!(scope, undefined, 2, AbortSignal.timeout(2_000))).items).toHaveLength(2);
    await s.close();
  });

  test("a required argument the mapper cannot fill fails the connect until the operator sets it", async () => {
    const { server } = mailServer(true, "required");
    await expect(
      make(server, { name: "list_mail" }).list!(scope, undefined, 2, AbortSignal.timeout(2_000)),
    ).rejects.toBeInstanceOf(ArgumentMappingError);
    const s = make(server, { name: "list_mail", fixed: { folder: "INBOX" } });
    expect((await s.list!(scope, undefined, 2, AbortSignal.timeout(2_000))).items).toHaveLength(2);
    await s.close();
  });

  test("no list tool, no list: the source is never synced", () => {
    expect(make(mailServer().server).list).toBeUndefined();
  });

  test("through the fan-out, a page is redacted before it is returned, and a failure is a status", async () => {
    const key = "AKIAZ3MSZ7Q2EXAMPLE1";
    const server = new McpServer({ name: "m", version: "1" });
    server.registerTool(
      "search_mail",
      { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({ content: [] }),
    );
    server.registerTool(
      "list_mail",
      { inputSchema: { cursor: z.string().optional() }, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: JSON.stringify([{ id: "k", text: `key ${key}` }]) }] }),
    );
    const s = make(server, { name: "list_mail" });
    const redact = (t: string) => t.replace(key, "[REDACTED]");
    const f = new SourceFanout({ sanitize: (items) => items.map((i) => ({ ...i, text: redact(i.text) })) });
    const page = await f.list(s, scope, undefined, 10, { timeoutMs: 2_000 });
    expect(typeof page).toBe("object");
    if (typeof page === "object") expect(page.items[0]!.text).not.toContain(key);
    const broken = {
      id: "x",
      kind: "t",
      description: "",
      search: async () => [],
      list: async () => Promise.reject(new Error("500")),
    };
    expect(await f.list(broken, scope, undefined, 10, { timeoutMs: 2_000 })).toBe("error");
    await s.close();
  });
});

describe("list mapping and next cursors", () => {
  test("cursor and page-size arguments by name; an integer offset; operator values win", () => {
    expect(mapListArgs({ properties: { cursor: { type: "string" }, limit: { type: "integer" } } })).toEqual({
      cursor: { name: "cursor", kind: "token" },
      limit: "limit",
      missing: [],
      fixed: {},
    });
    expect(mapListArgs({ properties: { skip: { type: "integer" }, per_page: { type: "integer" } } }).cursor).toEqual({
      name: "skip",
      kind: "offset",
    });
    // An offset that is not a number is no cursor: only the first page.
    expect(mapListArgs({ properties: { offset: { type: "string" } } }).cursor).toBeNull();
    const m = mapListArgs({ properties: { folder: { type: "string" } }, required: ["folder"] }, { folder: "INBOX" });
    expect(m.missing).toEqual([]);
    expect(buildListArgs(m, undefined, 50)).toEqual({ folder: "INBOX" });
  });

  test("next cursors where servers put them, and none on a last page", () => {
    expect(nextCursorOf([], { nextCursor: "a" })).toBe("a");
    expect(nextCursorOf([{ type: "text", text: '{"messages":[],"nextPageToken":"b"}' }])).toBe("b");
    expect(nextCursorOf([{ type: "text", text: '{"ok":true,"response_metadata":{"next_cursor":"c"}}' }])).toBe("c");
    expect(nextCursorOf([], { pageInfo: { endCursor: "d", hasNextPage: true } })).toBe("d");
    expect(nextCursorOf([], { pageInfo: { endCursor: "d", hasNextPage: false } })).toBeNull();
    expect(nextCursorOf([], { has_more: false, next_cursor: "e" })).toBeNull();
    expect(nextCursorOf([], { next_cursor: "" })).toBeNull();
    expect(nextCursorOf([{ type: "text", text: "Here are your messages" }])).toBeNull();
    expect(nextCursorOf([], { cursor: "x".repeat(5_000) })).toBeNull(); // too long to be a cursor
  });

  test("hostile results stay linear: deep nesting, huge strings, many keys", () => {
    let deep: unknown = { nextCursor: "z" };
    for (let i = 0; i < 5_000; i++) deep = { meta: deep };
    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i]));
    const huge = `{"x":"${"a".repeat(2_000_000)}","nextCursor":"y"}`;
    const t0 = performance.now();
    expect(nextCursorOf([], deep)).toBeNull(); // only one holder level is read
    expect(nextCursorOf([], wide)).toBeNull();
    expect(nextCursorOf([{ type: "text", text: huge }])).toBe("y");
    expect(nextCursorOf([{ type: "text", text: `{${"[".repeat(100_000)}` }])).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
