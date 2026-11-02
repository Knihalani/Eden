#!/usr/bin/env bun
/**
 * The common no-model screen in one command (`bun run funnel`; docs/LAB.md): hidden-funnel.ts with a named preset,
 * replayed cards and `--ask`, then the funnel score funnel-score.py prints (a hidden item counts as surfaced when it
 * was delivered or an ask cited it; the same for a decoy on control tasks), optionally against an earlier run.
 *
 *   bun run funnel [--suite train] [--seeds 41,42] [--preset ALL3] [--set '{"flag":true}'] [--cards default|none|F]
 *     [--no-ask] [--json out.json] [--baseline earlier.json] [--record] [--blind] [-- more hidden-funnel flags]
 *
 * - `--preset`: a name from presets.ts (H, ALL3, ALL5, NEW) or `none` (production defaults). `--set` adds flags.
 * - `--cards default`: the checked-in card caches (cards-v2 for dev/held-out worlds, cards-train for train), merged
 *   into a temp file; used when the configuration has `cards`.
 * - `--baseline`: a `--json` file of an earlier run on the same suites and seeds; prints, task by task, the hidden
 *   items gained and lost and the decoys gained and lost.
 * - Held-out suites are refused without `--blind`: they are measurement only, never for tuning (suites.ts). The
 *   unrun blind ones (UNRUN_BLIND) are spent by the first run that names them.
 * - Not recorded in bench/ledger.jsonl unless `--record` (a screen is not a result).
 *
 * NEW needs the reader (`-- --reader replay --reader-cache F` or `--reader live --reader-model m`) and the intent
 * requests (`-- --intent F`); ALL5 needs `-- --intent F --bridge F`. Neither file is checked in (docs/LAB.md).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS } from "./presets";
import { parseSuites, UNRUN_BLIND } from "./suites";

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const args = dash >= 0 ? argv.slice(0, dash) : argv;
const passthrough = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const fail = (message: string): never => {
  console.error(`funnel: ${message}`);
  process.exit(2);
};

const suiteArg = opt("suite", "train");
const suites = parseSuites(suiteArg);
const heldout = suites.filter((s) => s.startsWith("heldout"));
if (heldout.length && !args.includes("--blind")) {
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
const config = { ...preset, ...(JSON.parse(opt("set", "{}")) as Record<string, unknown>) };
const has = (flag: string) => passthrough.includes(flag);
if (config.askReader === true && !has("--reader")) {
  fail("this configuration has askReader: pass `-- --reader replay --reader-cache F` (or --reader live ...)");
}
if (config.intent === true && !has("--intent")) console.error("funnel: intent is on but no `-- --intent F`: no hits");
if (config.bridgeQuery === true && !has("--bridge")) console.error("funnel: bridgeQuery is on but no `-- --bridge F`");

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

const funnelArgs = [
  join(import.meta.dir, "hidden-funnel.ts"),
  "--suite",
  suites.join(","),
  "--seeds",
  seeds,
  "--config",
  JSON.stringify(config),
  "--json",
  out,
  "--label",
  presetName + (args.includes("--set") ? "+set" : ""),
  ...(args.includes("--no-ask") ? [] : ["--ask"]),
  ...(cards !== "none" && config.cards === true ? ["--cards", cards] : []),
  ...(args.includes("--record") ? [] : ["--no-record"]),
  ...passthrough,
];
console.error(`funnel: bun ${funnelArgs.map((a) => (/[\s{"]/.test(a) ? `'${a}'` : a)).join(" ")}`);
const t0 = performance.now();
const run = spawnSync("bun", funnelArgs, { stdio: "inherit" });
if (run.status !== 0) {
  rmSync(scratch, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}
const wall = (performance.now() - t0) / 1000;

interface TaskRow {
  suite: string;
  variant: "hidden" | "control";
  seed: number;
  template: string;
  delivered: boolean;
  askCited?: boolean;
}
const tasks = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { perTask: TaskRow[] }).perTask;
const surfaced = (t: TaskRow) => Boolean(t.delivered || t.askCited);
const key = (t: TaskRow) => `${t.suite}|${t.variant}|${t.seed}|${t.template}`;

const rows = tasks(out);
console.log(
  `\nfunnel score (surfaced = delivered or cited by ask), ${presetName}, seeds ${seeds}, ${wall.toFixed(0)} s`,
);
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
  console.log(`  ${suite.padEnd(10)} hidden ${a[0]}/${a[1]}  decoys ${a[2]}/${a[3]}`);
  a.forEach((v, i) => (total[i]! += v));
}
console.log(`  ${"TOTAL".padEnd(10)} hidden ${total[0]}/${total[1]}  decoys ${total[2]}/${total[3]}`);
if (!opt("json", "")) console.log("  (pass --json FILE to keep the per-task rows, e.g. as a later --baseline)");

const baseline = opt("baseline", "");
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
