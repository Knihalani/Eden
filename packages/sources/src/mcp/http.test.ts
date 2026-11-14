/**
 * Eden's streamable HTTP client transport (D1704) against the official SDK's server transport
 * (`WebStandardStreamableHTTPServerTransport`) under `Bun.serve`: JSON and SSE responses, the session id, the
 * protocol-version header, a server request in the middle of a stream, an expired session, HTTP errors and redirects.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { z } from "zod";
import { McpClient } from "./client";
import { StreamableHttpTransport } from "./http";

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) void s.stop(true);
});

function mail(opts: { pingFirst?: boolean } = {}) {
  const server = new McpServer({ name: "mail", version: "1" });
  server.registerTool(
    "search_mail",
    { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async ({ query }, extra) => {
      // A server request inside the tool call: on an SSE stream, before the response. The client must answer it.
      if (opts.pingFirst) await extra.sendRequest({ method: "ping" }, EmptyResultSchema);
      return { content: [{ type: "text", text: JSON.stringify([{ id: "m1", subject: `Re: ${query}` }]) }] };
    },
  );
  return server;
}

interface Seen {
  method: string;
  session: string | null;
  version: string | null;
  auth: string | null;
  accept: string | null;
}

/** An SDK server over HTTP; `json` picks JSON responses over SSE, `stateless` gives no session id. */
async function serve(opts: { json: boolean; stateless?: boolean; pingFirst?: boolean }) {
  const seen: Seen[] = [];
  const make = async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: opts.stateless ? undefined : () => crypto.randomUUID(),
      enableJsonResponse: opts.json,
    });
    await mail(opts).connect(transport);
    return transport;
  };
  let transport = await make();
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = req.method === "POST" ? ((await req.clone().json()) as { method?: string }) : {};
      seen.push({
        method: body.method ?? "(response)",
        session: req.headers.get("mcp-session-id"),
        version: req.headers.get("mcp-protocol-version"),
        auth: req.headers.get("authorization"),
        accept: req.headers.get("accept"),
      });
      // Stateless: the SDK's pattern is a fresh server and transport per request.
      if (opts.stateless) transport = await make();
      return transport.handleRequest(req);
    },
  });
  servers.push(http);
  return {
    url: new URL(`http://127.0.0.1:${http.port}/mcp`),
    seen,
    /** The server forgets every session (a restart): a new transport, which has never seen the old id. */
    restart: async () => {
      transport = await make();
    },
  };
}

describe("StreamableHttpTransport against the SDK's server transport", () => {
  for (const json of [true, false]) {
    test(`${json ? "JSON" : "SSE"} responses: handshake, session id, version header, tools/list, tools/call`, async () => {
      const s = await serve({ json });
      const client = new McpClient({ name: "eden", version: "0" });
      await client.connect(new StreamableHttpTransport(s.url, { headers: { Authorization: "Bearer t" } }));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search_mail"]);
      const res = await client.callTool({ name: "search_mail", arguments: { query: "budget" } });
      expect(res.content[0]!.text).toContain("Re: budget");
      await client.close();
      const [init, ...rest] = s.seen;
      expect(init).toMatchObject({ method: "initialize", session: null, version: null, auth: "Bearer t" });
      expect(init!.accept).toBe("application/json, text/event-stream");
      const session = rest[0]!.session;
      expect(session).toBeTruthy();
      for (const r of rest) expect(r).toMatchObject({ session, version: "2025-11-25", auth: "Bearer t" });
      expect(rest.map((r) => r.method)).toEqual(["notifications/initialized", "tools/list", "tools/call"]);
    });
  }

  // D1840 changed how replies are read (native line and string searches, views kept, one timer): results of every
  // size, 16 in flight, must equal what the SDK's own client reads from the same server, in both reply modes.
  for (const json of [true, false]) {
    test(`${json ? "JSON" : "SSE"}: 1 KB to 3 MB results, 16 in flight, as the SDK's client reads them`, async () => {
      const server = () => {
        const s = new McpServer({ name: "big", version: "1" });
        s.registerTool(
          "read",
          { inputSchema: { size: z.number(), seed: z.number() }, annotations: { readOnlyHint: true } },
          async ({ size, seed }) => {
            // Escapes, quotes, CRs and multi-byte characters inside the text, at every size.
            const unit = `row ${seed} "quoted" \\ back\r\nslash é ☕ ${"x".repeat(seed % 50)}\n`;
            const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
            return { content: [{ type: "text", text }], structuredContent: { rows: [{ id: `r${seed}`, size }] } };
          },
        );
        return s;
      };
      const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
      const http = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (req) => {
          const sid = req.headers.get("mcp-session-id");
          let t = sid ? sessions.get(sid) : undefined;
          if (!t) {
            t = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              enableJsonResponse: json,
              onsessioninitialized: (id) => void sessions.set(id, t!),
            });
            await server().connect(t);
          }
          return t.handleRequest(req);
        },
      });
      servers.push(http);
      const url = new URL(`http://127.0.0.1:${http.port}/mcp`);
      const ours = new McpClient({ name: "eden", version: "0" });
      await ours.connect(new StreamableHttpTransport(url));
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const sdk = new Client({ name: "sdk", version: "0" });
      await sdk.connect(new StreamableHTTPClientTransport(url));
      // Up to 3 MB of text: escaped, it stays under the 4 MiB cap on one SSE event.
      const sizes = [1_024, 65_536, 1_048_576, 3_000_000];
      const calls = Array.from({ length: 16 }, (_, i) => ({ size: sizes[i % sizes.length]!, seed: i }));
      const got = await Promise.all(calls.map((a) => ours.callTool({ name: "read", arguments: a })));
      for (const [i, a] of calls.entries()) {
        const want = await sdk.callTool({ name: "read", arguments: a });
        expect(got[i]).toEqual(want as never);
        expect(got[i]!.content[0]!.text!.length).toBe(a.size);
      }
      await ours.close();
      await sdk.close();
    }, 30_000);
  }

  test("SSE: a server request before the response is answered, and the response still arrives", async () => {
    const s = await serve({ json: false, pingFirst: true });
    const client = new McpClient({ name: "eden", version: "0" });
    await client.connect(new StreamableHttpTransport(s.url));
    const res = await client.callTool({ name: "search_mail", arguments: { query: "q" } });
    expect(res.content[0]!.text).toContain("Re: q");
    expect(s.seen.map((r) => r.method)).toContain("(response)");
    await client.close();
  });

  test("stateless JSON: no session id is invented", async () => {
    const s = await serve({ json: true, stateless: true });
    const client = new McpClient({ name: "eden", version: "0" });
    await client.connect(new StreamableHttpTransport(s.url));
    await client.listTools();
    await client.close();
    expect(s.seen.every((r) => r.session === null)).toBe(true);
  });

  // Eden's `McpSource`; skipped when this directory is used on its own.
  const MCP_SOURCE = new URL("../mcp-source.ts", import.meta.url);
  test.skipIf(!existsSync(MCP_SOURCE))(
    "an expired session (404) closes the transport, and McpSource connects again with a new initialize",
    async () => {
      const { McpSource } = (await import(MCP_SOURCE.href)) as typeof import("../mcp-source");
      const s = await serve({ json: true });
      const real = s.url;
      let expired = false;
      // The SDK answers an unknown session id with 400 on a fresh transport; a server that lost its sessions says 404.
      const fetchFn = (async (url: URL | string, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        if (expired && h.get("mcp-session-id")) {
          expired = false;
          await s.restart();
          return new Response("session not found", { status: 404 });
        }
        return fetch(url, init);
      }) as typeof fetch;
      const source = new McpSource({
        id: "mail",
        description: "mail",
        transport: () => new StreamableHttpTransport(real, { fetch: fetchFn }),
        searchTool: { name: "search_mail", args: (q) => ({ query: q.text }) },
        quickCloseMs: 0,
      });
      const query = { scope: { tenantId: "t", userId: "u" }, text: "plan", entities: [], limit: 5 };
      expect(await source.search(query, AbortSignal.timeout(2_000))).toHaveLength(1);
      expired = true;
      await expect(source.search(query, AbortSignal.timeout(2_000))).rejects.toThrow(/HTTP 404/);
      await new Promise((r) => setTimeout(r, 10));
      expect(await source.search(query, AbortSignal.timeout(2_000))).toHaveLength(1);
      expect(s.seen.filter((r) => r.method === "initialize")).toHaveLength(2);
      await source.close();
    },
  );
});

describe("StreamableHttpTransport errors and redirects", () => {
  test("an HTTP error rejects with its status in the message (the fan-out reads a 429 from it, D212)", async () => {
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("slow down, token sk-secret", { status: 429, headers: { "retry-after": "30" } }),
    });
    servers.push(http);
    const client = new McpClient({ name: "eden", version: "0" });
    const t = new StreamableHttpTransport(new URL(`http://127.0.0.1:${http.port}/`), {
      headers: { Authorization: "Bearer sk-user" },
    });
    const err = (await client.connect(t).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("Streamable HTTP error: Error POSTing to endpoint (HTTP 429, retry after 30)");
    // Neither the reply's body nor the user's credentials are in the message.
    expect(err.message).not.toContain("sk-");
  });

  test("a redirect is followed within the origin only; credentials never go to another origin", async () => {
    const other: (string | null)[] = [];
    const elsewhere = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => (other.push(req.headers.get("authorization")), new Response("{}")),
    });
    servers.push(elsewhere);
    const s = await serve({ json: true });
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/away") {
          return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${elsewhere.port}/` } });
        }
        if (path === "/here") return new Response(null, { status: 308, headers: { location: "/moved" } });
        return fetch(s.url, { method: req.method, headers: req.headers, body: req.body });
      },
    });
    servers.push(http);
    const base = `http://127.0.0.1:${http.port}`;
    const away = new McpClient({ name: "eden", version: "0" });
    const auth = { headers: { Authorization: "Bearer secret" } };
    await expect(away.connect(new StreamableHttpTransport(new URL(`${base}/away`), auth))).rejects.toThrow(
      /Redirect \(HTTP 307\) to http:\/\/127\.0\.0\.1:\d+\/ not followed/,
    );
    expect(other).toEqual([]);
    const here = new McpClient({ name: "eden", version: "0" });
    await here.connect(new StreamableHttpTransport(new URL(`${base}/here`), auth));
    expect((await here.listTools()).tools).toHaveLength(1);
    await here.close();
  });

  test("an answer of another content type is an error", async () => {
    const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html>") });
    servers.push(http);
    const client = new McpClient({ name: "eden", version: "0" });
    await expect(
      client.connect(new StreamableHttpTransport(new URL(`http://127.0.0.1:${http.port}/`))),
    ).rejects.toThrow("Unexpected content type: text/plain");
  });

  test("an event stream that ends before the response rejects the request", async () => {
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(': comment\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    servers.push(http);
    const client = new McpClient({ name: "eden", version: "0" });
    await expect(
      client.connect(new StreamableHttpTransport(new URL(`http://127.0.0.1:${http.port}/`))),
    ).rejects.toThrow("Event stream ended before the response");
  });

  test("an event split across chunks and lines ending in CRLF still parse", async () => {
    const result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } };
    const event = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 0, result })}\r\n\r\n`;
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const body = (await req.json()) as { method: string };
        if (body.method !== "initialize") return new Response(null, { status: 202 });
        const parts = [
          event.slice(0, 7),
          event.slice(7, event.indexOf("\r\n") + 1),
          event.slice(event.indexOf("\r\n") + 1),
        ];
        const stream = new ReadableStream({
          async start(c) {
            for (const p of parts) {
              c.enqueue(new TextEncoder().encode(p));
              await new Promise((r) => setTimeout(r, 5));
            }
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(http);
    const client = new McpClient({ name: "eden", version: "0" });
    let version = "";
    const t = new StreamableHttpTransport(new URL(`http://127.0.0.1:${http.port}/`));
    const set = t.setProtocolVersion.bind(t);
    t.setProtocolVersion = (v) => ((version = v), set(v));
    await client.connect(t);
    expect(version).toBe("2025-06-18");
    await client.close();
  });
});
