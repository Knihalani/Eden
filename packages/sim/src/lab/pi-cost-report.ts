#!/usr/bin/env bun
/**
 * The cost and latency split of pi-ab runs (H16, CL5; pi-cost.ts has the rules): per condition the agent's and Eden's
 * per-task cost, Eden's background while the user works, the one-time backfill per user, the steady state and all-in
 * totals (also on the 1:1:8 mix), reader and connector calls, wall; per kind the share raised; per day (long horizon,
 * `--days`) the per-task cost and wall, so the transcript's growth over a day shows. Since A3: connector calls per task
 * (the agent's, Eden's in the task's window and in the background) and per user (the backfill), and every total again
 * with the connectors priced per plan (`CONNECTOR_PLANS`), with eden − tools per plan.
 *
 *   bun packages/sim/src/lab/pi-cost-report.ts run-41.json run-42.json [--lifetime cold.json[,cold2.json]] [--json F]
 *
 * `--lifetime`: `cold-start.ts --users user:41,user:42 --out cold.json` output (the measured one-time backfill of each
 * seed's long-horizon user, checked to be the same user shape as the runs, `lifetimeFor`); without it the one-time
 * figure is what the run itself spent before the first request, less what the replayed cards saved (the line says
 * which).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Background, RunResult, Task } from "./ab-common";
import {
  CONNECTOR_PLANS,
  conditionCosts,
  costTasks,
  dayRows,
  kindRows,
  lifetimeFor,
  planCosts,
  type CostTask,
  type Lifetime,
  type UserShape,
} from "./pi-cost";
import { dayOf } from "./pi-user";
import { resumedNote } from "./run-journal";
import { sameSelection, selectionLine, type TaskSelection } from "./task-kinds";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const files = argv.filter((a, i) => a.endsWith(".json") && !["--lifetime", "--json"].includes(argv[i - 1] ?? ""));
if (!files.length) throw new Error("usage: pi-cost-report.ts run.json [run2.json …] [--lifetime cold.json] [--json F]");

interface RunFile {
  taskSelection?: TaskSelection;
  /** `--resume` (D813): what an earlier attempt's journal supplied (`resumedNote`). */
  resumed?: Parameters<typeof resumedNote>[1];
  seeds: number[];
  tasks: Task[];
  results: RunResult[];
  background?: Background[];
  timeline?: string;
  days?: { seed: number; condition: string; recapUsd?: number; recapEdenUsd?: number }[];
  suites: string[];
  user?: {
    worlds: { seed: number; daySizes: number[]; clashes: number }[];
    days: number;
    daySize: [number, number];
    mix: UserShape["mix"];
    gapMin: number;
    nightH: number;
  };
}

const tasks: CostTask[] = [];
const background: Background[] = [];
const recaps: { seed: number; condition: string; usd: number }[] = [];
const notes: string[] = [];
const shapes: { file: string; shape?: UserShape }[] = [];
const selections: (TaskSelection | undefined)[] = [];
for (const file of files) {
  const run = JSON.parse(readFileSync(file, "utf8")) as RunFile;
  selections.push(run.taskSelection);
  const resumed = resumedNote(file, run.resumed);
  if (resumed) notes.push(resumed);
  shapes.push({
    file,
    ...(run.user
      ? { shape: { suites: run.suites, days: run.user.days, daySize: run.user.daySize, mix: run.user.mix } }
      : {}),
  });
  const records = new Map<string, { events: { ph: string; ev: string }[] }>();
  const lines = run.timeline && existsSync(`${run.timeline}/tasks.jsonl`) ? `${run.timeline}/tasks.jsonl` : "";
  if (!lines) notes.push(`${file}: no timeline found, reader and connector calls read 0`);
  for (const line of lines ? readFileSync(lines, "utf8").split("\n") : []) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { task: string; condition: string; events: { ph: string; ev: string }[] };
    records.set(`${r.task}\u0000${r.condition}`, r);
  }
  // A long-horizon user's days, from its day sizes (the tasks are in day order, one world per seed).
  const days = new Map<string, number>();
  for (const w of run.user?.worlds ?? []) {
    const own = run.tasks.filter((t) => t.id.startsWith(`w${w.seed}:`));
    for (const [id, d] of dayOf(own, w.daySizes)) days.set(id, d);
    notes.push(`${file}: user w${w.seed}, ${w.daySizes.length} days (${w.daySizes.join(",")}), ${w.clashes} clashes`);
  }
  tasks.push(...costTasks(run, records, days));
  background.push(...(run.background ?? []));
  for (const d of run.days ?? []) {
    recaps.push({ seed: d.seed, condition: d.condition, usd: (d.recapUsd ?? 0) + (d.recapEdenUsd ?? 0) });
  }
}
sameSelection(selections);
console.log(selectionLine(selections[0]));
const lifetime: Lifetime[] = lifetimeFor(
  (flag("lifetime") ?? "")
    .split(",")
    .filter(Boolean)
    .map((f) => JSON.parse(readFileSync(f, "utf8")) as Parameters<typeof lifetimeFor>[0][number]),
  shapes,
);

const k = (x: number, d = 3) => (1_000 * x).toFixed(d);
const pad = (s: string | number, n: number) => String(s).padStart(n);
for (const n of notes) console.log(n);
const costs = conditionCosts(tasks, background, recaps, lifetime);
console.log(
  "\n$ per 1,000 tasks (agent and Eden per task; bg run = Eden's cards and intent while the user worked, per task; " +
    "one-time = backfill per user; steady = agent + Eden + bg run; all-in = steady + one-time spread over the " +
    "user's tasks in this run). Recap turns are probes: not tasks, their $ apart.",
);
console.log(
  "condition        n users   agent    Eden  bg run  steady  all-in  mix st  mix all   one-time $/user (from)" +
    "  reader/t  Eden conn/t  agent tools/t  wall p50  mean  recaps $",
);
for (const c of costs) {
  console.log(
    `${c.condition.padEnd(14)} ${pad(c.tasks, 3)} ${pad(c.users, 5)} ${pad(k(c.agent), 7)} ${pad(k(c.eden), 7)} ` +
      `${pad(k(c.backgroundRun), 7)} ${pad(k(c.steady), 7)} ${pad(k(c.allIn), 7)} ` +
      `${pad(c.mixSteady === null ? "-" : k(c.mixSteady), 7)} ${pad(c.mixAllIn === null ? "-" : k(c.mixAllIn), 8)} ` +
      `${pad(c.oneTimePerUser.toFixed(4), 16)} (${c.oneTimeFrom}) ${pad(c.readerCallsPerTask.toFixed(2), 9)} ` +
      `${pad(c.edenSourceCallsPerTask.toFixed(2), 12)} ${pad(c.agentToolsPerTask.toFixed(2), 14)} ` +
      `${pad(c.wallP50.toFixed(2), 9)} ${pad(c.wallMean.toFixed(2), 5)} ${pad(c.recapUsd.toFixed(4), 9)}`,
  );
}
console.log(
  "\nconnector calls per task (agent's source tools; Eden's in the task's window; Eden's background while the user " +
    "worked) and Eden's one-time backfill calls per user; streams recorded before A3 lack the background and backfill",
);
for (const c of costs) {
  const x = c.connectorPerTask;
  console.log(
    `${c.condition.padEnd(14)} agent ${x.agent.toFixed(2)}  Eden ${x.eden.toFixed(2)}  background ` +
      `${x.background.toFixed(2)}  mix ${c.mixConnectorPerTask === null ? "-" : c.mixConnectorPerTask.toFixed(2)}  ` +
      `backfill ${c.backfillCallsPerUser.toFixed(0)}/user (${c.backfillUsers} users)`,
  );
}
console.log(
  "\n$ per 1,000 tasks with the connectors priced per plan ($ per 1,000 calls; market.py, list prices, assumed): " +
    "steady, all-in, and on the 1:1:8 mix",
);
const plans = Object.entries(CONNECTOR_PLANS);
const priced = costs.map((c) => ({ c, by: plans.map(([plan, rate]) => ({ plan, ...planCosts(c, rate) })) }));
const opt = (x: number | null) => (x === null ? "-" : k(x));
for (const { c, by } of priced) {
  for (const p of by) {
    console.log(
      `${c.condition.padEnd(14)} ${p.plan.padEnd(28)} steady ${pad(k(p.steady), 7)}  all-in ${pad(k(p.allIn), 7)}  ` +
        `mix st ${pad(opt(p.mixSteady), 7)}  mix all ${pad(opt(p.mixAllIn), 7)}`,
    );
  }
}
const base = priced.find((x) => x.c.condition === "tools");
if (base) {
  console.log("\neden − tools per plan, $ per 1,000 tasks (each condition against `tools`)");
  for (const { c, by } of priced) {
    if (c === base.c) continue;
    by.forEach((p, i) => {
      const b = base.by[i]!;
      const diff = (x: number | null, y: number | null) => (x === null || y === null ? "-" : k(x - y));
      console.log(
        `${c.condition.padEnd(14)} ${p.plan.padEnd(28)} steady ${pad(k(p.steady - b.steady), 7)}  all-in ` +
          `${pad(k(p.allIn - b.allIn), 7)}  mix st ${pad(diff(p.mixSteady, b.mixSteady), 7)}  mix all ` +
          `${pad(diff(p.mixAllIn, b.mixAllIn), 7)}`,
      );
    });
  }
}
console.log("\nper kind: n, raised (graded), agent + Eden $ per 1k tasks, wall p50 s");
for (const r of kindRows(tasks)) {
  console.log(
    `${r.condition.padEnd(14)} ${r.kind.padEnd(8)} ${pad(r.n, 4)}  raised ${r.raised}/${r.graded} ` +
      `(${(r.graded ? (100 * r.raised) / r.graded : 0).toFixed(1)}%)  $${r.usd1k.toFixed(3)}/1k  p50 ${r.p50.toFixed(2)}`,
  );
}
const byDay = dayRows(tasks);
if (byDay.some((r) => r.day > 0)) {
  console.log("\nper day (long horizon): n, agent and Eden $ per 1k tasks, wall p50 s");
  for (const r of byDay) {
    console.log(
      `${r.condition.padEnd(14)} day ${r.day}  ${pad(r.n, 3)}  agent ${pad(r.agent1k.toFixed(3), 7)}  Eden ` +
        `${pad(r.eden1k.toFixed(3), 6)}  p50 ${r.p50.toFixed(2)}`,
    );
  }
}
if (flag("json"))
  writeFileSync(
    flag("json")!,
    JSON.stringify(
      { files, taskSelection: selections[0], costs, plans: priced, kinds: kindRows(tasks), byDay },
      null,
      2,
    ),
  );
