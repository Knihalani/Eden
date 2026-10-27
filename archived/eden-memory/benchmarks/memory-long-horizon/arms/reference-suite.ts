/**
 * The reference suites (prereg target 3): each arm of a group against its reference (reference.ts), every check
 * passing, in the states CI runs (groups.ts): every arm's `on`, and `off` and `shadow` for the group's flag sample.
 * An arm whose `on` reference delivers at a delivery point also satisfies the generic flag checks, since the
 * reference plugin's flag handling is the same for every table (kit.test.ts covers those checks).
 * `run.ts --reference` runs every state of every arm.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDirs, SCRIPTED_PLUGIN, tempDir } from "../harness/testkit";
import { ciStates, GROUPS } from "./groups";
import { runArm } from "./kit";
import { loadRecord, statesOf } from "./record";
import { REFERENCE_CLI, referenceFor } from "./reference";
import { ARMS } from "./registry";

/** Registers, for each arm of a group (groups.ts), one test per recorded state against its reference. */
export function referenceSuite(group: string): void {
  afterAll(removeTempDirs);
  const record = loadRecord();
  describe(`A5 §4 arms (${group}) against a plugin that does what A5 asks`, () => {
    for (const id of GROUPS[group] ?? []) {
      for (const state of ciStates(group, id, statesOf(record, id))) {
        test(`${id} [${state}]`, async () => {
          const reference = referenceFor(id);
          const table = join(tempDir("eden-reference"), "answers.json");
          writeFileSync(table, JSON.stringify(reference.answers));
          const env = { SCRIPTED_ANSWERS: table, SCRIPTED_REFERENCE: "1", ...reference.env };
          const options = { pluginDir: SCRIPTED_PLUGIN, cli: REFERENCE_CLI, scale: "ci" as const, flags: state, env };
          const result = await runArm(ARMS.get(id)!, options);
          expect(result.checks.filter((item) => !item.ok).map((item) => `${item.id}: ${item.detail}`)).toEqual([]);
        }, 240_000);
      }
    }
  });
}
