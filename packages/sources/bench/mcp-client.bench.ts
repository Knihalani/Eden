/**
 * Eden's MCP client (D1704) against the official SDK's client, on the same server: the SDK's own streamable HTTP
 * server transport under `Bun.serve` in this process, in JSON and in SSE response mode. Each client arm runs in a
 * fresh child process (so its RSS is its own): it connects, warms up, then times `listTools` and `callTool` one after
 * another and reports per-call p50/p99/mean in microseconds, the process RSS and heap after, and how many TCP
 * connections the server saw from it (1 means one keep-alive connection was reused throughout). Arms alternate
 * order each round; the summary is the median over rounds.
 *
 *   bun packages/sources/bench/mcp-client.bench.ts [calls=2000] [rounds=3]
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

type Arm = "eden" | "sdk";
type Mode = "json" | "sse";
interface Result {
  arm: Arm;
  mode: Mode;
  listP50: number;
  listP99: number;
  listMean: number;
  callP50: number;
  callP99: number;
  callMean: number;
  rssMb: number;
  heapMb: number;
  connections?: number;
}

const ROWS = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, subject: `Subject ${i}`, snippet: "x".repeat(200) }));

function server(mode: Mode) {
  const s = new McpServer({ name: "bench", version: "1" });
  s.registerTool(
    "search",
    { description: "search mail", inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: JSON.stringify(ROWS) }] }),
  );
  for (let i = 0; i < 9; i++) {
    s.registerTool(
      `tool_${i}`,
      { description: `tool ${i}`, inputSchema: { a: z.string(), b: z.number() } },
      async () => ({
        content: [],
      }),
    );
  }
  return { s, enableJsonResponse: mode === "json" };
}

async function child(arm: Arm, url: string, calls: number): Promise<void> {
  const quantile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let list: () => Promise<unknown>;
  let call: () => Promise<unknown>;
  let close: () => Promise<void>;
  if (arm === "eden") {
    const { McpClient, StreamableHttpTransport } = await import("../src/mcp");
    const c = new McpClient({ name: "bench", version: "0" });
    await c.connect(new StreamableHttpTransport(new URL(url)));
    list = () => c.listTools();
    call = () => c.callTool({ name: "search", arguments: { query: "budget" } });
    close = () => c.close();
  } else {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const c = new Client({ name: "bench", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    list = () => c.listTools();
    call = () => c.callTool({ name: "search", arguments: { query: "budget" } });
    close = () => c.close();
  }
  for (let i = 0; i < 200; i++) (await list(), await call());
  const time = async (f: () => Promise<unknown>) => {
    const out: number[] = [];
    for (let i = 0; i < calls; i++) {
      const t = Bun.nanoseconds();
      await f();
      out.push((Bun.nanoseconds() - t) / 1_000);
    }
    return out;
  };
  const l = await time(list);
  const c = await time(call);
  Bun.gc(true);
  const mem = process.memoryUsage();
  await close();
  const r = (x: number) => Math.round(x * 10) / 10;
  console.log(
    JSON.stringify({
      listP50: r(quantile(l, 0.5)),
      listP99: r(quantile(l, 0.99)),
      listMean: r(mean(l)),
      callP50: r(quantile(c, 0.5)),
      callP99: r(quantile(c, 0.99)),
      callMean: r(mean(c)),
      rssMb: r(mem.rss / 2 ** 20),
      heapMb: r(mem.heapUsed / 2 ** 20),
    }),
  );
}

async function main(calls: number, rounds: number): Promise<void> {
  // One SDK server per session, routed by Mcp-Session-Id; one Bun.serve per mode.
  const urls = new Map<Mode, string>();
  const portsBySession = new Map<string, Set<number>>();
  for (const mode of ["json", "sse"] as Mode[]) {
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 60,
      fetch: async (req, srv) => {
        const sid = req.headers.get("mcp-session-id");
        let t = sid ? sessions.get(sid) : undefined;
        if (!t) {
          const { s, enableJsonResponse } = server(mode);
          t = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse,
            onsessioninitialized: (id) => void sessions.set(id, t!),
          });
          await s.connect(t);
        }
        const res = await t.handleRequest(req);
        const id = sid ?? res.headers.get("mcp-session-id");
        const port = srv.requestIP(req)?.port;
        if (id && port) (portsBySession.get(id) ?? portsBySession.set(id, new Set()).get(id)!).add(port);
        return res;
      },
    });
    urls.set(mode, `http://127.0.0.1:${http.port}/mcp`);
  }
  const results: Result[] = [];
  for (let round = 0; round < rounds; round++) {
    const arms: Arm[] = round % 2 === 0 ? ["eden", "sdk"] : ["sdk", "eden"];
    for (const mode of ["json", "sse"] as Mode[]) {
      for (const arm of arms) {
        const before = new Set(portsBySession.keys());
        const p = Bun.spawn([process.execPath, import.meta.path, "--child", arm, urls.get(mode)!, String(calls)], {
          stdout: "pipe",
          stderr: "inherit",
        });
        const out = await new Response(p.stdout).text();
        await p.exited;
        const session = [...portsBySession.keys()].find((k) => !before.has(k));
        const connections = session ? portsBySession.get(session)!.size : undefined;
        const res = { arm, mode, ...(JSON.parse(out.trim().split("\n").pop()!) as object), connections } as Result;
        results.push(res);
        console.error(JSON.stringify(res));
      }
    }
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const keys = ["listP50", "listP99", "listMean", "callP50", "callP99", "callMean", "rssMb", "heapMb", "connections"];
  const summary: Record<string, Record<string, number>> = {};
  for (const mode of ["json", "sse"] as Mode[]) {
    for (const arm of ["eden", "sdk"] as Arm[]) {
      const rs = results.filter((r) => r.arm === arm && r.mode === mode);
      summary[`${arm}/${mode}`] = Object.fromEntries(
        keys.map((k) => [k, median(rs.map((r) => (r as unknown as Record<string, number>)[k] ?? NaN))]),
      );
    }
  }
  console.log(JSON.stringify({ calls, rounds, summary }, null, 2));
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv[0] === "--child") await child(argv[1] as Arm, argv[2]!, Number(argv[3]));
else await main(Number(argv[0] ?? 2_000), Number(argv[1] ?? 3));
