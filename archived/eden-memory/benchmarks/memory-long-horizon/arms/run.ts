#!/usr/bin/env bun
/**
 * Runs A5 §4 arms against a plugin and prints each run's checks, next to what `arms.json` records.
 *
 *   bun benchmarks/memory-long-horizon/arms/run.ts [--arm id,id] [--flags on|off|shadow|all]
 *       [--plugin DIR | --reference] [--scale ci|full] [--gate-tau on|shadow|off] [--json]
 *
 * `--gate-tau` runs every hook with `EDEN_FLAG_GATE_TAU` set (P4.3's evidence gate, shadow by default): the gate's own
 * measures are taken with it on; the records in `arms.json` are the default's.
 * Defaults: every arm, every flag state the record has, `plugins/eden-memory` and the product CLI from this tree,
 * CI scale. `--reference` runs each arm against its reference instead (reference.ts), where every check must pass.
 * Exit code 1 when a run differs from what is expected (the gate's comparison: `unstable` checks are left out), when
 * an arm id is unknown, or when nothing ran.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCRIPTED_PLUGIN } from "../harness/testkit";
import { EDEN_CLI, EDEN_PLUGIN, runArm, type ArmOptions, type ArmResult, type Scale } from "./kit";
import { loadRecord, mismatch, statesOf, type StateRecord } from "./record";
import { REFERENCE_CLI, referenceFor } from "./reference";
import { ARMS } from "./registry";

/** Directories holding reference tables, removed when the run ends. */
const tables: string[] = [];

/** The scripted plugin with the arm's reference table, and the reference CLI. */
function referenceOptions(id: string): Pick<ArmOptions, "pluginDir" | "cli" | "env"> {
  const { answers, env } = referenceFor(id);
  const dir = mkdtempSync(join(tmpdir(), "eden-reference-"));
  tables.push(dir);
  const table = join(dir, "answers.json");
  writeFileSync(table, JSON.stringify(answers));
  return {
    pluginDir: SCRIPTED_PLUGIN,
    cli: REFERENCE_CLI,
    env: { SCRIPTED_ANSWERS: table, SCRIPTED_REFERENCE: "1", ...env },
  };
}

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
  const reference = args.includes("--reference");
  const gate = argument(args, "--gate-tau");
  const env = gate === undefined ? {} : { env: { EDEN_FLAG_GATE_TAU: gate } };
  const results: (ArmResult & { recorded: StateRecord | null; matches: boolean })[] = [];
  for (const id of ids) {
    const arm = ARMS.get(id);
    if (!arm) {
      console.error(`${id}: no such arm`);
      return 1;
    }
    const states = statesOf(record, id).filter((state) => flags === "all" || state === flags);
    for (const state of states) {
      const options: ArmOptions = reference
        ? { ...referenceOptions(id), scale, flags: state }
        : { pluginDir, cli: EDEN_CLI, scale, flags: state, ...env };
      const result = await runArm(arm, options);
      const recorded = reference
        ? { state: "green" as const }
        : (record.arms.find((entry) => entry.id === id)?.[state] ?? null);
      const problem = recorded ? mismatch(result, recorded) : `${id} [${state}] is not recorded`;
      results.push({ ...result, recorded, matches: problem === "" });
      if (!args.includes("--json")) {
        console.log(`${problem ? "≠ " : "  "}${id} [${state}] ${(result.ms / 1000).toFixed(1)} s`);
        for (const item of result.checks) console.log(`    ${item.ok ? "ok  " : "FAIL"} ${item.id}: ${item.detail}`);
        if (problem) console.log(`    ${problem.split("\n")[0]}`);
      }
    }
  }
  if (args.includes("--json")) console.log(JSON.stringify(results, null, 2));
  return results.length > 0 && results.every((result) => result.matches) ? 0 : 1;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  for (const dir of tables) rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
