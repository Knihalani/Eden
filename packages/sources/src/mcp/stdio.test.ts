/**
 * The stdio client transport (D1860) against the official SDK's server as a child process, and against hostile
 * children: junk and oversized lines, a flood of server requests, a server that ignores the end of its input.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { McpClient } from "./client";
import { getPrompt, listPrompts, listResources, listResourceTemplates, readResource } from "./extras";
import { StdioClientTransport } from "./stdio";

const FIXTURE = new URL("./fixtures/sdk-server.ts", import.meta.url).pathname;
const open: McpClient[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function connect(transport: StdioClientTransport): Promise<McpClient> {
  const client = new McpClient({ name: "test", version: "0" });
  open.push(client);
  await client.connect(transport);
  return client;
}

/** A child running `code` under this runtime. */
const script = (code: string, extra: Partial<ConstructorParameters<typeof StdioClientTransport>[0]> = {}) =>
  new StdioClientTransport({ command: process.execPath, args: ["-e", code], ...extra });

describe("against the SDK's server over stdio", () => {
  test("handshake, tools, resources and prompts", async () => {
    const c = await connect(new StdioClientTransport({ command: process.execPath, args: [FIXTURE] }));
    expect(c.server?.serverInfo).toMatchObject({ name: "fixture", version: "1.2.3" });
    expect(c.server?.instructions).toBe("Ask for notes.");
    expect(c.server?.capabilities).toHaveProperty("tools");
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["env_names", "search_notes"]);
    const r = await c.callTool({ name: "search_notes", arguments: { query: "budget" } });
    expect(r.content).toEqual([{ type: "text", text: "found: budget" }]);
    expect((await listResources(c)).resources).toEqual([
      { uri: "notes://readme", name: "readme", mimeType: "text/plain" },
    ]);
    expect((await listResourceTemplates(c)).resourceTemplates).toMatchObject([
      { uriTemplate: "notes://{id}", name: "note" },
    ]);
    expect((await readResource(c, { uri: "notes://7" })).contents).toEqual([{ uri: "notes://7", text: "note 7" }]);
    const { prompts } = await listPrompts(c);
    expect(prompts).toMatchObject([{ name: "summarize", arguments: [{ name: "id", required: true }] }]);
    const p = await getPrompt(c, { name: "summarize", arguments: { id: "7" } });
    expect(p.messages).toEqual([{ role: "user", content: { type: "text", text: "Summarize note 7" } }]);
    // A JSON-RPC error from the server is an McpError, as for tools.
    await expect(readResource(c, { uri: "nope://x" })).rejects.toThrow(/MCP error/);
  });

  test("the child gets the default variables and the ones given, not the parent's others", async () => {
    process.env.EDEN_TEST_SECRET = "s3cret";
    try {
      const c = await connect(
        new StdioClientTransport({ command: process.execPath, args: [FIXTURE], env: { GIVEN: "1" } }),
      );
      const r = await c.callTool({ name: "env_names", arguments: {} });
      const names = JSON.parse(r.content[0]!.text!) as string[];
      expect(names).toContain("GIVEN");
      expect(names).toContain("PATH");
      expect(names).not.toContain("EDEN_TEST_SECRET");
    } finally {
      delete process.env.EDEN_TEST_SECRET;
    }
  });

  test("close ends the child; a call after it is refused", async () => {
    const t = new StdioClientTransport({ command: process.execPath, args: [FIXTURE] });
    const c = await connect(t);
    const pid = t.pid!;
    await c.close();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(c.callTool({ name: "search_notes", arguments: { query: "x" } })).rejects.toThrow(/Not connected/);
  });
});

describe("hostile children", () => {
  const INIT =
    '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"h","version":"1"}}}';
  /** A server that answers `initialize`, then runs `then` (with `w` writing to stdout). */
  const hostile = (then: string) => `
    const w = (s) => process.stdout.write(s);
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d;
      if (buf.includes('"initialize"') && !globalThis.done) { globalThis.done = true; w(${JSON.stringify(INIT + "\n")}); }
      if (buf.includes('"tools/call"') && !globalThis.called) { globalThis.called = true; ${then} }
    });`;

  test("a spawn that fails rejects the connect", async () => {
    const client = new McpClient({ name: "test", version: "0" });
    await expect(client.connect(new StdioClientTransport({ command: "/nonexistent/mcp-server" }))).rejects.toThrow();
  });

  test("junk lines are dropped and reported at most 100 times; the answer after them still arrives", async () => {
    const t = script(
      hostile(`for (let i = 0; i < 50000; i++) w("not json " + i + "\\n");
        w('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}\\n');`),
    );
    const errors: Error[] = [];
    const c = await connect(t);
    t.onerror = (e) => errors.push(e);
    const r = await c.callTool({ name: "x", arguments: {} });
    expect(r.content[0]!.text).toBe("ok");
    expect(errors.length).toBe(100);
  });

  test("a line past the cap is dropped whole, without holding it", async () => {
    const t = script(
      hostile(`w("x".repeat(3 * 1024 * 1024)); w("y".repeat(3 * 1024 * 1024) + "\\n");
        w('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}\\n');`),
      { maxLineBytes: 1024 * 1024 },
    );
    const errors: Error[] = [];
    const c = await connect(t);
    t.onerror = (e) => errors.push(e);
    expect((await c.callTool({ name: "x", arguments: {} })).content).toEqual([]);
    expect(errors.map((e) => e.message)).toEqual(["stdio: a line passed 1048576 bytes and was dropped"]);
  });

  test("a flood of server requests: pings answered at most 16 at once, others never; the call still answered", async () => {
    const t = script(
      hostile(`for (let i = 0; i < 20000; i++) w(JSON.stringify({ jsonrpc: "2.0", id: "s" + i,
          method: i % 2 ? "ping" : "sampling/createMessage", params: {} }) + "\\n");
        w('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}\\n');`),
    );
    const c = await connect(t);
    expect((await c.callTool({ name: "x", arguments: {} })).content).toEqual([]);
  });

  test("a server that ignores the end of its input and SIGTERM is killed at close", async () => {
    const t = script(
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
       process.stdin.on("data", (d) => { if (String(d).includes('"initialize"'))
         process.stdout.write(${JSON.stringify(INIT + "\n")}); });`,
      { exitGraceMs: 200 },
    );
    const c = await connect(t);
    const pid = t.pid!;
    const t0 = performance.now();
    await c.close();
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a server that exits mid-call rejects the call as a closed connection", async () => {
    const c = await connect(script(hostile("process.exit(3);")));
    await expect(c.callTool({ name: "x", arguments: {} })).rejects.toThrow(/Connection closed/);
  });
});
