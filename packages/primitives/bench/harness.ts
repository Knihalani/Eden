/**
 * A minimal benchmark harness: warmup, then timed batches; reports mean and p50/p99 of per-op time across batches.
 * Batching amortizes the cost of reading the clock (performance.now is ~30–50 ns) over many operations.
 */
export interface Result {
  name: string;
  meanNs: number;
  p50Ns: number;
  p99Ns: number;
  opsPerSec: number;
}

let sink: unknown;
/** Keeps results observable so the JIT cannot drop the work. */
export function consume(v: unknown): void {
  sink = v;
}

export function bench(name: string, fn: () => unknown, options: { batch?: number; batches?: number } = {}): Result {
  const batch = options.batch ?? 200;
  const batches = options.batches ?? 200;
  for (let i = 0; i < batch * 20; i++) sink = fn();
  const per: number[] = [];
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) sink = fn();
    per.push(((performance.now() - t0) * 1e6) / batch);
  }
  per.sort((a, b) => a - b);
  const meanNs = per.reduce((s, x) => s + x, 0) / per.length;
  const r = {
    name,
    meanNs,
    p50Ns: per[Math.floor(per.length * 0.5)]!,
    p99Ns: per[Math.floor(per.length * 0.99)]!,
    opsPerSec: 1e9 / meanNs,
  };
  return r;
}

export function report(results: Result[]): void {
  const fmt = (ns: number) => (ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(1)} ns`);
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(width)}  mean ${fmt(r.meanNs).padStart(10)}  p50 ${fmt(r.p50Ns).padStart(10)}  p99 ${fmt(r.p99Ns).padStart(10)}`,
    );
  }
  void sink;
}

/** Deterministic email-like text of about `bytes` characters, optionally with ~10% non-ASCII words. */
export function corpus(bytes: number, options: { nonAscii?: boolean; seed?: number } = {}): string {
  const words = (
    "the renewal call follow up please send sheet revenue thursday tuesday meeting invoice project deadline " +
    "contract pricing discount team offsite flight hotel booking reply draft notes agenda budget quarter review"
  ).split(" ");
  const names = ["Dana Lee", "Priya Raman", "Globex", "Initech", "Bill Lumbergh", "OPS-142", "sam@acme.com"];
  const foreign = ["Zoë", "Müller", "José", "Łukasz", "東京", "Ångström", "naïve", "Søren"];
  let x = options.seed ?? 42;
  const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
  let out = "";
  while (out.length < bytes) {
    const r = rnd();
    let w: string;
    if (options.nonAscii && r < 0.1) w = foreign[Math.floor(rnd() * foreign.length)]!;
    else if (r < 0.2) w = names[Math.floor(rnd() * names.length)]!;
    else w = words[Math.floor(rnd() * words.length)]!;
    out += w + (rnd() < 0.1 ? ". " : " ");
  }
  // Flattened like input from JSON or the network (bench/jsc.bench.ts found reading a rope costs no more).
  return flat(out.slice(0, bytes));
}

/** A flat copy of a string (no rope), as text arriving from JSON or the network would be. */
export function flat(s: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(s));
}
