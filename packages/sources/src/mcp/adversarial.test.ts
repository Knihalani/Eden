/**
 * Eden's MCP client and streamable HTTP transport (D1704) against servers that misbehave: malformed or oversized
 * replies, broken and padded event streams, wrong ids, hangs, and random bytes. Every failure must come back as a
 * rejected call (or an `onerror`), never as a throw out of the client or a request left waiting.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { McpClient } from "./client";
import { StreamableHttpTransport } from "./http";
import { SseParser } from "./sse";
import { asMessage, ErrorCode, McpError, type JsonRpcMessage } from "./types";

const URL_ = new URL("http://mcp.test/mcp");
const INIT = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "s", version: "1" } };

// Bounds on work, not on waiting: process CPU time, as cards.test.ts reads it, so a loaded machine does not fail them.
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

type Reply = (
  msg: { id?: number; method?: string },
  posted: unknown[],
  signal?: AbortSignal,
) => Response | Promise<Response>;

/** A transport over a fake server: `initialize` answered in JSON, every other request by `reply`. */
function over(reply: Reply, opts: { maxResponseBytes?: number; timeoutMs?: number } = {}) {
  const posted: unknown[] = [];
  const fetchFn = (async (_url: URL | string, init?: RequestInit) => {
    const msg = JSON.parse(String(init?.body)) as { id?: number; method?: string };
    posted.push(msg);
    if (msg.method === "initialize") return json({ jsonrpc: "2.0", id: msg.id, result: INIT });
    if (msg.id === undefined || !msg.method) return new Response(null, { status: 202 });
    return reply(msg, posted, init?.signal ?? undefined);
  }) as typeof fetch;
  const transport = new StreamableHttpTransport(URL_, { fetch: fetchFn, ...opts });
  const errors: Error[] = [];
  return { transport, posted, errors };
}

async function client(reply: Reply, opts: { maxResponseBytes?: number; timeoutMs?: number } = {}) {
  const o = over(reply, opts);
  const c = new McpClient({ name: "eden", version: "0" });
  await c.connect(o.transport);
  o.transport.onerror = (e) => o.errors.push(e);
  return { c, ...o };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
const sse = (body: string | ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });
const result = (id: number | undefined, r: unknown = { content: [{ type: "text", text: "ok" }] }) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: r });

/** A stream of the given chunks, then (optionally) an error instead of an end. */
function chunks(parts: (string | Uint8Array)[], fail?: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(c) {
      const p = parts.shift();
      if (p === undefined) return fail ? c.error(fail) : c.close();
      c.enqueue(typeof p === "string" ? new TextEncoder().encode(p) : p);
      await new Promise((r) => setTimeout(r, 1));
    },
  });
}

describe("malformed and oversized replies", () => {
  test("a reply that is not JSON rejects the call", async () => {
    const { c } = await client(() => json("{not json"));
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Reply is not JSON");
  });

  test("JSON that is valid JSON-RPC for nothing (no jsonrpc field) answers nothing", async () => {
    const { c, errors } = await client((m) => json({ id: m.id, result: {} }));
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Reply did not answer the request");
    // One report for what was dropped, then the request's own failure.
    expect(errors.map((e) => e.message)).toEqual([
      "Streamable HTTP error: Reply carried 1 malformed or unasked messages",
      "Streamable HTTP error: Reply did not answer the request",
    ]);
  });

  test("a JSON body past the cap is refused, declared or streamed", async () => {
    const big = result(1, { content: [{ type: "text", text: "x".repeat(5_000) }] });
    const declared = await client(() => json(big), { maxResponseBytes: 1_000 });
    await expect(declared.c.callTool({ name: "x" })).rejects.toThrow("Reply larger than 1000 bytes");
    const streamed = await client(
      () =>
        new Response(chunks([big.slice(0, 600), big.slice(600)]), { headers: { "content-type": "application/json" } }),
      { maxResponseBytes: 1_000 },
    );
    await expect(streamed.c.callTool({ name: "x" })).rejects.toThrow("Reply larger than 1000 bytes");
  });

  test("JSON nested past the shape bound is refused before it is parsed", async () => {
    const deep = `{"jsonrpc":"2.0","id":1,"result":{"content":[],"x":${"[".repeat(5_000)}${"]".repeat(5_000)}}}`;
    const { c } = await client(() => json(deep));
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Reply is not JSON");
  });

  test("an event stream past the cap is cut and refused", async () => {
    const pad = `: ${"x".repeat(400)}\n\n`;
    const { c } = await client(() => sse(chunks([pad, pad, pad, `data: ${result(1)}\n\n`])), {
      maxResponseBytes: 1_000,
    });
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Event stream larger than 1000 bytes");
  });

  test("one event's data past the cap is refused even when no chunk is", async () => {
    const line = `data: ${"y".repeat(300)}\n`;
    const { c } = await client(() => sse(chunks([line, line, line, line, "\n"])), { maxResponseBytes: 1_100 });
    await expect(c.callTool({ name: "x" })).rejects.toThrow(/larger than 1100 bytes/);
  });

  test("a wrong content type is refused", async () => {
    const { c } = await client(() => new Response("<html></html>", { headers: { "content-type": "text/html" } }));
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Unexpected content type: text/html");
  });
});

describe("event streams", () => {
  test("a truncated stream (cut mid-event) rejects", async () => {
    const r = result(1);
    const { c } = await client(() => sse(chunks([`data: ${r.slice(0, 20)}`])));
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Event stream ended before the response");
  });

  test("a body stream that reuses one buffer for every chunk still parses (its chunks are copied)", async () => {
    const bytes = new TextEncoder().encode(`event: message\ndata: ${result(1)}\n\n`);
    const buffer = new Uint8Array(7);
    let at = 0;
    const reusing = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (at >= bytes.length) return ctl.close();
        const n = Math.min(buffer.length, bytes.length - at);
        // The same memory every time: what the parser held of the last chunk is overwritten now.
        buffer.set(bytes.subarray(at, at + n));
        at += n;
        ctl.enqueue(buffer.subarray(0, n));
      },
    });
    const { c } = await client(() => sse(reusing));
    expect(await c.callTool({ name: "x" })).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  test("a server that closes mid-stream rejects instead of hanging", async () => {
    const { c } = await client(() => sse(chunks(["event: message\n", "data: {"], new Error("socket hang up"))));
    await expect(c.callTool({ name: "x" })).rejects.toThrow("socket hang up");
  });

  test("multi-line data fields are joined by line feeds; CR, CRLF and LF all end lines", async () => {
    const body = `event: message\r\ndata: {"jsonrpc":"2.0",\rdata: "id":1,\ndata: "result":{"content":[]}}\r\n\r\n`;
    const { c } = await client(() => sse(chunks(body.split(""))));
    expect(await c.callTool({ name: "x" })).toEqual({ content: [] });
  });

  test("interleaved notifications, other event types and comments come before the response", async () => {
    const note = (n: number) =>
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { n } })}\n\n`;
    const seen: JsonRpcMessage[] = [];
    const body = [": keep-alive\n\n", note(1), "event: other\ndata: {}\n\n", note(2), `id: 7\ndata: ${result(1)}\n\n`];
    const { c, transport } = await client(() => sse(chunks(body)));
    const prev = transport.onmessage!;
    transport.onmessage = (m) => (seen.push(m), prev(m));
    expect((await c.callTool({ name: "x" })).content).toEqual([{ type: "text", text: "ok" }]);
    expect(seen.map((m) => ("method" in m ? m.method : "response"))).toEqual([
      "notifications/progress",
      "notifications/progress",
      "response",
    ]);
  });

  test("a server request on the stream (sampling) is dropped unanswered: no POST, never acted on", async () => {
    const ask = JSON.stringify({
      jsonrpc: "2.0",
      id: "s1",
      method: "sampling/createMessage",
      params: { messages: [] },
    });
    const { c, posted } = await client(() => sse(chunks([`data: ${ask}\n\n`, `data: ${result(1)}\n\n`])));
    await c.callTool({ name: "x" });
    await new Promise((r) => setTimeout(r, 5));
    expect(posted.filter((m) => (m as { id?: unknown }).id === "s1")).toEqual([]);
  });

  test("a leading byte-order mark is dropped", async () => {
    const { c } = await client((m) => sse(`\uFEFFdata: ${result(m.id)}\n\n`));
    expect((await c.callTool({ name: "x" })).content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("a 202 to a request fails at once instead of at the call's timeout", async () => {
    const { c } = await client(() => new Response(null, { status: 202 }));
    // Failing fast is the message: a wait would end in the call's 60 s timeout, past this test's own 5 s.
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Server accepted the request without answering it");
  });
});

/** Regressions from the security review's proofs of concept (sse-quad, sse-e2e, ping-flood, pages, tiny). */
describe("floods and slow growth", () => {
  test("sse-quad: an 8 MiB unended line in 4 KB chunks is linear (was 1.6 s; quadratic re-joining)", () => {
    const p = new SseParser(16 * 1024 * 1024, () => false);
    const chunk = new Uint8Array(4_096).fill(0x61);
    const t = cpuMs();
    for (let n = 0; n < 8 * 1024 * 1024; n += chunk.length) expect(p.push(chunk)).toBe("more");
    expect(p.push(new Uint8Array([0x0a]))).toBe("more");
    expect(cpuMs() - t).toBeLessThan(400);
  });

  test("sse-e2e: 1 KB writes with no line end are cut at the 4 MiB event cap, cheaply", async () => {
    const piece = new Uint8Array(1_024).fill(0x61);
    let sent = 0;
    const endless = () =>
      sse(
        new ReadableStream({
          pull(c) {
            sent += piece.length;
            c.enqueue(piece);
          },
        }),
      );
    const { c } = await client(endless);
    const t = cpuMs();
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Event stream larger than 4194304 bytes");
    expect(sent).toBeLessThan(4 * 1024 * 1024 + 64 * 1024);
    expect(cpuMs() - t).toBeLessThan(2_000);
  });

  test("ping-flood: server requests on a reply cost at most 16 POSTs at once and fail the reply past 100", async () => {
    let pending = 0;
    let peak = 0;
    let replies = 0;
    const o = over((m) => {
      let s = "";
      for (let i = 0; i < 20_000; i++) s += `data: {"jsonrpc":"2.0","id":"p${i}","method":"ping"}\n\n`;
      return sse(s + `data: ${result(m.id)}\n\n`);
    });
    // Answers to pings hang until aborted: the server never takes them.
    const fetchFn = (o.transport as unknown as { fetchFn: typeof fetch }).fetchFn;
    (o.transport as unknown as { fetchFn: typeof fetch }).fetchFn = ((url: URL, init?: RequestInit) => {
      const msg = JSON.parse(String(init?.body)) as { method?: string };
      if (msg.method) return fetchFn(url, init);
      replies++;
      pending++;
      peak = Math.max(peak, pending);
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => (pending--, reject(new Error("aborted")))),
      );
    }) as typeof fetch;
    const c = new McpClient({ name: "eden", version: "0" });
    await c.connect(o.transport);
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Reply carried over 100 server requests");
    expect(peak).toBeLessThanOrEqual(16);
    expect(replies).toBeLessThanOrEqual(16);
    // Any other method is dropped outright: no POST at all.
    const other = await client((m) => {
      let s = "";
      for (let i = 0; i < 50; i++) s += `data: {"jsonrpc":"2.0","id":"r${i}","method":"roots/list"}\n\n`;
      return sse(s + `data: ${result(m.id)}\n\n`);
    });
    await other.c.callTool({ name: "x" });
    await new Promise((r) => setTimeout(r, 5));
    expect(other.posted.filter((m) => !(m as { method?: string }).method)).toEqual([]);
    await c.close();
  });

  test("pages: a tools/list reply is capped at 4 MiB, below the general cap", async () => {
    const tool = `{"name":"${"a".repeat(40)}","inputSchema":{"type":"object"}},`;
    const big = (id: number | undefined) =>
      json(`{"jsonrpc":"2.0","id":${id},"result":{"tools":[${tool.repeat(80_000)}{"name":"b","inputSchema":{}}]}}`);
    const { c } = await client((m) => big(m.id));
    await expect(c.listTools()).rejects.toThrow("Reply larger than 4194304 bytes");
  });

  test.each(["data:x\n\n", "data:1\n\n"])("tiny: a flood of junk events (%j) fails the reply after 100", async (ev) => {
    const { c, errors } = await client((m) => sse(ev.repeat(1_000_000) + `data: ${result(m.id)}\n\n`));
    const t = cpuMs();
    await expect(c.callTool({ name: "x" })).rejects.toThrow("over 100 bad messages");
    expect(cpuMs() - t).toBeLessThan(1_000);
    expect(errors.filter((e) => /malformed/.test(e.message))).toHaveLength(1);
  });
});

describe("ids, hangs and errors", () => {
  test("an id echoed as a numeric string answers its request, as the SDK accepts; another string does not", async () => {
    const { c } = await client((m) => json({ jsonrpc: "2.0", id: String(m.id), result: { content: [] } }));
    expect(await c.callTool({ name: "x" })).toEqual({ content: [] });
    const other = await client(() => json({ jsonrpc: "2.0", id: "x1", result: { content: [] } }));
    await expect(other.c.callTool({ name: "x" })).rejects.toThrow("Reply did not answer the request");
  });

  test("a cancelled call's POST is cut at once, even when the cancellation's own POST hangs", async () => {
    let cut = 0;
    const hang = (_m: unknown, _p: unknown, signal?: AbortSignal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          cut++;
          reject(new Error("aborted"));
        });
      });
    const o = over((m, p, signal) => hang(m, p, signal));
    // The notification's POST hangs too: `over` answers notifications itself, so route them to the hang here.
    const fetchFn = (o.transport as unknown as { fetchFn: typeof fetch }).fetchFn;
    (o.transport as unknown as { fetchFn: typeof fetch }).fetchFn = ((url: URL, init?: RequestInit) => {
      const msg = JSON.parse(String(init?.body)) as { method?: string };
      if (msg.method === "notifications/cancelled") return hang(msg, [], init?.signal ?? undefined);
      return fetchFn(url, init);
    }) as typeof fetch;
    const c = new McpClient({ name: "eden", version: "0" });
    await c.connect(o.transport);
    const ac = new AbortController();
    const call = c.callTool({ name: "x" }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(new Error("deadline"));
    await expect(call).rejects.toThrow("deadline");
    await new Promise((r) => setTimeout(r, 5));
    expect(cut).toBe(1); // the call's POST; the hanging notification is left to its own deadline
    await c.close();
  });

  test("a rate limit said in a 403's text is marked in fixed words, never quoted", async () => {
    const o = over(() => new Response("API rate limit exceeded for sk-user-token", { status: 403 }));
    const c = new McpClient({ name: "eden", version: "0" });
    await c.connect(o.transport);
    const err = (await c.callTool({ name: "x" }).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("Streamable HTTP error: Error POSTing to endpoint (HTTP 403, rate limited)");
    const plain = over(() => new Response("forbidden", { status: 403 }));
    const c2 = new McpClient({ name: "eden", version: "0" });
    await c2.connect(plain.transport);
    await expect(c2.callTool({ name: "x" })).rejects.toThrow(/\(HTTP 403\)$/);
  });

  test("a response to another id is dropped; the call is not answered by it", async () => {
    const { c, errors } = await client(() => json(result(99)));
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Reply did not answer the request");
    expect(errors.some((e) => /1 malformed or unasked/.test(e.message))).toBe(true);
    const onStream = await client(() => sse(`data: ${result(99)}\n\n`));
    await expect(onStream.c.callTool({ name: "x" })).rejects.toThrow("Event stream ended before the response");
  });

  test("a duplicate response: the first answers, the second is ignored", async () => {
    const first = { content: [{ type: "text", text: "first" }] };
    const second = { content: [{ type: "text", text: "second" }] };
    const { c } = await client((m) => json(`[${result(m.id, first)},${result(m.id, second)}]`));
    expect((await c.callTool({ name: "x" })).content[0]!.text).toBe("first");
  });

  test("an isError result is a result", async () => {
    const { c } = await client((m) => json(result(m.id, { content: [{ type: "text", text: "nope" }], isError: true })));
    expect(await c.callTool({ name: "x" })).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
  });

  test("a hanging server: the call times out, the POST is aborted, nothing stays in flight", async () => {
    let aborted = false;
    const { c, transport } = await client(
      (_m, _posted, signal) =>
        new Promise<Response>((_resolve, reject) => {
          // Never answered: only the transport's own abort ends this fetch.
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const err = await c.callTool({ name: "x" }, { timeoutMs: 30 }).catch((e: unknown) => e);
    expect((err as McpError).code).toBe(ErrorCode.RequestTimeout);
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(true);
    expect((transport as unknown as { flights: Set<unknown> }).flights.size).toBe(0);
  });

  test("the transport's own deadline ends a POST whose body never finishes", async () => {
    const { c } = await client(() => sse(new ReadableStream({ pull: () => new Promise(() => {}) })), { timeoutMs: 30 });
    await expect(c.callTool({ name: "x" })).rejects.toThrow("Request timed out");
  });

  test("close aborts every POST in flight and rejects its call", async () => {
    const { c, transport } = await client(() => sse(new ReadableStream({ pull: () => new Promise(() => {}) })));
    const call = c.callTool({ name: "x" });
    await new Promise((r) => setTimeout(r, 10));
    await c.close();
    expect(((await call.catch((e: unknown) => e)) as McpError).code).toBe(ErrorCode.ConnectionClosed);
    expect((transport as unknown as { flights: Set<unknown> }).flights.size).toBe(0);
  });
});

/** A small seeded generator, so a failure replays. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const PIECES = [
  "data:",
  "data: ",
  "event:",
  "event: message",
  "id: 1",
  ":",
  "\r",
  "\n",
  "\r\n",
  "{",
  "}",
  "[",
  "]",
  '"',
  "\\",
  '"jsonrpc":"2.0"',
  '"id":1',
  '"id":0',
  '"result":{}',
  '"method":"ping"',
  '"error":{"code":1,"message":"m"}',
  ",",
  "null",
  "1e999",
  "\u0000",
  "￿",
  "é",
];

function randomBytes(r: () => number): Uint8Array {
  const parts: string[] = [];
  const n = Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    parts.push(r() < 0.8 ? PIECES[Math.floor(r() * PIECES.length)]! : String.fromCharCode(Math.floor(r() * 256)));
  }
  const bytes = new TextEncoder().encode(parts.join(""));
  // Raw bytes too, not only valid UTF-8.
  for (let i = 0; i < bytes.length; i++) if (r() < 0.02) bytes[i] = Math.floor(r() * 256);
  return bytes;
}

function split(bytes: Uint8Array, r: () => number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const n = 1 + Math.floor(r() * 8);
    out.push(bytes.slice(at, at + n));
    at += n;
  }
  return out;
}

describe("fuzz", () => {
  test("the SSE parser never throws, and stays within its cap, on 5,000 random streams", () => {
    const r = rng(1);
    for (let i = 0; i < 5_000; i++) {
      const p = new SseParser(64, (data) => {
        expect(data.length).toBeLessThanOrEqual(64);
        return r() < 0.1;
      });
      for (const c of split(randomBytes(r), r)) if (p.push(c) !== "more") break;
    }
  });

  test("asMessage never throws on 5,000 random JSON values", () => {
    const r = rng(2);
    const values = [null, 0, -1, 1.5, "x", true, [], {}, { a: 1 }];
    const pick = (): unknown => values[Math.floor(r() * values.length)];
    for (let i = 0; i < 5_000; i++) {
      const v: Record<string, unknown> = {};
      for (const k of ["jsonrpc", "id", "method", "params", "result", "error"]) if (r() < 0.5) v[k] = pick();
      if (r() < 0.5) v.jsonrpc = "2.0";
      if (r() < 0.3) v.error = { code: pick(), message: pick() };
      const m = asMessage(r() < 0.1 ? pick() : v);
      if (m && !("method" in m) && "result" in m) expect(typeof m.result).toBe("object");
    }
  });

  test("the client never throws out and never hangs on 3,000 random replies (JSON and SSE)", async () => {
    const r = rng(3);
    const replies: Uint8Array[] = [];
    const { c } = await client(() => {
      const body = replies.shift()!;
      const type = r() < 0.5 ? "application/json" : "text/event-stream";
      return new Response(body, { headers: { "content-type": type } });
    });
    let settled = 0;
    for (let i = 0; i < 3_000; i++) {
      // Sometimes a valid response, wrapped in noise: the parse must still find or refuse it.
      const id = i + 1;
      const valid = r() < 0.3 ? new TextEncoder().encode(`data: ${result(id)}\n\n`) : new Uint8Array(0);
      const noise = randomBytes(r);
      const body = new Uint8Array(noise.length + valid.length);
      body.set(noise);
      body.set(valid, noise.length);
      replies.push(body);
      await c.callTool({ name: "x" }, { timeoutMs: 1_000 }).then(
        () => settled++,
        (e: unknown) => {
          expect(e).toBeInstanceOf(Error);
          settled++;
        },
      );
    }
    expect(settled).toBe(3_000);
  });
});

/** Eden's `McpSource`, absent when this directory is used on its own: its section is skipped then. */
const MCP_SOURCE = new URL("../mcp-source.ts", import.meta.url);
const eden = existsSync(MCP_SOURCE) ? ((await import(MCP_SOURCE.href)) as typeof import("../mcp-source")) : null;

describe.skipIf(!eden)("pages: McpSource keeps only the tools it uses (D7 unchanged)", () => {
  const { McpSource, ReadOnlyViolation } = eden ?? ({} as typeof import("../mcp-source"));
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" } }));
  const search = { name: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
  const source = (pages: (cursor: string | undefined) => { tools: unknown[]; nextCursor?: string }, lists: string[]) =>
    new McpSource({
      id: "s",
      description: "s",
      transport: () =>
        over((m, posted) => {
          const msg = posted[posted.length - 1] as { method: string; params?: { cursor?: string } };
          if (msg.method !== "tools/list") return json(result(m.id, { content: [] }));
          lists.push(msg.params?.cursor ?? "");
          return json(result(m.id, pages(msg.params?.cursor)));
        }).transport,
      searchTool: { name: "search", args: (q) => ({ q: q.text }) },
    });
  const query = { scope: { tenantId: "t", userId: "u" }, text: "x", entities: [], limit: 5 };

  test("a repeated cursor stops the listing; a tool never listed is 'no tool'", async () => {
    const lists: string[] = [];
    const s = source(() => ({ tools: filler(1_000), nextCursor: "same" }), lists);
    await expect(s.search(query, AbortSignal.timeout(2_000))).rejects.toThrow("server has no tool search");
    expect(lists).toEqual(["", "same"]);
  });

  test("the listing stops once every wanted tool is found", async () => {
    const lists: string[] = [];
    const s = source((c) => (c ? { tools: filler(10) } : { tools: [...filler(10), search], nextCursor: "p2" }), lists);
    expect(await s.search(query, AbortSignal.timeout(2_000))).toEqual([]);
    expect(lists).toEqual([""]);
    await s.close();
  });

  test("a wanted tool that is not read-only still fails the connect", async () => {
    const s = source(() => ({ tools: [{ ...search, annotations: {} }] }), []);
    await expect(s.search(query, AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(ReadOnlyViolation);
  });
});
