/**
 * Eden's MCP client (D1704) against the official SDK's servers, the reference implementation, over the SDK's
 * in-memory transport: the handshake, paged `tools/list`, `tools/call` and its error shapes, timeouts, cancellation
 * and a dropped connection.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpClient } from "./client";
import { ErrorCode, McpError, type JsonRpcMessage, type Transport } from "./types";

function notes() {
  const server = new McpServer({ name: "notes", version: "1" });
  server.registerTool(
    "search",
    { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async ({ query }) => ({
      content: [{ type: "text", text: `found ${query}` }],
      structuredContent: { results: [{ id: "n1", text: query }] },
    }),
  );
  server.registerTool("broken", { inputSchema: {} }, async () => {
    throw new Error("backend down");
  });
  return server;
}

async function connected(server: { connect(t: InMemoryTransport): Promise<void> }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new McpClient({ name: "eden-test", version: "0" });
  await client.connect(clientSide);
  return { client, clientSide, serverSide };
}

describe("McpClient's general surface (D1860)", () => {
  test("server info, any request, notifications to onnotification (a throwing handler fails nothing)", async () => {
    const server = new McpServer(
      { name: "notes", version: "2" },
      { instructions: "be brief", capabilities: { logging: {} } },
    );
    server.registerTool("log", { inputSchema: {} }, async (_args, extra) => {
      await extra.sendNotification({ method: "notifications/message", params: { level: "info", data: "working" } });
      return { content: [{ type: "text", text: "done" }] };
    });
    const { client } = await connected(server);
    expect(client.server).toMatchObject({ serverInfo: { name: "notes", version: "2" }, instructions: "be brief" });
    expect(client.server?.capabilities).toHaveProperty("tools");
    const seen: string[] = [];
    client.onnotification = (n) => {
      seen.push(`${n.method} ${JSON.stringify(n.params?.data)}`);
      throw new Error("a caller's bug");
    };
    expect((await client.callTool({ name: "log", arguments: {} })).content).toEqual([{ type: "text", text: "done" }]);
    expect(seen).toEqual(['notifications/message "working"']);
    // An async handler that rejects: no unhandled rejection (Bun exits 1 on one), and the call still answers.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      client.onnotification = async (n) => {
        seen.push(n.method);
        throw new Error("an async caller's bug");
      };
      expect((await client.callTool({ name: "log", arguments: {} })).content).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toHaveLength(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(await client.request("ping")).toEqual({});
    await expect(client.request("no/such")).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    await client.notify("notifications/roots/list_changed");
    await client.close();
  });
});

describe("McpClient against the SDK's McpServer (in memory)", () => {
  test("initialize, tools/list with annotations and schema, tools/call with structured content", async () => {
    const server = notes();
    const { client } = await connected(server);
    expect(server.server.getClientVersion()).toEqual({ name: "eden-test", version: "0" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "broken"]);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(tools[0]!.inputSchema.properties).toHaveProperty("query");
    const res = await client.callTool({ name: "search", arguments: { query: "dana" } });
    expect(res.content).toEqual([{ type: "text", text: "found dana" }]);
    expect(res.structuredContent).toEqual({ results: [{ id: "n1", text: "dana" }] });
    expect(res.isError).toBeUndefined();
    await client.close();
  });

  test("a tool that throws is a result with isError, not a rejection; bad arguments too", async () => {
    const { client } = await connected(notes());
    const broken = await client.callTool({ name: "broken", arguments: {} });
    expect(broken.isError).toBe(true);
    expect(broken.content[0]!.text).toContain("backend down");
    const bad = await client.callTool({ name: "search", arguments: { query: 3 } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  test("a JSON-RPC error rejects with McpError, code and message as the SDK gives them", async () => {
    const server = new Server({ name: "s", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      throw new McpError(-32029, "rate limit exceeded, retry after 3");
    });
    const { client } = await connected(server);
    const err = await client.callTool({ name: "x", arguments: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(-32029);
    // The SDK's server sends its error's whole message, prefix included; its client prefixes it again, as ours does.
    expect((err as McpError).message).toBe("MCP error -32029: MCP error -32029: rate limit exceeded, retry after 3");
    await client.close();
  });

  test("tools/list pages are read with the server's cursor", async () => {
    const server = new Server({ name: "paged", version: "1" }, { capabilities: { tools: {} } });
    const cursors: (string | undefined)[] = [];
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      cursors.push(req.params?.cursor);
      const page = req.params?.cursor ? 2 : 1;
      return {
        tools: [{ name: `t${page}`, inputSchema: { type: "object" as const } }],
        ...(page === 1 ? { nextCursor: "p2" } : {}),
      };
    });
    const { client } = await connected(server);
    const first = await client.listTools();
    expect(first).toEqual({ tools: [{ name: "t1", inputSchema: { type: "object" } }], nextCursor: "p2" });
    const second = await client.listTools({ cursor: "p2" });
    expect(second.nextCursor).toBeUndefined();
    expect(cursors).toEqual([undefined, "p2"]);
    await client.close();
  });

  test("a request past its timeout rejects with RequestTimeout and tells the server it was cancelled", async () => {
    const server = new Server({ name: "slow", version: "1" }, { capabilities: { tools: {} } });
    let cancelled: AbortSignal | undefined;
    server.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
      cancelled = extra.signal;
      await new Promise((r) => setTimeout(r, 1_000));
      return { content: [] };
    });
    const { client } = await connected(server);
    const err = await client.callTool({ name: "x" }, { timeoutMs: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.RequestTimeout);
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled?.aborted).toBe(true);
    await client.close();
  });

  test("an aborted signal rejects the call at once and cancels it on the server", async () => {
    const server = new Server({ name: "slow", version: "1" }, { capabilities: { tools: {} } });
    let cancelled: AbortSignal | undefined;
    server.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
      cancelled = extra.signal;
      await new Promise((r) => setTimeout(r, 1_000));
      return { content: [] };
    });
    const { client } = await connected(server);
    const ac = new AbortController();
    const call = client.callTool({ name: "x" }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort(new Error("deadline"));
    await expect(call).rejects.toThrow(/deadline/);
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled?.aborted).toBe(true);
    // An already aborted signal sends nothing and rejects with its reason.
    await expect(client.callTool({ name: "x" }, { signal: AbortSignal.abort(new Error("late")) })).rejects.toThrow(
      "late",
    );
    await client.close();
  });

  test("a closed connection rejects the requests in flight and calls onclose once", async () => {
    const server = new Server({ name: "slow", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {}));
    const { client, serverSide } = await connected(server);
    let closes = 0;
    client.onclose = () => closes++;
    const call = client.callTool({ name: "x" });
    await new Promise((r) => setTimeout(r, 10));
    await serverSide.close();
    const err = await call.catch((e: unknown) => e);
    expect((err as McpError).code).toBe(ErrorCode.ConnectionClosed);
    expect(closes).toBe(1);
    await expect(client.listTools()).rejects.toThrow("Not connected");
  });

  test("the server's ping is answered; its other requests are dropped unanswered", async () => {
    const server = notes();
    await connected(server);
    expect(await server.server.ping()).toEqual({});
    await expect(server.server.listRoots(undefined, { timeout: 50 })).rejects.toThrow(/Request timed out/);
  });
});

/** A server that answers `initialize` with the given version and records what the client sends. */
function fakeServer(version: string): { transport: Transport; sent: JsonRpcMessage[]; closed: () => boolean } {
  const sent: JsonRpcMessage[] = [];
  let closed = false;
  const transport: Transport = {
    start: async () => {},
    send: async (m) => {
      sent.push(m);
      if ("method" in m && m.method === "initialize" && "id" in m) {
        const reply = { protocolVersion: version, capabilities: {}, serverInfo: { name: "f", version: "1" } };
        queueMicrotask(() => transport.onmessage?.({ jsonrpc: "2.0", id: m.id, result: reply }));
      }
    },
    close: async () => {
      closed = true;
      transport.onclose?.();
    },
  };
  return { transport, sent, closed: () => closed };
}

describe("McpClient version negotiation", () => {
  test("an older supported version is accepted and handed to the transport", async () => {
    const f = fakeServer("2025-03-26");
    let told = "";
    f.transport.setProtocolVersion = (v) => (told = v);
    const client = new McpClient({ name: "c", version: "0" });
    await client.connect(f.transport);
    expect(told).toBe("2025-03-26");
    expect(f.sent.map((m) => ("method" in m ? m.method : "?"))).toEqual(["initialize", "notifications/initialized"]);
    const init = f.sent[0] as unknown as { params: { protocolVersion: string; capabilities: unknown } };
    expect(init.params.protocolVersion).toBe("2025-11-25");
  });

  test("an unsupported version fails the connect and closes the transport", async () => {
    const f = fakeServer("1999-01-01");
    const client = new McpClient({ name: "c", version: "0" });
    await expect(client.connect(f.transport)).rejects.toThrow("Server's protocol version is not supported: 1999-01-01");
    await new Promise((r) => setTimeout(r, 0));
    expect(f.closed()).toBe(true);
  });
});
