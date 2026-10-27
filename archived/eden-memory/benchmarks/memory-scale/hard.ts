#!/usr/bin/env bun
/**
 * Hard memory bench: 20k rows, 14 services in 3 repos sharing one vocabulary, paraphrased and path-scoped cues,
 * superseded values, distractors, redundancy and negatives. Not saturated on purpose; see README.md.
 *
 *   bun benchmarks/memory-scale/hard.ts                 # dev split (tune on this)
 *   bun benchmarks/memory-scale/hard.ts --split test    # locked test split (never tune on it)
 *   bun benchmarks/memory-scale/hard.ts --split all
 *   bun benchmarks/memory-scale/hard.ts --detail        # dev only: every failing case
 *
 * Prints `metric:` = failed checks on the split (lower is better), then the per-category breakdown.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MARK, openMemory } from "../../src/index";
import { consolidate } from "../../src/sleep";
import { type CaseResult, CHECKS, Oracle, bulletsOf, packetText, summarize, type Summary } from "./hard-oracle";
import { buildCases, buildWorld, FILLER_ROWS, REPOS, type HardCase, type Split, type World } from "./hard-world";

/** Far above the row count, so the default 2000-row trim never runs and all 20k rows stay searchable. */
const STORE_CAP = 1_000_000;
const CLOCK_START = Date.UTC(2026, 0, 5, 9);
const TURN_MS = 30_000;
const DAY_MS = 86_400_000;
const COLD_RUNS = 5;
/** 4 passes over both splits' cases give A5's ≥ 1,000 samples for a p99. */
const TIMING_REPS = 4;

export type HardOptions = {
  splits: Split[];
  fillerRows?: number;
  /** Warm inject timing passes over every case of both splits; 0 skips timing. */
  timingReps?: number;
  /** Run one full consolidation after the last session, as the Stop hook does. */
  sleep?: boolean;
  /** The cases to score per split; defaults to the bench's own (tests pass a small slice). */
  cases?: (world: World, split: Split) => HardCase[];
};

export type Scale = {
  rows: number;
  bytes: number;
  dirBytes: number;
  buildMs: number;
  sleepMs: number;
  p50Ms: number;
  p99Ms: number;
  coldMs: number;
  samples: number;
};

export type HardRun = { world: World; results: CaseResult[]; summaries: Map<Split, Summary>; scale: Scale };

type Mem = ReturnType<typeof openMemory>;

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

function dirSize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

/** Every EDEN_* variable is cleared and restored, so the caller's shell cannot point the bench at a real store. */
function isolate(): { dir: string; restore: () => void } {
  const saved = Object.entries(process.env).filter(([k]) => k.startsWith("EDEN_"));
  for (const [k] of saved) delete process.env[k];
  const root = mkdtempSync(join(tmpdir(), "eden-hard-bench-"));
  const dir = join(root, "memory");
  process.env.EDEN_HOME = join(root, "home");
  process.env.EDEN_MEMORY_DIR = dir;
  process.env.EDEN_KNOW = "0";
  process.env.EDEN_MEMORY_STORE_CAP = String(STORE_CAP);
  return {
    dir,
    restore: () => {
      for (const k of Object.keys(process.env)) if (k.startsWith("EDEN_")) delete process.env[k];
      for (const [k, v] of saved) process.env[k] = v;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Injected time: every Date.now() call advances 1 ms from a fixed start, plus explicit gaps between turns. */
function installClock(): { advance: (ms: number) => void; restore: () => void } {
  const real = Date.now;
  let t = CLOCK_START;
  Date.now = () => ++t;
  return { advance: (ms) => void (t += ms), restore: () => void (Date.now = real) };
}

function messages(c: HardCase): { role: string; content: string }[] {
  const prev = c.prev ? [{ role: "assistant", content: c.prev }] : [];
  return [...prev, { role: "user", content: c.cue }];
}

/**
 * One writer per (session, repo), freshly loaded from disk as a new hook process would be. Its turns are batched
 * in `quiet()` so the 2 MB store is written once per batch, not once per turn.
 */
function build(world: World, dir: string, clock: { advance: (ms: number) => void }): void {
  for (let session = 0; session < world.sessions; session++) {
    for (const repo of REPOS) {
      const batch = world.events.filter((e) => e.session === session && e.repo === repo.id);
      if (!batch.length) continue;
      const mem = openMemory({ dir, cwd: repo.cwd });
      mem.quiet(() => {
        for (const e of batch) {
          mem.observe([{ role: "user", content: e.text }]);
          clock.advance(TURN_MS);
        }
      });
      mem.close();
    }
    clock.advance(DAY_MS);
  }
}

export function runHard(opts: HardOptions): HardRun {
  const env = isolate();
  const clock = installClock();
  try {
    const world = buildWorld(opts.fillerRows ?? FILLER_ROWS);
    const t0 = performance.now();
    build(world, env.dir, clock);
    const buildMs = performance.now() - t0;
    let sleepMs = 0;
    if (opts.sleep !== false) {
      const t1 = performance.now();
      const mem = openMemory({ dir: env.dir, cwd: REPOS[0]!.cwd });
      consolidate(mem, { mode: "full" });
      mem.close();
      sleepMs = performance.now() - t1;
    }

    // Scoring never writes: each case sees the same store, whatever order the cases run in.
    process.env.EDEN_MEMORY = "readonly";
    const mems = new Map<string, Mem>(REPOS.map((r) => [r.id, openMemory({ dir: env.dir, cwd: r.cwd })]));
    const oracle = new Oracle(world);
    const results: CaseResult[] = [];
    const summaries = new Map<Split, Summary>();
    for (const split of opts.splits) {
      const cases = (opts.cases ?? buildCases)(world, split);
      const scored = cases.map((c) => {
        const packet = packetText(mems.get(c.repo)!.inject(messages(c)), MEMORY_MARK);
        return oracle.score(c, bulletsOf(packet), packet.includes(MEMORY_MARK));
      });
      results.push(...scored);
      summaries.set(split, summarize(scored));
    }

    const timed = [...buildCases(world, "dev"), ...buildCases(world, "test")];
    const times: number[] = [];
    for (let rep = 0; rep < (opts.timingReps ?? TIMING_REPS); rep++) {
      for (const c of timed) {
        const mem = mems.get(c.repo)!;
        const msgs = messages(c);
        const t = performance.now();
        mem.inject(msgs);
        times.push(performance.now() - t);
      }
    }
    times.sort((a, b) => a - b);
    const cold: number[] = [];
    for (let i = 0; i < (opts.timingReps === 0 ? 0 : COLD_RUNS); i++) {
      const c = timed[i]!;
      const t = performance.now();
      openMemory({ dir: env.dir, cwd: REPOS.find((r) => r.id === c.repo)!.cwd }).inject(messages(c));
      cold.push(performance.now() - t);
    }
    cold.sort((a, b) => a - b);

    const jsonl = join(env.dir, "memories.jsonl");
    const scale: Scale = {
      rows: existsSync(jsonl) ? readFileSync(jsonl, "utf8").split("\n").filter(Boolean).length : 0,
      bytes: existsSync(jsonl) ? statSync(jsonl).size : 0,
      dirBytes: dirSize(env.dir),
      buildMs,
      sleepMs,
      p50Ms: pct(times, 50),
      p99Ms: pct(times, 99),
      coldMs: pct(cold, 50),
      samples: times.length,
    };
    return { world, results, summaries, scale };
  } finally {
    clock.restore();
    env.restore();
  }
}

/** Hash of every case's failed checks and classified bullets: two runs agree iff their digests do. */
export function digest(results: CaseResult[]): string {
  const rows = results.map((r) => [r.id, r.fails, r.bullets.map((b) => [b.cls, b.text])]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

function rate(n: number, d: number): string {
  return d ? (n / d).toFixed(3) : "0.000";
}

export function report(run: HardRun): string[] {
  const out: string[] = [];
  const many = run.summaries.size > 1;
  for (const [split, s] of run.summaries) {
    const key = (k: string) => (many ? `${split}.${k}` : k);
    const line = (k: string, v: string | number) => out.push(`${key(k)}: ${v}`);
    line("split", split);
    line("metric", s.metric);
    line("checks", s.checks);
    line("cases", s.cases);
    line("cases_passed", s.passed);
    for (const k of CHECKS) line(`fail_${k}`, `${s.byCheck[k].fail}/${s.byCheck[k].total}`);
    line("need_miss_rate", rate(s.needMiss, s.positives));
    line("false_rate", rate(s.falseBullets, s.bullets));
    line("stale_rate", rate(s.staleBullets, s.bullets));
    line("redundant_rate", rate(s.redundantBullets, s.bullets));
    line("wrong_scope_bullets", s.wrongScopeBullets);
    line("bullets", s.bullets);
    line("unknown_bullets", s.unknownBullets);
    line("ack_packets", `${s.ack.fail}/${s.ack.total}`);
    line("nonhuman_packets", `${s.nonhuman.fail}/${s.nonhuman.total}`);
    for (const [cat, c] of s.byCategory) {
      const parts = CHECKS.filter((k) => c.byCheck[k].total).map((k) => {
        return `${k} ${c.byCheck[k].fail}/${c.byCheck[k].total}`;
      });
      line(`cat.${cat}`, `${c.fails}/${c.checks} (${c.cases} cases; ${parts.join(", ")})`);
    }
    line("digest", digest(run.results.filter((r) => r.split === split)));
  }
  const sc = run.scale;
  out.push(`n: ${sc.rows}`, `bytes: ${sc.bytes}`, `dir_bytes: ${sc.dirBytes}`);
  out.push(`build_ms: ${sc.buildMs.toFixed(0)}`, `sleep_ms: ${sc.sleepMs.toFixed(0)}`);
  out.push(`p50_ms: ${sc.p50Ms.toFixed(3)}`, `p99_ms: ${sc.p99Ms.toFixed(3)}`, `cold_ms: ${sc.coldMs.toFixed(1)}`);
  out.push(`timing_samples: ${sc.samples}`);
  return out;
}

function detail(results: CaseResult[], cases: Map<string, HardCase>): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (!r.fails.length) continue;
    const c = cases.get(r.id)!;
    out.push(`# ${r.id} [${r.fails.join(",")}] ${JSON.stringify(c.cue)} needs=${c.needs.join(",") || "-"}`);
    for (const b of r.bullets) out.push(`#   ${b.cls.padEnd(9)} ${b.slot ?? "-"} ${b.text.slice(0, 110)}`);
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const split = arg("--split") ?? "dev";
  if (!["dev", "test", "all"].includes(split)) throw new Error(`--split must be dev, test or all, not ${split}`);
  const splits: Split[] = split === "all" ? ["dev", "test"] : [split as Split];
  const wantDetail = args.includes("--detail");
  if (wantDetail && splits.includes("test")) throw new Error("--detail is dev-only: the test split is never tuned on");
  const run = runHard({ splits, sleep: !args.includes("--no-sleep") });
  for (const l of report(run)) console.log(l);
  if (wantDetail) {
    const cases = new Map(buildCases(run.world, "dev").map((c) => [c.id, c]));
    for (const l of detail(run.results, cases)) console.log(l);
  }
}
