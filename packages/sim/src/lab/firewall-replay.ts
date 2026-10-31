#!/usr/bin/env bun
/**
 * The action firewall's free tier (docs/research/econ-firewall.md): the action calls agents made in `pi-ab.ts --act`
 * runs, replayed against Eden's `checkAction` with no agent and no model, so a change to the firewall is measured in
 * seconds before a live run. Each task's world and Eden are rebuilt as pi-ab builds them (the configuration given,
 * `actionCheck` on, the sync's backfill, cards replayed from disk with no model), the request is observed, and then
 * each distinct call the agents made for that task is checked, in order.
 *
 * Per call: the verdict, the ground (`clash`, `conflict`, `graph`, `card`, `away`), and whether the finding cites the
 * task's planted item (the hidden fact; on a control task, its decoy). Totals: hidden tasks with a finding citing the
 * planted item, hidden tasks with only other findings, control tasks with any finding (a false block).
 *
 *   bun packages/sim/src/lab/firewall-replay.ts run-43.json [more.json] --config ALL.json [--cards cards.jsonl]
 *     [--conditions eden-act,tools-act] [--json out.json] [--verbose]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CardEnricher, ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { REALISTIC, simSources } from "../sources";
import type { ActionRecord } from "./act";
import { worldOf, type RunResult, type Task } from "./ab-common";
import { DiskCardMaker } from "./cards-disk";

const args = process.argv.slice(2);
const opt = (name: string, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const files = args.filter((a, i) => a.endsWith(".json") && !args[i - 1]?.startsWith("--"));
const configArg = opt("config", "{}");
const CONFIG = JSON.parse(
  configArg.endsWith(".json") || configArg.endsWith(".cfg") ? readFileSync(configArg, "utf8") : configArg,
);
const CONDITIONS = opt("conditions", "").split(",").filter(Boolean);
const VERBOSE = args.includes("--verbose");
const cardMaker = opt("cards") ? new DiskCardMaker(opt("cards")) : null;
const UNCAPPED = { callsPerSession: Infinity, usdPerSession: Infinity, usdPerUserDay: Infinity };

/** The distinct calls the agents made per task (the first condition's order first), and the tasks by world. */
const calls = new Map<string, { tool: string; args: ActionRecord["args"] }[]>();
const worlds = new Map<string, { seed: number; suite: string; variant: "hidden" | "control" }>();
for (const file of files) {
  const run = JSON.parse(readFileSync(file, "utf8")) as { seeds: number[]; tasks: Task[]; results: RunResult[] };
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  for (const r of run.results) {
    if (CONDITIONS.length && !CONDITIONS.includes(r.condition)) continue;
    const t = byId.get(r.task);
    if (!t || t.kind === "offworld") continue;
    // A task id names its seed in pi-ab's hidden suites only by the run: the run's one seed.
    const seed = run.seeds[0]!;
    const variant = t.kind === "control" ? "control" : "hidden";
    worlds.set(`${seed}|${t.suite}|${variant}`, { seed, suite: t.suite, variant });
    const list = calls.get(`${seed}|${t.id}`) ?? [];
    for (const a of r.actions ?? []) {
      const k = `${a.tool}${JSON.stringify(a.args)}`;
      if (!list.some((x) => `${x.tool}${JSON.stringify(x.args)}` === k)) list.push({ tool: a.tool, args: a.args });
    }
    calls.set(`${seed}|${t.id}`, list);
  }
}

interface Out {
  seed: number;
  suite: string;
  kind: "hidden" | "control";
  template: string;
  tool: string;
  verdict: string;
  reason: string;
  cited: string[];
  planted: boolean;
  ms: number;
}
const out: Out[] = [];

for (const w of worlds.values()) {
  const { world, tasks } = worldOf(w.seed, w.suite, w.variant, { maxTasks: 30, maxOffworld: 5 });
  const sources = simSources(world, REALISTIC, 0, w.seed);
  let clock = world.now;
  const cards = cardMaker
    ? new CardEnricher({ maker: cardMaker, budget: new Budget(UNCAPPED), now: () => clock })
    : undefined;
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed: w.seed }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    planner: new QueryPlanner({ seed: w.seed }),
    now: () => clock,
    config: { ...CONFIG, actionCheck: true },
    ...(cards ? { cards } : {}),
  });
  const scope = { tenantId: "replay", userId: `w${w.seed}` };
  const sync = partner.sync;
  if (sync) {
    const start = clock;
    clock -= 30 * 60_000;
    sync.track(scope, clock);
    for (let i = 0; i < 120 && !sync.warm(scope); i++) {
      await sync.tick();
      clock += 60_000;
    }
    clock = start;
  }
  if (cards) await cards.idle();
  for (const task of tasks) {
    clock += 3_600_000;
    if (sync) await sync.tick();
    const list = calls.get(`${w.seed}|${task.id}`);
    const sessionId = task.id;
    const ev = (e: Record<string, unknown>) => ({ ...scope, sessionId, at: clock, ...e }) as AgentEvent;
    await partner.observe(ev({ kind: "session_start" }));
    await partner.observe(ev({ kind: "user_message", text: task.text }), { waitMs: 3_000 });
    partner.takePending({ ...scope, sessionId });
    for (const c of list ?? []) {
      const check = await partner.checkAction(ev({ kind: "tool_call", tool: c.tool, input: c.args }));
      const cited = check.finding?.citations.map((x) => x.itemId) ?? [];
      const row: Out = {
        seed: w.seed,
        suite: task.suite,
        kind: w.variant,
        template: task.type,
        tool: c.tool,
        verdict: check.verdict,
        reason: check.reason,
        cited,
        planted: task.planted !== undefined && cited.includes(task.planted),
        ms: check.latencyMs,
      };
      out.push(row);
      if (VERBOSE) {
        console.log(
          `${row.kind.padEnd(7)} ${task.suite}/${task.type} ${c.tool} → ${row.verdict} ${row.reason}` +
            `${row.planted ? " PLANTED" : ""} ${cited.join(",")}`,
        );
        if (check.finding && VERBOSE) console.log(`    ${check.finding.text.replace(/\n/g, "\n    ")}`);
      }
    }
    await partner.observe(ev({ kind: "session_end" }));
    if (cards) await cards.idle();
  }
}

// Per task: hidden tasks with a finding citing the planted item, with only other findings; control tasks with any.
const byTask = new Map<string, Out[]>();
for (const o of out) {
  const k = `${o.seed}|${o.suite}|${o.kind}|${o.template}`;
  byTask.set(k, [...(byTask.get(k) ?? []), o]);
}
const tally = { hidden: { tasks: 0, planted: 0, other: 0 }, control: { tasks: 0, flagged: 0, decoy: 0 } };
for (const rows of byTask.values()) {
  const kind = rows[0]!.kind;
  const flagged = rows.filter((r) => r.verdict === "finding");
  if (kind === "hidden") {
    tally.hidden.tasks++;
    if (flagged.some((r) => r.planted)) tally.hidden.planted++;
    else if (flagged.length) tally.hidden.other++;
  } else {
    tally.control.tasks++;
    if (flagged.length) tally.control.flagged++;
    if (flagged.some((r) => r.planted)) tally.control.decoy++;
  }
}
const reasons: Record<string, number> = {};
for (const o of out)
  reasons[`${o.kind}:${o.verdict}:${o.reason}${o.planted ? ":planted" : ""}`] =
    (reasons[`${o.kind}:${o.verdict}:${o.reason}${o.planted ? ":planted" : ""}`] ?? 0) + 1;
const ms = out.map((o) => o.ms).sort((a, b) => a - b);
const summary = {
  calls: out.length,
  tally,
  reasons,
  checkMsP50: ms[Math.floor(ms.length / 2)] ?? 0,
  checkMsMax: ms.at(-1) ?? 0,
};
console.log(JSON.stringify(summary, null, 2));
if (opt("json")) writeFileSync(opt("json"), JSON.stringify({ summary, calls: out }, null, 2));
