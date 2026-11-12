/**
 * Eden's hand-written `ask_context` server (D1704) against the official SDK's `Client`, the reference implementation,
 * and its JSON-RPC handling message by message.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContextPartner } from "@eden/engine";
import { ASK_CONTEXT_DESCRIPTION } from "@eden/protocol";
import { buildPartner } from "./build";
import { createMcpServer } from "./mcp";

async function connect(edit: (p: ContextPartner) => void = () => {}) {
  const partner = buildPartner({ sources: async () => [], model: null });
  edit(partner);
  const server = createMcpServer(partner, { tenantId: "t", userId: "u", sessionId: "s" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(clientSide);
  return client;
}

describe("the hand-written server against the SDK's Client", () => {
  test("initialize negotiates the newest version, names the server, and offers tools; ping answers", async () => {
    const client = await connect();
    expect(client.getServerVersion()).toEqual({ name: "eden-context", version: "0.0.0" });
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect(await client.ping()).toEqual({});
    await client.close();
  });

  test("tools/list gives a literal JSON Schema the SDK accepts, read-only", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      {
        name: "ask_context",
        description: ASK_CONTEXT_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: { question: { type: "string", minLength: 1, maxLength: 2_000 } },
          required: ["question"],
        },
        annotations: { readOnlyHint: true },
      },
    ]);
    await client.close();
  });

  test.each([
    ["missing", {}, "question must be a string"],
    ["not a string", { question: 42 }, "question must be a string"],
    ["empty", { question: "" }, "question must be 1 to 2000 characters, not 0"],
    ["too long", { question: "q".repeat(2_001) }, "question must be 1 to 2000 characters, not 2001"],
  ])("invalid arguments (%s) are a tool error naming why, and ask nothing", async (_name, args, why) => {
    let asks = 0;
    const client = await connect((p) => {
      const ask = p.ask.bind(p);
      p.ask = (req) => (asks++, ask(req));
    });
    const res = await client.callTool({ name: "ask_context", arguments: args });
    expect(res).toEqual({
      content: [
        {
          type: "text",
          text: `MCP error -32602: Input validation error: Invalid arguments for tool ask_context: ${why}`,
        },
      ],
      isError: true,
    });
    expect(asks).toBe(0);
    await client.close();
  });

  test("an unknown tool and a failed ask are tool errors; extra arguments are ignored", async () => {
    const client = await connect((p) => {
      p.ask = async () => {
        throw new Error("no task is running");
      };
    });
    expect(await client.callTool({ name: "delete_everything", arguments: {} })).toEqual({
      content: [{ type: "text", text: "MCP error -32602: Tool delete_everything not found" }],
      isError: true,
    });
    expect(await client.callTool({ name: "ask_context", arguments: { question: "q", extra: 1 } })).toEqual({
      content: [{ type: "text", text: "no task is running" }],
      isError: true,
    });
    await client.close();
  });
});

describe("the server's JSON-RPC handling", () => {
  const handle = (m: unknown) => {
    const partner = buildPartner({ sources: async () => [], model: null });
    return createMcpServer(partner, { tenantId: "t", userId: "u", sessionId: "s" }).handle(m);
  };

  test("initialize answers the client's version when supported, else the newest", async () => {
    const init = (v: string) => handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } });
    expect(await init("2025-03-26")).toMatchObject({ result: { protocolVersion: "2025-03-26" } });
    expect(await init("2099-01-01")).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
  });

  test("other methods, malformed messages and missing params are errors; notifications get no answer", async () => {
    expect(await handle({ jsonrpc: "2.0", id: 2, method: "resources/list" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "Method not found" },
    });
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "tools/call" })).toMatchObject({ error: { code: -32602 } });
    expect(await handle({ id: 4, method: "ping" })).toMatchObject({ id: 4, error: { code: -32600 } });
    expect(await handle({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" })).toMatchObject({ id: null });
    expect(await handle([{ jsonrpc: "2.0", id: 5, method: "ping" }])).toMatchObject({ error: { code: -32600 } });
    expect(await handle(null)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull();
    expect(await handle({ jsonrpc: "2.0", id: 6, result: {} })).toBeNull();
  });
});
