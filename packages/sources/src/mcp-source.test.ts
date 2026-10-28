import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArgumentMappingError, McpSource, ReadOnlyViolation } from "./mcp-source";

/** A connector-like MCP server: one read tool, one write tool. */
function connector() {
  const server = new McpServer({ name: "notes", version: "1" });
  const notes = [{ id: "n1", title: "Dana's preferences", text: "Dana prefers morning calls" }];
  server.registerTool(
    "search_notes",
    { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async ({ query }) => ({
      content: [{ type: "text", text: JSON.stringify(notes.filter((n) => n.text.toLowerCase().includes(query))) }],
    }),
  );
  server.registerTool("delete_note", { inputSchema: { id: z.string() } }, async () => ({ content: [] }));
  return server;
}

function source(tool: string, trusted: string[] = []) {
  const server = connector();
  return new McpSource({
    id: "notes",
    description: "the user's notes",
    transport: () => {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      void server.connect(serverSide);
      return client;
    },
    searchTool: { name: tool, args: (q) => ({ query: q.text }) },
    trustedReadTools: trusted,
  });
}

const query = { scope: { tenantId: "t", userId: "u" }, text: "morning", entities: [], limit: 5 };

describe("McpSource", () => {
  test("searches through a read-only tool and maps the result to items", async () => {
    const s = source("search_notes");
    const items = await s.search(query, AbortSignal.timeout(2_000));
    expect(items).toEqual([
      expect.objectContaining({ id: "notes:n1", title: "Dana's preferences", text: "Dana prefers morning calls" }),
    ]);
    await s.close();
  });

  test("refuses a tool the server does not mark read-only, and does not reconnect on every lookup", async () => {
    let connects = 0;
    const server = connector();
    const s = new McpSource({
      id: "notes",
      description: "",
      transport: () => {
        connects++;
        const [client, serverSide] = InMemoryTransport.createLinkedPair();
        void server.connect(serverSide);
        return client;
      },
      searchTool: { name: "delete_note", args: () => ({ id: "x" }) },
    });
    await expect(s.search(query, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(s.search(query, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(connects).toBe(1);
  });

  test("an operator can trust a tool the server did not annotate", async () => {
    const s = source("search_notes", ["search_notes"]);
    expect(await s.search(query, AbortSignal.timeout(2_000))).toHaveLength(1);
    await s.close();
  });

  test("without an args function, the call is built from the tool's schema and the operator's fixed values", async () => {
    const server = new McpServer({ name: "chroma-like", version: "1" });
    let seen: unknown = null;
    server.registerTool(
      "query_documents",
      {
        inputSchema: {
          collection_name: z.string(),
          query_texts: z.array(z.string()),
          n_results: z.number().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        seen = args;
        return {
          content: [{ type: "text", text: JSON.stringify([{ id: "d1", text: "Dana prefers morning calls" }]) }],
        };
      },
    );
    const make = (fixed?: Record<string, unknown>) =>
      new McpSource({
        id: "docs",
        description: "",
        transport: () => {
          const [client, serverSide] = InMemoryTransport.createLinkedPair();
          void server.connect(serverSide);
          return client;
        },
        searchTool: { name: "query_documents", fixed },
      });
    // collection_name is required and nothing says which: refused, not guessed.
    await expect(make().search(query, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ArgumentMappingError);
    const s = make({ collection_name: "notes" });
    expect(await s.search(query, AbortSignal.timeout(2_000))).toHaveLength(1);
    expect(seen).toEqual({ collection_name: "notes", query_texts: ["morning"], n_results: 5 });
    await s.close();
  });
});

describe("McpSource fetch", () => {
  /** A notes server with a read-one tool whose record can change between calls. */
  type Reply = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> };
  function notesServer(readOnly = true, reply?: (id: string) => Reply) {
    const server = new McpServer({ name: "notes", version: "1" });
    const calls: unknown[] = [];
    const notes = new Map([["n1", { id: "n1", title: "Dana's preferences", text: "Dana prefers morning calls" }]]);
    server.registerTool(
      "search_notes",
      { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: JSON.stringify([...notes.values()]) }] }),
    );
    server.registerTool(
      "get_note",
      { inputSchema: { note_id: z.string(), format: z.string().optional() }, annotations: { readOnlyHint: readOnly } },
      async (args) => {
        calls.push(args);
        if (reply) return reply(args.note_id);
        const note = notes.get(args.note_id);
        return note
          ? { content: [{ type: "text", text: JSON.stringify(note) }] }
          : { content: [{ type: "text", text: "not found" }], isError: true };
      },
    );
    return { server, notes, calls };
  }
  const make = (
    server: McpServer,
    fetchTool?: { name: string; args?: (ref: string) => Record<string, unknown> },
    trustedReadTools: string[] = [],
  ) =>
    new McpSource({
      id: "notes",
      description: "the user's notes",
      transport: () => {
        const [client, serverSide] = InMemoryTransport.createLinkedPair();
        void server.connect(serverSide);
        return client;
      },
      searchTool: { name: "search_notes" },
      fetchTool,
      trustedReadTools,
    });
  const scope = { tenantId: "t", userId: "u" };

  test("returns the record's current version under the ref it was asked for, arguments from the schema", async () => {
    const { server, notes, calls } = notesServer();
    const s = make(server, { name: "get_note" });
    const [cached] = await s.search(query, AbortSignal.timeout(2_000));
    notes.set("n1", { id: "n1", title: "Dana's preferences", text: "Dana now prefers afternoon calls" });
    const fresh = await s.fetch(cached!.ref, scope, AbortSignal.timeout(2_000));
    expect(fresh).toEqual(
      expect.objectContaining({ id: cached!.id, ref: "n1", text: "Dana now prefers afternoon calls" }),
    );
    expect(calls).toEqual([{ note_id: "n1" }]);
    await s.close();
  });

  test("a record the server no longer has, an Eden content-hash ref, or no fetch tool: null", async () => {
    const { server, calls } = notesServer();
    const s = make(server, { name: "get_note" });
    expect(await s.fetch("gone", scope, AbortSignal.timeout(2_000))).toBeNull();
    expect(await s.fetch("eden-h-0123456789abcdef", scope, AbortSignal.timeout(2_000))).toBeNull();
    expect(calls).toEqual([{ note_id: "gone" }]); // The hash ref never reached the server.
    await s.close();
    const plain = make(notesServer().server);
    expect(await plain.fetch("n1", scope, AbortSignal.timeout(2_000))).toBeNull();
  });

  test("a fetch tool the server does not mark read-only fails the connect: neither tool is called", async () => {
    const { server, calls } = notesServer(false);
    const s = make(server, { name: "get_note" });
    await expect(s.search(query, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(s.fetch("n1", scope, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(calls).toEqual([]);
  });

  test("a fetch tool whose id argument cannot be found fails the connect", async () => {
    const server = new McpServer({ name: "odd", version: "1" });
    server.registerTool(
      "search_notes",
      { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({ content: [] }),
    );
    server.registerTool(
      "get_note",
      { inputSchema: { a: z.string(), b: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({ content: [] }),
    );
    const s = make(server, { name: "get_note" });
    await expect(s.search(query, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ArgumentMappingError);
  });

  const text = (t: string): Reply => ({ content: [{ type: "text", text: t }] });
  test.each([
    ["prose, with no error flag", () => text("No note found with that id.")],
    ["another record", () => text(JSON.stringify({ id: "n2", title: "Other", text: "Someone else's note" }))],
    ["a row with no id", () => text(JSON.stringify({ title: "Dana's preferences", text: "Dana prefers calls" }))],
  ])("a reply that is not the asked-for record is null, never stored under its ref: %s", async (_, reply) => {
    const s = make(notesServer(true, reply).server, { name: "get_note" });
    expect(await s.fetch("n1", scope, AbortSignal.timeout(2_000))).toBeNull();
    await s.close();
  });

  test("from a list, or from structured content, the row whose own id is the ref", async () => {
    const rows = [
      { id: "n9", title: "Other", text: "Not this one" },
      { id: "n1", title: "Dana's preferences", text: "Dana prefers afternoon calls" },
    ];
    for (const reply of [
      () => text(JSON.stringify(rows)),
      (): Reply => ({ content: [{ type: "text", text: "2 notes" }], structuredContent: { results: rows } }),
    ]) {
      const s = make(notesServer(true, reply).server, { name: "get_note" });
      const got = await s.fetch("n1", scope, AbortSignal.timeout(2_000));
      expect(got).toEqual(expect.objectContaining({ id: "notes:n1", ref: "n1", text: "Dana prefers afternoon calls" }));
      await s.close();
    }
  });

  test("an args function is used as given, and its tool is still checked read-only (or trusted)", async () => {
    const args = (ref: string) => ({ note_id: ref, format: "full" });
    const denied = notesServer(false);
    const s = make(denied.server, { name: "get_note", args });
    await expect(s.fetch("n1", scope, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(denied.calls).toEqual([]);
    const trusted = notesServer(false);
    const t = make(trusted.server, { name: "get_note", args }, ["get_note"]);
    expect(await t.fetch("n1", scope, AbortSignal.timeout(2_000))).toEqual(expect.objectContaining({ ref: "n1" }));
    expect(trusted.calls).toEqual([{ note_id: "n1", format: "full" }]);
    await t.close();
  });

  test("an aborted fetch rejects", async () => {
    const s = make(notesServer().server, { name: "get_note" });
    await s.search(query, AbortSignal.timeout(2_000)); // Connected first, so the abort reaches the call itself.
    const controller = new AbortController();
    controller.abort();
    await expect(s.fetch("n1", scope, controller.signal)).rejects.toThrow();
    await s.close();
  });
});
