/**
 * D1840's changes against the client as D1704 shipped it (`bench/mcp-d1704/`, frozen): the SSE parser on seeded
 * random streams, cut at random and replayed byte for byte, and the whole client and transport on seeded random
 * replies from a fake server. Each must give the same events, steps, results, errors, `onerror` reports and POSTs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { McpClient } from "./client";
import { StreamableHttpTransport } from "./http";
import { SseParser } from "./sse";

/** The frozen D1704 code, Eden's history: absent when this directory is used on its own, and the file skipped then. */
const ORACLE = new URL("../../bench/mcp-d1704/", import.meta.url);
const oracle = existsSync(ORACLE)
  ? {
      ...((await import(new URL("client.ts", ORACLE).href)) as typeof import("../../bench/mcp-d1704/client")),
      ...((await import(new URL("http.ts", ORACLE).href)) as typeof import("../../bench/mcp-d1704/http")),
      ...((await import(new URL("sse.ts", ORACLE).href)) as typeof import("../../bench/mcp-d1704/sse")),
    }
  : null;
const OldClient = oracle?.McpClient as typeof import("../../bench/mcp-d1704/client").McpClient;
const OldTransport =
  oracle?.StreamableHttpTransport as typeof import("../../bench/mcp-d1704/http").StreamableHttpTransport;
const OldParser = oracle?.SseParser as typeof import("../../bench/mcp-d1704/sse").SseParser;

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
  "data:x",
  "data: e\n\n",
  "data: a\ndata: b\r\n\r\n",
  "event:",
  "event: message",
  "event: other",
  "id: 1",
  "retry: 5",
  ":",
  ": comment",
  "\r",
  "\n",
  "\r\n",
  "\n\n",
  "\r\r",
  "﻿",
  "{",
  "}",
  '"',
  "\\",
  '"jsonrpc":"2.0"',
  "é",
  "\u0000",
];

/** A stream of SSE-ish pieces, with long runs (past the parser's native searches' short hops) now and then. */
function stream(r: () => number): Uint8Array {
  const parts: string[] = [];
  const n = Math.floor(r() * 60);
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.1) parts.push("y".repeat(1 + Math.floor(r() * 300)));
    else if (roll < 0.15) parts.push("\r".repeat(1 + Math.floor(r() * 5)));
    else if (roll < 0.9) parts.push(PIECES[Math.floor(r() * PIECES.length)]!);
    else parts.push(String.fromCharCode(Math.floor(r() * 256)));
  }
  return new TextEncoder().encode(parts.join(""));
}

function cut(bytes: Uint8Array, r: () => number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const big = r() < 0.3;
  for (let at = 0; at < bytes.length;) {
    const n = 1 + Math.floor(r() * (big ? 400 : 9));
    out.push(bytes.slice(at, at + n));
    at += n;
  }
  return out;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe.skipIf(!oracle)("SseParser against D1704's", () => {
  test("the same events and steps on 20,000 seeded streams, chunks kept or reused", () => {
    const r = rng(1708);
    let events = 0;
    let large = 0;
    for (let i = 0; i < 20_000; i++) {
      const bytes = stream(r);
      const parts = cut(bytes, r);
      const max = 8 + Math.floor(r() * 2_000);
      const stopAt = r() < 0.5 ? Math.floor(r() * 4) : -1;
      const run = (P: typeof SseParser | typeof OldParser, kept: boolean | null) => {
        const got: string[] = [];
        const p =
          kept === null
            ? new P(max, (d) => got.push(hex(d)) - 1 === stopAt)
            : new (P as typeof SseParser)(max, (d) => got.push(hex(d)) - 1 === stopAt, kept);
        for (const c of parts) {
          // A caller that keeps nothing may scribble on its chunk once `push` returns: a copy it is, then.
          const mine = kept ? c : c.slice();
          const step = p.push(mine);
          if (!kept) mine.fill(0x3f);
          got.push(step);
          if (step !== "more") break;
        }
        return got;
      };
      const want = run(OldParser, null);
      expect(run(SseParser, false)).toEqual(want);
      expect(run(SseParser, true)).toEqual(want);
      events += want.filter((x) => x !== "more" && x !== "stop" && x !== "too-large").length;
      if (want.includes("too-large")) large++;
    }
    // The streams reach events, stops and the cap often, so the comparison is not of empty runs.
    expect(events).toBeGreaterThan(20_000);
    expect(large).toBeGreaterThan(1_000);
  });

  test("one long event in chunks of every size, and lines split at a CR before their LF", () => {
    const body = new TextEncoder().encode(`event: message\r\ndata: ${"z".repeat(70_000)}\r\ndata: tail\r\n\r\n`);
    for (const size of [1, 2, 3, 31, 32, 33, 1_000, 65_536, body.length]) {
      const runs = [new OldParser(1 << 20, () => false), new SseParser(1 << 20, () => false, true)].map((p) => {
        const got: string[] = [];
        (p as unknown as { onEvent: (d: Uint8Array) => boolean }).onEvent = (d) => (got.push(hex(d)), false);
        for (let at = 0; at < body.length; at += size) got.push(p.push(body.slice(at, at + size)));
        return got;
      });
      expect(runs[1]).toEqual(runs[0]!);
    }
  });
});

describe.skipIf(!oracle)("McpClient and StreamableHttpTransport against D1704's", () => {
  const INIT = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "s", version: "1" } };
  const enc = new TextEncoder();

  /** A seeded random reply to request `id`: JSON or SSE, valid or not, with noise, other ids and server requests. */
  function reply(r: () => number, id: number): () => Response {
    const ok = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "t".repeat(r() * 200) }] },
    });
    const others = [
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }),
      JSON.stringify({ jsonrpc: "2.0", id: 900 + Math.floor(r() * 5), method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: 900, method: "sampling/createMessage", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: id + 1, result: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: String(id), result: { content: [] } }),
      JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32029, message: "slow down" } }),
      JSON.stringify({ jsonrpc: "2.0", id, result: { content: "nope" } }),
      JSON.stringify({ jsonrpc: "2.0", id, result: { content: [], structuredContent: [1] } }),
      // Multi-byte text, escapes and a byte-order mark: the native read decodes these itself (D1860).
      JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: 'é😀 "q" \\ \r\n' }] } }),
      `\ufeff${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } })}`,
      `\ufeff\ufeff${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } })}`,
      `{"jsonrpc":"2.0","id":${id},"result":{"a":${"[".repeat(1_100)}${"]".repeat(1_100)}}}`,
      "{not json",
      "",
    ];
    const pick = () => (r() < 0.4 ? ok : others[Math.floor(r() * others.length)]!);
    const roll = r();
    if (roll < 0.05) return () => new Response("busy, rate limit", { status: 429, headers: { "retry-after": "3" } });
    if (roll < 0.08) return () => new Response(null, { status: 202 });
    if (roll < 0.11) return () => new Response("x", { headers: { "content-type": "text/plain" } });
    if (roll < 0.5) {
      const many = r() < 0.3 ? `[${Array.from({ length: 1 + Math.floor(r() * 4) }, pick).join(",")}]` : pick();
      return () => new Response(many, { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    const events = Array.from({ length: 1 + Math.floor(r() * 5) }, () => {
      const m = pick();
      const lines = r() < 0.2 ? m.replace(/,/g, ",\ndata: ") : m;
      return `${r() < 0.3 ? "event: message\n" : ""}${r() < 0.1 ? ": hi\n" : ""}data: ${lines}\n\n`;
    }).join("");
    const bytes = enc.encode(events);
    const truncate = r() < 0.1 ? Math.floor(r() * bytes.length) : bytes.length;
    const parts = cut(bytes.subarray(0, truncate), r);
    return () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            const p = parts.shift();
            if (p) c.enqueue(p.slice());
            else c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
  }

  /**
   * Plays 1,000 seeded replies through a client. `real`: from a `Bun.serve` server through the runtime's own `fetch`,
   * where a JSON reply with a `Content-Length` takes this code's native read (D1860) and D1704's capped stream read.
   */
  async function play(
    Client: typeof McpClient | typeof OldClient,
    Transport: typeof StreamableHttpTransport,
    real = false,
  ) {
    const r = rng(17_08);
    const posted: string[] = [];
    const errors: string[] = [];
    const outcomes: unknown[] = [];
    let next: (() => Response) | null = null;
    const fetchFn = (async (_url: URL | string, init?: RequestInit) => {
      const msg = JSON.parse(String(init?.body)) as { id?: number; method?: string };
      posted.push(String(init?.body));
      if (msg.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: INIT }), {
          headers: { "content-type": "application/json", "mcp-session-id": "s1" },
        });
      }
      if (msg.id === undefined || !msg.method) return new Response(null, { status: 202 });
      return next!();
    }) as typeof fetch;
    const server = real
      ? Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: async (req) => fetchFn(req.url, { body: await req.text() }),
        })
      : null;
    const transport = server
      ? new Transport(new URL(`http://127.0.0.1:${server.port}/mcp`), { maxResponseBytes: 64 * 1024 })
      : new Transport(new URL("http://mcp.test/mcp"), { fetch: fetchFn, maxResponseBytes: 64 * 1024 });
    const client = new Client({ name: "eden", version: "0" });
    await client.connect(transport);
    transport.onerror = (e) => errors.push(`${e.name}: ${e.message}`);
    for (let i = 0; i < 1_000; i++) {
      // Ids start at 0 (initialize), so call i is request i + 1.
      next = reply(r, i + 1);
      const call = r() < 0.2 ? client.listTools() : client.callTool({ name: "search", arguments: { q: i } });
      outcomes.push(
        await call.then(
          (v) => ({ ok: v }),
          (e: Error) => ({ error: `${e.name}: ${e.message}` }),
        ),
      );
      // The pings a reply asked for are answered in the background: let them land before the next call.
      await new Promise((res) => setTimeout(res, 0));
    }
    await client.close();
    void server?.stop(true);
    return { outcomes, errors, posted: posted.sort() };
  }

  test("the same results, errors, reports and POSTs on 1,000 seeded random replies", async () => {
    const want = await play(OldClient, OldTransport as unknown as typeof StreamableHttpTransport);
    const got = await play(McpClient, StreamableHttpTransport);
    expect(got.outcomes).toEqual(want.outcomes);
    expect(got.errors).toEqual(want.errors);
    expect(got.posted).toEqual(want.posted);
    // Both kinds of outcome, in numbers.
    const ok = want.outcomes.filter((o) => "ok" in (o as object)).length;
    expect(ok).toBeGreaterThan(200);
    expect(want.outcomes.length - ok).toBeGreaterThan(200);
  }, 120_000);

  test("the same on 1,000 replies over real HTTP, where JSON takes the native read", async () => {
    const want = await play(OldClient, OldTransport as unknown as typeof StreamableHttpTransport, true);
    const got = await play(McpClient, StreamableHttpTransport, true);
    expect(got.outcomes).toEqual(want.outcomes);
    expect(got.errors).toEqual(want.errors);
    expect(got.posted).toEqual(want.posted);
    const ok = want.outcomes.filter((o) => "ok" in (o as object)).length;
    expect(ok).toBeGreaterThan(200);
  }, 60_000);
});
