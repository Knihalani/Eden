/**
 * A mixed server load for judging CPU offload by what users feel, not ns/op: many small events plus bursts of large
 * lookups, on one event loop, as Eden's server runs them.
 *
 * - Small events (one per agent turn, across many users): Poisson arrivals; text 100–1,500 characters; the gate
 *   (`sanitizeForStore`) and tokenizing run on the event loop. Latency = completion − scheduled arrival, so it
 *   includes waiting behind whatever else holds the loop.
 * - Lookups: Poisson arrivals, one in five arriving as a burst of four at once; 32 items each, sizes log-normal
 *   (median 1.2 KB, σ = 1, capped at the cache's 8,000 characters); 10% of items keyword-dense, 3% carrying a
 *   secret. Each item is gated (`gate`, which a strategy may offload) then tokenized on the loop (the index stays
 *   on the loop).
 * - Probe: a 1 ms interval timer; lag = how late each tick fires.
 *
 * Every random choice comes from a seeded generator, so strategies see the same arrivals and the same texts.
 * `lookupsPerSecond` is the rate of lookup *arrivals*; with bursts, lookups run at 1.6 times that.
 */
import { tokenizeInto, Vocab } from "../src/index";
import { corpus } from "./harness";

export type Gate = (texts: string[]) => Promise<string[]>;

export interface LoadConfig {
  seconds: number;
  smallPerSecond: number;
  lookupsPerSecond: number;
  seed: number;
}

export interface LoadResult {
  smallP50: number;
  smallP99: number;
  smallMax: number;
  lookupP50: number;
  lookupP99: number;
  lookupsDone: number;
  lookupsPerSecond: number;
  lagP50: number;
  lagP99: number;
  lagMax: number;
  mainCpuShare: number;
}

function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYWORD_DENSE =
  "Hi Dana, your api key for the staging account was rotated. The new access token is in the vault; do not paste " +
  "the password or the secret into Slack. Auth is via the SSO provider; the client secret and private key stay in " +
  "the KMS. If the token expires, ask Priya for a new key. ";

/** A pool of item texts, built once so building them is not timed. */
function itemTexts(rnd: () => number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    // Log-normal: exp(N(ln 1200, 1)), Box–Muller.
    const z = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const size = Math.max(80, Math.min(8_000, Math.round(1_200 * Math.exp(z))));
    const kind = rnd();
    let text = corpus(size, { seed: i + 1, nonAscii: rnd() < 0.2 });
    if (kind < 0.1) text = KEYWORD_DENSE.repeat(Math.ceil(size / KEYWORD_DENSE.length)).slice(0, size);
    else if (kind < 0.13)
      text = `${text.slice(0, size - 60)} key ${"gh" + "p_"}${"aB3dE5gH7jK9mN2pQ4sT6vW8yZ0123456789"}`;
    out.push(text);
  }
  return out;
}

const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

export async function runLoad(gate: Gate, config: LoadConfig): Promise<LoadResult> {
  const rnd = prng(config.seed);
  const items = itemTexts(rnd, 512);
  // Warm-up, untimed: every item through the strategy's gate once (compiles the rules each text needs, wherever
  // the gate runs, and lets the JIT see it), twice for a pool so each worker likely sees most texts.
  for (let round = 0; round < 2; round++) await gate(items);
  const smalls = Array.from({ length: 256 }, (_, i) => corpus(100 + Math.floor(rnd() * 1_400), { seed: 1_000 + i }));
  const vocab = new Vocab();
  const ids = new Uint32Array(8_192);
  const tokenize = (text: string) => tokenizeInto(text, vocab, true, ids, null);

  // Arrival schedule, in ms from the start.
  const arrivals: { at: number; kind: "small" | "lookup" }[] = [];
  const horizon = config.seconds * 1_000;
  for (let t = 0; t < horizon; t += (-Math.log(rnd() || 1e-9) / config.smallPerSecond) * 1_000) {
    arrivals.push({ at: t, kind: "small" });
  }
  for (let t = 0; t < horizon; t += (-Math.log(rnd() || 1e-9) / config.lookupsPerSecond) * 1_000) {
    const burst = rnd() < 0.2 ? 4 : 1;
    for (let b = 0; b < burst; b++) arrivals.push({ at: t, kind: "lookup" });
  }
  arrivals.sort((a, b) => a.at - b.at);

  const small: number[] = [];
  const lookups: number[] = [];
  const lags: number[] = [];
  let itemAt = 0;
  let smallAt = 0;
  const pending: Promise<void>[] = [];

  const start = performance.now();
  const cpu0 = process.threadCpuUsage();
  let expected = start + 1;
  const probe = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + 1;
  }, 1);

  for (const arrival of arrivals) {
    const due = start + arrival.at;
    const wait = due - performance.now();
    // Timers round down; wait whole milliseconds and never start an arrival before it is due.
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait)));
    if (arrival.kind === "small") {
      const text = smalls[smallAt++ % smalls.length]!;
      // Small events run inline in every strategy: the loop must not wait for a worker on its own turn.
      queueMicrotask(() => {
        tokenize(gateInline(text));
        small.push(performance.now() - due);
      });
    } else {
      const batch = Array.from({ length: 32 }, () => items[itemAt++ % items.length]!);
      pending.push(
        gate(batch).then((gated) => {
          for (const text of gated) tokenize(text);
          lookups.push(performance.now() - due);
        }),
      );
    }
  }
  await Promise.all(pending);
  const wall = performance.now() - start;
  clearInterval(probe);
  const cpu = process.threadCpuUsage(cpu0);
  return {
    smallP50: percentile(small, 0.5),
    smallP99: percentile(small, 0.99),
    smallMax: Math.max(...small),
    lookupP50: percentile(lookups, 0.5),
    lookupP99: percentile(lookups, 0.99),
    lookupsDone: lookups.length,
    lookupsPerSecond: (lookups.length / wall) * 1_000,
    lagP50: percentile(lags, 0.5),
    lagP99: percentile(lags, 0.99),
    lagMax: Math.max(...lags),
    mainCpuShare: (cpu.user + cpu.system) / 1_000 / wall,
  };
}

let gateInline: (text: string) => string = (text) => text;
/** The inline gate small events use (and the inline strategy uses for lookups). */
export function setInlineGate(fn: (text: string) => string): void {
  gateInline = fn;
}

export function row(name: string, r: LoadResult): string {
  const f = (x: number) => x.toFixed(2);
  return (
    `| ${name} | ${f(r.smallP50)} | ${f(r.smallP99)} | ${f(r.smallMax)} | ${f(r.lookupP50)} | ${f(r.lookupP99)} | ` +
    `${r.lookupsPerSecond.toFixed(1)} | ${f(r.lagP50)} | ${f(r.lagP99)} | ${f(r.lagMax)} | ` +
    `${(r.mainCpuShare * 100).toFixed(0)}% |`
  );
}

export const HEADER =
  "| Strategy | small p50 ms | small p99 ms | small max ms | lookup p50 ms | lookup p99 ms | lookups/s | " +
  "lag p50 ms | lag p99 ms | lag max ms | main-thread CPU |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
