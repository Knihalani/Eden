/**
 * The gate (A5 §4; EXECUTION X4: "CI fails if a red arm fails for a different reason"). Every arm of a group is run
 * at CI scale against `plugins/eden-memory` from this tree, in fresh processes: its `on` state, and its `off` and
 * `shadow` states for the group's flag sample (groups.ts). Each run must fail exactly the checks `arms.json`
 * records for it (none for a green state). A red arm that fails another set of
 * checks, or passes, fails the gate, as does a green arm that fails: either the arm is broken or the plugin's
 * behaviour changed, and `arms.json` is updated only with that evidence.
 *
 * Checks a state lists as `unstable` are left out of the comparison: today's plugin flips them between identical
 * runs (its pid-derived ids, #98), and the record says so with the measured flips.
 */
import { describe, test } from "bun:test";
import { ciStates, GROUPS } from "./groups";
import { EDEN_CLI, EDEN_PLUGIN, runArm, type FlagState } from "./kit";
import { loadRecord, mismatch, statesOf } from "./record";
import { ARMS } from "./registry";

/** Longest arm run at CI scale (spawn-writers, about 35 s) with room for a slow machine. */
const TIMEOUT_MS = 240_000;

/** Registers one test per CI state (groups.ts `ciStates`) of each arm of a group. */
export function gate(group: string): void {
  const record = loadRecord();
  describe(`A5 §4 arms (${group}) against plugins/eden-memory, as arms.json records them`, () => {
    for (const id of GROUPS[group] ?? []) {
      const arm = ARMS.get(id);
      const entry = record.arms.find((item) => item.id === id);
      for (const state of entry ? ciStates(group, id, statesOf(record, id)) : (["on"] as FlagState[])) {
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
