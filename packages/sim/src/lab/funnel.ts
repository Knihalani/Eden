#!/usr/bin/env bun
/**
 * The common no-model screen in one command (`bun run funnel`; docs/LAB.md): hidden-funnel.ts with a named preset,
 * replayed cards and `--ask`, then the funnel score funnel-score.py prints (a hidden item counts as surfaced when it
 * was delivered or an ask cited it; the same for a decoy on control tasks), optionally against an earlier run.
 *
 *   bun run funnel [--suite train] [--seeds 41,42] [--preset default] [--set '{"flag":true}'] [--cards default|none|F]
 *     [--intent default|none|F] [--no-ask] [--json out.json] [--baseline earlier.json] [--record] [--blind] [--jobs N]
 *     [-- more hidden-funnel flags]
 *
 * - `--preset`: `default` (the engine's DEFAULT_CONFIG, D112), `minus-<part>` or `minus-all` (presets.ts). `--set`
 *   adds settings (a trial is `--set` over `default`).
 * - `--cards default`: the checked-in card caches (cards-v2 for dev/held-out worlds, cards-train for train), merged
 *   into a temp file; used when the configuration has `cards`.
 * - `--cards-endpoint URL [--cards-endpoint-model NAME]` (M0, lab only; `cards-endpoint.ts`): every card comes live
 *   from an OpenAI-compatible endpoint (the distilled card model, `packages/sim/modal/`), none replayed, at $0
 *   Anthropic; `--cards F` keeps them (read and appended to, so a rerun replays them), else a temp file. The
 *   endpoint writes the intent requests too, so the checked-in requests are not replayed unless `--intent F` names a
 *   file. Labelled `[cards: endpoint (lab, M0)]`: never the shipped card model's figures.
 * - `--baseline`: a `--json` file of an earlier run on the same suites and seeds; prints, task by task, the hidden
 *   items gained and lost and the decoys gained and lost.
 * - Held-out suites are refused without `--blind`: they are measurement only, never for tuning (suites.ts).
 *   UNRUN_BLIND's (held-out 9-18) are kept out of `all`; all have been read (held-out 17 by A29, D399; held-out 18 by
 *   B18, D802), so UNREAD_BLIND is empty.
 * - Not recorded in bench/ledger.jsonl unless `--record` (a screen is not a result).
 * - `--jobs N`: N hidden-funnel.ts processes, rows merged before the score (same score). At `--time 0` each takes a
 *   block of suite × seed shards and all run at once, default one per core (D139; ms/task is then contended, so
 *   `--jobs 1` for latency); at `--time` > 0 one per shard, N at a time, default min(shards, 12, 3 × cores), since
 *   those shards wait on sleeps. The per-task output files (`--ask-diag`, `--packets`, …) shard and are merged;
 *   `--record`, `--timeline`, `--reader live` and `--judge live` force 1 and say why (the `--jobs` note below).
 * - `--intent default` (D158): the checked-in intent requests (`intent-v2`, train seeds 41-44, held-out 10-11
 *   seeds 41-42 and held-out 13 seeds 41-44; INTENT_COVERS in cards-disk.ts), unpacked into a temp file and passed
 *   as `-- --intent`, when the configuration has intent and cards and the run's suites and seeds are all covered, so
 *   the screen runs the shipped default. `none` leaves intent inert (the pre-D158 screens); a file, or
 *   `-- --intent F`, replays that file.
 * - `--coverage shipped|full` (P7, D872, D877): which card and intent index the run replays. `shipped`, the default
 *   wherever it covers the run (SHIPPED_COVERS in cards-disk.ts: train, reworded, longtail and heldout19, seeds
 *   41-44), replays `cards-shipped.jsonl.gz` as both `--cards` and `--intent`: the cards and requests the shipped
 *   enricher (`buildPartner`'s own `CardEnricher`) made for each world (`cold-start.ts --cards-out`). `full` is the
 *   older default: the checked-in cards and `cards-enrich.ts --intent`'s every-item requests, about seven times the
 *   items a deployment's enricher writes requests for (D714); a run shipped coverage does not cover, or one naming
 *   `--cards`, `--intent` or an endpoint, gets it. An explicit `--coverage shipped` refuses those. Every run prints
 *   its coverage beside the score and TOTAL line and writes it to the JSON (`coverage`): compare like with like.
 * - With intent on and nothing replayed (`--intent none`, an uncovered run, or a file for other items), every TOTAL
 *   and pool line and the JSON label say `[intent inert: no replay]`; `--reader stub|oracle` refuse a `--baseline`
 *   whose intent differs.
 * - `-- --neutral`: also the `neutral` variant of the suites that build it (neutral.ts, held-out 14): the same
 *   requests with nothing planted, reported on NEUTRAL lines and in the JSON's `neutral` block, never in the score.
 * - `-- --wait-ms N` (the observe's wait) prints the deliveries made before the agent's first model call;
 *   `-- --overlap` sends each request while another lookup is in flight (the slow path busy; scores not
 *   comparable). docs/LAB.md 1c.
 *
 * The default reads with the reader: with no `-- --reader` the screen uses `--reader stub` ($0); a real reading
 * needs `-- --reader replay --reader-model m --reader-cache F` or `--reader live --reader-model m`. A Haiku reader
 * cache for the default on train, seeds 41-42, intent replayed, is checked in gzipped
 * (`packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz`; docs/LAB.md recipe 2a; the older
 * `reader-haiku-train-4142.jsonl.gz` is D141's intent-inert reading, kept for history, replayed with `--intent none`).
 * A replayed reader prompt that is not in the cache fails open (the ask answers without the reader), so the run
 * prints the miss count and exits 3 after the score unless `--allow-misses`: such a run is part read, part not.
 * When every prompt missed and no `--reader-model` was given, it also says so: the cache key hashes the model id.
 * `-- --reader stub` screens the default at $0 with no key: the reader's pool per suite (hidden and decoy in pool,
 * pool items, prompt size); its delivery counts are not the preset's. `-- --reader oracle[:p_hit,p_false]` is a
 * ground-truth proxy, every line labelled so. Both shard. `-- --packet-k 10,15,20` prints the planted item in the
 * ask's top K. With `-- --lead-in clause` and a no-model reader, the draft's pool against the request's (docs/LAB.md).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CARD_FORM_REQUESTS, CARD_FORM_WIDE } from "@eden/engine";
import { flags, labConfig, parseJson } from "./flags";
import { INTENT_FILE, INTENT_PATH, intentUncovered, SHIPPED_FILE, SHIPPED_PATH, shippedUncovered } from "./cards-disk";
import {
  coverageLines,
  plantedCoverageLine,
  rulePrecisionLines,
  surfacedLines,
  type AskCoverage,
  type SurfacedRow,
} from "./ask-coverage";
import {
  amortisedCalls,
  callMismatches,
  defaultJobs,
  groupShards,
  mergeLines,
  mergeParts,
  partArgs,
  partFiles,
  soloReasons,
  type PartFile,
  type PartOut,
} from "./funnel-merge";
import { effective, PRESETS } from "./presets";
import { costScreen, costScreenLines, type CostRow } from "./cost-screen";
import { mergeNeutral, neutralLine, type NeutralOut } from "./neutral";
import { allMissedHint, cacheModels, missGate, MISS_EXIT } from "./reader-disk";
import {
  beforeModelLine,
  INTENT_INERT,
  intentMismatch,
  intentOfRun,
  intentState,
  screenLines,
  STUB_BANNER,
  type IntentState,
  type ScreenRow,
} from "./reader-stub";
import { isSynthTest, parseSuites, UNREAD_BLIND, UNRUN_BLIND } from "./suites";

const USAGE = `
bun run funnel [--suite train] [--seeds 41,42] [--preset default] [--set '{"flag":true}'] [--cards default|none|F]
  [--cards-endpoint URL [--cards-endpoint-model NAME]] [--intent default|none|F] [--coverage full|shipped] [--no-ask] [--json out.json] [--baseline earlier.json]
  [--record] [--blind] [--jobs N] [--allow-misses]
  [-- more hidden-funnel flags]
Presets: ${Object.keys(PRESETS).join(", ")}. docs/LAB.md has the recipes; funnel.ts's header every flag.`;
// Strict (flags.ts): a misspelled flag exits 2 before anything runs; what follows `--` is hidden-funnel.ts's to check.
const cli = flags(
  "funnel",
  {
    suite: "value",
    seeds: "value",
    preset: "value",
    set: "value",
    cards: "value",
    "cards-endpoint": "value",
    "cards-endpoint-model": "value",
    intent: "value",
    coverage: "value",
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
/** The run's temp directory (merged cards, intent requests, part files), removed on exit, SIGINT and SIGTERM. */
let scratch = "";
/**
 * The sharded output files' parts (`<file>.part-<i>`, next to each named file), removed on exit, SIGINT and SIGTERM
 * (not on SIGKILL, which no process can catch).
 */
let outputParts: PartFile[] = [];
const cleanup = () => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  for (const f of outputParts) for (const part of f.parts) rmSync(part, { force: true });
};
// Also on an uncaught throw (a merge that refuses its parts): no part file outlives the run.
process.on("exit", cleanup);
/** The running hidden-funnel processes and their close, stopped with the launcher so none writes after the cleanup. */
const children = new Map<ChildProcess, Promise<unknown>>();
/** The exit code of the signal being handled: no new process starts, and a child it stopped exits with that code. */
let stopping: number | undefined;
// 'exit' does not fire on a signal: pass it on to the children (a SIGTERM sent to the launcher alone does not reach
// them), wait up to 5 s for them to close so no late write recreates a part, then clean up and exit as the signal
// would (128 + its number).
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, async () => {
    stopping = code;
    for (const child of children.keys()) child.kill(signal);
    await Promise.race([Promise.all(children.values()), new Promise((done) => setTimeout(done, 5000))]);
    cleanup();
    process.exit(code);
  });
}
const fail = (message: string): never => {
  cleanup();
  console.error(`funnel: ${message}`);
  process.exit(2);
};

const suiteArg = opt("suite", "train");
const suites = parseSuites(suiteArg);
// The generated test split (D884) is M1's and M3's measurement set: held out like a held-out suite.
const heldout = suites.filter((s) => s.startsWith("heldout") || isSynthTest(s));
if (heldout.length && !cli.has("blind")) {
  fail(
    `${heldout.join(", ")} are held out: measurement only, never for tuning. Screen on train (or dev6a,dev6b); ` +
      `pass --blind for a pre-registered blind check.`,
  );
}
const unrun = suites.filter((s) => UNRUN_BLIND.includes(s) && !UNREAD_BLIND.includes(s));
if (unrun.length) {
  console.error(
    `funnel: ${unrun.join(", ")} kept out of \`all\` (UNRUN_BLIND) but read before (D72, D80, D85, D98, D112): ` +
      "not a blind measurement; a blind round needs a new suite",
  );
}
// A suite nobody has read (D350): this run reads it, so it is blind once; say so, and add it to the read ones after.
const unread = suites.filter((s) => UNREAD_BLIND.includes(s));
if (unread.length) {
  console.error(
    `funnel: ${unread.join(", ")} unread until now: this run is its blind read; move it out of UNREAD_BLIND`,
  );
}

const presetName = opt("preset", "default");
const preset = PRESETS[presetName];
if (!preset) fail(`unknown preset ${presetName} (known: ${Object.keys(PRESETS).join(", ")})`);
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
// What runs: the override over the default (D112), whose cards, intent and reader are on.
const run = effective(config);
const has = (flag: string) => passthrough.includes(flag);
/** The value after a hidden-funnel flag given after `--` ("" when absent). */
const passValue = (name: string) => {
  const i = passthrough.indexOf(`--${name}`);
  return i >= 0 ? (passthrough[i + 1] ?? "") : "";
};
const allowMisses = cli.has("allow-misses") || has("--allow-misses");
// The default reads with the reader; with none named, the screen stays $0 on the stub reader (nothing binds, so
// delivery is the rule paths'), and says so on every pool line. `-- --reader replay|live|oracle` for the rest.
if (run.askReader && !has("--reader")) {
  console.error("funnel: the reader is on and no `-- --reader`: screening with `--reader stub` ($0, nothing binds)");
  passthrough.push("--reader", "stub");
}
// The checked-in intent requests and the shards they cover (train seeds 41-44, held-out 10-11 seeds 41-42, held-out
// 13 seeds 41-44): INTENT_COVERS in cards-disk.ts, which the live harnesses read too.
const labDir = join(import.meta.dir, "..", "..", "lab");
scratch = mkdtempSync(join(tmpdir(), "eden-funnel-"));
const seeds = opt("seeds", "41,42");
const seedList = seeds.split(",");
// The intent requests (D158): replayed by default whenever the checked-in file covers the run, as the cards are, so
// the $0 screen runs what ships (`intent` is on in DEFAULT_CONFIG). Resolved before the baseline check below.
const endpoint = opt("cards-endpoint", "");
// `--coverage shipped` (D872): the shipped enricher's own cards and requests, as both files; checked before any use.
// The default (D877): shipped coverage wherever the file covers the run and no card or intent source is named; a run
// it does not cover, or one that names its own, keeps the full index's default and says so.
const ownCards = !!endpoint || cli.has("cards") || cli.has("intent") || has("--intent") || has("--cards");
// The card prompt's form the run asks in (D1062, D1063): shipped coverage covers only the shards holding its lines.
const cardForm =
  run.cards === true && run.intent === true && run.cardsRequestsFix === true
    ? run.cardsRequestsWide === true
      ? CARD_FORM_WIDE
      : CARD_FORM_REQUESTS
    : 0;
const coverage = opt(
  "coverage",
  !ownCards && !shippedUncovered(suites, seedList, cardForm).length ? "shipped" : "full",
);
if (coverage !== "full" && coverage !== "shipped") fail(`--coverage takes full or shipped, not ${coverage}`);
let shippedFile = "";
if (coverage === "shipped") {
  if (ownCards)
    fail("--coverage shipped replays its own cards and requests: drop --cards, --intent and --cards-endpoint");
  const uncovered = shippedUncovered(suites, seedList, cardForm);
  if (uncovered.length) fail(`--coverage shipped: ${SHIPPED_FILE} does not cover ${uncovered.join(", ")}`);
  shippedFile = join(scratch, "shipped.jsonl");
  writeFileSync(shippedFile, gunzipSync(readFileSync(SHIPPED_PATH)));
}
// The checked-in reader caches were recorded with the full index (D877): their prompts differ under shipped coverage.
if (coverage === "shipped" && !cli.has("coverage") && passValue("reader") === "replay") {
  console.error(
    "funnel: coverage is shipped by default (D877); the checked-in reader caches were recorded at --coverage full, " +
      "so pass it to replay them",
  );
}
if (endpoint && opt("cards", "default") === "none") fail("--cards-endpoint makes cards: drop --cards none");
// With an endpoint the requests are the endpoint's own (its calls ask for them), so none are replayed by default.
const intentArg = shippedFile || opt("intent", endpoint ? "none" : "default");
if (cli.has("intent") && has("--intent")) fail("--intent given twice (before and after `--`): pass one");
const intentWanted = run.intent === true && run.cards === true && opt("cards", "default") !== "none";
let intentNote = "";
let intentByDefault = false;
if (has("--intent")) {
  intentNote = `-- --intent ${passValue("intent")}`;
} else if (intentArg === "none") {
  intentNote = endpoint && !cli.has("intent") ? "requests from the endpoint (lab, M0), none replayed" : "--intent none";
} else if (intentArg !== "default") {
  passthrough.push("--intent", intentArg);
  intentNote = intentArg;
} else if (intentWanted) {
  const uncovered = intentUncovered(suites, seedList);
  if (uncovered.length) {
    const shown = uncovered.slice(0, 4).join(", ") + (uncovered.length > 4 ? `, … ${uncovered.length - 4} more` : "");
    intentNote = `the checked-in requests do not cover ${shown}`;
  } else {
    const file = join(scratch, "intent.jsonl");
    writeFileSync(file, gunzipSync(readFileSync(INTENT_PATH)));
    passthrough.push("--intent", file);
    intentNote = `${INTENT_FILE} by default, D158`;
    intentByDefault = true;
  }
}
if (intentWanted) console.error(`funnel: intent: ${intentNote}`);
if (intentWanted && endpoint && !has("--intent")) {
  console.error("funnel: cards and intent requests come live from the endpoint (lab, M0), none replayed");
} else if (intentWanted && !has("--intent")) {
  console.error(`funnel: intent is on with no replay: no hits; every TOTAL and pool line says ${INTENT_INERT}`);
}
// `--reader stub|oracle` with `--baseline`: refuse a baseline whose intent state differs, before the run when this
// run's state is known now (off, or on with no replay file), else after it (a file that matched nothing).
const readerKind = passValue("reader");
const noModelReader = readerKind === "stub" || readerKind.startsWith("oracle");
const baseline = opt("baseline", "");
const checkBaseline = (current: IntentState) => {
  if (!noModelReader || !baseline) return;
  const base = JSON.parse(readFileSync(baseline, "utf8")) as Parameters<typeof intentOfRun>[0] & { coverage?: string };
  const why = intentMismatch(current, intentOfRun(base));
  if (why) fail(`--baseline ${baseline} refused: ${why}`);
  // D877: a baseline that recorded another coverage measured another index (a run before D872 recorded none).
  const now = shippedFile ? "shipped" : intentByDefault ? "full" : "";
  const then = base.coverage?.split(" ")[0] ?? "";
  if (now && then && (then === "shipped" || then === "full") && now !== then) {
    fail(`--baseline ${baseline} refused: its coverage is ${then} and this run's is ${now} (pass --coverage ${then})`);
  }
};
if (!run.intent || !run.cards) checkBaseline("off");
// The endpoint writes requests for what it cards: live unless it wrote none (checked again after the run).
else if (endpoint) checkBaseline("live");
// Shipped coverage covers the run by construction (SHIPPED_COVERS), so it is live (checked again after).
else if (shippedFile) checkBaseline("live");
else if (!has("--intent")) checkBaseline("inert");
// The checked-in requests cover this run, so it is live unless the replay matches nothing (checked again after).
else if (intentByDefault) checkBaseline("live");

let cards = shippedFile || opt("cards", "default");
if (endpoint) {
  // The endpoint's cards go to `--cards F` (created when missing, replayed by a rerun) or a temp file.
  if (cards === "default") cards = join(scratch, "cards-endpoint.jsonl");
  if (!existsSync(cards)) writeFileSync(cards, "");
  passthrough.push("--cards-endpoint", endpoint);
  if (opt("cards-endpoint-model", "")) passthrough.push("--cards-endpoint-model", opt("cards-endpoint-model", ""));
} else if (cards === "default") {
  const merged = join(scratch, "cards.jsonl");
  const text = ["cards-v2.jsonl", "cards-train.jsonl"]
    .map((f) => readFileSync(join(labDir, "cards", f), "utf8").trimEnd())
    .join("\n");
  writeFileSync(merged, `${text}\n`);
  cards = merged;
}
const out = opt("json", join(scratch, "funnel.json"));

// A repeated seed would run twice in one process but once per block when grouped, so the merge refuses it up front.
if (new Set(seedList.map(Number)).size !== seedList.length) fail(`--seeds ${seeds} repeats a seed`);
// The ledger's label names the coverage too (D877), so a recorded level says which index it was measured with.
const label = presetName + (cli.has("set") ? "+set" : "") + (shippedFile ? "@shipped" : "");

/** hidden-funnel.ts's arguments for some suites and seeds, writing its rows to `json`; `pass`: the flags after `--`. */
const funnelArgsFor = (suiteList: string, seedList: string, json: string, pass = passthrough) => [
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
  ...(cards !== "none" && run.cards ? ["--cards", cards] : []),
  ...(cli.has("record") ? [] : ["--no-record"]),
  ...(allowMisses && !has("--allow-misses") ? ["--allow-misses"] : []),
  ...pass,
];
const shellLine = (a: string[]) => `bun ${a.map((x) => (/[\s{"]/.test(x) ? `'${x}'` : x)).join(" ")}`;

/**
 * `--jobs N`: N hidden-funnel.ts processes, their rows merged here before scoring (`mergeParts`, funnel-merge.ts). At
 * `--time 0` each process runs a block of suites × seeds (`groupShards`) and all start at once, default one per core:
 * each process repeats its start-up (worlds, cards, backfill) in CPU, so 12 one-shard processes on 4 cores spent more
 * CPU and were slower than 4 blocks of 3 (D139). At `--time` > 0 each shard gets its own process, N at a time, default
 * min(shards, 12, 3 × cores) (`defaultJobs`). A task's result does not depend on which other suites or seeds share
 * its process (checked at `--time 0` and `--time 1`: perTask rows identical without their timing fields,
 * docs/LAB.md). At `--time 0` its `ms` does: with N > 1 the processes contend for cores, so ms/task is not a latency
 * figure and the run says CONTENDED; `--jobs 1` gives the uncontended one. At `--time` > 0 a task's time is mostly
 * the connectors' simulated
 * latency (sleeps, not CPU), so shards barely contend and ms/task stays a latency figure (measured within a few
 * percent of one process, docs/LAB.md), and the run says how many ran at once; `--jobs` is honoured as typed, so a
 * latency study, a heavier configuration or a machine with fewer cores can choose one process. The per-task output
 * files (`--ask-diag`, `--packets`, `--card-log`, `--reader-log`, `--candidates`: `PART_FLAGS`) shard: process i
 * writes `<file>.part-<i>`, and the parts are merged into the named file in one canonical order (`mergeLines`) and
 * deleted (audit 2026-11-06, devloop-ask-diag-forces-one-process). Some runs keep one process whatever N says, each
 * reason printed (`soloReasons`, funnel-merge.ts): `--record` and `--timeline` (one ledger entry per suite; per-process
 * CPU and RSS would be contended), `--reader live` and `--judge live` (one append-only cache file and one spend stream
 * per run; a parallel live top-up is not built).
 */
const jobsGiven = cli.has("jobs") ? Number(opt("jobs", "1")) : undefined;
if (jobsGiven !== undefined && (!Number.isInteger(jobsGiven) || jobsGiven < 1)) {
  fail("--jobs must be a whole number of at least 1");
}
const solo = soloReasons({ record: cli.has("record"), passthrough });
/** `-- --time T`: connectors at their simulated latency; shards then wait on sleeps rather than contend for CPU. */
const timeScale = Number(passValue("time") || "0");
const shardCount = suites.length * seedList.length;
const cores = availableParallelism();
let jobs = defaultJobs({ ...(jobsGiven !== undefined ? { jobsGiven } : {}), timeScale, shards: shardCount, cores });
if (jobs > 1 && solo.length) {
  const asked = jobsGiven !== undefined ? `--jobs ${jobsGiven}` : `the default of ${jobs} jobs`;
  console.error(`funnel: ${asked} ignored, running one job, since each of these needs one process: ${solo.join("; ")}`);
  jobs = 1;
}
// The processes: at `--time 0` blocks of suites × seeds, all at once; at `--time` > 0 one per shard, `jobs` at a time.
const groups =
  jobs === 1
    ? [{ suites, seeds: seedList }]
    : timeScale > 0
      ? suites.flatMap((suite) => seedList.map((seed) => ({ suites: [suite], seeds: [seed] })))
      : groupShards(suites, seedList, jobs);
if (jobs > 1 && timeScale <= 0) jobs = groups.length;
if (jobsGiven === undefined && jobs > 1) {
  console.error(
    timeScale > 0
      ? `funnel: --time ${timeScale} without --jobs: ${jobs} shards at once on ${cores} cores (min(shards, 12, ` +
          "3 × cores)); ms/task read 0.8-3.5% higher at 12 jobs than at 1 on 4 cores (docs/LAB.md); --jobs 1 for an " +
          "uncontended latency figure"
      : `funnel: ${jobs} processes on ${cores} cores, each a block of suites × seeds (D139); ms/task is CONTENDED, ` +
          "--jobs 1 for an uncontended latency figure",
  );
}
const groupName = (g: { suites: string[]; seeds: string[] }) => `${g.suites.join(",")} seed ${g.seeds.join(",")}`;
// The per-task output files: one part per process when several run; with one, the file itself is the only part.
let outputs: PartFile[] = [];
try {
  outputs = partFiles(passthrough, groups.length);
} catch (error) {
  fail((error as Error).message);
}
if (jobs > 1) outputParts = outputs;

const t0 = performance.now();
if (jobs === 1) {
  const funnelArgs = funnelArgsFor(suites.join(","), seeds, out);
  console.error(`funnel: ${shellLine(funnelArgs)}`);
  const run = spawnSync("bun", funnelArgs, { stdio: "inherit" });
  // A run with reader misses still wrote its rows: score them, then fail below.
  if (run.status !== 0 && run.status !== MISS_EXIT) {
    cleanup();
    process.exit(stopping ?? run.status ?? 1);
  }
} else {
  await runGroups();
}
const wall = (performance.now() - t0) / 1000;
mergeOutputs();

/**
 * Each per-task output file in one canonical order (`mergeLines`): with several processes, their parts merged into
 * the named file, then deleted; with one, the file put in the same order (its seeds ran concurrently, so its lines
 * interleave), so `--jobs 1` and `--jobs N` write the same file. A file no process wrote (`--card-log` with no cards)
 * stays unwritten.
 */
function mergeOutputs() {
  for (const f of outputs) {
    const sources = jobs > 1 ? f.parts : [f.file];
    const present = sources.filter((p) => existsSync(p));
    if (!present.length) continue;
    writeFileSync(
      f.file,
      mergeLines(
        present.map((p) => readFileSync(p, "utf8")),
        suites,
      ),
    );
    if (jobs > 1) for (const p of f.parts) rmSync(p, { force: true });
  }
}

/** Runs every group, `jobs` at a time, prints each one's output in group order, and merges their JSON into `out`. */
async function runGroups() {
  const partJson = (i: number) => join(scratch, `part-${i}.json`);
  const partLog = (i: number) => join(scratch, `part-${i}.log`);
  const argsOf = (i: number) =>
    funnelArgsFor(
      groups[i]!.suites.join(","),
      groups[i]!.seeds.join(","),
      partJson(i),
      partArgs(passthrough, outputs, i),
    );
  console.error(
    `funnel: ${shardCount} shards (suite × seed) in ${groups.length} processes, ${jobs} at a time on ${cores} cores` +
      (timeScale > 0 ? ` (--time ${timeScale}: concurrent shards wait on simulated connector latency, not CPU)` : "") +
      `; the first: ${shellLine(argsOf(0))}`,
  );
  const results: { status: number | null; seconds: number }[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < groups.length && stopping === undefined; i = next++) {
      // Each process's stdout and stderr go to its own file, printed whole below so they do not interleave.
      const fd = openSync(partLog(i), "w");
      const started = performance.now();
      const child = spawn("bun", argsOf(i), { stdio: ["ignore", fd, fd] });
      const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
      children.set(child, closed);
      const status = await closed;
      children.delete(child);
      closeSync(fd);
      results[i] = { status, seconds: (performance.now() - started) / 1000 };
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  // Stopped by a signal: the children closed on it, so their results are partial. Exit as the signal handler would.
  if (stopping !== undefined) {
    cleanup();
    process.exit(stopping);
  }
  for (const [i, g] of groups.entries()) {
    const r = results[i]!;
    console.log(`\n== ${groupName(g)} (exit ${r.status}, ${r.seconds.toFixed(1)} s)`);
    process.stdout.write(readFileSync(partLog(i), "utf8"));
  }
  const failed = results.findIndex((r) => r.status !== 0 && r.status !== MISS_EXIT);
  if (failed >= 0) {
    console.error(`funnel: ${groupName(groups[failed]!)} failed (its output is above)`);
    cleanup();
    process.exit(stopping ?? results[failed]!.status ?? 1);
  }
  const parts = groups.map(
    (_, i) => JSON.parse(readFileSync(partJson(i), "utf8")) as PartOut & { neutral?: NeutralOut },
  );
  writeFileSync(out, JSON.stringify(merged(parts), null, 2));
}
/**
 * The run's card and intent coverage (D714, D872), printed with the score and kept in the JSON: `shipped` (the shipped
 * enricher's cards and requests), `full` (the checked-in every-item requests), `none` (intent replays nothing) or
 * the file a run named.
 */
const coverageLabel = !intentWanted
  ? "none (intent or cards off)"
  : shippedFile
    ? "shipped (cards-shipped, D872)"
    : intentByDefault
      ? "full (intent-v2: every item, about 7x a deployment's, D714)"
      : intentArg === "none" || intentNote.startsWith("the checked-in")
        ? "none (intent inert)"
        : `custom (${intentNote})`;
{
  const json = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  writeFileSync(out, JSON.stringify({ ...json, coverage: coverageLabel }, null, 2));
}

/**
 * The processes' JSON in hidden-funnel.ts's own shape for the same suites and seeds (`mergeParts`). Prints the merged
 * totals, since each process's own summary lines cover its block only.
 */
function merged(parts: (PartOut & { neutral?: NeutralOut })[]) {
  const m = mergeParts(parts, groups, suites, seedList);
  // `-- --neutral`: the neutral rows, merged apart from the planted tasks' (neutral.ts).
  const neutral = mergeNeutral(parts, suites, seedList);
  if (neutral) {
    for (const [suite, r] of Object.entries(neutral.suites)) console.log(`merged ${neutralLine(suite, r)}`);
    if (Object.keys(neutral.suites).length > 1) console.log(`merged ${neutralLine("TOTAL", neutral.total)}`);
  }
  const { total, sync } = m;
  const intent = { state: intentState(run, m.intentUse), ...m.intentUse };
  const n = Math.max(1, total.hidden.n + total.control.n);
  const request = total.hidden.calls + total.control.calls;
  console.log(
    `\nmerged ${shardCount} shards from ${groups.length} processes: hidden returned ` +
      `${total.hidden.returned}/${total.hidden.n}, delivered ${total.hidden.delivered}/${total.hidden.n}; decoys ` +
      `delivered ${total.control.delivered}/${total.control.n}; ${(request / n).toFixed(1)} calls/task; ` +
      `${((total.hidden.ms + total.control.ms) / n).toFixed(1)} ms/task ` +
      (timeScale > 0
        ? `(${jobs} jobs at once at --time ${timeScale}: mostly connector sleeps, a latency figure within a few ` +
          "percent of one job, docs/LAB.md)"
        : `CONTENDED (${jobs} processes at once: not a latency figure; use --jobs 1 for one)`),
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
  const mismatched = callMismatches(parts.map((p, i) => ({ name: groupName(groups[i]!), calls: p.calls })));
  if (mismatched.length) {
    console.log(
      `CALLS UNTRACED in ${mismatched.length} of ${parts.length} processes (traces vs connectors; per-trace ` +
        `sourceCalls and cost views built from traces are off, the connectors' count above is right${
          config.syncPollBehind === true ? "; syncPollBehind's polls reach no trace" : ""
        }): ${mismatched.join("; ")}`,
    );
  }
  if (m.cards) console.log(`merged cards use (summed): ${JSON.stringify(m.cards)}`);
  if (m.reader) console.log(`merged reader replay (summed): ${JSON.stringify(m.reader)}`);
  console.log(
    "(each process's own summary lines above, such as sync, cards, reader, overBudget and cpu, cover its block only; " +
      "overBudget's reader and bridge counts are not summed here)",
  );
  return {
    suite: suites.join(","),
    seeds: seedList.map(Number),
    config,
    label: label + (intent.state === "inert" ? `  ${INTENT_INERT}` : ""),
    intent,
    rows: m.rows,
    total,
    ...(sync ? { sync } : {}),
    ...(m.cards ? { cards: m.cards } : {}),
    ...(m.reader ? { reader: m.reader } : {}),
    ...(suites.length > 1 ? { suites: m.bySuite } : {}),
    perTask: m.perTask,
    ...(neutral ? { neutral } : {}),
  };
}

interface TaskRow extends ScreenRow {
  suite: string;
  seed: number;
  template: string;
}
const tasks = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { perTask: TaskRow[] }).perTask;
const outJson = JSON.parse(readFileSync(out, "utf8")) as {
  reader?: { replayed: number; sent: number; missed: number; subset?: number };
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
  if (why) fail(`--baseline ${baseline} refused: ${why}`);
}
const surfaced = (t: TaskRow) => Boolean(t.delivered || t.askCited);
const key = (t: TaskRow) => `${t.suite}|${t.variant}|${t.seed}|${t.template}`;

const rows = tasks(out);
// `--reader stub|oracle` (no model): stub's delivery is not the preset's; every oracle line says it is a proxy.
const tag = readerKind.startsWith("oracle") ? `  [${readerKind} proxy]` : "";
console.log(
  `\nfunnel score (surfaced = delivered or cited by ask), ${presetName}, seeds ${seeds}, ${wall.toFixed(0)} s` +
    (jobs > 1
      ? ` (${jobs} jobs; ms/task in the shards is ${timeScale > 0 ? "mostly connector sleeps" : "CONTENDED"})`
      : "") +
    tag,
);
if (intentWanted) console.log(`  intent: ${intentNow}${intentNote ? ` (${intentNote})` : ""}`);
console.log(`  coverage: ${coverageLabel}`);
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
console.log(
  `  ${"TOTAL".padEnd(10)} hidden ${total[0]}/${total[1]}  decoys ${total[2]}/${total[3]}${tag}${inert}` +
    `  [coverage: ${coverageLabel.split(" ")[0]}]`,
);
console.log(`  ${beforeModelLine(rows, passValue("wait-ms") || "default")}`);
// D173 (reporting only; the O7 gates stay decoys in pool and total surfaced, D165): how the surfaced items were
// surfaced, and the planted items' intent replay coverage, over the merged rows (each process prints only its block).
for (const l of surfacedLines("TOTAL", rows as SurfacedRow[])) console.log(`  ${l}${tag}${inert}`);
// S2's per-rule precision table (reporting only): each rule path's planted deliveries, flagged or not.
for (const l of rulePrecisionLines("TOTAL", rows as SurfacedRow[])) console.log(`  ${l}${tag}${inert}`);
const plantedLine = plantedCoverageLine(rows as SurfacedRow[]);
if (plantedLine) console.log(`  intent: ${plantedLine}`);
// `--ask-diag`: the rank -1 split by intent coverage (ask-coverage.ts), from the merged file's rows, so it covers the
// whole run whatever the processes were (each process's own lines above cover its block only).
const askDiag = outputs.find((f) => f.flag === "--ask-diag");
if (askDiag && existsSync(askDiag.file)) {
  type DiagRow = { variant: string; rank: number; cached: boolean; coverage?: AskCoverage | null };
  const diagRows = readFileSync(askDiag.file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DiagRow);
  for (const l of coverageLines(diagRows)) console.log(`  ${l}${inert}`);
}
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
// H18's cost screen (cost-screen.ts, docs/LAB.md 2b): Eden's per-task reader calls and $ as made, per kind and on the
// 1:1:8 mix, from the replayed reading; the neutral rows' own misses count too (they are outside the miss gate).
if (readerReplay) {
  const neutralOut = (outJson as { neutral?: NeutralOut }).neutral;
  const screened = costScreen(rows as unknown as CostRow[], (neutralOut?.perTask ?? []) as unknown as CostRow[]);
  const misses = readerReplay.missed + (neutralOut?.use?.reader?.missed ?? 0);
  for (const l of costScreenLines(screened, misses)) console.log(`  ${l}${inert}`);
}
if (readerReplay?.subset) {
  console.log(
    `  APPROXIMATE: ${readerReplay.subset} reader prompts answered from a recorded superset pool (--reader-subset), ` +
      "not read as asked",
  );
}
if (!opt("json", "")) console.log("  (pass --json FILE to keep the per-task rows, e.g. as a later --baseline)");

if (baseline) {
  const was = (JSON.parse(readFileSync(baseline, "utf8")) as { reader?: { subset?: number } }).reader?.subset ?? 0;
  if (was > 0) {
    console.log(`  APPROXIMATE BASELINE: ${was} of its reader prompts were answered from a recorded superset pool`);
  }
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
cleanup();
const gate = missGate(readerReplay?.missed ?? 0, allowMisses);
if (gate.message) console.error(`\nfunnel: ${gate.message}`);
// Every prompt missed with no `--reader-model`: almost always a cache made under another model (promptKey hashes it).
const hint = readerReplay
  ? allMissedHint(readerReplay, has("--reader-model"), cacheModels(passValue("reader-cache")))
  : null;
if (hint) console.error(`funnel: ${hint}`);
process.exit(gate.code);
