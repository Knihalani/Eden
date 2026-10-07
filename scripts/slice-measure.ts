#!/usr/bin/env bun
/**
 * Runs a slice's measurements (CLAUDE.md, lifecycle step 5) on one commit, in a fraction of the serial time:
 * count-only measures in parallel, timing-sensitive ones alone on a quiet machine, and only the measures the change
 * can affect.
 *
 *   bun scripts/slice-measure.ts --new DIR --out DIR [--base DIR] [--guard-base FILE,…]
 *       [--only arms,guards,r6,worlds,soak,bench,timing] [--changed REF] [--jobs N]
 *       [--r6-projects DIR] [--worlds 1,2,2] [--quiet-load X] [--quiet-wait MIN] [--dry-run]
 *
 * - `--new`: a checkout of the commit, after `bun install --frozen-lockfile`. Every harness tool runs from it.
 * - `--base`: a checkout of the baseline (`origin/main` when the slice began): the soak's and timing's other side,
 *   and base guard runs when no `--guard-base` file (an earlier `aa.ts --out`) is given.
 * - Measures:
 *   - `arms`: every arm in every recorded flag state, as four processes: `on` twice, `off`, `shadow`;
 *   - `guards`: `harness/aa.ts`, one process per seed (1, 2, 3; 3 runs each; no soak);
 *   - `r6`: the R6 replay twice, from `--r6-projects` (a frozen private copy; counts only);
 *   - `worlds`: `replay.ts --world N --out` for each seed in `--worlds`, kept for hand-read packets;
 *   - `soak`: `replay.ts --soak 1000`, base and new at once (the paired protocol);
 *   - `bench`: the locked 2k bench;
 *   - `timing`: scripts/submit-timing.ts, small and big transcripts and an A/A pair (only when named in `--only`).
 * - Selection: `--only` names the measures. `--changed REF` selects them from `git diff --name-only REF...HEAD` in
 *   the `--new` checkout (`selectMeasures`). With neither, every measure but `timing`.
 * - The parallel phase (arms, guards, r6, worlds) shares `--jobs` processes, default half the cores, longest first,
 *   and starts a task only while the 1-minute load average is under `--max-load` (default the core count). These are
 *   counts: load reaches them through hook timeouts, which change a run's events. A task with a hook timeout, a
 *   non-zero exit, runs of one seed on different events, or (arms) a mismatch is re-run alone afterwards, once; the
 *   summary gives both results, and one still affected alone is marked not valid.
 * - The serial phase (soak, bench, timing) waits, before each step, until the 1-minute load average is under
 *   `--quiet-load` (default half the cores) or `--quiet-wait` minutes (default 10) pass, and records the load.
 * - Output: each task's log and JSON under `--out`, and `summary.md` (also printed).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { guardReport, readSide } from "./slice-guards";

export type Measure = "arms" | "guards" | "r6" | "worlds" | "soak" | "bench" | "timing";
export const MEASURES: readonly Measure[] = ["arms", "guards", "r6", "worlds", "soak", "bench", "timing"];
/** Every measure the default run takes: `timing` is opt-in. */
export const DEFAULT_MEASURES: readonly Measure[] = ["arms", "guards", "r6", "worlds", "soak", "bench"];

/** What a changed file can affect, conservatively: code the hook may load affects every measure. */
export function measuresFor(file: string): readonly Measure[] {
  if (file === "benchmarks/memory-long-horizon/arms.json") return ["arms"];
  if (/^benchmarks\/memory-long-horizon\//.test(file) && !/\.test\.tsx?$/.test(file)) return DEFAULT_MEASURES;
  if (/^docs\/|^\.claude\/|\.md$/.test(file)) return [];
  if (/\.test\.tsx?$/.test(file)) return [];
  if (/^(apps|archived|scripts)\//.test(file)) return [];
  if (/^benchmarks\/memory-scale\//.test(file)) return ["bench"];
  if (/^benchmarks\//.test(file)) return [];
  return DEFAULT_MEASURES;
}

/** The measures a change needs, and which file asked for each. */
export function selectMeasures(files: readonly string[]): { measures: Measure[]; because: Map<Measure, string> } {
  const because = new Map<Measure, string>();
  for (const file of files)
    for (const measure of measuresFor(file)) if (!because.has(measure)) because.set(measure, file);
  return { measures: DEFAULT_MEASURES.filter((measure) => because.has(measure)), because };
}

interface Options {
  next: string;
  out: string;
  base?: string;
  guardBase?: string[];
  measures: Measure[];
  skipped: string[];
  jobs: number;
  r6Projects?: string;
  worlds: number[];
  quietLoad: number;
  quietWaitMs: number;
  maxLoad: number;
  dryRun: boolean;
}

interface Task {
  name: string;
  measure: Measure;
  cwd: string;
  cmd: string[];
  /** Expected seconds, to start the longest first. */
  weight: number;
}

interface Done {
  task: Task;
  exit: number;
  seconds: number;
  log: string;
}

const HARNESS = "benchmarks/memory-long-horizon";
const PLUGIN = "plugins/eden-memory";

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function git(dir: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

function options(args: string[]): Options {
  const next = argument(args, "--new");
  const out = argument(args, "--out");
  if (!next || !out) {
    console.error("usage: bun scripts/slice-measure.ts --new DIR --out DIR [--base DIR] [--only …] [--changed REF] …");
    process.exit(2);
  }
  const base = argument(args, "--base");
  const only = argument(args, "--only");
  const changed = argument(args, "--changed");
  let measures: Measure[] = [...DEFAULT_MEASURES];
  const skipped: string[] = [];
  if (only) {
    const named = only.split(",") as Measure[];
    const unknown = named.filter((measure) => !MEASURES.includes(measure));
    if (unknown.length) throw new Error(`unknown measures: ${unknown.join(", ")}`);
    measures = named;
  } else if (changed) {
    const files = git(resolve(next), "diff", "--name-only", `${changed}...HEAD`).split("\n").filter(Boolean);
    const selected = selectMeasures(files);
    measures = selected.measures;
    for (const [measure, file] of selected.because) skipped.push(`selected ${measure}: ${file} changed`);
    for (const measure of DEFAULT_MEASURES)
      if (!selected.because.has(measure)) skipped.push(`skipped ${measure}: no change since ${changed} can affect it`);
  }
  const r6Projects = argument(args, "--r6-projects");
  if (r6Projects && !existsSync(r6Projects)) throw new Error(`--r6-projects: no such directory ${r6Projects}`);
  const worlds = (argument(args, "--worlds") ?? "").split(",").filter(Boolean).map(Number);
  const guardBase = argument(args, "--guard-base")?.split(",");
  const drop = (measure: Measure, why: string) => {
    if (!measures.includes(measure)) return;
    measures = measures.filter((m) => m !== measure);
    skipped.push(`skipped ${measure}: ${why}`);
  };
  if (!r6Projects) drop("r6", "no --r6-projects");
  if (!worlds.length) drop("worlds", "no --worlds");
  if (!base) for (const measure of ["soak", "timing"] as const) drop(measure, "no --base");
  const half = Math.max(1, Math.floor(availableParallelism() / 2));
  return {
    next: resolve(next),
    out: resolve(out),
    base: base && resolve(base),
    guardBase: guardBase?.map((path) => resolve(path)),
    measures,
    skipped,
    jobs: Number(argument(args, "--jobs") ?? half),
    r6Projects: r6Projects && resolve(r6Projects),
    worlds,
    quietLoad: Number(argument(args, "--quiet-load") ?? half),
    quietWaitMs: Number(argument(args, "--quiet-wait") ?? 10) * 60_000,
    maxLoad: Number(argument(args, "--max-load") ?? availableParallelism()),
    dryRun: args.includes("--dry-run"),
  };
}

/** The parallel phase's tasks: count-only measures, each one process. */
export function parallelTasks(
  o: Pick<Options, "next" | "out" | "base" | "guardBase" | "measures" | "r6Projects" | "worlds">,
): Task[] {
  const tasks: Task[] = [];
  const has = (measure: Measure) => o.measures.includes(measure);
  if (has("arms"))
    for (const [name, flags] of [
      ["on-1", "on"],
      ["on-2", "on"],
      ["off", "off"],
      ["shadow", "shadow"],
    ] as const)
      tasks.push({
        name: `arms-${name}`,
        measure: "arms",
        cwd: o.next,
        weight: 300,
        cmd: ["bun", `${HARNESS}/arms/run.ts`, "--flags", flags],
      });
  const guardSides: [string, string][] = [["new", o.next]];
  if (o.base && !o.guardBase) guardSides.push(["base", o.base]);
  if (has("guards"))
    for (const [side, dir] of guardSides)
      for (const seed of [1, 2, 3])
        tasks.push({
          name: `guards-${side}-${seed}`,
          measure: "guards",
          cwd: dir,
          weight: 450,
          cmd: [
            "bun",
            `${HARNESS}/harness/aa.ts`,
            "--plugin",
            PLUGIN,
            "--seeds",
            String(seed),
            "--runs",
            "3",
            "--soak-runs",
            "0",
            "--out",
            join(o.out, `guards-${side}-${seed}.json`),
          ],
        });
  if (has("r6") && o.r6Projects)
    for (const run of [1, 2])
      tasks.push({
        name: `r6-${run}`,
        measure: "r6",
        cwd: o.next,
        weight: 1500,
        cmd: ["bun", `${HARNESS}/arms/r6-replay.ts`, "--plugin", PLUGIN, "--projects", o.r6Projects],
      });
  if (has("worlds")) {
    const seen = new Map<number, number>();
    for (const seed of o.worlds) {
      const n = (seen.get(seed) ?? 0) + 1;
      seen.set(seed, n);
      const dir = join(o.out, `world-${seed}-${n}`);
      tasks.push({
        name: `world-${seed}-${n}`,
        measure: "worlds",
        cwd: o.next,
        weight: 150,
        cmd: [
          "bun",
          `${HARNESS}/harness/replay.ts`,
          "--world",
          String(seed),
          "--plugin",
          join(o.next, PLUGIN),
          "--out",
          dir,
        ],
      });
    }
  }
  return tasks.sort((a, b) => b.weight - a.weight);
}

/** Tasks inherit no EDEN_* variable from the caller, so none points a run at a real store (as scripts/test.sh). */
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => !key.startsWith("EDEN_") && value !== undefined),
  ) as Record<string, string>;
}

async function runTask(task: Task, out: string): Promise<Done> {
  const log = join(out, `${task.name}.log`);
  const fd = openSync(log, "w");
  const started = performance.now();
  try {
    const child = Bun.spawn(task.cmd, { cwd: task.cwd, stdout: fd, stderr: fd, env: cleanEnv() });
    const exit = await child.exited;
    return { task, exit, seconds: (performance.now() - started) / 1000, log };
  } finally {
    closeSync(fd);
  }
}

/** Runs the tasks `jobs` at a time, in order, each started only while the load is under `maxLoad`. */
async function pool(tasks: Task[], jobs: number, out: string, maxLoad: number, waitMs: number): Promise<Done[]> {
  const done: Done[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      await quiet(maxLoad, waitMs);
      console.log(`start ${task.name}`);
      const result = await runTask(task, out);
      console.log(`done  ${task.name}: exit ${result.exit}, ${result.seconds.toFixed(0)} s`);
      done.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return done;
}

/** Waits until the 1-minute load average is under `limit`, at most `waitMs`; returns the load it started at. */
async function quiet(limit: number, waitMs: number): Promise<string> {
  const until = Date.now() + waitMs;
  while (loadavg()[0]! >= limit && Date.now() < until) await Bun.sleep(15_000);
  const [one, five] = loadavg();
  return `load average ${one!.toFixed(2)} (5 min ${five!.toFixed(2)})${one! >= limit ? `, still at or over ${limit} after waiting` : ""}`;
}

function lastJson(text: string): Record<string, any> | undefined {
  const end = text.lastIndexOf("}");
  for (let start = text.indexOf("{"); start >= 0 && start < end; start = text.indexOf("{", start + 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return undefined;
}

/** The JSON a task wrote: its `--out` file for guards, else the last JSON object in its log. */
function taskJson(done: Done): Record<string, any> | undefined {
  const at = done.task.cmd.indexOf("--out");
  const file = done.task.measure === "guards" && at >= 0 ? done.task.cmd[at + 1] : undefined;
  if (file) return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  return lastJson(readFileSync(done.log, "utf8"));
}

/**
 * Why a task's counts may be load's doing, or undefined when they are clean: a hook timeout or non-zero exit, runs of
 * one seed on different events (a timeout changes what follows), an arms mismatch, or no result at all.
 */
export function loadAffected(
  measure: Measure,
  exit: number,
  result: Record<string, any> | undefined,
): string | undefined {
  if (measure === "arms") return exit === 0 ? undefined : "an arms mismatch";
  if (!result) return `no result (exit ${exit})`;
  const runs: Record<string, any>[] =
    measure === "guards" ? (Object.values(result.world ?? {}) as Record<string, any>[][]).flat() : [result];
  const timedOut = runs.reduce((sum, run) => sum + (run.failOpen?.timedOut ?? 0), 0);
  const nonZero = runs.reduce((sum, run) => sum + (run.failOpen?.nonZeroExit ?? 0), 0);
  if (timedOut || nonZero) return `${timedOut} hook timeouts, ${nonZero} non-zero exits`;
  if (measure === "guards") {
    const seeds = Object.values(result.world ?? {}) as { digest: string }[][];
    if (seeds.some((seedRuns) => seedRuns.some((run) => run.digest !== seedRuns[0]?.digest)))
      return "runs of one seed on different events";
  }
  return exit === 0 ? undefined : `exit ${exit}`;
}

/** Re-runs each load-affected task alone, after the load falls; the parallel run's files are kept as `*.parallel.*`. */
async function confirmAlone(o: Options, done: Done[]): Promise<{ done: Done[]; notes: string[] }> {
  const notes: string[] = [];
  const kept: Done[] = [];
  for (const result of done) {
    const why = loadAffected(result.task.measure, result.exit, taskJson(result));
    if (!why) {
      kept.push(result);
      continue;
    }
    const at = result.task.cmd.indexOf("--out");
    const outFile = result.task.measure === "guards" && at >= 0 ? result.task.cmd[at + 1] : undefined;
    if (outFile && existsSync(outFile)) renameSync(outFile, outFile.replace(/\.json$/, ".parallel.json"));
    renameSync(result.log, result.log.replace(/\.log$/, ".parallel.log"));
    const load = await quiet(o.quietLoad, o.quietWaitMs);
    console.log(`again ${result.task.name} alone (${why} in parallel; ${load})`);
    const alone = await runTask(result.task, o.out);
    const still = loadAffected(alone.task.measure, alone.exit, taskJson(alone));
    const verdict = still ? `still ${still}: not valid, re-run on a quieter machine` : "clean";
    notes.push(`- ${result.task.name}: ${why} in the parallel run; re-run alone (${load}): ${verdict}`);
    kept.push(alone);
  }
  return { done: kept, notes };
}

function armsLine(done: Done): string {
  const text = readFileSync(done.log, "utf8");
  const mismatches = text.split("\n").filter((line) => line.startsWith("≠"));
  const recorded = text
    .split("\n")
    .filter((line) => line.includes(" recorded "))
    .map((line) => line.trim());
  const detail = recorded.length ? ` (${recorded.join("; ")})` : "";
  return `- ${done.task.name}: exit ${done.exit}, ${mismatches.length} mismatches${detail}, ${done.seconds.toFixed(0)} s`;
}

function r6Line(done: Done): string {
  const r = lastJson(readFileSync(done.log, "utf8"));
  if (!r) return `- ${done.task.name}: exit ${done.exit}, no summary (see the log)`;
  const human = r.bySubmit?.human ?? {};
  const rate = r.packet_rate ?? {};
  const ms = r.msUserPromptSubmit ?? {};
  const percent = (x: number) => (x * 100).toFixed(2);
  const ci = (rate.ci ?? []).map(percent).join("–");
  const nonHuman = `${r.bySubmit?.["task-notification"]?.packets}/${r.bySubmit?.peer?.packets}`;
  const parts = [
    `packet_rate ${rate.k}/${rate.n} = ${percent(rate.rate ?? 0)}% (CI ${ci}%)`,
    `bullet_volume ${r.bullet_volume} (human ${human.bullets}, SessionStart ${r.sessionStart?.bullets})`,
    `task-notification/peer packets ${nonHuman}`,
    `chatter ${r.chatter?.k}/${r.chatter?.n}`,
    `fail-open ${JSON.stringify(r.failOpen)}`,
    `Submit p50/p99 ${ms.p50}/${ms.p99} ms`,
    `corpus ${String(r.sessions?.corpus ?? "").slice(0, 12)}`,
    `${done.seconds.toFixed(0)} s`,
  ];
  return `- ${done.task.name}: ${parts.join("; ")}`;
}

function worldLine(done: Done): string {
  const r = lastJson(readFileSync(done.log, "utf8"));
  const m = r?.metrics;
  if (!m) return `- ${done.task.name}: exit ${done.exit}, no summary (see the log)`;
  return `- ${done.task.name}: stale ${m.stale_rate.k}/${m.stale_rate.n}, need_miss ${m.need_miss_rate.k}/${m.need_miss_rate.n}; kept in ${done.task.cmd.at(-1)}`;
}

function soakLine(side: string, log: string): string {
  const r = lastJson(readFileSync(log, "utf8"));
  if (!r?.msByPoint) return `- ${side}: no summary (see ${log})`;
  const points = ["UserPromptSubmit", "PostToolUse", "Stop"].map((point) => {
    const p = r.msByPoint[point] ?? {};
    return `${point} p50 ${p.p50} p99 ${p.p99} (n ${p.n})`;
  });
  return `- ${side}: ${points.join("; ")}; fail-open ${JSON.stringify(r.failOpen)}; digest ${String(r.digest).slice(0, 12)}`;
}

async function serialPhase(o: Options, lines: string[]): Promise<void> {
  if (o.measures.includes("soak") && o.base) {
    const load = await quiet(o.quietLoad, o.quietWaitMs);
    const sides = [
      {
        name: "soak-base",
        cmd: ["bun", `${HARNESS}/harness/replay.ts`, "--soak", "1000", "--plugin", join(o.base, PLUGIN)],
      },
      {
        name: "soak-new",
        cmd: ["bun", `${HARNESS}/harness/replay.ts`, "--soak", "1000", "--plugin", join(o.next, PLUGIN)],
      },
    ];
    console.log(`start soak (both sides at once; ${load})`);
    const done = await Promise.all(
      sides.map((side) => runTask({ ...side, measure: "soak", cwd: o.next, weight: 0 }, o.out)),
    );
    lines.push("", `## Soak (\`replay.ts --soak 1000\`, both sides at once; ${load})`, "");
    for (const result of done) lines.push(soakLine(result.task.name, result.log));
  }
  if (o.measures.includes("bench")) {
    const load = await quiet(o.quietLoad, o.quietWaitMs);
    const done = await runTask(
      { name: "bench", measure: "bench", cwd: o.next, weight: 0, cmd: ["bun", "run", "bench:memory-locked"] },
      o.out,
    );
    const tail = readFileSync(done.log, "utf8")
      .split("\n")
      .filter((line) => /^(metric|n):/.test(line));
    lines.push("", `## Locked 2k bench (${load})`, "", `- exit ${done.exit}: ${tail.join(", ")}`);
  }
  if (o.measures.includes("timing") && o.base) {
    lines.push("", "## Interleaved Submit timing (`scripts/submit-timing.ts`, 1,000 runs per side)", "");
    const script = join(import.meta.dir, "submit-timing.ts");
    const pairs = [
      ["timing-small", join(o.base, PLUGIN), join(o.next, PLUGIN), "small"],
      ["timing-big", join(o.base, PLUGIN), join(o.next, PLUGIN), "big"],
      ["timing-aa", join(o.base, PLUGIN), join(o.base, PLUGIN), "small"],
    ] as const;
    for (const [name, base, next, transcript] of pairs) {
      const load = await quiet(o.quietLoad, o.quietWaitMs);
      const cmd = ["bun", script, "--base", base, "--new", next, "--transcript", transcript];
      const done = await runTask({ name, measure: "timing", cwd: o.next, weight: 0, cmd }, o.out);
      lines.push(`- ${name} (${load}): ${readFileSync(done.log, "utf8").trim().split("\n").join("; ")}`);
    }
  }
}

function guardsSection(o: Options, done: Done[]): string[] {
  const files = (side: string) =>
    [1, 2, 3].map((seed) => join(o.out, `guards-${side}-${seed}.json`)).filter(existsSync);
  const next = files("new");
  const base = o.guardBase ?? files("base");
  const lines = ["", "## Guards (`harness/aa.ts`, one process per seed)", ""];
  for (const result of done.filter((d) => d.task.measure === "guards"))
    lines.push(`- ${result.task.name}: exit ${result.exit}, ${result.seconds.toFixed(0)} s`);
  if (next.length && base.length) lines.push("", guardReport(readSide(base.join(",")), readSide(next.join(","))));
  else lines.push("", "No base guard runs (`--base` or `--guard-base`): nothing to pair against.");
  return lines;
}

async function main(): Promise<void> {
  const o = options(process.argv.slice(2));
  const tasks = parallelTasks(o);
  console.log(`measures: ${o.measures.join(", ") || "none"}`);
  for (const note of o.skipped) console.log(note);
  console.log(`parallel tasks (${o.jobs} at a time): ${tasks.map((task) => task.name).join(", ") || "none"}`);
  if (o.dryRun) return;
  mkdirSync(o.out, { recursive: true });
  const started = performance.now();
  const lines = [
    `# Slice measurements`,
    "",
    `- new: \`${git(o.next, "rev-parse", "--short", "HEAD")}\` (${o.next})${o.base ? `; base: \`${git(o.base, "rev-parse", "--short", "HEAD")}\`` : ""}`,
    `- measures: ${o.measures.join(", ") || "none"}; parallel jobs ${o.jobs}; cores ${availableParallelism()}`,
    ...o.skipped.map((note) => `- ${note}`),
  ];
  const parallel = await pool(tasks, o.jobs, o.out, o.maxLoad, o.quietWaitMs);
  const { done, notes } = await confirmAlone(o, parallel);
  if (notes.length) lines.push("", "## Re-run alone (load-affected in the parallel phase)", "", ...notes);
  const of = (measure: Measure) =>
    done.filter((d) => d.task.measure === measure).sort((a, b) => a.task.name.localeCompare(b.task.name));
  if (of("arms").length)
    lines.push("", "## Arms (`arms/run.ts`, every arm, CI scale)", "", ...of("arms").map(armsLine));
  if (of("guards").length) lines.push(...guardsSection(o, done));
  if (of("r6").length) lines.push("", "## R6 replay (`arms/r6-replay.ts`, counts only)", "", ...of("r6").map(r6Line));
  if (of("worlds").length) lines.push("", "## Kept world replays", "", ...of("worlds").map(worldLine));
  await serialPhase(o, lines);
  const failed = done.filter((d) => d.exit !== 0 && d.task.measure !== "arms").map((d) => d.task.name);
  lines.push(
    "",
    `Total ${((performance.now() - started) / 60_000).toFixed(1)} min.${failed.length ? ` Non-zero exits: ${failed.join(", ")} (see their logs).` : ""}`,
  );
  const summary = lines.join("\n") + "\n";
  writeFileSync(join(o.out, "summary.md"), summary);
  console.log(`\n${summary}`);
}

if (import.meta.main) await main();
