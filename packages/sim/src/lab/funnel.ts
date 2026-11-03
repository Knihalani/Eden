#!/usr/bin/env bun
/**
 * The common no-model screen in one command (`bun run funnel`; docs/LAB.md): hidden-funnel.ts with a named preset,
 * replayed cards and `--ask`, then the funnel score funnel-score.py prints (a hidden item counts as surfaced when it
 * was delivered or an ask cited it; the same for a decoy on control tasks), optionally against an earlier run.
 *
 *   bun run funnel [--suite train] [--seeds 41,42] [--preset ALL3] [--set '{"flag":true}'] [--cards default|none|F]
 *     [--no-ask] [--json out.json] [--baseline earlier.json] [--record] [--blind] [--jobs N]
 *     [-- more hidden-funnel flags]
 *
 * - `--preset`: a name from presets.ts (H, ALL3, ALL3B, NEW, NEWB, NEWL, ...) or `none` (production
 *   defaults). `--set` adds flags.
 * - `--cards default`: the checked-in card caches (cards-v2 for dev/held-out worlds, cards-train for train), merged
 *   into a temp file; used when the configuration has `cards`.
 * - `--baseline`: a `--json` file of an earlier run on the same suites and seeds; prints, task by task, the hidden
 *   items gained and lost and the decoys gained and lost.
 * - Held-out suites are refused without `--blind`: they are measurement only, never for tuning (suites.ts). The
 *   unrun blind ones (UNRUN_BLIND) are spent by the first run that names them.
 * - Not recorded in bench/ledger.jsonl unless `--record` (a screen is not a result).
 * - `--jobs N`: N hidden-funnel.ts processes at once, one per suite × seed shard, rows merged before the score (same
 *   score; at `--time 0` ms/task is then contended). Default 1 at `--time 0`; at `--time` > 0 min(shards, 12,
 *   3 × cores), since those shards wait on sleeps. Some flags force 1 (the `--jobs` note below says which and why).
 * - With intent on and nothing replayed (no `-- --intent F`, or a file for other items), every TOTAL and pool line and
 *   the JSON label say `[intent inert: no replay]`; `--reader stub|oracle` refuse a `--baseline` whose intent differs.
 * - `-- --wait-ms N` (the observe's wait) prints the deliveries made before the agent's first model call;
 *   `-- --overlap` sends each request while another lookup is in flight (slowPathQueue's case; scores not
 *   comparable). docs/LAB.md 1c.
 *
 * NEW needs the reader (`-- --reader replay --reader-cache F` or `--reader live --reader-model m`) and the intent
 * requests (`-- --intent F`). Neither file is checked in (docs/LAB.md).
 * A replayed reader prompt that is not in the cache fails open (the ask answers without the reader), so the run
 * prints the miss count and exits 3 after the score unless `--allow-misses`: such a run is part NEW, part ALL3.
 * `-- --reader stub` screens the NEW family at $0 with no key: the reader's pool per suite (hidden and decoy in pool,
 * pool items, prompt size); its delivery counts are not the preset's. `-- --reader oracle[:p_hit,p_false]` is a
 * ground-truth proxy, every line labelled so. Both shard. `-- --packet-k 10,15,20` prints the planted item in the
 * ask's top K. With `-- --lead-in clause` and a no-model reader, the draft's pool against the request's (docs/LAB.md).
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { flags, labConfig, parseJson } from "./flags";
import { amortisedCalls, callMismatches, defaultJobs, type CallCheck } from "./funnel-merge";
import { PRESETS } from "./presets";
import { missGate, MISS_EXIT } from "./reader-disk";
import {
  beforeModelLine,
  INTENT_INERT,
  intentMismatch,
  intentOfRun,
  intentState,
  screenLines,
  STUB_BANNER,
  type IntentState,
  type IntentUse,
  type ScreenRow,
} from "./reader-stub";
import { parseSuites, UNRUN_BLIND } from "./suites";

const USAGE = `
bun run funnel [--suite train] [--seeds 41,42] [--preset ALL3] [--set '{"flag":true}'] [--cards default|none|F]
  [--no-ask] [--json out.json] [--baseline earlier.json] [--record] [--blind] [--jobs N] [--allow-misses]
  [-- more hidden-funnel flags]
Presets: none, ${Object.keys(PRESETS).join(", ")}. docs/LAB.md has the recipes; funnel.ts's header every flag.`;
// Strict (flags.ts): a misspelled flag exits 2 before anything runs; what follows `--` is hidden-funnel.ts's to check.
const cli = flags(
  "funnel",
  {
    suite: "value",
    seeds: "value",
    preset: "value",
    set: "value",
    cards: "value",
    json: "value",
    baseline: "value",
    jobs: "value",
    "no-ask": "bool",
    record: "bool",
    blind: "bool",
    "allow-misses": "bool",
  },
  USAGE,
);
const opt = cli.opt;
const passthrough = cli.rest;
const fail = (message: string): never => {
  console.error(`funnel: ${message}`);
  process.exit(2);
};

const suiteArg = opt("suite", "train");
const suites = parseSuites(suiteArg);
const heldout = suites.filter((s) => s.startsWith("heldout"));
if (heldout.length && !cli.has("blind")) {
  fail(
    `${heldout.join(", ")} are held out: measurement only, never for tuning. Screen on train (or dev6a,dev6b); ` +
      `pass --blind for a pre-registered blind check.`,
  );
}
const unrun = suites.filter((s) => UNRUN_BLIND.includes(s));
if (unrun.length) console.error(`funnel: ${unrun.join(", ")} never run before: this run spends them (UNRUN_BLIND)`);

const presetName = opt("preset", "ALL3");
const preset = presetName === "none" ? {} : PRESETS[presetName];
if (!preset) fail(`unknown preset ${presetName} (known: none, ${Object.keys(PRESETS).join(", ")})`);
// The merged configuration is checked whole (checkEngineConfig): an unknown or mistyped `--set` key, or a child flag
// whose parent the merged configuration has off (`syncPollBehind` without `sync`), exits 2 naming it.
let config: Record<string, unknown> = {};
try {
  const set = parseJson(opt("set", "{}"), "--set");
  if (typeof set !== "object" || set === null || Array.isArray(set)) fail("--set must be a JSON object");
  config = labConfig({ ...preset, ...(set as object) }, `--preset ${presetName} with --set`);
} catch (error) {
  fail((error as Error).message);
}
const has = (flag: string) => passthrough.includes(flag);
/** The value after a hidden-funnel flag given after `--` ("" when absent). */
const passValue = (name: string) => {
  const i = passthrough.indexOf(`--${name}`);
  return i >= 0 ? (passthrough[i + 1] ?? "") : "";
};
const allowMisses = cli.has("allow-misses") || has("--allow-misses");
if (config.askReader === true && !has("--reader")) {
  fail("this configuration has askReader: pass `-- --reader replay --reader-cache F` (or --reader live ...)");
}
if (config.intent === true && !has("--intent")) {
  console.error(
    `funnel: intent is on but no \`-- --intent F\`: no hits; every TOTAL and pool line says ${INTENT_INERT}`,
  );
}
// `--reader stub|oracle` with `--baseline`: refuse a baseline whose intent state differs, before the run when this
// run's state is known now (off, or on with no replay file), else after it (a file that matched nothing).
const readerKind = passValue("reader");
const noModelReader = readerKind === "stub" || readerKind.startsWith("oracle");
const baseline = opt("baseline", "");
const checkBaseline = (current: IntentState) => {
  if (!noModelReader || !baseline) return;
  const why = intentMismatch(current, intentOfRun(JSON.parse(readFileSync(baseline, "utf8"))));
  if (why) fail(`--baseline ${baseline} refused: ${why}`);
};
if (config.intent !== true) checkBaseline("off");
else if (!has("--intent")) checkBaseline("inert");

const labDir = join(import.meta.dir, "..", "..", "lab");
const scratch = mkdtempSync(join(tmpdir(), "eden-funnel-"));
let cards = opt("cards", "default");
if (cards === "default") {
  const merged = join(scratch, "cards.jsonl");
  const text = ["cards-v2.jsonl", "cards-train.jsonl"]
    .map((f) => readFileSync(join(labDir, "cards", f), "utf8").trimEnd())
    .join("\n");
  writeFileSync(merged, `${text}\n`);
  cards = merged;
}
const out = opt("json", join(scratch, "funnel.json"));
const seeds = opt("seeds", "41,42");

const seedList = seeds.split(",");
const label = presetName + (cli.has("set") ? "+set" : "");

/** hidden-funnel.ts's arguments for some suites and seeds, writing its rows to `json`. */
const funnelArgsFor = (suiteList: string, seedList: string, json: string) => [
  join(import.meta.dir, "hidden-funnel.ts"),
  "--suite",
  suiteList,
  "--seeds",
  seedList,
  "--config",
  JSON.stringify(config),
  "--json",
  json,
  "--label",
  label,
  ...(cli.has("no-ask") ? [] : ["--ask"]),
  ...(cards !== "none" && config.cards === true ? ["--cards", cards] : []),
  ...(cli.has("record") ? [] : ["--no-record"]),
  ...(allowMisses && !has("--allow-misses") ? ["--allow-misses"] : []),
  ...passthrough,
];
const shellLine = (a: string[]) => `bun ${a.map((x) => (/[\s{"]/.test(x) ? `'${x}'` : x)).join(" ")}`;

/**
 * `--jobs N`: one hidden-funnel.ts process per suite × seed shard, N at a time, their rows merged here before
 * scoring. Default 1 at `--time 0`; at `--time` > 0, min(shards, 12, 3 × cores) (`defaultJobs`, funnel-merge.ts). A
 * task's result does not depend on which other seeds share its process (checked at `--time 0` and `--time 1`: perTask
 * rows identical without their timing fields, docs/LAB.md). At `--time 0` its `ms` does: with N > 1 the shards contend
 * for cores, so ms/task is not a latency figure. At `--time` > 0 a task's time is mostly the connectors' simulated
 * latency (sleeps, not CPU), so shards barely contend and ms/task stays a latency figure (measured within a few
 * percent of one process, docs/LAB.md), and the run says how many ran at once; `--jobs` is honoured as typed, so a
 * latency study, a heavier configuration or a machine with fewer cores can choose one process. Some runs keep one
 * process whatever N says: each flag below clears and rewrites one output file per process (shards would overwrite
 * each other's), `--record` books one ledger entry per suite (a seed shard would book a partial run), and a live judge
 * or reader would multiply paid calls and rate-limit pressure in parallel.
 */
const jobsGiven = cli.has("jobs") ? Number(opt("jobs", "1")) : undefined;
if (jobsGiven !== undefined && (!Number.isInteger(jobsGiven) || jobsGiven < 1)) {
  fail("--jobs must be a whole number of at least 1");
}
const soloReasons = [
  ...["--packets", "--card-log", "--reader-log", "--ask-diag", "--candidates", "--timeline"].filter(has),
  ...(cli.has("record") ? ["--record"] : []),
  ...(passValue("judge") === "live" ? ["--judge live"] : []),
  ...(passValue("reader") === "live" ? ["--reader live"] : []),
];
/** `-- --time T`: connectors at their simulated latency; shards then wait on sleeps rather than contend for CPU. */
const timeScale = Number(passValue("time") || "0");
const shards = suites.flatMap((suite) => seedList.map((seed) => ({ suite, seed })));
const cores = availableParallelism();
let jobs = defaultJobs({ ...(jobsGiven !== undefined ? { jobsGiven } : {}), timeScale, shards: shards.length, cores });
if (jobs > 1 && soloReasons.length) {
  const asked = jobsGiven !== undefined ? `--jobs ${jobsGiven}` : `the --time default of ${jobs} jobs`;
  console.error(`funnel: ${asked} ignored, running one job: ${soloReasons.join(", ")} needs one process`);
  jobs = 1;
} else if (jobsGiven === undefined && jobs > 1) {
  console.error(
    `funnel: --time ${timeScale} without --jobs: ${jobs} shards at once on ${cores} cores (min(shards, 12, ` +
      "3 × cores)); ms/task read 0.8-3.5% higher at 12 jobs than at 1 on 4 cores (docs/LAB.md); --jobs 1 for an " +
      "uncontended latency figure",
  );
}

const t0 = performance.now();
if (jobs === 1) {
  const funnelArgs = funnelArgsFor(suites.join(","), seeds, out);
  console.error(`funnel: ${shellLine(funnelArgs)}`);
  const run = spawnSync("bun", funnelArgs, { stdio: "inherit" });
  // A run with reader misses still wrote its rows: score them, then fail below.
  if (run.status !== 0 && run.status !== MISS_EXIT) {
    rmSync(scratch, { recursive: true, force: true });
    process.exit(run.status ?? 1);
  }
} else {
  await runShards();
}
const wall = (performance.now() - t0) / 1000;

/** Runs every shard, `jobs` at a time, prints each one's output in shard order, and merges their JSON into `out`. */
async function runShards() {
  const shardJson = (i: number) => join(scratch, `shard-${i}.json`);
  const shardLog = (i: number) => join(scratch, `shard-${i}.log`);
  console.error(
    `funnel: ${shards.length} shards (suite × seed), ${jobs} at a time on ${availableParallelism()} cores` +
      (timeScale > 0 ? ` (--time ${timeScale}: concurrent shards wait on simulated connector latency, not CPU)` : "") +
      `; the first: ${shellLine(funnelArgsFor(shards[0]!.suite, shards[0]!.seed, shardJson(0)))}`,
  );
  const results: { status: number | null; seconds: number }[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < shards.length; i = next++) {
      const { suite, seed } = shards[i]!;
      // Each shard's stdout and stderr go to its own file, printed whole below so shards do not interleave.
      const fd = openSync(shardLog(i), "w");
      const started = performance.now();
      const child = spawn("bun", funnelArgsFor(suite, seed, shardJson(i)), { stdio: ["ignore", fd, fd] });
      const status = await new Promise<number | null>((done) => child.on("close", (code) => done(code)));
      closeSync(fd);
      results[i] = { status, seconds: (performance.now() - started) / 1000 };
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  for (const [i, { suite, seed }] of shards.entries()) {
    const r = results[i]!;
    console.log(`\n== shard ${suite} seed ${seed} (exit ${r.status}, ${r.seconds.toFixed(1)} s)`);
    process.stdout.write(readFileSync(shardLog(i), "utf8"));
  }
  const failed = results.findIndex((r) => r.status !== 0 && r.status !== MISS_EXIT);
  if (failed >= 0) {
    console.error(`funnel: shard ${shards[failed]!.suite} seed ${shards[failed]!.seed} failed (its output is above)`);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(results[failed]!.status ?? 1);
  }
  writeFileSync(out, JSON.stringify(mergeShards(shards.map((_, i) => shardJson(i))), null, 2));
}

interface Row {
  n: number;
  returned: number;
  cached: number;
  delivered: number;
  calls: number;
  ms: number;
}
interface Rows {
  hidden: Row;
  control: Row;
}
type Counts = Record<string, number>;
interface ShardOut {
  rows: Record<string, Rows>;
  total: Rows;
  sync?: Counts;
  cards?: Counts;
  reader?: Counts;
  intent?: IntentUse;
  calls?: CallCheck;
  perTask: { variant: "hidden" | "control" }[];
}

/**
 * The shards' JSON in hidden-funnel.ts's own shape for the same suites and seeds: perTask in its order (per suite,
 * hidden then control, seeds in order); rows, totals and the sync, cards and reader counters summed. Prints the
 * merged totals, since each shard's own summary lines cover that shard only.
 */
function mergeShards(files: string[]) {
  const parts = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as ShardOut);
  const addRows = (into: Rows | undefined, r: Rows): Rows => {
    const sum = into ?? { hidden: zeroRow(), control: zeroRow() };
    for (const v of ["hidden", "control"] as const) {
      for (const k of Object.keys(r[v]) as (keyof Row)[]) sum[v][k] += r[v][k];
    }
    return sum;
  };
  const addCounts = (into: Counts | undefined, c: Counts | undefined) => {
    if (!c) return into;
    const sum = into ?? {};
    for (const [k, v] of Object.entries(c)) sum[k] = (sum[k] ?? 0) + v;
    return sum;
  };
  let total: Rows = { hidden: zeroRow(), control: zeroRow() };
  let sync: Counts | undefined;
  let cardUse: Counts | undefined;
  let reader: Counts | undefined;
  const intentUse: IntentUse = { asked: 0, found: 0 };
  const rows: Record<string, Rows> = {};
  const bySuite: Record<string, { rows: Record<string, Rows>; total: Rows }> = {};
  for (const [i, p] of parts.entries()) {
    const suite = shards[i]!.suite;
    const s = (bySuite[suite] ??= { rows: {}, total: { hidden: zeroRow(), control: zeroRow() } });
    for (const [name, r] of Object.entries(p.rows)) {
      s.rows[name] = addRows(s.rows[name], r);
      const k = suites.length > 1 ? `${suite}/${name}` : name;
      rows[k] = addRows(rows[k], r);
    }
    s.total = addRows(s.total, p.total);
    total = addRows(total, p.total);
    sync = addCounts(sync, p.sync);
    cardUse = addCounts(cardUse, p.cards);
    reader = addCounts(reader, p.reader);
    intentUse.asked += p.intent?.asked ?? 0;
    intentUse.found += p.intent?.found ?? 0;
  }
  const intent = { state: intentState(config, intentUse), ...intentUse };
  const perTask = suites.flatMap((suite) =>
    (["hidden", "control"] as const).flatMap((variant) =>
      parts.flatMap((p, i) => (shards[i]!.suite === suite ? p.perTask.filter((t) => t.variant === variant) : [])),
    ),
  );
  const n = Math.max(1, total.hidden.n + total.control.n);
  const request = total.hidden.calls + total.control.calls;
  console.log(
    `\nmerged ${shards.length} shards: hidden returned ${total.hidden.returned}/${total.hidden.n}, delivered ` +
      `${total.hidden.delivered}/${total.hidden.n}; decoys delivered ${total.control.delivered}/${total.control.n}; ` +
      `${(request / n).toFixed(1)} calls/task; ${((total.hidden.ms + total.control.ms) / n).toFixed(1)} ms/task ` +
      (timeScale > 0
        ? `(${jobs} jobs at once at --time ${timeScale}: mostly connector sleeps, a latency figure within a few ` +
          "percent of one job, docs/LAB.md)"
        : `CONTENDED (${jobs} jobs at once: not a latency figure; use --jobs 1 for one)`),
  );
  if (sync) {
    // `demandSeen`, not `demand`: the listings seen in the tasks' windows are already in `request` (funnel-merge.ts).
    const amortised = amortisedCalls(request, sync);
    console.log(
      `merged sync (summed): ${JSON.stringify(sync)}; request ${(request / n).toFixed(2)}/task, amortised total ` +
        `${(amortised / n).toFixed(2)}/task, backfill ${(sync.warmMs! / Math.max(1, sync.users!)).toFixed(0)} ` +
        `ms/user (contended); demand items ${sync.demandItems ?? 0}, background items ${sync.backgroundItems ?? 0}`,
    );
  }
  const mismatched = callMismatches(
    parts.map((p, i) => ({ name: `${shards[i]!.suite} seed ${shards[i]!.seed}`, calls: p.calls })),
  );
  if (mismatched.length) {
    console.log(
      `CALLS UNTRACED in ${mismatched.length} of ${parts.length} shards (traces vs connectors; per-trace sourceCalls ` +
        `and cost views built from traces are off, the connectors' count above is right${
          config.syncPollBehind === true ? "; syncPollBehind's polls reach no trace" : ""
        }): ${mismatched.join("; ")}`,
    );
  }
  if (cardUse) console.log(`merged cards use (summed): ${JSON.stringify(cardUse)}`);
  if (reader) console.log(`merged reader replay (summed): ${JSON.stringify(reader)}`);
  console.log(
    "(each shard's own summary lines above, such as sync, cards, reader, overBudget and cpu, cover that shard only; " +
      "overBudget's reader and bridge counts are not summed here)",
  );
  return {
    suite: suites.join(","),
    seeds: seedList.map(Number),
    config,
    label: label + (intent.state === "inert" ? `  ${INTENT_INERT}` : ""),
    intent,
    rows,
    total,
    ...(sync ? { sync } : {}),
    ...(cardUse ? { cards: cardUse } : {}),
    ...(reader ? { reader } : {}),
    ...(suites.length > 1 ? { suites: bySuite } : {}),
    perTask,
  };
}
function zeroRow(): Row {
  return { n: 0, returned: 0, cached: 0, delivered: 0, calls: 0, ms: 0 };
}

interface TaskRow extends ScreenRow {
  suite: string;
  seed: number;
  template: string;
}
const tasks = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { perTask: TaskRow[] }).perTask;
const outJson = JSON.parse(readFileSync(out, "utf8")) as {
  reader?: { missed: number };
  config?: Record<string, unknown>;
  intent?: { state?: IntentState };
};
const readerReplay = outJson.reader;
// Intent on with nothing replayed: the run is the preset minus intent, and every TOTAL and pool line says so.
const intentNow = intentOfRun(outJson);
const inert = intentNow === "inert" || intentNow === "unknown" ? `  ${INTENT_INERT}` : "";
// A replay file that matched none of this run's items is only known now.
if (intentNow !== "unknown" && noModelReader && baseline) {
  const why = intentMismatch(intentNow, intentOfRun(JSON.parse(readFileSync(baseline, "utf8"))));
  if (why) {
    rmSync(scratch, { recursive: true, force: true });
    fail(`--baseline ${baseline} refused: ${why}`);
  }
}
const surfaced = (t: TaskRow) => Boolean(t.delivered || t.askCited);
const key = (t: TaskRow) => `${t.suite}|${t.variant}|${t.seed}|${t.template}`;

const rows = tasks(out);
// `--reader stub|oracle` (no model): stub's delivery is not the preset's; every oracle line says it is a proxy.
const tag = readerKind.startsWith("oracle") ? `  [${readerKind} proxy]` : "";
console.log(
  `\nfunnel score (surfaced = delivered or cited by ask), ${presetName}, seeds ${seeds}, ${wall.toFixed(0)} s` +
    (jobs > 1
      ? ` (${jobs} jobs; ms/task in the shards is ${timeScale > 0 ? "mostly connector sleeps" : "contended"})`
      : "") +
    tag,
);
if (readerKind === "stub") console.log(`  ${STUB_BANNER}`);
const bySuite = new Map<string, number[]>();
for (const t of rows) {
  const a = bySuite.get(t.suite) ?? [0, 0, 0, 0];
  const i = t.variant === "hidden" ? 0 : 2;
  a[i]! += Number(surfaced(t));
  a[i + 1]! += 1;
  bySuite.set(t.suite, a);
}
const total = [0, 0, 0, 0];
for (const [suite, a] of [...bySuite].sort()) {
  console.log(`  ${suite.padEnd(10)} hidden ${a[0]}/${a[1]}  decoys ${a[2]}/${a[3]}${tag}`);
  a.forEach((v, i) => (total[i]! += v));
}
console.log(`  ${"TOTAL".padEnd(10)} hidden ${total[0]}/${total[1]}  decoys ${total[2]}/${total[3]}${tag}${inert}`);
console.log(`  ${beforeModelLine(rows, passValue("wait-ms") || "default")}`);
// The reader's pool (any reader), `--packet-k` and the draft's pool (`--lead-in` with a no-model reader), per suite.
const packetK = passValue("packet-k").split(",").filter(Boolean).map(Number);
const screen = [...bySuite.keys()].sort().flatMap((suite) =>
  screenLines(
    suite,
    rows.filter((t) => t.suite === suite),
    packetK,
  ),
);
if (screen.length) {
  console.log(
    "reader screen (pool: the ids the reader was given for the request, a measurement of pool content, not a bound; " +
      "top-K: the ask's ranked candidates; draft: the draft's pool against the request's first read):",
  );
  for (const l of [...screen, ...(bySuite.size > 1 ? screenLines("TOTAL", rows, packetK) : [])]) {
    console.log(`  ${l}${tag}${inert}`);
  }
}
if (readerReplay) console.log(`  reader replay misses: ${readerReplay.missed}`);
if (!opt("json", "")) console.log("  (pass --json FILE to keep the per-task rows, e.g. as a later --baseline)");

if (baseline) {
  const before = new Map(tasks(baseline).map((t) => [key(t), t]));
  const moved = { hidden: [0, 0], control: [0, 0] };
  const changed: string[] = [];
  let missing = 0;
  for (const t of rows) {
    const b = before.get(key(t));
    if (!b) {
      missing++;
      continue;
    }
    if (surfaced(t) === surfaced(b)) continue;
    moved[t.variant][surfaced(t) ? 0 : 1]! += 1;
    changed.push(`${surfaced(t) ? "+" : "-"} ${t.variant.padEnd(7)} ${key(t)}`);
  }
  console.log(
    `against ${baseline}: hidden +${moved.hidden[0]} −${moved.hidden[1]}, ` +
      `decoys +${moved.control[0]} −${moved.control[1]}` +
      (missing ? ` (${missing} tasks not in the baseline)` : ""),
  );
  for (const line of changed.slice(0, 40)) console.log(`  ${line}`);
  if (changed.length > 40) console.log(`  … ${changed.length - 40} more`);
}
rmSync(scratch, { recursive: true, force: true });
const gate = missGate(readerReplay?.missed ?? 0, allowMisses);
if (gate.message) console.error(`\nfunnel: ${gate.message}`);
process.exit(gate.code);
