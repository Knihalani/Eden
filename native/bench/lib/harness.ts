/**
 * A small timing harness that runs on Bun and Node. Each benchmark warms up, then takes `samples` timed samples;
 * a sample runs the op `inner` times, with `inner` chosen so a sample lasts at least `minSampleNs` (ops slower
 * than that are timed one by one). Mean, p50 and p99 are over the samples' per-op times, so for sub-5 µs ops the
 * percentiles describe batches, not single calls.
 */

declare const Bun: { nanoseconds(): number; version: string } | undefined;

const hrtime = (globalThis as { process?: { hrtime: { bigint(): bigint } } }).process?.hrtime;

/** Nanoseconds from an arbitrary origin. */
export const now: () => number = typeof Bun !== "undefined" ? () => Bun!.nanoseconds() : () => Number(hrtime!.bigint());

export const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`;

/** Results are folded in here so no op can be optimised away. */
export let sink = 0;
export function consume(value: unknown): void {
  sink = (sink + (typeof value === "number" ? value : value ? 1 : 0)) | 0;
}

export interface Stats {
  name: string;
  meanNs: number;
  p50Ns: number;
  p99Ns: number;
  inner: number;
  samples: number;
}

export interface BenchOptions {
  samples?: number;
  warmupMs?: number;
  minSampleNs?: number;
}

export function bench(name: string, op: () => unknown, options: BenchOptions = {}): Stats {
  const samples = options.samples ?? 2000;
  const warmupNs = (options.warmupMs ?? 150) * 1e6;
  const minSampleNs = options.minSampleNs ?? 5000;
  let runs = 0;
  const warmStart = now();
  while (now() - warmStart < warmupNs || runs < 200) {
    consume(op());
    runs++;
  }
  const estimate = (now() - warmStart) / runs;
  const inner = Math.max(1, Math.ceil(minSampleNs / Math.max(estimate, 1)));
  const times = new Float64Array(samples);
  for (let s = 0; s < samples; s++) {
    const start = now();
    for (let k = 0; k < inner; k++) consume(op());
    times[s] = (now() - start) / inner;
  }
  const sorted = Float64Array.from(times).sort();
  const mean = times.reduce((a, b) => a + b, 0) / samples;
  const at = (q: number) => sorted[Math.min(samples - 1, Math.floor(q * samples))]!;
  return { name, meanNs: mean, p50Ns: at(0.5), p99Ns: at(0.99), inner, samples };
}

const fmt = (ns: number, unit: "us" | "ns") => (unit === "us" ? (ns / 1000).toFixed(3) : ns.toFixed(1));

/** Prints rows as a Markdown table, in µs (default) or ns, with optional extra columns. */
export function table(
  title: string,
  rows: (Stats & { extra?: Record<string, string> })[],
  unit: "us" | "ns" = "us",
): void {
  const extras = [...new Set(rows.flatMap((row) => Object.keys(row.extra ?? {})))];
  const u = unit === "us" ? "µs" : "ns";
  console.log(`\n### ${title} (${runtime})\n`);
  console.log(`| case | mean ${u}/op | p50 ${u} | p99 ${u} | ops/sample |${extras.map((e) => ` ${e} |`).join("")}`);
  console.log(`|---|---:|---:|---:|---:|${extras.map(() => "---:|").join("")}`);
  for (const row of rows) {
    const cells = extras.map((e) => ` ${row.extra?.[e] ?? ""} |`).join("");
    const stats = `${fmt(row.meanNs, unit)} | ${fmt(row.p50Ns, unit)} | ${fmt(row.p99Ns, unit)}`;
    console.log(`| ${row.name} | ${stats} | ${row.inner} |${cells}`);
  }
}

/** ns per KiB of input, for per-size comparisons. */
export const perKiB = (ns: number, bytes: number) => ((ns / bytes) * 1024).toFixed(1);
