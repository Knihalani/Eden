#!/usr/bin/env bun
/**
 * B18 (docs/research/b18-heldout18.md): a sha256 of everything an arm's agent and grader are given on heldout18, so
 * two commits can be shown to run identical tasks without anyone reading them. Run with the commit's checkout as the
 * working directory: `cd CHECKOUT && bun /abs/path/tasks-hash.ts`. Prints hashes and counts only, no task text.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

const root = process.cwd();
const common = await import(join(root, "packages/sim/src/lab/ab-common.ts"));
const user = await import(join(root, "packages/sim/src/lab/pi-user.ts"));
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
// The world as built (every item the sim sources serve), serialised whole.
const worldSha = (world: unknown) => {
  const text = JSON.stringify(world);
  return `${sha(world)} (${text.length} bytes)`;
};

for (const seed of [41, 42, 43, 44]) {
  for (const variant of ["hidden", "control", "neutral"]) {
    const w = common.worldOf(seed, "heldout18", variant, { maxTasks: 30, maxOffworld: 5 }, {});
    console.log(`short w${seed} ${variant}: ${w.tasks.length} tasks ${sha(w.tasks)} world ${worldSha(w.world)}`);
  }
  const plan = user.planUser(seed, user.suiteTemplates(seed, ["heldout18"]), {
    days: 2,
    size: user.parseDaySize("16"),
    mix: user.parseMix("1:1:8"),
  });
  const u = user.userWorldOf(seed, plan);
  console.log(
    `days w${seed}: ${u.tasks.length} tasks (${u.daySizes.join(",")}) ${sha(u.tasks)} world ${worldSha(u.world)}`,
  );
}
console.log(`prompts ${common.armPromptsHash()} neutral ${common.armPromptsHash(null, true)}`);
