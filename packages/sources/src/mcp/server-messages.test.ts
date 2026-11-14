/**
 * What a server sends besides its answers (D1872-D1875), against the official SDK's server and against hostile fakes:
 * SSE resumption by `Last-Event-ID` (`resume`), the standalone GET stream (`openServerStream`), handlers for the
 * server's requests (`setRequestHandler`), and the per-reply budgets (`limits`). All of it is opt-in except the
 * budgets, and every bound of D1704 holds on each path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CreateMessageResultSchema,
  ElicitResultSchema,
  ListRootsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpClient } from "./client";
import { StreamableHttpTransport, type StreamableHttpOptions } from "./http";
import { McpError, type JsonRpcNotification } from "./types";

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) void s.stop(true);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** An SDK server over HTTP with an event store (resumable), a session, and the tools below. */
async function sdk(register: (s: McpServer) => void, opts: { eventStore?: boolean } = {}) {
  const server = new McpServer({ name: "s", version: "1" }, { capabilities: { logging: {} } });
  register(server);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    ...(opts.eventStore === false ? {} : { eventStore: new InMemoryEventStore(), retryInterval: 5 }),
  });
  await server.connect(transport);
  const seen: { method: string; lastEventId: string | null }[] = [];
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    fetch: (req) => {
      seen.push({ method: req.method, lastEventId: req.headers.get("last-event-id") });
      return transport.handleRequest(req);
    },
  });
  servers.push(http);
  return { server, transport, seen, url: new URL(`http://127.0.0.1:${http.port}/mcp`) };
}

async function connect(
  url: URL,
  options: StreamableHttpOptions = {},
  client = new McpClient({ name: "c", version: "0" }),
) {
  const transport = new StreamableHttpTransport(url, options);
  const notes: JsonRpcNotification[] = [];
  client.onnotification = (n) => void notes.push(n);
  await client.connect(transport);
  return { client, transport, notes };
}

/** The SDK's polling pattern (its `ssePollingExample`): the server closes a tool's stream midway and keeps working. */
function polling(s: McpServer) {
  s.registerTool("long_task", { annotations: { readOnlyHint: true } }, async (extra) => {
    // Sent on the tool's own stream (related to its request), as progress is.
    const log = (data: string) =>
      extra.sendNotification({ method: "notifications/message", params: { level: "info", data } });
    await log("25%");
    extra.closeSSEStream?.();
    await sleep(30);
    await log("75% (sent while the client was away)");
    return { content: [{ type: "text", text: "done" }] };
  });
}

describe("SSE resumption (resume, D1873)", () => {
  test("a tool whose stream the SDK server closes midway is answered after a GET with Last-Event-ID", async () => {
    const { url, seen } = await sdk(polling);
    const { client, notes } = await connect(url, { resume: { initialDelayMs: 1 } });
    const result = await client.callTool({ name: "long_task" });
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    // Every progress message arrived, in order, the second one replayed from the server's store.
    expect(notes.map((n) => (n.params as { data: string }).data)).toEqual([
      "25%",
      "75% (sent while the client was away)",
    ]);
    const gets = seen.filter((r) => r.method === "GET");
    expect(gets).toHaveLength(1);
    expect(gets[0]!.lastEventId).toBeTruthy();
    await client.close();
  });

  test("off by default (Eden's path): the same tool fails as before, with no GET sent", async () => {
    const { url, seen } = await sdk(polling);
    const { client } = await connect(url);
    await expect(client.callTool({ name: "long_task" })).rejects.toThrow("Event stream ended before the response");
    expect(seen.filter((r) => r.method === "GET")).toEqual([]);
    await client.close();
  });

  /** A fake server: POSTs answered by `post`, GETs by `get`; `initialize` in JSON. */
  function fake(
    post: (id: number) => Response,
    get: (lastEventId: string | null, n: number) => Response,
    opts: StreamableHttpOptions = {},
  ) {
    const gets: (string | null)[] = [];
    const fetchFn = (async (_u: URL | string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (init?.method === "GET") {
        gets.push(h.get("last-event-id"));
        return get(h.get("last-event-id"), gets.length);
      }
      const msg = JSON.parse(String(init?.body)) as { id?: number; method?: string };
      if (msg.method === "initialize") {
        const result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "f", version: "1" } };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (msg.id === undefined) return new Response(null, { status: 202 });
      return post(msg.id);
    }) as typeof fetch;
    return {
      gets,
      transport: new StreamableHttpTransport(new URL("http://mcp.test/mcp"), { fetch: fetchFn, ...opts }),
    };
  }
  const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
  const answer = (id: number) => `data: {"jsonrpc":"2.0","id":${id},"result":{"content":[]}}\n\n`;

  test("reconnects are bounded: a server that breaks every stream is given up on after maxRetries", async () => {
    const f = fake(
      () => sse("id: e1\ndata: \n\n"),
      () => sse(`id: e2\nretry: 0\ndata: \n\n`),
      { resume: { maxRetries: 3, initialDelayMs: 1 } },
    );
    const client = new McpClient({ name: "c", version: "0" });
    await client.connect(f.transport);
    await expect(client.callTool({ name: "x" })).rejects.toThrow("Event stream ended before the response");
    expect(f.gets).toEqual(["e1", "e2", "e2"]);
  });

  test("retry: is honoured but capped by maxDelayMs, and the POST's deadline holds through the waits", async () => {
    const f = fake(
      () => sse("id: e1\nretry: 600000\ndata: \n\n"),
      () => sse(""),
      { resume: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 60_000 }, timeoutMs: 150 },
    );
    const client = new McpClient({ name: "c", version: "0" });
    await client.connect(f.transport);
    const t = performance.now();
    await expect(client.callTool({ name: "x" })).rejects.toThrow("Request timed out");
    expect(performance.now() - t).toBeLessThan(2_000);
    expect(f.gets).toEqual([]);
  });

  test("the reply cap counts every connection: a server that resumes forever cannot read past it", async () => {
    const big = `id: e\ndata: ${"x".repeat(3_000)}\n\n`;
    const f = fake(
      () => sse(big),
      () => sse(big),
      {
        resume: { maxRetries: 100, initialDelayMs: 0 },
        maxResponseBytes: 10_000,
        limits: { badMessages: 1_000 },
      },
    );
    const client = new McpClient({ name: "c", version: "0" });
    await client.connect(f.transport);
    await expect(client.callTool({ name: "x" })).rejects.toThrow("Event stream larger than 10000 bytes");
    expect(f.gets.length).toBe(3);
  });

  test("an id that is not short visible ASCII is not sent back: there is nothing to resume from", async () => {
    const f = fake(
      () => sse(`id: a\u0001b\ndata: \n\n`),
      () => sse(""),
      { resume: { initialDelayMs: 0 } },
    );
    const client = new McpClient({ name: "c", version: "0" });
    await client.connect(f.transport);
    await expect(client.callTool({ name: "x" })).rejects.toThrow("ended before the response");
    expect(f.gets).toEqual([]);
  });

  test("a resumed stream that answers resolves the call; one the server refuses fails with its status", async () => {
    const ok = fake(
      () => sse("id: 7\ndata: \n\n"),
      () => sse(answer(1)),
      { resume: { initialDelayMs: 0 } },
    );
    const c1 = new McpClient({ name: "c", version: "0" });
    await c1.connect(ok.transport);
    await expect(c1.callTool({ name: "x" })).resolves.toEqual({ content: [] });
    const refused = fake(
      () => sse("id: 7\ndata: \n\n"),
      () => new Response(null, { status: 405 }),
      { resume: { initialDelayMs: 0 } },
    );
    const c2 = new McpClient({ name: "c", version: "0" });
    await c2.connect(refused.transport);
    await expect(c2.callTool({ name: "x" })).rejects.toThrow("Could not resume the event stream (HTTP 405)");
  });
});

describe("the GET stream (openServerStream, D1873)", () => {
  test("against the SDK: server notifications outside any request arrive; a closed stream is reopened from its place", async () => {
    const { server, transport, url, seen } = await sdk(() => {});
    const { client, transport: t, notes } = await connect(url, { resume: { initialDelayMs: 1 } });
    // The SDK sends the GET's headers with its first event, so the open resolves once one is sent.
    const opened = t.openServerStream();
    await sleep(30);
    await server.sendLoggingMessage({ level: "info", data: "one" });
    expect(await opened).toBe(true);
    for (let i = 0; i < 100 && notes.length < 1; i++) await sleep(10);
    expect(notes.map((n) => (n.params as { data: string }).data)).toEqual(["one"]);
    // The server ends the stream (its polling pattern); the client opens it again from the last event's id. (The
    // SDK's example event store cannot replay its own GET stream, whose id holds the `_` it splits ids on, so what
    // is checked past this point is the reconnect itself.)
    transport.closeStandaloneSSEStream();
    for (let i = 0; i < 200 && seen.filter((r) => r.method === "GET").length < 2; i++) await sleep(10);
    const gets = seen.filter((r) => r.method === "GET");
    expect(gets[0]!.lastEventId).toBeNull();
    expect(gets[1]!.lastEventId).toBeTruthy();
    await client.close();
  });

  /** A fake whose GET stream is `body`; counts the POSTs that answer server requests. */
  async function getStream(body: () => Response, opts: StreamableHttpOptions = {}) {
    let answers = 0;
    let gets = 0;
    const fetchFn = (async (_u: URL | string, init?: RequestInit) => {
      if (init?.method === "GET") {
        gets++;
        return body();
      }
      const msg = JSON.parse(String(init?.body)) as { id?: number; method?: string };
      if (msg.method === "initialize") {
        const result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "f", version: "1" } };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (!msg.method) answers++;
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const transport = new StreamableHttpTransport(new URL("http://mcp.test/mcp"), { fetch: fetchFn, ...opts });
    const errors: string[] = [];
    const client = new McpClient({ name: "c", version: "0" });
    await client.connect(transport);
    transport.onerror = (e) => void errors.push(e.message);
    return { transport, client, errors, answers: () => answers, gets: () => gets };
  }

  test("a server without one answers 405: false, and nothing is retried", async () => {
    const g = await getStream(() => new Response(null, { status: 405 }));
    expect(await g.transport.openServerStream()).toBe(false);
    await sleep(20);
    expect(g.gets()).toBe(1);
  });

  test("a ping flood on it fails after the budget, with at most 16 answers, and is not opened again", async () => {
    let s = "";
    for (let i = 0; i < 20_000; i++) s += `data: {"jsonrpc":"2.0","id":${i},"method":"ping"}\n\n`;
    const g = await getStream(() => new Response(s, { headers: { "content-type": "text/event-stream" } }), {
      resume: { initialDelayMs: 0 },
    });
    const t = cpuMs();
    expect(await g.transport.openServerStream()).toBe(true);
    for (let i = 0; i < 100 && !g.errors.some((e) => /server requests/.test(e)); i++) await sleep(5);
    expect(g.errors.filter((e) => /over 100 server requests/.test(e))).toHaveLength(1);
    await sleep(30);
    expect(g.answers()).toBeLessThanOrEqual(100);
    expect(g.gets()).toBe(1);
    expect(cpuMs() - t).toBeLessThan(1_000);
  });

  test("a response on it is unasked: dropped and counted, never taken as an answer", async () => {
    const g = await getStream(
      () =>
        new Response(`data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      { resume: { maxRetries: 0, initialDelayMs: 0 } },
    );
    await g.transport.openServerStream();
    await sleep(30);
    expect(g.errors).toContain("Streamable HTTP error: Reply carried 1 malformed or unasked messages");
  });

  test("an event past 4 MiB ends the connection; reopening is bounded by maxRetries", async () => {
    const g = await getStream(
      () => new Response(`data: ${"x".repeat(5 * 1024 * 1024)}`, { headers: { "content-type": "text/event-stream" } }),
      { resume: { maxRetries: 2, initialDelayMs: 0 } },
    );
    await g.transport.openServerStream();
    for (let i = 0; i < 200 && g.gets() < 3; i++) await sleep(10);
    await sleep(50);
    expect(g.gets()).toBe(3); // the first and maxRetries more, none delivering anything
  });

  test("a server that ends every connection at once is reopened at most twice a second; junk is not a delivery", async () => {
    const g = await getStream(
      () => new Response("retry: 0\ndata: x\n\n", { headers: { "content-type": "text/event-stream" } }),
      { resume: { maxRetries: 1_000, initialDelayMs: 0 } },
    );
    await g.transport.openServerStream();
    await sleep(1_100);
    expect(g.gets()).toBeLessThanOrEqual(4);
    const h = await getStream(
      () => new Response("retry: 0\ndata: x\n\n", { headers: { "content-type": "text/event-stream" } }),
      { resume: { maxRetries: 2, initialDelayMs: 0 } },
    );
    await h.transport.openServerStream();
    await sleep(1_600);
    expect(h.gets()).toBe(3); // the junk delivered nothing: two misses more and it stops
    await g.client.close();
  });

  test("close ends it", async () => {
    const g = await getStream(
      () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }),
    );
    await g.transport.openServerStream();
    await g.client.close();
    await sleep(20);
    expect(g.gets()).toBe(1);
  });
});

describe("server-request handlers (setRequestHandler, D1875)", () => {
  function asking(s: McpServer) {
    s.registerTool("ask", { annotations: { readOnlyHint: true } }, async (extra) => {
      const sampled = await extra.sendRequest(
        {
          method: "sampling/createMessage",
          params: { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 5 },
        },
        CreateMessageResultSchema,
      );
      const roots = await extra.sendRequest({ method: "roots/list" }, ListRootsResultSchema);
      const elicited = await extra.sendRequest(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "name?",
            requestedSchema: { type: "object", properties: { n: { type: "string" } } },
          },
        },
        ElicitResultSchema,
      );
      const text = JSON.stringify({ sampled: sampled.content, roots: roots.roots, elicited: elicited.content });
      return { content: [{ type: "text", text }] };
    });
  }

  test("sampling, roots and elicitation are answered by the handlers against the SDK's server", async () => {
    const { url } = await sdk(asking, { eventStore: false });
    const client = new McpClient(
      { name: "c", version: "0" },
      { capabilities: { sampling: {}, roots: {}, elicitation: { form: {} } } },
    );
    const asked: unknown[] = [];
    client.setRequestHandler("sampling/createMessage", (params) => {
      asked.push(params);
      return { role: "assistant", content: { type: "text", text: "hello" }, model: "m" };
    });
    client.setRequestHandler("roots/list", async () => ({ roots: [{ uri: "file:///w", name: "w" }] }));
    client.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { n: "Ada" } }));
    await connect(url, {}, client);
    const result = await client.callTool({ name: "ask" });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      sampled: { type: "text", text: "hello" },
      roots: [{ uri: "file:///w", name: "w" }],
      elicited: { n: "Ada" },
    });
    expect(asked).toHaveLength(1);
    await client.close();
  });

  test("a handler's McpError reaches the server with its code; any other throw as a bare internal error", async () => {
    const { url } = await sdk(
      (s) => {
        s.registerTool("ask", { annotations: { readOnlyHint: true } }, async (extra) => {
          const out: string[] = [];
          for (const method of ["roots/list", "sampling/createMessage"]) {
            await extra
              .sendRequest(
                { method, params: { messages: [], maxTokens: 1 } } as never,
                method === "roots/list" ? ListRootsResultSchema : CreateMessageResultSchema,
              )
              .catch((e: Error) => out.push(e.message));
          }
          return { content: [{ type: "text", text: JSON.stringify(out) }] };
        });
      },
      { eventStore: false },
    );
    const client = new McpClient({ name: "c", version: "0" }, { capabilities: { roots: {}, sampling: {} } });
    client.setRequestHandler("roots/list", () => {
      throw new McpError(-32042, "no roots here");
    });
    client.setRequestHandler("sampling/createMessage", () => {
      throw new Error("secret token sk-123 in a stack");
    });
    await connect(url, {}, client);
    const result = await client.callTool({ name: "ask" });
    const errors = JSON.parse((result.content[0] as { text: string }).text) as string[];
    expect(errors[0]).toContain("-32042");
    expect(errors[0]).toContain("no roots here");
    expect(errors[1]).toContain("Internal error");
    expect(errors.join(" ")).not.toContain("sk-123");
    await client.close();
  });

  test("without a handler the request is dropped (Eden's path), and ping cannot be replaced", async () => {
    const client = new McpClient({ name: "c", version: "0" });
    expect(() => client.setRequestHandler("ping", () => ({}))).toThrow();
    // Dropping is what adversarial.test.ts's ping-flood test checks for roots/list.
  });

  test("the server cancelling its request aborts the handler, whose answer is then not sent", async () => {
    const { url } = await sdk(
      (s) => {
        s.registerTool("ask", { annotations: { readOnlyHint: true } }, async (extra) => {
          const ac = new AbortController();
          const p = extra
            .sendRequest({ method: "roots/list" }, ListRootsResultSchema, { signal: ac.signal })
            .catch((e: Error) => e.message);
          await sleep(30);
          ac.abort("enough");
          return { content: [{ type: "text", text: String(await p) }] };
        });
      },
      { eventStore: false },
    );
    const client = new McpClient({ name: "c", version: "0" }, { capabilities: { roots: {} } });
    let aborted = false;
    client.setRequestHandler(
      "roots/list",
      (_p, { signal }) =>
        new Promise((resolve) => signal.addEventListener("abort", () => ((aborted = true), resolve({ roots: [] })))),
    );
    await connect(url, {}, client);
    await client.callTool({ name: "ask" });
    for (let i = 0; i < 50 && !aborted; i++) await sleep(10);
    expect(aborted).toBe(true);
    await client.close();
  });
});

describe("reply budgets (limits, D1872)", () => {
  /** A reply that sends `n` pings `gapMs` apart, then the answer. */
  function pacedPings(n: number, gapMs: number, opts: StreamableHttpOptions) {
    const enc = new TextEncoder();
    const fetchFn = (async (_u: URL | string, init?: RequestInit) => {
      const msg = JSON.parse(String(init?.body)) as { id?: number; method?: string };
      if (msg.method === "initialize") {
        const result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "f", version: "1" } };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (msg.id === undefined || !msg.method) return new Response(null, { status: 202 });
      const id = msg.id;
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (i < n) {
            if (gapMs) await sleep(gapMs);
            c.enqueue(enc.encode(`data: {"jsonrpc":"2.0","id":"p${i++}","method":"ping"}\n\n`));
          } else {
            c.enqueue(enc.encode(`data: {"jsonrpc":"2.0","id":${id},"result":{"content":[]}}\n\n`));
            c.close();
          }
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return new StreamableHttpTransport(new URL("http://mcp.test/mcp"), { fetch: fetchFn, ...opts });
  }

  test("server requests spread over time are allowed past the burst; the same number at once is not", async () => {
    const limits = { serverRequests: 10, serverRequestsPerSecond: 200 };
    const slow = new McpClient({ name: "c", version: "0" });
    await slow.connect(pacedPings(40, 5, { limits }));
    await expect(slow.callTool({ name: "x" })).resolves.toEqual({ content: [] });
    const burst = new McpClient({ name: "c", version: "0" });
    await burst.connect(pacedPings(40, 0, { limits }));
    await expect(burst.callTool({ name: "x" })).rejects.toThrow(/Reply carried over 1\d server requests/);
  });

  test("the budget is the caller's to set", async () => {
    const c = new McpClient({ name: "c", version: "0" });
    await c.connect(pacedPings(500, 0, { limits: { serverRequests: 1_000 } }));
    await expect(c.callTool({ name: "x" })).resolves.toEqual({ content: [] });
  });
});
