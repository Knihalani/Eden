/**
 * The gate (A5 §4; EXECUTION X4: "CI fails if a red arm fails for a different reason"). Every recorded state of
 * the given arms is run at CI scale against `plugins/eden-memory` from this tree, each in fresh processes, and must
 * fail exactly the checks `arms.json` records for it (none for a green state). A red arm that fails another set of
 * checks, or passes, fails the gate, as does a green arm that fails: either the arm is broken or the plugin's
 * behaviour changed, and `arms.json` is updated only with that evidence.
 *
 * Checks a state lists as `unstable` are left out of the comparison: today's plugin flips them between identical
 * runs (its pid-derived ids, #98), and the record says so with the measured flips.
 */
import { describe, test } from "bun:test";
import { GROUPS } from "./groups";
import { EDEN_CLI, EDEN_PLUGIN, runArm, type ArmResult, type FlagState } from "./kit";
import { loadRecord, statesOf, type StateRecord } from "./record";
import { ARMS } from "./registry";

/** Longest arm run at CI scale (spawn-writers, about 35 s) with room for a slow machine. */
const TIMEOUT_MS = 240_000;

/** The difference between a run and its record, in words; empty when they agree. */
export function mismatch(result: ArmResult, record: StateRecord): string {
  const unstable = new Set(record.unstable ?? []);
  const stable = (ids: readonly string[]) => ids.filter((id) => !unstable.has(id)).sort();
  const want = stable(record.state === "green" ? [] : (record.failed ?? []));
  const got = stable(result.failed);
  if (JSON.stringify(want) === JSON.stringify(got)) return "";
  const unexpected = got.filter((id) => !want.includes(id));
  const missing = want.filter((id) => !got.includes(id));
  const detail = result.checks
    .filter((item) => unexpected.includes(item.id) || missing.includes(item.id))
    .map((item) => `  ${item.ok ? "now passes" : "now fails"} ${item.id}: ${item.detail}`);
  return [
    `${result.arm} [${result.flags}] recorded ${record.state} ${JSON.stringify(want)}, ran ${JSON.stringify(got)}`,
    ...detail,
  ].join("\n");
}

/** Registers one test per recorded state of each arm of a group (groups.ts). */
export function gate(group: string): void {
  const record = loadRecord();
  describe(`A5 §4 arms (${group}) against plugins/eden-memory, as arms.json records them`, () => {
    for (const id of GROUPS[group] ?? []) {
      const arm = ARMS.get(id);
      const entry = record.arms.find((item) => item.id === id);
      for (const state of entry ? statesOf(record, id) : (["on"] as FlagState[])) {
        const recorded = entry?.[state];
        test(
          `${id} [${state}]: ${recorded?.state ?? "unrecorded"}`,
          async () => {
            if (!arm || !recorded) throw new Error(`${id}: ${arm ? "not in arms.json" : "no such arm"}`);
            const result = await runArm(arm, { pluginDir: EDEN_PLUGIN, cli: EDEN_CLI, scale: "ci", flags: state });
            const problem = mismatch(result, recorded);
            if (problem) throw new Error(problem);
          },
          TIMEOUT_MS,
        );
      }
    }
  });
}
