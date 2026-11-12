#!/usr/bin/env bun
/**
 * B19 (D1040, docs/research/b19-final-bench.md): B18's tasks-hash for any suite. A sha256 of every task list and
 * world an arm's agent and grader are given (short: each seed × hidden, control, neutral; days: each user's plan), and
 * of the agent's and grader's prompts, so two arm trees can be shown to run identical tasks without anyone reading
 * them. Run with the tree as the working directory; prints hashes and counts only, no task text:
 *
 *   cd TREE && bun /abs/path/tasks-hash.ts SUITE SEEDS DAYS DAY_SIZE     # e.g. train 41,42 2 16
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

const [suite = "train", seedList = "41", days = "2", daySize = "16"] = process.argv.slice(2);
const root = process.cwd();
const common = await import(join(root, "packages/sim/src/lab/ab-common.ts"));
const suites = await import(join(root, "packages/sim/src/lab/suites.ts"));
const user = await import(join(root, "packages/sim/src/lab/pi-user.ts"));
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
const worldSha = (world: unknown) => `${sha(world)} (${JSON.stringify(world).length} bytes)`;
const names: string[] = suites.parseSuites(suite);

for (const seed of seedList.split(",").map(Number)) {
  for (const name of names) {
    for (const variant of ["hidden", "control", "neutral"]) {
      const w = common.worldOf(seed, name, variant, { maxTasks: 30, maxOffworld: 5 }, {});
      console.log(
        `short w${seed} ${name} ${variant}: ${w.tasks.length} tasks ${sha(w.tasks)} world ${worldSha(w.world)}`,
      );
    }
  }
  const plan = user.planUser(seed, user.suiteTemplates(seed, names), {
    days: Number(days),
    size: user.parseDaySize(daySize),
    mix: user.parseMix("1:1:8"),
  });
  const u = user.userWorldOf(seed, plan);
  console.log(
    `days w${seed}: ${u.tasks.length} tasks (${u.daySizes.join(",")}) ${sha(u.tasks)} world ${worldSha(u.world)}`,
  );
}
console.log(`prompts ${common.armPromptsHash()} neutral ${common.armPromptsHash(null, true)}`);
