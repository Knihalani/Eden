import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpSource, ReadOnlyViolation } from "./mcp-source";

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
});
