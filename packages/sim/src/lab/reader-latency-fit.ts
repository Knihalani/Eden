#!/usr/bin/env bun
/**
 * How the reader's latency splits into a fixed floor, input and output (no model call; docs/COST-MODEL.md "Where 3x
 * is impossible"). Fits `latency = floor + a * input tokens + b * output tokens` by least squares, from either:
 *
 * - the train-screens table of docs/research/haiku-phase3.md (default): one row per run, its p50 latency against its
 *   mean input and output tokens. Rows with a range or no tokens ("(replayed)") are left out. A run-level
 *   (ecological) fit: it says how runs differ, not how one call's time is made up.
 * - `--runs FILE`: a funnel log summary (packages/sim/lab/haiku/phase3/funnel-reader-cost.txt), one point per run,
 *   p50 and p90 fitted apart, with and without runs that only replayed another run's calls. Also ecological.
 * - `--replay FILE.jsonl ...`: reader replay caches (`reader-disk.ts` lines), one point per call: usage and
 *   `latencyMs`, with `ttftMs` summarised when the provider streamed it. With cached input in the lines, a second fit
 *   splits input into uncached and cached tokens.
 *
 *   bun packages/sim/src/lab/reader-latency-fit.ts [--md docs/research/haiku-phase3.md | --runs FILE.txt |
 *     --replay a.jsonl b.jsonl] [--at 3921,188]
 *
 * `--at IN,OUT` prints the fit's split for one call shape (default: prompt v7's 3,921 in, 188 out).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface Point {
  input: number;
  output: number;
  cached?: number;
  ms: number;
  ttftMs?: number | null;
  label?: string;
}

export interface Fit {
  /** Coefficients in the order of `names` (the first is the floor, ms). */
  names: string[];
  coef: number[];
  r2: number;
  maxErr: number;
  n: number;
}

const num = (s: string) => Number(s.replace(/,/g, ""));

/** Solves `A x = b` by Gaussian elimination with partial pivoting (A small and square). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) throw new Error("singular fit: too few distinct points");
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Ordinary least squares of `y` on `[1, ...x]`. */
export function leastSquares(xs: number[][], y: number[], names: string[]): Fit {
  const k = xs[0]!.length + 1;
  const ata = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const aty = new Array<number>(k).fill(0);
  xs.forEach((x, i) => {
    const row = [1, ...x];
    for (let r = 0; r < k; r++) {
      aty[r]! += row[r]! * y[i]!;
      for (let c = 0; c < k; c++) ata[r]![c]! += row[r]! * row[c]!;
    }
  });
  const coef = solve(ata, aty);
  const pred = xs.map((x) => coef[0]! + x.reduce((s, v, j) => s + v * coef[j + 1]!, 0));
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = y.reduce((s, v, i) => s + (v - pred[i]!) ** 2, 0);
  const maxErr = Math.max(...y.map((v, i) => Math.abs(v - pred[i]!)));
  return { names: ["floor ms", ...names], coef, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1, maxErr, n: y.length };
}

/** `latency = floor + a * input + b * output`. */
export const fitTokens = (points: Point[]) =>
  leastSquares(
    points.map((p) => [p.input, p.output]),
    points.map((p) => p.ms),
    ["ms / input token", "ms / output token"],
  );

/** Input split into uncached and cached tokens: `floor + a * uncached + c * cached + b * output`. */
export const fitCached = (points: Point[]) =>
  leastSquares(
    points.map((p) => [p.input - (p.cached ?? 0), p.cached ?? 0, p.output]),
    points.map((p) => p.ms),
    ["ms / uncached input token", "ms / cached input token", "ms / output token"],
  );

/**
 * The train-screens rows of a haiku-phase3-style table: the table whose header names "Reader in / out tokens" and
 * "p50 / p90 ms", each row with a single "IN / OUT" and a single "P50 / P90" (rows with a range or none are left out).
 */
export function tableRows(markdown: string): Point[] {
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const pair = /^([\d,]+) \/ ([\d,]+)$/;
  const out: Point[] = [];
  let tok = -1;
  let lat = -1;
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) {
      tok = lat = -1;
      continue;
    }
    const c = cells(line);
    const t = c.findIndex((x) => /in \/ out tokens/i.test(x));
    const l = c.findIndex((x) => /p50 \/ p90 ms/i.test(x));
    if (t >= 0 && l >= 0) {
      tok = t;
      lat = l;
      continue;
    }
    if (tok < 0) continue;
    const tm = pair.exec(c[tok] ?? "");
    const lm = pair.exec(c[lat] ?? "");
    if (!tm || !lm) continue;
    out.push({ input: num(tm[1]!), output: num(tm[2]!), ms: num(lm[1]!), label: c[0] });
  }
  return out;
}

/** One point per call in reader replay caches (`reader-disk.ts` lines; a line with no usage is skipped). */
export function replayRows(text: string): Point[] {
  const out: Point[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const l = JSON.parse(raw) as {
      usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
      latencyMs?: number;
      ttftMs?: number;
    };
    if (!l.usage || typeof l.latencyMs !== "number" || l.latencyMs <= 0) continue;
    out.push({
      input: l.usage.inputTokens ?? 0,
      output: l.usage.outputTokens ?? 0,
      cached: l.usage.cachedInputTokens ?? 0,
      ms: l.latencyMs,
      ttftMs: l.ttftMs ?? null,
    });
  }
  return out;
}

/**
 * One point per run in a funnel log summary such as packages/sim/lab/haiku/phase3/funnel-reader-cost.txt: the
 * reader line's "N sent now", "IN in / OUT out tokens per call" and "p50 X ms, p90 Y ms" (`--runs FILE`).
 */
export function runRows(text: string): (Point & { p90: number; sent: number })[] {
  const out: (Point & { p90: number; sent: number })[] = [];
  for (const line of text.split("\n")) {
    const tok = /(\d+) in \/ (\d+) out tokens per call/.exec(line);
    const lat = /p50 (\d+) ms, p90 (\d+) ms/.exec(line);
    const sent = /(\d+) sent now/.exec(line);
    if (!tok || !lat) continue;
    out.push({
      input: Number(tok[1]),
      output: Number(tok[2]),
      ms: Number(lat[1]),
      p90: Number(lat[2]),
      sent: sent ? Number(sent[1]) : 0,
      label: line.split(" ")[0],
    });
  }
  return out;
}

const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};

function show(title: string, fit: Fit, at: [number, number]): void {
  console.log(`${title}: n ${fit.n}, R^2 ${fit.r2.toFixed(3)}, max error ${fit.maxErr.toFixed(1)} ms`);
  fit.names.forEach((n, i) => console.log(`  ${n.padEnd(26)} ${fit.coef[i]!.toPrecision(4)}`));
  if (fit.coef.length === 3) {
    const [floor, a, b] = fit.coef as [number, number, number];
    const total = floor + a * at[0] + b * at[1];
    const share = (x: number) => `${((100 * x) / total).toFixed(0)}%`;
    console.log(
      `  at ${at[0]} in / ${at[1]} out: ${total.toFixed(0)} ms = floor ${floor.toFixed(0)} (${share(floor)}) + ` +
        `input ${(a * at[0]).toFixed(0)} (${share(a * at[0])}) + output ${(b * at[1]).toFixed(0)} ` +
        `(${share(b * at[1])}); a reader-only change reaches at most ${(total / floor).toFixed(2)}x (the floor)`,
    );
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fail = (message: string): never => {
    console.error(message);
    process.exit(2);
  };
  // A flag given without its value is an error, not a silent fall back to the default fit.
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
    return v;
  };
  const known = new Set(["--md", "--replay", "--runs", "--at"]);
  const unknown = args.filter((a) => a.startsWith("--") && !known.has(a));
  if (unknown.length) fail(`unknown flag ${unknown.join(", ")}; known: ${[...known].join(", ")}`);
  const atText = opt("at");
  const atArg = (atText ?? "3921,188").split(",").map(Number);
  if (atArg.length !== 2 || !atArg.every((x) => Number.isFinite(x) && x >= 0))
    fail(`--at needs IN,OUT token counts (two numbers), got ${atText}`);
  const at: [number, number] = [atArg[0]!, atArg[1]!];
  const ri = args.indexOf("--replay");
  // Every argument after --replay up to the next flag is a file.
  const replays: string[] = [];
  if (ri >= 0)
    for (const a of args.slice(ri + 1)) {
      if (a.startsWith("--")) break;
      replays.push(a);
    }
  if (ri >= 0 && replays.length === 0) fail("--replay needs at least one replay file");
  const shown = (f: string) => relative(process.cwd(), f) || f;
  const runs = opt("runs");
  if (replays.length > 0) {
    const points = replays.flatMap((f) => replayRows(readFileSync(f, "utf8")));
    if (points.length < 4) {
      console.error(`${points.length} calls with usage and latency in ${replays.join(", ")}: too few to fit`);
      process.exit(1);
    }
    show(`per-call fit over ${replays.length} replay file(s)`, fitTokens(points), at);
    if (points.some((p) => (p.cached ?? 0) > 0)) show("per-call fit, cached input apart", fitCached(points), at);
    const ttft = points.flatMap((p) => (typeof p.ttftMs === "number" ? [p.ttftMs] : []));
    const ms = points.map((p) => p.ms);
    console.log(`latency p50 ${quantile(ms, 0.5)} ms, p90 ${quantile(ms, 0.9)} ms over ${ms.length} calls`);
    console.log(
      ttft.length
        ? `TTFT p50 ${quantile(ttft, 0.5)} ms, p90 ${quantile(ttft, 0.9)} ms over ${ttft.length} streamed calls`
        : "TTFT: none recorded (the provider did not stream these calls)",
    );
  } else if (runs) {
    const all = runRows(readFileSync(runs, "utf8"));
    // A run that sent nothing replayed another run's calls: the same point again.
    const own = all.filter((r) => r.sent > 0);
    for (const [title, rows] of [
      [`${all.length} runs of ${shown(runs)}`, all],
      [`the ${own.length} that sent calls (pure replays left out)`, own],
    ] as const) {
      show(`run-level p50 fit over ${title}`, fitTokens(rows), at);
      show(`run-level p90 fit over ${title}`, fitTokens(rows.map((r) => ({ ...r, ms: r.p90 }))), at);
    }
  } else {
    const md = opt("md") ?? join(import.meta.dir, "..", "..", "..", "..", "docs", "research", "haiku-phase3.md");
    if (!existsSync(md)) {
      console.error(`no such file: ${md}`);
      process.exit(1);
    }
    const points = tableRows(readFileSync(md, "utf8"));
    for (const p of points) console.log(`  ${p.input} in / ${p.output} out: p50 ${p.ms} ms  (${p.label})`);
    show(
      `run-level fit over ${points.length} rows of ${shown(md)} (ecological: run medians, not calls)`,
      fitTokens(points),
      at,
    );
  }
}
