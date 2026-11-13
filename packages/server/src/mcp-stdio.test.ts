/**
 * MCP over stdio (D1704): the line transport on its own, then `mcp-stdio.ts` as a subprocess driven by the official
 * SDK's stdio client, one full round trip.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JsonRpcMessage } from "@eden/sources";
import { StdioServerTransport } from "./stdio-transport";

function pipes(maxLine?: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new StdioServerTransport(stdin, stdout, maxLine);
  const got: JsonRpcMessage[] = [];
  const errors: Error[] = [];
  const written: string[] = [];
  transport.onmessage = (m) => got.push(m);
  transport.onerror = (e) => errors.push(e);
  stdout.on("data", (d: Buffer) => written.push(...d.toString("utf8").split("\n").filter(Boolean)));
  return { stdin, transport, got, errors, written };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("StdioServerTransport", () => {
  test("messages split across chunks, several in one chunk, CRLF, blank lines and multi-byte characters", async () => {
    const p = pipes();
    await p.transport.start();
    const a = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const b = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { q: "café ☕" } });
    const bytes = Buffer.from(`${a}\r\n\n  \n${b}\n`, "utf8");
    // Cut inside the multi-byte characters too.
    for (let i = 0; i < bytes.length; i += 3) p.stdin.write(bytes.subarray(i, i + 3));
    await tick();
    expect(p.got).toEqual([JSON.parse(a), JSON.parse(b)]);
    await p.transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    await tick();
    expect(p.written).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  test("a line that is not JSON, or nests too deep, is answered with a parse error; the next line still reads", async () => {
    const p = pipes();
    await p.transport.start();
    p.stdin.write("{nope\n");
    p.stdin.write(`${"[".repeat(5_000)}${"]".repeat(5_000)}\n`);
    p.stdin.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    await tick();
    expect(p.written.slice(0, 2).map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    ]);
    expect(p.got).toEqual([{ jsonrpc: "2.0", id: 2, method: "ping" }]);
  });

  test("a line past the cap is dropped whole, held or not, and the line after it reads", async () => {
    const p = pipes(100);
    await p.transport.start();
    p.stdin.write("x".repeat(60));
    p.stdin.write("x".repeat(60)); // past the cap while still unended: skipped up to its newline
    p.stdin.write(`${"x".repeat(500)}\n${"y".repeat(150)}\n`);
    p.stdin.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
    await tick();
    expect(p.got).toEqual([{ jsonrpc: "2.0", id: 3, method: "ping" }]);
    expect(p.errors.map((e) => e.message)).toEqual([
      "stdio: a line passed 100 bytes and was dropped",
      "stdio: a line passed 100 bytes and was dropped",
    ]);
    expect(p.written).toEqual([]);
  });

  test("close stops reading and refuses sends", async () => {
    const p = pipes();
    let closed = 0;
    p.transport.onclose = () => closed++;
    await p.transport.start();
    await p.transport.close();
    await p.transport.close();
    p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await tick();
    expect(p.got).toEqual([]);
    expect(closed).toBe(1);
    await expect(p.transport.send({ jsonrpc: "2.0", id: 1, result: {} })).rejects.toThrow("Not connected");
  });
});

test("mcp-stdio.ts as a subprocess: the SDK's stdio client initializes, lists and asks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eden-stdio-"));
  const sources = join(dir, "sources.json");
  writeFileSync(
    sources,
    JSON.stringify({
      sources: [
        { id: "calendar", description: "events", docs: [{ ref: "e1", title: "Dentist", text: "Dentist Friday 9am" }] },
      ],
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "mcp-stdio.ts")],
    cwd: join(import.meta.dir, "../../.."),
    env: { PATH: process.env.PATH ?? "", HOME: dir, EDEN_HOME: dir, EDEN_USER: "u1", EDEN_SOURCES_FILE: sources },
    stderr: "pipe",
  });
  const client = new Client({ name: "agent", version: "1" });
  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("eden-context");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ask_context"]);
    const res = (await client.callTool({ name: "ask_context", arguments: { question: "when is the dentist?" } })) as {
      content: { text: string }[];
    };
    expect(res.content[0]!.text).toContain("Dentist Friday 9am");
  } finally {
    await client.close();
  }
}, 30_000);

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`mcp-stdio.ts stopped by ${signal} after an ask writes the mentions it learned (D1780's review)`, async () => {
    // Mentions are written behind, within a second; a signal's default action skips the `exit` listener that would
    // write them, so mcp-stdio closes the map on each signal. Before, this file held 0 mention rows after the ask.
    const dir = mkdtempSync(join(tmpdir(), "eden-stdio-sig-"));
    const sources = join(dir, "sources.json");
    const doc = (ref: string, title: string, text: string) => ({ ref, title, text });
    writeFileSync(
      sources,
      JSON.stringify({
        sources: [
          {
            id: "calendar",
            description: "events",
            docs: [doc("e1", "Dentist with Dana Lee", "Friday 9am, Acme Corp")],
          },
          { id: "mail", description: "mail", docs: [doc("m1", "Note from Dana Lee", "Acme Corp project Phoenix")] },
        ],
      }),
    );
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "mcp-stdio.ts")], {
      cwd: join(import.meta.dir, "../../.."),
      env: { PATH: process.env.PATH ?? "", HOME: dir, EDEN_HOME: dir, EDEN_USER: "u1", EDEN_SOURCES_FILE: sources },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (m: object) => proc.stdin.write(`${JSON.stringify(m)}\n`);
    const replies = proc.stdout.getReader();
    let buffered = "";
    const reply = async (id: number): Promise<unknown> => {
      for (;;) {
        for (const line of buffered.split("\n")) {
          if (line.trim() && (JSON.parse(line) as { id?: number }).id === id) return JSON.parse(line);
        }
        const { value, done } = await replies.read();
        if (done) throw new Error("mcp-stdio closed its output");
        buffered += new TextDecoder().decode(value);
      }
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    await reply(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const question = "when do I see Dana Lee from Acme Corp?";
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_context", arguments: { question } } });
    expect(JSON.stringify(await reply(2))).toContain("Dana Lee");
    proc.kill(signal);
    expect(await proc.exited).toBe(0);
    const file = readdirSync(join(dir, "mcp-stdio")).find((n) => n.endsWith(".db"))!;
    const db = new Database(join(dir, "mcp-stdio", file), { readonly: true });
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM mention").get() as { n: number }).n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  }, 30_000);
}
