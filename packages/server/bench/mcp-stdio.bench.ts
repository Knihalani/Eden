/**
 * Eden's MCP server side over stdio (D1704, D1840): `StdioServerTransport` and `createMcpServer` on in-process pipes,
 * with a partner that answers at once, so what is timed is the framing, the parse and the handler. Each arm runs in
 * its own child process: `eden` (this tree) and `d1704` (the stdio transport and its shape check as D1704 shipped
 * them, `bench/mcp-d1704/`; the handler did not change). It writes `count` requests of one kind in chunks of 64 KB,
 * waits for every answer, and reports CPU per message in µs and the RSS after (the 64 KB answers pile up in the
 * output pipe, so the RSS is the bench's). `KINDS=ping,...` picks the kinds. Arms alternate each round; the summary
 * is the median over rounds.
 *
 *   env -u BUN_OPTIONS bun packages/server/bench/mcp-stdio.bench.ts [rounds=5] [count=20000]
 */
import { PassThrough } from "node:stream";

type Arm = "eden" | "d1704";
const KINDS = (
  process.env.KINDS ? process.env.KINDS.split(",") : ["ping", "tools/list", "ask 1 KB", "ask 64 KB answer"]
) as readonly string[];

async function child(arm: Arm, count: number): Promise<void> {
  const { createMcpServer } = await import("../src/mcp");
  const { StdioServerTransport } =
    arm === "eden" ? await import("../src/stdio-transport") : await import("./mcp-d1704/stdio-transport");
  const out: Record<string, number> = {};
  for (const kind of KINDS) {
    const answer = kind === "ask 64 KB answer" ? "a".repeat(65_536) : "an answer";
    const partner = {
      ask: async () => ({ answer, citations: [{ sourceId: "mail", title: "Re: budget", url: "https://x.test/1" }] }),
      observe: async () => ({}),
    } as never;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let got = 0;
    let done: () => void = () => {};
    stdout.on("data", (d: Buffer) => {
      for (let i = d.indexOf(10); i >= 0; i = d.indexOf(10, i + 1)) got++;
      if (got >= count) done();
    });
    const server = createMcpServer(partner, { tenantId: "t", userId: "u", sessionId: "s" });
    await server.connect(new StdioServerTransport(stdin, stdout));
    const line = (id: number) => {
      if (kind === "ping") return JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
      if (kind === "tools/list") return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
      const question = "what did dana say about the budget? ".repeat(kind === "ask 1 KB" ? 28 : 2);
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "ask_context", arguments: { question: question.slice(0, 1_000) } },
      });
    };
    const body = Buffer.from(Array.from({ length: count }, (_, i) => `${line(i)}\n`).join(""));
    const finished = new Promise<void>((r) => (done = r));
    Bun.gc(true);
    const c0 = process.cpuUsage();
    for (let at = 0; at < body.length; at += 65_536) stdin.write(body.subarray(at, at + 65_536));
    await finished;
    const c = process.cpuUsage(c0);
    out[kind] = Math.round(((c.user + c.system) / count) * 100) / 100;
    await server.close();
  }
  out.rssMb = Math.round((process.memoryUsage().rss / 2 ** 20) * 10) / 10;
  console.log(JSON.stringify(out));
  process.exit(0);
}

async function main(rounds: number, count: number): Promise<void> {
  const runs: { arm: Arm; r: Record<string, number> }[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const arm of (round % 2 ? ["d1704", "eden"] : ["eden", "d1704"]) as Arm[]) {
      const p = Bun.spawn([process.execPath, import.meta.path, "--child", arm, String(count)], { stdout: "pipe" });
      const r = JSON.parse((await new Response(p.stdout).text()).trim()) as Record<string, number>;
      await p.exited;
      runs.push({ arm, r });
    }
  }
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const summary: Record<string, Record<string, number>> = {};
  for (const arm of ["eden", "d1704"] as Arm[]) {
    const mine = runs.filter((x) => x.arm === arm).map((x) => x.r);
    summary[arm] = Object.fromEntries(Object.keys(mine[0]!).map((k) => [k, median(mine.map((m) => m[k]!))]));
  }
  console.log(JSON.stringify({ rounds, count, cpuUsPerMessage: summary }, null, 1));
}

const argv = process.argv.slice(2);
if (argv[0] === "--child") await child(argv[1] as Arm, Number(argv[2]));
else await main(Number(argv[0] ?? 5), Number(argv[1] ?? 20_000));
