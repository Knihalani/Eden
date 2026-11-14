/**
 * Where an MCP client's time goes (D1704's client, D1840; `docs/research/mcp-perf.md`). A canned server in its own
 * process answers `tools/call` with a result of a set size (one text block) and `tools/list` with tools of a set total
 * size, as `application/json` or as `text/event-stream`, so the client's own work is what is timed, not a server's.
 * Each client arm runs in a fresh child process and reports, per (mode, method, size, in flight): per-call p50/p99
 * latency in µs, process CPU per call in µs (all threads: Bun's fetch runs its HTTP on its own), peak RSS (sampled
 * every 2 ms while the cell runs) and the heap left right after it, before any forced GC (what the cell allocated and
 * had not yet collected); and once, the time from process start to the first call's answer (imports, `initialize`,
 * the call).
 *
 * Arms: `eden` (this tree's `src/mcp`), `d1704` (the client as D1704 shipped it, frozen in `bench/mcp-d1704/`), `sdk`
 * (`@modelcontextprotocol/sdk`'s Client and StreamableHTTPClientTransport), and `fetch` (one bare POST and parse per
 * call, with no MCP session, bounds or checks: the floor). Arms interleave in each round (the order rotates), and the
 * summary is the median over rounds. Three rounds of the four arms take about 50 minutes on 4 cores.
 *
 *   env -u BUN_OPTIONS bun packages/sources/bench/mcp-profile.bench.ts [rounds=3] [arms=eden,d1704,sdk,fetch] [quick]
 *
 * `quick` runs 1 KB and 64 KB only. 4 MB is run at 1 and 16 in flight only (256 at once would hold 1 GiB of replies).
 */
type Arm = "eden" | "d1704" | "sdk" | "fetch";
type Mode = "json" | "sse";
type Method = "call" | "list";

// The largest stays under the 4 MiB caps on a `tools/list` reply and on one SSE event, envelope included.
const SIZES = [1024, 65_536, 1_048_576, 4_000_000];
const INFLIGHT = [1, 16, 256];

/** Calls timed for one cell: enough for a p99 at small sizes, bounded in bytes at large ones. */
function callsFor(size: number, inflight: number): number {
  const byBytes = Math.floor((256 * 1_048_576) / size);
  return Math.max(inflight * 4, Math.min(2_000, byBytes));
}

// ---------------------------------------------------------------------------------------------------------------------
// The canned server: one process, replies built once per (mode, method, size) around the request's id.

function server(): void {
  const enc = new TextEncoder();
  const cache = new Map<string, [Uint8Array, Uint8Array]>();
  const body = (method: string, size: number): string => {
    if (method === "tools/list") {
      // Tools of about 1 KB each (a description of the rest), up to `size` bytes in all.
      const n = Math.max(1, Math.round(size / 1024));
      const desc = "d".repeat(Math.max(0, Math.round(size / n) - 120));
      const tools = Array.from({ length: n }, (_, i) => ({
        name: `tool_${i}`,
        description: desc,
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
      }));
      return JSON.stringify({ tools });
    }
    return JSON.stringify({ content: [{ type: "text", text: "x".repeat(size) }] });
  };
  const parts = (mode: string, method: string, size: number): [Uint8Array, Uint8Array] => {
    const key = `${mode}/${method}/${size}`;
    let p = cache.get(key);
    if (!p) {
      const result = body(method, size);
      const pre = `{"result":${result},"jsonrpc":"2.0","id":`;
      p =
        mode === "sse"
          ? [enc.encode(`event: message\ndata: ${pre}`), enc.encode("}\n\n")]
          : [enc.encode(pre), enc.encode("}")];
      cache.set(key, p);
    }
    return p;
  };
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      // The SDK's client opens a standalone GET stream; this server offers none, as the spec allows.
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const [, mode, sizeText] = new URL(req.url).pathname.split("/");
      const text = await req.text();
      const msg = JSON.parse(text) as { id?: number; method?: string; params?: { protocolVersion?: string } };
      if (msg.id === undefined || msg.method === undefined) return new Response(null, { status: 202 });
      const id = String(msg.id);
      const type = mode === "sse" ? "text/event-stream" : "application/json";
      if (msg.method === "initialize") {
        const result = JSON.stringify({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "canned", version: "1" },
        });
        const json = `{"jsonrpc":"2.0","id":${id},"result":${result}}`;
        return new Response(mode === "sse" ? `event: message\ndata: ${json}\n\n` : json, {
          headers: { "content-type": type, "mcp-session-id": "canned-session" },
        });
      }
      const [pre, post] = parts(mode!, msg.method, Number(sizeText));
      const idBytes = enc.encode(id);
      const out = new Uint8Array(pre.length + idBytes.length + post.length);
      out.set(pre, 0);
      out.set(idBytes, pre.length);
      out.set(post, pre.length + idBytes.length);
      return new Response(out, { headers: { "content-type": type } });
    },
  });
  console.log(http.port);
}

// ---------------------------------------------------------------------------------------------------------------------
// One client arm in its own process.

interface Cell {
  mode: Mode;
  method: Method;
  size: number;
  inflight: number;
  p50: number;
  p99: number;
  cpu: number;
  rssMb: number;
  heapMb: number;
}

interface Client {
  list(): Promise<unknown>;
  call(): Promise<unknown>;
  close(): Promise<void>;
}

async function open(arm: Arm, url: string): Promise<Client> {
  if (arm === "fetch") {
    // The floor: one bare POST per call, its reply read with `text()` and parsed (SSE framing cut by hand), with no
    // MCP session, id matching, bounds or checks.
    let id = 0;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const post = async (method: string) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: { name: "search" } });
      const text = await (await fetch(url, { method: "POST", headers, body })).text();
      return JSON.parse(text.startsWith("event:") ? text.slice(text.indexOf("data: ") + 6) : text);
    };
    await post("initialize");
    return { list: () => post("tools/list"), call: () => post("tools/call"), close: async () => {} };
  }
  if (arm === "sdk") {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const c = new Client({ name: "bench", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    return {
      list: () => c.listTools(),
      call: () => c.callTool({ name: "search", arguments: { query: "budget" } }),
      close: () => c.close(),
    };
  }
  const mod =
    arm === "eden"
      ? await import("../src/mcp")
      : { ...(await import("./mcp-d1704/client")), ...(await import("./mcp-d1704/http")) };
  const c = new mod.McpClient({ name: "bench", version: "0" });
  await c.connect(new mod.StreamableHttpTransport(new URL(url)));
  return {
    list: () => c.listTools(),
    call: () => c.callTool({ name: "search", arguments: { query: "budget" } }),
    close: () => c.close(),
  };
}

async function child(arm: Arm, port: number, quick: boolean): Promise<void> {
  const quantile = (xs: Float64Array, p: number) => xs.slice().sort()[Math.floor(p * (xs.length - 1))]!;
  // Time to first call: from process start (performance.timeOrigin) to the first answer, imports included.
  const first = await open(arm, `http://127.0.0.1:${port}/json/1024/mcp`);
  await first.call();
  const firstCallMs = performance.now();
  await first.close();
  const cells: Cell[] = [];
  for (const mode of ["json", "sse"] as Mode[]) {
    for (const size of quick ? SIZES.slice(0, 2) : SIZES) {
      const client = await open(arm, `http://127.0.0.1:${port}/${mode}/${size}/mcp`);
      for (const method of ["call", "list"] as Method[]) {
        const f = method === "call" ? client.call : client.list;
        for (const inflight of INFLIGHT) {
          if (size > 1_048_576 && inflight > 16) continue;
          const calls = callsFor(size, inflight);
          // Warm: a tenth of the calls, at the same concurrency.
          await run(f, Math.max(inflight, Math.floor(calls / 10)), inflight);
          Bun.gc(true);
          let peak = process.memoryUsage.rss();
          const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 2);
          const cpu0 = process.cpuUsage();
          const lat = await run(f, calls, inflight);
          const cpu = process.cpuUsage(cpu0);
          clearInterval(sampler);
          const heap = process.memoryUsage().heapUsed;
          cells.push({
            mode,
            method,
            size,
            inflight,
            p50: quantile(lat, 0.5),
            p99: quantile(lat, 0.99),
            cpu: (cpu.user + cpu.system) / calls,
            rssMb: Math.max(peak, process.memoryUsage.rss()) / 2 ** 20,
            heapMb: heap / 2 ** 20,
          });
        }
      }
      await client.close();
    }
  }
  console.log(JSON.stringify({ firstCallMs, cells }));
  process.exit(0);
}

/** `calls` calls with `inflight` at once, each one's latency in µs. */
async function run(f: () => Promise<unknown>, calls: number, inflight: number): Promise<Float64Array> {
  const lat = new Float64Array(calls);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < calls; i = next++) {
      const t = Bun.nanoseconds();
      await f();
      lat[i] = (Bun.nanoseconds() - t) / 1_000;
    }
  };
  await Promise.all(Array.from({ length: inflight }, worker));
  return lat;
}

// ---------------------------------------------------------------------------------------------------------------------

async function main(rounds: number, arms: Arm[], quick: boolean): Promise<void> {
  const srv = Bun.spawn([process.execPath, import.meta.path, "--server"], { stdout: "pipe", stderr: "inherit" });
  const reader = srv.stdout.getReader();
  const { value } = await reader.read();
  const port = Number(new TextDecoder().decode(value).trim());
  const runs: { arm: Arm; firstCallMs: number; cells: Cell[] }[] = [];
  for (let round = 0; round < rounds; round++) {
    const order = arms.map((_, i) => arms[(i + round) % arms.length]!);
    for (const arm of order) {
      const p = Bun.spawn([process.execPath, import.meta.path, "--child", arm, String(port), quick ? "quick" : ""], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      const r = JSON.parse(out.trim().split("\n").pop()!) as { firstCallMs: number; cells: Cell[] };
      runs.push({ arm, ...r });
      console.error(`round ${round} ${arm}: first call ${r.firstCallMs.toFixed(1)} ms`);
    }
  }
  srv.kill();
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const firstCall = Object.fromEntries(
    arms.map((a) => [a, r1(median(runs.filter((r) => r.arm === a).map((r) => r.firstCallMs)))]),
  );
  const keyOf = (c: Cell) => `${c.mode} ${c.method} ${c.size} x${c.inflight}`;
  const rows: Record<string, Record<string, string>> = {};
  for (const arm of arms) {
    const mine = runs.filter((r) => r.arm === arm);
    for (const c of mine[0]!.cells) {
      const same = mine.map((r) => r.cells.find((x) => keyOf(x) === keyOf(c))!);
      const m = (k: keyof Cell) => r1(median(same.map((x) => x[k] as number)));
      (rows[keyOf(c)] ??= {})[arm] =
        `p50 ${m("p50")} p99 ${m("p99")} cpu ${m("cpu")} rss ${m("rssMb")} heap ${m("heapMb")}`;
    }
  }
  console.log(JSON.stringify({ rounds, firstCallMs: firstCall, cells: rows }, null, 1));
}

const argv = process.argv.slice(2);
if (argv[0] === "--server") server();
else if (argv[0] === "--child") await child(argv[1] as Arm, Number(argv[2]), argv[3] === "quick");
else await main(Number(argv[0] ?? 3), (argv[1] ?? "eden,d1704,sdk,fetch").split(",") as Arm[], argv[2] === "quick");
