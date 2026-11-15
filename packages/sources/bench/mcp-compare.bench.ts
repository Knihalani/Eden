/**
 * Eden's MCP client against other MCP clients, on the same local servers (D1860,
 * `docs/research/mcp-vs-alternatives.md`): speed (CPU and latency per call, peak RSS, at 1 KB, 64 KB and 1 MB, JSON
 * and SSE replies, 1, 16 and 256 in flight, on the canned server of `mcp-profile.bench.ts`), the time from process
 * start to the first call's answer, and how each client takes the hostile replies of `src/mcp/adversarial.test.ts`
 * (a hostile server here, local only).
 *
 * The other clients are not Eden's dependencies: install each in its own empty directory under one root, with its
 * install scripts off, and point `MCP_ALT_DIR` at that root. Nothing is run from inside those directories.
 *
 *   <root>/sdk-v2      npm install --ignore-scripts @modelcontextprotocol/client@2.4.0
 *   <root>/pi-mcp      npm install --ignore-scripts @earendil-works/pi-mcp@1.5.2
 *   <root>/ai-sdk-mcp  npm install --ignore-scripts @ai-sdk/mcp@2.0.99 zod@4.6.7
 *   <root>/py-mcp/venv python3 -I -m venv venv && venv/bin/python -I -m pip install mcp   (2.3.0 here)
 *
 *   MCP_ALT_DIR=<root> env -u BUN_OPTIONS bun packages/sources/bench/mcp-compare.bench.ts perf [rounds=3] [arms]
 *   MCP_ALT_DIR=<root> env -u BUN_OPTIONS bun packages/sources/bench/mcp-compare.bench.ts hostile [arms]
 *
 * Arms: `eden` (this tree), `sdk` (`@modelcontextprotocol/sdk` 1.x, Eden's devDependency), `sdk2`, `pi`, `aisdk`,
 * `python` (`mcp-compare-client.py` under the venv's Python, `-I`). Every JavaScript arm runs under Bun.
 */
import { spawn } from "node:child_process";

type ArmName = "eden" | "sdk" | "sdk2" | "pi" | "aisdk" | "python";
const ALL: ArmName[] = ["eden", "sdk", "sdk2", "pi", "aisdk", "python"];
const ALT = process.env.MCP_ALT_DIR ?? "";
const HERE = new URL(".", import.meta.url).pathname;

/** Sent on every request, so the redirect case can see where it goes. */
const SECRET_HEADERS = { authorization: "Bearer canary-token", "x-api-key": "canary-key" };

interface Opened {
  call(): Promise<unknown>;
  close(): Promise<void>;
}

/** Connects one client to `url`, with the canary headers and a per-call timeout where the client takes one. */
async function open(arm: ArmName, url: string, timeoutMs: number): Promise<Opened> {
  const args = { query: "budget" };
  if (arm === "eden") {
    const { McpClient, StreamableHttpTransport } = await import("../src/mcp");
    const c = new McpClient({ name: "bench", version: "0" });
    await c.connect(new StreamableHttpTransport(new URL(url), { headers: SECRET_HEADERS }));
    return { call: () => c.callTool({ name: "search", arguments: args }, { timeoutMs }), close: () => c.close() };
  }
  if (arm === "sdk" || arm === "sdk2") {
    const mod =
      arm === "sdk"
        ? {
            ...(await import("@modelcontextprotocol/sdk/client/index.js")),
            ...(await import("@modelcontextprotocol/sdk/client/streamableHttp.js")),
          }
        : await import(`${ALT}/sdk-v2/node_modules/@modelcontextprotocol/client/dist/index.mjs`);
    const c = new mod.Client({ name: "bench", version: "0" });
    await c.connect(new mod.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: SECRET_HEADERS } }));
    return {
      // 1.x takes (params, resultSchema, options); 2.x takes (params, options).
      call: () =>
        arm === "sdk"
          ? c.callTool({ name: "search", arguments: args }, undefined, { timeout: timeoutMs })
          : c.callTool({ name: "search", arguments: args }, { timeout: timeoutMs }),
      close: () => c.close(),
    };
  }
  if (arm === "pi") {
    const mod = await import(`${ALT}/pi-mcp/node_modules/@earendil-works/pi-mcp/dist/index.js`);
    const c = new mod.McpClient({ name: "bench", version: "0" });
    await c.connect(new mod.StreamableHttpTransport({ url, headers: SECRET_HEADERS }));
    return { call: () => c.callTool("search", args, { timeoutMs }), close: () => c.close() };
  }
  if (arm === "aisdk") {
    const mod = await import(`${ALT}/ai-sdk-mcp/node_modules/@ai-sdk/mcp/dist/index.js`);
    const c = await mod.createMCPClient({ transport: { type: "http", url, headers: SECRET_HEADERS } });
    return {
      call: () => c.callTool({ name: "search", arguments: args, options: { signal: AbortSignal.timeout(timeoutMs) } }),
      close: () => c.close(),
    };
  }
  throw new Error(`no JavaScript arm ${arm}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Speed: one arm in its own process, against the canned server.

const SIZES = (process.env.MCP_COMPARE_SIZES ?? "1024,65536,1048576").split(",").map(Number);
const INFLIGHT = [1, 16, 256];
/**
 * The shapes of the result's text (`mcp-profile.bench.ts`'s `TEXT_SHAPES`: plain, lines, escapes, unicode, numbers) and
 * the reply modes, each a list; a cell's key starts with its shape. `MCP_COMPARE_TEXT` defaults to plain alone, and
 * `MCP_COMPARE_SIZES` picks the sizes.
 */
const SHAPES = (process.env.MCP_COMPARE_TEXT ?? "plain").split(",");
const MODES = (process.env.MCP_COMPARE_MODES ?? "json,sse").split(",");
const callsFor = (size: number, inflight: number) =>
  Math.max(inflight * 4, Math.min(2_000, Math.floor((256 * 1_048_576) / size)));

interface Cell {
  key: string;
  p50: number;
  p99: number;
  cpu: number;
  rssMb: number;
  error?: string;
}

async function perfChild(arm: ArmName, port: number): Promise<void> {
  const first = await open(arm, `http://127.0.0.1:${port}/json/1024/plain/mcp`, 60_000);
  await first.call();
  process.stdout.write("first\n");
  await first.close();
  const cells: Cell[] = [];
  const quantile = (xs: Float64Array, p: number) => xs.slice().sort()[Math.floor(p * (xs.length - 1))]!;
  for (const shape of SHAPES) {
    for (const mode of MODES) {
      for (const size of SIZES) {
        const c = await open(arm, `http://127.0.0.1:${port}/${mode}/${size}/${shape}/mcp`, 120_000);
        for (const inflight of INFLIGHT) {
          const key = `${shape} ${mode} ${size} x${inflight}`;
          const calls = callsFor(size, inflight);
          try {
            await run(c.call, Math.max(inflight, Math.floor(calls / 10)), inflight);
            Bun.gc(true);
            let peak = process.memoryUsage.rss();
            const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 2);
            const cpu0 = process.cpuUsage();
            const lat = await run(c.call, calls, inflight);
            const cpu = process.cpuUsage(cpu0);
            clearInterval(sampler);
            cells.push({
              key,
              p50: quantile(lat, 0.5),
              p99: quantile(lat, 0.99),
              cpu: (cpu.user + cpu.system) / calls,
              rssMb: Math.max(peak, process.memoryUsage.rss()) / 2 ** 20,
            });
          } catch (e) {
            cells.push({ key, p50: 0, p99: 0, cpu: 0, rssMb: 0, error: String(e).slice(0, 200) });
          }
        }
        await c.close();
      }
    }
  }
  console.log(JSON.stringify({ cells }));
  process.exit(0);
}

async function run(f: () => Promise<unknown>, calls: number, inflight: number): Promise<Float64Array> {
  const lat = new Float64Array(calls);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < calls; i = next++) {
      const t = performance.now();
      await f();
      lat[i] = (performance.now() - t) * 1_000;
    }
  };
  await Promise.all(Array.from({ length: inflight }, worker));
  return lat;
}

/** Runs one arm's child; returns its stdout's last line and the time from spawn to its `first` line. */
function child(arm: ArmName, argv: string[], killAfterMs: number) {
  const [cmd, ...pre] =
    arm === "python"
      ? [`${ALT}/py-mcp/venv/bin/python`, "-I", `${HERE}mcp-compare-client.py`]
      : [process.execPath, import.meta.path];
  const t0 = performance.now();
  const p = spawn(cmd!, [...pre, ...argv, ...(arm === "python" ? [] : [arm])], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BUN_OPTIONS: "" },
  });
  let out = "";
  let err = "";
  let firstMs = NaN;
  let peakRss = 0;
  const sample = setInterval(() => {
    // The child's own RSS from /proc, so every arm (Python too) is read the same way, from outside.
    try {
      const status = require("node:fs").readFileSync(`/proc/${p.pid}/status`, "utf8") as string;
      const kb = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0);
      peakRss = Math.max(peakRss, kb / 1024);
    } catch {}
  }, 20);
  p.stdout.on("data", (d) => {
    out += d;
    if (Number.isNaN(firstMs) && out.includes("first\n")) firstMs = performance.now() - t0;
  });
  p.stderr.on("data", (d) => (err = (err + d).slice(-2_000)));
  const killer = setTimeout(() => p.kill("SIGKILL"), killAfterMs);
  return new Promise<{
    last: string;
    firstMs: number;
    ms: number;
    code: number | null;
    signal: string | null;
    err: string;
    peakRssMb: number;
  }>((resolve) =>
    p.on("close", (code, signal) => {
      clearTimeout(killer);
      clearInterval(sample);
      const lines = out.trim().split("\n");
      resolve({
        last: lines[lines.length - 1] ?? "",
        firstMs,
        ms: performance.now() - t0,
        code,
        signal,
        err,
        peakRssMb: peakRss,
      });
    }),
  );
}

/** Starts a server process (this file's `--hostile` or the profile bench's canned one) and returns its port. */
async function serverProcess(argv: string[]): Promise<{ port: number; kill(): void }> {
  const p = spawn(process.execPath, argv, {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, BUN_OPTIONS: "" },
  });
  const port = await new Promise<number>((resolve) => p.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
  return { port, kill: () => p.kill() };
}

async function perfMain(rounds: number, arms: ArmName[]): Promise<void> {
  const srv = await serverProcess([`${HERE}mcp-profile.bench.ts`, "--server"]);
  const runs: { arm: ArmName; firstMs: number; cells: Cell[] }[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const arm of arms.map((_, i) => arms[(i + r) % arms.length]!)) {
      const res = await child(arm, ["--perf", String(srv.port)], 30 * 60_000);
      try {
        runs.push({ arm, firstMs: res.firstMs, cells: (JSON.parse(res.last) as { cells: Cell[] }).cells });
        console.error(`round ${r} ${arm}: first call ${res.firstMs.toFixed(0)} ms`);
      } catch {
        console.error(`round ${r} ${arm}: failed (${res.code ?? res.signal}) ${res.err.slice(-300)}`);
      }
    }
  }
  srv.kill();
  const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const out: Record<string, unknown> = {};
  for (const arm of arms) {
    const mine = runs.filter((x) => x.arm === arm);
    if (mine.length === 0) continue;
    const cells: Record<string, string> = {};
    for (const c of mine[0]!.cells) {
      const same = mine.map((x) => x.cells.find((y) => y.key === c.key)!).filter((y) => !y.error);
      if (same.length === 0) {
        cells[c.key] = `error ${c.error}`;
        continue;
      }
      const m = (k: "p50" | "p99" | "cpu" | "rssMb") => Math.round(med(same.map((y) => y[k])) * 10) / 10;
      cells[c.key] = `cpu ${m("cpu")} p50 ${m("p50")} p99 ${m("p99")} rss ${m("rssMb")}`;
    }
    out[arm] = { firstCallMs: Math.round(med(mine.map((x) => x.firstMs))), cells };
  }
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------------------------------------------------------------
// Hostile replies, each against a fresh client process. Every case answers `initialize` normally and is hostile on
// `tools/call` only. Each call has a 5 s timeout where the client takes one; the child is killed at 30 s.

const CASES = [
  "oversized-json", // 128 MiB JSON body with its Content-Length
  "oversized-sse", // an SSE line that never ends, up to 512 MiB
  "slow-drip", // an SSE stream of one comment every 250 ms, never the response
  "sse-junk", // 2,000,000 junk events, then the response
  "request-flood", // 20,000 server requests (ping and sampling) on the stream, then the response
  "redirect", // 307 to another origin, which answers the call
  "malformed", // `{not json` as application/json
  "deep-json", // 1,000,000 nested arrays
] as const;

function hostileServer(): void {
  const enc = new TextEncoder();
  const posts = new Map<string, number>();
  const leaked = new Map<string, string[]>();
  const answer = (id: unknown, text = "ok") =>
    JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
  // The other origin a redirect points at: records which canary headers arrive, and answers the call.
  const other = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const got = [
        req.headers.get("authorization") ? "authorization" : "",
        req.headers.get("x-api-key") ? "x-api-key" : "",
      ];
      leaked.set("redirect", got.filter(Boolean));
      const msg = (await req.json().catch(() => ({}))) as { id?: unknown };
      return new Response(answer(msg.id, "followed"), { headers: { "content-type": "application/json" } });
    },
  });
  // 128 MiB of result, built once; the request's id goes after it (`"id"` last), so every client's call is answered.
  const big = enc.encode(
    `{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"${"x".repeat(128 * 1024 * 1024)}"}]},"id":`,
  );
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.slice(1);
      if (path.startsWith("stats/")) {
        // Read once per client: the counts start over for the next.
        const c = path.slice(6);
        const stats = { posts: posts.get(c) ?? 0, leaked: leaked.get(c) ?? [] };
        posts.delete(c);
        leaked.delete(c);
        return Response.json(stats);
      }
      if (req.method !== "POST") return new Response(null, { status: 405 });
      posts.set(path, (posts.get(path) ?? 0) + 1);
      const msg = (await req.json().catch(() => ({}))) as {
        id?: unknown;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (msg.method === "initialize") {
        const result = {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "hostile", version: "1" },
        };
        return Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers: { "mcp-session-id": "h1" } });
      }
      if (msg.method !== "tools/call") {
        // Notifications and the client's answers to server requests are accepted; any other request answered empty.
        if (msg.id === undefined || msg.method === undefined) return new Response(null, { status: 202 });
        return Response.json({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
      }
      const id = msg.id;
      // An event stream pulled from a generator: one piece per pull, so a client that stops reading stops the server.
      const sse = (gen: () => AsyncGenerator<string>) => {
        const it = gen();
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(ctl) {
              const { value, done } = await it.next();
              if (done) ctl.close();
              else ctl.enqueue(enc.encode(value));
            },
            cancel() {
              void it.return(undefined);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      switch (path as (typeof CASES)[number]) {
        case "oversized-json":
          return new Response(new Blob([big, `${JSON.stringify(id)}}`]), {
            headers: { "content-type": "application/json" },
          });
        case "oversized-sse":
          return sse(async function* () {
            const chunk = "x".repeat(65_536);
            yield "event: message\ndata: ";
            for (let sent = 0; sent < 512 * 1024 * 1024; sent += chunk.length) yield chunk;
          });
        case "slow-drip":
          return sse(async function* () {
            for (let i = 0; i < 400; i++) {
              yield ": drip\n";
              await Bun.sleep(250);
            }
          });
        case "sse-junk":
          return sse(async function* () {
            const block = "data: x\n\n".repeat(10_000);
            for (let i = 0; i < 200; i++) yield block;
            yield `data: ${answer(id)}\n\n`;
          });
        case "request-flood":
          return sse(async function* () {
            let block = "";
            for (let i = 0; i < 20_000; i++) {
              const method = i % 2 ? "ping" : "sampling/createMessage";
              block += `data: ${JSON.stringify({ jsonrpc: "2.0", id: `s${i}`, method, params: {} })}\n\n`;
              if (block.length > 60_000) {
                yield block;
                block = "";
              }
            }
            yield `${block}data: ${answer(id)}\n\n`;
          });
        case "redirect":
          return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/mcp` } });
        case "malformed":
          return new Response("{not json", { headers: { "content-type": "application/json" } });
        case "deep-json":
          return new Response(
            `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${"[".repeat(1_000_000)}${"]".repeat(1_000_000)}}`,
            {
              headers: { "content-type": "application/json" },
            },
          );
      }
      return new Response("no case", { status: 404 });
    },
  });
  console.log(http.port);
}

async function caseChild(arm: ArmName, port: number, name: string): Promise<void> {
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  let outcome: string;
  try {
    const c = await open(arm, `http://127.0.0.1:${port}/${name}`, 5_000);
    try {
      const r = (await c.call()) as { content?: { text?: string }[] } | undefined;
      const text = r?.content?.[0]?.text ?? "";
      outcome = `answered (${text.length > 20 ? `${text.length} chars` : text || "empty"})`;
    } catch (e) {
      outcome = `error: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
    }
    void c.close().catch(() => {});
  } catch (e) {
    outcome = `connect error: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
  }
  const cpu = process.cpuUsage(cpu0);
  console.log(
    JSON.stringify({
      outcome,
      ms: Math.round(performance.now() - t0),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      // The process's peak RSS (kB on Linux), read by the process itself so a short run is not missed.
      maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    }),
  );
  process.exit(0);
}

async function hostileMain(arms: ArmName[]): Promise<void> {
  const srv = await serverProcess([import.meta.path, "--hostile"]);
  const rows: Record<string, Record<string, unknown>> = {};
  for (const name of process.env.MCP_COMPARE_CASES?.split(",") ?? CASES) {
    for (const arm of arms) {
      const res = await child(arm, ["--case", String(srv.port), name], 30_000);
      const stats = (await (await fetch(`http://127.0.0.1:${srv.port}/stats/${name}`)).json()) as {
        posts: number;
        leaked: string[];
      };
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(res.last) as Record<string, unknown>;
      } catch {
        r = {
          outcome: res.signal === "SIGKILL" ? "hung: killed at 30 s" : `crashed (${res.code ?? res.signal})`,
          stderr: res.err.slice(-200),
        };
      }
      // Posts counted by the case's path: initialize, initialized, the call, and every answer to a server request.
      (rows[name] ??= {})[arm] = {
        ...r,
        // A killed child cannot report its own peak: the parent's sampling of /proc stands in.
        maxRssMb: r.maxRssMb ?? Math.round(res.peakRssMb),
        posts: stats.posts,
        leaked: stats.leaked,
      };
      console.error(name, arm, JSON.stringify(rows[name]![arm]));
    }
  }
  srv.kill();
  console.log(JSON.stringify(rows, null, 1));
}

const argv = process.argv.slice(2);
if (argv[0] === "--hostile") hostileServer();
else if (argv[0] === "--perf") await perfChild(argv[2] as ArmName, Number(argv[1]));
else if (argv[0] === "--case") await caseChild(argv[3] as ArmName, Number(argv[1]), argv[2]!);
else if (argv[0] === "perf") await perfMain(Number(argv[1] ?? 3), (argv[2]?.split(",") as ArmName[]) ?? ALL);
else if (argv[0] === "hostile") await hostileMain((argv[1]?.split(",") as ArmName[]) ?? ALL);
else console.error("usage: mcp-compare.bench.ts perf [rounds] [arms] | hostile [arms]");
