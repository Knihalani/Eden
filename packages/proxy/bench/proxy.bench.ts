/**
 * The proxy's own work a request on a long conversation: a coding agent's tool-using turns replayed through
 * `createProxy` with a stub upstream and a stub Eden that answer at once, so what is timed is the proxy reading the
 * history (which messages are new, the conversation's hashes, packets kept in place), not the model or Eden.
 *
 *   bun packages/proxy/bench/proxy.bench.ts [turns=30] [reps=5] [srcB]
 *
 * Each turn is a user message, three tool rounds (a call with ~1 KB of arguments, a ~6 KB result) and a reply; every
 * model call of the turn is a request (4 a turn), so the last requests carry ~650 KB of history. Prints the µs a
 * request (all requests of the replay, and the last turn's), median of reps. With `srcB` (a directory holding another
 * copy of `proxy.ts`), arms A (this package's src) and B run interleaved, the order alternating each repetition, with
 * a self-vs-self control (A against a second A instance), and their paired ratios are printed.
 */
import { join } from "node:path";

const turns = Number(process.argv[2] ?? 30);
const reps = Math.max(1, Number(process.argv[3] ?? 5));
const srcB = process.argv[4];

type Proxy = (req: Request) => Promise<Response>;
type Make = (o: Record<string, unknown>) => Proxy;
const makeA: Make = (await import(join(import.meta.dir, "../src/proxy.ts"))).createProxy;
const makeB: Make | null = srcB ? (await import(join(srcB, "proxy.ts"))).createProxy : null;

// Eden answers at once: nothing new for the turn, nothing pending (the proxy's EdenClient uses the global fetch).
const EDEN = "http://eden.invalid";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(EDEN)) {
    if (url.includes("/v1/pending")) return Response.json({ injections: [] });
    return Response.json({ injection: null, pending: false });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;
const upstreamFetch = (async () =>
  Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })) as unknown as typeof fetch;

const word = (i: number) => ["renewal", "Globex", "Dana", "invoice", "deploy", "test", "build", "review"][i % 8]!;
const prose = (n: number, seed: number) =>
  Array.from({ length: Math.ceil(n / 8) }, (_, i) => word(i * 7 + seed))
    .join(" ")
    .slice(0, n);

/** The requests of one replay: each model call's whole history. */
function requests(): string[] {
  const messages: Record<string, unknown>[] = [{ role: "system", content: prose(4_000, 1) }];
  const out: string[] = [];
  const send = () => out.push(JSON.stringify({ model: "m", user: "user-1", messages }));
  for (let t = 0; t < turns; t++) {
    messages.push({ role: "user", content: `Turn ${t}: ${prose(300, t)}` });
    send();
    for (let r = 0; r < 3; r++) {
      const id = `call_${t}_${r}`;
      const args = JSON.stringify({ path: `src/file${t}_${r}.ts`, pattern: prose(900, t + r), limit: 200 });
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "grep", arguments: args } }],
      });
      messages.push({ role: "tool", tool_call_id: id, content: prose(6_000, t * 3 + r) });
      send();
    }
    messages.push({ role: "assistant", content: prose(500, t + 11) });
  }
  return out;
}

const bodies = requests();
const perTurn = 4;

async function replay(make: Make): Promise<{ all: number; last: number }> {
  const proxy = make({ upstream: "http://up.invalid/v1", edenUrl: EDEN, fetch: upstreamFetch, waitMs: 0 });
  let total = 0;
  let last = 0;
  for (let i = 0; i < bodies.length; i++) {
    const req = new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodies[i],
    });
    const t0 = performance.now();
    const res = await proxy(req);
    await res.arrayBuffer();
    const dt = performance.now() - t0;
    total += dt;
    if (i >= bodies.length - perTurn) last += dt;
  }
  return { all: (total * 1_000) / bodies.length, last: (last * 1_000) / perTurn };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const forceGc = process.env.BENCH_GC === "1";

await replay(makeA);
if (makeB) await replay(makeB);
const arms: Record<string, { all: number[]; last: number[] }> = { A: { all: [], last: [] }, A2: { all: [], last: [] } };
if (makeB) arms.B = { all: [], last: [] };
const order = Object.keys(arms);
for (let r = 0; r < reps; r++) {
  const slots = r % 2 ? [...order].reverse() : order;
  for (const arm of slots) {
    if (forceGc) Bun.gc(true);
    const got = await replay(arm === "B" ? makeB! : makeA);
    arms[arm]!.all.push(got.all);
    arms[arm]!.last.push(got.last);
  }
}
const summary: Record<string, unknown> = {
  turns,
  requests: bodies.length,
  lastBodyKB: Math.round(bodies.at(-1)!.length / 1024),
};
for (const [arm, v] of Object.entries(arms)) {
  summary[arm] = { usPerRequest: +median(v.all).toFixed(1), usLastTurn: +median(v.last).toFixed(1) };
}
const ratio = (x: number[], y: number[]) => +median(x.map((v, i) => v / y[i]!)).toFixed(3);
summary.controlA2overA = ratio(arms.A2!.all, arms.A!.all);
if (makeB) summary.BoverA = { all: ratio(arms.B!.all, arms.A!.all), last: ratio(arms.B!.last, arms.A!.last) };
console.log(JSON.stringify(summary));
