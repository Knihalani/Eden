#!/usr/bin/env bun
/**
 * Runs A5 §4 arms against a plugin and prints each run's checks, next to what `arms.json` records.
 *
 *   bun benchmarks/memory-long-horizon/arms/run.ts [--arm id,id] [--flags on|off|shadow|all]
 *       [--plugin DIR] [--scale ci|full] [--json]
 *
 * Defaults: every arm, every flag state the record has, `plugins/eden-memory` and the product CLI from this tree,
 * CI scale. Exit code 1 when a run differs from the record.
 */
import { resolve } from "node:path";
import { EDEN_CLI, EDEN_PLUGIN, runArm, type ArmResult, type FlagState, type Scale } from "./kit";
import { expected, loadRecord, statesOf } from "./record";
import { ARMS } from "./registry";

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const record = loadRecord();
  const ids = argument(args, "--arm")?.split(",") ?? record.arms.map((entry) => entry.id);
  const flags = argument(args, "--flags") ?? "all";
  const pluginDir = resolve(argument(args, "--plugin") ?? EDEN_PLUGIN);
  const scale = (argument(args, "--scale") ?? "ci") as Scale;
  const results: (ArmResult & { expected: string[] | null; matches: boolean })[] = [];
  for (const id of ids) {
    const arm = ARMS.get(id);
    if (!arm) {
      console.error(`${id}: no such arm`);
      continue;
    }
    const states = flags === "all" ? statesOf(record, id) : [flags as FlagState];
    for (const state of states) {
      const result = await runArm(arm, { pluginDir, cli: EDEN_CLI, scale, flags: state });
      const want = expected(record, id, state);
      const matches = want !== null && JSON.stringify(want) === JSON.stringify(result.failed);
      results.push({ ...result, expected: want, matches });
      if (!args.includes("--json")) {
        console.log(`${matches ? "  " : "≠ "}${id} [${state}] ${(result.ms / 1000).toFixed(1)} s`);
        for (const item of result.checks) console.log(`    ${item.ok ? "ok  " : "FAIL"} ${item.id}: ${item.detail}`);
        if (!matches) console.log(`    recorded: ${want === null ? "nothing" : JSON.stringify(want)}`);
      }
    }
  }
  if (args.includes("--json")) console.log(JSON.stringify(results, null, 2));
  return results.every((result) => result.matches) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
