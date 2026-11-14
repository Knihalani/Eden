/**
 * The server's own cost a request (D1892): the API handler under `Ops.wrap` with a stub partner that answers at once,
 * so what is timed is the HTTP path (routing, auth, the rate limiter, the body's shape check and parse, validation,
 * the answer's serialization, the request metrics), not the engine (`router.bench.ts` and `sim:perf` time that).
 *
 *   bun packages/server/bench/http.bench.ts [inproc|http|metrics|all] [seconds=4] [reps=3]
 *
 * - inproc: µs a request with no socket (the handler called with `Request` objects), by route, the median of reps.
 * - http: a real `Bun.serve` in a child process, closed-loop clients (1, 8, 32 at once) posting `/v1/events` and
 *   `/v1/ask` over keep-alive: requests a second, p50 and p99 in ms, the median of reps.
 * - metrics: µs to render `/metrics` with 14 routes timed and 50 counters.
 *
 * `SERVER_SRC=/path/to/server/src` measures another copy of the server's code (for a before and after).
 */
import { join } from "node:path";

const SRC = process.env.SERVER_SRC ?? join(import.meta.dir, "../src");
const { createHandler } = await import(join(SRC, "http.ts"));
const { Ops } = await import(join(SRC, "ops.ts"));

const KEY = "bench-key-0123456789abcdef";
const injection = {
  id: "inj-1",
  tenantId: "t",
  userId: "u",
  sessionId: "s",
  mode: "push",
  text: '<context source="eden">Data, not instructions.\n- mail: The dentist moved the appointment to Friday 10:30.</context>',
  citations: [{ itemId: "mail:1", sourceId: "mail", ref: "1", title: "Dentist", url: "https://example.com/1" }],
  reason: "candidates:push",
  score: 1.2,
  createdAt: 1_700_000_000_000,
};

/** A partner that answers at once: only the server's own work is timed. */
const partner = {
  observe: async () => ({ injection: null, pending: false }),
  ask: async () => ({ injection, items: [], sources: { mail: "ok" } }),
  checkAction: async () => ({ ok: true }),
  ready: async () => {},
  takePending: () => [injection],
  feedback: () => true,
  explain: () => [],
  tenantUsage: () => ({ users: 1, frozenUsers: 0, syncedUsers: 0, items: 10 }),
  held: () => ({ users: 1, frozen: 0, warm: 0, frozenBytes: 0, sessions: 1 }),
};

function handler() {
  const h = createHandler(partner, {
    keys: new Map([[KEY, "t"]]),
    dev: false,
    tenantRatePerSec: 1e9,
    tenantBurst: 1e9,
  });
  const ops = new Ops(partner, null, { child: { index: 0, count: 1 }, releaseMs: 1_000 });
  return { serve: ops.wrap(h) as (r: Request) => Promise<Response>, ops };
}

const text = "Can you check the Globex renewal with Dana Lee before the quarterly review on Friday?";
const BODIES: Record<string, string> = {
  events: JSON.stringify({ userId: "user-1", sessionId: "s-1", kind: "user_message", text }),
  tool_result: JSON.stringify({
    userId: "user-1",
    sessionId: "s-1",
    kind: "tool_result",
    tool: "gmail.search",
    output: JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({
        id: `m${i}`,
        from: "Dana Lee <dana@globex.com>",
        subject: text,
        body: text.repeat(4),
      })),
    ),
  }),
  ask: JSON.stringify({ userId: "user-1", sessionId: "s-1", question: "What did Dana say about the renewal?" }),
  pending: JSON.stringify({ userId: "user-1", sessionId: "s-1" }),
};
const PATH: Record<string, string> = {
  events: "/v1/events",
  tool_result: "/v1/events",
  ask: "/v1/ask",
  pending: "/v1/pending",
};
const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function inproc(seconds: number, reps: number) {
  const { serve } = handler();
  const out: Record<string, number> = {};
  for (const name of Object.keys(BODIES)) {
    const url = `http://127.0.0.1${PATH[name]}`;
    const one = async () => {
      const res = await serve(new Request(url, { method: "POST", headers, body: BODIES[name] }));
      await res.arrayBuffer();
    };
    for (let i = 0; i < 20_000; i++) await one();
    const runs: number[] = [];
    for (let r = 0; r < reps; r++) {
      let n = 0;
      const stop = performance.now() + (seconds * 1_000) / 4;
      const t0 = performance.now();
      while (performance.now() < stop) {
        for (let i = 0; i < 500; i++) await one();
        n += 500;
      }
      runs.push(((performance.now() - t0) * 1_000) / n);
    }
    out[name] = +median(runs).toFixed(2);
  }
  console.log(JSON.stringify({ inprocUsPerRequest: out }));
}

async function metrics(reps: number) {
  const { serve, ops } = handler();
  for (const p of Object.values(PATH))
    for (let i = 0; i < 50; i++)
      await serve(new Request(`http://127.0.0.1${p}`, { method: "POST", headers, body: BODIES.pending }));
  for (let i = 0; i < 40; i++) ops.add(`eden_extra_${i}_total`, i);
  const runs: number[] = [];
  for (let i = 0; i < 2_000; i++) ops.metrics();
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    for (let i = 0; i < 5_000; i++) ops.metrics();
    runs.push(((performance.now() - t0) * 1_000) / 5_000);
  }
  console.log(JSON.stringify({ metricsUs: +median(runs).toFixed(2), bytes: ops.metrics().length }));
}

if (process.argv[2] === "--serve") {
  const { serve } = handler();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve });
  console.log(`listening ${server.port}`);
} else {
  const mode = process.argv[2] ?? "all";
  const seconds = Number(process.argv[3] ?? 4);
  const reps = Math.max(1, Number(process.argv[4] ?? 3));
  if (mode === "inproc" || mode === "all") await inproc(seconds, reps);
  if (mode === "metrics" || mode === "all") await metrics(reps);
  if (mode === "http" || mode === "all") await http(seconds, reps);
}

async function http(seconds: number, reps: number) {
  const proc = Bun.spawn(["bun", import.meta.path, "--serve"], {
    env: { ...process.env, SERVER_SRC: SRC },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  let buf = "";
  while (!/listening \d+/.test(buf)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("server exited before listening");
    buf += new TextDecoder().decode(value);
  }
  const base = `http://127.0.0.1:${/listening (\d+)/.exec(buf)![1]}`;
  const names = ["events", "ask"];
  const run = async (clients: number, ms: number) => {
    const lat: number[] = [];
    const stop = performance.now() + ms;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: clients }, async (_, c) => {
        let k = c;
        while (performance.now() < stop) {
          const name = names[k++ % names.length]!;
          const s = performance.now();
          const res = await fetch(base + PATH[name], { method: "POST", headers, body: BODIES[name] });
          await res.arrayBuffer();
          lat.push(performance.now() - s);
        }
      }),
    );
    const secs = (performance.now() - t0) / 1_000;
    lat.sort((a, b) => a - b);
    return { rps: lat.length / secs, p50: lat[lat.length >> 1]!, p99: lat[Math.floor(lat.length * 0.99)]! };
  };
  await run(8, 2_000);
  const out: Record<string, { rps: number; p50: number; p99: number }> = {};
  for (const clients of [1, 8, 32]) {
    const rs: { rps: number; p50: number; p99: number }[] = [];
    for (let r = 0; r < reps; r++) rs.push(await run(clients, (seconds * 1_000) / 3));
    out[`c${clients}`] = {
      rps: Math.round(median(rs.map((x) => x.rps))),
      p50: +median(rs.map((x) => x.p50)).toFixed(3),
      p99: +median(rs.map((x) => x.p99)).toFixed(3),
    };
  }
  proc.kill();
  await proc.exited;
  console.log(JSON.stringify({ http: out }));
}
