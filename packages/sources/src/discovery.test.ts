/**
 * Connector universality (A4): a spec with no `searchTool` discovers its tools at connect, whatever
 * the server calls them; arbitrary result shapes normalize into items end-to-end. Four fake
 * connectors cover the shapes real servers take: a token-paged listing, a nested envelope, blob
 * rows with no ids, and a rate-limited tool that errors part way.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpSource } from "./mcp-source";

const link = (server: McpServer) => () => {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  void server.connect(serverSide);
  return client;
};

const discovered = (id: string, server: McpServer) => new McpSource({ id, description: "", transport: link(server) });

const query = { scope: { tenantId: "t", userId: "u" }, text: "morning", entities: [], limit: 5 };

const alice = { tenantId: "t", userId: "u" };

describe("tool discovery (A4)", () => {
  test("a token-paged listing with no search tool syncs every page; live search degrades to []", async () => {
    const server = new McpServer({ name: "files", version: "1" });
    server.registerTool(
      "enumerate_documents",
      {
        inputSchema: { pageToken: z.string().optional(), per_page: z.number().optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ pageToken }) => {
        const page = pageToken === "p2" ? 2 : 1;
        const rows =
          page === 1
            ? [{ doc_id: "d1", heading: "Plan", body: "morning standup notes" }]
            : [{ doc_id: "d2", heading: "Retro", body: "afternoon retro" }];
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ response_metadata: { next_cursor: page === 1 ? "p2" : null }, hits: rows }),
            },
          ],
        };
      },
    );
    const s = discovered("files", server);
    expect(await s.search(query, AbortSignal.timeout(2_000))).toEqual([]);
    const p1 = await s.list!(alice, undefined, 10, AbortSignal.timeout(2_000));
    expect(p1.items.map((i) => i.ref)).toEqual(["d1"]);
    const p2 = await s.list!(alice, p1.next ?? undefined, 10, AbortSignal.timeout(2_000));
    expect(p2.items.map((i) => [i.ref, i.text])).toEqual([["d2", "afternoon retro"]]);
    expect(p2.next).toBeNull();
    await s.close();
  });

  test("a nested envelope's rows are found under result/data/messages", async () => {
    const server = new McpServer({ name: "mail", version: "1" });
    server.registerTool(
      "lookup_messages",
      { inputSchema: { search_query: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result: { data: { messages: [{ message_id: "m9", subject: "Standup", body: "morning notes here" }] } },
            }),
          },
        ],
      }),
    );
    const s = discovered("mail", server);
    const items = await s.search(query, AbortSignal.timeout(2_000));
    expect(items).toEqual([expect.objectContaining({ ref: "m9", title: "Standup" })]);
    await s.close();
  });

  test("blob rows with no id take a content-hash ref, and a fetch tool by another name is wired", async () => {
    const server = new McpServer({ name: "blobs", version: "1" });
    server.registerTool(
      "retrieve",
      { inputSchema: { keywords: z.string() }, annotations: { readOnlyHint: true } },
      async () => ({
        content: [{ type: "text", text: JSON.stringify([{ heading: "blob one", payload: "morning blob" }]) }],
      }),
    );
    server.registerTool(
      "get_blob",
      { inputSchema: { blob_id: z.string() }, annotations: { readOnlyHint: true } },
      async ({ blob_id }) => ({
        content: [{ type: "text", text: JSON.stringify({ blob_id, payload: `content of ${blob_id}` }) }],
      }),
    );
    const s = discovered("blobs", server);
    const items = await s.search(query, AbortSignal.timeout(2_000));
    expect(items).toHaveLength(1);
    expect(items[0]!.ref.startsWith("eden-h-")).toBe(true);
    // The same row searched again makes the same ref: different lookups dedupe to one item.
    expect((await s.search(query, AbortSignal.timeout(2_000)))[0]!.id).toBe(items[0]!.id);
    // get_blob's `blob_id` maps as the fetch ref even without a configured fetchTool.
    expect(s.fetchesById).toBe(true);
    await s.close();
  });

  test("a rate-limited connector's error result is an empty answer, not a thrown lookup", async () => {
    const server = new McpServer({ name: "limited", version: "1" });
    let calls = 0;
    server.registerTool(
      "search_all",
      { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
      async () => {
        calls++;
        if (calls === 1) return { isError: true, content: [{ type: "text", text: "rate limited" }] };
        return { content: [{ type: "text", text: JSON.stringify([{ id: "ok1", text: "morning quota" }]) }] };
      },
    );
    const s = discovered("limited", server);
    expect(await s.search(query, AbortSignal.timeout(2_000))).toEqual([]);
    expect(await s.search(query, AbortSignal.timeout(2_000))).toHaveLength(1);
    await s.close();
  });

  test("a server with no mappable read connects cleanly: search [], list a failed sync", async () => {
    const server = new McpServer({ name: "write-only", version: "1" });
    server.registerTool("create_thing", { inputSchema: { name: z.string() } }, async () => ({ content: [] }));
    const s = discovered("wo", server);
    expect(await s.search(query, AbortSignal.timeout(2_000))).toEqual([]);
    if (s.list)
      await expect(s.list(alice, undefined, 5, AbortSignal.timeout(2_000))).rejects.toThrow(/no list-mappable/);
    await s.close();
  });
});
